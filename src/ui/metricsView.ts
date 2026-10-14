import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SessionManager } from '../core/sessionManager';
import { SessionView } from '../core/sessionModel';

/*
 * Layer 3b: what a tree row cannot draw — summary cards, context bar, per-owner cost
 * breakdown with bars. The session total sits on top; the drill-down shows who spent it.
 */

export interface MetricsPayload {
  summary: { active: number; total: number; costUsd: number; tokens: number; agentsRunning: number; waiting: number; unknownCosts?: boolean };
  session?: SessionView;
}

type Inbound =
  | { type: 'open'; sessionId: string }
  | { type: 'openAgent'; sessionId: string; ownerId: string }
  | { type: 'allow'; sessionId: string; requestId: string; always: boolean }
  | { type: 'deny'; sessionId: string; requestId: string }
  | { type: 'answer'; sessionId: string; requestId: string; question: string; label: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'ready' };

export class MetricsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private selected?: string;
  private timer?: NodeJS.Timeout;

  constructor(private readonly manager: SessionManager) {}

  select(sessionId: string | undefined) {
    if (sessionId === this.selected) return;
    this.selected = sessionId;
    this.update(true);
  }

  get selectedId() {
    return this.selected;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage((m: Inbound) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.update(true));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Throttled: at most one post every 300 ms. */
  update(now = false) {
    if (!this.view?.visible) return;
    if (now) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.post();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.post();
    }, 300);
  }

  private post() {
    const list = this.manager.list();
    if (this.selected && !list.some((s) => s.id === this.selected)) this.selected = undefined;
    const payload: MetricsPayload = {
      summary: {
        active: list.filter((s) => s.state !== 'exited').length,
        total: list.length,
        costUsd: list.reduce((a, s) => a + s.costUsd, 0),
        unknownCosts: list.some((s) => s.costAvailable === false),
        tokens: list.reduce((a, s) => a + s.tokens.total, 0),
        agentsRunning: list.reduce((a, s) => a + s.runningAgents, 0),
        waiting: list.filter((s) => s.uiState === 'waiting').length,
      },
      session: this.selected ? this.manager.view(this.selected) : undefined,
    };
    void this.view?.webview.postMessage({ type: 'state', payload, now: Date.now() });
  }

  private onMessage(m: Inbound) {
    switch (m.type) {
      case 'ready':
        return this.update(true);
      case 'open':
        return void vscode.commands.executeCommand('agentSessions.open', m.sessionId);
      case 'openAgent':
        return void vscode.commands.executeCommand('agentSessions.openAgent', m.sessionId, m.ownerId);
      case 'allow':
        this.manager.allow(m.sessionId, m.requestId, m.always);
        return;
      case 'deny':
        this.manager.deny(m.sessionId, m.requestId);
        return;
      case 'answer':
        this.manager.answer(m.sessionId, m.requestId, { [m.question]: m.label });
        return;
      case 'interrupt':
        this.manager.interrupt(m.sessionId);
        return;
    }
  }
}

function html(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--running:var(--vscode-charts-blue);--waiting:var(--vscode-charts-yellow);--done:var(--vscode-charts-green);--opus:var(--vscode-charts-purple);--sonnet:var(--vscode-charts-green);--haiku:var(--vscode-charts-orange);--other:var(--vscode-descriptionForeground)}
body{margin:0;padding:8px 12px 16px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
.k{font-size:11px;color:var(--vscode-descriptionForeground)}
.v{font-variant-numeric:tabular-nums;color:var(--vscode-foreground)}
.summary{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;padding:8px 10px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;margin-bottom:12px}
.summary .v{font-size:15px}
h3{font-size:12px;margin:0 0 6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.chip{font-size:10px;padding:0 5px;border-radius:3px;border:1px solid currentColor;line-height:15px;white-space:nowrap}
.opus{color:var(--opus)}.sonnet{color:var(--sonnet)}.haiku{color:var(--haiku)}.other,.fable{color:var(--other)}
.st{font-size:11px}.st.running{color:var(--running)}.st.waiting{color:var(--waiting)}.st.done{color:var(--done)}.st.exited{color:var(--vscode-disabledForeground)}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;padding:6px 0 10px;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))}
.wide{grid-column:1/-1}
.bar{height:4px;background:var(--vscode-editorWidget-border,#8884);border-radius:2px;margin-top:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--running)}
.bar i.warn{background:var(--waiting)}.bar i.hot{background:var(--vscode-errorForeground)}
.est{font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic}
.breakdown h4{font-size:11px;font-weight:500;color:var(--vscode-descriptionForeground);margin:10px 0 2px}
.legend{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 6px;display:flex;gap:4px 10px;flex-wrap:wrap;align-items:center}
.legend i{display:inline-block;width:10px;height:4px;border-radius:2px;margin-right:4px;vertical-align:middle}
.legend i.opus{background:var(--opus)}.legend i.sonnet{background:var(--sonnet)}.legend i.haiku{background:var(--haiku)}
.row{display:grid;grid-template-columns:1fr auto;gap:2px 8px;width:100%;text-align:left;padding:5px 4px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:3px}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row .lbl{display:flex;flex-direction:column;gap:2px;min-width:0}
.row .lbl b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .sub{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--vscode-descriptionForeground);flex-wrap:wrap}
.row .c{text-align:right;font-variant-numeric:tabular-nums}
.row .c small{display:block;font-size:11px;color:var(--vscode-descriptionForeground)}
.row .bar{grid-column:1/-1;margin-top:0}
.row .bar i.opus{background:var(--opus)}.row .bar i.sonnet{background:var(--sonnet)}.row .bar i.haiku{background:var(--haiku)}.row .bar i.other,.row .bar i.fable{background:var(--other)}
.top{font-size:10px;color:var(--waiting)}
.depth1{padding-left:14px}.depth2{padding-left:26px}.depth3{padding-left:38px}
.pending{margin:10px 0;padding:8px 10px;border:1px solid var(--waiting);border-radius:4px}
.pending code{word-break:break-all}
.btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
button.b{border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:3px 10px;border-radius:2px;cursor:pointer;font:inherit}
button.b.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.empty{color:var(--vscode-descriptionForeground);padding:4px 0}
.err{color:var(--vscode-errorForeground);font-size:11px;margin-top:6px}
.links{display:flex;gap:8px;margin-top:8px}
a{color:var(--vscode-textLink-foreground);cursor:pointer}
</style></head>
<body>
<div class="summary">
  <div title="Sessions whose agent process is alive (running, waiting for you, or idle)"><div class="k">Live sessions</div><div class="v" id="s-active">–</div></div>
  <div><div class="k">Total cost</div><div class="v" id="s-cost">–</div></div>
  <div><div class="k">Total tokens</div><div class="v" id="s-tok">–</div></div>
  <div><div class="k">Subagents running</div><div class="v" id="s-ag">–</div></div>
</div>
<div id="detail"><div class="empty">Select a session to see its metrics and cost breakdown.</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null, skew = 0;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'k' : String(Math.round(n));
const usd = (n) => n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
const dur = (ms) => { const s = Math.max(0, Math.floor(ms/1000)), m = Math.floor(s/60), h = Math.floor(m/60); return h ? h+'h '+(m%60)+'m' : m ? m+'m '+(s%60)+'s' : s+'s'; };
const canon = (id) => String(id || '').toLowerCase().replace(/\\[[^\\]]*\\]$/, '').replace(/-\\d{8}$/, '');
const family = (id) => { const c = canon(id); for (const f of ['fable','opus','sonnet','haiku']) if (c.includes(f)) return f; return 'other'; };
const label = (id) => { const m = /^claude-([a-z]+)-(\\d+)(?:-(\\d+))?$/.exec(canon(id)); if (!m) return id ? canon(id) : '—'; const n = m[1][0].toUpperCase()+m[1].slice(1); return m[3] ? n+' '+m[2]+'.'+m[3] : n+' '+m[2]; };
const chip = (id) => '<span class="chip '+family(id)+'">'+esc(label(id))+'</span>';
const ST = {running:'Running',waiting:'Waiting for you',done:'Done',ready:'Ready',exited:'Ended',completed:'Completed',failed:'Failed',killed:'Stopped'};
const ICON = {running:'⟳',waiting:'⚠',done:'✓',ready:'○',exited:'■',completed:'✓',failed:'✗',killed:'■'};

window.addEventListener('message', (e) => {
  if (e.data.type !== 'state') return;
  state = e.data.payload; skew = Date.now() - e.data.now; render();
});
setInterval(() => { if (state?.session) tick(); }, 1000);

function render() {
  const s = state.summary;
  $('s-active').textContent = s.active + ' of ' + s.total;
  $('s-cost').textContent = usd(s.costUsd) + (s.unknownCosts ? ' (known)' : '');
  $('s-tok').textContent = tok(s.tokens);
  $('s-ag').textContent = String(s.agentsRunning);
  const v = state.session, d = $('detail');
  if (!v) { d.innerHTML = '<div class="empty">Select a session to see its metrics and cost breakdown.</div>'; return; }
  const ui = v.state === 'exited' ? 'exited' : v.uiState === 'done' && v.turns === 0 ? 'ready' : v.uiState;
  const main = v.owners[0];
  const ctx = v.contextPct, cls = ctx >= 85 ? 'hot' : ctx >= 60 ? 'warn' : '';
  let h = '<h3>' + esc(v.name) + ' ' + chip(v.model) + ' <span class="st '+ui+'">'+ICON[ui]+' '+(ST[ui])+'</span></h3>';
  h += '<div class="metrics">'
    + '<div><div class="k">Active for</div><div class="v" id="uptime"></div></div>'
    + '<div><div class="k">Total cost' + (v.costAvailable !== false && v.costIsEstimate ? ' <span class="est" title="' + (v.provider === 'codex' ? 'Token usage priced at Standard API rates; actual billing may differ' : 'Includes an estimate for the part spent after the last completed turn') + '">(estimate)</span>' : '') + '</div><div class="v">' + (v.costAvailable === false ? 'Unavailable' : usd(v.costUsd)) + '</div></div>'
    + '<div><div class="k">Total tokens</div><div class="v" title="input + output + cache write; cache reads shown separately">' + tok(v.tokens.total) + ' <small class="k">+' + tok(v.tokens.cacheRead) + ' cache read</small></div></div>'
    + '<div><div class="k">Turns</div><div class="v">' + v.turns + '</div></div>'
    + '<div class="wide"><div class="k">Context used <span class="est" title="Size of the main conversation\\'s last prompt relative to the model\\'s context window">(estimate)</span></div>'
    + '<div class="v">~' + ctx.toFixed(0) + '%  (' + tok(main.contextTokens) + ' / ' + tok(main.contextWindow) + ')</div><div class="bar"><i class="'+cls+'" style="width:'+ctx+'%"></i></div></div>'
    + '</div>';
  if (v.pending.length) h += pendingHtml(v, v.pending[0]);
  const parts = v.owners, total = parts.reduce((a, o) => a + o.costUsd, 0) || 1;
  const agents = parts.slice(1), max = Math.max(0, ...agents.map((a) => a.costUsd));
  h += '<div class="breakdown"><h4>Cost breakdown' + (agents.length ? ' — the session total includes its subagents' : '') + '</h4>'
    + '<div class="legend"><span title="Each bar is that row\\'s share of this session\\'s total cost">Bar: share of cost</span><span><i class="opus"></i>Opus</span><span><i class="sonnet"></i>Sonnet</span><span><i class="haiku"></i>Haiku</span></div>';
  for (const o of parts) {
    const isMain = o.id === 'main';
    // Under an ended session a subagent is stopped too (shownAgentState in sessionModel.ts).
    const st = isMain ? ui : v.state === 'exited' && o.state !== 'failed' ? 'killed' : o.state;
    const top = agents.length > 1 && !isMain && o.costUsd === max && max > 0;
    const share = o.costUsd / total * 100;
    h += '<button class="row depth' + Math.min(3, o.depth) + '" data-owner="' + esc(o.id) + '">'
      + '<span class="lbl"><b><span class="st '+st+'">' + (ICON[st] || '') + '</span> ' + esc(o.label) + '</b>'
      + '<span class="sub">' + chip(o.model) + (o.agentType ? '<span>' + esc(o.agentType) + '</span>' : '') + (o.background ? '<span>background</span>' : '')
      + (!isMain ? '<span title="This subagent\\'s own context window usage (estimate)">ctx ~' + o.contextPct.toFixed(0) + '%</span>' : '')
      + (top ? '<span class="top">top spender</span>' : '') + '</span></span>'
      + '<span class="c">' + (v.costAvailable === false ? '—' : usd(o.costUsd)) + '<small>' + share.toFixed(0) + '% · ' + tok(o.tokens.total) + ' tokens</small></span>'
      + '<span class="bar" title="' + share.toFixed(0) + '% of this session\\'s cost"><i class="' + family(o.model) + '" style="width:' + share.toFixed(1) + '%"></i></span></button>';
  }
  h += '</div><div class="k" style="margin-top:6px">Per-subagent cost is an estimate: tokens × the rate of the model each message used.</div>';
  if (v.lastError) h += '<div class="err">' + esc(v.lastError) + '</div>';
  h += '<div class="links"><a data-act="open">Open session</a>' + (v.uiState === 'running' && v.state !== 'exited' ? '<a data-act="interrupt">Interrupt</a>' : '') + '</div>';
  d.innerHTML = h;
  tick();
}

function pendingHtml(v, p) {
  if (p.kind === 'question') {
    const qs = p.input?.questions || [];
    if (qs.length === 1 && !qs[0].multiSelect) {
      const q = qs[0];
      return '<div class="pending"><b>? ' + esc(q.question) + '</b><div class="btns">'
        + (q.options || []).map((o) => '<button class="b" data-answer="' + esc(o.label) + '" data-q="' + esc(q.question) + '" data-req="' + esc(p.requestId) + '">' + esc(o.label) + '</button>').join('')
        + '</div></div>';
    }
    return '<div class="pending"><b>The agent is asking you ' + qs.length + ' questions.</b><div class="btns"><button class="b primary" data-act="open">Answer in the tab</button></div></div>';
  }
  const inp = p.input || {};
  const arg = inp.command || inp.file_path || inp.path || inp.pattern || inp.url || '';
  return '<div class="pending"><b>⚠ ' + esc(p.toolName) + '</b>' + (arg ? ' <code>' + esc(String(arg).slice(0, 200)) + '</code>' : '')
    + (p.description ? '<div class="k">' + esc(p.description) + '</div>' : '')
    + '<div class="btns"><button class="b primary" data-allow="' + esc(p.requestId) + '">Allow</button>'
    + (p.suggestions?.length ? '<button class="b" data-always="' + esc(p.requestId) + '">Always allow</button>' : '')
    + '<button class="b" data-deny="' + esc(p.requestId) + '">Deny</button></div></div>';
}

function tick() {
  const v = state.session, el = $('uptime');
  if (!v || !el) return;
  const end = v.endedAt ?? (Date.now() - skew);
  el.textContent = dur(end - v.createdAt) + (v.state === 'exited' ? ' (stopped)' : '');
}

document.addEventListener('click', (e) => {
  const v = state?.session; if (!v) return;
  const t = e.target.closest('button, a'); if (!t) return;
  const sid = v.id;
  if (t.dataset.owner) return vscode.postMessage(t.dataset.owner === 'main' ? { type: 'open', sessionId: sid } : { type: 'openAgent', sessionId: sid, ownerId: t.dataset.owner });
  if (t.dataset.allow) return vscode.postMessage({ type: 'allow', sessionId: sid, requestId: t.dataset.allow, always: false });
  if (t.dataset.always) return vscode.postMessage({ type: 'allow', sessionId: sid, requestId: t.dataset.always, always: true });
  if (t.dataset.deny) return vscode.postMessage({ type: 'deny', sessionId: sid, requestId: t.dataset.deny });
  if (t.dataset.answer) return vscode.postMessage({ type: 'answer', sessionId: sid, requestId: t.dataset.req, question: t.dataset.q, label: t.dataset.answer });
  if (t.dataset.act === 'open') return vscode.postMessage({ type: 'open', sessionId: sid });
  if (t.dataset.act === 'interrupt') return vscode.postMessage({ type: 'interrupt', sessionId: sid });
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
