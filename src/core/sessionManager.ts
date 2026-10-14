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
}

export interface ManagerEvents {
  record: (id: string, rec: LogRecord) => void;
  changed: (id: string) => void;
  listChanged: () => void;
  transition: (id: string, from: UiState, to: UiState, view: SessionView) => void;
}

const MAX_STDERR_LINES = 200;

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Live>();
  private accountData = new Map<AgentProvider, { response?: any; error?: string; fetchedAt: number }>();
  private accountPending = new Map<AgentProvider, Promise<void>>();
  private accountProbes = new Set<ClaudeProcess | CodexRpc>();
  private prices: PriceTable;
  /** Last command list any claude reported: headless claude only sends init after the first message. */
  private commandCache: SlashCommands = { headless: [], terminalOnly: [] };
  private now: () => number;

  constructor(private opts: ManagerOptions) {
    super();
    this.prices = opts.prices ?? new PriceTable();
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.logDir, { recursive: true });
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

  setCodex(command: string, extraArgs: string[] = [], approvalPolicy = 'on-request', sandbox = 'workspace-write') {
    this.opts.codexCommand = command;
    this.opts.codexExtraArgs = extraArgs;
    this.opts.codexApprovalPolicy = approvalPolicy;
    this.opts.codexSandbox = sandbox;
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

  private get indexPath() {
    return path.join(this.opts.storageDir, 'sessions.json');
  }

  private logPath(id: string) {
    return path.join(this.logDir, `${id}.ndjson`);
  }

  // ---------- persistence ----------

  /** Rebuild every known session from its event log. Processes from a previous host are gone. */
  load() {
    try {
      this.commandCache = JSON.parse(fs.readFileSync(this.commandsPath, 'utf8'));
    } catch {
      /* first run */
    }
    let stored: StoredSession[] = [];
    try {
      stored = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      stored = [];
    }
    for (const s of stored) {
      const records = this.readLog(s.id);
      const model = this.replay(s, records);
      const live: Live = { stored: s, model, records, stderrLines: 0, lastUi: model.uiState(), queue: [] };
      this.sessions.set(s.id, live);
      if (model.state !== 'exited') this.append(live, 'meta', { type: 'exit', reason: 'VS Code restarted' });
      live.lastUi = live.model.uiState();
    }
    this.emit('listChanged');
  }

  private readLog(id: string): LogRecord[] {
    let text = '';
    try {
      text = fs.readFileSync(this.logPath(id), 'utf8');
    } catch {
      return [];
    }
    const out: LogRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a torn last line after a crash */
      }
    }
    return out;
  }

  private replay(s: SessionMeta, records: LogRecord[]): SessionModel {
    const m = new SessionModel({ id: s.id, name: s.name, cwd: s.cwd, createdAt: s.createdAt, provider: s.provider ?? 'claude', requestedModel: (s as StoredSession).model }, this.prices);
    for (const r of records) m.apply(r);
    return m;
  }

  private saveIndex() {
    const list = [...this.sessions.values()].map((s) => s.stored);
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.indexPath);
  }

  private append(s: Live, dir: LogRecord['dir'], ev: StreamEvent) {
    if (s.removed) return;
    const rec: LogRecord = { t: this.now(), dir, ev };
    s.records.push(rec);
    try {
      fs.appendFileSync(this.logPath(s.stored.id), JSON.stringify(rec) + '\n');
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
      ? codexPermissionView(s.stored.codexPermissions ?? { approvalPolicy: this.opts.codexApprovalPolicy ?? 'on-request', sandbox: this.opts.codexSandbox ?? 'workspace-write' })
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
    return this.sessions.get(id)?.queue ?? [];
  }

  records(id: string): readonly LogRecord[] {
    return this.sessions.get(id)?.records ?? [];
  }

  isAlive(id: string): boolean {
    return Boolean(this.sessions.get(id)?.proc?.alive);
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
      codexPermissions: o.provider === 'codex' ? o.codexPermissions && { ...o.codexPermissions } : undefined,
    };
    const live: Live = {
      stored,
      model: this.replay(stored, []),
      records: [],
      stderrLines: 0,
      lastUi: 'done',
      queue: [],
    };
    this.sessions.set(id, live);
    fs.writeFileSync(this.logPath(id), '');
    this.saveIndex();
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
    fs.writeFileSync(this.logPath(id), records.map((r) => JSON.stringify(r) + '\n').join(''));
    const live: Live = { stored, model: this.replay(stored, records), records, stderrLines: 0, lastUi: 'done', queue: [] };
    this.sessions.set(id, live);
    this.append(live, 'meta', { type: 'fork', from: parentId, fromName: p.name });
    live.lastUi = live.model.uiState();
    this.saveIndex();
    this.emit('listChanged');
    this.spawn(live, 'fork');
    return id;
  }

  resume(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.proc?.alive) return;
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
    this.saveIndex();
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
      this.saveIndex();
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
    await s.effortPending;
    const proc = s.proc;
    const pending = (async () => {
      if (proc instanceof ClaudeProcess && proc.alive) {
        await proc.requestControl({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
      } else if (proc instanceof CodexProcess && proc.alive) await proc.setEffort(effort);
      if (s.removed) return;
      s.stored.effort = effort;
      this.saveIndex();
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
      if (s.proc === proc) s.proc = undefined;
      if (s.model.state !== 'exited') this.append(s, 'meta', { type: 'exit', code, signal });
    });
    const spec = { command, args, cwd: s.stored.cwd, env: this.opts.env ?? childEnv() };
    if (proc instanceof CodexProcess) proc.start({
      ...spec, model: s.stored.model, effort: s.stored.effort ?? 'medium',
      threadId: s.stored.conversationId,
      forkFrom: !s.stored.conversationId ? s.stored.forkConversationId : undefined,
      approvalPolicy: s.stored.codexPermissions?.approvalPolicy ?? this.opts.codexApprovalPolicy ?? 'on-request',
      approvalsReviewer: s.stored.codexPermissions?.approvalsReviewer,
      sandbox: s.stored.codexPermissions?.sandbox ?? this.opts.codexSandbox ?? 'workspace-write',
      importHistory: Boolean(s.stored.conversationId && !s.records.some((r) => r.dir === 'in' && (r.ev.type === 'assistant' || r.ev.type === 'codex_text' || r.ev.codex_history))),
    });
    else proc.start(spec);
    void this.refreshUsage(s.stored.id);
    this.drain(s);
  }

  private onEvent(s: Live, ev: StreamEvent) {
    if (ev.type === 'system' && ev.subtype === 'permission_settings') {
      s.permissionView = codexPermissionView(ev.settings);
      this.emit('changed', s.stored.id);
    }
    if (s.stored.provider !== 'codex' && ev.type === 'system' && ev.subtype === 'init' && typeof ev.permissionMode === 'string') {
      s.stored.permissionMode = claudePermissionView(ev.permissionMode).value;
      s.permissionView = claudePermissionView(ev.permissionMode);
      this.saveIndex();
    }
    if (s.stored.provider === 'codex' && ev.type === 'system' && ev.subtype === 'init' && ev.conversation_id) {
      s.stored.conversationId = ev.conversation_id;
      if (ev.model) s.stored.model = ev.model;
      this.saveIndex();
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
    s.queue.push({ id: randomUUID(), text, images, queuedAt: this.now() });
    if (!s.proc?.alive) this.resume(id); // drains once started
    else this.drain(s);
    if (s.queue.length) this.emit('changed', id);
    return true;
  }

  /** Take a message back out of the queue before it is sent. */
  unqueue(id: string, messageId: string): boolean {
    const s = this.sessions.get(id);
    const i = s?.queue.findIndex((q) => q.id === messageId) ?? -1;
    if (!s || i < 0) return false;
    s.queue.splice(i, 1);
    this.emit('changed', id);
    return true;
  }

  /** Writes the next queued message if Claude is free: running, and between turns. */
  private drain(s: Live) {
    if (!s.queue.length || !s.proc?.alive || s.model.uiState() !== 'done' || s.effortPending || s.permissionPending) return;
    // Off the queue before the write, so listeners of that write already see it gone.
    const next = s.queue.shift()!;
    if (!this.write(s, userMessage(next.text, next.images))) s.queue.unshift(next);
  }

  respond(id: string, requestId: string, decision: PermissionDecision): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.write(s, controlResponse(requestId, decision));
  }

  allow(id: string, requestId: string, always = false): boolean {
    const p = this.view(id)?.pending.find((r) => r.requestId === requestId);
    if (!p) return false;
    const decision: PermissionDecision = { behavior: 'allow', updatedInput: p.input };
    if (always && p.suggestions?.length) decision.updatedPermissions = p.suggestions;
    return this.respond(id, requestId, decision);
  }

  deny(id: string, requestId: string, message = 'The user denied this permission.'): boolean {
    const sent = this.respond(id, requestId, { behavior: 'deny', message });
    // Codex approval decisions cannot carry feedback. Queue the user's instruction for the next turn.
    if (sent && this.stored(id)?.provider === 'codex' && message.trim() && message !== 'The user denied this permission.') this.send(id, message);
    return sent;
  }

  /** Answer an AskUserQuestion request: question text → chosen label(s), comma separated. */
  answer(id: string, requestId: string, answers: Record<string, string>): boolean {
    const p = this.view(id)?.pending.find((r) => r.requestId === requestId);
    if (!p) return false;
    return this.respond(id, requestId, { behavior: 'allow', updatedInput: { ...p.input, answers } });
  }

  interrupt(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    return this.write(s, interruptRequest(randomUUID()));
  }

  stop(id: string) {
    this.sessions.get(id)?.proc?.kill();
  }

  /** Wait for shutdown before handing the native conversation to another process. */
  stopAndWait(id: string): Promise<void> {
    const proc = this.sessions.get(id)?.proc;
    if (!proc?.alive) return Promise.resolve();
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
    this.saveIndex();
    this.emit('listChanged');
  }

  rename(id: string, name: string) {
    const s = this.sessions.get(id);
    if (!s || !name.trim()) return;
    s.stored.name = name.trim();
    s.model.rename(s.stored.name);
    this.saveIndex();
    this.emit('changed', id);
  }

  remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.removed = true;
    s.proc?.kill();
    this.sessions.delete(id);
    this.saveIndex();
    try {
      fs.unlinkSync(this.logPath(id));
    } catch {
      /* already gone */
    }
    this.emit('listChanged');
  }

  /** Kill every child (VS Code is shutting down). Resolves once they have all exited. */
  dispose(): Promise<void> {
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
