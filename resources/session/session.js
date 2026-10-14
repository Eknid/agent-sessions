// Session chat tab (webview side). The extension sends transcript items (see
// src/core/transcript.ts) and a state snapshot; this file only draws them and turns
// clicks and keys into messages back to the extension.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const BOOT = window.BOOT || {};
  // Lets VS Code restore this tab after a window reload (see the panel serializer).
  vscode.setState(BOOT);

  const $log = document.getElementById('log');
  const $dock = document.getElementById('dock');
  const logWrap = h('div', 'wrap');
  $log.appendChild(logWrap);
  const busy = h('div', '', 'Working…');
  busy.id = 'busy';

  let voiceState = 'idle';
  let readOnly = false;
  let state = null;
  let commands = [];
  const nodes = new Map(); // item id → element
  const opened = new Map(); // tool id → user's open/closed choice
  const history = [];
  let histPos = -1;
  let histDraft = '';
  let attachments = []; // { mediaType, data, url }
  let pendingKey = '';
  let queueKey = '';
  let popup = { items: [], sel: 0, open: false };

  // ---------- helpers ----------
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const nearBottom = () => $log.scrollHeight - $log.scrollTop - $log.clientHeight < 80;
  const toBottom = () => { $log.scrollTop = $log.scrollHeight; };
  const post = (m) => vscode.postMessage(m);

  const ICON = {
    mic: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5"/></svg>',

    send: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5 3 7.5l1.1 1.1 3.1-3.1V14h1.6V5.5l3.1 3.1L13 7.5z"/></svg>',
    stop: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>',
    queue: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3h11M2.5 6.5h6M4 6.5V11a1.5 1.5 0 0 0 1.5 1.5h7"/><path d="m10.5 10.5 2 2-2 2"/></svg>',
    trash: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.7 7v4.5M9.3 7v4.5"/></svg>',
    image: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3"/></svg>',
  };

  // ---------- Markdown ----------
  const md = new marked.Marked({ gfm: true, breaks: false });
  // Raw HTML in a reply is shown as text, never interpreted.
  md.use({ renderer: { html: (t) => esc(t.text ?? t.raw ?? '') } });
  const PATHLIKE = /^(?:~?\/|\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+(?::\d+(?:-\d+)?)?$|^[\w.@+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sql|md|json|ya?ml|toml|sh|go|rs|java|kt|rb|css|scss|html|txt|csv|tf|hcl|ipynb|lock)(?::\d+(?:-\d+)?)?$/;

  function markdown(text) {
    const div = h('div', 'md');
    try {
      div.innerHTML = md.parse(text);
    } catch {
      div.textContent = text;
    }
    for (const pre of div.querySelectorAll('pre')) {
      const b = h('button', 'copy', 'Copy');
      b.dataset.act = 'copy';
      pre.appendChild(b);
    }
    for (const code of div.querySelectorAll('code')) {
      if (code.parentElement && code.parentElement.tagName === 'PRE') continue;
      if (PATHLIKE.test(code.textContent.trim())) {
        code.classList.add('path');
        code.title = 'Open ' + code.textContent.trim();
      }
    }
    return div;
  }

  // ---------- items ----------
  function render(it) {
    switch (it.kind) {
      case 'user': return userEl(it);
      case 'text': {
        const r = h('div', 'row text');
        r.appendChild(markdown(it.markdown));
        return r;
      }
      case 'thinking': {
        const r = h('div', 'row thinking');
        const d = h('details', 'thinking');
        d.appendChild(h('summary', '', 'Thinking'));
        d.appendChild(h('div', 'body', it.text));
        r.appendChild(d);
        return r;
      }
      case 'tool': return toolEl(it);
      case 'permission': return permEl(it);
      case 'question': return questionRowEl(it);
      case 'note': return noteEl(it);
      default: return h('div');
    }
  }

  function userEl(it) {
    const e = h('div', 'user' + (it.t === 0 ? ' prompt' : ''));
    if (it.images && it.images.length) {
      const imgs = h('div', 'imgs');
      for (const im of it.images) {
        const img = h('img', 'thumb');
        img.src = 'data:' + im.mediaType + ';base64,' + im.data;
        img.alt = 'image';
        imgs.appendChild(img);
      }
      e.appendChild(imgs);
    }
    if (it.text) e.appendChild(document.createTextNode(it.t === 0 ? 'Prompt from parent:\n' + it.text : it.text));
    return e;
  }

  function toolEl(it) {
    const r = h('div', 'row tool ' + it.status);
    r.dataset.id = it.id;
    // Every IN/OUT box starts closed; only the user's click opens it (and it stays open).
    const isOpen = opened.get(it.id) === true;
    if (isOpen) r.classList.add('open');
    const head = h('div', 'head');
    head.dataset.act = 'toggle';
    head.appendChild(h('span', 'name', it.name));
    if (it.summary) {
      const a = h('span', 'arg', it.summary);
      a.title = it.summary;
      head.appendChild(a);
    }
    if (it.agent) {
      const a = h('a', 'agent-link', 'Open transcript');
      a.dataset.act = 'agent';
      a.dataset.owner = it.agent.ownerId;
      head.appendChild(a);
    }
    head.appendChild(h('span', 'chev', isOpen ? '⌄' : '›'));
    r.appendChild(head);
    if (it.agent && (it.agent.note || it.agent.model || it.agent.background)) {
      const bits = [it.agent.model, it.agent.background ? 'background' : '', it.agent.note].filter(Boolean);
      r.appendChild(h('div', 'sub', bits.join(' · ')));
    }
    const io = h('div', 'io');
    if (it.input) io.appendChild(ioRow('IN', it.input, it.inputKind === 'diff' ? 'diff' : ''));
    if (it.output !== undefined) {
      const out = it.output.trim() ? it.output : '(no output)';
      io.appendChild(ioRow('OUT', out + (it.outputTruncated ? '\n… (truncated)' : ''), it.status === 'error' ? 'err' : ''));
    } else if (it.status === 'running') {
      io.appendChild(ioRow('OUT', 'running…', ''));
    }
    if (io.childNodes.length) r.appendChild(io);
    return r;
  }

  function ioRow(label, text, kind) {
    const row = h('div', 'r');
    row.appendChild(h('div', 'k', label));
    const pre = h('pre', kind === 'err' ? 'err' : '');
    if (kind === 'diff') {
      text.split('\n').forEach((l, i) => {
        pre.appendChild(h('span', 'ln ' + (i === 0 ? 'file' : l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : ''), l || ' '));
      });
    } else {
      pre.textContent = text;
    }
    // Long blocks start clipped; a click shows everything.
    if (text.split('\n').length > 6 || text.length > 600) {
      pre.classList.add('clip');
      pre.dataset.act = 'unclip';
    }
    row.appendChild(pre);
    return row;
  }

  const OUTCOME = {
    allowed: ['Allowed', 'ok'],
    always: ['Always allowed', 'ok'],
    denied: ['Denied', 'err'],
    cancelled: ['Cancelled', 'dim'],
  };

  function permEl(it) {
    const r = h('div', 'row perm ' + (it.outcome || 'pending'));
    r.appendChild(document.createTextNode('Permission '));
    r.appendChild(h('span', 'what', it.summary));
    const [label, tone] = it.outcome ? OUTCOME[it.outcome] : ['Waiting for you ↓', 'warn'];
    r.appendChild(h('span', 'badge ' + tone, label));
    return r;
  }

  function questionRowEl(it) {
    const done = it.answers || it.skipped;
    const r = h('div', 'row question' + (it.answers ? ' answered' : ''));
    for (const q of it.questions) {
      const line = h('div', 'qa');
      line.appendChild(document.createTextNode(q.question + ' '));
      if (it.answers && it.answers[q.question] !== undefined) {
        line.appendChild(document.createTextNode('→ '));
        line.appendChild(h('b', '', it.answers[q.question]));
      }
      r.appendChild(line);
    }
    if (!done) r.appendChild(h('span', 'badge warn', 'Waiting for you ↓'));
    else if (it.skipped) r.appendChild(h('span', 'badge dim', 'Skipped'));
    return r;
  }

  function noteEl(it) {
    if (it.title) {
      const e = h('div', 'note local ' + (it.tone || ''));
      e.appendChild(h('span', 'title', it.title));
      e.appendChild(document.createTextNode(it.text));
      return e;
    }
    if (it.divider) return h('div', 'note divider ' + (it.tone || ''), it.text);
    return h('div', 'note ' + (it.tone || ''), it.text);
  }

  function upsert(items) {
    const stick = nearBottom();
    for (const it of items) {
      const el = render(it);
      el.dataset.id = it.id;
      const old = nodes.get(it.id);
      if (old) old.replaceWith(el);
      else logWrap.insertBefore(el, busy.parentNode === logWrap ? busy : null);
      nodes.set(it.id, el);
    }
    updateEmpty();
    if (stick) toBottom();
  }

  function updateEmpty() {
    let empty = logWrap.querySelector('.empty');
    const hasItems = nodes.size > 0;
    if (hasItems && empty) empty.remove();
    if (!hasItems && !empty && !readOnly) {
      empty = h('div', 'empty');
      empty.appendChild(h('b', '', 'Start the conversation'));
      empty.appendChild(document.createTextNode(state ? state.cwd : ''));
      logWrap.prepend(empty);
    }
  }

  // ---------- dock: pending cards + queue + input ----------
  const $cards = h('div', 'cards');
  const $queue = h('div', 'queue');
  $queue.hidden = true;
  const $composerWrap = h('div', 'composer-wrap');
  const $popup = h('div', 'popup');
  $popup.hidden = true;
  const $composer = h('div', 'composer');
  const $chips = h('div', 'chips');
  const $ta = h('textarea');
  $ta.rows = 1;
  $ta.spellcheck = true;
  const $bar = h('div', 'bar');
  const $status = h('div', 'status');
  const $attach = h('button', 'icon-btn');
  $attach.innerHTML = ICON.image;
  $attach.title = 'Attach images (or paste with ⌘V, or drag in holding ⇧)';
  const $mic = h('button', 'icon-btn mic');
  $mic.innerHTML = ICON.mic;
  $mic.title = 'Start voice dictation';
  $mic.setAttribute('aria-label', $mic.title);
  $mic.setAttribute('aria-pressed', 'false');
  const $voiceNote = h('div', 'voice-note');
  $voiceNote.hidden = true;
  $voiceNote.setAttribute('role', 'status');
  const $send = h('button', 'send');
  $bar.append($status, $mic, $attach, $send);
  $composer.append($chips, $ta, $bar, $voiceNote);
  $composerWrap.append($popup, $queue, $composer);
  const dockWrap = h('div', 'wrap');
  dockWrap.append($cards, $composerWrap);
  $dock.appendChild(dockWrap);

  function renderStatus() {
    $status.textContent = '';
    if (!state) return;
    const ui = state.state === 'exited' ? 'exited' : state.uiState;
    $composer.classList.remove('state-running', 'state-waiting', 'state-done', 'state-exited');
    $composer.classList.add('state-' + ui);
    const add = (element) => {
      if ($status.children.length) $status.appendChild(h('span', 'sep', '·'));
      $status.appendChild(element);
    };
    if (!readOnly) {
      const group = h('span', 'model-effort');
      group.appendChild(h('span', '', state.model || (state.provider || 'Claude') + ' default'));
      const effort = h('button', 'status-btn effort', state.effort || 'medium');
      effort.title = 'Change reasoning effort (applies from the next turn)';
      effort.setAttribute('aria-label', 'Change effort: ' + (state.effort || 'medium'));
      effort.addEventListener('click', () => post({ type: 'changeEffort' }));
      group.appendChild(effort);
      add(group);
      const permissions = state.permissions;
      const permissionButton = h('button', 'status-btn permissions', permissions ? permissions.label : 'Permissions');
      permissionButton.title = (permissions ? permissions.detail + '\n' : '') + 'Change permission mode for this session.';
      permissionButton.setAttribute('aria-label', 'Change permission mode: ' + (permissions ? permissions.label : 'Permissions'));
      permissionButton.addEventListener('click', () => post({ type: 'changePermissions' }));
      add(permissionButton);
    }
    if (state.contextPct) add(h('span', '', 'context ' + Math.round(state.contextPct) + '%'));
    if (state.cost) add(h('span', '', state.cost));
    const usage = state.accountUsage;
    const usageButton = h('button', 'status-btn usage', usage ? usage.label : (state.provider === 'Codex' ? 'Usage left …' : 'Credits left …'));
    usageButton.title = (usage ? usage.detail + '\nUpdated ' + new Date(usage.fetchedAt).toLocaleTimeString() : 'Loading account usage.') + '\nClick to refresh.';
    usageButton.addEventListener('click', () => post({ type: 'refreshUsage' }));
    add(usageButton);
    busy.classList.toggle('on', ui === 'running');
    if (!busy.parentNode) logWrap.appendChild(busy);
    $ta.placeholder =
      ui === 'exited' ? 'Session ended — send a message to resume it'
        : ui === 'waiting' ? 'Answer above (text here goes with Deny), or ↵ to queue a message'
          : ui === 'running' ? (state.provider || 'Claude') + ' is working… ↵ adds to the queue · Esc interrupts'
            : 'Message ' + (state.provider || 'Claude') + '…   / for commands';
    updateSend();
  }

  function running() {
    return state && state.state !== 'exited' && state.uiState === 'running';
  }

  /** Whether a message sent now waits in the queue: a turn is under way, or others wait already. */
  function queues() {
    return Boolean(state && ((state.state !== 'exited' && state.uiState !== 'done') || (state.queue && state.queue.length)));
  }

  // ---------- queue (above the input) ----------
  function renderQueue() {
    const q = (state && state.queue) || [];
    const ended = state && state.state === 'exited';
    const key = (ended ? 'x' : '') + q.map((m) => m.id).join(',');
    if (key === queueKey) return;
    queueKey = key;
    $queue.textContent = '';
    $queue.hidden = !q.length;
    if (!q.length) return;
    const head = h('div', 'q-head');
    head.appendChild(h('span', 'q-title', 'Queue'));
    head.appendChild(h('span', 'q-count', String(q.length)));
    head.appendChild(h('span', 'q-when', ended ? 'sent when the session resumes' : 'sent when the agent finishes, one per turn'));
    $queue.appendChild(head);
    q.forEach((m, i) => {
      const row = h('div', 'q-item');
      const icon = h('span', 'q-icon');
      icon.innerHTML = ICON.queue;
      const lines = m.text.trim().split('\n');
      const t = h('span', 'q-text', m.text.trim() ? lines[0] + (lines.length > 1 ? ' …' : '') : '(image only)');
      t.title = m.text;
      row.append(icon, t);
      if (m.images) row.appendChild(h('span', 'q-imgs', m.images === 1 ? '1 image' : m.images + ' images'));
      if (i === 0 && !ended) row.appendChild(h('span', 'q-next', 'next'));
      const del = h('button', 'icon-btn q-del');
      del.innerHTML = ICON.trash;
      del.title = 'Remove from the queue';
      del.onclick = () => post({ type: 'unqueue', id: m.id });
      row.appendChild(del);
      $queue.appendChild(row);
    });
  }

  function updateSend() {
    const empty = !$ta.value.trim() && !attachments.length;
    const stop = running() && empty;
    $send.classList.toggle('stop', stop);
    $send.innerHTML = stop ? ICON.stop : ICON.send;
    $send.title = stop ? 'Interrupt (Esc)' : queues() ? 'Add to the queue (↵)' : 'Send (↵)';
    $send.disabled = !stop && empty;
  }

  function autosize() {
    $ta.style.height = 'auto';
    $ta.style.height = Math.min($ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  function send() {
    const text = $ta.value;
    if (!text.trim() && !attachments.length) return;
    post({ type: 'send', text, images: attachments.map((a) => ({ mediaType: a.mediaType, data: a.data })) });
    if (text.trim() && history[history.length - 1] !== text) history.push(text);
    histPos = -1;
    $ta.value = '';
    attachments = [];
    renderChips();
    closePopup();
    autosize();
    updateSend();
    toBottom();
  }

  // ---------- pending cards ----------
  function renderCards() {
    const pending = (state && state.pending) || [];
    const key = pending.map((p) => p.requestId).join(',');
    if (key === pendingKey) return;
    pendingKey = key;
    $cards.textContent = '';
    for (const p of pending) $cards.appendChild(p.kind === 'question' ? questionCard(p) : permissionCard(p));
  }

  function permissionCard(p) {
    const c = h('div', 'card');
    const t = h('div', 'title', 'Allow ' + ((state && state.provider) || 'Claude') + ' to use ' + (p.tool || 'this tool') + '?');
    if (p.from) t.appendChild(h('span', 'from', '  from ' + p.from));
    c.appendChild(t);
    c.appendChild(h('div', 'what', p.summary));
    if (p.description) c.appendChild(h('div', 'desc', p.description));
    const btns = h('div', 'btns');
    const allow = h('button', 'btn primary');
    allow.innerHTML = 'Allow<kbd>y</kbd>';
    allow.onclick = () => post({ type: 'allow', requestId: p.requestId, always: false });
    btns.appendChild(allow);
    if (p.canAlways) {
      const always = h('button', 'btn');
      always.innerHTML = 'Always allow<kbd>a</kbd>';
      always.onclick = () => post({ type: 'allow', requestId: p.requestId, always: true });
      btns.appendChild(always);
    }
    const deny = h('button', 'btn');
    deny.innerHTML = 'Deny<kbd>n</kbd>';
    deny.onclick = () => denyWithText(p.requestId);
    btns.appendChild(deny);
    btns.appendChild(h('span', 'hint', 'Text in the input below is sent with Deny'));
    c.appendChild(btns);
    return c;
  }

  function denyWithText(requestId) {
    const message = $ta.value.trim();
    post({ type: 'deny', requestId, message });
    if (message) {
      $ta.value = '';
      autosize();
      updateSend();
    }
  }

  function questionCard(p) {
    const c = h('div', 'card');
    const t = h('div', 'title', ((state && state.provider) || 'Claude') + ' has a question');
    if (p.from) t.appendChild(h('span', 'from', '  from ' + p.from));
    c.appendChild(t);
    const qs = p.questions || [];
    const chosen = qs.map(() => new Set());
    const others = [];
    const submit = h('button', 'btn primary', 'Submit');
    const answers = () => {
      const out = {};
      qs.forEach((q, i) => {
        const labels = [...chosen[i]];
        const other = others[i].value.trim();
        if (other) labels.push(other);
        if (labels.length) out[q.question] = labels.join(', ');
      });
      return out;
    };
    const refresh = () => { submit.disabled = Object.keys(answers()).length < qs.length; };
    qs.forEach((q, i) => {
      const block = h('div', 'q');
      const qt = h('div', 'qt');
      if (q.header) qt.appendChild(h('span', 'chip', q.header));
      qt.appendChild(document.createTextNode(q.question + (q.multiSelect ? ' (choose any)' : '')));
      block.appendChild(qt);
      (q.options || []).forEach((o, n) => {
        const b = h('button', 'opt-btn');
        b.appendChild(h('span', 'n', String(n + 1)));
        b.appendChild(document.createTextNode(o.label));
        if (o.description) b.appendChild(h('span', 'd', o.description));
        b.onclick = () => {
          if (q.multiSelect) {
            chosen[i].has(o.label) ? chosen[i].delete(o.label) : chosen[i].add(o.label);
          } else {
            chosen[i].clear();
            chosen[i].add(o.label);
            others[i].value = '';
          }
          for (const [k, el] of [...block.querySelectorAll('.opt-btn')].entries()) el.classList.toggle('chosen', chosen[i].has(q.options[k].label));
          refresh();
          // One single-choice question: a click is the answer.
          if (qs.length === 1 && !q.multiSelect) post({ type: 'answer', requestId: p.requestId, answers: answers() });
        };
        block.appendChild(b);
      });
      const other = h('input', 'other');
      other.placeholder = 'Other… (type your own answer)';
      other.oninput = () => {
        if (!q.multiSelect && other.value.trim()) {
          chosen[i].clear();
          block.querySelectorAll('.opt-btn').forEach((el) => el.classList.remove('chosen'));
        }
        refresh();
      };
      other.onkeydown = (e) => {
        if (e.key === 'Enter' && !submit.disabled) {
          e.preventDefault();
          submit.click();
        }
      };
      others.push(other);
      block.appendChild(other);
      c.appendChild(block);
    });
    const btns = h('div', 'btns');
    submit.onclick = () => post({ type: 'answer', requestId: p.requestId, answers: answers() });
    const skip = h('button', 'btn', 'Skip');
    skip.onclick = () => post({ type: 'skip', requestId: p.requestId });
    btns.append(submit, skip);
    c.appendChild(btns);
    refresh();
    return c;
  }

  // ---------- slash suggestions ----------
  function rank(c, q) {
    const n = c.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[:\-_]/).some((p) => p.startsWith(q))) return 2;
    if (n.includes(q)) return 3;
    return -1;
  }
  function matches(q) {
    q = q.toLowerCase();
    return commands
      .map((c) => ({ c, r: rank(c, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || (a.c.kind === b.c.kind ? 0 : a.c.kind === 'local' ? -1 : 1) || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c);
  }
  function updatePopup() {
    const m = /^\/(\S*)$/.exec($ta.value);
    if (!m) return closePopup();
    popup.items = matches(m[1]);
    popup.sel = Math.min(popup.sel, Math.max(0, popup.items.length - 1));
    if (!popup.items.length) return closePopup();
    popup.open = true;
    $popup.hidden = false;
    $popup.textContent = '';
    popup.items.forEach((c, i) => {
      const o = h('div', 'opt' + (i === popup.sel ? ' sel' : ''));
      o.appendChild(h('span', 'nm', '/' + c.name));
      o.appendChild(h('span', 'ds', c.description));
      if (c.kind === 'local') o.appendChild(h('span', 'local', 'extension'));
      if (c.kind === 'skill') o.appendChild(h('span', 'local', 'skill'));
      if (c.kind === 'terminal') o.appendChild(h('span', 'local', 'terminal'));
      o.onmousedown = (e) => {
        e.preventDefault();
        popup.sel = i;
        complete();
        $ta.value += ' ';
        $ta.focus();
      };
      $popup.appendChild(o);
    });
    $popup.children[popup.sel]?.scrollIntoView({ block: 'nearest' });
  }
  function closePopup() {
    popup.open = false;
    popup.sel = 0;
    $popup.hidden = true;
  }
  function complete() {
    const c = popup.items[popup.sel];
    if (c) $ta.value = '/' + c.name;
    closePopup();
    autosize();
    updateSend();
  }

  // ---------- input keys ----------
  $ta.addEventListener('input', () => {
    autosize();
    updatePopup();
    updateSend();
    histPos = -1;
  });
  $ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (popup.open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        popup.sel = (popup.sel + (e.key === 'ArrowDown' ? 1 : -1) + popup.items.length) % popup.items.length;
        updatePopup();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        complete();
        $ta.value += ' ';
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const exact = $ta.value === '/' + popup.items[popup.sel]?.name;
        complete();
        if (exact) send();
        else $ta.value += ' ';
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape') {
      if (running()) {
        e.preventDefault();
        post({ type: 'interrupt' });
      }
      return;
    }
    if (e.key === 'ArrowUp' && $ta.selectionStart === 0 && $ta.selectionEnd === 0 && history.length) {
      e.preventDefault();
      if (histPos === -1) {
        histDraft = $ta.value;
        histPos = history.length;
      }
      histPos = Math.max(0, histPos - 1);
      $ta.value = history[histPos];
      autosize();
      updateSend();
      $ta.setSelectionRange(0, 0);
      return;
    }
    if (e.key === 'ArrowDown' && histPos !== -1 && $ta.selectionStart === $ta.value.length) {
      e.preventDefault();
      histPos++;
      if (histPos >= history.length) {
        histPos = -1;
        $ta.value = histDraft;
      } else {
        $ta.value = history[histPos];
      }
      autosize();
      updateSend();
    }
  });
  $ta.addEventListener('blur', () => setTimeout(closePopup, 150));
  $send.addEventListener('click', () => (running() && !$ta.value.trim() && !attachments.length ? post({ type: 'interrupt' }) : send()));
  $attach.addEventListener('click', () => post({ type: 'pickImages' }));
  $mic.addEventListener('click', () => post({ type: 'voice' }));

  // y / a / n answer a permission request while the input is empty.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const p = state && state.pending && state.pending[0];
    if (!p || p.kind !== 'permission') return;
    const inInput = document.activeElement === $ta;
    if (document.activeElement && document.activeElement !== document.body && !inInput) return;
    if (inInput && $ta.value) return;
    const k = e.key.toLowerCase();
    if (k === 'y') post({ type: 'allow', requestId: p.requestId, always: false });
    else if (k === 'a' && p.canAlways) post({ type: 'allow', requestId: p.requestId, always: true });
    else if (k === 'n') post({ type: 'deny', requestId: p.requestId, message: '' });
    else return;
    e.preventDefault();
  });

  // ---------- images ----------
  const OK_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const MAX_SIDE = 2000; // Claude downsizes anything larger anyway
  const MAX_B64 = 4_500_000; // stays under the API's 5 MB per image

  function readAsDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }
  function loadImg(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('not an image'));
      img.src = url;
    });
  }
  /** Fits the image to what the API accepts: a supported type, ≤2000 px a side, <5 MB. */
  async function prepare(url, type) {
    const img = await loadImg(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale < 1 || url.length > MAX_B64 || !OK_TYPES.has(type)) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      url = c.toDataURL('image/png');
      type = 'image/png';
      if (url.length > MAX_B64) {
        url = c.toDataURL('image/jpeg', 0.85);
        type = 'image/jpeg';
      }
    }
    return { mediaType: type, data: url.slice(url.indexOf(',') + 1), url };
  }
  async function addBlobs(blobs) {
    for (const b of blobs) {
      try {
        attachments.push(await prepare(await readAsDataUrl(b), b.type));
      } catch {
        /* not a readable image */
      }
    }
    renderChips();
    updateSend();
    $ta.focus();
  }
  async function addEncoded(images) {
    for (const im of images) {
      try {
        attachments.push(await prepare('data:' + im.mediaType + ';base64,' + im.data, im.mediaType));
      } catch {
        /* skip */
      }
    }
    renderChips();
    updateSend();
    $ta.focus();
  }
  function renderChips() {
    $chips.textContent = '';
    attachments.forEach((a, i) => {
      const c = h('div', 'chip-img');
      const img = h('img');
      img.src = a.url;
      img.className = 'thumb-chip';
      img.dataset.act = 'zoom';
      const x = h('button', '', '×');
      x.title = 'Remove';
      x.onclick = () => {
        attachments.splice(i, 1);
        renderChips();
        updateSend();
      };
      c.append(img, x);
      $chips.appendChild(c);
    });
  }

  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    // Copied text (e.g. cells that also carry a picture) pastes as text.
    if (!files.length || dt.getData('text/plain')) return;
    e.preventDefault();
    void addBlobs(files);
  });
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      $composer.classList.add('drag');
    });
  }
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) $composer.classList.remove('drag');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    $composer.classList.remove('drag');
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) return void addBlobs(files);
    // From the VS Code explorer: paths only, the extension reads them.
    const uris = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (uris.length) post({ type: 'dropPaths', uris });
  });

  // ---------- clicks in the transcript ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const a = t.closest('a[href]');
    if (a) {
      e.preventDefault();
      post({ type: 'openLink', href: a.getAttribute('href') });
      return;
    }
    const code = t.closest('code.path');
    if (code) {
      post({ type: 'openLink', href: code.textContent.trim() });
      return;
    }
    if (t.matches('img.thumb, img.thumb-chip')) return lightbox(t.src);
    const act = t.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'copy': {
        const pre = act.closest('pre');
        const text = pre.querySelector('code') ? pre.querySelector('code').textContent : pre.textContent;
        copy(text);
        act.textContent = 'Copied';
        setTimeout(() => (act.textContent = 'Copy'), 1200);
        return;
      }
      case 'toggle': {
        const row = act.closest('.tool');
        const open = !row.classList.contains('open');
        row.classList.toggle('open', open);
        opened.set(row.dataset.id, open);
        const chev = row.querySelector('.chev');
        if (chev) chev.textContent = open ? '⌄' : '›';
        return;
      }
      case 'unclip':
        act.classList.remove('clip');
        delete act.dataset.act;
        return;
      case 'agent':
        e.stopPropagation();
        post({ type: 'openAgent', ownerId: act.dataset.owner });
        return;
    }
  });

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = h('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  function lightbox(src) {
    const box = h('div', 'lightbox');
    const img = h('img');
    img.src = src;
    box.appendChild(img);
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelector('.lightbox')?.remove();
  });

  // ---------- messages from the extension ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        readOnly = m.readOnly;
        state = m.state;
        commands = m.commands || [];
        nodes.clear();
        logWrap.textContent = '';
        history.length = 0;
        for (const it of m.items) if (it.kind === 'user' && it.t !== 0 && it.text) history.push(it.text);
        if (readOnly) {
          $composerWrap.hidden = true;
          const b = h('div', 'banner', 'Read-only subagent transcript. To steer it, write in the main session.');
          dockWrap.appendChild(b);
        }
        logWrap.appendChild(busy);
        pendingKey = '';
        queueKey = '';
        upsert(m.items);
        renderStatus();
        renderCards();
        renderQueue();
        toBottom();
        if (!readOnly) $ta.focus();
        if (!readOnly) updatePopup();
        return;
      case 'items':
        upsert(m.items);
        return;
      case 'state':
        if (!m.state) return;
        state = m.state;
        renderStatus();
        renderCards();
        renderQueue();
        return;
      case 'commands':
        commands = m.commands || [];
        if (document.activeElement === $ta) updatePopup();
        return;
      case 'attach':
        void addEncoded(m.images || []);
        if (m.text) {
          $ta.value += ($ta.value && !/\s$/.test($ta.value) ? ' ' : '') + m.text;
          autosize();
          updateSend();
        }
        return;
      case 'voice':
        voiceState = m.state;
        $mic.classList.toggle('recording', voiceState === 'recording');
        $mic.disabled = voiceState === 'starting' || voiceState === 'transcribing';
        $mic.innerHTML = voiceState === 'recording' ? ICON.stop : ICON.mic;
        $mic.title = voiceState === 'recording' ? 'Stop and transcribe' : voiceState === 'transcribing' ? 'Transcribing…' : 'Start voice dictation';
        $mic.setAttribute('aria-label', $mic.title);
        $mic.setAttribute('aria-pressed', String(voiceState === 'recording'));
        $voiceNote.textContent = m.error || (voiceState === 'recording' ? 'Listening… click the microphone to stop (max 2 minutes).' : voiceState === 'transcribing' ? 'Transcribing…' : voiceState === 'starting' ? 'Starting microphone…' : '');
        $voiceNote.hidden = !$voiceNote.textContent;
        $voiceNote.classList.toggle('error', Boolean(m.error));
        if (m.text && !readOnly) {
          $ta.value += ($ta.value && !/\s$/.test($ta.value) ? ' ' : '') + m.text;
          autosize(); updateSend(); updatePopup(); $ta.focus();
        }
        return;
      case 'focus':
        if (!readOnly) $ta.focus();
        return;
    }
  });

  updateSend();
  post({ type: 'ready' });
})();
