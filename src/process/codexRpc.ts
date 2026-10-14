import { EventEmitter } from 'events';
import { ClaudeProcess, SpawnSpec } from './claudeProcess';
import { StreamEvent } from '../core/events';

/** Codex app-server's newline-delimited JSON-RPC transport. No model turns are sent by initialize. */
export class CodexRpc extends EventEmitter {
  private wire = new ClaudeProcess();
  private seq = 0;
  private lastStderr = '';
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor() {
    super();
    this.wire.on('event', (message: any) => {
      if (message.method) { this.emit(message.id !== undefined ? 'request' : 'notification', message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.wire.on('stderr', (text: string) => { this.lastStderr = (this.lastStderr + text).slice(-2000); this.emit('stderr', text); });
    this.wire.on('spawnError', (err: Error) => this.emit('spawnError', err));
    this.wire.on('exit', (code, signal) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`Codex app-server exited${this.lastStderr.trim() ? ': ' + this.lastStderr.trim() : ''}`));
      }
      this.pending.clear();
      this.emit('exit', code, signal);
    });
  }

  start(spec: SpawnSpec) { this.wire.start(spec); }
  get alive() { return this.wire.alive; }
  kill() { this.wire.kill(); }
  notify(method: string) { return this.wire.send({ method } as unknown as StreamEvent); }
  reply(id: string | number, result: unknown) { return this.wire.send({ id, result } as unknown as StreamEvent); }
  reject(id: string | number, message: string) {
    return this.wire.send({ id, error: { code: -32601, message } } as unknown as StreamEvent);
  }

  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.wire.send({ id, method, params } as unknown as StreamEvent)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Codex app-server is not running'));
      }
    });
  }

  async initialize() {
    const response = await this.request('initialize', {
      clientInfo: { name: 'agent_sessions', title: 'Agent Sessions for VS Code', version: '0.11.7' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
    return response;
  }
}
