// Where the other worktrees of this repository are (design 0.1-c §7, M6). Runs stay in the worktree that captured them
// (`<worktree>/.nunchi/runs`) and the ledger names each run's worktree by its stream: `main` for the main worktree,
// `wt:<name>` for a linked one (state.mjs stateRoot, `<name>` the folder under `<common dir>/worktrees/`). The fix loop
// in one worktree reads the sweep another one captured (its scope, its recordings) through this. Found from the files
// the version-control tool keeps for its worktrees, never by running anything; null when the worktree is gone.
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { readFileSync, lstatSync, statSync, realpathSync } from 'node:fs';

const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const real = p => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const NAME = /^[^/\\:\0]+$/;

// The folder of a stream's worktree. `root`: the state root (state.mjs stateRoot: `gitCommonDir`).
export function worktreeOf(root, stream) {
  const common = root?.gitCommonDir;
  if (!common || typeof stream !== 'string') return null;
  if (stream === 'main') {
    // a repository with a working tree keeps its common folder as `<worktree>/.git` (a bare one has no main worktree)
    const top = dirname(common);
    return isDir(join(top, '.git')) && real(join(top, '.git')) === real(common) ? top : null;
  }
  const m = /^wt:(.+)$/.exec(stream);
  if (!m || !NAME.test(m[1]) || m[1] === '.' || m[1] === '..') return null;
  const admin = join(common, 'worktrees', m[1]);
  let dotgit;
  try {
    if (!lstatSync(join(admin, 'gitdir')).isFile()) return null;
    dotgit = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
  } catch { return null; }
  if (!dotgit) return null;
  // newer versions may write it relative to the worktree's admin folder
  const at = isAbsolute(dotgit) ? dotgit : resolve(admin, dotgit);
  try { if (!lstatSync(at).isFile()) return null; } catch { return null; }
  return dirname(at);
}

// The runs folder of a stream's worktree, for the app at `root.prefix` in the repository. → a folder, or null.
export function runsDirOf(root, stream) {
  const wt = worktreeOf(root, stream);
  if (!wt) return null;
  const dir = join(wt, ...String(root.prefix || '').split('/').filter(Boolean), '.nunchi', 'runs');
  return isDir(dir) ? dir : null;
}
