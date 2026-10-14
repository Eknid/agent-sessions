// End-to-end against the real `claude` CLI (Haiku, a few cents). Opt-in: AGENT_SESSIONS_E2E=1.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../src/core/sessionManager';

const enabled = process.env.AGENT_SESSIONS_E2E === '1';
const claude = enabled ? execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim().split('\n').pop()! : '';

function waitFor(m: SessionManager, id: string, pred: () => boolean, label: string, ms = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const timer = setTimeout(() => {
      m.off('changed', check);
      reject(new Error(`timeout: ${label} (state=${m.view(id)?.state})`));
    }, ms);
    const check = (sid: string) => {
      if (sid === id && pred()) {
        clearTimeout(timer);
        m.off('changed', check);
        resolve();
      }
    };
    m.on('changed', check);
  });
}

test('real claude: subagent + permission + resume', { skip: !enabled, timeout: 600_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-e2e-'));
  const store = path.join(tmp, 'store');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  const m = new SessionManager({ storageDir: store, command: claude });
  const m2 = new SessionManager({ storageDir: store, command: claude });
  try {
  const states: string[] = [];
  m.on('transition', (_id, _f, to) => states.push(to));
  // Auto-approve every permission from the "user" side, like pressing y in the tab.
  m.on('changed', (sid) => {
    const p = m.view(sid)?.pending[0];
    if (p?.kind === 'permission') m.allow(sid, p.requestId);
  });

  const id = m.create({
    cwd: work,
    name: 'e2e',
    model: 'haiku',
    prompt:
      'Do two things in order. 1) Spawn exactly one subagent with the Agent tool (subagent_type general-purpose, model haiku, foreground) whose task is to reply with the single word PONG and use no tools. 2) Then run this exact bash command: touch e2e_marker.txt . Finally reply DONE.',
  });
  await waitFor(m, id, () => (m.view(id)?.turns ?? 0) >= 1 && m.view(id)!.uiState === 'done', 'first turn');
  let v = m.view(id)!;
  console.log(JSON.stringify({ states, cost: v.costUsd, tokens: v.tokens, owners: v.owners.map((o) => [o.label, o.model, o.state, o.tokens.total, o.costUsd.toFixed(4), o.contextPct.toFixed(1)]) }));
  assert.ok(states.includes('waiting'), 'went through a permission wait');
  assert.ok(fs.existsSync(path.join(work, 'e2e_marker.txt')), 'approved command ran');
  const sub = v.owners.find((o) => o.id !== 'main');
  assert.ok(sub, 'subagent tracked');
  assert.equal(sub!.state, 'completed');
  assert.match(sub!.model ?? '', /haiku/);
  assert.ok(sub!.tokens.total > 0, 'subagent tokens attributed');
  assert.ok(v.costFinalUsd! > 0, 'authoritative cost');
  const est = v.owners.reduce((a, o) => a + o.costUsd, 0);
  console.log(`estimate ${est.toFixed(5)} vs billed ${v.costFinalUsd!.toFixed(5)}`);
  assert.ok(Math.abs(est - v.costFinalUsd!) / v.costFinalUsd! < 0.25, 'estimate within 25% of billed');
  assert.ok(v.contextPct > 0);

  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'stopped');

  // Reload + resume: the conversation must continue with memory of the first turn.
  m2.load();
  m2.send(id, 'What exact single word did your subagent reply with? Answer with just that word.');
  await waitFor(m2, id, () => m2.view(id)!.turns >= 2 && m2.view(id)!.uiState === 'done', 'resumed turn');
  const last = [...m2.records(id)].reverse().find((r) => r.ev.type === 'result');
  console.log('resumed answer:', last?.ev.result);
  assert.match(String(last?.ev.result), /PONG/i);
  v = m2.view(id)!;
  assert.ok(v.costUsd >= m.view(id)!.costUsd, 'cost does not go backwards across resume');
  } finally {
    await m2.dispose();
    await m.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
