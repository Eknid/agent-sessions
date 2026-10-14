// Renders the sessions board outside VS Code, so its HTML/CSS/JS can be checked in a browser.
// Usage (after `npx tsc -p .`): node scripts/preview-board.js [storageDir] > out/preview-board.html
// storageDir is the extension's global storage (sessions.json + logs/); it is only read.
// Two fixture sessions are added, one running and one waiting on a permission.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  // Only what modules build at load time (sessionTree's group icons).
  if (req === 'vscode') return { ThemeIcon: class {}, ThemeColor: class {} };
  return origLoad.call(this, req, ...rest);
};
const root = path.join(__dirname, '..');
const { SessionModel } = require(path.join(root, 'out/src/core/sessionModel'));
const { PriceTable } = require(path.join(root, 'out/src/core/pricing'));
const { toCard, withRepoLabels } = require(path.join(root, 'out/src/ui/boardPanel'));

const prices = new PriceTable();
const readLog = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function view(meta, records, until) {
  const m = new SessionModel(meta, prices);
  for (const r of records) {
    if (until && until(r)) break;
    m.apply(r);
  }
  const v = m.view();
  if (meta.archived) v.archived = true;
  return v;
}

const views = [];
const dir = process.argv[2];
if (dir) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
  for (const s of index) {
    const log = path.join(dir, 'logs', s.id + '.ndjson');
    if (fs.existsSync(log)) views.push(view({ ...s, requestedModel: s.model }, readLog(log)));
  }
}
const fx = (f) => readLog(path.join(root, 'test/fixtures', f));
const now = Date.now();
let seen = false;
views.push(view({ id: 'w', name: 'Feature store ingestion', cwd: '/repos/feature-store', createdAt: now - 3600e3 }, fx('03-forwarded-subagent-permission.ndjson'), (r) => {
  if (seen) return true;
  if (r.ev.type === 'control_request') seen = true;
  return false;
}));
views.push(view({ id: 'r', name: 'dbt model refactor', cwd: '/repos/di_transform_dbt', createdAt: now - 600e3 }, fx('02-background-subagent.ndjson').slice(0, 12)));
// Fixture timestamps are old; make the synthetic ones look recent.
views.slice(-2).forEach((v, i) => (v.updatedAt = now - (i + 1) * 90e3));

const cards = withRepoLabels(views.filter((v) => !v.archived).map(toCard));
const archived = views.filter((v) => v.archived).length;
const theme = {
  'foreground': '#cccccc', 'descriptionForeground': '#9d9d9d', 'editor-background': '#1f1f1f', 'widget-border': '#313131',
  'editorWidget-background': '#202020', 'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
  'focusBorder': '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
  'charts-blue': '#3794ff', 'charts-yellow': '#cca700', 'charts-green': '#89d185', 'errorForeground': '#f85149',
  'font-family': '-apple-system, BlinkMacSystemFont, sans-serif', 'font-size': '13px', 'editor-font-family': 'Menlo, monospace',
};
const vars = Object.entries(theme).map(([k, v]) => `--vscode-${k}:${v}`).join(';');
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../resources/board/board.css"><style>html{${vars}}</style></head><body>
<header id="top"></header><main id="board"></main>
<script>
const MSG = ${JSON.stringify({ type: 'cards', cards, archived, now }).replace(/</g, '\\u003c')};
// #state={...} starts the page with that saved state, e.g. folded lanes or columns.
const START = (() => { try { return JSON.parse(decodeURIComponent((location.hash.match(/state=([^&]+)/) || [])[1] || 'null')); } catch { return null; } })();
window.acquireVsCodeApi = () => ({ getState() { return START; }, setState() {}, postMessage(m) { console.log('[to extension]', JSON.stringify(m)); if (m.type === 'ready') setTimeout(() => window.postMessage(MSG, '*')); } });
</script>
<script src="../resources/board/board.js"></script>
<script>
// #hover shows every card's hover actions, for screenshots.
if (location.hash.includes('hover')) document.head.insertAdjacentHTML('beforeend', '<style>.card.has-acts .acts{display:flex}.card.has-acts .ago{display:none}</style>');
</script>
</body></html>`);
