import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { clearRepoCache, repoLabels, repoOf, repoOrder } from '../src/core/repo';

test('repository: nearest .git up from the cwd, worktree files count, $HOME never does', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-repo-')));
  const repo = path.join(tmp, 'di_transform_dbt');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'models', 'marts'), { recursive: true });
  const wt = path.join(tmp, 'worktree');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere');
  const plain = path.join(tmp, 'notes');
  fs.mkdirSync(plain);
  clearRepoCache();
  assert.deepEqual(repoOf(repo, undefined, tmp + '/none'), { root: repo, name: 'di_transform_dbt', subdir: '' });
  assert.deepEqual(repoOf(path.join(repo, 'models', 'marts'), undefined, tmp + '/none'), { root: repo, name: 'di_transform_dbt', subdir: path.join('models', 'marts') });
  assert.equal(repoOf(wt, undefined, tmp + '/none').root, wt);
  assert.deepEqual(repoOf(plain, undefined, tmp + '/none'), { root: plain, name: 'notes', subdir: '' }, 'no git: the folder itself');
  // A .git in $HOME (dotfiles) does not make $HOME the repository of everything below it.
  clearRepoCache();
  fs.mkdirSync(path.join(tmp, '.git'));
  assert.equal(repoOf(plain, undefined, tmp).root, plain);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('repository labels: folder name, parent/name when two share it', () => {
  const l = repoLabels(['/a/data_repos/di_transform_dbt', '/b/scratch/di_transform_dbt', '/a/notes', '/a/notes']);
  assert.deepEqual([...l.values()], ['data_repos/di_transform_dbt', 'scratch/di_transform_dbt', 'notes']);
});

test('repository order: waiting first, then running, then most recent', () => {
  const rows = [
    { name: 'old', waiting: 0, running: 0, latest: 1 },
    { name: 'busy', waiting: 0, running: 1, latest: 2 },
    { name: 'recent', waiting: 0, running: 0, latest: 9 },
    { name: 'asks', waiting: 1, running: 0, latest: 0 },
  ];
  assert.deepEqual(rows.sort(repoOrder).map((r) => r.name), ['asks', 'busy', 'recent', 'old']);
});
