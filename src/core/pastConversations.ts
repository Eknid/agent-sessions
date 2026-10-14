import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexRpc } from '../process/codexRpc';
import { childEnv } from '../process/claudeProcess';

/*
 * Past Claude Code conversations for a folder, read from ~/.claude/projects/<slug>/<id>.jsonl.
 * The transcript format is internal to Claude Code, so this only extracts a label (custom
 * title or first prompt) and degrades to the bare id when the format changes.
 */

export interface PastConversation {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

/** `/Users/me/my repo` → `-Users-me-my-repo`, the folder name Claude Code uses. */
export const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstPrompt(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    let prompt: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if ((o.type === 'custom-title' || o.type === 'summary') && typeof (o.customTitle ?? o.summary) === 'string') return o.customTitle ?? o.summary;
      if (!prompt && o.type === 'user' && !o.isMeta && !o.isSidechain) {
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: { type: string }) => b.type === 'text')?.text : undefined;
        // Skip command wrappers and injected context.
        if (text && !/^\s*</.test(text)) prompt = text;
      }
    }
    return prompt;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function listPastConversations(cwd: string, home = os.homedir(), limit = 50): PastConversation[] {
  const dir = path.join(home, '.claude', 'projects', projectSlug(cwd));
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items = names
    .filter((n) => n.endsWith('.jsonl') && UUID.test(n.slice(0, -6)))
    .map((n) => {
      const file = path.join(dir, n);
      let updatedAt = 0;
      try {
        updatedAt = fs.statSync(file).mtimeMs;
      } catch {
        /* vanished */
      }
      return { id: n.slice(0, -6), file, updatedAt };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return items.map((i) => ({
    id: i.id,
    cwd,
    updatedAt: i.updatedAt,
    title: (firstPrompt(i.file) ?? i.id).replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
}

/** Read Codex's thread index through its public protocol, respecting CODEX_HOME. */
export async function listPastCodexConversations(cwd: string, command: string, extraArgs: string[] = []): Promise<PastConversation[]> {
  const rpc = new CodexRpc();
  const timer = setTimeout(() => rpc.kill(), 15_000);
  rpc.start({ command, args: ['app-server', ...extraArgs], cwd, env: childEnv() });
  try {
    await rpc.initialize();
    const out: PastConversation[] = [];
    let cursor: string | null = null;
    do {
      const page = await rpc.request('thread/list', { cwd, limit: 100, cursor, sortKey: 'updated_at' });
      for (const thread of page.data ?? []) {
        if (path.resolve(thread.cwd) !== path.resolve(cwd)) continue;
        out.push({ id: thread.id, cwd, title: (thread.name || thread.preview || thread.id).replace(/\s+/g, ' ').slice(0, 120), updatedAt: thread.updatedAt * 1000 });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 50);
    return out.slice(0, 50);
  } finally { clearTimeout(timer); rpc.kill(); }
}
