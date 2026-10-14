// Renders the metrics webview outside VS Code with real reducer output from the fixtures,
// so the HTML/JS can be checked in a browser. Usage: node scripts/preview-metrics.js > out/preview.html
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Minimal `vscode` stub: metricsView only needs Webview.cspSource at render time.
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return {};
  return origLoad.call(this, req, ...rest);
};

const out = path.join(__dirname, '..', 'out');
const { MetricsViewProvider } = require(path.join(out, 'src/ui/metricsView'));
const { SessionModel } = require(path.join(out, 'src/core/sessionModel'));
const { PriceTable } = require(path.join(out, 'src/core/pricing'));

function model(fixture, name, stopBefore) {
  const m = new SessionModel({ id: name, name, cwd: '~/repos/' + name, createdAt: Date.now() - 42 * 60000 }, new PriceTable());
  const lines = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', fixture), 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const r = JSON.parse(l);
    if (stopBefore && stopBefore(r)) break;
    m.apply(r);
  }
  return m.view();
}

// One session parked on a permission request, so the pending block renders too.
let seenPerm = false;
const waiting = model('03-forwarded-subagent-permission.ndjson', 'feature-store-ingestion', (r) => {
  if (seenPerm) return true;
  if (r.ev.type === 'control_request') seenPerm = true;
  return false;
});

// Grab the HTML the provider would install.
let html = '';
const provider = new MetricsViewProvider({ list: () => [], view: () => undefined });
provider.resolveWebviewView({
  webview: {
    cspSource: 'self',
    set options(_v) {},
    set html(v) { html = v; },
    onDidReceiveMessage() {},
    postMessage() {},
  },
  onDidChangeVisibility() {},
  onDidDispose() {},
  visible: false,
});

const payload = {
  summary: { active: 3, total: 4, costUsd: 6.42, tokens: 412300, agentsRunning: 2, waiting: 1 },
  session: waiting,
};
const theme = `<style>
body{background:#252526}
:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#8b8b8b;--vscode-font-family:-apple-system,system-ui,sans-serif;--vscode-font-size:13px;
--vscode-charts-blue:#3794ff;--vscode-charts-yellow:#e2b714;--vscode-charts-green:#89d185;--vscode-charts-purple:#c586c0;--vscode-charts-orange:#dcaa6c;
--vscode-widget-border:#3c3c3c;--vscode-list-hoverBackground:#2a2d2e;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-errorForeground:#f14c4c;--vscode-textLink-foreground:#3794ff;--vscode-disabledForeground:#6f6f6f}
</style>`;
const stub = `<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__posted.push(m); if (m.type === 'ready') setTimeout(() => window.postMessage({ type: 'state', payload: ${JSON.stringify(payload)}, now: Date.now() }, '*'), 0); } });
window.addEventListener('error', (e) => { document.title = 'JS ERROR: ' + e.message; });
</script>`;
html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace('<head>', '<head>' + theme + stub)
  .replace(/<body>/, '<body style="width:330px">');
process.stdout.write(html);
