import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { StreamEvent } from '../core/events';

/** Environment variables a parent Claude Code session sets for its own children; never inherit them. */
const SESSION_SCOPED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CODEX_THREAD_ID',
];

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of SESSION_SCOPED_ENV) delete env[k];
  return env;
}

/**
 * One `claude -p --input-format stream-json --output-format stream-json` child.
 * Emits `event` per stdout JSON line, `stderr`, `exit`. Knows nothing about sessions.
 */
export class ClaudeProcess extends EventEmitter {
  private child?: ChildProcess;
  private buf = '';
  private exited = false;

  start(spec: SpawnSpec) {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => this.emit('stderr', chunk));
    child.stdin!.on('error', () => undefined); // EPIPE after exit is expected; the exit event reports it.
    child.on('error', (err) => {
      this.emit('spawnError', err);
      this.finish(null, null);
    });
    child.on('exit', (code, signal) => {
      // Flush a trailing line without newline.
      if (this.buf.trim()) this.onData('\n');
      this.finish(code, signal);
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.exited;
  }

  send(ev: StreamEvent): boolean {
    if (!this.alive || !this.child?.stdin?.writable) return false;
    this.child.stdin.write(JSON.stringify(ev) + '\n');
    return true;
  }

  /** Correlated native controls, independent of ordinary conversation events. */
  requestControl(request: Record<string, unknown>, timeout = 15_000): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', onEvent); this.off('exit', onExit); };
      const onExit = () => { cleanup(); reject(new Error('Claude process exited')); };
      const onEvent = (ev: StreamEvent) => {
        if (ev.type !== 'control_response' || ev.response?.request_id !== id) return;
        cleanup();
        if (ev.response.subtype === 'error') reject(new Error(ev.response.error));
        else resolve(ev.response.response);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Claude ${request.subtype} timed out`)); }, timeout);
      this.on('event', onEvent); this.once('exit', onExit);
      if (!this.send({ type: 'control_request', request_id: id, request } as StreamEvent)) onExit();
    });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    if (!this.alive) return;
    this.child!.kill(signal);
    const c = this.child!;
    setTimeout(() => {
      if (!this.exited) c.kill('SIGKILL');
    }, 3000).unref();
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        this.emit('event', JSON.parse(line) as StreamEvent);
      } catch {
        this.emit('stderr', line + '\n');
      }
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}
