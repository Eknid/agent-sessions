import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fmtUsd } from './core/format';
import { PriceTable, Rates } from './core/pricing';
import { AgentProvider, discoverModels, modelChoices, providerLabel } from './core/models';
import { bundledCodex } from './core/executable';
import { SessionManager } from './core/sessionManager';
import { MAIN, SessionView, UiState } from './core/sessionModel';
import { MetricsViewProvider } from './ui/metricsView';
import { listPastConversations, listPastCodexConversations } from './core/pastConversations';
import { BOARD_VIEW_TYPE, BoardPanel } from './ui/boardPanel';
import { PANEL_VIEW_TYPE, SessionPanel, TabHost } from './ui/sessionPanel';
import { Filter, GroupBy, SessionTreeProvider, stateLabel } from './ui/sessionTree';

let manager: SessionManager | undefined;

/** `claude` is often only on the login shell's PATH (Homebrew, ~/.local/bin), not VS Code's. */
function resolveExecutable(name: AgentProvider, configured: string): string {
  if (configured) return configured;
  if (name === 'codex') {
    const bundled = bundledCodex(vscode.extensions.getExtension('openai.chatgpt')?.extensionPath);
    if (bundled) return bundled;
  }
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-lc', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 }).trim();
    const line = out.split('\n').pop()?.trim();
    if (line && fs.existsSync(line)) return line;
  } catch {
    /* fall through */
  }
  for (const p of [path.join(process.env.HOME ?? '', `.local/bin/${name}`), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (fs.existsSync(p)) return p;
  }
  return name;
}

function config() {
  const c = vscode.workspace.getConfiguration('agentSessions');
  return {
    claudePath: c.get<string>('claudePath', ''),
    codexPath: c.get<string>('codexPath', ''),
    defaultProvider: c.get<AgentProvider>('defaultProvider', 'claude'),
    codexDefaultModel: c.get<string>('codexDefaultModel', ''),
    codexExtraArgs: c.get<string[]>('codexExtraArgs', []),
    codexApprovalPolicy: c.get<string>('codexApprovalPolicy', 'on-request'),
    codexSandbox: c.get<string>('codexSandbox', 'workspace-write'),
    additionalClaudeModels: c.get<string[]>('additionalClaudeModels', []),
    additionalCodexModels: c.get<string[]>('additionalCodexModels', []),
    defaultModel: c.get<string>('defaultModel', ''),
    permissionMode: c.get<string>('permissionMode', 'default'),
    extraArgs: c.get<string[]>('extraArgs', []),
    notifications: c.get<boolean>('notifications', true),
    pricingOverrides: c.get<Record<string, Partial<Rates>>>('pricingOverrides', {}),
    groupBy: c.get<GroupBy>('groupBy', 'status'),
  };
}

export function activate(context: vscode.ExtensionContext) {
  const cfg = config();
  const storageDir = context.globalStorageUri.fsPath;
  let claudePath = resolveExecutable('claude', cfg.claudePath);
  let codexPath = resolveExecutable('codex', cfg.codexPath);
  const mgr = new SessionManager({
    storageDir,
    command: claudePath,
    codexCommand: codexPath,
    codexExtraArgs: cfg.codexExtraArgs,
    codexApprovalPolicy: cfg.codexApprovalPolicy,
    codexSandbox: cfg.codexSandbox,
    extraArgs: cfg.extraArgs,
    prices: new PriceTable(cfg.pricingOverrides),
  });
  manager = mgr;

  const tree = new SessionTreeProvider(mgr);
  tree.groupBy = cfg.groupBy;
  const treeView = vscode.window.createTreeView('agentSessions.tree', { treeDataProvider: tree, showCollapseAll: false });
  const metrics = new MetricsViewProvider(mgr);
  context.subscriptions.push(treeView, vscode.window.registerWebviewViewProvider('agentSessions.metrics', metrics));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'agentSessions.showWaiting';
  context.subscriptions.push(status);

  // ---------- tabs ----------
  const panels = new Map<string, SessionPanel>();
  const tabKey = (sessionId: string, owner: string) => `${sessionId}/${owner}`;
  const closeTabs = (sessionId: string) => {
    for (const [key, p] of panels) if (key.startsWith(sessionId + '/')) p.panel.dispose();
  };

  const tabHost: TabHost = {
    resumePast: (cwd, provider) => void resumePast(cwd, provider),
    openNative: (id) => void vscode.commands.executeCommand('agentSessions.openNative', id),
    openAgent: (id, owner) => openTab(id, owner),
    changeCodexModel: (id) => void vscode.commands.executeCommand('agentSessions.changeCodexModel', id),
  };

  /** /resume: pick a past Claude Code conversation in `cwd` and track it as a session. */
  async function resumePast(cwd?: string, provider: AgentProvider = 'claude') {
    if (!cwd) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const pick =
        folders.length === 1
          ? folders[0].uri.fsPath
          : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath })), { placeHolder: 'Folder' }))?.description;
      if (!pick) return;
      cwd = pick;
    }
    let past: ReturnType<typeof listPastConversations>;
    try { past = provider === 'codex' ? await listPastCodexConversations(cwd, codexPath, config().codexExtraArgs) : listPastConversations(cwd); }
    catch (error) { void vscode.window.showErrorMessage(`Could not load ${providerLabel(provider)} conversations: ${String(error)}`); return; }
    if (!past.length) {
      void vscode.window.showInformationMessage(`No past ${providerLabel(provider)} conversations found for ${cwd}.`);
      return;
    }
    const ago = (t: number) => {
      const m = Math.round((Date.now() - t) / 60000);
      return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
    };
    const pick = await vscode.window.showQuickPick(
      past.map((p) => ({
        label: p.title,
        description: `${ago(p.updatedAt)}${mgr.has(p.id) ? ' · already tracked' : ''}`,
        detail: p.id,
        id: p.id,
      })),
      { placeHolder: `Resume a conversation from ${path.basename(cwd)}`, matchOnDetail: true },
    );
    if (!pick) return;
    const recent = past.find((p) => p.id === pick.id)!.updatedAt > Date.now() - 120_000;
    if (recent && !mgr.has(pick.id)) {
      const ok = await vscode.window.showWarningMessage(
        `"${pick.label.slice(0, 60)}" was updated less than 2 minutes ago and may still be open in another ${providerLabel(provider)} window. Resume anyway?`,
        { modal: true },
        'Resume',
      );
      if (ok !== 'Resume') return;
    }
    const c = config();
    const id = mgr.create({ cwd, provider, resumeId: pick.id, name: pick.label.slice(0, 40), model: (provider === 'codex' ? c.codexDefaultModel : c.defaultModel) || undefined, permissionMode: c.permissionMode });
    openTab(id);
  }

  /** Wraps a webview panel (new, or restored by VS Code after a reload) as a session tab. */
  function adopt(panel: vscode.WebviewPanel, sessionId: string, owner: string): SessionPanel {
    const key = tabKey(sessionId, owner);
    const tab = new SessionPanel(panel, mgr, sessionId, owner, context.extensionUri, () => {
      if (panels.get(key) === tab) panels.delete(key);
      // Closing the tab only drops the view; the process keeps running in the manager.
      const v = mgr.view(sessionId);
      if (owner === MAIN && v && v.uiState === 'running' && v.state !== 'exited') {
        void vscode.window.setStatusBarMessage(`$(info) ${v.name} keeps working in the background`, 4000);
      }
    }, tabHost);
    panels.set(key, tab);
    panel.onDidChangeViewState((e) => e.webviewPanel.active && metrics.select(sessionId));
    return tab;
  }

  function openTab(sessionId: string, owner = MAIN) {
    const v = mgr.view(sessionId);
    if (!v) return;
    const existing = panels.get(tabKey(sessionId, owner));
    if (existing) {
      existing.reveal();
      existing.focusInput();
      metrics.select(sessionId);
      return;
    }
    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, v.name, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
    });
    adopt(panel, sessionId, owner);
    metrics.select(sessionId);
  }

  const activePanel = () => [...panels.values()].find((p) => p.panel.active);

  // ---------- board ----------
  let board: BoardPanel | undefined;
  const adoptBoard = (panel: vscode.WebviewPanel) => (board = new BoardPanel(panel, mgr, context.extensionUri, () => (board = undefined)));
  function openBoard() {
    if (board) return board.reveal();
    const panel = vscode.window.createWebviewPanel(BOARD_VIEW_TYPE, 'Sessions board', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
    });
    adoptBoard(panel);
  }
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(BOARD_VIEW_TYPE, {
      async deserializeWebviewPanel(panel) {
        if (board) return panel.dispose();
        adoptBoard(panel);
      },
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, saved: { sessionId?: string; owner?: string } | undefined) {
        const id = saved?.sessionId;
        const owner = saved?.owner ?? MAIN;
        if (!id || !mgr.view(id) || panels.has(tabKey(id, owner))) return panel.dispose();
        adopt(panel, id, owner);
      },
    }),
    treeView.onDidChangeSelection((e) => {
      const n = e.selection[0];
      if (n?.sessionId) metrics.select(n.sessionId);
    }),
  );

  function isLookingAt(sessionId: string): boolean {
    return vscode.window.state.focused && activePanel()?.sessionId === sessionId;
  }

  // ---------- reactions to the manager ----------
  function refreshChrome() {
    const list = mgr.list();
    const running = list.filter((s) => s.uiState === 'running' && s.state !== 'exited').length;
    const waiting = list.filter((s) => s.uiState === 'waiting');
    const cost = list.reduce((a, s) => a + s.costUsd, 0);
    status.text = `$(hubot) ${running ? `$(sync~spin) ${running}` : '0'}${waiting.length ? `  $(bell-dot) ${waiting.length}` : ''}  ${fmtUsd(cost)}`;
    status.tooltip = `Agent Sessions — ${running} running, ${waiting.length} waiting for you, ${fmtUsd(cost)} known cost${list.some((s) => s.provider === 'codex' && s.costAvailable !== false) ? '; includes Standard API estimates' : ''}${list.some((s) => s.costAvailable === false) ? '; some costs unavailable' : ''}`;
    status.backgroundColor = waiting.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    list.length ? status.show() : status.hide();
    treeView.badge = waiting.length ? { value: waiting.length, tooltip: `${waiting.length} session${waiting.length === 1 ? '' : 's'} waiting for you` } : undefined;
    const counts = { running, waiting: waiting.length, done: list.filter((s) => s.uiState === 'done').length };
    treeView.description = tree.filter === 'all' ? `${running} running · ${counts.waiting} waiting` : `filter: ${FILTER_LABEL[tree.filter]}`;
  }

  async function notify(id: string, from: UiState, to: UiState, v: SessionView) {
    if (!config().notifications || isLookingAt(id)) return;
    let msg: string | undefined;
    if (to === 'waiting') {
      const p = v.pending[0];
      msg = p?.kind === 'question' ? `${v.name} is asking you a question.` : `${v.name} needs permission: ${p?.toolName ?? ''}`;
    } else if (to === 'done' && from === 'running') {
      // The next queued message goes out right away: Claude is not done.
      if (v.state !== 'exited' && mgr.queue(id).length) return;
      msg = v.state === 'exited' ? `${v.name}: process ended (${v.exitInfo ?? ''}).` : `${v.name} finished its turn.`;
    }
    if (!msg) return;
    const pick = await (to === 'waiting' ? vscode.window.showWarningMessage(msg, 'Open') : vscode.window.showInformationMessage(msg, 'Open'));
    if (pick === 'Open') openTab(id);
  }

  const onChanged = (id: string) => {
    tree.refresh(id);
    metrics.update();
    refreshChrome();
  };
  const onList = () => {
    tree.refresh();
    metrics.update(true);
    refreshChrome();
  };
  mgr.on('changed', onChanged);
  mgr.on('listChanged', onList);
  mgr.on('transition', (id, from, to, v) => void notify(id, from, to, v));

  // Uptime in tooltips and the metrics card ticks on its own; descriptions refresh every 30 s.
  const tick = setInterval(() => {
    if (mgr.list().some((s) => s.state !== 'exited')) tree.refresh();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  // ---------- commands ----------
  const reg = (id: string, fn: (...args: any[]) => unknown) => // eslint-disable-line @typescript-eslint/no-explicit-any
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const sessionArg = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object' && 'sessionId' in arg) return (arg as { sessionId: string }).sessionId;
    const sel = treeView.selection[0];
    if (sel?.sessionId) return sel.sessionId;
    return activePanel()?.sessionId ?? metrics.selectedId;
  };
  async function pickSession(arg: unknown, filter?: (v: SessionView) => boolean): Promise<string | undefined> {
    const id = sessionArg(arg);
    if (id) return id;
    const items = mgr.list().filter((v) => (filter ? filter(v) : !v.archived)).map((v) => ({ label: v.name, description: stateLabel(v), id: v.id }));
    return (await vscode.window.showQuickPick(items, { placeHolder: 'Pick a session' }))?.id;
  }

  async function pickProvider(): Promise<AgentProvider | undefined> {
    const preferred = config().defaultProvider;
    const choices = (['claude', 'codex'] as const).map((provider) => ({ label: providerLabel(provider), provider, description: provider === preferred ? 'Default agent' : undefined }));
    choices.sort((a, b) => Number(b.provider === preferred) - Number(a.provider === preferred));
    return (await vscode.window.showQuickPick(choices, { placeHolder: 'Choose an agent: Claude Code or Codex' }))?.provider;
  }

  async function newSession(initialCwd?: string) {
    const provider = await pickProvider();
    if (!provider) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    let cwd = initialCwd;
    const browse = '$(folder-opened) Choose a folder…';
    if (!cwd && folders.length === 1) cwd = folders[0].uri.fsPath;
    const picked =
      cwd || folders.length === 1
        ? undefined
        : await vscode.window.showQuickPick([...folders.map((f) => ({ label: f.name, description: f.uri.fsPath })), { label: browse, description: '' }], {
            placeHolder: 'Working directory for the session',
          });
    if (!cwd && folders.length !== 1) {
      if (!picked) return;
      cwd = picked.label === browse ? undefined : picked.description;
    }
    if (!cwd) {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this folder' });
      if (!uri?.[0]) return;
      cwd = uri[0].fsPath;
    }
    const c = config();
    let discovered: Awaited<ReturnType<typeof discoverModels>> = [];
    try {
      discovered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Loading ${providerLabel(provider)} models…` }, () =>
        discoverModels(provider, provider === 'codex' ? codexPath : claudePath, cwd!, provider === 'codex' ? c.codexExtraArgs : c.extraArgs));
    } catch (error) {
      void vscode.window.showWarningMessage(`Could not load ${providerLabel(provider)} models: ${error instanceof Error ? error.message : String(error)}. ${provider === 'claude' ? 'Showing known versions.' : 'Use the provider default or enter a custom model ID. Check codex login and agentSessions.codexPath.'}`);
    }
    const models = modelChoices(provider, discovered, provider === 'codex' ? c.codexDefaultModel : c.defaultModel, provider === 'codex' ? c.additionalCodexModels : c.additionalClaudeModels);
    const pickerItems: (typeof models[number] & { kind?: vscode.QuickPickItemKind })[] = [];
    let unverifiedSection = false;
    for (const [index, entry] of models.entries()) {
      if (index > 0 && entry.unverified && !unverifiedSection) {
        pickerItems.push({ label: 'Other model IDs — access unverified', value: '', kind: vscode.QuickPickItemKind.Separator });
        unverifiedSection = true;
      }
      pickerItems.push(entry);
    }
    const model = await vscode.window.showQuickPick(pickerItems, { placeHolder: `${providerLabel(provider)} model — search by name or version`, matchOnDescription: true, matchOnDetail: true });
    if (!model) return;
    let modelId = model.value;
    if (modelId === '__custom__') {
      const custom = await vscode.window.showInputBox({ prompt: 'Exact model ID or deployment name', placeHolder: provider === 'claude' ? 'claude-opus-4-8' : 'Model ID from your Codex provider', validateInput: (value) => value.trim() ? undefined : 'Enter a model ID' });
      if (!custom) return;
      modelId = custom.trim();
    }
    const name = await vscode.window.showInputBox({ prompt: 'Session name', value: path.basename(cwd) });
    if (name === undefined) return;
    // The conversation starts in the tab.
    const id = mgr.create({ cwd, name, provider, model: modelId || undefined, permissionMode: c.permissionMode });
    openTab(id);
    void treeView.reveal(tree.sessionNode(id), { select: true, focus: false });
  }

  reg('agentSessions.newSession', () => newSession());
  reg('agentSessions.newSessionHere', (arg?: unknown) => {
    const cwd = arg instanceof vscode.Uri
      ? arg.fsPath
      : arg && typeof arg === 'object' && 'root' in arg && typeof (arg as { root?: unknown }).root === 'string'
        ? (arg as { root: string }).root
        : undefined;
    return newSession(cwd);
  });
  reg('agentSessions.changeCodexModel', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => v.provider === 'codex' && !v.archived);
    const v = id && mgr.view(id);
    if (!id || !v || v.provider !== 'codex') return;
    if (mgr.isAlive(id) && ['running', 'waiting', 'starting'].includes(v.state)) {
      void vscode.window.showInformationMessage('Interrupt or finish the current turn before changing the model.');
      return;
    }
    try {
      const c = config();
      const discovered = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Loading Codex models…' }, () =>
        discoverModels('codex', codexPath, v.cwd, c.codexExtraArgs));
      const models = modelChoices('codex', discovered, c.codexDefaultModel, c.additionalCodexModels).filter((model) => model.value && model.value !== '__custom__');
      const picked = await vscode.window.showQuickPick(models, { placeHolder: 'Choose a Codex model for this session — conversation history is kept', matchOnDescription: true, matchOnDetail: true });
      if (!picked) return;
      await mgr.changeCodexModel(id, picked.value);
      openTab(id);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  });
  reg('agentSessions.fork', async (arg?: unknown) => {
    const parentId = await pickSession(arg, (v) => mgr.canFork(v.id));
    const v = parentId && mgr.view(parentId);
    if (!parentId || !v) return;
    if (!mgr.canFork(parentId)) {
      void vscode.window.showInformationMessage(`"${v.name}" has no conversation to fork yet: send it a message first.`);
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: `Name of the fork of "${v.name}"`, value: `${v.name} (fork)` });
    if (name === undefined) return;
    const id = mgr.fork(parentId, name);
    if (!id) return;
    openTab(id);
    void treeView.reveal(tree.sessionNode(id), { select: true, focus: false });
  });

  reg('agentSessions.resumePast', async () => { const provider = await pickProvider(); if (provider) await resumePast(undefined, provider); });
  reg('agentSessions.board', () => openBoard());
  reg('agentSessions.open', async (arg?: unknown) => {
    const id = await pickSession(arg);
    if (id) openTab(id);
  });
  reg('agentSessions.copySessionId', async (arg?: unknown) => {
    const id = await pickSession(arg);
    if (!id) return;
    const v = mgr.view(id);
    const resumeId = mgr.resumeId(id);
    if (!resumeId) {
      void vscode.window.showInformationMessage(v?.provider === 'codex'
        ? 'This Codex session has no resumable thread ID yet. Send its first message, then copy the session ID.'
        : 'This session has no resumable ID.');
      return;
    }
    await vscode.env.clipboard.writeText(resumeId);
    void vscode.window.setStatusBarMessage(`$(copy) ${providerLabel(v?.provider ?? 'claude')} session ID copied`, 3000);
  });
  reg('agentSessions.openAgent', (sessionId: string, ownerId: string) => openTab(sessionId, ownerId));
  reg('agentSessions.interrupt', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => v.uiState !== 'done');
    if (id) mgr.interrupt(id);
  });
  reg('agentSessions.stop', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => v.state !== 'exited');
    if (id) mgr.stop(id);
  });
  reg('agentSessions.resume', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => v.state === 'exited');
    if (!id) return;
    mgr.resume(id);
    openTab(id);
  });
  reg('agentSessions.remove', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const v = id && mgr.view(id);
    if (!id || !v) return;
    const ok = await vscode.window.showWarningMessage(
      `Remove "${v.name}" from the list? Its extension event log is deleted; the conversation itself stays in ${providerLabel(v.provider)}.`,
      { modal: true },
      'Remove',
    );
    if (ok !== 'Remove') return;
    closeTabs(id);
    mgr.remove(id);
  });
  reg('agentSessions.archive', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => !v.archived);
    const v = id && mgr.view(id);
    if (!id || !v || v.archived) return;
    if (v.uiState !== 'done' && v.state !== 'exited') {
      const ok = await vscode.window.showWarningMessage(`"${v.name}" is still working. Archiving stops it. Archive anyway?`, { modal: true }, 'Archive');
      if (ok !== 'Archive') return;
    }
    closeTabs(id);
    mgr.archive(id);
    void vscode.window.setStatusBarMessage(`$(archive) ${v.name} archived`, 3000);
  });
  reg('agentSessions.unarchive', async (arg?: unknown) => {
    const id = await pickSession(arg, (v) => Boolean(v.archived));
    if (!id) return;
    mgr.archive(id, false);
    void treeView.reveal(tree.sessionNode(id), { select: true, focus: false });
  });
  reg('agentSessions.showArchived', async () => {
    const archived = mgr.list().filter((v) => v.archived);
    if (!archived.length) {
      void vscode.window.showInformationMessage('No archived conversations.');
      return;
    }
    const items = archived.map((v) => ({
      label: v.name,
      description: `${fmtUsd(v.costUsd)} · ${new Date(v.createdAt).toLocaleDateString()}`,
      detail: v.cwd,
      id: v.id,
      buttons: [{ iconPath: new vscode.ThemeIcon('discard'), tooltip: 'Unarchive' }],
    }));
    const qp = vscode.window.createQuickPick<(typeof items)[number]>();
    qp.items = items;
    qp.placeholder = 'Archived conversations — pick one to open it';
    qp.matchOnDetail = true;
    qp.onDidTriggerItemButton((e) => {
      mgr.archive(e.item.id, false);
      qp.items = qp.items.filter((i) => i.id !== e.item.id);
      if (!qp.items.length) qp.hide();
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      qp.hide();
      if (pick) openTab(pick.id);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });
  reg('agentSessions.rename', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const v = id && mgr.view(id);
    if (!id || !v) return;
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: v.name });
    if (name) mgr.rename(id, name);
  });
  reg('agentSessions.openNative', async (arg?: unknown) => {
    const id = await pickSession(arg);
    const v = id && mgr.view(id);
    if (!id || !v) return;
    if (mgr.isAlive(id)) {
      // Two processes on one session would interleave the transcript.
      const ok = await vscode.window.showWarningMessage(
        `To open "${v.name}" in the native TUI, the process managed by the extension must be stopped first. Continue?`,
        { modal: true },
        'Stop and open',
      );
      if (ok !== 'Stop and open') return;
      await mgr.stopAndWait(id);
    }
    const codex = v.provider === 'codex';
    const st = mgr.stored(id)!;
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    const args = codex ? (st.conversationId ? ['resume', st.conversationId] : []) : ['--resume', id];
    if (st.model) args.push('--model', st.model);
    if (codex) args.push('-c', `model_reasoning_effort="${st.effort ?? 'medium'}"`);
    else args.push('--effort', st.effort ?? 'medium');
    if (codex && st.codexPermissions) {
      args.push('-c', `approval_policy="${st.codexPermissions.approvalPolicy}"`,
        '-c', `approvals_reviewer="${st.codexPermissions.approvalsReviewer ?? 'user'}"`,
        '-c', `sandbox_mode="${st.codexPermissions.sandbox}"`);
    } else if (!codex && st.permissionMode) args.push('--permission-mode', st.permissionMode);
    const t = vscode.window.createTerminal({ name: `${providerLabel(v.provider)} · ${v.name}`, cwd: v.cwd, location: vscode.TerminalLocation.Editor });
    t.sendText([codex ? codexPath : claudePath, ...args].map(quote).join(' '));
    t.show();
  });
  reg('agentSessions.showWaiting', async () => {
    const list = mgr.list();
    const waiting = list.filter((v) => v.uiState === 'waiting');
    const items = (waiting.length ? waiting : list.filter((v) => !v.archived)).map((v) => ({ label: v.name, description: `${stateLabel(v)} · ${fmtUsd(v.costUsd)}`, id: v.id }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: waiting.length ? 'Sessions waiting for you' : 'Sessions' });
    if (pick) openTab(pick.id);
  });
  reg('agentSessions.filter', async () => {
    const pick = await vscode.window.showQuickPick(
      (Object.keys(FILTER_LABEL) as Filter[]).map((f) => ({ label: FILTER_LABEL[f], f, picked: f === tree.filter })),
      { placeHolder: 'Show sessions…' },
    );
    if (!pick) return;
    tree.filter = pick.f;
    tree.refresh();
    refreshChrome();
  });
  const setGroupBy = (g: GroupBy) => vscode.workspace.getConfiguration('agentSessions').update('groupBy', g, vscode.ConfigurationTarget.Global);
  reg('agentSessions.groupByRepository', () => setGroupBy('repository'));
  reg('agentSessions.groupByStatus', () => setGroupBy('status'));
  reg('agentSessions.collapseAll', () => vscode.commands.executeCommand('workbench.actions.treeView.agentSessions.tree.collapseAll'));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('agentSessions')) return;
      const c = config();
      claudePath = resolveExecutable('claude', c.claudePath);
      codexPath = resolveExecutable('codex', c.codexPath);
      mgr.setCommand(claudePath, c.extraArgs);
      mgr.setCodex(codexPath, c.codexExtraArgs, c.codexApprovalPolicy, c.codexSandbox);
      if (e.affectsConfiguration('agentSessions.pricingOverrides')) mgr.setPrices(new PriceTable(c.pricingOverrides));
      if (e.affectsConfiguration('agentSessions.groupBy')) {
        tree.groupBy = c.groupBy;
        tree.refresh();
      }
    }),
  );

  mgr.load();
  refreshChrome();
  return { manager: mgr, openTab, tab: (sessionId: string, owner = MAIN) => panels.get(tabKey(sessionId, owner)), board: () => board, tree };
}

const FILTER_LABEL: Record<Filter, string> = { all: 'All', running: 'Running', waiting: 'Waiting for you', done: 'Done' };

export function deactivate(): Promise<void> | undefined {
  return manager?.dispose();
}
