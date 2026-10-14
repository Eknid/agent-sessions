// Sessions board (webview side): draws the cards the extension sends (see src/ui/boardPanel.ts)
// in three status columns, one lane per repository (or one flat lane), and turns clicks into
// commands. Lanes and columns fold; what is folded is remembered with the tab.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    lanes: saved.lanes === 'flat' ? 'flat' : 'repo',
    foldedRepos: new Set(saved.foldedRepos || []),
    foldedCols: new Set(saved.foldedCols || []),
  };
  const save = () => vscode.setState({ board: true, lanes: ui.lanes, foldedRepos: [...ui.foldedRepos], foldedCols: [...ui.foldedCols] });
  save();
  const post = (m) => vscode.postMessage(m);
  const $top = document.getElementById('top');
  const $board = document.getElementById('board');

  const COLUMNS = [
    { key: 'running', title: 'Running' },
    { key: 'waiting', title: 'Waiting for you' },
    { key: 'done', title: 'Done' },
  ];
  let cards = [];
  let archived = 0;
  let skew = 0;
  let filter = '';
  const lastColumn = new Map();

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() + skew - t) / 1000));
    if (s < 60) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const hr = Math.round(m / 60);
    return hr < 24 ? hr + 'h ago' : Math.round(hr / 24) + 'd ago';
  }
  const tilde = (p) => String(p).replace(/^\/Users\/[^/]+/, '~');

  // ---------- header ----------
  const $title = h('h1', '', 'Sessions');
  const $sum = h('div', 'sum');
  const $seg = h('div', 'seg');
  $seg.title = 'Lanes';
  const segBtn = (key, label) => {
    const b = h('button', '', label);
    b.dataset.key = key;
    b.onclick = () => {
      ui.lanes = key;
      save();
      render();
    };
    return b;
  };
  $seg.append(segBtn('repo', 'By repository'), segBtn('flat', 'All together'));
  const $search = h('input');
  $search.type = 'search';
  $search.placeholder = 'Filter by name or repository';
  $search.addEventListener('input', () => {
    filter = $search.value.trim().toLowerCase();
    render();
  });
  const $new = h('button', 'btn primary', 'New session');
  $new.onclick = () => post({ type: 'newSession' });
  $top.append($title, $sum, h('div', 'spacer'), $seg, $search, $new);

  function renderSummary() {
    const n = (k) => cards.filter((c) => c.column === k).length;
    const total = cards.reduce((a, c) => a + (c.costUsd || 0), 0);
    $sum.textContent = '';
    const add = (label, value) => {
      const s = h('span');
      s.append(h('b', '', String(value)), document.createTextNode(' ' + label));
      $sum.appendChild(s);
    };
    add('running', n('running'));
    add('waiting', n('waiting'));
    add('done', n('done'));
    add('total', '$' + total.toFixed(2));
    if (archived) $sum.appendChild(h('span', '', archived + ' archived'));
    for (const b of $seg.children) b.classList.toggle('on', b.dataset.key === ui.lanes);
  }

  // Same orders as the sidebar (groupOrder in src/core/sessionModel.ts, repoOrder in src/core/repo.ts).
  const order = {
    running: (a, b) => b.updatedAt - a.updatedAt,
    // Whoever has waited longest comes first.
    waiting: (a, b) => a.updatedAt - b.updatedAt,
    done: (a, b) => b.updatedAt - a.updatedAt,
  };
  const repoOrder = (a, b) =>
    Number(b.waiting > 0) - Number(a.waiting > 0) || Number(b.running > 0) - Number(a.running > 0) || b.latest - a.latest;

  // ---------- cards ----------
  function chipClass(c) {
    if (c.column !== 'done') return c.column;
    return c.sub || 'done';
  }

  function cardEl(c) {
    const e = h('div', 'card');
    e.tabIndex = 0;
    e.dataset.id = c.id;
    e.title = c.cwd;
    const prev = lastColumn.get(c.id);
    if (prev && prev !== c.column) e.classList.add('moved');
    lastColumn.set(c.id, c.column);

    const t = h('div', 't');
    t.append(h('span', 'name', c.name), h('span', 'ago', ago(c.updatedAt)));
    e.appendChild(t);

    const meta = h('div', 'meta');
    meta.appendChild(h('span', 'chip ' + chipClass(c), c.label));
    // In a repository lane the repository is the lane title: only say where inside it.
    const where = ui.lanes === 'repo' ? c.subdir : c.subdir ? c.repoName + '/' + c.subdir : c.repoName;
    const bits = [where, c.model, c.cost].filter(Boolean);
    if (c.contextPct) bits.push('ctx ' + Math.round(c.contextPct) + '%');
    if (c.agents) bits.push(c.agents + ' subagent' + (c.agents > 1 ? 's' : '') + (c.runningAgents ? ', ' + c.runningAgents + ' running' : ''));
    bits.forEach((b) => {
      meta.appendChild(h('span', 'sep', '·'));
      meta.appendChild(h('span', '', b));
    });
    if (c.column === 'running') meta.prepend(h('span', 'spin'));
    e.appendChild(meta);

    if (c.pending) {
      const ask = h('div', 'ask');
      ask.appendChild(h('div', 'what', c.pending.summary));
      const btns = h('div', 'btns');
      if (c.pending.kind === 'permission') {
        btns.appendChild(btn('Allow', 'primary', () => post({ type: 'allow', id: c.id, requestId: c.pending.requestId, always: false })));
        if (c.pending.canAlways) btns.appendChild(btn('Always allow', '', () => post({ type: 'allow', id: c.id, requestId: c.pending.requestId, always: true })));
        btns.appendChild(btn('Deny', '', () => post({ type: 'deny', id: c.id, requestId: c.pending.requestId })));
      } else {
        btns.appendChild(btn('Answer…', 'primary', () => post({ type: 'open', id: c.id })));
      }
      ask.appendChild(btns);
      e.appendChild(ask);
    } else if (c.sub === 'error' && c.error) {
      const err = h('div', 'err', c.error);
      err.title = c.error;
      e.appendChild(err);
    }

    if (!c.pending) {
      const acts = h('div', 'acts');
      if (c.column === 'running') acts.appendChild(btn('Interrupt', '', () => post({ type: 'interrupt', id: c.id })));
      if (c.sub === 'ended' || c.sub === 'error') acts.appendChild(btn('Resume', '', () => post({ type: 'resume', id: c.id })));
      if (c.column === 'done') acts.appendChild(btn('Archive', '', () => post({ type: 'archive', id: c.id })));
      // In the title row, where the time is: on hover they take its place, covering nothing.
      if (acts.childNodes.length) {
        t.appendChild(acts);
        e.classList.add('has-acts');
      }
    }

    e.addEventListener('click', () => post({ type: 'open', id: c.id }));
    e.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target === e) post({ type: 'open', id: c.id });
    });
    return e;
  }

  function btn(label, kind, fn) {
    const b = h('button', 'btn sm ' + kind, label);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn();
    });
    return b;
  }

  // ---------- folding ----------
  function toggle(set, key) {
    set.has(key) ? set.delete(key) : set.add(key);
    save();
    render();
  }

  /** Column widths: a folded status is a narrow strip with its count. */
  function columnTemplate() {
    return COLUMNS.map((c) => (ui.foldedCols.has(c.key) ? '38px' : 'minmax(240px, 1fr)')).join(' ');
  }

  function columnHeads(shown) {
    const row = h('div', 'heads');
    for (const c of COLUMNS) {
      const n = shown.filter((x) => x.column === c.key).length;
      const folded = ui.foldedCols.has(c.key);
      const head = h('button', 'colhead ' + c.key + (folded ? ' folded' : ''));
      head.title = (folded ? 'Show ' : 'Hide ') + c.title.toLowerCase() + ' sessions';
      head.append(h('span', 'chev', folded ? '›' : '⌄'), h('span', 'dot'), h('span', 'ttl', c.title), h('span', 'n', String(n)));
      head.onclick = () => toggle(ui.foldedCols, c.key);
      row.appendChild(head);
    }
    return row;
  }

  function laneEl(key, title, path, mine) {
    const lane = h('section', 'lane');
    const folded = key !== null && ui.foldedRepos.has(key);
    if (key !== null) {
      const head = h('button', 'lane-head' + (folded ? ' folded' : ''));
      head.title = path;
      head.append(h('span', 'chev', folded ? '›' : '⌄'), h('span', 'repo-name', title));
      for (const c of COLUMNS) {
        const n = mine.filter((x) => x.column === c.key).length;
        if (n) head.appendChild(h('span', 'count ' + c.key, n + ' ' + (c.key === 'waiting' ? 'waiting' : c.key)));
      }
      const cost = mine.reduce((a, x) => a + (x.costUsd || 0), 0);
      head.appendChild(h('span', 'lane-cost', '$' + cost.toFixed(2)));
      head.onclick = () => toggle(ui.foldedRepos, key);
      lane.appendChild(head);
    }
    if (folded) return lane;
    const body = h('div', 'cells');
    for (const c of COLUMNS) {
      const inCol = mine.filter((x) => x.column === c.key).sort(order[c.key]);
      const cell = h('div', 'cell ' + c.key);
      if (ui.foldedCols.has(c.key)) {
        cell.classList.add('folded');
        if (inCol.length) {
          const b = h('button', 'hidden-n', String(inCol.length));
          b.title = inCol.length + ' hidden — show ' + c.title.toLowerCase();
          b.onclick = () => toggle(ui.foldedCols, c.key);
          cell.appendChild(b);
        }
      } else {
        for (const card of inCol) cell.appendChild(cardEl(card));
      }
      body.appendChild(cell);
    }
    lane.appendChild(body);
    return lane;
  }

  // ---------- render ----------
  function render() {
    renderSummary();
    const scroll = $board.scrollTop;
    $board.textContent = '';
    if (!cards.length) {
      const empty = h('div', 'empty-board');
      empty.append(h('b', '', 'No sessions yet'));
      const b = h('button', 'btn primary', 'New session');
      b.onclick = () => post({ type: 'newSession' });
      empty.appendChild(b);
      $board.appendChild(empty);
      return;
    }
    const shown = filter
      ? cards.filter((c) => (c.name + ' ' + c.repoName + ' ' + c.subdir + ' ' + c.folder).toLowerCase().includes(filter))
      : cards;
    $board.style.setProperty('--cols', columnTemplate());
    $board.appendChild(columnHeads(shown));
    if (!shown.length) {
      $board.appendChild(h('div', 'none', 'No session matches “' + filter + '”'));
      return;
    }
    if (ui.lanes === 'flat') {
      $board.appendChild(laneEl(null, '', '', shown));
    } else {
      const repos = new Map();
      for (const c of shown) {
        let r = repos.get(c.repo);
        if (!r) repos.set(c.repo, (r = { key: c.repo, name: c.repoName, cards: [], waiting: 0, running: 0, latest: 0 }));
        r.cards.push(c);
        if (c.column === 'waiting') r.waiting++;
        if (c.column === 'running') r.running++;
        r.latest = Math.max(r.latest, c.updatedAt);
      }
      for (const r of [...repos.values()].sort(repoOrder)) $board.appendChild(laneEl(r.key, r.name, tilde(r.key), r.cards));
    }
    $board.scrollTop = scroll;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type !== 'cards') return;
    cards = m.cards || [];
    archived = m.archived || 0;
    skew = (m.now || Date.now()) - Date.now();
    render();
  });
  // "5m ago" keeps moving on its own.
  setInterval(() => {
    for (const el of document.querySelectorAll('.card')) {
      const c = cards.find((x) => x.id === el.dataset.id);
      if (c) el.querySelector('.ago').textContent = ago(c.updatedAt);
    }
  }, 30000);

  post({ type: 'ready' });
})();
