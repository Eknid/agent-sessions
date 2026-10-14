import { AGENT_TOOL_NAMES, contentBlocks, LogRecord, QUESTION_TOOL_NAME, StreamEvent, Usage } from './events';
import { canonicalModel, PriceTable } from './pricing';
import type { AgentProvider } from './models';
import type { CodexSkill } from './codexCommands';
import type { AccountUsage } from './accountUsage';
import type { PermissionView } from './permissions';

/*
 * Pure reducer from the event log to session state and metrics. No I/O, no VS Code:
 * the same records always produce the same snapshot, which is what makes replay after a
 * reload (and the fixture tests) work.
 */

export type SessionState = 'starting' | 'idle' | 'running' | 'waiting' | 'exited';
/** The three states the user asked for. `idle` and `exited` are both "done with the turn". */
export type UiState = 'running' | 'waiting' | 'done';
export type AgentState = 'running' | 'completed' | 'failed' | 'killed';

export const MAIN = 'main';

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PendingRequest {
  requestId: string;
  kind: 'permission' | 'question';
  toolName: string;
  toolUseId?: string;
  input: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  description?: string;
  suggestions?: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  ownerId: string;
  at: number;
}

export interface OwnerView {
  id: string;
  parentId?: string;
  label: string;
  agentType?: string;
  background: boolean;
  state: AgentState | UiState;
  model?: string;
  modelsSeen: string[];
  tokens: TokenTotals & { total: number };
  costUsd: number;
  contextTokens: number;
  contextWindow: number;
  contextPct: number;
  messages: number;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  depth: number;
}

export interface SessionView {
  permissions?: PermissionView;
  effort?: string;
  accountUsage?: AccountUsage;
  provider?: AgentProvider;
  costAvailable?: boolean;
  id: string;
  name: string;
  /** Put away by the user: listed only under "Archived". Set by the manager. */
  archived?: boolean;
  cwd: string;
  state: SessionState;
  uiState: UiState;
  waitReason?: 'permission' | 'question';
  createdAt: number;
  endedAt?: number;
  model?: string;
  costUsd: number;
  costFinalUsd?: number;
  costIsEstimate: boolean;
  tokens: TokenTotals & { total: number };
  contextPct: number;
  owners: OwnerView[];
  pending: PendingRequest[];
  runningAgents: number;
  turns: number;
  /** Time of the last record: when the session last did anything. */
  updatedAt: number;
  lastError?: string;
  exitInfo?: string;
  claudeVersion?: string;
}

interface Owner {
  id: string;
  parentId?: string;
  label: string;
  agentType?: string;
  requestedModel?: string;
  background: boolean;
  state: AgentState;
  taskId?: string;
  modelsSeen: Set<string>;
  lastModel?: string;
  tokens: TokenTotals;
  costUsd: number;
  lastPromptTokens: number;
  messages: number;
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  depth: number;
}

interface LedgerRow {
  owner: string;
  model?: string;
  tokens: TokenTotals;
  cost: number;
}

/**
 * A subagent's state as views show it. Once its session has ended nothing is alive, so a
 * completed subagent shows as stopped too (its real outcome stays in `state` for tooltips);
 * a failure still shows as failed.
 */
export function shownAgentState(v: Pick<SessionView, 'state'>, o: Pick<OwnerView, 'state'>): OwnerView['state'] {
  return v.state === 'exited' && o.state !== 'failed' ? 'killed' : o.state;
}

/** The group a session is listed under, in the sidebar and on the board. Ended → done. */
export function groupOf(v: Pick<SessionView, 'state' | 'uiState'>): UiState {
  if (v.state === 'exited') return 'done';
  return v.uiState;
}

/** Order inside a group: most recent first, except whoever has waited longest for you. */
export function groupOrder(group: UiState): (a: Pick<SessionView, 'updatedAt'>, b: Pick<SessionView, 'updatedAt'>) => number {
  return group === 'waiting' ? (a, b) => a.updatedAt - b.updatedAt : (a, b) => b.updatedAt - a.updatedAt;
}

export interface SessionMeta {
  provider?: AgentProvider;
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  /** The --model the session was launched with (alias or id); shown until claude reports one. */
  requestedModel?: string;
}

/** Older logs recorded Italian reasons; show them in English. */
const LEGACY_REASONS: Record<string, string> = { 'VS Code riavviato': 'VS Code restarted' };

function exitReason(ev: StreamEvent): string {
  if (ev.reason) return LEGACY_REASONS[ev.reason] ?? ev.reason;
  return ev.signal ? `signal ${ev.signal}` : `exit code ${ev.code ?? '?'}`;
}

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const total = (t: TokenTotals) => t.input + t.output + t.cacheWrite;

function tokensOf(u: Usage | undefined): TokenTotals {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
  };
}

function addInto(dst: TokenTotals, src: TokenTotals, sign = 1) {
  dst.input += sign * src.input;
  dst.output += sign * src.output;
  dst.cacheWrite += sign * src.cacheWrite;
  dst.cacheRead += sign * src.cacheRead;
}

export class SessionModel {
  readonly meta: SessionMeta;
  state: SessionState = 'starting';
  private waitReason?: 'permission' | 'question';
  private endedAt?: number;
  private exitInfo?: string;
  private lastError?: string;
  private claudeVersion?: string;
  private initModel?: string;
  private turns = 0;
  private updatedAt = 0;
  /** Slash commands this headless process accepts, and the ones only the interactive TUI has. */
  codexSkills: CodexSkill[] = [];
  slashCommands: string[] = [];
  terminalOnlyCommands: string[] = [];

  private owners = new Map<string, Owner>();
  private taskToOwner = new Map<string, string>();
  /** tool_use id of an Agent call → owner that issued it (for nesting). */
  private agentCallParent = new Map<string, string>();
  private pending: PendingRequest[] = [];
  /** Background tasks that are not subagents (e.g. `run_in_background` Bash). */
  private otherBackgroundTasks = new Set<string>();

  private ledger = new Map<string, LedgerRow>();
  /** Native Codex counters are cumulative. Keep their baseline separate from session/fork totals. */
  private codexTotals = new Map<string, TokenTotals>();
  private estTotal = 0;
  private estAtLastResult = 0;
  private costFinal?: number;
  private runBase = 0;
  private runCumulative?: boolean;
  /** Cost of the parent conversation at fork time: claude's cumulative total includes it. */
  private costOffset = 0;
  private contextWindows = new Map<string, number>();

  constructor(meta: SessionMeta, private prices: PriceTable) {
    this.meta = { ...meta };
    this.owners.set(MAIN, this.newOwner(MAIN, 'Main conversation', 0));
  }

  setPrices(prices: PriceTable) {
    this.prices = prices;
  }

  rename(name: string) {
    this.meta.name = name;
  }

  /** Apply one record. Returns true if anything visible changed. */
  apply(rec: LogRecord): boolean {
    const ev = rec.ev;
    if (rec.t > this.updatedAt) this.updatedAt = rec.t;
    if (rec.dir === 'meta') return this.applyMeta(ev, rec.t);
    if (rec.dir === 'out') return this.applyOut(ev, rec.t);
    return this.applyIn(ev, rec.t);
  }

  // ---- outbound (what we wrote to stdin) ----
  private applyOut(ev: StreamEvent, t: number): boolean {
    if (ev.type === 'user') {
      this.setState('running');
      return true;
    }
    if (ev.type === 'control_response') {
      const id = ev.response?.request_id;
      this.pending = this.pending.filter((p) => p.requestId !== id);
      if (this.state === 'waiting' && this.pending.length === 0) this.setState('running');
      else if (this.pending.length) this.waitReason = this.pending[0].kind;
      return true;
    }
    void t;
    return false;
  }

  // ---- lifecycle ----
  private applyMeta(ev: StreamEvent, t: number): boolean {
    switch (ev.type) {
      case 'spawn':
        this.state = 'starting';
        this.endedAt = undefined;
        this.exitInfo = undefined;
        this.runBase = this.costFinal ?? 0;
        this.runCumulative = undefined;
        return true;
      case 'exit':
        this.state = 'exited';
        this.endedAt = t;
        this.pending = [];
        this.waitReason = undefined;
        this.exitInfo = exitReason(ev);
        for (const o of this.owners.values()) {
          if (o.id !== MAIN && o.state === 'running') {
            o.state = 'killed';
            o.endedAt = t;
          }
        }
        this.otherBackgroundTasks.clear();
        return true;
      case 'error':
        this.lastError = String(ev.message ?? 'error');
        return true;
      case 'fork':
        this.startFork();
        return true;
      default:
        return false;
    }
  }

  // ---- inbound (claude stdout) ----
  private applyIn(ev: StreamEvent, t: number): boolean {
    switch (ev.type) {
      case 'system':
        return this.applySystem(ev, t);
      case 'assistant':
        return this.applyAssistant(ev, t);
      case 'user':
        return this.applyUser(ev, t);
      case 'control_request':
        return this.applyControlRequest(ev, t);
      case 'control_cancel_request': {
        const before = this.pending.length;
        this.pending = this.pending.filter((p) => p.requestId !== ev.request_id);
        if (this.pending.length === 0 && this.state === 'waiting') this.setState('running');
        return before !== this.pending.length;
      }
      case 'result':
        return this.applyResult(ev, t);
      default:
        return false;
    }
  }

  private applySystem(ev: StreamEvent, t: number): boolean {
    switch (ev.subtype) {
      case 'codex_skills':
        if (Array.isArray(ev.skills)) this.codexSkills = ev.skills;
        return true;
      case 'codex_turn_started':
        this.setState('running');
        return true;
      case 'codex_usage': {
        const owner = ev.owner ? this.agentOwner(ev.owner, t) : this.owners.get(MAIN)!;
        const usage = ev.usage?.total;
        if (!usage) return false;
        const snapshot: TokenTotals = {
          // Cached reads and writes are subsets of Codex's inclusive input count.
          input: Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0) - (usage.cacheWriteInputTokens ?? 0)),
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cachedInputTokens ?? 0,
          cacheWrite: usage.cacheWriteInputTokens ?? 0,
        };
        let previous = this.codexTotals.get(owner.id) ?? zero();
        const inclusiveInput = (tokens: TokenTotals) => tokens.input + tokens.cacheRead + tokens.cacheWrite;
        // A CLI that restarts native counters on resume still contributes new usage.
        if (inclusiveInput(snapshot) < inclusiveInput(previous) || snapshot.output < previous.output) previous = zero();
        const delta = { ...snapshot };
        addInto(delta, previous, -1);
        this.codexTotals.set(owner.id, snapshot);
        addInto(owner.tokens, delta);
        owner.lastPromptTokens = ev.usage.last?.inputTokens ?? 0;
        if (ev.model) { owner.lastModel = ev.model; owner.modelsSeen.add(ev.model); }
        const cost = this.prices.cost(owner.lastModel, { input_tokens: delta.input, output_tokens: delta.output, cache_read_input_tokens: delta.cacheRead, cache_creation_input_tokens: delta.cacheWrite }, ev.usage.last?.inputTokens ?? inclusiveInput(delta));
        owner.costUsd += cost;
        this.estTotal += cost;
        if (ev.usage.modelContextWindow && owner.lastModel) this.contextWindows.set(canonicalModel(owner.lastModel), ev.usage.modelContextWindow);
        return true;
      }
      case 'init':
        this.claudeVersion = ev.claude_code_version ?? this.claudeVersion;
        this.initModel = ev.model ?? this.initModel;
        if (this.meta.provider === 'codex' && ev.model) {
          const main = this.owners.get(MAIN)!;
          main.lastModel = ev.model;
          main.modelsSeen.add(ev.model);
        }
        if (Array.isArray(ev.slash_commands)) this.slashCommands = ev.slash_commands;
        if (Array.isArray(ev.terminal_slash_commands)) this.terminalOnlyCommands = ev.terminal_slash_commands;
        if (this.state === 'starting') this.setState('idle');
        return true;
      case 'task_started': {
        const isAgent = ev.task_type === 'local_agent' || ev.subagent_type !== undefined;
        if (!isAgent) {
          if (ev.is_backgrounded && ev.task_id) this.otherBackgroundTasks.add(ev.task_id);
          return false;
        }
        const owner = this.agentOwner(ev.tool_use_id, t);
        owner.taskId = ev.task_id;
        owner.agentType = ev.subagent_type ?? owner.agentType;
        owner.label = ev.description ?? owner.label;
        owner.background = Boolean(ev.is_backgrounded) || owner.background;
        if (typeof ev.spawn_depth === 'number') owner.depth = ev.spawn_depth;
        owner.state = 'running';
        owner.startedAt = owner.startedAt ?? t;
        if (ev.task_id) this.taskToOwner.set(ev.task_id, owner.id);
        return true;
      }
      case 'task_updated': {
        const status = ev.patch?.status;
        if (this.otherBackgroundTasks.has(ev.task_id) && status && status !== 'running') {
          this.otherBackgroundTasks.delete(ev.task_id);
          return true;
        }
        const owner = this.ownerByTask(ev.task_id);
        if (!owner || !status) return false;
        this.setAgentStatus(owner, status, ev.patch?.end_time ?? t);
        return true;
      }
      case 'task_notification': {
        if (this.otherBackgroundTasks.has(ev.task_id)) {
          this.otherBackgroundTasks.delete(ev.task_id);
          return true;
        }
        const owner = this.ownerByTask(ev.task_id) ?? (ev.tool_use_id ? this.owners.get(ev.tool_use_id) : undefined);
        if (!owner) return false;
        if (ev.status) this.setAgentStatus(owner, ev.status, t);
        if (ev.summary) owner.summary = String(ev.summary);
        return true;
      }
      default:
        return false;
    }
  }

  private applyAssistant(ev: StreamEvent, t: number): boolean {
    const ownerId: string = ev.parent_tool_use_id ?? MAIN;
    const owner = ownerId === MAIN ? this.owners.get(MAIN)! : this.agentOwner(ownerId, t);
    const msg = ev.message ?? {};
    const model: string | undefined = msg.model;

    // A new turn can start on its own (e.g. a background agent finished).
    if (ownerId === MAIN && (this.state === 'idle' || this.state === 'starting')) this.setState('running');

    for (const b of contentBlocks(ev)) {
      if (b.type === 'tool_use' && b.id && AGENT_TOOL_NAMES.has(b.name ?? '')) {
        this.agentCallParent.set(b.id, ownerId);
        const sub = this.agentOwner(b.id, t);
        sub.parentId = ownerId;
        sub.label = b.input?.description ?? sub.label;
        sub.agentType = b.input?.subagent_type ?? sub.agentType;
        sub.requestedModel = b.input?.model ?? sub.requestedModel;
        sub.background = Boolean(b.input?.run_in_background) || sub.background;
        sub.depth = (owner.depth ?? 0) + 1;
      }
    }

    if (model && model !== '<synthetic>') {
      owner.modelsSeen.add(canonicalModel(model));
      owner.lastModel = model;
    }
    const id: string | undefined = msg.id;
    if (!id || !msg.usage) return true;

    // Each content block of one API message is emitted as its own event with the same id and
    // usage: book the message once, and if a later copy reports more, book the difference.
    const tokens = tokensOf(msg.usage);
    const cost = this.prices.cost(model, msg.usage);
    const prev = this.ledger.get(id);
    if (prev) {
      if (prev.owner !== ownerId) return true;
      addInto(owner.tokens, prev.tokens, -1);
      owner.costUsd -= prev.cost;
      this.estTotal -= prev.cost;
    } else {
      owner.messages++;
    }
    this.ledger.set(id, { owner: ownerId, model, tokens, cost });
    addInto(owner.tokens, tokens);
    owner.costUsd += cost;
    this.estTotal += cost;
    owner.lastPromptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    return true;
  }

  private applyUser(ev: StreamEvent, t: number): boolean {
    let changed = false;
    const result = ev.tool_use_result;
    for (const b of contentBlocks(ev)) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      // A tool result settles any permission request for that call, however it was resolved
      // (answered by us, aborted, or decided by a hook).
      if (this.pending.some((p) => p.toolUseId === b.tool_use_id)) {
        this.pending = this.pending.filter((p) => p.toolUseId !== b.tool_use_id);
        if (this.pending.length === 0 && this.state === 'waiting') this.setState('running');
        else if (this.pending.length) this.waitReason = this.pending[0].kind;
        changed = true;
      }
      const sub = this.owners.get(b.tool_use_id);
      if (!sub || sub.id === MAIN) continue;
      changed = true;
      if (result && typeof result === 'object') {
        if (result.status === 'async_launched') {
          sub.background = true;
          continue;
        }
        if (result.resolvedModel) {
          sub.modelsSeen.add(canonicalModel(result.resolvedModel));
          sub.lastModel = sub.lastModel ?? result.resolvedModel;
        }
        // Without --forward-subagent-text the subagent's messages never reach us; its final
        // usage is then the only number we get, so book it once.
        if (sub.messages === 0 && result.usage) {
          const tokens = tokensOf(result.usage);
          const cost = this.prices.cost(result.resolvedModel ?? sub.requestedModel, result.usage);
          this.ledger.set(`final:${sub.id}`, { owner: sub.id, model: result.resolvedModel, tokens, cost });
          addInto(sub.tokens, tokens);
          sub.costUsd += cost;
          this.estTotal += cost;
          sub.messages = 1;
          sub.lastPromptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
        }
      }
      if (sub.state === 'running') this.setAgentStatus(sub, b.is_error ? 'failed' : 'completed', t);
    }
    return changed;
  }

  private applyControlRequest(ev: StreamEvent, t: number): boolean {
    const r = ev.request ?? {};
    if (r.subtype !== 'can_use_tool') return false;
    const kind = r.tool_name === QUESTION_TOOL_NAME ? 'question' : 'permission';
    let ownerId = MAIN;
    for (const o of this.owners.values()) {
      if (o.id !== MAIN && o.state === 'running' && r.agent_id && o.taskId === r.agent_id) ownerId = o.id;
    }
    this.pending.push({
      requestId: ev.request_id,
      kind,
      toolName: r.tool_name,
      toolUseId: r.tool_use_id,
      input: r.input,
      description: r.description,
      suggestions: r.permission_suggestions,
      ownerId,
      at: t,
    });
    this.waitReason = this.pending[0].kind;
    this.setState('waiting');
    return true;
  }

  private applyResult(ev: StreamEvent, _t: number): boolean {
    this.turns++;
    if (typeof ev.total_cost_usd === 'number') {
      // total_cost_usd is cumulative for the process (and, since 2.1.277, across --resume).
      // Older CLIs restart from zero on resume: detect that on the first result of a run.
      if (this.runCumulative === undefined) this.runCumulative = ev.total_cost_usd + 1e-9 >= this.runBase;
      this.costFinal = this.runCumulative ? ev.total_cost_usd : this.runBase + ev.total_cost_usd;
      this.estAtLastResult = this.estTotal;
    }
    if (ev.modelUsage && typeof ev.modelUsage === 'object') {
      for (const [m, u] of Object.entries<any>(ev.modelUsage)) { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (typeof u?.contextWindow === 'number') this.contextWindows.set(canonicalModel(m), u.contextWindow);
      }
    }
    if (ev.is_error && ev.subtype !== 'error_during_execution') {
      this.lastError = Array.isArray(ev.errors) ? ev.errors.join('; ') : String(ev.result ?? ev.subtype);
    } else if (!ev.is_error) {
      this.lastError = undefined;
    }
    // A finished turn cannot still be waiting on a permission: whatever was open is moot.
    this.pending = [];
    if ((ev.queued_turn_count ?? 0) > 0 || (this.meta.provider !== 'codex' && this.runningBackgroundAgents() > 0)) this.setState('running');
    else this.setState('idle');
    return true;
  }

  /**
   * Everything before a fork record is the parent's history: it stays in the transcript, but
   * the fork's cost, tokens and subagents start from zero. Context carries over.
   */
  private startFork() {
    const offset = this.currentCost();
    this.costOffset = offset;
    // Seeding costFinal lets the next run tell whether claude's total includes the parent.
    this.costFinal = offset;
    this.estTotal = 0;
    this.estAtLastResult = 0;
    this.ledger.clear();
    this.turns = 0;
    this.pending = [];
    this.waitReason = undefined;
    this.taskToOwner.clear();
    this.agentCallParent.clear();
    this.otherBackgroundTasks.clear();
    const main = this.owners.get(MAIN)!;
    // Forked native threads inherit the parent's cumulative usage; only later increments belong here.
    const baseline = this.codexTotals.get(MAIN);
    this.codexTotals = new Map(baseline ? [[MAIN, baseline]] : []);
    this.owners = new Map([[MAIN, { ...main, tokens: zero(), costUsd: 0, messages: 0, modelsSeen: new Set(main.modelsSeen) }]]);
  }

  private currentCost(): number {
    const sinceResult = this.estTotal - this.estAtLastResult;
    return this.costFinal !== undefined ? this.costFinal + sinceResult : this.estTotal;
  }

  // ---- helpers ----
  private setState(s: SessionState) {
    if (this.state === 'exited' && s !== 'starting') return;
    this.state = s;
    if (s !== 'waiting') this.waitReason = undefined;
  }

  private setAgentStatus(owner: Owner, status: string, t: number) {
    const map: Record<string, AgentState> = {
      running: 'running',
      pending: 'running',
      completed: 'completed',
      success: 'completed',
      failed: 'failed',
      error: 'failed',
      killed: 'killed',
      stopped: 'killed',
      cancelled: 'killed',
    };
    const next = map[status] ?? owner.state;
    if (next !== 'running' && owner.state === 'running') owner.endedAt = t;
    owner.state = next;
  }

  private newOwner(id: string, label: string, depth: number): Owner {
    return {
      id,
      label,
      background: false,
      state: 'running',
      modelsSeen: new Set(),
      tokens: zero(),
      costUsd: 0,
      lastPromptTokens: 0,
      messages: 0,
      depth,
    };
  }

  private agentOwner(toolUseId: string, t: number): Owner {
    let o = this.owners.get(toolUseId);
    if (!o) {
      o = this.newOwner(toolUseId, 'Subagent', 1);
      o.startedAt = t;
      o.parentId = this.agentCallParent.get(toolUseId) ?? MAIN;
      this.owners.set(toolUseId, o);
    }
    return o;
  }

  private ownerByTask(taskId: string | undefined): Owner | undefined {
    const id = taskId ? this.taskToOwner.get(taskId) : undefined;
    return id ? this.owners.get(id) : undefined;
  }

  private runningBackgroundAgents(): number {
    let n = 0;
    for (const o of this.owners.values()) if (o.id !== MAIN && o.background && o.state === 'running') n++;
    return n;
  }

  private windowFor(model: string | undefined): number {
    return this.contextWindows.get(canonicalModel(model)) ?? this.prices.contextWindow(model);
  }

  uiState(): UiState {
    if (this.state === 'waiting') return 'waiting';
    // `starting` is not "running": a headless claude emits nothing until it gets its first
    // message, so a freshly spawned session is idle until we send one.
    if (this.state === 'running') return 'running';
    return 'done';
  }

  view(): SessionView {
    const ui = this.uiState();
    const owners: OwnerView[] = [];
    const sum = zero();
    let runningAgents = 0;
    for (const o of this.owners.values()) {
      addInto(sum, o.tokens);
      if (o.id !== MAIN && o.state === 'running') runningAgents++;
      const model = o.lastModel ?? (o.id === MAIN ? this.initModel ?? this.meta.requestedModel : o.requestedModel);
      const window = this.windowFor(model);
      owners.push({
        id: o.id,
        parentId: o.id === MAIN ? undefined : o.parentId ?? MAIN,
        label: o.label,
        agentType: o.agentType,
        background: o.background,
        state: o.id === MAIN ? ui : o.state,
        model,
        modelsSeen: [...o.modelsSeen],
        tokens: { ...o.tokens, total: total(o.tokens) },
        costUsd: o.costUsd,
        contextTokens: o.lastPromptTokens,
        contextWindow: window,
        contextPct: window ? Math.min(100, (o.lastPromptTokens / window) * 100) : 0,
        messages: o.messages,
        startedAt: o.id === MAIN ? this.meta.createdAt : o.startedAt,
        endedAt: o.id === MAIN ? this.endedAt : o.endedAt,
        summary: o.summary,
        depth: o.depth,
      });
    }
    const main = owners[0];
    const sinceResult = this.estTotal - this.estAtLastResult;
    const costUsd = Math.max(0, this.currentCost() - this.costOffset);
    return {
      id: this.meta.id,
      provider: this.meta.provider ?? 'claude',
      costAvailable: this.meta.provider !== 'codex' || this.prices.hasRates(main.model),
      name: this.meta.name,
      cwd: this.meta.cwd,
      state: this.state,
      uiState: ui,
      waitReason: this.waitReason,
      createdAt: this.meta.createdAt,
      endedAt: this.endedAt,
      model: main.model ?? this.meta.requestedModel,
      costUsd,
      costFinalUsd: this.costFinal === undefined ? undefined : Math.max(0, this.costFinal - this.costOffset),
      costIsEstimate: this.costFinal === undefined || sinceResult > 1e-9,
      tokens: { ...sum, total: total(sum) },
      contextPct: main.contextPct,
      owners,
      pending: [...this.pending],
      runningAgents,
      turns: this.turns,
      updatedAt: this.updatedAt,
      lastError: this.lastError,
      exitInfo: this.exitInfo,
      claudeVersion: this.claudeVersion,
    };
  }
}
