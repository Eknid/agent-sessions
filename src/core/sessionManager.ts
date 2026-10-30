import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeProcess, childEnv } from '../process/claudeProcess';
import { CodexProcess } from '../process/codexProcess';
import { AgentProvider, discoverModels } from './models';
import { claudeAccountUsage, codexAccountUsage } from './accountUsage';
import { readAccountUsage } from '../process/accountUsage';
import { CodexRpc } from '../process/codexRpc';
import { CodexPermissions, PermissionView, permissionChoices, claudePermissionView, codexPermissionView, codexPermissionPreset } from './permissions';
import { CODEX_COMMANDS, CODEX_TERMINAL_COMMANDS } from './codexCommands';
import {
  controlError,
  controlResponse,
  ImageAttachment,
  interruptRequest,
  LogRecord,
  PermissionDecision,
  StreamEvent,
  userMessage,
} from './events';
import { PriceTable } from './pricing';
import { SessionMeta, SessionModel, SessionView, UiState } from './sessionModel';

/*
 * Layer 1 of the design: the only owner of claude processes. Every byte that crosses a
 * process boundary is appended to the session's event log, and state is always the
 * reducer's view of that log. UI layers subscribe; closing a tab never touches a process.
 */

export interface ManagerOptions {
  storageDir: string;
  command: string;
  codexCommand?: string;
  codexExtraArgs?: string[];
  codexApprovalPolicy?: string;
  codexApprovalsReviewer?: CodexPermissions['approvalsReviewer'];
  codexSandbox?: string;
  extraArgs?: string[];
  prices?: PriceTable;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface CreateOptions {
  codexPermissions?: CodexPermissions;
  effort?: string;
  provider?: AgentProvider;
  name?: string;
  cwd: string;
  model?: string;
  permissionMode?: string;
  prompt?: string;
  /** Adopt an existing Claude Code conversation (its session id) instead of starting a new one. */
  resumeId?: string;
}

export interface SlashCommands {
  forwardUnknown?: boolean;
  local?: string[];
  descriptions?: Record<string, string>;
  skills?: string[];
  /** Accepted by the headless process. */
  headless: string[];
  /** Only available in the interactive TUI. */
  terminalOnly: string[];
}

interface StoredSession extends SessionMeta {
  codexPermissions?: CodexPermissions;
  effort?: string;
  /** Codex assigns its own thread ID; the extension ID stays stable across forks/reloads. */
  conversationId?: string;
  forkConversationId?: string;
  model?: string;
  permissionMode?: string;
  /** Conversation this session was forked from (`--resume <it> --fork-session`). */
  forkedFrom?: string;
  archived?: boolean;
}

/** A message the user sent while Claude was busy; it goes out when the turn is over. */
export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageAttachment[];
  queuedAt: number;
}

/** How a process starts: a fresh conversation, an existing one, or a copy of another. */
type SpawnMode = 'new' | 'resume' | 'fork';

/**
 * Whether the session's own conversation exists on disk: Claude writes it only once it gets a
 * message. A fork's copied history belongs to its parent, so only what follows the fork counts.
 */
function hasConversation(all: readonly LogRecord[]): boolean {
  let from = 0;
  all.forEach((r, i) => {
    if (r.dir === 'meta' && r.ev.type === 'fork') from = i;
  });
  const records = from ? all.slice(from) : all;
  return records.some((r) => (r.dir === 'out' && r.ev.type === 'user') || (r.dir === 'meta' && r.ev.type === 'spawn' && r.ev.resume && !r.ev.fork));
}

interface Live {
  permissionView?: PermissionView;
  permissionPending?: Promise<void>;
  effortPending?: Promise<void>;
  stored: StoredSession;
  model: SessionModel;
  records: LogRecord[];
  proc?: ClaudeProcess | CodexProcess;
  stderrLines: number;
  lastUi: UiState;
  /** Messages waiting for Claude to finish (in memory only), oldest first. */
  queue: QueuedMessage[];
  removed?: boolean;
  /** Bytes of the log file already reflected in `records`. */
  offset: number;
  /** Set while another VS Code window runs this session's process. */
  remote?: RemoteOwner;
}

/** Written by the window that runs a session's process, so other windows can follow it. */
interface OwnerFile {
  instance: string;
  pid: number;
  queue: QueuedMessage[];
}

interface RemoteOwner extends OwnerFile {
  key: string;
}

/** A call another window asks the owner of a session to make. */
interface RemoteRequest {
  sessionId: string;
  op: 'send' | 'unqueue' | 'allow' | 'deny' | 'answer' | 'interrupt' | 'stop' | 'changeEffort' | 'changePermissions';
  args: unknown[];
}

/** An owner that stops refreshing its file for this long is treated as gone. */
const OWNER_STALE_MS = 20_000;
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;

export interface ManagerEvents {
  record: (id: string, rec: LogRecord) => void;
  changed: (id: string) => void;
  listChanged: () => void;
  transition: (id: string, from: UiState, to: UiState, view: SessionView) => void;
  /** The log was rewritten by another window: tabs must replay it from the start. */
  reloaded: (id: string) => void;
}

const MAX_STDERR_LINES = 200;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>();
  private accountData = new Map<AgentProvider, { response?: any; error?: string; fetchedAt: number }>();
  private accountPending = new Map<AgentProvider, Promise<void>>();
  private accountProbes = new Set<ClaudeProcess | CodexRpc>();
  private prices: PriceTable;
  /** Last command list any claude reported: headless claude only sends init after the first message. */
  private commandCache: SlashCommands = { headless: [], terminalOnly: [] };
  private now: () => number;
  /** Identifies this manager (one per VS Code window) to the other windows sharing the storage. */
  readonly instance = randomUUID();
  private watchers: fs.FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private syncTimer?: NodeJS.Timeout;
  private fullSync = false;
  private dirtyLogs = new Set<string>();
  private disposed = false;

  constructor(private opts: ManagerOptions) {
    super();
    this.prices = opts.prices ?? new PriceTable();
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
    fs.mkdirSync(this.ownerDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  override on<E extends keyof ManagerEvents>(event: E, listener: ManagerEvents[E]): this {
    return super.on(event, listener);
  }

  override off<E extends keyof ManagerEvents>(event: E, listener: ManagerEvents[E]): this {
    return super.off(event, listener);
  }

  setCommand(command: string, extraArgs: string[] = []) {
    this.opts.command = command;
    this.opts.extraArgs = extraArgs;
  }

  setCodex(command: string, extraArgs: string[] = [], approvalPolicy = 'on-request', sandbox = 'workspace-write', approvalsReviewer: CodexPermissions['approvalsReviewer'] = 'auto_review') {
    this.opts.codexCommand = command;
    this.opts.codexExtraArgs = extraArgs;
    this.opts.codexApprovalPolicy = approvalPolicy;
    this.opts.codexSandbox = sandbox;
    this.opts.codexApprovalsReviewer = approvalsReviewer;
  }

  setPrices(prices: PriceTable) {
    this.prices = prices;
    // Estimates are booked at apply time, so rebuild every model from its log.
    for (const s of this.sessions.values()) {
      s.model = this.replay(s.stored, s.records);
      this.emit('changed', s.stored.id);
    }
  }

  private get commandsPath() {
    return path.join(this.opts.storageDir, 'commands.json');
  }

  private get logDir() {
    return path.join(this.opts.storageDir, 'logs');
  }

  /** The single shared index used up to 0.11.10: now only read, to import what it lists. */
  private get legacyIndexPath() {
    return path.join(this.opts.storageDir, 'sessions.json');
  }

  /** One metadata file per session, so no window can overwrite another window's sessions. */
  private get metaDir() {
    return path.join(this.opts.storageDir, 'sessions');
  }

  private metaPath(id: string) {
    return path.join(this.metaDir, `${id}.json`);
  }

  private logPath(id: string) {
    return path.join(this.logDir, `${id}.ndjson`);
  }

  private get ownerDir() {
    return path.join(this.opts.storageDir, 'owners');
  }

  private ownerPath(id: string) {
    return path.join(this.ownerDir, `${id}.json`);
  }

  private get inboxDir() {
    return path.join(this.opts.storageDir, 'requests', this.instance);
  }

  // ---------- persistence ----------

  /** Rebuild every known session from its event log. Processes from a previous host are gone. */
  load() {
    try {
      this.commandCache = JSON.parse(fs.readFileSync(this.commandsPath, 'utf8'));
    } catch {
      /* first run */
    }
    this.recover();
    const owners = this.readOwners();
    for (const s of this.readIndex()) {
      const live = this.loadSession(s, owners);
      // Its process died with the window that ran it, unless that window is still open.
      if (live.model.state !== 'exited' && !live.remote) this.append(live, 'meta', { type: 'exit', reason: 'VS Code restarted' });
      live.lastUi = live.model.uiState();
    }
    this.emit('listChanged');
    this.removeStaleInboxes();
    this.watch();
  }

  /** Inboxes left behind by windows that did not shut down cleanly. */
  private removeStaleInboxes() {
    const root = path.join(this.opts.storageDir, 'requests');
    try {
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (name !== this.instance && Date.now() - fs.statSync(dir).mtimeMs > 24 * 3600_000) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }

  private loadSession(s: StoredSession, owners: Map<string, RemoteOwner>): Live {
    const { records, bytes } = this.readLog(s.id);
    const model = this.replay(s, records);
    const live: Live = { stored: s, model, records, stderrLines: 0, lastUi: model.uiState(), queue: [], offset: bytes, remote: owners.get(s.id) };
    this.sessions.set(s.id, live);
    return live;
  }

  private readIndex(): StoredSession[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.metaDir);
    } catch {
      return [];
    }
    const list: StoredSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const s: StoredSession = JSON.parse(fs.readFileSync(path.join(this.metaDir, name), 'utf8'));
        if (s?.id === name.slice(0, -5)) list.push(s);
      } catch {
        /* being replaced */
      }
    }
    return list;
  }

  /**
   * Brings back sessions whose metadata is missing: those only listed in the old shared index,
   * then any log left without an entry (older versions let one window drop another's sessions).
   */
  private recover() {
    const known = new Set(this.readIndex().map((s) => s.id));
    const valid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id);
    const write = (s: StoredSession) => {
      try {
        this.writeMeta(s);
        known.add(s.id);
      } catch (err) {
        this.emit('storageError', err);
      }
    };
    let legacy: StoredSession[] = [];
    try {
      const list = JSON.parse(fs.readFileSync(this.legacyIndexPath, 'utf8'));
      if (Array.isArray(list)) legacy = list;
    } catch {
      /* none */
    }
    // A session removed since has no log any more: it must not come back.
    for (const s of legacy) if (valid(s?.id) && !known.has(s.id) && fs.existsSync(this.logPath(s.id))) write(s);
    let logs: string[] = [];
    try {
      logs = fs.readdirSync(this.logDir);
    } catch {
      return;
    }
    for (const name of logs) {
      const id = name.slice(0, -'.ndjson'.length);
      if (!name.endsWith('.ndjson') || !valid(id) || known.has(id)) continue;
      const s = this.fromLog(id);
      if (s) write(s);
    }
  }

  /** Metadata rebuilt from a log alone, filed in the archive. Undefined when the log is too thin. */
  private fromLog(id: string): StoredSession | undefined {
    const { records } = this.readLog(id);
    let cwd: string | undefined;
    let provider: AgentProvider = 'claude';
    let conversationId: string | undefined;
    let model: string | undefined;
    let forkedFrom: string | undefined;
    let prompt: string | undefined;
    for (const { dir, ev } of records) {
      if (dir === 'meta' && ev.type === 'spawn' && /codex/i.test(path.basename(String(ev.command ?? '')))) provider = 'codex';
      if (dir === 'meta' && ev.type === 'fork' && typeof ev.from === 'string') forkedFrom ??= ev.from;
      if (dir === 'in' && ev.type === 'system' && ev.subtype === 'init') {
        if (typeof ev.cwd === 'string') cwd ??= ev.cwd;
        if (ev.provider === 'codex') provider = 'codex';
        if (typeof ev.conversation_id === 'string') conversationId ??= ev.conversation_id;
        if (typeof ev.model === 'string') model ??= ev.model;
      }
      if (dir === 'out' && ev.type === 'user' && prompt === undefined) {
        const content = ev.message?.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? content.map((c: any) => (c?.type === 'text' ? c.text : '')).join(' ') : '';
        prompt = text.trim().split('\n')[0].trim();
      }
    }
    if (!cwd || prompt === undefined) return undefined;
    return {
      id,
      provider,
      conversationId: provider === 'codex' ? conversationId : undefined,
      name: prompt.slice(0, 60) || `${path.basename(cwd)}-${id.slice(0, 4)}`,
      cwd,
      createdAt: records[0]?.t ?? this.now(),
      model,
      forkedFrom,
      archived: true,
    };
  }

  /** Parses the complete lines of a log from `from`; `bytes` ends after the last complete line. */
  private readLog(id: string, from = 0): { records: LogRecord[]; bytes: number } {
    let buf: Buffer;
    try {
      const fd = fs.openSync(this.logPath(id), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        buf = Buffer.alloc(Math.max(0, size - from));
        let read = 0;
        while (read < buf.length) {
          const n = fs.readSync(fd, buf, read, buf.length - read, from + read);
          if (!n) break;
          read += n;
        }
        buf = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { records: [], bytes: from };
    }
    const end = buf.lastIndexOf(0x0a) + 1;
    const out: LogRecord[] = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn line after a crash */
      }
    }
    // A crash can leave a last line without its newline: it still counts once loaded from scratch.
    if (from === 0 && end < buf.length) {
      try {
        out.push(JSON.parse(buf.subarray(end).toString('utf8')));
      } catch {
        /* torn */
      }
      return { records: out, bytes: buf.length };
    }
    return { records: out, bytes: from + end };
  }

  private replay(s: SessionMeta, records: LogRecord[]): SessionModel {
    const m = new SessionModel({ id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, provider: s.provider ?? 'claude', requestedModel: (s as StoredSession).model }, this.prices);
    for (const r of records) m.apply(r);
    return m;
  }

  private writeMeta(s: StoredSession) {
    const file = this.metaPath(s.id);
    const tmp = `${file}.${this.instance}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, file);
  }

  /**
   * Writes one session's metadata. Only `created` may add a file: a missing one means another
   * window removed the session, which must not come back.
   */
  private saveMeta(s: Live, created = false) {
    if (s.removed || (!created && !fs.existsSync(this.metaPath(s.stored.id)))) return;
    this.writeMeta(s.stored);
  }

  private append(s: Live, dir: LogRecord['dir'], ev: StreamEvent) {
    if (s.removed) return;
    // Another window may have written to the log since: read that first, so it stays in order.
    if (!s.proc) this.tail(s);
    const rec: LogRecord = { t: this.now(), dir, ev };
    s.records.push(rec);
    try {
      const line = JSON.stringify(rec) + '\n';
      fs.appendFileSync(this.logPath(s.stored.id), line);
      s.offset += Buffer.byteLength(line);
    } catch (err) {
      // Keep the session usable in memory; the next reload will miss this record.
      this.emit('storageError', err);
    }
    const changed = s.model.apply(rec);
    // Settle the transition before any listener runs: a listener may answer a permission
    // synchronously, and that nested append must see this transition as already happened.
    const ui = s.model.uiState();
    if (ui !== s.lastUi) {
      const from = s.lastUi;
      s.lastUi = ui;
      this.emit('transition', s.stored.id, from, ui, s.model.view());
    }
    this.emit('record', s.stored.id, rec);
    if (changed) this.emit('changed', s.stored.id);
    this.drain(s);
  }

  // ---------- other VS Code windows ----------
  /*
   * Every window has its own manager on the same storage. A session's process runs in one
   * window, which alone writes its log and keeps an owner file fresh. The other windows tail
   * the log to show the same transcript, and send their actions to the owner's inbox.
   */

  private claim(s: Live) {
    this.publish(s, true);
    s.remote = undefined;
  }

  private release(s: Live) {
    try {
      const file = this.ownerPath(s.stored.id);
      const owner: OwnerFile = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (owner.instance === this.instance) fs.unlinkSync(file);
    } catch {
      /* not ours, or gone */
    }
  }

  /** Rewrites the owner file, which also carries the queue for the other windows. */
  private publish(s: Live, force = false) {
    if (!force && !s.proc) return;
    const owner: OwnerFile = { instance: this.instance, pid: process.pid, queue: s.queue };
    const file = this.ownerPath(s.stored.id);
    try {
      fs.writeFileSync(`${file}.${this.instance}.tmp`, JSON.stringify(owner));
      fs.renameSync(`${file}.${this.instance}.tmp`, file);
    } catch (err) {
      this.emit('storageError', err);
    }
  }

  private queueChanged(s: Live) {
    this.publish(s);
    this.emit('changed', s.stored.id);
  }

  /** The other window running this session, if any. */
  private ownerOf(s: Live): RemoteOwner | undefined {
    return s.proc ? undefined : s.remote;
  }

  /** Hands an action to the window that runs the session. False when this window should do it. */
  private forward(s: Live, op: RemoteRequest['op'], args: unknown[]): boolean {
    const owner = this.ownerOf(s);
    if (!owner) return false;
    const dir = path.join(this.opts.storageDir, 'requests', owner.instance);
    const file = path.join(dir, `${this.now()}-${randomUUID()}.json`);
    const request: RemoteRequest = { sessionId: s.stored.id, op, args };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(request));
      fs.renameSync(file + '.tmp', file);
    } catch (err) {
      this.emit('storageError', err);
    }
    return true;
  }

  /** Live owner files of other windows, by session id. */
  private readOwners(): Map<string, RemoteOwner> {
    const owners = new Map<string, RemoteOwner>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.ownerDir);
    } catch {
      return owners;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.ownerDir, name);
      try {
        const stat = fs.statSync(file);
        const owner: OwnerFile = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (owner.instance === this.instance || !pidAlive(owner.pid) || Date.now() - stat.mtimeMs > OWNER_STALE_MS) continue;
        owners.set(name.slice(0, -5), { ...owner, key: `${owner.instance}:${JSON.stringify(owner.queue.map((q) => q.id))}` });
      } catch {
        /* being replaced */
      }
    }
    return owners;
  }

  private watch() {
    if (this.disposed || this.watchers.length) return;
    const on = (dir: string, fn: (name: string) => void) => {
      try {
        this.watchers.push(fs.watch(dir, (_event, name) => fn(name ? String(name) : '')));
      } catch {
        /* polling still catches up */
      }
    };
    on(this.metaDir, () => this.scheduleSync());
    on(this.ownerDir, () => this.scheduleSync());
    on(this.inboxDir, () => this.scheduleSync());
    on(this.logDir, (name) => {
      if (name.endsWith('.ndjson')) this.dirtyLogs.add(name.slice(0, -7));
      this.scheduleSync(true);
    });
    const poll = setInterval(() => this.sync(), POLL_MS);
    // The owner file's age tells other windows this one is still open.
    const beat = setInterval(() => {
      const now = new Date();
      try { fs.utimesSync(this.inboxDir, now, now); } catch { /* recreated by the next sender */ }
      for (const s of this.sessions.values()) {
        if (!s.proc) continue;
        try { fs.utimesSync(this.ownerPath(s.stored.id), now, now); } catch { this.publish(s); }
      }
    }, HEARTBEAT_MS);
    poll.unref?.();
    beat.unref?.();
    this.timers.push(poll, beat);
  }

  private scheduleSync(logsOnly = false) {
    if (!logsOnly) this.fullSync = true;
    if (this.syncTimer || this.disposed) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      if (this.fullSync) this.sync();
      else this.syncLogs();
    }, 15);
  }

  private syncLogs() {
    const ids = [...this.dirtyLogs];
    this.dirtyLogs.clear();
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && !s.proc) this.tail(s);
    }
  }

  /** Catches up with every change other windows made to the shared storage. */
  sync() {
    if (this.disposed) return;
    this.fullSync = false;
    this.dirtyLogs.clear();
    this.processInbox();
    const owners = this.readOwners();
    let listChanged = false;
    const index = this.readIndex();
    const onDisk = new Set(index.map((e) => e.id));
    for (const entry of index) {
      const s = this.sessions.get(entry.id);
      if (!s) {
        this.loadSession(entry, owners);
        listChanged = true;
        continue;
      }
      if (JSON.stringify(entry) === JSON.stringify(s.stored)) continue;
      const wasArchived = Boolean(s.stored.archived);
      s.stored = entry;
      s.model.rename(entry.name);
      if (entry.archived) s.proc?.kill();
      if (wasArchived !== Boolean(entry.archived)) listChanged = true;
      this.emit('changed', entry.id);
    }
    for (const [id, s] of this.sessions) {
      // Removed in another window only when its file is gone, not when it could not be read.
      if (onDisk.has(id) || fs.existsSync(this.metaPath(id))) continue;
      s.removed = true;
      s.proc?.kill();
      this.sessions.delete(id);
      listChanged = true;
    }
    for (const s of this.sessions.values()) {
      if (s.proc) continue;
      this.tail(s);
      const owner = owners.get(s.stored.id);
      if (owner?.key !== s.remote?.key) {
        s.remote = owner;
        this.emit('changed', s.stored.id);
      }
      if (!owner && s.model.state !== 'exited' && this.abandoned(s)) this.append(s, 'meta', { type: 'exit', reason: 'VS Code window closed' });
    }
    if (listChanged) this.emit('listChanged');
  }

  /** A log nobody owns that has not moved for a while: the window that ran it is gone. */
  private abandoned(s: Live): boolean {
    try {
      return Date.now() - fs.statSync(this.logPath(s.stored.id)).mtimeMs > OWNER_STALE_MS / 2;
    } catch {
      return true;
    }
  }

  /** Applies records another window appended to the log. */
  private tail(s: Live) {
    if (s.removed) return;
    let size: number;
    try {
      size = fs.statSync(this.logPath(s.stored.id)).size;
    } catch {
      return;
    }
    if (size === s.offset) return;
    if (size < s.offset) {
      // Rewritten from scratch: replay all of it.
      const { records, bytes } = this.readLog(s.stored.id);
      s.records = records;
      s.model = this.replay(s.stored, records);
      s.offset = bytes;
      s.lastUi = s.model.uiState();
      this.emit('reloaded', s.stored.id);
      this.emit('changed', s.stored.id);
      return;
    }
    const { records, bytes } = this.readLog(s.stored.id, s.offset);
    s.offset = bytes;
    let changed = false;
    for (const rec of records) {
      s.records.push(rec);
      if (s.model.apply(rec)) changed = true;
      this.emit('record', s.stored.id, rec);
    }
    // Notifications belong to the window that runs the session.
    s.lastUi = s.model.uiState();
    if (changed) this.emit('changed', s.stored.id);
  }

  private processInbox() {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.inboxDir).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.inboxDir, name);
      let request: RemoteRequest;
      try {
        request = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.unlinkSync(file);
      } catch {
        continue;
      }
      this.handleRequest(request);
    }
  }

  private handleRequest(r: RemoteRequest) {
    const id = r.sessionId;
    const a = Array.isArray(r.args) ? r.args : [];
    const s = this.sessions.get(id);
    if (!s) return;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (r.op) {
      case 'send': return void this.send(id, str(a[0]), Array.isArray(a[1]) ? a[1] as ImageAttachment[] : []);
      case 'unqueue': return void this.unqueue(id, str(a[0]));
      case 'allow': return void this.allow(id, str(a[0]), a[1] === true);
      case 'deny': return void this.deny(id, str(a[0]), str(a[1]) || undefined);
      case 'answer': return void this.answer(id, str(a[0]), (a[1] ?? {}) as Record<string, string>);
      case 'interrupt': return void this.interrupt(id);
      case 'stop': return this.stop(id);
      case 'changeEffort': return void this.changeEffort(id, str(a[0])).catch((err) => this.emit('storageError', err));
      case 'changePermissions': return void this.changePermissions(id, str(a[0])).catch((err) => this.emit('storageError', err));
    }
  }

  // ---------- queries ----------

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => this.viewOf(s)).sort((a, b) => b.createdAt - a.createdAt);
  }

  view(id: string): SessionView | undefined {
    const s = this.sessions.get(id);
    return s && this.viewOf(s);
  }

  private viewOf(s: Live): SessionView {
    const v = s.model.view();
    v.effort = s.stored.effort ?? 'medium';
    const provider = s.stored.provider ?? 'claude';
    v.permissions = s.permissionView ?? (provider === 'codex'
      ? codexPermissionView(s.stored.codexPermissions ?? this.defaultCodexPermissions())
      : claudePermissionView(s.stored.permissionMode));
    const account = this.accountData.get(provider);
    if (account) v.accountUsage = account.error
      ? { label: `${provider === 'codex' ? 'Usage' : 'Credits'} left —`, detail: account.error, fetchedAt: account.fetchedAt }
      : provider === 'codex' ? codexAccountUsage(account.response, s.stored.model, account.fetchedAt) : claudeAccountUsage(account.response, account.fetchedAt);
    if (s.stored.archived) v.archived = true;
    return v;
  }

  /** Messages waiting for the current turn to end, oldest (next to go) first. */
  queue(id: string): readonly QueuedMessage[] {
    const s = this.sessions.get(id);
    return (s?.remote && !s.proc ? s.remote.queue : s?.queue) ?? [];
  }

  records(id: string): readonly LogRecord[] {
    return this.sessions.get(id)?.records ?? [];
  }

  isAlive(id: string): boolean {
    const s = this.sessions.get(id);
    return Boolean(s?.proc?.alive || (s?.remote && !s.proc));
  }

  /** Whether the session's process runs in another VS Code window. */
  isRemote(id: string): boolean {
    const s = this.sessions.get(id);
    return Boolean(s?.remote && !s.proc);
  }

  stored(id: string): StoredSession | undefined {
    return this.sessions.get(id)?.stored;
  }

  /** Provider-native conversation ID accepted by Claude/Codex resume commands. */
  resumeId(id: string): string | undefined {
    const stored = this.sessions.get(id)?.stored;
    if (!stored) return;
    return stored.provider === 'codex' ? stored.conversationId : stored.id;
  }

  // ---------- lifecycle ----------

  slashCommands(id?: string): SlashCommands {
    const session = id ? this.sessions.get(id) : undefined;
    if (session?.stored.provider === 'codex') {
      const skills = session.model.codexSkills;
      return { forwardUnknown: false, local: Object.keys(CODEX_COMMANDS), headless: skills.map((s) => s.name),
        skills: skills.map((s) => s.name), terminalOnly: CODEX_TERMINAL_COMMANDS,
        descriptions: { ...CODEX_COMMANDS, ...Object.fromEntries(skills.map((s) => [s.name, s.description])) } };
    }
    const m = id ? this.sessions.get(id)?.model : undefined;
    if (m?.slashCommands.length) return { headless: m.slashCommands, terminalOnly: m.terminalOnlyCommands };
    return this.commandCache;
  }

  async codexCommand(id: string, name: string, args = ''): Promise<string> {
    const session = this.sessions.get(id);
    if (!session || session.stored.provider !== 'codex') throw new Error('This command requires a Codex session.');
    if (this.ownerOf(session)) throw new Error('This session runs in another VS Code window: use the command there.');
    if (!session.proc?.alive) this.resume(id);
    if (!(session.proc instanceof CodexProcess)) throw new Error('Codex is not running.');
    return session.proc.command(name, args);
  }

  /** The managed session for a Claude Code conversation id, if any. */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  create(o: CreateOptions): string {
    if (o.resumeId && this.sessions.has(o.resumeId)) return o.resumeId;
    const id = o.resumeId ?? randomUUID();
    const stored: StoredSession = {
      id,
      provider: o.provider ?? 'claude',
      conversationId: o.provider === 'codex' ? o.resumeId : undefined,
      name: o.name?.trim() || `${path.basename(o.cwd)}-${id.slice(0, 4)}`,
      cwd: o.cwd,
      createdAt: this.now(),
      model: o.model || undefined,
      effort: o.effort ?? 'medium',
      permissionMode: o.permissionMode,
      codexPermissions: o.provider === 'codex' ? { ...(o.codexPermissions ?? this.defaultCodexPermissions()) } : undefined,
    };
    const live: Live = {
      stored,
      model: this.replay(stored, []),
      records: [],
      stderrLines: 0,
      lastUi: 'done',
      queue: [],
      offset: 0,
    };
    this.sessions.set(id, live);
    // Claimed before other windows can see it, so none of them takes the new log as abandoned.
    this.claim(live);
    // Metadata first: a log without it is taken for one an older version lost.
    this.saveMeta(live, true);
    fs.writeFileSync(this.logPath(id), '');
    this.emit('listChanged');
    this.spawn(live, o.resumeId ? 'resume' : 'new');
    if (o.prompt?.trim()) this.send(id, o.prompt);
    return id;
  }

  /** Whether `id` has a conversation on disk that can be forked. */
  canFork(id: string): boolean {
    const s = this.sessions.get(id);
    return Boolean(s && (s.stored.provider === 'codex' ? s.stored.conversationId && hasConversation(s.records) : hasConversation(s.records)));
  }

  /**
   * A new session that continues a copy of `parentId`'s conversation. The parent's log is
   * copied so the tab shows the history; the parent keeps running untouched.
   */
  fork(parentId: string, name?: string): string | undefined {
    const parent = this.sessions.get(parentId);
    if (!parent || !this.canFork(parentId)) return undefined;
    const id = randomUUID();
    const p = parent.stored;
    const stored: StoredSession = {
      id,
      provider: p.provider,
      forkConversationId: p.provider === 'codex' ? p.conversationId : undefined,
      name: name?.trim() || `${p.name} (fork)`,
      cwd: p.cwd,
      createdAt: this.now(),
      model: p.model,
      effort: p.effort ?? 'medium',
      permissionMode: p.permissionMode,
      codexPermissions: p.codexPermissions && { ...p.codexPermissions },
      forkedFrom: parentId,
    };
    const records = [...parent.records];
    const text = records.map((r) => JSON.stringify(r) + '\n').join('');
    const live: Live = { stored, model: this.replay(stored, records), records, stderrLines: 0, lastUi: 'done', queue: [], offset: Buffer.byteLength(text) };
    this.sessions.set(id, live);
    this.claim(live);
    this.saveMeta(live, true);
    fs.writeFileSync(this.logPath(id), text);
    this.append(live, 'meta', { type: 'fork', from: parentId, fromName: p.name });
    live.lastUi = live.model.uiState();
    this.emit('listChanged');
    this.spawn(live, 'fork');
    return id;
  }

  resume(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.proc?.alive || this.ownerOf(s)) return;
    // --resume needs a transcript on disk, which exists only once a message was sent. Until
    // then a fork is forked again from its parent.
    if (hasConversation(s.records)) this.spawn(s, 'resume');
    else this.spawn(s, s.stored.forkedFrom ? 'fork' : 'new');
  }

  /** Resume the same Codex thread with a new model; never discard a running turn or history. */
  async changeCodexModel(id: string, model: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.stored.provider !== 'codex') throw new Error('Select a Codex session.');
    if (!model.trim()) throw new Error('Select an explicit Codex model.');
    if (s.proc?.alive && ['running', 'waiting', 'starting'].includes(s.model.state)) {
      throw new Error('Interrupt or finish the current turn before changing the model.');
    }
    await this.stopAndWait(id);
    if (s.removed) return;
    s.stored.model = model.trim();
    this.saveMeta(s);
    this.resume(id);
  }

  permissionChoices(id: string) {
    const s = this.sessions.get(id);
    return s ? permissionChoices(s.stored.provider ?? 'claude') : [];
  }

  async changePermissions(id: string, value: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session not found.');
    const provider = s.stored.provider ?? 'claude';
    if (!permissionChoices(provider).some((choice) => choice.value === value)) throw new Error('Invalid permission mode.');
    if (this.forward(s, 'changePermissions', [value])) return;
    const previous = s.permissionPending;
    const settings = provider === 'codex' ? codexPermissionPreset(value) : undefined;
    const pending = Promise.resolve(previous).catch(() => undefined).then(async () => {
      if (s.removed) return;
      const proc = s.proc;
      let mode = value;
      if (proc?.alive) {
        if (proc instanceof CodexProcess) await proc.setPermissions(settings!);
        else {
          const result = await proc.requestControl({ subtype: 'set_permission_mode', mode: value });
          mode = result?.mode ?? value;
          if (claudePermissionView(mode).value !== value) throw new Error(`Claude kept permission mode ${mode}.`);
        }
      }
      if (s.removed) return;
      if (settings) s.stored.codexPermissions = settings;
      else s.stored.permissionMode = claudePermissionView(mode).value;
      s.permissionView = settings ? codexPermissionView(settings) : claudePermissionView(mode);
      this.saveMeta(s);
      this.emit('changed', id);
    });
    s.permissionPending = pending;
    try { await pending; } finally {
      if (s.permissionPending === pending) s.permissionPending = undefined;
      this.drain(s);
    }
  }

  async effortChoices(id: string): Promise<string[]> {
    const s = this.sessions.get(id);
    if (!s) return [];
    const provider = s.stored.provider ?? 'claude';
    const models = await discoverModels(provider, provider === 'codex' ? this.opts.codexCommand ?? 'codex' : this.opts.command,
      s.stored.cwd, provider === 'codex' ? this.opts.codexExtraArgs : this.opts.extraArgs);
    const current = s.stored.model || s.model.view().model;
    const entry = models.find((m) => m.value === current || m.aliases?.includes(current ?? '')) ?? models.find((m) => m.configuredDefault);
    return entry?.efforts ?? (!current ? models.defaultEfforts : undefined) ?? ['low', 'medium', 'high'];
  }

  async changeEffort(id: string, effort: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session not found.');
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Invalid effort.');
    if (this.forward(s, 'changeEffort', [effort])) return;
    await s.effortPending;
    const proc = s.proc;
    const pending = (async () => {
      if (proc instanceof ClaudeProcess && proc.alive) {
        await proc.requestControl({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
      } else if (proc instanceof CodexProcess && proc.alive) await proc.setEffort(effort);
      if (s.removed) return;
      s.stored.effort = effort;
      this.saveMeta(s);
      this.emit('changed', id);
    })();
    s.effortPending = pending;
    try { await pending; } finally {
      if (s.effortPending === pending) s.effortPending = undefined;
      this.drain(s);
    }
  }

  refreshUsage(id: string, force = false): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve();
    const provider = s.stored.provider ?? 'claude';
    const pending = this.accountPending.get(provider);
    if (pending) return pending;
    const data = this.accountData.get(provider);
    if (!force && data && this.now() - data.fetchedAt < 45_000) return Promise.resolve();
    const proc = s.proc;
    const request = proc?.alive
      ? proc instanceof CodexProcess ? proc.readUsage() : proc.requestControl({ subtype: 'get_usage', skip_behaviors: true })
      : readAccountUsage(provider, { command: provider === 'codex' ? this.opts.codexCommand ?? 'codex' : this.opts.command,
          args: provider === 'codex' ? this.codexSpec.args : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...(this.opts.extraArgs ?? [])],
          cwd: s.stored.cwd, env: this.opts.env ?? childEnv() }, (process, add) => {
          if (add) this.accountProbes.add(process); else this.accountProbes.delete(process);
        });
    const refresh = request.then((response) => {
      this.accountData.set(provider, { response, fetchedAt: this.now() });
    }).catch(() => {
      this.accountData.set(provider, { error: 'Account usage could not be refreshed. Click to retry.', fetchedAt: this.now() });
    }).finally(() => {
      this.accountPending.delete(provider);
      for (const live of this.sessions.values()) if ((live.stored.provider ?? 'claude') === provider) this.emit('changed', live.stored.id);
    });
    this.accountPending.set(provider, refresh);
    return refresh;
  }

  get codexSpec() {
    return { command: this.opts.codexCommand ?? 'codex', args: ['app-server', ...(this.opts.codexExtraArgs ?? [])], env: this.opts.env ?? childEnv() };
  }

  private buildArgs(s: Live, mode: SpawnMode): string[] {
    const st = s.stored;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--permission-prompt-tool', 'stdio',
      '--allow-dangerously-skip-permissions',
      ...(mode === 'resume' ? ['--resume', st.id] : []),
      ...(mode === 'fork' ? ['--resume', st.forkedFrom!, '--fork-session'] : []),
      ...(mode === 'resume' ? [] : ['--session-id', st.id]),
    ];
    if (st.model) args.push('--model', st.model);
    args.push(...(this.opts.extraArgs ?? []));
    if (st.permissionMode) args.push('--permission-mode', st.permissionMode);
    args.push('--effort', st.effort ?? 'medium');
    return args;
  }

  private spawn(s: Live, mode: SpawnMode) {
    const codex = s.stored.provider === 'codex';
    const proc = codex ? new CodexProcess() : new ClaudeProcess();
    // This window takes the session over: catch up with what others wrote, then own the log.
    this.tail(s);
    this.claim(s);
    s.proc = proc;
    s.permissionView = undefined;
    s.stderrLines = 0;
    const args = codex ? ['app-server', ...(this.opts.codexExtraArgs ?? [])] : this.buildArgs(s, mode);
    const command = codex ? this.opts.codexCommand ?? 'codex' : this.opts.command;
    this.append(s, 'meta', { type: 'spawn', resume: mode !== 'new', fork: mode === 'fork' || undefined, command, args });
    proc.on('event', (ev: StreamEvent) => this.onEvent(s, ev));
    proc.on('accountUsage', (usage: any) => {
      this.accountData.set('codex', { response: usage, fetchedAt: this.now() });
      for (const live of this.sessions.values()) if (live.stored.provider === 'codex') this.emit('changed', live.stored.id);
    });
    proc.on('stderr', (text: string) => {
      if (s.stderrLines >= MAX_STDERR_LINES) return;
      s.stderrLines += text.split('\n').length;
      this.append(s, 'meta', { type: 'stderr', text });
    });
    proc.on('spawnError', (err: Error) => this.append(s, 'meta', { type: 'error', message: `could not start ${codex ? 'codex' : 'claude'}: ${err.message}` }));
    proc.on('exit', (code: number | null, signal: string | null) => {
      if (s.proc !== proc) return;
      if (s.model.state !== 'exited') this.append(s, 'meta', { type: 'exit', code, signal });
      s.proc = undefined;
      this.release(s);
    });
    const spec = { command, args, cwd: s.stored.cwd, env: this.opts.env ?? childEnv() };
    if (proc instanceof CodexProcess) proc.start({
      ...spec, model: s.stored.model, effort: s.stored.effort ?? 'medium',
      threadId: s.stored.conversationId,
      forkFrom: !s.stored.conversationId ? s.stored.forkConversationId : undefined,
      approvalPolicy: s.stored.codexPermissions?.approvalPolicy ?? this.defaultCodexPermissions().approvalPolicy,
      approvalsReviewer: s.stored.codexPermissions?.approvalsReviewer ?? this.defaultCodexPermissions().approvalsReviewer,
      sandbox: s.stored.codexPermissions?.sandbox ?? this.defaultCodexPermissions().sandbox,
      importHistory: Boolean(s.stored.conversationId && !s.records.some((r) => r.dir === 'in' && (r.ev.type === 'assistant' || r.ev.type === 'codex_text' || r.ev.codex_history))),
    });
    else proc.start(spec);
    void this.refreshUsage(s.stored.id);
    this.drain(s);
  }

  private defaultCodexPermissions(): CodexPermissions {
    return {
      approvalPolicy: (this.opts.codexApprovalPolicy as CodexPermissions['approvalPolicy']) ?? 'on-request',
      approvalsReviewer: this.opts.codexApprovalsReviewer ?? 'auto_review',
      sandbox: (this.opts.codexSandbox as CodexPermissions['sandbox']) ?? 'workspace-write',
    };
  }

  private onEvent(s: Live, ev: StreamEvent) {
    if (ev.type === 'system' && ev.subtype === 'permission_settings') {
      s.permissionView = codexPermissionView(ev.settings);
      this.emit('changed', s.stored.id);
    }
    if (s.stored.provider !== 'codex' && ev.type === 'system' && ev.subtype === 'init' && typeof ev.permissionMode === 'string') {
      s.stored.permissionMode = claudePermissionView(ev.permissionMode).value;
      s.permissionView = claudePermissionView(ev.permissionMode);
      this.saveMeta(s);
    }
    if (s.stored.provider === 'codex' && ev.type === 'system' && ev.subtype === 'init' && ev.conversation_id) {
      s.stored.conversationId = ev.conversation_id;
      if (ev.model) s.stored.model = ev.model;
      this.saveMeta(s);
    }
    this.append(s, 'in', ev);
    if (ev.type === 'result') void this.refreshUsage(s.stored.id, true);
    if (s.stored.provider !== 'codex' && ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.slash_commands)) {
      this.commandCache = { headless: ev.slash_commands, terminalOnly: ev.terminal_slash_commands ?? [] };
      try {
        fs.writeFileSync(this.commandsPath, JSON.stringify(this.commandCache));
      } catch {
        /* cache only */
      }
    }
    // Answer control requests we cannot handle, otherwise claude would wait forever.
    if (ev.type === 'control_request' && ev.request?.subtype !== 'can_use_tool') {
      this.write(s, controlError(ev.request_id, `unsupported control request: ${ev.request?.subtype}`), false);
    }
  }

  private write(s: Live, ev: StreamEvent, log = true): boolean {
    if (!s.proc?.send(ev)) return false;
    if (log) this.append(s, 'out', ev);
    return true;
  }

  // ---------- interaction ----------

  /**
   * Send a user message. It joins the session's queue and goes out as soon as Claude is free:
   * at once when idle, otherwise when the current turn ends — one message per turn, in order.
   * A stopped session is restarted with --resume.
   */
  send(id: string, text: string, images: ImageAttachment[] = []): boolean {
    const s = this.sessions.get(id);
    if (!s || (!text.trim() && !images.length)) return false;
    // Writing to an archived session brings it back.
    if (s.stored.archived) this.archive(id, false);
    if (this.forward(s, 'send', [text, images])) return true;
    s.queue.push({ id: randomUUID(), text, images, queuedAt: this.now() });
    if (!s.proc?.alive) this.resume(id); // drains once started
    else this.drain(s);
    if (s.queue.length) this.queueChanged(s);
    return true;
  }

  /** Take a message back out of the queue before it is sent. */
  unqueue(id: string, messageId: string): boolean {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'unqueue', [messageId])) return true;
    const i = s?.queue.findIndex((q) => q.id === messageId) ?? -1;
    if (!s || i < 0) return false;
    s.queue.splice(i, 1);
    this.queueChanged(s);
    return true;
  }

  /** Writes the next queued message if Claude is free: running, and between turns. */
  private drain(s: Live) {
    if (!s.queue.length || !s.proc?.alive || s.model.uiState() !== 'done' || s.effortPending || s.permissionPending) return;
    // Off the queue before the write, so listeners of that write already see it gone.
    const next = s.queue.shift()!;
    if (!this.write(s, userMessage(next.text, next.images))) s.queue.unshift(next);
    this.publish(s);
  }

  respond(id: string, requestId: string, decision: PermissionDecision): boolean {
    const s = this.sessions.get(id);
    if (!s || this.ownerOf(s)) return false;
    return this.write(s, controlResponse(requestId, decision));
  }

  allow(id: string, requestId: string, always = false): boolean {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'allow', [requestId, always])) return true;
    const p = this.view(id)?.pending.find((r) => r.requestId === requestId);
    if (!p) return false;
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: p.input };
    if (always && p.suggestions?.length) decision.updatedPermissions = p.suggestions;
    return this.respond(id, requestId, decision);
  }

  deny(id: string, requestId: string, message = 'The user denied this permission.'): boolean {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'deny', [requestId, message])) return true;
    const sent = this.respond(id, requestId, { behavior: 'deny', message });
    // Codex approval decisions cannot carry feedback. Queue the user's instruction for the next turn.
    if (sent && this.stored(id)?.provider === 'codex' && message.trim() && message !== 'The user denied this permission.') this.send(id, message);
    return sent;
  }

  /** Answer an AskUserQuestion request: question text → chosen label(s), comma separated. */
  answer(id: string, requestId: string, answers: Record<string, string>): boolean {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'answer', [requestId, answers])) return true;
    const p = this.view(id)?.pending.find((r) => r.requestId === requestId);
    if (!p) return false;
    return this.respond(id, requestId, { behavior: 'allow', updatedInput: { ...p.input, answers } });
  }

  interrupt(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (this.forward(s, 'interrupt', [])) return true;
    return this.write(s, interruptRequest(randomUUID()));
  }

  stop(id: string) {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'stop', [])) return;
    s?.proc?.kill();
  }

  /** Wait for shutdown before handing the native conversation to another process. */
  async stopAndWait(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s && this.forward(s, 'stop', [])) {
      for (let i = 0; i < 100 && this.ownerOf(s); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        this.sync();
      }
      if (this.ownerOf(s)) throw new Error('The VS Code window running this session did not stop it.');
      return;
    }
    const proc = s?.proc;
    if (!proc?.alive) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill();
    return exited;
  }

  /** Archiving puts a session away: its process stops, its history stays. */
  archive(id: string, archived = true) {
    const s = this.sessions.get(id);
    if (!s || Boolean(s.stored.archived) === archived) return;
    s.stored.archived = archived || undefined;
    if (archived) s.proc?.kill();
    this.saveMeta(s);
    this.emit('listChanged');
  }

  rename(id: string, name: string) {
    const s = this.sessions.get(id);
    if (!s || !name.trim()) return;
    s.stored.name = name.trim();
    s.model.rename(s.stored.name);
    this.saveMeta(s);
    this.emit('changed', id);
  }

  remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.removed = true;
    s.proc?.kill();
    this.sessions.delete(id);
    // The log goes first: metadata without a log is harmless, a log without metadata is recovered.
    for (const file of [this.logPath(id), this.metaPath(id)]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
    }
    this.emit('listChanged');
  }

  /** Kill every child (VS Code is shutting down). Resolves once they have all exited. */
  dispose(): Promise<void> {
    this.disposed = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.syncTimer);
    try { fs.rmSync(this.inboxDir, { recursive: true, force: true }); } catch { /* best effort */ }
    const waits: Promise<void>[] = [];
    for (const proc of this.accountProbes) proc.kill();
    this.accountProbes.clear();
    for (const s of this.sessions.values()) {
      const p = s.proc;
      if (!p?.alive) continue;
      waits.push(new Promise((resolve) => p.once('exit', () => resolve())));
      p.kill();
    }
    return Promise.all(waits).then(() => undefined);
  }
}
