import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { listPastConversations, projectSlug } from '../src/core/pastConversations';
import { catalogue, classify, matchCommands } from '../src/core/slashCommands';

const cmds = { headless: ['compact', 'clear', 'model', 'context', 'mind:search', 'superpowers:writing-plans', 'doctor', '__remote-workflow'], terminalOnly: ['doctor'] };

test('classify: local, forwarded, TUI-only, unknown, and paths', () => {
  assert.deepEqual(classify('/resume', cmds), { kind: 'local', name: 'resume', args: '' });
  assert.deepEqual(classify('/compact keep the plan', cmds), { kind: 'headless', name: 'compact' });
  assert.deepEqual(classify('/doctor', cmds), { kind: 'unsupported', name: 'doctor', terminalOnly: true });
  assert.deepEqual(classify('/login', cmds), { kind: 'unsupported', name: 'login', terminalOnly: false });
  assert.deepEqual(classify('/Users/me/file.txt is broken', cmds), { kind: 'text' });
  assert.deepEqual(classify('plain text', cmds), { kind: 'text' });
  assert.deepEqual(classify('/anything', { headless: [], terminalOnly: [] }), { kind: 'headless', name: 'anything' }, 'no list yet: let claude decide');
});

test('catalogue and matching: local first, TUI-only and internal hidden, plugin segments match', () => {
  const all = catalogue(cmds);
  assert.ok(!all.some((c) => c.name === 'doctor' || c.name.startsWith('__')));
  assert.equal(matchCommands(all, 're')[0].name, 'resume');
  assert.deepEqual(matchCommands(all, 'co').map((c) => c.name).slice(0, 3), ['cost', 'compact', 'context']);
  assert.equal(matchCommands(all, 'writing')[0].name, 'superpowers:writing-plans');
  assert.equal(matchCommands(all, 'search')[0].name, 'mind:search');
  assert.equal(matchCommands(all, 'zzz').length, 0);
});

test('past conversations: titles from the first real prompt, newest first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-home-'));
  const cwd = '/Users/me/my repo';
  const dir = path.join(home, '.claude', 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(dir, `${a}.jsonl`), [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<command-name>x</command-name>' } }),
    JSON.stringify({ type: 'user', message: { content: 'Fix the flaky dbt test' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'Wallet history model' }) + '\n');
  fs.writeFileSync(path.join(dir, 'not-a-session.jsonl'), '');
  fs.utimesSync(path.join(dir, `${a}.jsonl`), new Date(1000), new Date(1000));
  const list = listPastConversations(cwd, home);
  assert.deepEqual(list.map((p) => [p.id, p.title]), [[b, 'Wallet history model'], [a, 'Fix the flaky dbt test']]);
  assert.equal(projectSlug('/Users/example/projects/Personal Workspace'), '-Users-example-projects-Personal-Workspace');
  fs.rmSync(home, { recursive: true, force: true });
});
