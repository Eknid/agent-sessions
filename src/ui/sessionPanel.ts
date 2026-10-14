import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ImageAttachment, LogRecord } from '../core/events';
import { AgentProvider, providerLabel } from '../core/models';
import { fmtDuration, fmtSessionCost, fmtTokens, fmtUsd } from '../core/format';
import { modelLabel } from '../core/pricing';
import { SessionManager } from '../core/sessionManager';
import { MAIN, SessionView, shownAgentState } from '../core/sessionModel';
import { catalogue, classify } from '../core/slashCommands';
import { Item, Tone, toolSummary, Transcript } from '../core/transcript';
import { STATE_LABEL, stateLabel } from './sessionTree';
import { VoiceDictation, transcribeAudio } from '../process/voice';
import { AccountUsage } from '../core/accountUsage';
import { PermissionView } from '../core/permissions';

/** What a tab needs from the extension for commands it cannot do on its own. */
export interface TabHost {
  resumePast(cwd: string, provider?: AgentProvider): void;
  openNative(sessionId: string): void;
  openAgent(sessionId: string, ownerId: string): void;
  changeCodexModel(sessionId: string): void;
}

export const PANEL_VIEW_TYPE = 'agentSessions.session';

/*
 * Layer 4: a chat tab onto a session. It owns no process — opening replays the event log
 * into chat items, closing just unsubscribes. The session keeps running in the manager.
 */

const STATE_GLYPH: Record<string, string> = { running: '▶', waiting: '⚠', done: '✓', exited: '■' };

/** Pending request as the webview shows it: an actionable card above the input. */
export interface PendingCard {
  requestId: string;
  kind: 'permission' | 'question';
  tool?: string;
  summary: string;
  description?: string;
  canAlways: boolean;
  from?: string;
  questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
}

export interface PanelState {
  permissions?: PermissionView;
  effort?: string;
  accountUsage?: AccountUsage;
  provider?: string;
  name: string;
  cwd: string;
  model: string;
  state: string;
  uiState: string;
  label: string;
  cost: string;
  contextPct: number;
  pending: PendingCard[];
  /** Messages waiting for the turn to end; images as a count (the page has no use for the data). */
  queue: { id: string; text: string; images: number }[];
}

export type Inbound =
  | { type: 'ready' }
  | { type: 'send'; text: string; images: ImageAttachment[] }
  | { type: 'interrupt' }
  | { type: 'unqueue'; id: string }
  | { type: 'allow'; requestId: string; always: boolean }
  | { type: 'deny'; requestId: string; message?: string }
  | { type: 'answer'; requestId: string; answers: Record<string, string> }
  | { type: 'skip'; requestId: string }
  | { type: 'openAgent'; ownerId: string }
  | { type: 'openLink'; href: string }
  | { type: 'pickImages' }
  | { type: 'changeEffort' }
  | { type: 'changePermissions' }
  | { type: 'refreshUsage' }
  | { type: 'voice' }
  | { type: 'dropPaths'; uris: string[] };

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Read from disk only up to this size; the tab then fits it to the API's limits. */
const MAX_IMAGE_FILE = 30 * 1024 * 1024;

export class SessionPanel {
  private transcript: Transcript;
  private listeners: (() => void)[] = [];
  private stateTimer?: NodeJS.Timeout;
  private lastTitle = '';
  private lastCommands = '';
  private localSeq = 0;
  private usageTimer?: NodeJS.Timeout;
  private voice: VoiceDictation;
  private effortPickerOpen = false;
  private permissionPickerOpen = false;
  /** Set once the page has loaded and asked for its content. */
  ready = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly manager: SessionManager,
    readonly sessionId: string,
    readonly owner: string,
    private readonly extensionUri: vscode.Uri,
    private readonly onClosed: () => void,
    private readonly host: TabHost,
  ) {
    this.voice = new VoiceDictation((command, id) => vscode.commands.executeCommand(command, id),
      (wav, signal) => transcribeAudio(wav, { ...manager.codexSpec, cwd: manager.view(sessionId)?.cwd ?? process.cwd() }, signal),
      (state, text, error) => this.post({ type: 'voice', state, text, error }));
    this.transcript = new Transcript({ owner });
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')] };
    const icon = owner === MAIN ? 'chat' : 'agent';
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', `${icon}-light.svg`),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', `${icon}-dark.svg`),
    };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: Inbound) => this.receive(m), undefined, this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    const onRecord = (id: string, rec: LogRecord) => id === this.sessionId && this.onRecord(rec);
    const onChanged = (id: string) => id === this.sessionId && this.scheduleState();
    this.manager.on('record', onRecord);
    this.manager.on('changed', onChanged);
    this.listeners.push(() => this.manager.off('record', onRecord), () => this.manager.off('changed', onChanged));
    this.updateTitle();
  }

  private disposables: vscode.Disposable[] = [];

  get readOnly() {
    return this.owner !== MAIN;
  }

  reveal() {
    this.panel.reveal(undefined, false);
  }

  focusInput() {
    void this.panel.webview.postMessage({ type: 'focus' });
  }

  private dispose() {
    clearInterval(this.usageTimer);
    this.voice.dispose();
    clearTimeout(this.stateTimer);
    for (const off of this.listeners) off();
    this.listeners = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.onClosed();
  }

  // ---------- host → webview ----------

  private post(msg: unknown) {
    if (this.ready) void this.panel.webview.postMessage(msg);
  }

  private init() {
    this.transcript = new Transcript({ owner: this.owner });
    for (const rec of this.manager.records(this.sessionId)) this.transcript.apply(rec);
    this.ready = true;
    this.lastCommands = '';
    this.post({ type: 'init', readOnly: this.readOnly, items: this.transcript.all(), state: this.state(), commands: this.commands() });
    if (!this.readOnly) {
      void this.manager.refreshUsage(this.sessionId);
      if (!this.usageTimer) this.usageTimer = setInterval(() => {
        if (this.panel.visible) void this.manager.refreshUsage(this.sessionId);
      }, 60_000);
    }
  }

  private onRecord(rec: LogRecord) {
    const items = this.transcript.apply(rec);
    if (items.length) this.post({ type: 'items', items });
  }

  private scheduleState() {
    this.updateTitle();
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.post({ type: 'state', state: this.state() });
      const cmds = this.commands();
      const key = JSON.stringify(cmds);
      if (key !== this.lastCommands) {
        this.lastCommands = key;
        this.post({ type: 'commands', commands: cmds });
      }
    }, 80);
  }

  private commands() {
    return catalogue(this.manager.slashCommands(this.sessionId));
  }

  private state(): PanelState | undefined {
    const v = this.manager.view(this.sessionId);
    if (!v) return undefined;
    const owner = v.owners.find((o) => o.id === this.owner);
    const sub = this.readOnly && owner;
    return {
      name: sub ? `${owner.label} — subagent of ${v.name}` : v.name,
      provider: v.provider === 'codex' ? 'Codex' : 'Claude',
      cwd: v.cwd,
      model: modelLabel(sub ? owner.model : v.model),
      effort: v.effort,
      permissions: v.permissions,
      accountUsage: v.accountUsage,
      state: v.state,
      uiState: sub ? shownAgentState(v, owner) : v.uiState,
      label: sub ? STATE_LABEL[shownAgentState(v, owner)] ?? owner.state : stateLabel(v),
      cost: fmtSessionCost(v, sub ? owner.costUsd : v.costUsd),
      contextPct: sub ? owner.contextPct : v.contextPct,
      pending: this.readOnly ? [] : v.pending.map((p) => this.card(v, p)),
      queue: this.readOnly ? [] : this.manager.queue(this.sessionId).map((q) => ({ id: q.id, text: q.text, images: q.images.length })),
    };
  }

  private card(v: SessionView, p: SessionView['pending'][number]): PendingCard {
    const from = p.ownerId && p.ownerId !== MAIN ? v.owners.find((o) => o.id === p.ownerId)?.label : undefined;
    if (p.kind === 'question') {
      return {
        requestId: p.requestId,
        kind: 'question',
        summary: `${providerLabel(v.provider)} has a question`,
        canAlways: false,
        from,
        questions: (p.input?.questions ?? []).map((q: NonNullable<PendingCard['questions']>[number]) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect,
          options: q.options ?? [],
        })),
      };
    }
    return {
      requestId: p.requestId,
      kind: 'permission',
      tool: p.toolName,
      summary: toolSummary(p.toolName ?? 'tool', p.input),
      description: p.description,
      canAlways: Boolean(p.suggestions?.length),
      from,
    };
  }

  private updateTitle() {
    const v = this.manager.view(this.sessionId);
    if (!v) return;
    const owner = v.owners.find((o) => o.id === this.owner);
    const state = this.readOnly ? (owner ? shownAgentState(v, owner) : 'done') : v.state === 'exited' ? 'exited' : v.uiState;
    const glyph = STATE_GLYPH[state] ?? (state === 'completed' ? '✓' : state === 'running' ? '▶' : '■');
    const title = `${glyph} ${this.readOnly ? `${v.name} › ${owner?.label ?? 'subagent'}` : v.name}`;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.panel.title = title;
    }
  }

  /** A message shown only in this tab (not part of the session log). */
  private local(title: string, text: string, tone: Tone = 'dim') {
    const item: Item = { kind: 'note', id: `local${++this.localSeq}`, title, text, tone };
    this.post({ type: 'items', items: [item] });
  }

  // ---------- webview → host ----------

  /** A message from the page (public so the smoke test can act like the page). */
  receive(m: Inbound) {
    if (this.readOnly && !['ready', 'openAgent', 'openLink'].includes(m.type)) return;
    switch (m.type) {
      case 'ready':
        return this.init();
      case 'send':
        return this.submit(m.text ?? '', (m.images ?? []).filter((i) => ALLOWED_IMAGE_TYPES.has(i.mediaType) && typeof i.data === 'string'));
      case 'interrupt':
        if (this.manager.view(this.sessionId)?.uiState !== 'done') this.manager.interrupt(this.sessionId);
        return;
      case 'unqueue':
        this.manager.unqueue(this.sessionId, m.id);
        return;
      case 'allow': {
        const p = this.manager.view(this.sessionId)?.pending.find((r) => r.requestId === m.requestId);
        this.manager.allow(this.sessionId, m.requestId, Boolean(m.always && p?.suggestions?.length));
        return;
      }
      case 'deny':
        this.manager.deny(this.sessionId, m.requestId, m.message?.trim() ? `The user denied this and said: ${m.message.trim()}` : undefined);
        return;
      case 'answer':
        this.manager.answer(this.sessionId, m.requestId, m.answers);
        return;
      case 'skip':
        this.manager.deny(this.sessionId, m.requestId, 'The user chose not to answer.');
        return;
      case 'openAgent':
        this.host.openAgent(this.sessionId, m.ownerId);
        return;
      case 'openLink':
        return void this.openLink(m.href);
      case 'pickImages':
        return void this.pickImages();
      case 'changeEffort':
        return void this.pickEffort();
      case 'changePermissions':
        return void this.pickPermissions();
      case 'refreshUsage':
        return void this.manager.refreshUsage(this.sessionId, true);
      case 'voice':
        return void this.voice.toggle().catch((error: Error) => this.post({ type: 'voice', state: 'idle', error: error.message }));
      case 'dropPaths':
        return this.attachPaths((m.uris ?? []).map((u) => (u.startsWith('file:') ? vscode.Uri.parse(u).fsPath : u)));
    }
  }

  private async pickPermissions() {
    if (this.permissionPickerOpen) return;
    this.permissionPickerOpen = true;
    try {
      const current = this.manager.view(this.sessionId)?.permissions;
      const pick = await vscode.window.showQuickPick(this.manager.permissionChoices(this.sessionId).map((choice) => ({
        label: choice.label, detail: choice.detail, description: choice.value === current?.value ? 'Current' : undefined, value: choice.value,
      })), { placeHolder: 'Permission mode for this session · applies to subsequent actions' });
      if (pick) await this.manager.changePermissions(this.sessionId, pick.value);
    } catch (error) { this.local('Permissions', (error as Error).message, 'warn'); }
    finally { this.permissionPickerOpen = false; }
  }

  private async pickEffort() {
    if (this.effortPickerOpen) return;
    this.effortPickerOpen = true;
    try {
      const levels = await this.manager.effortChoices(this.sessionId);
      if (!levels.length) { this.local('Effort', 'This model does not support adjustable effort.'); return; }
      const current = this.manager.view(this.sessionId)?.effort ?? 'medium';
      const pick = await vscode.window.showQuickPick(levels.map((level) => ({ label: level,
        description: level === current ? 'Current' : level === 'medium' ? 'Default' : undefined })),
        { placeHolder: 'Reasoning effort · applies from the next turn' });
      if (pick) await this.manager.changeEffort(this.sessionId, pick.label);
    } catch (error) { this.local('Effort', (error as Error).message, 'warn'); }
    finally { this.effortPickerOpen = false; }
  }

  private async pickImages() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: vscode.Uri.file(this.manager.view(this.sessionId)?.cwd ?? process.env.HOME ?? '/'),
      filters: { Images: Object.keys(IMAGE_EXT).map((e) => e.slice(1)) },
    });
    if (uris?.length) this.attachPaths(uris.map((u) => u.fsPath));
  }

  /** Images become attachments; any other dropped file is mentioned by path in the message. */
  private attachPaths(paths: string[]) {
    const images: ImageAttachment[] = [];
    const mentions: string[] = [];
    const cwd = this.manager.view(this.sessionId)?.cwd ?? '';
    for (const p of paths) {
      const type = IMAGE_EXT[path.extname(p).toLowerCase()];
      try {
        if (type && fs.statSync(p).size <= MAX_IMAGE_FILE) {
          images.push({ mediaType: type, data: fs.readFileSync(p).toString('base64') });
          continue;
        }
      } catch {
        /* unreadable: mention it instead */
      }
      const rel = cwd && p.startsWith(cwd + path.sep) ? path.relative(cwd, p) : p;
      mentions.push(/\s/.test(rel) ? JSON.stringify(rel) : rel);
    }
    void this.panel.webview.postMessage({ type: 'attach', images, text: mentions.join(' ') });
  }

  private submit(raw: string, images: ImageAttachment[]) {
    const text = raw.trim();
    if (!text && !images.length) return;
    if (!images.length) {
      const cmd = classify(text, this.manager.slashCommands(this.sessionId));
      if (cmd.kind === 'local') return this.localCommand(cmd.name, text, cmd.args);
      if (cmd.kind === 'unsupported') {
        const why = cmd.terminalOnly ? `/${cmd.name} only works in the native terminal.` : `/${cmd.name} isn't available in headless sessions.`;
        return this.local(text, `${why} Use /native to open this session in the TUI, or /help for what works here.`, 'warn');
      }
    }
    this.manager.send(this.sessionId, text, images);
  }

  private localCommand(name: string, text: string, args = '') {
    const v = this.manager.view(this.sessionId);
    if (!v) return;
    switch (name) {
      case 'permissions':
        return void this.pickPermissions();
      case 'model':
        this.host.changeCodexModel(this.sessionId);
        return;
      case 'goal':
      case 'compact':
      case 'review':
      case 'skills':
      case 'mcp':
      case 'usage':
        void this.manager.codexCommand(this.sessionId, name, args)
          .then((body) => this.local(text, body))
          .catch((error) => this.local(text, error instanceof Error ? error.message : String(error), 'warn'));
        return;
      case 'help': {
        const cmds = this.manager.slashCommands(this.sessionId);
        const local = catalogue(cmds).filter((c) => c.kind === 'local').map((c) => `  /${c.name.padEnd(10)} ${c.description}`).join('\n');
        const forwarded = catalogue(cmds).filter((c) => c.kind === 'headless' || c.kind === 'skill').map((c) => '/' + c.name);
        const body = [
          'Handled by the extension',
          local,
          '',
          `Sent to ${providerLabel(v.provider)} (${forwarded.length})`,
          forwarded.length ? '  ' + forwarded.join('  ') : v.provider === 'codex' ? '  No enabled skills found.' : '  known after Claude has answered once',
          '',
          ...(cmds.terminalOnly.length ? [`Interactive TUI only: ${cmds.terminalOnly.map((c) => '/' + c).join(' ')} — use /native.`, ''] : []),
          'Type / for suggestions. ↵ send · ⇧↵ new line · ↑/↓ history · Esc interrupt · ⌘V or drop (hold ⇧) to attach images.',
          'While the agent works, ↵ adds the message to the queue above the input; each one is sent when the turn before it ends.',
        ].join('\n');
        return this.local(text, body);
      }
      case 'status':
      case 'cost': {
        const main = v.owners[0];
        const lines = [
          `${v.name}  ${stateLabel(v)} · ${modelLabel(v.model)} · ${v.turns} turns · active ${fmtDuration((v.endedAt ?? Date.now()) - v.createdAt)}`,
          `Cost ${v.costAvailable === false ? 'unavailable (configure pricingOverrides for estimates)' : fmtSessionCost(v)}${v.costAvailable !== false && v.costIsEstimate ? (v.provider === 'codex' ? ' (Standard API estimate)' : ' (partly estimated)') : ''} · tokens ${fmtTokens(v.tokens.total)} (+${fmtTokens(v.tokens.cacheRead)} cache read)`,
          `Context ~${v.contextPct.toFixed(0)}% (${fmtTokens(main.contextTokens)} / ${fmtTokens(main.contextWindow)})`,
          ...v.owners.slice(1).map((o) => `  ${o.label} · ${modelLabel(o.model)} · ${o.state} · ${fmtTokens(o.tokens.total)} · ${fmtUsd(o.costUsd)}`),
        ];
        return this.local(text, lines.join('\n'));
      }
      case 'exit':
      case 'quit':
        this.local(text, 'Stopping the agent process. Send a message to resume the session.');
        this.manager.stop(this.sessionId);
        return;
      case 'resume':
        this.local(text, 'Pick a conversation from the list at the top of the window…');
        this.host.resumePast(v.cwd, v.provider);
        return;
      case 'native':
        this.local(text, `Opening this session in the ${providerLabel(v.provider)} terminal…`);
        this.host.openNative(this.sessionId);
        return;
    }
  }

  /** Links in Claude's replies: web links open in the browser, file paths in the editor. */
  private async openLink(href: string) {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const v = this.manager.view(this.sessionId);
    if (!v) return;
    let target = decodeURIComponent(href.replace(/^file:\/\//, ''));
    let line: number | undefined;
    let endLine: number | undefined;
    const hash = /#L(\d+)(?:-L?(\d+))?$/.exec(target);
    if (hash) {
      line = Number(hash[1]);
      endLine = hash[2] ? Number(hash[2]) : undefined;
      target = target.slice(0, hash.index);
    } else {
      const colon = /:(\d+)(?::\d+)?$/.exec(target);
      if (colon) {
        line = Number(colon[1]);
        target = target.slice(0, colon.index);
      }
    }
    if (target.startsWith('~/')) target = path.join(process.env.HOME ?? '', target.slice(2));
    const abs = path.isAbsolute(target) ? target : path.join(v.cwd, target);
    if (!fs.existsSync(abs)) {
      void vscode.window.setStatusBarMessage(`$(warning) Not found: ${target}`, 3000);
      return;
    }
    const uri = vscode.Uri.file(abs);
    if (fs.statSync(abs).isDirectory()) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    const selection = line ? new vscode.Range(line - 1, 0, (endLine ?? line) - 1, 0) : undefined;
    await vscode.window.showTextDocument(uri, { selection, viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  // ---------- page ----------

  private html(): string {
    const w = this.panel.webview;
    const res = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', ...p)).toString();
    const nonce = crypto.randomBytes(16).toString('base64');
    const boot = JSON.stringify({ sessionId: this.sessionId, owner: this.owner }).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data: blob:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${res('session', 'session.css')}">
</head>
<body>
<main id="log" aria-live="polite"></main>
<footer id="dock"></footer>
<script nonce="${nonce}">window.BOOT = ${boot};</script>
<script nonce="${nonce}" src="${res('vendor', 'marked.js')}"></script>
<script nonce="${nonce}" src="${res('session', 'session.js')}"></script>
</body></html>`;
  }
}
