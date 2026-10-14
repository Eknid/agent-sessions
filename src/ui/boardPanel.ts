import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { fmtSessionCost } from '../core/format';
import { modelLabel } from '../core/pricing';
import { repoLabels, repoOf } from '../core/repo';
import { SessionManager } from '../core/sessionManager';
import { groupOf, SessionView } from '../core/sessionModel';
import { toolSummary } from '../core/transcript';
import { stateLabel } from './sessionTree';

/*
 * The board: every tracked (not archived) session as a card in one of three columns —
 * Running, Waiting for you, Done — in one lane per repository (or one flat lane). One tab
 * for the whole window; it only reads the manager and sends the same commands the sidebar does.
 */

export const BOARD_VIEW_TYPE = 'agentSessions.board';

export type Column = 'running' | 'waiting' | 'done';

export interface Card {
  id: string;
  name: string;
  column: Column;
  /** Finer state inside the column, e.g. Ready / Ended in Done. */
  label: string;
  sub: 'ready' | 'ended' | 'error' | '';
  folder: string;
  cwd: string;
  /** Repository lane: git root of the cwd (see core/repo.ts), its name, and the cwd inside it. */
  repo: string;
  repoName: string;
  subdir: string;
  model: string;
  cost: string;
  costUsd: number;
  contextPct: number;
  agents: number;
  runningAgents: number;
  turns: number;
  updatedAt: number;
  error?: string;
  pending?: { requestId: string; kind: 'permission' | 'question'; summary: string; canAlways: boolean };
}

export const columnOf: (v: SessionView) => Column = groupOf;

export function toCard(v: SessionView): Card {
  const p = v.pending[0];
  const column = columnOf(v);
  const repo = repoOf(v.cwd);
  return {
    id: v.id,
    name: v.name,
    column,
    label: stateLabel(v),
    sub: v.state === 'exited' ? (v.lastError ? 'error' : 'ended') : column === 'done' && v.turns === 0 ? 'ready' : '',
    folder: path.basename(v.cwd),
    cwd: v.cwd,
    repo: repo.root,
    repoName: repo.name,
    subdir: repo.subdir,
    model: `${v.provider === 'codex' ? 'Codex · ' : ''}${modelLabel(v.model)}`,
    cost: fmtSessionCost(v),
    costUsd: v.costUsd,
    contextPct: v.contextPct,
    agents: v.owners.length - 1,
    runningAgents: v.runningAgents,
    turns: v.turns,
    updatedAt: v.updatedAt || v.createdAt,
    error: v.lastError,
    pending:
      p && column === 'waiting'
        ? {
            requestId: p.requestId,
            kind: p.kind,
            summary: p.kind === 'question' ? String(p.input?.questions?.[0]?.question ?? 'Claude has a question') : toolSummary(p.toolName ?? 'tool', p.input),
            canAlways: Boolean(p.suggestions?.length),
          }
        : undefined,
  };
}

/** Two repositories with the same folder name get told apart by their parent folder. */
export function withRepoLabels(cards: Card[]): Card[] {
  const labels = repoLabels(cards.map((c) => c.repo));
  for (const c of cards) c.repoName = labels.get(c.repo) ?? c.repoName;
  return cards;
}

type Inbound =
  | { type: 'ready' }
  | { type: 'open'; id: string }
  | { type: 'allow'; id: string; requestId: string; always: boolean }
  | { type: 'deny'; id: string; requestId: string }
  | { type: 'interrupt'; id: string }
  | { type: 'resume'; id: string }
  | { type: 'archive'; id: string }
  | { type: 'newSession' };

export class BoardPanel {
  private timer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  ready = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly manager: SessionManager,
    private readonly extensionUri: vscode.Uri,
    private readonly onClosed: () => void,
  ) {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')] };
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'resources', 'board-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'resources', 'board-dark.svg'),
    };
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m: Inbound) => this.receive(m), undefined, this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    const update = () => this.schedule();
    manager.on('changed', update);
    manager.on('listChanged', update);
    this.disposables.push({ dispose: () => (manager.off('changed', update), manager.off('listChanged', update)) });
  }

  reveal() {
    this.panel.reveal(undefined, false);
  }

  cards(): Card[] {
    return withRepoLabels(this.manager.list().filter((v) => !v.archived).map(toCard));
  }

  private dispose() {
    clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.onClosed();
  }

  private schedule() {
    if (!this.ready || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.post();
    }, 150);
  }

  private post() {
    const archived = this.manager.list().filter((v) => v.archived).length;
    void this.panel.webview.postMessage({ type: 'cards', cards: this.cards(), archived, now: Date.now() });
  }

  /** A message from the page (public so the smoke test can act like the page). */
  receive(m: Inbound) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        return this.post();
      case 'open':
        return void vscode.commands.executeCommand('agentSessions.open', m.id);
      case 'allow': {
        const p = this.manager.view(m.id)?.pending.find((r) => r.requestId === m.requestId);
        this.manager.allow(m.id, m.requestId, Boolean(m.always && p?.suggestions?.length));
        return;
      }
      case 'deny':
        this.manager.deny(m.id, m.requestId);
        return;
      case 'interrupt':
        this.manager.interrupt(m.id);
        return;
      case 'resume':
        return void vscode.commands.executeCommand('agentSessions.resume', m.id);
      case 'archive':
        return void vscode.commands.executeCommand('agentSessions.archive', m.id);
      case 'newSession':
        return void vscode.commands.executeCommand('agentSessions.newSession');
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const res = (...p: string[]) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', ...p)).toString();
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${res('board', 'board.css')}">
</head>
<body>
<header id="top"></header>
<main id="board"></main>
<script nonce="${nonce}" src="${res('board', 'board.js')}"></script>
</body></html>`;
  }
}
