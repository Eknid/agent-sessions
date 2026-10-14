import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { SessionManager } from '../src/core/sessionManager';
import { Transcript } from '../src/core/transcript';
import { discoverModels, modelChoices } from '../src/core/models';
import { listPastCodexConversations } from '../src/core/pastConversations';
import { catalogue, classify } from '../src/core/slashCommands';
import { PriceTable } from '../src/core/pricing';

const fake = path.join(__dirname, '../../test/fake-codex.js');
fs.chmodSync(fake, 0o755);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-codex-'));
const log = path.join(tmp, 'rpc.ndjson');
const managers: SessionManager[] = [];
after(async () => { await Promise.all(managers.map((m) => m.dispose())); fs.rmSync(tmp, { recursive: true, force: true }); });
const wire = (): any[] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
function manager(storage = fs.mkdtempSync(path.join(tmp, 'store-')), extraEnv: NodeJS.ProcessEnv = {}) {
  const m = new SessionManager({ storageDir: storage, command: '/nonexistent/claude', codexCommand: fake, env: { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_STATE_DIR: tmp, ...extraEnv } });
  managers.push(m);
  return m;
}
async function until(pred: () => boolean) {
  const end = Date.now() + 5000;
  while (!pred()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test('Changing a rejected saved Codex model resumes the same thread and pins every turn', async () => {
  const storage = path.join(tmp, 'model-recovery');
  const m = manager(storage, { FAKE_CODEX_REJECT_MODEL: 'gpt-6.1-sol' });
  const id = m.create({ cwd: tmp, provider: 'codex', model: 'gpt-6.1-sol', prompt: 'first attempt' });
  await until(() => m.view(id)?.turns === 1);
  const thread = m.stored(id)!.conversationId;
  assert.match(m.view(id)!.lastError!, /not supported/);
  await m.stopAndWait(id);
  const restored = manager(storage, { FAKE_CODEX_REJECT_MODEL: 'gpt-6.1-sol' });
  restored.load();
  await restored.changeCodexModel(id, 'codex-test');
  await until(() => restored.view(id)?.model === 'codex-test');
  assert.equal(restored.stored(id)!.conversationId, thread);
  assert.equal(restored.stored(id)!.model, 'codex-test');
  assert.ok(wire().some((r) => r.method === 'thread/resume' && r.params.threadId === thread && r.params.model === 'codex-test'));
  restored.send(id, 'try again');
  await until(() => restored.view(id)?.turns === 2);
  assert.ok(wire().some((r) => r.method === 'turn/start' && r.params.threadId === thread && r.params.model === 'codex-test'));
  assert.ok(restored.records(id).some((r) => r.dir === 'out' && r.ev.message?.content === 'first attempt'), 'Original prompt stays in the session history');
  assert.equal(restored.view(id)!.lastError, undefined);
  await restored.stopAndWait(id);
  const reloaded = manager(storage);
  reloaded.load();
  assert.equal(reloaded.stored(id)!.model, 'codex-test');
  assert.equal(reloaded.view(id)!.model, 'codex-test');
});

test('Changing a Codex model cannot discard a running turn', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex', model: 'codex-test', prompt: 'slow' });
  await until(() => m.records(id).some((r) => r.ev.subtype === 'init'));
  await assert.rejects(m.changeCodexModel(id, 'gpt-5.6-sol'), /Interrupt or finish/);
  assert.equal(m.isAlive(id), true);
  assert.equal(m.stored(id)!.model, 'codex-test');
  m.interrupt(id);
  await until(() => m.view(id)?.turns === 1);
});

test('Codex medium effort defaults, updates native settings and persists across turns and reload', async () => {
  const storage = path.join(tmp, 'effort');
  const m = manager(storage);
  const id = m.create({ cwd: tmp, provider: 'codex', model: 'codex-test', prompt: 'first' });
  await until(() => m.view(id)?.turns === 1 && !!m.view(id)?.accountUsage);
  const threadId = m.stored(id)!.conversationId;
  assert.equal(m.view(id)?.effort, 'medium');
  assert.equal(m.view(id)?.accountUsage?.label, 'Usage left primary 77%');
  assert.ok(wire().some((r) => r.method === 'thread/start' && r.params.config?.model_reasoning_effort === 'medium'));
  assert.ok(wire().some((r) => r.method === 'turn/start' && r.params.threadId === threadId && r.params.effort === 'medium'));
  assert.deepEqual(await m.effortChoices(id), ['low', 'medium', 'high', 'xhigh']);
  await m.changeEffort(id, 'xhigh');
  assert.ok(wire().some((r) => r.method === 'thread/settings/update' && r.params.threadId === threadId && r.params.effort === 'xhigh'));
  m.send(id, 'second');
  await until(() => m.view(id)?.turns === 2);
  assert.ok(wire().some((r) => r.method === 'turn/start' && r.params.threadId === threadId && r.params.effort === 'xhigh'));
  await m.stopAndWait(id);
  const restored = manager(storage); restored.load();
  assert.equal(restored.view(id)?.effort, 'xhigh');
  await restored.refreshUsage(id);
  assert.equal(restored.view(id)?.accountUsage?.label, 'Usage left primary 77%');
  assert.equal(restored.isAlive(id), false);
  assert.equal(restored.view(id)?.turns, 2);
  restored.resume(id);
  await until(() => restored.records(id).some((r) => r.ev.subtype === 'init' && r.t > m.records(id)[0].t));
  await until(() => wire().some((r) => r.method === 'thread/resume' && r.params.threadId === threadId && r.params.config.model_reasoning_effort === 'xhigh'));
});

test('Codex lifecycle: independent thread ID, permission, usage, transcript, reload and resume', async () => {
  const storage = path.join(tmp, 'lifecycle');
  const m = manager(storage);
  const id = m.create({ cwd: tmp, provider: 'codex', model: 'codex-test', prompt: 'permission' });
  await until(() => m.view(id)?.uiState === 'waiting');
  const thread = m.stored(id)!.conversationId!;
  assert.notEqual(thread, id);
  assert.equal(m.resumeId(id), thread, 'copy/resume exposes the native Codex thread ID');
  assert.equal(m.view(id)?.provider, 'codex');
  const req = m.view(id)!.pending[0];
  assert.equal(req.toolName, 'Bash');
  assert.ok(m.allow(id, req.requestId));
  await until(() => m.view(id)?.turns === 1);
  assert.equal(m.view(id)?.tokens.input, 80);
  assert.equal(m.view(id)?.tokens.cacheRead, 20);
  assert.equal(m.view(id)?.owners[0].contextWindow, 200000);
  assert.equal(m.view(id)?.costAvailable, false);
  assert.equal(m.view(id)?.costUsd, 0, 'Never estimate Codex at Claude prices');
  const transcript = new Transcript({ owner: 'main' });
  for (const rec of m.records(id)) transcript.apply(rec);
  assert.ok(transcript.all().some((item) => item.kind === 'text' && item.markdown === 'approved'));
  assert.equal(transcript.all().filter((item) => item.kind === 'text' && item.markdown === 'approved').length, 1, 'Streaming text is updated in place');
  m.stop(id);
  await until(() => m.view(id)?.state === 'exited');
  const restored = manager(storage);
  restored.load();
  assert.equal(restored.view(id)?.provider, 'codex');
  assert.equal(restored.stored(id)?.conversationId, thread);
  restored.send(id, 'hello again');
  await until(() => restored.view(id)?.turns === 2);
  assert.ok(wire().some((r) => r.method === 'thread/resume' && r.params.threadId === thread));
});

test('Codex queue, interruption, image input and question answers use the native RPC shapes', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex', prompt: 'slow' });
  await until(() => wire().some((r) => r.method === 'turn/start' && r.params.threadId === m.stored(id)?.conversationId));
  m.send(id, 'next', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
  assert.equal(m.queue(id).length, 1);
  m.interrupt(id);
  await until(() => m.view(id)?.turns === 2);
  assert.equal(m.queue(id).length, 0);
  assert.ok(wire().some((r) => r.params?.input?.some((b: any) => b.url === 'data:image/png;base64,aGVsbG8=')));
  m.send(id, 'question');
  await until(() => m.view(id)?.waitReason === 'question');
  m.answer(id, m.view(id)!.pending[0].requestId, { 'Which option?': 'A' });
  await until(() => m.view(id)?.turns === 3);
  assert.ok(wire().some((r) => r.result?.answers?.q1?.answers?.[0] === 'A'));
  assert.equal(classify('/compact', m.slashCommands(id)).kind, 'local');
  assert.equal(classify('/model', m.slashCommands(id)).kind, 'local');
  assert.equal(classify('/unknown', m.slashCommands(id)).kind, 'unsupported');
});

test('Codex forks its native conversation and tracks subagents in their own transcript', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex', prompt: 'agent' });
  await until(() => m.view(id)?.turns === 1);
  const child = m.view(id)!.owners.find((o) => o.id === 'codex-agent:child')!;
  assert.equal(child.state, 'completed');
  const transcript = new Transcript({ owner: child.id });
  for (const rec of m.records(id)) transcript.apply(rec);
  assert.ok(transcript.all().some((i) => i.kind === 'text' && i.markdown === 'found it'));
  const fork = m.fork(id)!;
  assert.ok(fork);
  await until(() => !!m.stored(fork)?.conversationId);
  assert.notEqual(m.stored(fork)?.conversationId, m.stored(id)?.conversationId);
  assert.ok(wire().some((r) => r.method === 'thread/fork' && r.params.threadId === m.stored(id)?.conversationId));
  m.send(fork, 'forked');
  await until(() => m.view(fork)?.turns === 1);
  assert.equal(m.view(id)?.turns, 1);
});

test('Codex missing executable exits and clears running state', async () => {
  const m = manager();
  m.setCodex('/nonexistent/codex');
  const id = m.create({ cwd: tmp, provider: 'codex', prompt: 'hello' });
  await until(() => m.view(id)?.state === 'exited');
  assert.match(m.view(id)!.lastError!, /could not start codex/);
});

test('Codex decline queues user feedback, permissions are explicit, and configured prices are estimates', async () => {
  const m = manager();
  m.setPrices(new PriceTable({ 'codex-test': { input: 2, output: 8, cacheRead: 0.5 } }));
  const id = m.create({ cwd: tmp, provider: 'codex', prompt: 'permission' });
  await until(() => m.view(id)?.uiState === 'waiting');
  m.deny(id, m.view(id)!.pending[0].requestId, 'Use another approach');
  await until(() => m.view(id)?.turns === 2);
  assert.ok(wire().some((r) => r.params?.input?.some((b: any) => b.text === 'Use another approach')));
  assert.equal(m.view(id)?.costAvailable, true);
  assert.equal(m.view(id)?.costIsEstimate, true);
  assert.ok(Math.abs(m.view(id)!.costUsd - 0.0005) < 1e-9);
  m.send(id, 'grant');
  await until(() => m.view(id)?.uiState === 'waiting');
  assert.equal(m.view(id)!.pending[0].toolName, 'Permissions');
  m.allow(id, m.view(id)!.pending[0].requestId);
  await until(() => m.view(id)?.turns === 3);
  assert.ok(wire().some((r) => r.result?.permissions?.network?.enabled === true && r.result.scope === 'turn'));
});

test('model discovery includes all Codex pages and hidden models, and versioned Claude choices', async () => {
  const discovered = await discoverModels('codex', fake, tmp);
  assert.deepEqual(discovered.map((m) => m.value), ['codex-test', 'codex-hidden']);
  const choices = modelChoices('claude', [{ label: 'Opus 5.5', value: 'claude-opus-5-5' }], '', ['my-deployment']);
  assert.equal(choices.filter((m) => m.value === 'claude-opus-5-5').length, 1);
  assert.ok(choices.some((m) => m.value === 'claude-opus-4-8'));
  assert.ok(choices.some((m) => m.value === 'my-deployment'));
  assert.ok(choices.some((m) => m.value === '__custom__'));
  const past = await listPastCodexConversations(tmp, fake);
  assert.equal(past[0].title, 'Earlier Codex conversation');
  const claude = await discoverModels('claude', path.join(__dirname, '../../test/fake-claude.js'), tmp);
  assert.deepEqual(claude.map((m) => m.value), ['claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-1-20250805']);
});

test('Codex slash catalogue includes native operations, local skills and remote plugin skills', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex' });
  await until(() => m.view(id)?.state === 'idle');
  const all = catalogue(m.slashCommands(id));
  for (const name of ['goal', 'compact', 'review', 'skills', 'mcp', 'usage']) {
    assert.equal(classify('/' + name, m.slashCommands(id)).kind, 'local');
    assert.ok(all.some((c) => c.name === name));
  }
  assert.equal(all.find((c) => c.name === 'test-skill')?.kind, 'skill');
  assert.equal(all.find((c) => c.name === 'test-plugin:remote-skill')?.kind, 'skill');
  assert.ok(!all.some((c) => c.name === 'disabled-skill' || c.name.startsWith('disabled:')));
  m.send(id, '/test-skill perform the task');
  await until(() => m.view(id)?.turns === 1);
  assert.ok(wire().some((r) => r.method === 'turn/start' && r.params.threadId === m.stored(id)?.conversationId
    && r.params.input.some((b: any) => b.type === 'skill' && b.path === '/tmp/test-skill/SKILL.md')
    && r.params.input.some((b: any) => b.text === '$test-skill perform the task')));
  m.send(id, '/test-plugin:remote-skill use the plugin');
  await until(() => m.view(id)?.turns === 2);
  assert.ok(wire().some((r) => r.method === 'turn/start' && r.params.threadId === m.stored(id)?.conversationId
    && r.params.input.some((b: any) => b.type === 'mention' && b.path === 'plugin://test-plugin@test-marketplace')
    && r.params.input.some((b: any) => b.text === '$test-plugin:remote-skill use the plugin')));
  await m.stopAndWait(id);
  assert.equal(classify('/test-skill continue', m.slashCommands(id)).kind, 'headless', 'Skills remain invocable after /exit');
  m.send(id, '/test-skill continue');
  await until(() => m.view(id)?.turns === 3);
  assert.equal(m.view(id)?.state, 'idle');
});

test('Codex goal lifecycle, compaction and review use native RPCs on the same thread', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex' });
  assert.match(await m.codexCommand(id, 'goal'), /No active goal/);
  const threadId = m.stored(id)!.conversationId;
  assert.match(await m.codexCommand(id, 'goal', 'Fix the failing build'), /Status: active/);
  assert.match(await m.codexCommand(id, 'goal', 'pause'), /Status: paused/);
  assert.match(await m.codexCommand(id, 'goal', 'resume'), /Status: active/);
  assert.equal(await m.codexCommand(id, 'goal', 'clear'), 'Goal cleared.');
  assert.match(await m.codexCommand(id, 'skills', 'reload'), /test-plugin:remote-skill/);
  assert.match(await m.codexCommand(id, 'mcp'), /test-mcp/);
  assert.match(await m.codexCommand(id, 'usage'), /23% used/);
  await assert.rejects(m.codexCommand(id, 'compact', 'unexpected args'), /without arguments/);
  await m.codexCommand(id, 'compact');
  await m.codexCommand(id, 'review');
  await until(() => m.view(id)?.state === 'running');
  await assert.rejects(m.codexCommand(id, 'compact'), /Interrupt or finish/);
  await until(() => m.view(id)?.turns === 1);
  const requests = wire().filter((r) => r.params?.threadId === threadId);
  assert.ok(requests.some((r) => r.method === 'thread/goal/set' && r.params.objective === 'Fix the failing build' && r.params.origin === 'user'));
  assert.ok(requests.some((r) => r.method === 'thread/goal/clear' && r.params.origin === 'user'));
  assert.ok(requests.some((r) => r.method === 'thread/compact/start'));
  assert.ok(requests.some((r) => r.method === 'review/start' && r.params.target.type === 'uncommittedChanges'));
  assert.ok(!requests.some((r) => r.method === 'turn/start'), 'Native operations never become slash-command prompts');
});

test('Interrupting a Codex turn pauses its active goal before stopping the turn', async () => {
  const m = manager();
  const id = m.create({ cwd: tmp, provider: 'codex' });
  await m.codexCommand(id, 'goal', 'Fix the project');
  m.send(id, 'slow');
  await until(() => wire().some((r) => r.method === 'turn/start' && r.params.threadId === m.stored(id)?.conversationId));
  m.interrupt(id);
  await until(() => m.view(id)?.turns === 1);
  assert.match(await m.codexCommand(id, 'goal'), /Status: paused/);
});

test('published Codex pricing appears automatically, survives reload and excludes inherited fork usage', async () => {
  const storage = path.join(tmp, 'published-pricing');
  const m = manager(storage);
  const id = m.create({ cwd: tmp, provider: 'codex', model: 'gpt-6.1-sol', prompt: 'hello' });
  await until(() => m.view(id)?.turns === 1);
  assert.equal(m.view(id)?.costAvailable, true);
  assert.equal(m.view(id)?.costIsEstimate, true);
  assert.ok(Math.abs(m.view(id)!.costUsd - 0.000262) < 1e-12);
  await m.stopAndWait(id);
  const restored = manager(storage);
  restored.load();
  assert.ok(Math.abs(restored.view(id)!.costUsd - 0.000262) < 1e-12);
  restored.send(id, 'resume');
  await until(() => restored.view(id)?.turns === 2);
  assert.ok(Math.abs(restored.view(id)!.costUsd - 0.000524) < 1e-12);
  const fork = restored.fork(id)!;
  restored.send(fork, 'fork');
  await until(() => restored.view(fork)?.turns === 1);
  assert.equal(restored.view(fork)?.tokens.input, 80);
  assert.ok(Math.abs(restored.view(fork)!.costUsd - 0.000262) < 1e-12);
});
