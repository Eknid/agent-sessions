import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalModel, modelFamily, modelLabel, PriceTable } from '../src/core/pricing';

test('model ids', () => {
  assert.equal(canonicalModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(canonicalModel('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(modelLabel('haiku'), 'Haiku');
  assert.equal(modelLabel(undefined), '—');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  const p = new PriceTable();
  assert.equal(p.rates('claude-sonnet-9-9').input, 2, 'unknown sonnet priced as current sonnet');
  assert.equal(p.contextWindow('claude-opus-5[1m]'), 1_000_000);
  assert.equal(p.cost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
  assert.equal(
    p.cost('claude-haiku-4-5', { cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }),
    1.25 + 2,
  );
  const o = new PriceTable({ 'claude-opus-5-5': { input: 1 } });
  assert.equal(o.rates('claude-opus-5-5').input, 1);
  assert.equal(o.rates('claude-opus-5-5').output, 20);
});

test('OpenAI Standard pricing includes cached input, cache writes and snapshot IDs', () => {
  const prices = new PriceTable();
  // One million tokens in each independently-priced bucket.
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
  assert.equal(prices.cost('gpt-6.1-sol', usage, 100_000), 14.6);
  assert.equal(prices.cost('gpt-6-astra', usage, 100_000), 73.5);
  assert.equal(prices.rates('gpt-6.1-sol').cacheWrite1h, 2.5, 'OpenAI has no Anthropic one-hour write premium');
  assert.equal(prices.hasRates('gpt-5.5-2026-04-23'), true);
  assert.equal(prices.rates('openai/gpt-6.1-sol').input, 2);
  assert.equal(prices.hasRates('unpublished-model'), false);
  assert.equal(prices.cost('unpublished-model', usage), 0);
  assert.equal(new PriceTable({ 'gpt-6.1-sol': { input: 1 } }).cost('gpt-6.1-sol', { input_tokens: 1_000_000 }, 100_000), 1);
});

test('OpenAI long-context rates begin strictly above 272K prompt tokens', () => {
  const prices = new PriceTable();
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
  assert.equal(prices.cost('gpt-6.1-sol', usage, 272_000), 14.6);
  assert.equal(prices.cost('gpt-6.1-sol', usage, 272_001), 24.2);
  assert.equal(prices.cost('gpt-6-astra', usage, 272_001), 122);
});
