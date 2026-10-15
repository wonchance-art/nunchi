// The fix loop after its review (M3, 2026-10-15 KST): recovery and races — a start killed while claiming, records
// compare-and-swap, claims renewed during checks, sweeps on the fix branch. Split from fix-loop.test.mjs (helpers:
// test/fixtures/fix-loop-helpers.mjs).
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

process.env.XDG_STATE_HOME = tmp('nunchi-fix-recovery-xdg-');

// ---- M3 review: recovery and races (3.4–3.7) ----------------------------------------------------------------------------

test('claims: a new claim takes the token the start wrote into its record first, so a start killed right after resumes', async () => {
  const p = await fixProject();
  const sd = stateDir(p);
  const token = 'ab'.repeat(16);
  const c = C.acquireClaim(sd, { group: p.group, worktree: p.root, branch: 'b', url: 'serve', files: [], fresh: token });
  assert.equal(c.token, token);
  // a record left in phase claiming with that token (the command died before it wrote branching): start resumes
  const rec = R.allocate(sd, p.group, { decision: { id: P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.find(r => r.fp === p.fp).decision.id }, base: git(p.root, 'rev-parse', 'HEAD'), worktree: p.root, url: 'http://127.0.0.1:3000',
    rootFiles: [], allowed: [], routes: ['/settings'], scope: { routes: ['/settings'], persons: ['guest'], viewports: ['d', 'm'], states: ['normal'] }, samplePaths: {}, sweep: '0001', fps: { rule: [p.fp], ai: [] } });
  R.setPhase(sd, rec, 'claiming', { claim: { token } });
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  assert.equal(C.readClaim(sd, p.group).token, token, 'the same claim, not a second one');
});

test('records: the newest open attempt is the latest, whatever closed after it; a stale write is refused (compare-and-swap)', async () => {
  const p = await fixProject();
  const sd = stateDir(p);
  const a = R.allocate(sd, p.group, { x: 1 });
  const b = R.allocate(sd, p.group, { x: 2 });
  R.setPhase(sd, b, 'aborted', {});
  assert.equal(R.latestRecord(sd, p.group).attempt, a.attempt);
  const a2 = R.setPhase(sd, a, 'claiming', {});
  assert.throws(() => R.setPhase(sd, a, 'started', {}), e => e.code === 'RECORD_CHANGED', 'written from a copy read before');
  assert.equal(R.setPhase(sd, a2, 'started', {}).phase, 'started');
});

test('records: an --abort from another terminal while P1 runs is not overwritten by the verdict', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  const capture = async a => { const r = await p.cap.capture(a); if (a.runMeta?.fix?.probe === 'P1') F.abortFix(ctxOf(p), p.group); return r; };
  const v = await F.verifyFix(ctxOf(p, { capture }), p.group);
  assert.match(v.lines.at(-1), /^'Tap target smaller than 24px' changed while it was being re-checked \(it is needs-you now\): nothing more was done\.$/);
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'interrupted']);
  assert.notEqual(rowOf(p).status, 'fixed');
});

test('records: a person\'s Keep while P1 runs cancels the attempt (its commit undone), not "fixed"', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  const capture = async a => { const r = await p.cap.capture(a); if (a.runMeta?.fix?.probe === 'P1') P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: p.group }], decision: 'keep', reason: 'intended', by: 'Tester', channel: 'board' }); return r; };
  const v = await F.verifyFix(ctxOf(p, { capture }), p.group);
  assert.match(v.lines.at(-1), /^Stopped fixing 'Tap target smaller than 24px': you decided Keep while I was fixing it, so the fix was undone\.$/);
  assert.equal(latest(p).phase, 'cancelled');
});

test('claims: the checks renew the claim while they run (a 31-minute suite keeps it)', async () => {
  const p = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node -e 0' }, dependencies: { next: '0.0.0-test' } }) } });
  let now = Date.now();
  const { checkProfile, approveProfile, scriptsApprovedPath } = await import('../src/checks.mjs');
  approveProfile(scriptsApprovedPath(stateDir(p)), p.root, { seen: checkProfile(p.root).hash, channel: 'cli-tty', by: 'Tester' });
  let calls = 0;
  const runChecks = async () => { if (calls++ === 1) now += 31 * 60e3; return { pm: { name: 'npm' }, results: { test: { status: 'pass', exit: 0, count: null, output: '' } } }; };
  const deps = { now: () => now, runChecks };
  assert.equal((await F.startFix(ctxOf(p, deps), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(ctxOf(p, deps), p.group);
  assert.equal(c.code, 0, c.lines.join('\n'));
  commitWith(p.root, trailers(c));
  const v = await F.verifyFix(ctxOf(p, deps), p.group);
  assert.match(v.lines.at(-1), /^Fixed 'Tap target smaller than 24px'/);
});

test('a sweep folded while the fix waits (rows gone, the decision still Fix) does not cancel the attempt', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  const head = git(p.root, 'rev-parse', 'HEAD');
  const run = join(p.nunchi, 'runs', '0009');
  await p.cap.capture({ baseUrl: 'http://127.0.0.1:3000', scenes: ROUTES.map(r => ({ route: r, path: r, person: 'guest' })), out: run, viewports: ['m', 'd'], states: ['normal'],
    runMeta: { schema: 1, id: '0009', kind: 'sweep', worktree: 'main', wholeApp: true, scope: { routes: ROUTES, persons: ['guest'], viewports: ['d', 'm'], states: ['normal'], changedSince: null } } });
  writeFileSync(join(p.nunchi, 'runs', 'latest'), '0009\n');
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.doesNotMatch(v.lines.join('\n'), /you decided/);
  assert.equal(git(p.root, 'rev-parse', 'HEAD'), head, 'the good fix stays');
  assert.equal(latest(p).phase, 'fixed');
});

test('a record changed under a command: said in words (what it is now), never a stack trace; a revert commit made just before is named', async () => {
  const p = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node -e 0' }, dependencies: { next: '0.0.0-test' } }) } });
  const { checkProfile, approveProfile, scriptsApprovedPath } = await import('../src/checks.mjs');
  approveProfile(scriptsApprovedPath(stateDir(p)), p.root, { seen: checkProfile(p.root).hash, channel: 'cli-tty', by: 'Tester' });
  let calls = 0;
  // the second run of the checks (fix --checks): someone aborts the attempt from another terminal meanwhile
  const runChecks = async () => { if (calls++ === 1) F.abortFix(ctxOf(p), p.group); return { pm: { name: 'npm' }, results: { test: { status: 'pass', exit: 0, count: null, output: '' } } }; };
  assert.equal((await F.startFix(ctxOf(p, { runChecks }), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(ctxOf(p, { runChecks }), p.group);
  assert.equal(c.code, 1);
  assert.deepEqual(c.lines, ['Someone stopped this attempt (fix --abort) while this command ran. Nothing more was done.']);
  // a revert commit landed, then the record was written by someone else before this command could close it
  const q = await fixProject();
  await attempt(q, { change: ['TINY', 'WRAP'], verify: false });
  const ctx = ctxOf(q);
  const orig = ctx.git.revert;
  ctx.git.revert = o => { const r = orig(o); const rec = latest(q); R.update(stateDir(q), rec, { note: 'written by another command' }); return r; };
  const v = await F.verifyFix(ctx, q.group);
  const head = git(q.root, 'rev-parse', '--short=7', 'HEAD');
  assert.match(v.lines.at(-1), new RegExp(`Nothing more was done\\. The fix had just been undone by commit ${head}: that commit stays; look at it with git show ${head}\\.$`));
  assert.equal(v.code, 1);
});

test('a claim no open attempt owns (a start killed while claiming, before its token was written): wait N min or --abort, which releases it; never "resume with --verify"', async () => {
  const p = await fixProject();
  const sd = stateDir(p);
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  const real = latest(p);
  F.abortFix(ctxOf(p), p.group);
  const { attempt: _a, phase: _p, phases: _ps, rev: _r, claim: _c, outcome: _o, p0: _p0, ...fields } = real;
  R.setPhase(sd, R.allocate(sd, p.group, fields), 'claiming');                 // no token recorded
  C.acquireClaim(sd, { group: p.group, worktree: real.worktree, branch: real.branch, url: real.url, files: real.rootFiles, mine: null });
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 1);
  assert.doesNotMatch(s.lines.join('\n'), /--verify/);
  assert.match(s.lines.at(-1), /no open attempt owns that claim \(a command was stopped while it claimed\): wait (29|30) min for it to expire, or release it now with `nunchi fix --abort [0-9a-f]{12}`\.$/);
  const a = F.abortFix(ctxOf(p), p.group);
  assert.match(a.lines.at(-1), /^Released the claim on 'Tap target smaller than 24px' that a stopped command left behind\.$/);
  assert.equal(C.readClaim(sd, p.group), null);
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0, 'it starts again');
  // a holder that is open stops at a step: the hint names that step, not --verify
  const q = await fixProject();
  assert.equal((await F.startFix(ctxOf(q), q.group, { agent: 'Codex' })).code, 0);
  const other = await fixProject();
  const qsd = stateDir(q);
  const c = C.acquireClaim(qsd, { group: q.group, worktree: q.root, branch: 'b', url: 'serve', files: [], mine: 'x' });
  assert.equal(c.ok, false);
  assert.match(C.refusalText(c, { me: 'Codex', hint: 'go on with `nunchi fix --checks g`' }), /: go on with `nunchi fix --checks g`\.$/);
  assert.ok(other);
});
