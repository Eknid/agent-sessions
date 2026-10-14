import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { SessionManager } from '../src/core/sessionManager';
import { UiState } from '../src/core/sessionModel';

const FAKE = path.join(__dirname, '..', '..', 'test', 'fake-claude.js');
fs.chmodSync(FAKE, 0o755);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-test-'));
const argsFile = path.join(tmp, 'args.ndjson');
const env = { ...process.env, FAKE_CLAUDE_ARGS_FILE: argsFile };
const managers: SessionManager[] = [];
after(async () => {
  await Promise.all(managers.map((m) => m.dispose()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function manager() {
  const m = new SessionManager({ storageDir: path.join(tmp, 'store'), command: FAKE, env });
  managers.push(m);
  return m;
}

function waitFor(m: SessionManager, id: string, pred: () => boolean, label: string, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const timer = setTimeout(() => {
      m.off('changed', check);
      reject(new Error(`timeout waiting for ${label}; state=${m.view(id)?.state}`));
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

const spawnedArgs = (): string[][] =>
  fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];


/** The fake writes its argv when it starts; wait for spawn number `n`. */
async function nthSpawn(n: number): Promise<string[]> {
  for (let i = 0; i < 100 && spawnedArgs().length < n; i++) await new Promise((r) => setTimeout(r, 20));
  return spawnedArgs()[n - 1];
}

test('full lifecycle: permission round-trip, subagent, persistence, resume', async () => {
  const m = manager();
  const transitions: [UiState, UiState][] = [];
  m.on('transition', (_id, from, to) => transitions.push([from, to]));

  const id = m.create({ cwd: tmp, name: 'demo', model: 'sonnet', prompt: 'please ask permission' });
  assert.equal(m.resumeId(id), id, 'Claude uses the managed session UUID as its resume ID');
  await waitFor(m, id, () => m.view(id)!.uiState === 'waiting', 'waiting');
  const v = m.view(id)!;
  assert.equal(v.pending[0].toolName, 'Bash');
  assert.equal(v.waitReason, 'permission');

  const args = spawnedArgs()[0];
  for (const flag of ['-p', '--forward-subagent-text', '--verbose']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(args[args.indexOf('--session-id') + 1], id);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');

  assert.ok(m.allow(id, v.pending[0].requestId, true));
  await waitFor(m, id, () => m.view(id)!.uiState === 'done', 'done after allow');
  const out = m.records(id).filter((r) => r.dir === 'out');
  assert.deepEqual(out[1].ev.response.response.updatedPermissions, [{ type: 'addRules' }], '"always" forwards the suggestions');

  m.send(id, 'spawn an agent');
  await waitFor(m, id, () => m.view(id)!.turns === 2, 'second turn');
  const sub = m.view(id)!.owners.find((o) => o.id === 'tu_agent')!;
  assert.equal(sub.state, 'completed');
  assert.equal(sub.agentType, 'Explore');
  assert.deepEqual(sub.modelsSeen, ['claude-haiku-4-5']);
  assert.ok(Math.abs(m.view(id)!.costUsd - 0.02) < 1e-9);

  assert.deepEqual(transitions, [
    ['done', 'running'],
    ['running', 'waiting'],
    ['waiting', 'running'],
    ['running', 'done'],
    ['done', 'running'],
    ['running', 'done'],
  ]);

  // A second manager on the same storage = VS Code reloaded: history replays, process is gone.
  const m2 = manager();
  m2.load();
  const r = m2.view(id)!;
  assert.equal(r.state, 'exited');
  assert.equal(r.exitInfo, 'VS Code restarted');
  assert.equal(r.name, 'demo');
  assert.equal(r.turns, 2);
  assert.ok(Math.abs(r.costUsd - 0.02) < 1e-9);
  assert.equal(r.owners.length, 2);

  // Sending to an exited session resumes it with --resume.
  m2.send(id, 'hello again');
  await waitFor(m2, id, () => m2.view(id)!.turns === 3, 'resumed turn');
  const resumed = spawnedArgs()[1];
  assert.equal(resumed[resumed.indexOf('--resume') + 1], id);
  assert.ok(!resumed.includes('--session-id'));
});

test('a listener answering synchronously still sees every transition in order', async () => {
  const m = manager();
  const seen: string[] = [];
  m.on('transition', (_id, from, to) => seen.push(`${from}>${to}`));
  m.on('changed', (sid) => {
    const p = m.view(sid)?.pending[0];
    if (p) m.allow(sid, p.requestId);
  });
  const id = m.create({ cwd: tmp, prompt: 'please ask permission' });
  await waitFor(m, id, () => m.view(id)!.uiState === 'done', 'done');
  assert.deepEqual(seen, ['done>running', 'running>waiting', 'waiting>running', 'running>done']);
});

test('adopting a past conversation spawns with --resume under its own id', async () => {
  const m = manager();
  const past = '33333333-3333-4333-8333-333333333333';
  const before = spawnedArgs().length;
  const id = m.create({ cwd: tmp, resumeId: past, name: 'old one' });
  assert.equal(id, past);
  assert.equal(m.create({ cwd: tmp, resumeId: past }), past, 'already tracked: no second process');
  const args = await nthSpawn(before + 1);
  assert.equal(args[args.indexOf('--resume') + 1], past);
  m.send(id, 'hi');
  await waitFor(m, id, () => m.view(id)!.turns === 1, 'turn on adopted session');
  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'stopped');
  m.resume(id);
  const again = await nthSpawn(before + 2);
  assert.ok(again.includes('--resume'), 'resuming an adopted session keeps --resume');
});

test('fork continues a copy of the conversation under a new id', async () => {
  const m = manager();
  const parent = m.create({ cwd: tmp, name: 'parent', prompt: 'hi' });
  await waitFor(m, parent, () => m.view(parent)!.turns === 1, 'parent turn');
  const parentCost = m.view(parent)!.costUsd;
  assert.ok(parentCost > 0);

  const before = spawnedArgs().length;
  const id = m.fork(parent)!;
  assert.notEqual(id, parent);
  assert.equal(m.view(id)!.name, 'parent (fork)');
  const args = await nthSpawn(before + 1);
  assert.equal(args[args.indexOf('--resume') + 1], parent);
  assert.ok(args.includes('--fork-session'));
  assert.equal(args[args.indexOf('--session-id') + 1], id);
  assert.ok(m.records(id).some((r) => r.dir === 'out' && r.ev.type === 'user'), 'history copied');
  assert.equal(m.view(id)!.costUsd, 0, 'parent cost is not counted again');
  assert.equal(m.view(id)!.turns, 0);
  assert.equal(m.canFork(id), false, 'nothing of its own on disk yet');

  // Stopped before its first message: the next start forks again.
  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'fork stopped');
  m.resume(id);
  const again = await nthSpawn(before + 2);
  assert.ok(again.includes('--fork-session'));

  m.send(id, 'hello fork');
  await waitFor(m, id, () => m.view(id)!.turns === 1, 'fork turn');
  assert.ok(Math.abs(m.view(id)!.costUsd - 0.01) < 1e-9, 'only the fork\'s own turn');
  assert.equal(m.view(parent)!.costUsd, parentCost, 'parent untouched');
  assert.equal(m.canFork(id), true);
  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'fork stopped again');
  m.resume(id);
  const resumed = await nthSpawn(before + 3);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], id);
  assert.ok(!resumed.includes('--fork-session'));
});

test('archive stops the process, survives a reload, and a new message brings it back', async () => {
  const store = path.join(tmp, 'store-archive');
  const m = new SessionManager({ storageDir: store, command: FAKE, env });
  managers.push(m);
  const id = m.create({ cwd: tmp, name: 'old', prompt: 'hi' });
  await waitFor(m, id, () => m.view(id)!.turns === 1, 'first turn');
  m.archive(id);
  assert.equal(m.view(id)!.archived, true);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'stopped by archive');

  const m2 = new SessionManager({ storageDir: store, command: FAKE, env });
  managers.push(m2);
  m2.load();
  assert.equal(m2.view(id)!.archived, true, 'persisted');
  m2.send(id, 'back to work');
  assert.equal(m2.view(id)!.archived, undefined);
  await waitFor(m2, id, () => m2.view(id)!.turns === 2, 'turn after unarchive');
});

test('messages sent while Claude works wait in the queue and go out one per turn', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, prompt: 'please ask permission' });
  await waitFor(m, id, () => m.view(id)!.uiState === 'waiting', 'waiting');
  const userMessages = () => m.records(id).filter((r) => r.dir === 'out' && r.ev.type === 'user').map((r) => r.ev.message.content);

  m.send(id, 'first after');
  m.send(id, 'second after');
  m.send(id, 'dropped');
  assert.deepEqual(m.queue(id).map((q) => q.text), ['first after', 'second after', 'dropped']);
  assert.deepEqual(userMessages(), ['please ask permission'], 'nothing written while the turn is under way');
  assert.ok(m.unqueue(id, m.queue(id)[2].id));
  assert.equal(m.unqueue(id, 'nope'), false);

  m.allow(id, m.view(id)!.pending[0].requestId);
  await waitFor(m, id, () => m.view(id)!.turns === 3, 'both queued turns');
  assert.deepEqual(userMessages(), ['please ask permission', 'first after', 'second after'], 'in order, one per turn');
  assert.equal(m.queue(id).length, 0);

  // A stopped session keeps its queue until it runs again.
  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'stopped');
  m.send(id, 'after restart');
  await waitFor(m, id, () => m.view(id)!.turns === 4, 'turn after restart');
  assert.equal(userMessages().at(-1), 'after restart');
});

test('stop, rename, remove', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, prompt: 'hi' });
  await waitFor(m, id, () => m.view(id)!.uiState === 'done', 'first turn');
  m.rename(id, 'renamed');
  assert.equal(m.view(id)!.name, 'renamed');
  m.stop(id);
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'exited');
  assert.equal(m.isAlive(id), false);
  const id2 = m.create({ cwd: tmp, prompt: 'hi' });
  await waitFor(m, id2, () => m.view(id2)!.uiState === 'done', 'second session');
  m.remove(id2); // removing a live session must not resurrect its log when the process exits
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(tmp, 'store', 'logs', `${id2}.ndjson`)), false);
  m.remove(id);
  assert.equal(m.view(id), undefined);
  assert.equal(fs.existsSync(path.join(tmp, 'store', 'logs', `${id}.ndjson`)), false);
});

test('missing executable surfaces an error instead of hanging', async () => {
  const m = new SessionManager({ storageDir: path.join(tmp, 'store2'), command: '/nonexistent/claude', env });
  managers.push(m);
  const id = m.create({ cwd: tmp });
  await waitFor(m, id, () => m.view(id)!.state === 'exited', 'exited');
  assert.match(m.view(id)!.lastError ?? '', /could not start claude/);
});

test('Claude effort changes use native controls, keep the conversation and show assigned credits before a prompt', async () => {
  const storageDir = path.join(tmp, 'effort-store');
  const wireLog = path.join(tmp, 'effort-wire.ndjson');
  const m = new SessionManager({ storageDir, command: FAKE, env: { ...env, FAKE_CLAUDE_LOG: wireLog } });
  managers.push(m);
  const id = m.create({ cwd: tmp, model: 'claude-opus-5-5' });
  await waitFor(m, id, () => !!m.view(id)?.accountUsage, 'account credits');
  assert.equal(m.view(id)?.accountUsage?.label, 'Credits left 55.3%');
  assert.equal(m.view(id)?.effort, 'medium');
  assert.equal(m.view(id)?.turns, 0);
  assert.deepEqual(await m.effortChoices(id), ['low', 'medium', 'high', 'xhigh', 'max']);
  await m.changeEffort(id, 'high');
  const messages = fs.readFileSync(wireLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(messages.some((ev) => ev.request?.subtype === 'apply_flag_settings' && ev.request.settings.effortLevel === 'high'));
  assert.equal(m.view(id)?.effort, 'high');
  m.send(id, 'first');
  await waitFor(m, id, () => m.view(id)?.turns === 1, 'first turn');
  const fork = m.fork(id)!;
  assert.equal(m.view(fork)?.effort, 'high');
  await m.stopAndWait(id);
  const restored = new SessionManager({ storageDir, command: FAKE, env }); managers.push(restored); restored.load();
  assert.equal(restored.view(id)?.effort, 'high');
  await restored.refreshUsage(id);
  assert.equal(restored.view(id)?.accountUsage?.label, 'Credits left 55.3%');
  assert.equal(restored.isAlive(id), false, 'Usage lookup must not resume a stopped conversation');
  assert.equal(restored.view(id)?.turns, 1);
});
