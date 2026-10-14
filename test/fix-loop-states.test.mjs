// The fix loop (design 0.1-c §7, §4.8, §4.9): claims, cancellation, expiry, abort, undo, signing, records and
// recovery. Split from fix-loop.test.mjs (helpers: test/fixtures/fix-loop-helpers.mjs).
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

process.env.XDG_STATE_HOME = tmp('nunchi-fix-states-xdg-');

// ---- claims (design §7) ---------------------------------------------------------------------------------------------

test('claims: another agent fixing in this folder gets the refusal copy as written; the same agent is never told about worktrees', async () => {
  const p = await fixProject();
  const now = Date.now();
  const worktree = git(p.root, 'rev-parse', '--show-toplevel');
  const other = C.acquireClaim(stateDir(p), { group: 'abcabcabcabc', worktree, branch: 'nunchi/fixes-1014', url: 'http://127.0.0.1:3000', files: [], agent: 'Claude Code', now: now - 4 * 60e3 });
  assert.equal(other.ok, true);
  let r = await F.startFix(ctxOf(p, { now: () => now }), p.group, { agent: 'Codex' });
  const folder = worktree.split(/[\\/]/).pop();
  assert.deepEqual(r.lines, [`Claude Code is already fixing in this folder (branch nunchi/fixes-1014, 4 min). To fix in parallel: \`git worktree add ../${folder}-2 -b nunchi/fixes-2\`, open that folder in Codex, start the app there on another port. Or wait: deciding and capturing still work here.`]);
  assert.equal(latest(p).phase, 'aborted');
  r = await F.startFix(ctxOf(p, { now: () => now }), p.group, { agent: 'Claude Code' });
  // that claim was made by hand here: no open attempt owns it, so the line says to wait or release it (never --verify)
  assert.deepEqual(r.lines, ['A fix of another finding (group abcabcabcabc) is still open in this folder (branch nunchi/fixes-1014, 4 min): no open attempt owns that claim (a command was stopped while it claimed): wait 26 min for it to expire, or release it now with `nunchi fix --abort abcabcabcabc`.']);
  assert.doesNotMatch(r.lines[0], /worktree/);
  // an expired claim (reader's clock: lastRenewal + 30 min) is taken over
  r = await F.startFix(ctxOf(p, { now: () => now + 31 * 60e3 }), p.group, { agent: 'Codex' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(C.readClaim(stateDir(p), 'abcabcabcabc'), null);
  const mine = C.readClaim(stateDir(p), p.group);
  assert.deepEqual([mine.declaredAgent, mine.worktree, mine.branch, mine.files], ['Codex', worktree, latest(p).branch, ['app/settings/page.jsx']]);
});

test('claims: one file per claim (markers made with wx); a URL another live claim uses; --url required in a linked worktree (that copy)', async () => {
  const p = await fixProject();
  const sd = stateDir(p);
  const a = C.acquireClaim(sd, { group: 'aaaaaaaaaaaa', worktree: '/w/one', branch: 'b1', url: 'http://127.0.0.1:3000', files: ['app/settings/page.jsx'], agent: 'Claude Code' });
  assert.equal(a.ok, true);
  const b = C.acquireClaim(sd, { group: 'bbbbbbbbbbbb', worktree: '/w/two', branch: 'b2', url: 'http://127.0.0.1:3001', files: ['app/settings/page.jsx'], agent: 'Codex' });
  assert.deepEqual([b.ok, b.why, b.file], [false, 'file', 'app/settings/page.jsx']);
  const u = C.acquireClaim(sd, { group: 'cccccccccccc', worktree: '/w/two', branch: 'b2', url: 'http://127.0.0.1:3000/', files: ['x.jsx'], agent: 'Codex' });
  assert.deepEqual([u.ok, u.why], [false, 'url']);
  // an agent that did not say who it is (no --agent) is taken for the same one: no worktree advice
  const anon = C.refusalText({ why: 'folder', group: 'aaaaaaaaaaaa', claim: { declaredAgent: 'Claude Code', branch: 'b1', worktree: '/w/one', lastRenewal: new Date().toISOString() } }, { me: null, folder: 'one' });
  assert.doesNotMatch(anon, /worktree/);
  assert.equal(C.refusalText(u), 'Another fix (branch b1) is checking the app at http://127.0.0.1:3000. Start the app from this folder on a free port (e.g. `PORT=3001 npm run dev`), then verify with `--url http://127.0.0.1:3001`.');
  assert.equal(C.releaseClaim(sd, 'aaaaaaaaaaaa', 'not-the-token'), false, 'only the holder releases');
  assert.equal(C.releaseClaim(sd, 'aaaaaaaaaaaa', a.token), true);
  assert.equal(C.acquireClaim(sd, { group: 'bbbbbbbbbbbb', worktree: '/w/two', branch: 'b2', url: 'http://127.0.0.1:3001', files: ['app/settings/page.jsx'], agent: 'Codex' }).ok, true);
  // a linked worktree: its own app server, so --url is required
  const wt = join(tmp('nunchi-wt-'), 'shelf-2');
  git(p.root, 'worktree', 'add', '-q', wt, '-b', 'nunchi/fixes-2');
  mkdirSync(join(wt, '.nunchi', 'har'), { recursive: true });
  cpSync(join(p.nunchi, 'decisions'), join(wt, '.nunchi', 'decisions'), { recursive: true });           // committed files travel with git
  writeFileSync(join(wt, '.nunchi', 'har', 'guest.json'), '{}');
  const r = await F.startFix(F.openFix({ cwd: wt, root: wt, deps: { capture: p.cap.capture, prove: proveOk } }), p.group);
  assert.deepEqual(r.lines, ['Start the app from this folder on a free port (e.g. `PORT=3001 npm run dev`), then start with `--url http://127.0.0.1:3001`.']);
});

test('claims: renewed every 5 minutes while a capture runs (the interval is the test\'s), and by every fix command', async () => {
  const p = await fixProject();
  const sd = stateDir(p);
  const t0 = Date.now() - 20 * 60e3;
  const c = C.acquireClaim(sd, { group: 'aaaaaaaaaaaa', worktree: '/w', branch: 'b', url: null, files: [], now: t0 });
  const before = C.readClaim(sd, 'aaaaaaaaaaaa').lastRenewal;
  await C.whileRenewing(sd, 'aaaaaaaaaaaa', c.token, () => new Promise(res => setTimeout(res, 120)), { every: 30 });
  assert.notEqual(C.readClaim(sd, 'aaaaaaaaaaaa').lastRenewal, before);
  assert.equal(C.RENEW_MS, 5 * 60e3);
  assert.equal(C.renewClaim(sd, 'aaaaaaaaaaaa', 'someone-else'), false);
});

// ---- the state machine: cancellation, expiry, abort -------------------------------------------------------------------

test('cancelled: the person decides against the fix during the claim — before the commit the attempt stops; after it the commit is undone', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  let led = P.loadLedger(p.nunchi, { root: p.root });
  P.recordDecisions(led, { targets: [{ group: p.group }], decision: 'keep', reason: 'intended', by: 'Tester', channel: 'board' });
  let r = await F.checkFix(ctxOf(p), p.group);
  assert.equal(r.lines[0], 'Stopped fixing: you decided Keep while I was fixing it.');
  assert.equal(latest(p).phase, 'cancelled');
  assert.equal(C.readClaim(stateDir(p), p.group), null, 'claim released');
  const q = await fixProject();
  await attempt(q, { verify: false });
  const fixCommit = git(q.root, 'rev-parse', 'HEAD');
  led = P.loadLedger(q.nunchi, { root: q.root });
  P.recordDecisions(led, { targets: [{ group: q.group }], decision: 'false-positive', reason: 'not-a-problem', by: 'Tester', channel: 'board' });
  r = await F.verifyFix(ctxOf(q), q.group);
  assert.equal(r.lines[0], `Stopped fixing '${TITLE}': you decided Not a problem while I was fixing it, so the fix was undone.`);
  assert.equal(latest(q).phase, 'cancelled');
  assert.equal(git(q.root, 'rev-parse', 'HEAD^'), fixCommit);
  assert.equal(git(q.root, 'log', '-1', '--format=%(trailers:key=Nunchi-Revert,valueonly)'), `${q.group} attempt 1`);
});

test('claim expired: before the commit → to fix again; after it → needs you with the commit shown (and "retry" re-checks it)', async () => {
  const p = await fixProject();
  const t0 = Date.now();
  assert.equal((await F.startFix(ctxOf(p, { now: () => t0 }), p.group)).code, 0);
  let r = await F.checkFix(ctxOf(p, { now: () => t0 + 31 * 60e3 }), p.group);
  assert.equal(r.lines[0], 'Stopped fixing: the claim expired before a fix was committed. It is still to fix.');
  assert.equal(latest(p).phase, 'aborted');
  assert.equal(rowOf(p).status, 'to-fix');
  const q = await fixProject();
  await attempt(q, { verify: false, deps: { now: () => t0 } });
  r = await F.verifyFix(ctxOf(q, { now: () => t0 + 31 * 60e3 }), q.group);
  assert.match(r.lines[0], /^The fix of this finding \(commit [0-9a-f]{7}\) was not re-checked before its claim expired\. It needs you/);
  assert.deepEqual([latest(q).phase, latest(q).outcome.needsYou, latest(q).outcome.commit], ['needs-you', 'interrupted', git(q.root, 'rev-parse', 'HEAD')]);
  r = await F.verifyFix(ctxOf(q, { now: () => t0 + 32 * 60e3 }), q.group);
  assert.deepEqual(r.lines, [`Fixed '${TITLE}' (re-checked 2 screens, nothing else broke).`]);
});

test('abort: before the commit → still to fix; after it → needs you, the commit shown', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  let r = F.abortFix(ctxOf(p), p.group);
  assert.equal(r.lines[0], `Stopped fixing '${TITLE}' before a commit. It is still to fix.`);
  assert.equal(C.readClaim(stateDir(p), p.group), null);
  const q = await fixProject();
  await attempt(q, { verify: false });
  r = F.abortFix(ctxOf(q), q.group);
  assert.match(r.lines[0], /^Stopped fixing 'Tap target smaller than 24px' after its commit \([0-9a-f]{7}\), before nunchi re-checked it\./);
  assert.deepEqual([latest(q).phase, latest(q).outcome.needsYou], ['needs-you', 'interrupted']);
});

test('undo: a fix that landed is reverted while it is HEAD, and the ledger opens it again; once HEAD moved on, it is refused', async () => {
  const p = await fixProject();
  await attempt(p);
  assert.equal(rowOf(p).status, 'fixed');
  const r = F.undoFix(ctxOf(p), p.group);
  assert.match(r.lines[0], /^Undid the fix of 'Tap target smaller than 24px' \(commit [0-9a-f]{7} reverted by [0-9a-f]{7}\)\. It is to fix again\.$/);
  assert.deepEqual([latest(p).phase, rowOf(p).status, rowOf(p).goneAt], ['undone', 'to-fix', null]);
  assert.ok(!L.readState(join(stateDir(p), 'ledger.json')).folds.some(f => f.source === 'fix'), 'the fix fold is gone');
  const q = await fixProject();
  await attempt(q);
  git(q.root, 'commit', '-q', '--allow-empty', '-m', 'later work');
  const no = F.undoFix(ctxOf(q), q.group);
  assert.equal(no.code, 1);
  assert.match(no.lines[0], /is no longer the last commit: nunchi undoes only its own last commit\. Undo it by hand with git revert [0-9a-f]{7}\./);
});

test('git: a revert the repository requires to be signed, and signing fails → needs you; never committed unsigned, the tree left clean', async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'WRAP'], verify: false });
  const fixCommit = git(p.root, 'rev-parse', 'HEAD');
  const fail = join(p.root, '..', `failing-gpg-${process.pid}.sh`);
  writeFileSync(fail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  git(p.root, 'config', 'commit.gpgsign', 'true');
  git(p.root, 'config', 'gpg.format', 'openpgp');
  git(p.root, 'config', 'gpg.program', fail);
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.match(v.lines[0], /^Couldn't undo the fix of 'Tap target smaller than 24px' \(commit [0-9a-f]{7}\): your repository requires signed commits and signing failed\. nunchi never commits unsigned: it needs you\.$/);
  assert.equal(git(p.root, 'rev-parse', 'HEAD'), fixCommit, 'no commit');
  assert.equal(git(p.root, 'status', '--porcelain', '--', '.', ':!.nunchi'), '', 'the revert was aborted');
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'signing']);
});

test('git: SSH signing that fails ("failed to write commit object", nothing else) is a signing failure too', { skip: process.platform === 'win32' && 'a failing signing program needs a POSIX shell' }, async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'WRAP'], verify: false });
  const fail = join(p.root, '..', `failing-ssh-${process.pid}.sh`);
  writeFileSync(fail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const [k, v] of [['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['user.signingkey', join(p.root, '..', 'no-key')], ['gpg.ssh.program', fail]]) git(p.root, 'config', k, v);
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.match(v.lines[0], /your repository requires signed commits and signing failed/);
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'signing']);
});

// ---- records and recovery (design §4.8) ------------------------------------------------------------------------------

test('records: attempts allocated with wx, a phase before every side effect; attempts counted from git trailers when the records are lost', async () => {
  const p = await fixProject();
  await attempt(p, { change: ['TINY', 'WRAP'] });
  await attempt(p, { change: ['TINY', 'WRAP'] });
  assert.deepEqual(R.attemptNumbers(stateDir(p), p.group), [1, 2]);
  rmSync(join(stateDir(p), 'fixes'), { recursive: true, force: true });
  const r = await F.startFix(ctxOf(p), p.group);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /couldn't fix 'Tap target smaller than 24px' in 2 tries/, 'from the trailers, every branch');
  // two allocations at once never share a number
  const a = R.allocate(stateDir(p), p.group, {}), b = R.allocate(stateDir(p), p.group, {});
  assert.deepEqual([a.attempt, b.attempt], [1, 2]);
});

test('recovery: a start that died in P0 resumes with the same claim; a crash between "reverting" and the revert, or after the revert commit, or in "folding", is seen through', async () => {
  const p = await fixProject();
  let calls = 0;
  const dying = async (...a) => { if (calls++ === 0) throw new Error('killed'); return p.cap.capture(...a); };
  await assert.rejects(F.startFix(ctxOf(p, { capture: dying }), p.group), /killed/);
  assert.equal(latest(p).phase, 'p0');
  const token = latest(p).claim.token;
  const r = await F.startFix(ctxOf(p, { capture: dying }), p.group);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual([latest(p).phase, latest(p).claim.token, latest(p).attempt], ['started', token, 1], 'the same attempt and claim');
  // killed after the phase "reverting" was written, before git ran
  const q = await fixProject();
  await attempt(q, { change: ['TINY', 'WRAP'], verify: false });
  let rec = latest(q);
  rec = R.setPhase(stateDir(q), { ...rec, commit: git(q.root, 'rev-parse', 'HEAD') }, 'reverting', { verdict: { outcome: 'not-fixed', still: [] }, phrase: `That fix did not remove '${TITLE}'` });
  let s = F.statusFix(ctxOf(q), q.group);
  assert.match(s.lines[0], /attempt 1 {2}reverted/);
  assert.equal(git(q.root, 'log', '-1', '--format=%(trailers:key=Nunchi-Revert,valueonly)'), `${q.group} attempt 1`);
  // killed after git made the revert commit, before the record said so
  const u = await fixProject();
  await attempt(u, { change: ['TINY', 'WRAP'], verify: false });
  rec = latest(u);
  const commit = git(u.root, 'rev-parse', 'HEAD');
  git(u.root, 'revert', '--no-edit', '--no-commit', commit);
  git(u.root, 'commit', '-q', '-m', 'nunchi: undo', '-m', `Nunchi-Revert: ${u.group} attempt 1`);
  R.setPhase(stateDir(u), { ...rec, commit }, 'reverting', { verdict: { outcome: 'not-fixed', still: [] }, phrase: 'x' });
  s = F.statusFix(ctxOf(u), u.group);
  assert.match(s.lines[0], /attempt 1 {2}reverted/);
  assert.equal(git(u.root, 'rev-list', '--count', 'HEAD'), String(Number(git(u.root, 'rev-list', '--count', 'main')) + 2), 'no second revert');
  // killed in "folding": the fold is applied by the next command
  const w = await fixProject();
  await attempt(w);
  rec = latest(w);
  const ledger = join(stateDir(w), 'ledger.json');
  L.commitFix(ledger, st => L.unfoldFix(st, { run: rec.p1.run, stream: 'main' }));
  R.setPhase(stateDir(w), rec, 'folding', {});
  assert.equal(rowOf(w).status, 'to-fix');
  F.statusFix(ctxOf(w), w.group);
  assert.deepEqual([latest(w).phase, rowOf(w).status], ['fixed', 'fixed']);
  // a probe file a killed command left in public/ is removed by the next one
  writeFileSync(join(w.root, 'public', 'nunchi-probe-0123456789abcdef.txt'), 'x');
  ctxOf(w);
  assert.ok(!existsSync(join(w.root, 'public', 'nunchi-probe-0123456789abcdef.txt')));
});
