import { AGENT_TOOL_NAMES, contentBlocks, ImageAttachment, LogRecord, QUESTION_TOOL_NAME, StreamEvent } from './events';
import { fmtDuration, fmtUsd } from './format';
import { modelLabel } from './pricing';
import { MAIN } from './sessionModel';

/*
 * Turns event-log records into chat items for the session tab. Display only: it never
 * decides state, it mirrors what the reducer derives from the same records. Items are
 * keyed, and a later record can update an earlier item (a tool call gets its output, a
 * permission request its outcome), so `apply` returns every item it added or changed.
 */

export type ImageData = ImageAttachment;

export type Tone = 'dim' | 'ok' | 'warn' | 'error';

export type Item =
  | { kind: 'user'; id: string; text: string; images: ImageData[]; t: number }
  | { kind: 'text'; id: string; markdown: string }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      /** One-line argument shown next to the name, e.g. the command or file. */
      summary: string;
      /** What the tool was given, formatted for reading. */
      input: string;
      /** `diff` renders +/- lines, `text` a plain block. */
      inputKind: 'text' | 'diff';
      output?: string;
      outputTruncated?: boolean;
      status: 'running' | 'done' | 'error';
      /** Agent calls: the subagent whose transcript can be opened. */
      agent?: { ownerId: string; background: boolean; model?: string; note?: string };
    }
  | {
      kind: 'permission';
      id: string;
      requestId: string;
      summary: string;
      description?: string;
      outcome?: 'allowed' | 'always' | 'denied' | 'cancelled';
    }
  | {
      kind: 'question';
      id: string;
      requestId: string;
      questions: { question: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
      answers?: Record<string, string>;
      skipped?: boolean;
    }
  /** `title` is set on notes the tab writes itself, e.g. the answer to /help. */
  | { kind: 'note'; id: string; text: string; tone: Tone; divider?: boolean; title?: string };

export interface TranscriptOptions {
  /** `main` shows the main conversation; a tool_use id shows only that subagent's transcript. */
  owner: string;
}

/** Tool output kept per item; the rest is cut so a huge `cat` does not bloat the tab. */
const MAX_OUTPUT = 20_000;

/** Harness bookkeeping that subagent notifications carry instead of a real summary. */
const HARNESS_SUMMARY = /delivered to you as a message|SubagentHandback|^\[harness/i;

function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Short argument summary for a tool call, e.g. `Bash(npm test)`. */
export function toolSummary(name: string, input: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const arg = toolArg(name, input);
  return arg ? `${name}(${arg})` : name;
}

function toolArg(name: string, input: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!input || typeof input !== 'object') return '';
  if (AGENT_TOOL_NAMES.has(name)) return oneLine(String(input.description ?? ''), 160);
  const key = ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'].find(
    (k) => typeof input[k] === 'string',
  );
  return key ? oneLine(String(input[key]), 160) : '';
}

/** Title of a tool row. A Bash command is already in the IN box, so its description reads better. */
function toolTitle(name: string, input: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (name === 'Bash' && typeof input?.description === 'string' && input.description.trim()) return oneLine(input.description, 160);
  return toolArg(name, input);
}

function toolInput(name: string, input: any): { text: string; kind: 'text' | 'diff' } { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!input || typeof input !== 'object') return { text: '', kind: 'text' };
  if (name === 'Bash' && typeof input.command === 'string') return { text: input.command, kind: 'text' };
  if ((name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') {
    const edits: { old_string?: string; new_string?: string }[] = Array.isArray(input.edits) ? input.edits : [input];
    const body = edits
      .map((e) => [
        ...String(e.old_string ?? '').split('\n').map((l) => '- ' + l),
        ...String(e.new_string ?? '').split('\n').map((l) => '+ ' + l),
      ].join('\n'))
      .join('\n…\n');
    return { text: `${input.file_path}\n${body}`, kind: 'diff' };
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    return { text: `${input.file_path}\n${String(input.content ?? '').split('\n').map((l) => '+ ' + l).join('\n')}`, kind: 'diff' };
  }
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const mark: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' };
    return { text: input.todos.map((t: { status?: string; content?: string }) => `${mark[t.status ?? ''] ?? '☐'} ${t.content ?? ''}`).join('\n'), kind: 'text' };
  }
  if (AGENT_TOOL_NAMES.has(name) && typeof input.prompt === 'string') return { text: input.prompt, kind: 'text' };
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === 'string') return { text: input[keys[0]], kind: 'text' };
  return { text: JSON.stringify(input, null, 2), kind: 'text' };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : ''))
      .join('\n');
  }
  return '';
}

/** Text and images of a user message we sent. */
export function userContent(content: unknown): { text: string; images: ImageData[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const images: ImageData[] = [];
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
      else if (c?.type === 'image' && c.source?.type === 'base64') images.push({ mediaType: c.source.media_type, data: c.source.data });
    }
  }
  return { text: texts.join('\n'), images };
}

export class Transcript {
  private items = new Map<string, Item>();
  private toolNames = new Map<string, string>();
  private agentLabels = new Map<string, string>();
  /** Permission/question item per request id, and per tool_use id for settling. */
  private byRequest = new Map<string, string>();
  private byToolUse = new Map<string, string>();
  private initShown = false;
  private turnHasOutput = false;
  private seq = 0;

  constructor(private opts: TranscriptOptions) {}

  all(): Item[] {
    return [...this.items.values()];
  }

  /** Items this record added or changed, in display order. */
  apply(rec: LogRecord): Item[] {
    const ev = rec.ev;
    const touched: Item[] = [];
    if (rec.dir === 'meta') this.meta(ev, touched);
    else if (rec.dir === 'out') this.out(ev, rec.t, touched);
    else this.inbound(ev, touched);
    if (touched.length && !(rec.dir === 'in' && ev.type === 'result')) this.turnHasOutput = true;
    return touched;
  }

  private put(item: Item, touched: Item[]): Item {
    this.items.set(item.id, item);
    if (!touched.includes(item)) touched.push(item);
    return item;
  }

  private note(text: string, tone: Tone, touched: Item[], divider = false) {
    this.put({ kind: 'note', id: `n${++this.seq}`, text, tone, divider }, touched);
  }

  private mine(ev: StreamEvent): boolean {
    return (ev.parent_tool_use_id ?? MAIN) === this.opts.owner;
  }

  private get isMain() {
    return this.opts.owner === MAIN;
  }

  // ---------- record kinds ----------

  private meta(ev: StreamEvent, touched: Item[]) {
    if (ev.type === 'fork') return this.note(`Forked from ${ev.fromName ?? ev.from} — the conversation continues here`, 'dim', touched, true);
    if (ev.type === 'spawn') {
      if (!ev.fork) this.note(ev.resume ? 'Session resumed' : 'Session started', 'dim', touched, true);
      return;
    }
    if (ev.type === 'exit') {
      const why = ev.reason === 'VS Code riavviato' ? 'VS Code restarted' : ev.reason ?? (ev.signal ? `signal ${ev.signal}` : `exit code ${ev.code}`);
      // Whatever was still open can no longer be answered.
      for (const it of this.items.values()) {
        if (it.kind === 'tool' && it.status === 'running') this.put({ ...it, status: 'error', output: it.output ?? '(process ended)' }, touched);
        if (it.kind === 'permission' && !it.outcome) this.put({ ...it, outcome: 'cancelled' }, touched);
      }
      return this.note(`Process exited (${why})`, 'dim', touched, true);
    }
    if (ev.type === 'error') return this.note(String(ev.message), 'error', touched);
    if (ev.type === 'stderr' && this.isMain) {
      const text = String(ev.text).trimEnd();
      if (text) this.note(text, 'dim', touched);
    }
  }

  private out(ev: StreamEvent, t: number, touched: Item[]) {
    if (!this.isMain) return;
    if (ev.type === 'user') {
      const { text, images } = userContent(ev.message?.content);
      this.put({ kind: 'user', id: `u${++this.seq}`, text, images, t }, touched);
      return;
    }
    if (ev.type === 'control_response') {
      const reqId = ev.response?.request_id;
      const r = ev.response?.response;
      const it = reqId && this.items.get(this.byRequest.get(reqId) ?? '');
      if (!it || !r) return;
      if (it.kind === 'question') {
        if (r.behavior === 'deny') this.put({ ...it, skipped: true }, touched);
        else this.put({ ...it, answers: r.updatedInput?.answers ?? {} }, touched);
      } else if (it.kind === 'permission') {
        const outcome = r.behavior === 'deny' ? 'denied' : r.updatedPermissions?.length ? 'always' : 'allowed';
        this.put({ ...it, outcome }, touched);
      }
      return;
    }
    if (ev.type === 'control_request' && ev.request?.subtype === 'interrupt') this.note('Interrupt requested', 'warn', touched);
  }

  private inbound(ev: StreamEvent, touched: Item[]) {
    switch (ev.type) {
      case 'codex_text':
        if (this.mine(ev)) this.put({ kind: 'text', id: `codex:${ev.id}`, markdown: ev.text }, touched);
        return;
      case 'system':
        return this.system(ev, touched);
      case 'assistant':
        return this.assistant(ev, touched);
      case 'user':
        return this.user(ev, touched);
      case 'control_request':
        if (this.mine(ev) || this.isMain) this.controlRequest(ev, touched);
        return;
      case 'control_cancel_request': {
        const it = this.items.get(this.byRequest.get(ev.request_id) ?? '');
        if (it?.kind === 'permission' && !it.outcome) this.put({ ...it, outcome: 'cancelled' }, touched);
        return;
      }
      case 'result':
        if (this.isMain) this.result(ev, touched);
        return;
    }
  }

  private system(ev: StreamEvent, touched: Item[]) {
    if (ev.subtype === 'init' && this.isMain && !this.initShown) {
      // claude re-emits init at every turn; the header line is only useful once.
      this.initShown = true;
      return this.note(`${modelLabel(ev.model)} · ${ev.cwd ?? ''} · ${ev.provider === 'codex' ? 'Codex' : `Claude Code ${ev.claude_code_version ?? ''}`}`, 'dim', touched);
    }
    if (ev.subtype === 'task_notification') {
      const label = this.agentLabels.get(ev.tool_use_id) ?? 'task';
      const ok = ev.status === 'completed';
      // A background call stays "running" until its task reports back.
      const call = this.items.get(ev.tool_use_id ?? '');
      if (call?.kind === 'tool' && call.status === 'running') this.put({ ...call, status: ok ? 'done' : 'error' }, touched);
      const summary = ev.summary && !HARNESS_SUMMARY.test(String(ev.summary)) ? String(ev.summary) : '';
      if (this.isMain) return this.note(`${label}: ${ev.status}${summary ? ' — ' + oneLine(summary, 300) : ''}`, ok ? 'ok' : 'error', touched);
      if (ev.tool_use_id === this.opts.owner) return this.note(`${ev.status}${summary ? ': ' + summary : ''}`, ok ? 'ok' : 'error', touched);
    }
    if (ev.subtype === 'api_retry' && this.isMain) {
      return this.note(`API retry ${ev.attempt}/${ev.max_retries} (${ev.error_status ?? ev.error ?? ''})`, 'warn', touched);
    }
  }

  private assistant(ev: StreamEvent, touched: Item[]) {
    for (const b of contentBlocks(ev)) {
      if (b.type === 'tool_use' && b.id) {
        this.toolNames.set(b.id, b.name ?? 'tool');
        if (AGENT_TOOL_NAMES.has(b.name ?? '')) this.agentLabels.set(b.id, b.input?.description ?? 'subagent');
      }
      if (!this.mine(ev)) continue;
      // Each content block of one API message arrives once, as its own event.
      if (b.type === 'text' && b.text?.trim()) {
        this.put({ kind: 'text', id: `t${++this.seq}`, markdown: b.text.trim() }, touched);
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        this.put({ kind: 'thinking', id: `k${++this.seq}`, text: b.thinking.trim() }, touched);
      } else if (b.type === 'tool_use' && b.id && b.name !== QUESTION_TOOL_NAME) {
        const name = b.name ?? 'tool';
        const inp = toolInput(name, b.input);
        const item: Item = {
          kind: 'tool',
          id: b.id,
          name,
          summary: toolTitle(name, b.input),
          input: inp.text,
          inputKind: inp.kind,
          status: 'running',
        };
        if (AGENT_TOOL_NAMES.has(name)) item.agent = { ownerId: b.id, background: Boolean(b.input?.run_in_background), model: b.input?.model };
        this.put(item, touched);
      }
    }
  }

  private user(ev: StreamEvent, touched: Item[]) {
    if (ev.codex_history && this.isMain) {
      const { text, images } = userContent(ev.message?.content);
      this.put({ kind: 'user', id: `u${++this.seq}`, text, images, t: 0 }, touched);
      return;
    }
    // In a subagent tab the first user message is the prompt it received from its parent.
    if (!this.isMain && this.mine(ev)) {
      for (const b of contentBlocks(ev)) {
        if (b.type === 'text' && b.text) this.put({ kind: 'user', id: `u${++this.seq}`, text: b.text, images: [], t: 0 }, touched);
      }
    }
    if (!this.mine(ev)) return;
    for (const b of contentBlocks(ev)) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      // A tool result settles a permission request for that call, however it was resolved.
      const pid = this.byToolUse.get(b.tool_use_id);
      const perm = pid ? this.items.get(pid) : undefined;
      if (perm?.kind === 'permission' && !perm.outcome) this.put({ ...perm, outcome: b.is_error ? 'cancelled' : 'allowed' }, touched);

      const it = this.items.get(b.tool_use_id);
      if (!it || it.kind !== 'tool') continue;
      const r = ev.tool_use_result;
      if (it.agent) {
        const note =
          r?.status === 'async_launched'
            ? 'started in background'
            : r?.totalTokens !== undefined
              ? `completed · ${r.totalTokens} tokens · ${modelLabel(r.resolvedModel)}${r.totalDurationMs ? ` · ${fmtDuration(r.totalDurationMs)}` : ''}`
              : undefined;
        const background = r?.status === 'async_launched' || it.agent.background;
        const status = b.is_error ? 'error' : background && r?.status === 'async_launched' ? 'running' : 'done';
        this.put({ ...it, status, output: resultText(b.content).slice(0, MAX_OUTPUT), agent: { ...it.agent, background, note } }, touched);
        continue;
      }
      const text = resultText(b.content);
      this.put(
        {
          ...it,
          status: b.is_error ? 'error' : 'done',
          output: text.slice(0, MAX_OUTPUT),
          outputTruncated: text.length > MAX_OUTPUT || undefined,
        },
        touched,
      );
    }
  }

  private controlRequest(ev: StreamEvent, touched: Item[]) {
    const r = ev.request ?? {};
    if (r.subtype !== 'can_use_tool') return;
    if (r.tool_name === QUESTION_TOOL_NAME) {
      const questions = (r.input?.questions ?? []).map((q: { question: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }) => ({
        question: q.question,
        multiSelect: q.multiSelect,
        options: q.options ?? [],
      }));
      const item = this.put({ kind: 'question', id: `q:${ev.request_id}`, requestId: ev.request_id, questions }, touched);
      this.byRequest.set(ev.request_id, item.id);
      if (r.tool_use_id) this.byToolUse.set(r.tool_use_id, item.id);
      return;
    }
    const summary = toolSummary(r.tool_name ?? 'tool', r.input);
    const desc = r.description && !summary.includes(r.description) ? String(r.description) : undefined;
    const item = this.put({ kind: 'permission', id: `p:${ev.request_id}`, requestId: ev.request_id, summary, description: desc }, touched);
    this.byRequest.set(ev.request_id, item.id);
    if (r.tool_use_id) this.byToolUse.set(r.tool_use_id, item.id);
  }

  private result(ev: StreamEvent, touched: Item[]) {
    const hadOutput = this.turnHasOutput;
    this.turnHasOutput = false;
    const dur = ev.duration_ms ? ` · ${fmtDuration(ev.duration_ms)}` : '';
    const cost = typeof ev.total_cost_usd === 'number' ? ` · session total ${fmtUsd(ev.total_cost_usd)}` : '';
    if (ev.subtype === 'error_during_execution' && ev.terminal_reason === 'aborted_streaming') {
      return this.note(`Turn interrupted${cost}`, 'warn', touched, true);
    }
    if (ev.is_error) {
      const why = Array.isArray(ev.errors) ? ev.errors.join('; ') : ev.result ?? ev.subtype;
      return this.note(`Error: ${oneLine(String(why), 300)}${cost}`, 'error', touched, true);
    }
    // Automatic follow-up turns (e.g. a background agent reporting back) can be silent.
    if (!hadOutput) return;
    this.note(`Turn complete${dur}${cost}`, 'dim', touched, true);
  }
}
