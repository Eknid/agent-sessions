// Runs inside a real VS Code extension host (see scripts/smoke.sh). Uses the fake claude
// configured in the temp workspace settings, so it is deterministic and free.
import * as assert from 'assert';
import * as vscode from 'vscode';
import type { SessionManager } from '../../src/core/sessionManager';
import type { BoardPanel } from '../../src/ui/boardPanel';
import type { SessionPanel } from '../../src/ui/sessionPanel';
import type { Node, SessionTreeProvider } from '../../src/ui/sessionTree';

interface Api {
  manager: SessionManager;
  openTab: (sessionId: string, owner?: string) => void;
  tab: (sessionId: string, owner?: string) => SessionPanel | undefined;
  board: () => BoardPanel | undefined;
  tree: SessionTreeProvider;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

const chatTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('agentSessions.session'));

export async function run(): Promise<void> {
  const step = (s: string) => console.log('[smoke] ' + s);
  const ext = vscode.extensions.getExtension('eknid-mucollari.agent-sessions');
  assert.ok(ext, 'extension present');
  const api = (await ext!.activate()) as Api;
  step('activated');

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['agentSessions.board', 'agentSessions.newSession', 'agentSessions.newSessionHere', 'agentSessions.copySessionId', 'agentSessions.fork', 'agentSessions.archive', 'agentSessions.showArchived', 'agentSessions.open', 'agentSessions.interrupt', 'agentSessions.resume', 'agentSessions.showWaiting', 'agentSessions.changeCodexModel']) {
    assert.ok(cmds.includes(c), `command ${c}`);
  }
  step('commands registered');

  const mgr = api.manager;
  const cwd = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const id = mgr.create({ cwd, name: 'smoke', prompt: 'please ask permission' });
  await vscode.commands.executeCommand('agentSessions.open', id);
  await until('chat tab opened', () => chatTabs().some((t) => t.label.includes('smoke')));
  const tab = () => api.tab(id)!;
  // `ready` comes from the page script itself: the CSP, marked and session.js all loaded.
  await until('page loaded and asked for its content', () => Boolean(tab()?.ready));
  step('chat tab opened, page ready: ' + chatTabs().map((t) => t.label).join(', '));

  await until('waiting for permission', () => mgr.view(id)?.uiState === 'waiting');
  await vscode.commands.executeCommand('agentSessions.board');
  await until('board loaded', () => Boolean(api.board()?.ready));
  const card = () => api.board()!.cards().find((c) => c.id === id)!;
  assert.equal(card().column, 'waiting');
  assert.equal(card().pending?.summary, 'Bash(echo hi)');
  step('board open, session in "Waiting for you" with its request');
  api.board()!.receive({ type: 'allow', id, requestId: card().pending!.requestId, always: false });
  await until('turn finished after Allow on the board', () => mgr.view(id)?.uiState === 'done');
  assert.ok(mgr.records(id).some((r) => r.dir === 'out' && r.ev.type === 'control_response' && r.ev.response?.response?.behavior === 'allow'));
  assert.equal(card().column, 'done');
  step('allowed from the board card; card moved to "Done"');
  const roots = api.tree.getChildren() as Node[];
  assert.deepEqual(roots.map((n) => (n.kind === 'group' ? n.group : n.kind)), ['running', 'waiting', 'done'], 'sidebar grouped like the board');
  const inGroup = (g: string) => (api.tree.getChildren(roots.find((n) => n.kind === 'group' && n.group === g)) as Node[]).map((n) => n.sessionId);
  assert.ok(inGroup('done').includes(id) && !inGroup('waiting').includes(id), 'session listed under Done');
  assert.equal(api.tree.getParent(api.tree.sessionNode(id))?.kind, 'group', 'reveal walks up to the group');
  step('sidebar: Running / Waiting for you / Done groups, session under Done');
  api.tree.groupBy = 'repository';
  const repos = api.tree.getChildren() as Node[];
  assert.ok(repos.length >= 1 && repos.every((n) => n.kind === 'repo'), 'grouped by repository');
  const inRepo = (api.tree.getChildren(repos[0]) as Node[]).map((n) => n.sessionId);
  assert.ok(inRepo.includes(id), 'session listed under its repository');
  assert.equal(api.tree.getParent(api.tree.sessionNode(id))?.kind, 'repo');
  assert.equal(card().repoName, require('path').basename(cwd), 'board card knows its repository lane');
  api.tree.groupBy = 'status';
  step('sidebar grouped by repository too; board card carries its repository');
  api.board()!.panel.dispose();
  await vscode.commands.executeCommand('agentSessions.open', id);

  const sentUser = () => mgr.records(id).filter((r) => r.dir === 'out' && r.ev.type === 'user').map((r) => r.ev.message.content);
  tab().receive({ type: 'send', text: 'hello from the tab', images: [] });
  await until('second turn', () => (mgr.view(id)?.turns ?? 0) >= 2);
  assert.equal(sentUser().at(-1), 'hello from the tab');
  step('message sent from the tab');

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  tab().receive({ type: 'send', text: 'what is this?', images: [{ mediaType: 'image/png', data: png }, { mediaType: 'text/html', data: 'x' }] });
  await until('image turn', () => (mgr.view(id)?.turns ?? 0) >= 3);
  const withImage = sentUser().at(-1) as { type: string; source?: { media_type: string } }[];
  assert.deepEqual(withImage.map((b) => b.type), ['image', 'text'], 'image first, then text; the non-image was dropped');
  step('image attachment sent as an image block');

  const before = sentUser().length;
  tab().receive({ type: 'send', text: '/doctor', images: [] });
  await sleep(300);
  assert.equal(sentUser().length, before, '/doctor (TUI-only) is not sent to claude');
  step('/doctor refused locally (TUI-only), nothing sent');
  tab().receive({ type: 'send', text: '/exit', images: [] });
  await until('process stopped by /exit', () => mgr.view(id)?.state === 'exited');
  step('/exit stopped the process');
  tab().receive({ type: 'send', text: 'back again', images: [] });
  await until('resumed by typing', () => mgr.isAlive(id) && (mgr.view(id)?.turns ?? 0) >= 4);
  step('typing after /exit resumed the session');

  const t0 = mgr.view(id)!.turns;
  tab().receive({ type: 'send', text: 'please ask permission', images: [] });
  await until('waiting again', () => mgr.view(id)?.uiState === 'waiting');
  tab().receive({ type: 'send', text: 'queued one', images: [] });
  tab().receive({ type: 'send', text: 'queued two', images: [] });
  assert.deepEqual(mgr.queue(id).map((q) => q.text), ['queued one', 'queued two']);
  assert.equal(sentUser().at(-1), 'please ask permission', 'queued messages wait for the turn to end');
  tab().receive({ type: 'unqueue', id: mgr.queue(id)[1].id });
  tab().receive({ type: 'allow', requestId: mgr.view(id)!.pending[0].requestId, always: false });
  await until('queued message sent after the turn', () => mgr.view(id)!.turns >= t0 + 2 && mgr.view(id)!.uiState === 'done');
  assert.equal(sentUser().at(-1), 'queued one');
  assert.equal(mgr.queue(id).length, 0);
  step('sent while Claude worked: queued, one removed with the trash, the other sent after the turn');

  tab().panel.dispose();
  await until('tab closed', () => !chatTabs().some((t) => t.label.includes('smoke')));
  assert.ok(mgr.isAlive(id), 'process survives closing the tab');
  step('tab closed, process still alive');

  api.openTab(id);
  await until('tab reopened and ready', () => Boolean(api.tab(id)?.ready));
  step('tab reopened (history replayed from the event log)');

  mgr.send(id, 'spawn an agent');
  await until('agent turn', () => (mgr.view(id)?.owners.length ?? 0) >= 2);
  const v = mgr.view(id)!;
  const row = api.tree.getTreeItem(api.tree.sessionNode(id));
  assert.equal(row.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'a session with subagents starts folded');
  step('session with a subagent is folded in the sidebar');
  tab().receive({ type: 'openAgent', ownerId: v.owners[1].id });
  await until('agent tab ready', () => Boolean(api.tab(id, v.owners[1].id)?.ready));
  step('subagent tab opened from the transcript link');

  const codex = mgr.create({ cwd, provider: 'codex', model: 'gpt-6.1-sol', name: 'Codex smoke', prompt: 'permission' });
  api.openTab(codex);
  await until('Codex tab ready and waiting', () => Boolean(api.tab(codex)?.ready) && mgr.view(codex)?.uiState === 'waiting');
  await vscode.commands.executeCommand('workbench.action.keepEditor');
  await vscode.commands.executeCommand('agentSessions.board');
  await until('Codex board ready', () => Boolean(api.board()?.ready));
  await vscode.commands.executeCommand('workbench.action.keepEditor');
  assert.equal(mgr.view(codex)?.provider, 'codex');
  const codexCard = () => api.board()!.cards().find((c) => c.id === codex)!;
  assert.ok(codexCard().model.startsWith('Codex'));
  api.board()!.receive({ type: 'allow', id: codex, requestId: codexCard().pending!.requestId, always: false });
  await until('Codex turn completed through board approval', () => mgr.view(codex)?.turns === 1);
  assert.equal(codexCard().cost, '~<$0.01');
  assert.equal(mgr.view(codex)?.costIsEstimate, true);
  assert.ok(Math.abs(mgr.view(codex)!.costUsd - 0.000262) < 1e-12);
  api.tab(codex)!.panel.dispose();
  assert.ok(mgr.isAlive(codex), 'Codex process survives closing its tab');
  api.openTab(codex);
  await until('Codex history replayed in reopened tab', () => Boolean(api.tab(codex)?.ready));
  const originalThread = mgr.stored(codex)!.conversationId;
  await mgr.changeCodexModel(codex, 'gpt-6-sol');
  await until('Codex changed model shown in board', () => codexCard().model.includes('gpt-6-sol'));
  assert.equal(mgr.stored(codex)!.conversationId, originalThread);
  api.tab(codex)!.receive({ type: 'send', text: 'after model change', images: [] });
  await until('Codex chat works after model change', () => mgr.view(codex)?.turns === 2);
  assert.equal(mgr.view(codex)!.model, 'gpt-6-sol');
  step('Codex chat, board approval, metrics and tab reopening work');
  step('Codex model change preserves the native thread and updates the open UI');
  const codexTab = api.tab(codex)!;
  codexTab.receive({ type: 'send', text: '/goal Fix the failing build', images: [] });
  await until('goal created through the chat tab', () => (codexTab as any).localSeq > 0);
  assert.match(await mgr.codexCommand(codex, 'goal'), /Fix the failing build/);
  codexTab.receive({ type: 'send', text: '/goal pause', images: [] });
  await until('goal pause acknowledged', () => (codexTab as any).localSeq > 1);
  assert.match(await mgr.codexCommand(codex, 'goal'), /Status: paused/);
  codexTab.receive({ type: 'send', text: '/goal clear', images: [] });
  await until('goal clear acknowledged', () => (codexTab as any).localSeq > 2);
  assert.match(await mgr.codexCommand(codex, 'goal'), /No active goal/);
  codexTab.receive({ type: 'send', text: '/test-plugin:remote-skill inspect this project', images: [] });
  await until('plugin skill sent through chat', () => mgr.view(codex)?.turns === 3);
  assert.equal(mgr.stored(codex)!.conversationId, originalThread);
  step('Codex native goal controls and plugin skills work through the chat tab');

  await mgr.changeEffort(codex, 'high');
  assert.equal((codexTab as any).state().effort, 'high');
  await mgr.refreshUsage(codex, true);
  assert.equal((codexTab as any).state().accountUsage.label, 'Usage left primary 77%');
  step('Chat state exposes editable effort and native account usage');
  await mgr.changePermissions(id, 'auto');
  assert.equal((tab() as any).state().permissions.label, 'Auto mode');
  await mgr.changePermissions(codex, 'auto');
  assert.equal((codexTab as any).state().permissions.label, 'Approve for me');
  assert.equal(mgr.stored(codex)!.conversationId, originalThread);
  assert.ok((codexTab as any).commands().some((c: any) => c.name === 'permissions' && c.kind === 'local'));
  step('Claude Auto mode and Codex Approve for me update the chat control and retain the conversation');

  // Exercise the panel's real dictation wiring with synthetic audio; never open a microphone.
  const voiceMessages: any[] = [];
  const webview = codexTab.panel.webview as any;
  const originalPost = webview.postMessage.bind(webview);
  webview.postMessage = (message: any) => { if (message.type === 'voice') voiceMessages.push(message); return originalPost(message); };
  let delivered = false;
  let read: ((value: unknown) => void) | undefined;
  const helpers = [
    vscode.commands.registerCommand('_codex.microphone.available', () => 1),
    vscode.commands.registerCommand('_codex.microphone.start', () => ({ status: 'started', sampleRate: 16000 })),
    vscode.commands.registerCommand('_codex.microphone.read', () => {
      if (!delivered) { delivered = true; return { status: 'audio', pcm: Buffer.alloc(32000).toString('base64') }; }
      return new Promise((resolve) => { read = resolve; });
    }),
    vscode.commands.registerCommand('_codex.microphone.stop', () => read?.({ status: 'stopped' })),
    vscode.commands.registerCommand('_codex.microphone.cancel', () => undefined),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ text: 'Prova vocale nella bozza.' }), { status: 200 });
  try {
    const turns = mgr.view(codex)!.turns;
    codexTab.receive({ type: 'voice' });
    await until('dictation recording', () => !!read && voiceMessages.some((m) => m.state === 'recording'));
    codexTab.receive({ type: 'voice' });
    await until('voice text delivered to chat draft', () => voiceMessages.some((m) => m.text === 'Prova vocale nella bozza.'));
    assert.equal(mgr.view(codex)!.turns, turns, 'Dictation must not auto-send a model prompt');
  } finally { globalThis.fetch = originalFetch; webview.postMessage = originalPost; helpers.forEach((d) => d.dispose()); }
  step('Voice button records, stops and returns a transcription without auto-sending');

  await vscode.commands.executeCommand('workbench.view.extension.agentSessions');
  await sleep(500);
  step('sidebar shown');
  // SMOKE_HOLD_MS keeps the window up, e.g. to take a screenshot of it.
  const hold = Number(process.env.SMOKE_HOLD_MS || 0);
  if (hold) await sleep(hold);

  await mgr.dispose();
  step('OK');
}
