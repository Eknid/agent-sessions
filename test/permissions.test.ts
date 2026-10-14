import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { SessionManager } from '../src/core/sessionManager';
import { claudePermissionView, codexPermissionView, codexPermissionPreset } from '../src/core/permissions';
import { catalogue, classify } from '../src/core/slashCommands';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-permissions-'));
const claude = path.join(__dirname, '../../test/fake-claude.js');
const codex = path.join(__dirname, '../../test/fake-codex.js');
const managers: SessionManager[] = [];
after(async () => { await Promise.all(managers.map((m) => m.dispose())); fs.rmSync(tmp, { recursive: true, force: true }); });
function manager(storageDir: string, log: string, env: NodeJS.ProcessEnv = {}) {
  const m = new SessionManager({ storageDir, command: claude, codexCommand: codex,
    env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CODEX_LOG: log, FAKE_CODEX_STATE_DIR: tmp, ...env } });
  managers.push(m); return m;
}
const messages = (log: string): any[] => fs.readFileSync(log, 'utf8').trim().split('\n').map((s) => JSON.parse(s));
async function until(predicate: () => boolean) {
  for (let i = 0; !predicate(); i++) { if (i > 500) throw new Error('Timeout'); await new Promise((r) => setTimeout(r, 10)); }
}

test('Claude auto mode changes live without answering a pending approval and survives fork/reload/resume', async () => {
  const storage = path.join(tmp, 'claude'); const log = path.join(tmp, 'claude-wire');
  const m = manager(storage, log);
  const id = m.create({ cwd: tmp, permissionMode: 'default', prompt: 'permission' });
  await until(() => m.view(id)?.uiState === 'waiting');
  assert.equal(m.view(id)?.permissions?.label, 'Ask for approval');
  await m.changePermissions(id, 'auto');
  assert.equal(m.view(id)?.permissions?.label, 'Auto mode');
  assert.equal(m.view(id)?.pending.length, 1);
  assert.equal(m.view(id)?.turns, 0);
  assert.ok(messages(log).some((ev) => ev.request?.subtype === 'set_permission_mode' && ev.request.mode === 'auto'));
  assert.ok(!messages(log).some((ev) => ev.type === 'control_response' && ev.response.request_id === 'perm_1'));
  m.allow(id, m.view(id)!.pending[0].requestId);
  await until(() => m.view(id)?.turns === 1);
  const fork = m.fork(id)!; assert.equal(m.stored(fork)?.permissionMode, 'auto');
  await m.stopAndWait(id); await m.stopAndWait(fork);
  const restored = manager(storage, log); restored.load();
  assert.equal(restored.view(id)?.permissions?.value, 'auto');
  restored.resume(id); restored.send(id, 'continue');
  await until(() => restored.view(id)?.turns === 2);
  const spawns = restored.records(id).filter((r) => r.ev.type === 'spawn');
  assert.ok(spawns.at(-1)!.ev.args.includes('auto'));
  assert.equal(restored.stored(id)?.id, id);
  await restored.changePermissions(id, 'default');
  assert.equal(restored.view(id)?.permissions?.label, 'Ask for approval');
});

test('A rejected Claude permission switch keeps the previous selection and leaves chat usable', async () => {
  const m = manager(path.join(tmp, 'claude-rejection'), path.join(tmp, 'claude-rejection-wire'), { FAKE_CLAUDE_REJECT_PERMISSION: 'auto' });
  const id = m.create({ cwd: tmp, permissionMode: 'acceptEdits' });
  await assert.rejects(m.changePermissions(id, 'auto'), /disallowed by organization/);
  assert.equal(m.stored(id)?.permissionMode, 'acceptEdits');
  assert.equal(m.view(id)?.permissions?.label, 'Accept edits');
  m.send(id, 'still works'); await until(() => m.view(id)?.turns === 1);
  await assert.rejects(m.changePermissions(id, 'made-up'), /Invalid permission/);
});

test('Codex Approve for me sets the native reviewer, retains its sandbox, and persists across turns/forks/resume', async () => {
  const storage = path.join(tmp, 'codex'); const log = path.join(tmp, 'codex-wire');
  const m = manager(storage, log);
  const id = m.create({ cwd: tmp, provider: 'codex', prompt: 'first' });
  await until(() => m.view(id)?.turns === 1);
  const threadId = m.stored(id)!.conversationId;
  await m.changePermissions(id, 'auto');
  assert.equal(m.view(id)?.permissions?.label, 'Approve for me');
  const update = messages(log).find((ev) => ev.method === 'thread/settings/update' && ev.params.approvalsReviewer === 'auto_review');
  assert.equal(update.params.threadId, threadId);
  assert.equal(update.params.approvalPolicy, 'on-request');
  assert.deepEqual(update.params.sandboxPolicy.writableRoots, [tmp]);
  assert.equal(update.params.sandboxPolicy.networkAccess, false);
  m.send(id, 'next'); await until(() => m.view(id)?.turns === 2);
  const turn = messages(log).filter((ev) => ev.method === 'turn/start').at(-1);
  assert.equal(turn.params.approvalsReviewer, 'auto_review');
  assert.equal(turn.params.approvalPolicy, 'on-request');
  assert.equal(turn.params.sandboxPolicy.type, 'workspaceWrite');
  const fork = m.fork(id)!; assert.deepEqual(m.stored(fork)?.codexPermissions, m.stored(id)?.codexPermissions);
  await m.stopAndWait(fork); await m.stopAndWait(id);
  const restored = manager(storage, log); restored.load();
  assert.equal(restored.view(id)?.permissions?.label, 'Approve for me');
  restored.resume(id);
  await until(() => messages(log).some((ev) => ev.method === 'thread/resume' && ev.params.threadId === threadId && ev.params.approvalsReviewer === 'auto_review'));
  assert.equal(restored.stored(id)?.conversationId, threadId);
  await restored.changePermissions(id, 'readOnly');
  assert.equal(restored.view(id)?.permissions?.label, 'Read only');
  assert.equal(messages(log).filter((ev) => ev.method === 'thread/settings/update').at(-1).params.sandboxPolicy.type, 'readOnly');
  await restored.changePermissions(id, 'fullAccess');
  const full = messages(log).filter((ev) => ev.method === 'thread/settings/update').at(-1);
  assert.equal(full.params.approvalPolicy, 'never');
  assert.equal(full.params.sandboxPolicy.type, 'dangerFullAccess');
  await restored.changePermissions(id, 'ask');
  assert.equal(restored.view(id)?.permissions?.label, 'Ask for approval');
});

test('Codex managed rejection does not silently fall back to another permission mode', async () => {
  const m = manager(path.join(tmp, 'codex-reject'), path.join(tmp, 'codex-reject-wire'), { FAKE_CODEX_REJECT_REVIEWER: 'auto_review' });
  const id = m.create({ cwd: tmp, provider: 'codex', codexPermissions: codexPermissionPreset('readOnly') });
  await until(() => m.records(id).some((r) => r.ev.subtype === 'init'));
  await assert.rejects(m.changePermissions(id, 'auto'), /disallowed by organization/);
  assert.equal(m.view(id)?.permissions?.label, 'Read only');
  assert.equal(m.stored(id)?.codexPermissions?.sandbox, 'read-only');
});

test('Labels distinguish custom/no-review settings and /permissions is handled locally for both providers', () => {
  assert.equal(codexPermissionView({ sandbox: 'workspace-write', approvalPolicy: 'never' }).label, 'Custom permissions');
  assert.equal(codexPermissionView({ sandboxPolicy: { type: 'workspaceWrite', networkAccess: true }, approvalPolicy: 'on-request' }).value, 'custom');
  assert.equal(claudePermissionView('manual').label, 'Ask for approval');
  const cmds = { headless: [], terminalOnly: ['permissions'] };
  assert.deepEqual(classify('/permissions', cmds), { kind: 'local', name: 'permissions', args: '' });
  assert.equal(catalogue(cmds).filter((c) => c.name === 'permissions').length, 1);
});
