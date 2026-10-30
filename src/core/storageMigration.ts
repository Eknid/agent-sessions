import * as fs from 'fs';
import * as path from 'path';

/** Copy the previous extension's sessions once, leaving its archive untouched. */
export function migrateLegacyStorage(storageDir: string): number {
  const legacy = path.join(path.dirname(storageDir), 'eknid-mucollari.claude-sessions');
  const marker = path.join(storageDir, 'legacy-storage-migrated.json');
  const legacyIndex = path.join(legacy, 'sessions.json');
  if (storageDir === legacy || fs.existsSync(marker) || !fs.existsSync(legacyIndex)) return 0;

  const readIndex = (file: string): { id: string; [key: string]: unknown }[] => {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data) || data.some((s) => !s || typeof s.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(s.id))) {
      throw new Error(`Invalid session index: ${file}`);
    }
    return data;
  };
  const index = path.join(storageDir, 'sessions.json');
  const oldSessions = readIndex(legacyIndex);
  const current = fs.existsSync(index) ? readIndex(index) : [];
  const ids = new Set(current.map((s) => s.id));
  const added = oldSessions.filter((s) => !ids.has(s.id));
  const logs = path.join(storageDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const s of added) {
    const source = path.join(legacy, 'logs', `${s.id}.ndjson`);
    const target = path.join(logs, `${s.id}.ndjson`);
    // Never replace a log already owned by the new extension.
    if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  const commands = path.join(storageDir, 'commands.json');
  if (!fs.existsSync(commands) && fs.existsSync(path.join(legacy, 'commands.json'))) {
    fs.copyFileSync(path.join(legacy, 'commands.json'), commands, fs.constants.COPYFILE_EXCL);
  }
  // Publish the index only once all copied transcripts are available. A failed copy can be retried.
  fs.writeFileSync(index + '.migration.tmp', JSON.stringify([...current, ...added], null, 2));
  fs.renameSync(index + '.migration.tmp', index);
  fs.writeFileSync(marker, JSON.stringify({ migratedAt: new Date().toISOString(), count: added.length }));
  return added.length;
}
