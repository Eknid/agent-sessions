import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/*
 * The repository a session works in: the nearest folder up from its cwd that has a `.git`
 * (a directory, or a file in worktrees and submodules). Folders outside git are their own
 * "repository". Shared by the sidebar and the board so both group sessions the same way.
 */

export interface Repo {
  root: string;
  name: string;
  /** cwd relative to the root ('' when the session runs at the root). */
  subdir: string;
}

const cache = new Map<string, string>();

export function repoOf(cwd: string, exists: (p: string) => boolean = fs.existsSync, home = os.homedir()): Repo {
  let root = cache.get(cwd);
  if (root === undefined) {
    root = findRoot(cwd, exists, home);
    cache.set(cwd, root);
  }
  return { root, name: path.basename(root) || root, subdir: path.relative(root, cwd) };
}

function findRoot(cwd: string, exists: (p: string) => boolean, home: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    // A dotfiles repo in $HOME (or one at /) would swallow every folder: never a root.
    if (dir === home || path.dirname(dir) === dir) return path.resolve(cwd);
    if (exists(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
}

/** Forget cached roots (tests; or after a `git init`). */
export function clearRepoCache() {
  cache.clear();
}

/** Display names for repository roots: the folder name, or parent/name when two share a name. */
export function repoLabels(roots: Iterable<string>): Map<string, string> {
  const unique = [...new Set(roots)];
  const byName = new Map<string, number>();
  for (const r of unique) byName.set(path.basename(r), (byName.get(path.basename(r)) ?? 0) + 1);
  return new Map(unique.map((r) => [r, (byName.get(path.basename(r)) ?? 0) > 1 ? path.join(path.basename(path.dirname(r)), path.basename(r)) : path.basename(r) || r]));
}

export interface RepoCounts {
  waiting: number;
  running: number;
  latest: number;
}

/** Repositories with someone waiting for you first, then busy ones, then most recent. */
export function repoOrder(a: RepoCounts, b: RepoCounts): number {
  return Number(b.waiting > 0) - Number(a.waiting > 0) || Number(b.running > 0) - Number(a.running > 0) || b.latest - a.latest;
}
