import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { discoverModels, modelChoices } from '../src/core/models';

test('Codex picker separates known Astra and Sol IDs from the account catalogue', () => {
  const oldCatalogue = [{ label: 'GPT-5.6-Sol', value: 'gpt-5.6-sol' }];
  const choices = modelChoices('codex', oldCatalogue);
  assert.equal(choices.find((model) => model.label === 'GPT-6.1-Sol')?.value, 'gpt-6.1-sol');
  assert.equal(choices.find((model) => model.label === 'GPT-6-Astra')?.value, 'gpt-6-astra');
  assert.ok(choices.some((model) => model.value === 'gpt-5.6-sol'));
  assert.match(choices.find((model) => model.value === 'gpt-6-astra')!.description!, /Not advertised/);
  assert.equal(choices.find((model) => model.value === 'gpt-6.1-sol')!.unverified, true);
  assert.ok(choices.findIndex((model) => model.value === 'gpt-6.1-sol') > choices.findIndex((model) => model.value === 'gpt-5.6-sol'));
  assert.equal(modelChoices('codex', []).find((model) => model.value === 'gpt-6-astra')?.unverified, true, 'Discovery failures do not imply account access');
});

test('Codex catalogue metadata takes precedence over fallbacks and models are deduplicated', () => {
  const discovered = [{ label: 'Astra from provider', value: 'gpt-6-astra', detail: 'Live description' }];
  const choices = modelChoices('codex', discovered, '', ['gpt-6-astra']);
  assert.equal(choices.filter((model) => model.value === 'gpt-6-astra').length, 1);
  assert.equal(choices.find((model) => model.value === 'gpt-6-astra')?.label, 'Astra from provider');
  assert.equal(choices.find((model) => model.value === 'gpt-6-astra')?.detail, 'Live description');
  assert.notEqual(choices.find((model) => model.value === 'gpt-6-astra')?.unverified, true);
});

test('Codex preserves configured Sol when an older catalogue omits it', async () => {
  const previous = process.env.FAKE_CODEX_CONFIG_MODEL;
  process.env.FAKE_CODEX_CONFIG_MODEL = 'gpt-6.1-sol';
  try {
    const discovered = await discoverModels('codex', path.join(__dirname, '../../test/fake-codex.js'), process.cwd());
    assert.ok(discovered.some((model) => model.value === 'codex-hidden'), 'All catalogue pages are retained');
    const configured = discovered.find((model) => model.value === 'gpt-6.1-sol')!;
    assert.equal(configured.configuredDefault, true);
    assert.equal(configured.advertised, false);
    const choices = modelChoices('codex', discovered);
    assert.equal(choices[0].label, 'Default (GPT-6.1-Sol)');
    assert.equal(choices[0].value, 'gpt-6.1-sol', 'Never silently substitute a different model');
    assert.match(choices[0].description!, /not in the current/);
    assert.equal(choices.filter((model) => model.value === 'gpt-6.1-sol').length, 1);
    assert.equal(choices.find((model) => model.value === 'gpt-6.1-sol')?.unverified, true);
    const overridden = modelChoices('codex', discovered, 'my-override');
    assert.equal(overridden[0].value, 'my-override');
    assert.equal(overridden.find((model) => model.value === 'my-override')?.unverified, true);
  } finally {
    if (previous === undefined) delete process.env.FAKE_CODEX_CONFIG_MODEL;
    else process.env.FAKE_CODEX_CONFIG_MODEL = previous;
  }
});

test('Codex follows a configured default when the account advertises it', () => {
  const choices = modelChoices('codex', [
    { label: 'Sol 6.1', value: 'gpt-6.1-sol', advertised: true, configuredDefault: true },
    { label: 'Astra', value: 'gpt-6-astra', advertised: true, catalogDefault: true },
  ]);
  assert.equal(choices[0].label, 'Default (GPT-6.1-Sol)');
  assert.equal(choices[0].value, 'gpt-6.1-sol');
  assert.notEqual(choices.find((model) => model.value === 'gpt-6.1-sol')?.unverified, true);
  assert.equal(modelChoices('codex', choices.slice(1), 'gpt-6-astra')[0].value, 'gpt-6-astra');
});

test('Codex labels an unadvertised configured default when discovery returns no catalogue', () => {
  const choices = modelChoices('codex', [], 'gpt-6.1-sol');
  assert.equal(choices[0].value, 'gpt-6.1-sol');
  assert.equal(choices[0].unverified, true);
  assert.match(choices[0].detail!, /may reject/);
});

test('ChatGPT picker keeps configured, known and custom IDs with availability metadata', async () => {
  const previousModel = process.env.FAKE_CODEX_CONFIG_MODEL;
  const previousAccount = process.env.FAKE_CODEX_ACCOUNT_TYPE;
  process.env.FAKE_CODEX_CONFIG_MODEL = 'gpt-6.1-sol';
  process.env.FAKE_CODEX_ACCOUNT_TYPE = 'chatgpt';
  try {
    const catalog = await discoverModels('codex', path.join(__dirname, '../../test/fake-codex.js'), process.cwd());
    assert.equal(catalog.accountType, 'chatgpt');
    const choices = modelChoices('codex', catalog, 'gpt-6.1-sol', ['gpt-6-astra']);
    assert.equal(choices[0].value, 'gpt-6.1-sol');
    assert.ok(!choices.some((model) => model.value === 'codex-hidden'), 'Internal models stay out of the normal picker');
    assert.equal(choices.find((model) => model.value === 'gpt-6.1-sol')?.unverified, true);
    assert.equal(choices.find((model) => model.value === 'gpt-6-astra')?.unverified, true);
  } finally {
    if (previousModel === undefined) delete process.env.FAKE_CODEX_CONFIG_MODEL;
    else process.env.FAKE_CODEX_CONFIG_MODEL = previousModel;
    if (previousAccount === undefined) delete process.env.FAKE_CODEX_ACCOUNT_TYPE;
    else process.env.FAKE_CODEX_ACCOUNT_TYPE = previousAccount;
  }
});
