import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogRecord } from '../src/core/events';
import { PriceTable } from '../src/core/pricing';
import { SessionModel } from '../src/core/sessionModel';

const record = (ev: LogRecord['ev']): LogRecord => ({ t: 1, dir: 'in', ev });
const model = () => new SessionModel({ id: 'pricing', name: 'pricing', cwd: '/tmp', createdAt: 0, provider: 'codex', requestedModel: 'gpt-6.1-sol' }, new PriceTable());
const usage = (inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens: number, outputTokens: number, promptTokens = inputTokens) => record({
  type: 'system', subtype: 'codex_usage', model: 'gpt-6.1-sol',
  usage: { total: { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens }, last: { inputTokens: promptTokens }, modelContextWindow: 1_050_000 },
});

test('Codex charges each input bucket once and does not add reasoning tokens twice', () => {
  const m = model();
  const event = usage(100_000, 20_000, 10_000, 5_000);
  event.ev.usage.total.reasoningOutputTokens = 4_000;
  m.apply(event);
  assert.deepEqual(m.view().tokens, { input: 70_000, cacheRead: 20_000, cacheWrite: 10_000, output: 5_000, total: 85_000 });
  assert.ok(Math.abs(m.view().costUsd - 0.217) < 1e-12);
  m.apply(event);
  assert.ok(Math.abs(m.view().costUsd - 0.217) < 1e-12, 'Duplicate snapshots do not increase cost');
  assert.equal(m.view().costIsEstimate, true);
});

test('Codex long-context increments do not reprice earlier short requests, and replay restores cost', () => {
  const events = [usage(100_000, 0, 0, 10_000), usage(400_000, 0, 0, 20_000, 300_000)];
  const m = model();
  m.apply(events[0]);
  assert.ok(Math.abs(m.view().costUsd - 0.3) < 1e-12);
  m.apply(events[1]);
  // First request = $0.30. Second = 300K input at $4 + 10K output at $15 = $1.35.
  assert.ok(Math.abs(m.view().costUsd - 1.65) < 1e-12);
  const replayed = model();
  events.forEach((event) => replayed.apply(event));
  assert.equal(replayed.view().costUsd, m.view().costUsd);
});

test('Codex keeps previous costs when native counters reset on resume', () => {
  const m = model();
  m.apply(usage(100_000, 0, 0, 10_000));
  m.apply(usage(50_000, 0, 0, 5_000));
  assert.ok(Math.abs(m.view().costUsd - 0.45) < 1e-12);
  assert.equal(m.view().tokens.input, 150_000);
});
