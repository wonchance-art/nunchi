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
