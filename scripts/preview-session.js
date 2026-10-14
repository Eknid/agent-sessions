// Renders the session chat tab outside VS Code from an event log, so its HTML/CSS/JS can be
// checked in a browser. Usage (after `npx tsc -p .`):
//   node scripts/preview-session.js [log.ndjson] [--pending] [--queue] > out/preview-session.html
// then open it from a local server in the repo root (e.g. `python3 -m http.server`), since
// the page loads resources/ by relative path. Messages the page sends are logged to the console.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { Transcript } = require(path.join(root, 'out/src/core/transcript'));
const { catalogue } = require(path.join(root, 'out/src/core/slashCommands'));

const args = process.argv.slice(2);
const withPending = args.includes('--pending');
const withQueue = args.includes('--queue');
const file = args.find((a) => !a.startsWith('--')) || path.join(root, 'test/fixtures/03-forwarded-subagent-permission.ndjson');
const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const t = new Transcript({ owner: 'main' });
for (const r of records) t.apply(r);

const pending = withPending
  ? [
      { requestId: 'r1', kind: 'permission', tool: 'Bash', summary: 'Bash(dbt build -s consumer_activity_daily)', description: 'Build the activity mart', canAlways: true },
      ...(args.includes('--question')
        ? [{
            requestId: 'r2', kind: 'question', summary: 'Claude has a question', canAlways: false,
            questions: [
              { question: 'Should budget-triggered top-ups count as instant?', header: 'Definition', options: [{ label: 'Yes', description: 'Keep them in top_up_instant_*' }, { label: 'No', description: 'Exclude them, as today' }] },
              { question: 'Which marts should change?', header: 'Scope', multiSelect: true, options: [{ label: 'consumer_activity_daily' }, { label: 'consumer_activity_monthly' }] },
            ],
          }]
        : []),
    ]
  : [];
const init = {
  type: 'init',
  readOnly: false,
  items: t.all(),
  state: {
    name: 'preview', cwd: '~/repos/di_transform_dbt', model: 'Opus 5.5', cost: '$7.00', contextPct: 34, pending,
    state: withQueue ? 'running' : 'idle',
    uiState: withPending ? 'waiting' : withQueue ? 'running' : 'done',
    label: withPending ? 'Needs permission' : withQueue ? 'Working' : 'Done',
    queue: withQueue
      ? [
          { id: 'q1', text: 'Now add the same test to consumer_activity_monthly', images: 0 },
          { id: 'q2', text: 'Then compare with this dashboard\nand tell me which numbers differ', images: 2 },
        ]
      : [],
  },
  commands: catalogue({ headless: ['compact', 'context', 'model', 'mind:search', 'review'], terminalOnly: ['doctor'] }),
};

// The VS Code Dark Modern colours the page reads.
const theme = {
  'foreground': '#cccccc', 'descriptionForeground': '#9d9d9d', 'editor-background': '#1f1f1f', 'widget-border': '#313131',
  'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898',
  'textCodeBlock-background': '#2b2b2b', 'testing-iconPassed': '#73c991', 'errorForeground': '#f85149', 'editorWarning-foreground': '#cca700',
  'textLink-foreground': '#4daafc', 'focusBorder': '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c', 'editorSuggestWidget-background': '#202020', 'editorSuggestWidget-border': '#454545',
  'editorSuggestWidget-selectedBackground': '#04395e', 'list-activeSelectionBackground': '#04395e', 'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
  'font-size': '13px', 'editor-font-family': 'Menlo, Monaco, monospace', 'toolbar-hoverBackground': '#5a5d5e50',
};
const vars = Object.entries(theme).map(([k, v]) => `--vscode-${k}:${v}`).join(';');

process.stdout.write(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="../resources/session/session.css">
<style>html{${vars}}</style></head><body>
<main id="log"></main><footer id="dock"></footer>
<script>
window.BOOT = { sessionId: 'preview', owner: 'main' };
const INIT = ${JSON.stringify(init).replace(/</g, '\\u003c')};
window.acquireVsCodeApi = () => ({
  setState() {},
  postMessage(m) {
    console.log('[to extension]', JSON.stringify(m).slice(0, 300));
    if (m.type === 'ready') setTimeout(() => window.postMessage(INIT, '*'));
    if (m.type === 'unqueue') {
      INIT.state.queue = INIT.state.queue.filter((q) => q.id !== m.id);
      setTimeout(() => window.postMessage({ type: 'state', state: INIT.state }, '*'));
    }
  },
});
</script>
<script src="../resources/vendor/marked.js"></script>
<script src="../resources/session/session.js"></script>
<script>
// #find=text scrolls to the first element containing that text (for screenshots).
const want = decodeURIComponent((location.hash.match(/find=([^&]+)/) || [])[1] || '');
if (want) setTimeout(() => {
  const el = [...document.querySelectorAll('#log .user, #log .row')].find((e) => e.textContent.includes(want));
  if (el) el.scrollIntoView({ block: 'start' });
}, 400);
// #type=text puts text in the input (e.g. /co to show suggestions); #img adds a sample image;
// #del clicks the first queued message's trash button.
const typed = decodeURIComponent((location.hash.match(/type=([^&]+)/) || [])[1] || '');
setTimeout(() => {
  const ta = document.querySelector('textarea');
  if (typed) { ta.value = typed; ta.dispatchEvent(new Event('input')); ta.focus(); }
  if (location.hash.includes('img')) {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200;
    const g = c.getContext('2d'); g.fillStyle = '#2b6cb0'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('screenshot', 90, 110);
    const url = c.toDataURL('image/png');
    window.postMessage({ type: 'attach', images: [{ mediaType: 'image/png', data: url.slice(22) }] }, '*');
  }
  if (location.hash.includes('del')) document.querySelector('.q-del')?.click();
}, 500);
</script>
</body></html>`);
