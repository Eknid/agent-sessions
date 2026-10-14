import * as vscode from 'vscode';
import { fmtDuration, fmtSessionCost, fmtTokens, fmtUsd } from '../core/format';
import { modelLabel } from '../core/pricing';
import { SessionManager } from '../core/sessionManager';
import { repoLabels, repoOf, repoOrder } from '../core/repo';
import { groupOf, groupOrder, MAIN, OwnerView, SessionView, shownAgentState, UiState } from '../core/sessionModel';

/*
 * Layer 3: sessions grouped by status as on the board (Running / Waiting for you / Done) or by
 * repository, then Archived; each session folded with its subagents inside.
 * Native TreeView: free a11y, keyboard, menus.
 */

export type GroupBy = 'status' | 'repository';

export type Filter = 'all' | UiState;

export type Node =
  | { kind: 'group'; group: UiState; sessionId: '' }
  | { kind: 'repo'; root: string; sessionId: '' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'agent'; sessionId: string; ownerId: string }
  /** The "Archived" group at the end of the list. */
  | { kind: 'archive'; sessionId: '' };

const ARCHIVE: Node = { kind: 'archive', sessionId: '' };
const GROUPS: UiState[] = ['running', 'waiting', 'done'];
const GROUP_NODE = Object.fromEntries(GROUPS.map((g) => [g, { kind: 'group', group: g, sessionId: '' }])) as Record<UiState, Node>;
const GROUP_ICON: Record<UiState, vscode.ThemeIcon> = {
  running: new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.blue')),
  waiting: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow')),
  done: new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green')),
};

export const STATE_LABEL: Record<string, string> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Done',
  ready: 'Ready',
  exited: 'Ended',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Stopped',
};

export function sessionIcon(v: SessionView): vscode.ThemeIcon {
  if (v.state === 'exited') return new vscode.ThemeIcon(v.lastError ? 'error' : 'circle-slash', new vscode.ThemeColor(v.lastError ? 'errorForeground' : 'disabledForeground'));
  if (v.uiState === 'waiting') return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.yellow'));
  if (v.uiState === 'running') return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
  if (v.turns === 0) return new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('charts.blue'));
  return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
}

function agentIcon(v: SessionView, o: OwnerView): vscode.ThemeIcon {
  switch (shownAgentState(v, o)) {
    case 'running':
      return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'));
    case 'completed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    default:
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
  }
}

export function stateLabel(v: SessionView): string {
  if (v.state === 'exited') return STATE_LABEL.exited;
  if (v.uiState === 'waiting') return v.waitReason === 'question' ? 'Asking you a question' : 'Needs permission';
  // Nothing sent yet: the process is up and waiting for its first message.
  if (v.uiState === 'done' && v.turns === 0 && v.state !== 'running') return STATE_LABEL.ready;
  return STATE_LABEL[v.uiState];
}

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private nodes = new Map<string, Node>();
  private pendingRefresh = new Set<string>();
  /** Group each session was last drawn in; moving between groups needs a root refresh. */
  private drawnIn = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private repoNodes = new Map<string, Node>();
  filter: Filter = 'all';
  groupBy: GroupBy = 'status';

  constructor(private readonly manager: SessionManager) {}

  sessionNode(sessionId: string): Node {
    let n = this.nodes.get(sessionId);
    if (!n) this.nodes.set(sessionId, (n = { kind: 'session', sessionId }));
    return n;
  }

  private agentNode(sessionId: string, ownerId: string): Node {
    const key = `${sessionId}/${ownerId}`;
    let n = this.nodes.get(key);
    if (!n) this.nodes.set(key, (n = { kind: 'agent', sessionId, ownerId }));
    return n;
  }

  /** Coalesce bursts of stream events into one refresh per session every 250 ms. */
  refresh(sessionId?: string) {
    this.pendingRefresh.add(sessionId ?? '*');
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ids = [...this.pendingRefresh];
      this.pendingRefresh.clear();
      if (ids.includes('*')) return this.emitter.fire(undefined);
      for (const id of ids) {
        // A session that appeared, left the filter or changed group needs a root refresh.
        const v = this.manager.view(id);
        if (!v || this.drawnIn.get(id) !== this.placeOf(v)) return this.emitter.fire(undefined);
        this.emitter.fire(this.sessionNode(id));
      }
    }, 250);
  }

  private placeOf(v: SessionView): string {
    if (v.archived) return 'archive';
    // By repository the status still decides the order inside the group.
    return this.groupBy === 'repository' ? `${repoOf(v.cwd).root}\0${groupOf(v)}` : groupOf(v);
  }

  private repoNode(root: string): Node {
    let n = this.repoNodes.get(root);
    if (!n) this.repoNodes.set(root, (n = { kind: 'repo', root, sessionId: '' }));
    return n;
  }

  /** Not archived, passing the status filter. */
  private live(): SessionView[] {
    return this.manager.list().filter((v) => !v.archived && (this.filter === 'all' || groupOf(v) === this.filter));
  }

  /** Repositories with their sessions: waiting first (longest first), then running, then done. */
  private repos(): { root: string; label: string; sessions: SessionView[] }[] {
    const by = new Map<string, SessionView[]>();
    for (const v of this.live()) {
      const root = repoOf(v.cwd).root;
      by.set(root, [...(by.get(root) ?? []), v]);
    }
    const labels = repoLabels(by.keys());
    const rank: Record<UiState, number> = { waiting: 0, running: 1, done: 2 };
    return [...by.entries()]
      .map(([root, sessions]) => ({
        root,
        label: labels.get(root) ?? root,
        sessions: sessions.sort((a, b) => rank[groupOf(a)] - rank[groupOf(b)] || groupOrder(groupOf(a))(a, b)),
        waiting: sessions.filter((v) => groupOf(v) === 'waiting').length,
        running: sessions.filter((v) => groupOf(v) === 'running').length,
        latest: Math.max(...sessions.map((v) => v.updatedAt || v.createdAt)),
      }))
      .sort(repoOrder);
  }

  private shownGroups(): UiState[] {
    return this.filter === 'all' ? GROUPS : [this.filter];
  }

  private inGroup(group: UiState): SessionView[] {
    return this.manager.list().filter((v) => !v.archived && groupOf(v) === group).sort(groupOrder(group));
  }

  private archived(): SessionView[] {
    return this.manager.list().filter((v) => v.archived);
  }

  private sessionNodes(views: SessionView[]): Node[] {
    for (const v of views) this.drawnIn.set(v.id, this.placeOf(v));
    return views.map((v) => this.sessionNode(v.id));
  }

  getChildren(el?: Node): Node[] {
    if (!el) {
      // No sessions at all: an empty tree shows the welcome view (New Session / Resume…).
      if (!this.manager.list().length) return [];
      const groups = this.groupBy === 'repository' ? this.repos().map((r) => this.repoNode(r.root)) : this.shownGroups().map((g) => GROUP_NODE[g]);
      return this.filter === 'all' && this.archived().length ? [...groups, ARCHIVE] : groups;
    }
    if (el.kind === 'group') return this.sessionNodes(this.inGroup(el.group));
    if (el.kind === 'repo') return this.sessionNodes(this.repos().find((r) => r.root === el.root)?.sessions ?? []);
    if (el.kind === 'archive') return this.sessionNodes(this.archived());
    const v = this.manager.view(el.sessionId);
    if (!v) return [];
    const parent = el.kind === 'session' ? MAIN : el.ownerId;
    return v.owners.filter((o) => o.id !== MAIN && o.parentId === parent).map((o) => this.agentNode(v.id, o.id));
  }

  getParent(el: Node): Node | undefined {
    if (el.kind === 'archive' || el.kind === 'group' || el.kind === 'repo') return undefined;
    if (el.kind === 'session') {
      const v = this.manager.view(el.sessionId);
      if (!v) return undefined;
      if (v.archived) return ARCHIVE;
      return this.groupBy === 'repository' ? this.repoNode(repoOf(v.cwd).root) : GROUP_NODE[groupOf(v)];
    }
    const o = this.manager.view(el.sessionId)?.owners.find((x) => x.id === el.ownerId);
    return !o?.parentId || o.parentId === MAIN ? this.sessionNode(el.sessionId) : this.agentNode(el.sessionId, o.parentId);
  }

  getTreeItem(el: Node): vscode.TreeItem {
    if (el.kind === 'archive') return this.archiveItem();
    if (el.kind === 'group') return this.groupItem(el.group);
    if (el.kind === 'repo') return this.repoItem(el.root);
    const v = this.manager.view(el.sessionId);
    if (!v) return new vscode.TreeItem('?');
    return el.kind === 'session' ? this.sessionItem(v) : this.agentItem(v, el.ownerId);
  }

  private groupItem(group: UiState): vscode.TreeItem {
    const n = this.inGroup(group).length;
    const item = new vscode.TreeItem(STATE_LABEL[group], n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = `group:${group}`;
    item.iconPath = GROUP_ICON[group];
    item.description = String(n);
    item.contextValue = `group.${group}`;
    return item;
  }

  private repoItem(root: string): vscode.TreeItem {
    const r = this.repos().find((x) => x.root === root);
    const item = new vscode.TreeItem(r?.label ?? root, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `repo:${root}`;
    item.iconPath = new vscode.ThemeIcon('repo');
    const count = (g: UiState) => r?.sessions.filter((v) => groupOf(v) === g).length ?? 0;
    item.description = (['waiting', 'running', 'done'] as UiState[]).filter((g) => count(g)).map((g) => `${count(g)} ${g}`).join(' · ');
    item.tooltip = root;
    item.contextValue = 'repo';
    return item;
  }

  private archiveItem(): vscode.TreeItem {
    const n = this.archived().length;
    const item = new vscode.TreeItem('Archived', vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'archive';
    item.iconPath = new vscode.ThemeIcon('archive');
    item.description = `${n} conversation${n === 1 ? '' : 's'}`;
    item.tooltip = 'Archived conversations: open one to read it, or write to it to bring it back.';
    item.contextValue = 'archive';
    return item;
  }

  private sessionItem(v: SessionView): vscode.TreeItem {
    const agents = v.owners.length - 1;
    // Folded by default: subagents show only when you unfold the session.
    const item = new vscode.TreeItem(v.name, agents ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    // A new id scheme, so rows VS Code remembers as unfolded from before start folded too.
    item.id = `s:${v.id}`;
    item.iconPath = sessionIcon(v);
    const sub = agents ? ` · ${agents} subagent${agents > 1 ? 's' : ''}${v.runningAgents ? `, ${v.runningAgents} running` : ''}` : '';
    item.description = `${v.provider === 'codex' ? 'Codex · ' : ''}${stateLabel(v)}${sub} · ${fmtSessionCost(v)} · ${modelLabel(v.model)}`;
    const forkable = this.manager.canFork(v.id) ? '.forkable' : '';
    item.contextValue = v.archived ? `archived${forkable}` : `session.${v.state === 'exited' ? 'exited' : v.state}${forkable}${v.provider === 'codex' ? '.codex' : ''}`;
    item.command = { command: 'agentSessions.open', title: 'Open', arguments: [v.id] };
    item.tooltip = sessionTooltip(v);
    return item;
  }

  private agentItem(v: SessionView, ownerId: string): vscode.TreeItem {
    const o = v.owners.find((x) => x.id === ownerId);
    if (!o) return new vscode.TreeItem('?');
    const hasChildren = v.owners.some((x) => x.parentId === ownerId);
    const item = new vscode.TreeItem(o.label, hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `s:${v.id}/${o.id}`;
    item.iconPath = agentIcon(v, o);
    const agents = v.owners.filter((x) => x.id !== MAIN);
    const top = agents.length > 1 && agents.every((x) => x.costUsd <= o.costUsd) ? ' · top spender' : '';
    const bg = o.background ? ' · bg' : '';
    item.description = `${o.agentType ?? ''}${bg} · ${modelLabel(o.model)} · ${fmtTokens(o.tokens.total)} · ${fmtUsd(o.costUsd)}${top}`;
    item.contextValue = 'agent';
    item.command = { command: 'agentSessions.openAgent', title: 'Open', arguments: [v.id, o.id] };
    const md = new vscode.MarkdownString();
    const shown = shownAgentState(v, o);
    const outcome = shown !== o.state ? ` (session ended; the subagent had ${STATE_LABEL[o.state]?.toLowerCase() ?? o.state})` : '';
    md.appendMarkdown(`**${o.label}**  \n${STATE_LABEL[shown] ?? shown}${outcome} · ${o.agentType ?? 'subagent'}${o.background ? ' · background' : ''}\n\n`);
    md.appendMarkdown(`Model: ${o.modelsSeen.map(modelLabel).join(', ') || modelLabel(o.model)}  \n`);
    md.appendMarkdown(`Tokens: ${fmtTokens(o.tokens.total)} (+${fmtTokens(o.tokens.cacheRead)} cache read)  \n`);
    md.appendMarkdown(`Cost (estimate): ${fmtUsd(o.costUsd)}  \n`);
    md.appendMarkdown(`Context (estimate): ~${o.contextPct.toFixed(0)}% (${fmtTokens(o.contextTokens)} / ${fmtTokens(o.contextWindow)})`);
    if (o.startedAt) md.appendMarkdown(`  \nDuration: ${fmtDuration((o.endedAt ?? Date.now()) - o.startedAt)}`);
    if (o.summary) md.appendMarkdown(`\n\n---\n${o.summary.slice(0, 500)}`);
    item.tooltip = md;
    return item;
  }
}

export function sessionTooltip(v: SessionView): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${v.name}**  \n\`${v.cwd}\`\n\n`);
  md.appendMarkdown(`${stateLabel(v)}${v.exitInfo ? ` (${v.exitInfo})` : ''}  \n`);
  md.appendMarkdown(`Active for: ${fmtDuration((v.endedAt ?? Date.now()) - v.createdAt)}  \n`);
  md.appendMarkdown(`Cost: ${fmtSessionCost(v)}${v.costAvailable !== false && v.costIsEstimate ? (v.provider === 'codex' ? ' (Standard API estimate)' : ' (partly estimated)') : ''}  \n`);
  md.appendMarkdown(`Tokens: ${fmtTokens(v.tokens.total)} (+${fmtTokens(v.tokens.cacheRead)} cache read)  \n`);
  md.appendMarkdown(`Context (estimate): ~${v.contextPct.toFixed(0)}%  \n`);
  md.appendMarkdown(`Model: ${modelLabel(v.model)} · turns: ${v.turns}`);
  if (v.lastError) md.appendMarkdown(`\n\n$(error) ${v.lastError}`);
  md.supportThemeIcons = true;
  return md;
}
