import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAccountUsage, codexAccountUsage } from '../src/core/accountUsage';

test('Claude assigned credits use precise monetary amounts rather than rounded usage or session cost', () => {
  const usage = claudeAccountUsage({ session: { total_cost_usd: 3 }, rate_limits: { spend: {
    used: { amount_minor: 44668, currency: 'USD', exponent: 2 }, limit: { amount_minor: 100000, currency: 'USD', exponent: 2 }, percent: 45,
  } } }, 123);
  assert.equal(usage.label, 'Credits left 55.3%');
  assert.match(usage.detail, /\$553\.32 remaining of \$1,000\.00/);
  assert.equal(usage.fetchedAt, 123);
  assert.equal(claudeAccountUsage({ rate_limits: { extra_usage: { monthly_limit: 100, used_credits: 125 } } }).label, 'Credits left 0%');
  assert.equal(claudeAccountUsage({ rate_limits: { spend: { limit: null, percent: 0 } } }).label, 'Credits left —');
  assert.equal(claudeAccountUsage({ rate_limits: { extra_usage: { monthly_limit: 0, used_credits: 0 } } }).label, 'Credits left —');
});

test('Codex usage remaining includes both native windows and chooses the current model allowance', () => {
  const rateLimits = { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1791600657 }, secondary: { usedPercent: 11, windowDurationMins: 10080 } };
  assert.equal(codexAccountUsage({ rateLimits }).label, 'Usage left 5h 93% · weekly 89%');
  assert.match(codexAccountUsage({ rateLimits }).detail, /resets/);
  assert.equal(codexAccountUsage({ rateLimits, rateLimitsByLimitId: { special: {
    normalModelSlug: 'astra', primary: { usedPercent: 20, windowDurationMins: 300 },
  } } }, 'astra').label, 'Usage left 5h 80%');
  assert.equal(codexAccountUsage({ rateLimits: { primary: { usedPercent: null } } }).label, 'Usage left —');
  assert.equal(codexAccountUsage({ rateLimits: { primary: { usedPercent: 110 } } }).label, 'Usage left primary 0%');
});
