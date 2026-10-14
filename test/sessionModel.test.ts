import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogRecord } from '../src/core/events';
import { PriceTable } from '../src/core/pricing';
import { MAIN, SessionModel, shownAgentState } from '../src/core/sessionModel';
import { loadFixture, newModel, replay } from './helpers';

const SUB_03 = 'toolu_018n5UN46acreWmpfDjM2XnN';
const SUB_01 = 'toolu_0179d7HCabxAkwJLwoaXfbEh';
const SUB_02 = 'toolu_019oXCiQF2wcad3TNoVDJ6Ag';

test('forwarded subagent: tokens deduplicated and attributed per owner', () => {
  const { model } = replay(loadFixture('03-forwarded-subagent-permission.ndjson'));
  const v = model.view();
  const main = v.owners.find((o) => o.id === MAIN)!;
  const sub = v.owners.find((o) => o.id === SUB_03)!;
  // Expected values computed independently from the raw stream (unique message ids only).
  assert.equal(main.tokens.total, 15867);
  assert.equal(sub.tokens.total, 6072);
  assert.equal(v.tokens.total, 15867 + 6072, 'session total = sum of owners');
  assert.equal(sub.parentId, MAIN);
  assert.equal(sub.state, 'completed');
  assert.equal(sub.agentType, 'general-purpose');
  assert.deepEqual(sub.modelsSeen, ['claude-haiku-4-5']);
  assert.equal(main.contextTokens, 31009);
  assert.equal(main.contextWindow, 200000, 'window taken from result.modelUsage');
  assert.equal(sub.contextTokens, 15699, 'subagent has its own context');
});

test('cost: authoritative from result, estimate close to it', () => {
  const { model } = replay(loadFixture('03-forwarded-subagent-permission.ndjson'));
  const v = model.view();
  assert.ok(Math.abs(v.costFinalUsd! - 0.05062725) < 1e-12);
  assert.ok(Math.abs(v.costUsd - 0.05062725) < 1e-12);
  assert.equal(v.costIsEstimate, false);
  const est = v.owners.reduce((s, o) => s + o.costUsd, 0);
  assert.ok(Math.abs(est - 0.05062725) / 0.05062725 < 0.1, `estimate ${est} within 10% of the billed cost`);
});

test('permission request drives the waiting state', () => {
  const records = loadFixture('03-forwarded-subagent-permission.ndjson');
  const idx = records.findIndex((r) => r.ev.type === 'control_request');
  const { model } = replay(records, (_r, i) => i > idx);
  const v = model.view();
  assert.equal(v.uiState, 'waiting');
  assert.equal(v.waitReason, 'permission');
  assert.equal(v.pending.length, 1);
  assert.equal(v.pending[0].toolName, 'Bash');
  assert.equal(v.pending[0].input.command, 'touch probe_perm.txt');

  const all = replay(records);
  assert.deepEqual(all.states, ['done', 'running', 'waiting', 'running', 'done']);
  assert.equal(all.model.view().state, 'exited');
});

test('subagent without forwarded messages: usage from the Agent tool result', () => {
  const { model } = replay(loadFixture('01-foreground-subagent.ndjson'));
  const v = model.view();
  const sub = v.owners.find((o) => o.id === SUB_01)!;
  assert.equal(sub.tokens.total, 15770);
  assert.equal(sub.state, 'completed');
  assert.equal(sub.label, 'test ping agent');
  assert.equal(v.owners.find((o) => o.id === MAIN)!.tokens.total, 15012);
  assert.equal(v.costUsd, 0.05559875);
});

test('background subagent: automatic follow-up turn flips back to running', () => {
  const { model, states } = replay(loadFixture('02-background-subagent.ndjson'));
  assert.deepEqual(states, ['done', 'running', 'done', 'running', 'done']);
  const v = model.view();
  const sub = v.owners.find((o) => o.id === SUB_02)!;
  assert.equal(sub.background, true);
  assert.equal(sub.state, 'completed');
  assert.equal(sub.tokens.total, 14355);
  assert.equal(sub.summary, 'PONG');
  assert.equal(v.turns, 2);
  assert.equal(v.costUsd, 0.0542426, 'cumulative total_cost_usd replaces, never sums');
});

test('AskUserQuestion becomes a question wait; background Bash is not a subagent', () => {
  const { model, states } = replay(loadFixture('05-ask-user-question.ndjson'), (r) => r.dir === 'meta' && r.ev.type === 'exit');
  assert.deepEqual(states, ['done', 'running', 'waiting', 'running', 'done', 'running', 'done']);
  const v = model.view();
  assert.equal(v.owners.length, 1, 'local_bash background task is not listed as an agent');
  const records = loadFixture('05-ask-user-question.ndjson');
  const idx = records.findIndex((r) => r.ev.type === 'control_request');
  const w = replay(records, (_r, i) => i > idx).model.view();
  assert.equal(w.waitReason, 'question');
  assert.equal(w.pending[0].input.questions[0].options.length, 2);
});

function rec(dir: LogRecord['dir'], ev: LogRecord['ev'], t = 0): LogRecord {
  return { t, dir, ev };
}

const asst = (id: string, usage: object, parent: string | null = null, content: object[] = [{ type: 'text', text: 'x' }]) =>
  rec('in', { type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'claude-opus-5-5', usage, content } });

test('same message id is booked once; a larger later copy books only the delta', () => {
  const m = newModel();
  m.apply(rec('meta', { type: 'spawn' }));
  m.apply(rec('out', { type: 'user', message: { content: 'hi' } }));
  m.apply(asst('m1', { input_tokens: 10, output_tokens: 5 }));
  m.apply(asst('m1', { input_tokens: 10, output_tokens: 5 }));
  assert.equal(m.view().tokens.total, 15);
  m.apply(asst('m1', { input_tokens: 10, output_tokens: 50 }));
  assert.equal(m.view().tokens.total, 60);
  assert.equal(m.view().owners[0].messages, 1);
});

test('result with a still-running background agent keeps the session running', () => {
  const m = newModel();
  m.apply(rec('meta', { type: 'spawn' }));
  m.apply(rec('out', { type: 'user', message: { content: 'go' } }));
  m.apply(asst('m1', { input_tokens: 1, output_tokens: 1 }, null, [
    { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'scan', run_in_background: true, model: 'haiku' } },
  ]));
  m.apply(rec('in', { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu1', is_backgrounded: true, task_type: 'local_agent', subagent_type: 'Explore' }));
  m.apply(rec('in', { type: 'result', subtype: 'success', total_cost_usd: 0.01 }));
  let v = m.view();
  assert.equal(v.uiState, 'running');
  assert.equal(v.runningAgents, 1);
  assert.equal(v.owners[1].agentType, 'Explore');
  m.apply(rec('in', { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed' } }));
  m.apply(rec('in', { type: 'result', subtype: 'success', total_cost_usd: 0.02 }));
  v = m.view();
  assert.equal(v.uiState, 'done');
  assert.equal(v.costUsd, 0.02);
});

test('nested subagents link to the agent that spawned them', () => {
  const m = newModel();
  m.apply(rec('out', { type: 'user', message: { content: 'go' } }));
  m.apply(asst('m1', { input_tokens: 1 }, null, [{ type: 'tool_use', id: 'outer', name: 'Agent', input: { description: 'outer' } }]));
  m.apply(asst('m2', { input_tokens: 1 }, 'outer', [{ type: 'tool_use', id: 'inner', name: 'Agent', input: { description: 'inner' } }]));
  m.apply(asst('m3', { input_tokens: 7 }, 'inner'));
  const v = m.view();
  const inner = v.owners.find((o) => o.id === 'inner')!;
  assert.equal(inner.parentId, 'outer');
  assert.equal(inner.depth, 2);
  assert.equal(inner.tokens.total, 7);
});

test('cost across --resume: cumulative and non-cumulative CLIs', () => {
  const m = newModel();
  m.apply(rec('meta', { type: 'spawn' }));
  m.apply(rec('in', { type: 'result', total_cost_usd: 0.05 }));
  m.apply(rec('meta', { type: 'exit', code: 0 }));
  m.apply(rec('meta', { type: 'spawn', resume: true }));
  m.apply(rec('in', { type: 'result', total_cost_usd: 0.07 }));
  assert.equal(m.view().costUsd, 0.07, 'cumulative CLI: replace');

  const old = newModel();
  old.apply(rec('meta', { type: 'spawn' }));
  old.apply(rec('in', { type: 'result', total_cost_usd: 0.05 }));
  old.apply(rec('meta', { type: 'spawn', resume: true }));
  old.apply(rec('in', { type: 'result', total_cost_usd: 0.01 }));
  old.apply(rec('in', { type: 'result', total_cost_usd: 0.03 }));
  assert.ok(Math.abs(old.view().costUsd - 0.08) < 1e-9, 'restarted counter: add the base');
});

test('a freshly spawned session is idle (not running) until its first message', () => {
  const m = new SessionModel({ id: 's', name: 'n', cwd: '/', createdAt: 0, requestedModel: 'sonnet' }, new PriceTable());
  m.apply(rec('meta', { type: 'spawn' }));
  // headless claude only runs its SessionStart hooks until stdin delivers a message
  m.apply(rec('in', { type: 'system', subtype: 'hook_started' }));
  let v = m.view();
  assert.equal(v.uiState, 'done');
  assert.equal(v.turns, 0);
  assert.equal(v.model, 'sonnet', 'requested model shown before claude reports one');
  m.apply(rec('out', { type: 'user', message: { content: 'go' } }));
  v = m.view();
  assert.equal(v.uiState, 'running');
});

test('exit kills running agents and clears pending requests', () => {
  const m = newModel();
  m.apply(rec('out', { type: 'user', message: { content: 'go' } }));
  m.apply(asst('m1', { input_tokens: 1 }, null, [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }]));
  m.apply(rec('in', { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }));
  assert.equal(m.uiState(), 'waiting');
  m.apply(rec('meta', { type: 'exit', code: 1 }, 99));
  const v = m.view();
  assert.equal(v.state, 'exited');
  assert.equal(v.pending.length, 0);
  assert.equal(v.owners[1].state, 'killed');
  assert.equal(v.endedAt, 99);
});

test('views show subagents of an ended session as stopped, failures as failed', () => {
  const { model } = replay(loadFixture('01-foreground-subagent.ndjson'));
  const v = model.view();
  const sub = v.owners.find((o) => o.id === SUB_01)!;
  assert.equal(v.state, 'exited');
  assert.equal(sub.state, 'completed', 'the real outcome is kept');
  assert.equal(shownAgentState(v, sub), 'killed');
  assert.equal(shownAgentState(v, { state: 'failed' }), 'failed');
  assert.equal(shownAgentState({ state: 'idle' }, sub), 'completed', 'live session: shown as it is');
  assert.ok(v.updatedAt >= v.createdAt && v.updatedAt > 0, 'last activity time');
});
