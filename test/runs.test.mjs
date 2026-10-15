import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRun, finishRun, latestRun, listRuns, gcRuns, workTree, ensureGitignore } from '../src/runs.mjs';
import { runHealth } from '../src/capture.mjs';
import { tmp as tmpDir } from './fixtures/tmp.mjs';

const tmp = p => tmpDir(`nunchi-${p}-`);

test('runs: sequential ids, invisible until finished, latest moves only on completion', () => {
  const dir = tmp('runs');
  const a = startRun(dir);
  assert.equal(a.id, '0001');
  assert.equal(a.parent, null);
  assert.equal(latestRun(dir), null, 'a partial run is never latest');
  const b = startRun(dir);
  assert.equal(b.id, '0002', 'a second capture started meanwhile gets its own id');
  finishRun(dir, a.id);
  assert.equal(latestRun(dir), '0001');
  assert.deepEqual(listRuns(dir), { complete: ['0001'], partial: ['0002.partial'] });
  finishRun(dir, b.id);
  const c = startRun(dir);
  assert.equal(c.parent, '0002');
  assert.equal(readFileSync(join(dir, 'latest'), 'utf8'), '0002\n');
});

test('gc keeps the newest runs and latest, removes stale partial folders only', () => {
  const dir = tmp('gc');
  for (let i = 0; i < 4; i++) { const r = startRun(dir); finishRun(dir, r.id); }
  const fresh = startRun(dir); const stale = startRun(dir);
  const old = Date.now() / 1000 - 7200;
  utimesSync(stale.path, old, old);
  const r = gcRuns(dir, { keep: 2 });
  assert.deepEqual(r.kept, ['0003', '0004']);
  assert.deepEqual(r.removed.sort(), ['0001', '0002', '0006.partial']);
  assert.ok(existsSync(fresh.path), 'a run still being written is not removed');
});

test('workTree: commit plus a hash that changes with uncommitted edits, nunchi folder ignored', () => {
  const root = tmp('git');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
  writeFileSync(join(root, 'page.js'), 'export default 1\n');
  git('add', '.'); git('commit', '-qm', 'one');
  const clean = workTree(root);
  assert.match(clean.commit, /^[0-9a-f]{40}$/);
  assert.equal(clean.dirty, false);
  mkdirSync(join(root, '.nunchi', 'runs', '0001'), { recursive: true });
  writeFileSync(join(root, '.nunchi', 'runs', '0001', 'x.json'), '{}');
  assert.deepEqual(workTree(root), clean, 'writing a run does not make the tree look edited');
  writeFileSync(join(root, 'page.js'), 'export default 2\n');
  const edited = workTree(root);
  assert.equal(edited.dirty, true);
  assert.notEqual(edited.tree, clean.tree);
  writeFileSync(join(root, 'new.js'), 'x');
  assert.notEqual(workTree(root).tree, edited.tree, 'new untracked files count as edits');
  assert.deepEqual(workTree(tmp('nogit')), { commit: null, dirty: null, tree: null, repo: false });
});

test('ensureGitignore adds missing entries once and keeps the user\'s own lines', () => {
  const dir = tmp('ign');
  writeFileSync(join(dir, '.gitignore'), 'evidence/\nmine.txt');
  ensureGitignore(dir); ensureGitignore(dir);
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'evidence/\nmine.txt\nauth.json\nhar/\nruns/\nstate/\n');
});

test('run health: whole-run failures are named once, a single bounced screen is not one', () => {
  const e = (id, person, extra = {}) => ({ id, person, state: 'normal', reason: null, dataRequests: 0, replayMisses: 0, ...extra });
  const bounce = id => ({ rule: 'signed-in-bounced', scene: id });
  const signed = ['a', 'b', 'c', 'd'].map(x => e(x, 'signed-in'));
  assert.equal(runHealth(signed, [bounce('a')]).status, 'ok');
  assert.deepEqual(runHealth(signed, [bounce('a'), bounce('b')]).problems, [{ status: 'login-expired', scenes: 2, of: 4 }]);
  assert.equal(runHealth([e('x', 'guest', { reason: 'no-dom' }), e('y', 'guest', { reason: 'no-dom' }), e('z', 'guest')], []).status, 'app-unreachable');
  assert.equal(runHealth([e('x', 'guest', { dataRequests: 1, replayMisses: 2 }), e('y', 'guest', { dataRequests: 3, replayMisses: 1 })], []).status, 'recording-stale');
});
