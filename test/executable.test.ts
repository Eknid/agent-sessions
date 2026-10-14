import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { bundledCodex } from '../src/core/executable';

test('Codex resolves the active official extension bundle and falls back when absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bundle-'));
  try {
    assert.equal(bundledCodex(undefined), undefined);
    assert.equal(bundledCodex(root, 'darwin', 'arm64'), undefined);
    for (const [platform, arch, target, name] of [
      ['darwin', 'arm64', 'macos-aarch64', 'codex'],
      ['darwin', 'x64', 'macos-x86_64', 'codex'],
      ['linux', 'x64', 'linux-x86_64', 'codex'],
      ['win32', 'x64', 'windows-x86_64', 'codex.exe'],
    ] as const) {
      const file = path.join(root, 'bin', target, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      assert.equal(bundledCodex(root, platform, arch), file);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
