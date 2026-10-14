// git for the fix loop (design 0.1-c §4.7). Every call goes through runs.mjs gitRunner: the repository's own programs
// switched off (core.fsmonitor, core.hooksPath, diff.external, the pager and every filter driver's commands, as
// GIT_CONFIG_COUNT overrides, which outrank the system file it reads), --no-optional-locks, no prompt, the caller's GIT_* variables dropped,
// a timeout; diffs add --no-ext-diff --no-textconv. The loop never pushes, resets or forces:
// - the commit check is `rev-list --parents -n1 HEAD` = [HEAD, base], the `Nunchi-Fix: <group>` trailer and a clean
//   tree (nunchi's own `.nunchi/` aside: decisions made in the board while fixing are not the fix);
// - a revert happens only when HEAD is the fix commit: `git revert --no-commit`, then a commit with the
//   `Nunchi-Revert: <group> attempt <n>` trailer, hooks off, 60 s; any failure → `git revert --abort`, and the caller
//   says *needs you*. A signing the repository requires and that fails is never retried unsigned;
// - attempts are counted from the trailers of every branch (`--all`), so they survive lost state and other worktrees.
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitRunner, DIFF_SAFE } from '../runs.mjs';

export const TRAILERS = { fix: 'Nunchi-Fix', attempt: 'Nunchi-Attempt', decision: 'Nunchi-Decision', revert: 'Nunchi-Revert' };
export const REVERT_TIMEOUT = 60_000;
// nunchi's own folder is never part of a fix: decisions written while fixing stay uncommitted beside it
export const OUTSIDE_NUNCHI = ':(top,exclude,glob)**/.nunchi/**';
const HEX = /^[0-9a-f]{40,64}$/;
const GROUP = /^[0-9a-f]{12}$/;

// "Key: value" lines of a commit's trailer block (git's own parse, `%(trailers:only,unfold)`).
export function parseTrailers(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (m) (out[m[1]] ||= []).push(m[2].trim());
  }
  return out;
}
// The message of a fix commit: a subject the skill writes, and the trailers the engine asks for (printed by
// `fix --checks`). Trailer values are engine words only: a group id, a number, a decision id.
export function fixTrailers({ group, attempt, decision }) {
  if (!GROUP.test(group)) throw new Error('a fix trailer names a 12-hex group');
  return [`${TRAILERS.fix}: ${group}`, `${TRAILERS.attempt}: ${Number(attempt)}`, ...(decision ? [`${TRAILERS.decision}: ${String(decision).replace(/[^\w-]/g, '')}`] : [])];
}

export function fixGit(root) {
  const run = gitRunner(root);
  const git = (args, opts = {}) => run(args, { encoding: 'utf8', ...opts });
  const tryGit = (args, opts) => { try { return git(args, opts); } catch { return null; } };
  const api = {
    root,
    head: () => { const h = tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); return h ? h.trim() : null; },
    branch: () => { const b = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD']); return b ? b.trim() : null; },
    toplevel: () => git(['rev-parse', '--show-toplevel']).trim(),
    gitPath: name => git(['rev-parse', '--path-format=absolute', '--git-path', name]).trim(),
    // [rev, its parents…]
    parents: (rev = 'HEAD') => git(['rev-list', '--parents', '-n1', '--end-of-options', rev]).trim().split(/\s+/).filter(Boolean),
    branchExists: name => tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null,
    // the repository's default branch: what origin/HEAD names, else init.defaultBranch, else main or master (one that exists)
    defaultBranch: () => {
      const o = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
      if (o && /^refs\/remotes\/origin\/./.test(o.trim())) return o.trim().slice('refs/remotes/origin/'.length);
      const cfg = tryGit(['config', '--get', 'init.defaultBranch']);
      if (cfg && cfg.trim() && api.branchExists(cfg.trim())) return cfg.trim();
      for (const b of ['main', 'master']) if (api.branchExists(b)) return b;
      return cfg ? cfg.trim() || null : null;
    },
    // what is not committed (nunchi's own folder aside), as paths
    status: () => git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', ':/', OUTSIDE_NUNCHI])
      .split('\0').filter(Boolean).map(e => e.slice(3)).filter(Boolean).sort(),
    // a revert, cherry-pick, merge or rebase left in the middle
    inProgress: () => ['REVERT_HEAD', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply'].filter(n => existsSync(api.gitPath(n))),
    clean: () => !api.status().length && !api.inProgress().length,
    // what a commit made now would take besides the fix's own undo: changes in the working tree (nunchi's folder aside)
    // and anything staged at all (a staged .nunchi file would be committed too)
    uncommitted: () => [...new Set([...api.status(), ...git(['diff', ...DIFF_SAFE, '--cached', '--name-only', '-z']).split('\0').filter(Boolean)])].sort(),
    // the commit a revert in progress is undoing (REVERT_HEAD), or null
    revertHead: () => { try { return readFileSync(api.gitPath('REVERT_HEAD'), 'utf8').trim() || null; } catch { return null; } },
    // The tree a commit of the working tree as it is would get (nunchi's folder as HEAD has it): hashed in a temporary
    // index outside the repository, so the real index is never touched. --checks records it, --verify compares it with
    // the commit's tree.
    workingTree: () => {
      const dir = mkdtempSync(join(tmpdir(), 'nunchi-index-'));
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      try {
        if (api.head()) git(['read-tree', 'HEAD'], { env });
        git(['add', '-A', '--', ':/', OUTSIDE_NUNCHI], { env });
        return git(['write-tree'], { env }).trim();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    treeOf: rev => git(['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`]).trim(),
    trailers: (rev = 'HEAD') => parseTrailers(git(['log', '-1', '--format=%(trailers:only,unfold)', '--end-of-options', rev])),
    subject: (rev = 'HEAD') => git(['log', '-1', '--format=%s', '--end-of-options', rev]).trim(),
    // every commit on any branch whose trailers name the group: fix commits and reverts, newest first
    groupCommits: group => {
      if (!GROUP.test(group)) return [];
      const out = tryGit(['log', '--all', '--format=%H%x1f%P%x1f%(trailers:only,unfold)%x1e']);
      if (!out) return [];
      return out.split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => {
        const [sha, parents, tr] = r.split('\x1f');
        return { sha: sha.trim(), parents: (parents || '').trim().split(/\s+/).filter(Boolean), trailers: parseTrailers(tr) };
      }).filter(c => (c.trailers[TRAILERS.fix] || []).includes(group) || (c.trailers[TRAILERS.revert] || []).some(v => v.split(/\s+/)[0] === group));
    },
    diffNames: (base, head) => git(['diff', ...DIFF_SAFE, '--name-only', '-z', '--end-of-options', base, head, '--']).split('\0').filter(Boolean).sort(),
    diffPatch: (base, head) => git(['diff', ...DIFF_SAFE, '--unified=0', '--no-color', '--end-of-options', base, head, '--']),
    abortRevert: () => tryGit(['revert', '--abort'], { timeout: REVERT_TIMEOUT }) !== null,
    switchNew: name => git(['switch', '--quiet', '--no-guess', '-c', name]),
    switchTo: name => git(['switch', '--quiet', '--no-guess', name]),
    // Undo the fix commit (design §4.7). → { ok: true, sha } or { ok: false, reason: 'not-head' | 'in-progress' |
    // 'dirty' | 'signing' | 'failed', message, files? }. Never resets: a failure is aborted and left for the person.
    // Only on a clean working tree and index: `revert --no-commit` starts from the index, so staged work would be
    // committed inside the undo, and `revert --abort` (a reset --merge) would throw it away. `onStart` runs right before
    // git revert (the caller records that this revert is nunchi's, so only nunchi's is ever aborted).
    revert: ({ fixCommit, group, attempt, why = '', onStart = () => {} }) => {
      if (!HEX.test(String(fixCommit))) return { ok: false, reason: 'failed', message: 'no fix commit to undo' };
      if (api.head() !== fixCommit) return { ok: false, reason: 'not-head', message: `the fix commit ${fixCommit.slice(0, 7)} is no longer the last commit (HEAD is ${String(api.head()).slice(0, 7)})` };
      if (api.inProgress().length) return { ok: false, reason: 'in-progress', message: `a ${api.inProgress()[0]} is in progress` };
      const dirty = api.uncommitted();
      if (dirty.length) return { ok: false, reason: 'dirty', files: dirty, message: `your working tree has changes that are not committed (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` +${dirty.length - 5} more` : ''})` };
      const abort = () => { tryGit(['revert', '--abort'], { timeout: REVERT_TIMEOUT }); };
      onStart();
      try {
        git(['revert', '--no-commit', '--no-edit', '--end-of-options', fixCommit], { timeout: REVERT_TIMEOUT });
        git(['commit', '--no-verify', '-m', `nunchi: undo fix attempt ${Number(attempt)} of ${group}`, ...(why ? ['-m', why] : []), '-m', `${TRAILERS.revert}: ${group} attempt ${Number(attempt)}`], { timeout: REVERT_TIMEOUT });
      } catch (e) {
        const message = String(e.stderr || e.message || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        abort();
        // an SSH signing program that fails says only "failed to write commit object": with signing required, that is it
        const signs = (tryGit(['config', '--bool', 'commit.gpgsign']) || '').trim() === 'true';
        return { ok: false, reason: /gpg|sign|ssh-keygen|signing/i.test(message) || (signs && /failed to write commit object/i.test(message)) ? 'signing' : 'failed', message };
      }
      return { ok: true, sha: api.head() };
    },
  };
  return api;
}
