// The fix loop after its review (M3, 2026-10-15 KST): attempts, branches, git filters, the diff policy through git,
// --serve start's proof, recovery and races. Split from fix-loop.test.mjs (helpers: test/fixtures/fix-loop-helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as C from '../src/fix/claims.mjs';
import * as P from '../src/project.mjs';
import * as L from '../src/ledger.mjs';
import { readKey } from '../src/state.mjs';
import { fixProject, edit, commitWith, git, tmp, ROUTES } from './fixtures/fix-project.mjs';

import { proveOk, ctxOf, stateDir, latest, rowOf, trailers, TITLE, attempt, aiProject, verdictsFor, servedProject } from './fixtures/fix-loop-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-fix-attempts-xdg-');

// ---- attempts are the person's to renew (M3 review, 2.3–2.5) -----------------------------------------------------------

test('attempts: after 2 tries only a person\'s new Fix starts another round; one the agent records (from chat) is refused', async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'WRAP'] });
  await attempt(p, { change: ['TINY', 'WRAP'] });
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'b']);
  const led = P.loadLedger(p.nunchi, { root: p.root });
  P.recordDecisions(led, { targets: [{ group: p.group }], decision: 'fix', by: 'agent', channel: 'cli-agent' });
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 1);
  assert.match(s.lines.at(-1), /only the person can start another round: ask them to choose “Try again with a note…” for it in the board \(nunchi open\)\. A Fix your AI records does not count\.$/);
  // with the records lost, git's trailers still say an earlier decision used every attempt
  rmSync(join(stateDir(p), 'fixes'), { recursive: true, force: true });
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 1);
  P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: p.group }], decision: 'fix', by: 'Tester', channel: 'board', note: 'use the shared button' });
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0, 'the person\'s Fix from the board starts attempt 1 again');
});

test('attempts: a fix commit without the Nunchi-Decision trailer is not verified (it would never be counted)', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'WRAP');
  const c = await F.checkFix(ctxOf(p), p.group);
  commitWith(p.root, trailers(c).filter(t => !t.startsWith('Nunchi-Decision')));
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.equal(v.code, 1);
  assert.match(v.lines.at(-1), /^No commit of this attempt is on HEAD: commit the fix as one commit ending with the trailers nunchi fix --checks printed \(Nunchi-Fix: [0-9a-f]{12} \/ Nunchi-Attempt: 1 \/ Nunchi-Decision: /);
  assert.equal(latest(p).phase, 'checked', 'not taken for this attempt\'s commit');
});

test('attempts: counted as distinct Nunchi-Attempt values, so a copy of a fix commit (a rebase, another branch) is one attempt', async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'WRAP'] });                        // attempt 1: not fixed, undone
  const fix1 = git(p.root, 'rev-parse', 'HEAD~1');
  const branch = git(p.root, 'branch', '--show-current');
  git(p.root, 'switch', '-q', '-c', 'copy', latest(p).base);
  git(p.root, 'cherry-pick', fix1);                                      // the same attempt, another commit
  git(p.root, 'switch', '-q', branch);
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /attempt 2 of 2/);
});

test('attempts: a git error while counting throws rather than counting none', async () => {
  const p = await fixProject();
  const { fixGit } = await import('../src/fix/git.mjs');
  const g = fixGit(p.root);
  rmSync(join(p.root, '.git'), { recursive: true, force: true });
  assert.throws(() => g.groupCommits(p.group));
});

test('branch: verify and undo only on the fix branch; the same commit on another branch, or a detached HEAD → refused / needs you', async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'ROOMY'], verify: false });
  const head = git(p.root, 'rev-parse', 'HEAD');
  git(p.root, 'switch', '-q', '-c', 'elsewhere');
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.match(v.lines.at(-1), /HEAD is on elsewhere, not on the fix branch nunchi\/fixes-\d{4}: switch back to it/);
  git(p.root, 'switch', '-q', latest(p).branch);
  await F.verifyFix(ctxOf(p), p.group);
  assert.equal(latest(p).phase, 'fixed');
  git(p.root, 'switch', '-q', '--detach', head);
  const u = F.undoFix(ctxOf(p), p.group);
  assert.match(u.lines.at(-1), /^Couldn't undo the fix of 'Tap target smaller than 24px' \(commit [0-9a-f]{7}\): HEAD is detached, not on the fix branch nunchi\/fixes-\d{4}\. Switch back to nunchi\/fixes-\d{4}, then tell your AI “undo it” — it needs you\.$/);
  assert.equal(git(p.root, 'rev-parse', 'HEAD'), head, 'nothing reverted');
});

test('filters: a repository whose files go through git filters (Git LFS) is refused up front, with the paths; none → no refusal', async () => {
  const p = await fixProject({ files: { '.gitattributes': '* -text\n*.bin filter=lfs diff=lfs merge=lfs -text\n', 'assets/hero.bin': 'version https://git-lfs.github.com/spec/v1\n' } });
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 1);
  assert.match(s.lines.at(-1), /^This repository runs files through git filters \(Git LFS or similar: assets\/hero\.bin\)\. nunchi runs git with every filter switched off/);
  assert.equal(latest(p), null, 'nothing started');
  const { fixGit } = await import('../src/fix/git.mjs');
  const q = await fixProject();
  assert.deepEqual(fixGit(q.root).filtered(), []);
});

test('diff policy through git: a file moved away from .github/ (renames off) and a symbolic link are flagged', { skip: process.platform === 'win32' && 'symbolic links need privileges on Windows' }, async () => {
  const p = await fixProject({ files: { '.github/workflows/ci.yml': 'on: push\n' } });
  await attempt(p, { change: ['TINY', 'ROOMY'], verify: false, extraEdit: root => {
    git(root, 'mv', '.github/workflows/ci.yml', 'app/settings/ci.yml');
    symlinkSync('page.jsx', join(root, 'app', 'settings', 'alias.jsx'));
    git(root, 'add', 'app/settings/alias.jsx');
  } });
  const v = await F.verifyFix(ctxOf(p), p.group);
  const lines = v.lines.join('\n');
  assert.match(lines, /\.github\/workflows\/ci\.yml: CI \(\.github\)/);
  assert.match(lines, /app\/settings\/alias\.jsx: a symbolic link or submodule/);
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'diff']);
});

test('--serve start proves the commit only when the approved build check passed on it', async () => {
  const p = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { start: 'next start' }, dependencies: { next: '0.0.0-test' } }) } });
  const { checkProfile, approveProfile, scriptsApprovedPath } = await import('../src/checks.mjs');
  approveProfile(scriptsApprovedPath(stateDir(p)), p.root, { seen: checkProfile(p.root).hash, channel: 'cli-tty', by: 'Tester' });
  let served = 0;
  const serve = async () => { served++; return { ok: true, url: 'http://127.0.0.1:4999', stop: () => {} }; };
  const s = await F.startFix(ctxOf(p, { serve }), p.group, { serve: 'start' });
  assert.equal(s.code, 1);
  assert.match(s.lines.join('\n'), /--serve start serves what was last built in this folder, and no approved build check passed on this commit/);
  assert.equal(served, 0, 'not even started');
  // with a build that passes, it is proof
  const q = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { build: 'node -e 0', start: 'next start' }, dependencies: { next: '0.0.0-test' } }) } });
  approveProfile(scriptsApprovedPath(stateDir(q)), q.root, { seen: checkProfile(q.root).hash, channel: 'cli-tty', by: 'Tester' });
  const runChecks = async () => ({ pm: { name: 'npm' }, results: { build: { status: 'pass', exit: 0, count: null, output: '' } } });
  assert.equal((await F.startFix(ctxOf(q, { serve, runChecks }), q.group, { serve: 'start' })).code, 0);
});

test('attempts: counted per group since the person\'s last Fix — a Fix the agent records after each revert does not reset the count', async () => {
  const p = await fixProject();
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const s = await F.startFix(ctxOf(p), p.group);
    if (s.code) { lines.push(s.lines.at(-1)); break; }
    edit(p.root, 'app/settings/page.jsx', 'TINY', 'WRAP');
    commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
    lines.push((await F.verifyFix(ctxOf(p), p.group)).lines.at(-1));
    P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: p.group }], decision: 'fix', by: 'agent', channel: 'cli-agent' });
  }
  assert.match(lines[0], /\(attempt 1 of 2\)\. Trying another way\.$/);
  assert.match(lines[1], /\(attempt 2 of 2\)\. The AI couldn't fix this in 2 tries: it needs you in the board\.$/);
  assert.match(lines[2], /only the person can start another round: ask them to choose “Try again with a note…” for it in the board \(nunchi open\)\. A Fix your AI records does not count\.$/);
  assert.equal(lines.length, 3);
  // a person's Fix (the board) starts a new round: attempt 1 of 2 again
  P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: p.group }], decision: 'fix', by: 'Tester', channel: 'board', note: 'use the shared button' });
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /attempt 1 of 2/);
});
