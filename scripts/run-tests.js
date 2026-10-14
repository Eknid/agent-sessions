'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.join(__dirname, '..', 'out', 'test');
const testFiles = fs.readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

if (testFiles.length === 0) {
  console.error(`No compiled tests found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
