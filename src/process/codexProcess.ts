import { EventEmitter } from 'events';
import { StreamEvent } from '../core/events';
import { CodexRpc } from './codexRpc';
import { SpawnSpec } from './claudeProcess';
import { CodexSkill, CODEX_COMMANDS, CODEX_TERMINAL_COMMANDS } from '../core/codexCommands';
import { CodexPermissions, codexSandboxPolicy } from '../core/permissions';

export interface CodexSessionSpec extends SpawnSpec {
  model?: string;
  effort?: string;
  threadId?: string;
  forkFrom?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox?: string;
  importHistory?: boolean;
}

/** Adapt Codex app-server events to the session log used by the reducer and transcript. */
export class CodexProcess extends EventEmitter {
  private rpc = new CodexRpc();
  private ready?: Promise<void>;
  private threadId?: string;
  private turnId?: string;
  private model?: string;
  private effort = 'medium';
  private permissionOverrides?: CodexPermissions;
  private turnGeneration = 0;
  private interruptPending = false;
  private requests = new Map<string, any>();
  private tools = new Set<string>();
  private owners = new Map<string, string>();
  private ownerModels = new Map<string, string>();
  private texts = new Map<string, string>();
  private cwd = '';
  private availableSkills: CodexSkill[] = [];
  get skills(): readonly CodexSkill[] { return this.availableSkills; }

  constructor() {
    super();
    this.rpc.on('stderr', (text: string) => this.emit('stderr', text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')));
    this.rpc.on('spawnError', (error) => this.emit('spawnError', error));
    this.rpc.on('exit', (code, signal) => this.emit('exit', code, signal));
    this.rpc.on('notification', (message) => this.notification(message));
    this.rpc.on('request', (message) => this.serverRequest(message));
  }

  get alive() { return this.rpc.alive; }
  kill() { this.rpc.kill(); }
  private event(ev: StreamEvent) { this.emit('event', ev); }
  private assistant(content: any[], owner?: string) {
    this.event({ type: 'assistant', parent_tool_use_id: owner, message: { model: owner ? this.ownerModels.get(owner) : this.model, content } });
  }

  start(spec: CodexSessionSpec) {
    this.model = spec.model;
    this.effort = spec.effort ?? 'medium';
    this.cwd = spec.cwd;
    this.rpc.start(spec);
    this.ready = this.initialize(spec).catch((error: Error) => {
      if (this.alive) {
        this.emit('spawnError', error);
        this.kill();
      }
      throw error;
    });
    // The session may be opened without ever sending a message.
    void this.ready.catch(() => undefined);
  }

  private async initialize(spec: CodexSessionSpec) {
    await this.rpc.initialize();
    const overrides = { cwd: spec.cwd, model: spec.model, approvalPolicy: spec.approvalPolicy, approvalsReviewer: spec.approvalsReviewer, sandbox: spec.sandbox, config: { model_reasoning_effort: this.effort } };
    const result = spec.forkFrom
      ? await this.rpc.request('thread/fork', { ...overrides, threadId: spec.forkFrom })
      : spec.threadId
        ? await this.rpc.request('thread/resume', { ...overrides, threadId: spec.threadId })
        : await this.rpc.request('thread/start', overrides);
    this.threadId = result.thread.id;
    this.model = result.model || spec.model;
    this.event({ type: 'system', subtype: 'permission_settings', settings: {
      approvalPolicy: result.approvalPolicy ?? spec.approvalPolicy,
      approvalsReviewer: result.approvalsReviewer ?? spec.approvalsReviewer ?? 'user',
      sandbox: spec.sandbox, sandboxPolicy: result.sandbox,
    } });
    if (spec.importHistory) {
      for (const turn of result.thread.turns ?? []) {
        for (const item of turn.items ?? []) {
          if (item.type === 'userMessage') this.event({ type: 'user', codex_history: true, message: { content: (item.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => ({ type: 'text', text: b.text })) } });
          else this.item(item, true);
        }
      }
    }
    // Skill discovery is optional for older clients; a failure must not prevent opening the thread.
    try { await this.loadSkills(); } catch (error) { this.emit('stderr', `Could not load Codex skills: ${String(error)}\n`); }
    this.event({ type: 'system', subtype: 'init', provider: 'codex', conversation_id: this.threadId, model: this.model, cwd: spec.cwd,
      slash_commands: [...Object.keys(CODEX_COMMANDS), ...this.skills.map((s) => s.name)], terminal_slash_commands: CODEX_TERMINAL_COMMANDS });
  }

  private async loadSkills(forceReload = false) {
    const result = await this.rpc.request('skills/list', { cwds: [this.cwd], forceReload }, 10_000);
    const skills: CodexSkill[] = (result.data ?? []).flatMap((entry: any) => entry.skills ?? [])
      .filter((skill: any) => skill.enabled !== false && skill.name && skill.path)
      .map((skill: any) => ({ name: skill.pluginId ? `${skill.pluginId.split('@')[0]}:${skill.name}` : skill.name,
        path: skill.path, pluginId: skill.pluginId, description: skill.shortDescription || skill.description || 'Codex skill' }));
    // New harnesses expose remote plugin skills separately, without filesystem paths.
    try {
      const installed = await this.rpc.request('plugin/installed', { cwds: [this.cwd] }, 5000);
      const details = await Promise.allSettled((installed.marketplaces ?? []).flatMap((marketplace: any) =>
        (marketplace.plugins ?? []).filter((plugin: any) => plugin.installed && plugin.enabled).map(async (plugin: any) => {
          const detail = await this.rpc.request('plugin/read', { pluginName: plugin.name,
            ...(marketplace.path ? { marketplacePath: marketplace.path } : { remoteMarketplaceName: marketplace.name }) }, 5000);
          return (detail.plugin?.skills ?? []).filter((s: any) => s.enabled !== false && s.name).map((s: any) => ({
            name: `${plugin.name}:${s.name}`, path: s.path || undefined, pluginId: plugin.id,
            description: s.shortDescription || s.description || 'Codex plugin skill',
          }));
        })));
      for (const detail of details) if (detail.status === 'fulfilled') skills.push(...detail.value);
    } catch { /* Older clients include local plugin skills in skills/list instead. */ }
    const seen = new Set<string>();
    this.availableSkills = skills.filter((skill) => {
        if (seen.has(skill.name)) return false;
        seen.add(skill.name);
        return true;
      });
    this.event({ type: 'system', subtype: 'codex_skills', skills: this.skills });
  }

  /** Slash operations invoke app-server APIs, never send TUI commands as model prompts. */
  async command(name: string, args: string): Promise<string> {
    await this.ready;
    if (name === 'goal') {
      const params = { threadId: this.threadId, origin: 'user' };
      if (args === 'clear') { await this.rpc.request('thread/goal/clear', params); return 'Goal cleared.'; }
      const result = args === '' ? await this.rpc.request('thread/goal/get', { threadId: this.threadId })
        : await this.rpc.request('thread/goal/set', { ...params, ...(args === 'pause' ? { status: 'paused' }
          : args === 'resume' ? { status: 'active' } : { objective: args, status: 'active' }) });
      const goal = result.goal;
      if (args === 'pause' && this.turnId) await this.interruptTurn();
      return goal ? `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed ?? 0}${goal.tokenBudget != null ? ` / ${goal.tokenBudget}` : ''}` : 'No active goal. Use /goal <objective> to create one.';
    }
    if (name === 'skills') {
      if (args && args !== 'reload') throw new Error('Use /skills or /skills reload. Invoke a skill with /<name> <instructions>.');
      await this.loadSkills(args === 'reload');
      return this.skills.length ? this.skills.map((s) => `/${s.name} — ${s.description}`).join('\n') : 'No enabled Codex skills found.';
    }
    if (name === 'mcp') {
      const servers: any[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await this.rpc.request('mcpServerStatus/list', { cursor, limit: 100 });
        servers.push(...(page.data ?? []));
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeated MCP cursor.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return servers.length ? servers.map((s) => `${s.name} — ${s.authStatus ?? 'unknown'}\n  ${Object.keys(s.tools ?? {}).join(', ') || 'No tools'}`).join('\n') : 'No MCP servers configured.';
    }
    if (name === 'usage') {
      const result = await this.rpc.request('account/rateLimits/read', {});
      const limits = result.rateLimitsByLimitId ?? { codex: result.rateLimits };
      return Object.entries(limits).map(([id, value]: [string, any]) => `${id}: ${['primary', 'secondary'].filter((k) => value?.[k]).map((k) => `${k} ${value[k].usedPercent}% used`).join(' · ') || 'Usage unavailable'}`).join('\n') || 'Usage unavailable.';
    }
    if (this.turnId) throw new Error('Interrupt or finish the current turn before using this command.');
    if (name === 'compact') {
      if (args) throw new Error('Use /compact without arguments.');
      await this.rpc.request('thread/compact/start', { threadId: this.threadId });
      return 'Conversation compaction started.';
    }
    if (name === 'review') {
      const result = await this.rpc.request('review/start', { threadId: this.threadId, delivery: 'inline',
        target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' } });
      // Do not resurrect a turn that has already completed while the reply was arriving.
      if (result.turn?.status === 'inProgress') this.turnId = result.turn.id;
      return 'Codex review started.';
    }
    throw new Error(`Unknown Codex command: /${name}`);
  }

  async setEffort(effort: string) {
    await this.ready;
    try { await this.rpc.request('thread/settings/update', { threadId: this.threadId, effort }); }
    catch (error) {
      // Older app-servers still accept effort on turn/start.
      if (!/unknown method|method not found|unsupported.*method/i.test((error as Error).message)) throw error;
    }
    this.effort = effort;
  }

  async setPermissions(settings: CodexPermissions) {
    await this.ready;
    await this.rpc.request('thread/settings/update', { threadId: this.threadId,
      approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
      sandboxPolicy: codexSandboxPolicy(settings.sandbox, this.cwd) });
    this.permissionOverrides = { ...settings };
  }

  async readUsage() {
    await this.ready;
    return this.rpc.request('account/rateLimits/read', {}, 15_000);
  }

  send(ev: StreamEvent): boolean {
    if (!this.alive) return false;
    if (ev.type === 'user') {
      const blocks = typeof ev.message.content === 'string' ? [{ type: 'text', text: ev.message.content }] : ev.message.content;
      const input = blocks.map((b: any) => b.type === 'image'
        ? { type: 'image', url: `data:${b.source.media_type};base64,${b.source.data}` }
        : { type: 'text', text: b.text, text_elements: [] });
      const generation = ++this.turnGeneration;
      void this.ready!.then(async () => {
        for (const block of input) {
          if (block.type !== 'text') continue;
          const match = /^[/\$]([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(block.text.trim());
          const skill = match && this.skills.find((s) => s.name === match[1]);
          if (skill) {
            block.text = `$${skill.name}${match![2] ? ' ' + match![2] : ''}`;
            if (skill.path) input.push({ type: 'skill', name: skill.name, path: skill.path });
            else if (skill.pluginId) input.push({ type: 'mention', name: skill.pluginId.split('@')[0], path: `plugin://${skill.pluginId}` });
            break;
          }
        }
        const settings = this.permissionOverrides;
        const result = await this.rpc.request('turn/start', { threadId: this.threadId, input, model: this.model, effort: this.effort,
          ...(settings ? { approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer,
            sandboxPolicy: codexSandboxPolicy(settings.sandbox, this.cwd) } : {}) });
        if (generation !== this.turnGeneration) return;
        this.turnId = result.turn.id;
        if (this.interruptPending) await this.interruptTurn();
      }).catch((error: Error) => {
        if (this.alive) this.event({ type: 'result', subtype: 'error', is_error: true, errors: [error.message] });
      });
      return true;
    }
    if (ev.type === 'control_request' && ev.request?.subtype === 'interrupt') {
      this.interruptPending = true;
      if (this.turnId) void this.interruptTurn();
      return true;
    }
    if (ev.type === 'control_response') return this.respond(ev.response.request_id, ev.response.response);
    return false;
  }

  private async interruptTurn() {
    this.interruptPending = false;
    const turnId = this.turnId;
    try {
      // A user interrupt must also stop automatic goal continuation.
      try {
        const result = await this.rpc.request('thread/goal/get', { threadId: this.threadId }, 2000);
        if (result.goal?.status === 'active') await this.rpc.request('thread/goal/set', { threadId: this.threadId, origin: 'user', status: 'paused' });
      } catch { /* Older clients do not expose goals. The turn can still be interrupted. */ }
      if (turnId && this.turnId === turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId });
    }
    catch (error) { this.event({ type: 'error', message: String(error) }); }
  }

  private respond(key: string, decision: any): boolean {
    const request = this.requests.get(key);
    if (!request) return false;
    const allowed = decision.behavior === 'allow';
    let result: any;
    if (request.method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of request.params.questions) {
        const answer = decision.updatedInput?.answers?.[q.question];
        answers[q.id] = { answers: allowed && answer ? [answer] : [] };
      }
      result = { answers };
    } else if (request.method === 'item/permissions/requestApproval') {
      result = { permissions: allowed ? request.params.permissions : {}, scope: 'turn' };
    } else {
      result = { decision: allowed ? 'accept' : 'decline' };
    }
    if (!this.rpc.reply(request.id, result)) return false;
    this.requests.delete(key);
    return true;
  }

  private serverRequest(request: any) {
    const p = request.params ?? {};
    const key = `codex:${request.id}`;
    let tool: string;
    let input: any;
    switch (request.method) {
      case 'item/commandExecution/requestApproval': tool = 'Bash'; input = { command: p.command, cwd: p.cwd }; break;
      case 'item/fileChange/requestApproval': tool = 'Edit'; input = { file_path: p.grantRoot, itemId: p.itemId }; break;
      case 'item/permissions/requestApproval': tool = 'Permissions'; input = p.permissions; break;
      case 'item/tool/requestUserInput': tool = 'AskUserQuestion'; input = { questions: p.questions }; break;
      default:
        this.rpc.reject(request.id, `Unsupported request: ${request.method}. Use /native for this interaction.`);
        this.event({ type: 'error', message: `Codex requested ${request.method}, which requires the native terminal.` });
        return;
    }
    this.requests.set(key, request);
    this.event({ type: 'control_request', request_id: key, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: p.itemId, description: p.reason, agent_id: p.threadId === this.threadId ? undefined : p.threadId } });
  }

  private notification(message: any) {
    if (message.method === 'thread/settings/updated' && message.params.threadId === this.threadId) {
      this.event({ type: 'system', subtype: 'permission_settings', settings: message.params.threadSettings });
      return;
    }
    if (message.method === 'account/rateLimits/updated') {
      this.emit('accountUsage', { rateLimits: message.params.rateLimits });
      return;
    }
    const p = message.params ?? {};
    const owner = this.owners.get(p.threadId);
    // Events for subagents use their receiving thread as the transcript owner.
    if (this.threadId && p.threadId && p.threadId !== this.threadId && !owner) return;
    switch (message.method) {
      case 'skills/changed':
        void this.loadSkills(true).catch((error) => this.emit('stderr', `Could not refresh Codex skills: ${String(error)}\n`));
        return;
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const key = `${p.threadId}:${p.itemId}`;
        const text = (this.texts.get(key) ?? '') + (p.delta ?? '');
        this.texts.set(key, text);
        this.event({ type: 'codex_text', id: key, text, parent_tool_use_id: owner });
        return;
      }
      case 'turn/started':
        if (!owner) {
          this.turnId = p.turn.id;
          this.event({ type: 'system', subtype: 'codex_turn_started' });
          if (this.interruptPending) void this.interruptTurn();
        }
        return;
      case 'turn/completed':
        if (owner) {
          this.event({ type: 'system', subtype: 'task_notification', task_id: p.threadId, tool_use_id: owner, status: p.turn.status === 'completed' ? 'completed' : 'failed', summary: p.turn.error?.message });
          return;
        }
        this.turnGeneration++;
        this.turnId = undefined;
        this.interruptPending = false;
        for (const [key, r] of this.requests) {
          if (r.params.turnId === p.turn.id) {
            this.requests.delete(key);
            this.event({ type: 'control_cancel_request', request_id: key });
          }
        }
        this.event({ type: 'result', subtype: p.turn.status === 'interrupted' ? 'error_during_execution' : p.turn.status === 'failed' ? 'error' : 'success', is_error: ['failed', 'interrupted'].includes(p.turn.status), terminal_reason: p.turn.status === 'interrupted' ? 'aborted_streaming' : undefined, errors: p.turn.error ? [p.turn.error.message] : undefined });
        return;
      case 'thread/tokenUsage/updated':
        this.event({ type: 'system', subtype: 'codex_usage', owner, model: owner ? this.ownerModels.get(owner) : this.model, thread_id: p.threadId, usage: p.tokenUsage });
        return;
      case 'error':
        this.event({ type: 'error', message: p.error?.message ?? 'Codex error' });
        return;
      case 'item/started':
      case 'item/completed':
        this.item(p.item, message.method === 'item/completed', owner, p.threadId);
        return;
    }
  }

  private item(item: any, completed: boolean, owner?: string, threadId = this.threadId) {
    if (!item) return;
    if (item.type === 'agentMessage' || item.type === 'plan') {
      if (completed && item.text) {
        const key = `${threadId}:${item.id}`;
        if (this.texts.has(key)) {
          this.texts.delete(key);
          this.event({ type: 'codex_text', id: key, text: item.text, parent_tool_use_id: owner });
        } else this.assistant([{ type: 'text', text: item.text }], owner);
      }
      return;
    }
    if (item.type === 'reasoning') {
      if (completed && (item.summary?.length || item.content?.length)) this.assistant([{ type: 'thinking', thinking: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') }], owner);
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      for (const id of item.receiverThreadIds ?? []) {
        const agentOwner = `codex-agent:${id}`;
        if (!this.owners.has(id)) {
          this.owners.set(id, agentOwner);
          if (item.model) this.ownerModels.set(agentOwner, item.model);
          this.assistant([{ type: 'tool_use', id: agentOwner, name: 'Agent', input: { description: item.prompt || id, model: item.model, run_in_background: true } }], owner);
          this.event({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: agentOwner, task_type: 'local_agent', subagent_type: 'Codex', description: item.prompt || id, is_backgrounded: true });
        }
        const state = item.agentsStates?.[id];
        if (state && ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(state.status)) {
          if (state.message) this.assistant([{ type: 'text', text: state.message }], agentOwner);
          this.event({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: agentOwner, status: state.status === 'completed' ? 'completed' : 'failed', summary: state.message });
        }
      }
      return;
    }
    const name = item.type === 'commandExecution' ? 'Bash' : item.type === 'fileChange' ? 'Edit' : item.type === 'mcpToolCall' ? `mcp__${item.server}__${item.tool}` : item.type === 'webSearch' ? 'WebSearch' : item.type === 'dynamicToolCall' ? item.tool : undefined;
    if (!name) return;
    const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item.arguments ?? item.changes ?? { query: item.query };
    const key = `${owner ?? 'main'}:${item.id}`;
    if (!this.tools.has(key)) {
      this.tools.add(key);
      this.assistant([{ type: 'tool_use', id: item.id, name, input }], owner);
    }
    if (completed) {
      this.tools.delete(key);
      const output = item.aggregatedOutput ?? item.result ?? item.changes ?? item.contentItems ?? item.error ?? '';
      this.event({ type: 'user', parent_tool_use_id: owner, message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: typeof output === 'string' ? output : JSON.stringify(output), is_error: item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0) }] } });
    }
  }
}
