import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { migrateLegacyStorage } from '../src/core/storageMigration';

test('imports legacy sessions and transcripts once, preserving current sessions and the old archive', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'eknid-mucollari.claude-sessions');
  const current = path.join(root, 'eknid-mucollari.agent-sessions');
  fs.mkdirSync(path.join(old, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(current, 'logs'), { recursive: true });
  const legacy = [{ id: 'old', name: 'Old conversation', conversationId: 'native-thread' }, { id: 'shared', name: 'Old name' }];
  fs.writeFileSync(path.join(old, 'sessions.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(old, 'logs/old.ndjson'), 'old transcript\n');
  fs.writeFileSync(path.join(old, 'logs/shared.ndjson'), 'stale transcript\n');
  fs.writeFileSync(path.join(old, 'commands.json'), '{}');
  fs.writeFileSync(path.join(current, 'sessions.json'), JSON.stringify([{ id: 'shared', name: 'New name' }]));
  fs.writeFileSync(path.join(current, 'logs/shared.ndjson'), 'new transcript\n');
  const before = fs.readFileSync(path.join(old, 'sessions.json'), 'utf8');
  assert.equal(migrateLegacyStorage(current), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, 'sessions.json'), 'utf8')), [{ id: 'shared', name: 'New name' }, legacy[0]]);
  assert.equal(fs.readFileSync(path.join(current, 'logs/old.ndjson'), 'utf8'), 'old transcript\n');
  assert.equal(fs.readFileSync(path.join(current, 'logs/shared.ndjson'), 'utf8'), 'new transcript\n');
  assert.equal(fs.readFileSync(path.join(old, 'sessions.json'), 'utf8'), before);
  // Removing an imported session must not cause it to reappear at the next activation.
  fs.writeFileSync(path.join(current, 'sessions.json'), '[]');
  assert.equal(migrateLegacyStorage(current), 0);
  assert.equal(fs.readFileSync(path.join(current, 'sessions.json'), 'utf8'), '[]');
});

test('invalid legacy data leaves the current archive untouched and can be retried', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'eknid-mucollari.claude-sessions');
  const current = path.join(root, 'eknid-mucollari.agent-sessions');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(current);
  fs.writeFileSync(path.join(current, 'sessions.json'), '[]');
  fs.writeFileSync(path.join(old, 'sessions.json'), '[{"id":"../outside"}]');
  assert.throws(() => migrateLegacyStorage(current), /Invalid session index/);
  assert.equal(fs.readFileSync(path.join(current, 'sessions.json'), 'utf8'), '[]');
  assert.equal(fs.existsSync(path.join(current, 'legacy-storage-migrated.json')), false);
  fs.writeFileSync(path.join(old, 'sessions.json'), '[]');
  assert.equal(migrateLegacyStorage(current), 0);
  assert.equal(fs.existsSync(path.join(current, 'legacy-storage-migrated.json')), true);
});
