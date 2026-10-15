// Per-worktree URL rules (design 0.1-c §7, M6): each worktree runs its own app server. fix --start and --verify need
// --url in a worktree other than the one that captured the sweep (or started the attempt), and refuse a URL another
// live claim uses; a linked worktree on a fix branch (which never sweeps) fixes from the sweep the main worktree captured,
// with that sweep's scope and recordings. Synthetic repositories and a fake capture, as the M3 fix-loop tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, realpathSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as F from '../src/fix/loop.mjs';
import * as C from '../src/fix/claims.mjs';
import { worktreeOf, runsDirOf } from '../src/worktrees.mjs';
import * as P from '../src/project.mjs';
import { fixProject, fakeCapture, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';
import { proveOk, ctxOf, stateDir, latest, trailers, TITLE } from './fixtures/fix-loop-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-fix-wt-xdg-');
const POSIX = process.platform !== 'win32';
const OWN = verb => `Start the app from this folder on a free port (e.g. \`PORT=3001 npm run dev\`), then ${verb} with \`--url http://127.0.0.1:3001\`.`;
const real = p => realpathSync.native(p);
// A linked worktree of the fixture's repository on a fix branch; decisions travel as files (here copied).
function linked(p, name, branch = null) {
  const wt = join(tmp('nunchi-wt-'), name);
  if (branch) git(p.root, 'worktree', 'add', '-q', wt, branch); else git(p.root, 'worktree', 'add', '-q', wt, '-b', `nunchi/fixes-${name}`);
  cpSync(join(p.nunchi, 'decisions'), join(wt, '.nunchi', 'decisions'), { recursive: true });
  const cap = fakeCapture(wt);
  return { wt, cap, ctx: (extra = {}) => F.openFix({ cwd: wt, root: wt, deps: { capture: cap.capture, prove: proveOk, ...extra } }) };
}

test('worktrees: a stream names a worktree, found from the files git keeps for it, never by running anything', async () => {
  const p = await fixProject();
  const { wt } = linked(p, 'two');
  const root = P.stateOf(join(wt, '.nunchi')).root;
  assert.equal(root.stream, 'wt:two');
  assert.equal(real(worktreeOf(root, 'wt:two')), real(wt));
  assert.equal(real(worktreeOf(root, 'main')), real(p.root));
  assert.equal(real(runsDirOf(root, 'main')), real(join(p.nunchi, 'runs')));
  assert.equal(runsDirOf(root, 'wt:two'), null, 'no runs folder there yet');
  for (const bad of ['wt:../x', 'wt:a/b', 'wt:', 'wt:gone', 'other']) assert.equal(worktreeOf(root, bad), null, bad);
});

test('paths: one folder whatever the slashes and the case on Windows, and through a link elsewhere', () => {
  const win = { platform: 'win32', real: p => p };
  assert.equal(C.samePath('D:/a/Shop', 'd:\\a\\shop\\', win), true);
  assert.equal(C.samePath('D:/a/shop', 'D:/a/shop-2', win), false);
  const dir = tmp('nunchi-samepath-');
  assert.equal(C.samePath(dir, `${dir}/`), true);
  assert.equal(C.samePath(dir, join(dir, 'x')), false);
  assert.equal(C.samePath(null, dir), false);
  if (POSIX) { mkdirSync(join(dir, 'real')); symlinkSync(join(dir, 'real'), join(dir, 'link')); assert.equal(C.samePath(join(dir, 'link'), join(dir, 'real')), true, 'a link is its target'); }
});

test('a linked worktree on a fix branch fixes from the main worktree\'s sweep: --url required (the copy as written), then that sweep\'s scope and recordings', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  const plan = F.planFixes(two.ctx());
  assert.ok(plan.lines.includes(OWN('start')), plan.lines.join('\n'));
  let r = await F.startFix(two.ctx(), p.group, { agent: 'Codex' });
  assert.deepEqual([r.code, r.lines], [1, [OWN('start')]]);
  assert.equal(latest(p), null, 'nothing allocated');
  r = await F.startFix(two.ctx(), p.group, { agent: 'Codex', vendor: 'OpenAI', url: 'http://127.0.0.1:3001' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  const rec = latest(p);
  assert.deepEqual([rec.stream, rec.sweep, real(rec.sweepDir), real(rec.harFrom)], ['wt:two', '0001', real(join(p.nunchi, 'runs', '0001')), real(join(p.nunchi, 'har'))], 'the sweep and recordings of the folder that captured');
  assert.deepEqual(two.cap.calls.map(c => [c.baseUrl, c.kind]), [['http://127.0.0.1:3001', 'fix-probe']]);
  const claim = C.readClaim(stateDir(p), p.group);
  assert.deepEqual([claim.declaredAgent, claim.declaredVendor, claim.url, C.samePath(claim.worktree, two.wt)], ['Codex', 'OpenAI', 'http://127.0.0.1:3001', true]);
  // the main worktree, another agent: the same finding is being fixed in another folder
  const mine = await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' });
  assert.equal(mine.code, 1);
  assert.match(mine.lines.at(-1), /^Codex is already fixing this finding in another folder \(branch nunchi\/fixes-two, (just started|\d+ min)\)\. Wait for it, or decide something else in the board/);
  // nor are its checks run here, on another branch
  const checks = await F.checkFix(ctxOf(p), p.group);
  assert.deepEqual([checks.code, checks.lines.at(-1)], [1, `This attempt is on branch nunchi/fixes-two, and this folder is on main: run nunchi fix --checks ${p.group} where nunchi/fixes-two is checked out.`]);
  assert.equal(latest(p).phase, 'started', 'the attempt is as it was');
});

test('--verify refuses a --url another live claim uses, and moves the claim to a free one', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  assert.equal((await F.startFix(two.ctx(), p.group, { agent: 'Codex', url: 'http://127.0.0.1:3001' })).code, 0);
  edit(two.wt, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(two.ctx(), p.group);
  assert.equal(c.code, 0, c.lines.join('\n'));
  commitWith(two.wt, trailers(c));
  // another group's fix in the main worktree checks the app at :3002
  const other = C.acquireClaim(stateDir(p), { group: 'bbbbbbbbbbbb', worktree: git(p.root, 'rev-parse', '--show-toplevel'), branch: 'nunchi/fixes-1015', url: 'http://127.0.0.1:3002', files: ['app/page.jsx'], agent: 'Claude Code' });
  assert.equal(other.ok, true);
  let v = await F.verifyFix(two.ctx(), p.group, { url: 'http://127.0.0.1:3002/' });
  assert.deepEqual([v.code, v.lines], [1, ['Another fix (branch nunchi/fixes-1015) is checking the app at http://127.0.0.1:3002. Start the app from this folder on a free port (e.g. `PORT=3001 npm run dev`), then verify with `--url http://127.0.0.1:3001`.']]);
  assert.doesNotMatch(v.lines.join('\n'), /worktree/);
  assert.equal(C.readClaim(stateDir(p), p.group).url, 'http://127.0.0.1:3001', 'the claim keeps its address');
  v = await F.verifyFix(two.ctx(), p.group, { url: 'http://127.0.0.1:3003' });
  assert.equal(v.code, 0, v.lines.join('\n'));
  assert.match(v.lines.at(-1), new RegExp(`^Fixed '${TITLE}'`));
  assert.deepEqual([latest(p).phase, latest(p).url, two.cap.calls.at(-1).baseUrl], ['fixed', 'http://127.0.0.1:3003', 'http://127.0.0.1:3003']);
});

test('--verify in a worktree other than the attempt\'s needs its own app (--url); P0 is read from the folder it was captured in', async () => {
  const p = await fixProject();
  const s = await F.startFix(ctxOf(p), p.group);                               // the main worktree, its sweep's address
  assert.equal(s.code, 0, s.lines.join('\n'));
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(ctxOf(p), p.group);
  commitWith(p.root, trailers(c));
  // the fix branch moves to another folder (a branch is checked out in one worktree at a time)
  const branch = latest(p).branch;
  git(p.root, 'switch', '-q', 'main');
  const three = linked(p, 'three', branch);
  let v = await F.verifyFix(three.ctx(), p.group);
  assert.deepEqual([v.code, v.lines], [1, [OWN('verify')]]);
  v = await F.verifyFix(three.ctx(), p.group, { url: 'http://127.0.0.1:3005' });
  assert.equal(v.code, 0, v.lines.join('\n'));
  assert.match(v.lines.at(-1), new RegExp(`^Fixed '${TITLE}'`));
  assert.deepEqual([latest(p).phase, latest(p).p1.stream], ['fixed', 'wt:three']);
});

test('the single-agent path never mentions worktrees: the same folder\'s second start, and its URL refusal', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' })).code, 0);
  const again = await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' });
  assert.doesNotMatch(again.lines.join('\n'), /worktree/);
  assert.doesNotMatch(C.refusalText({ why: 'url', group: 'aaaaaaaaaaaa', claim: { branch: 'b', url: 'http://127.0.0.1:3000', lastRenewal: new Date().toISOString() } }), /worktree/);
});

test('a sweep whose folder cannot be found now is said, never read: fix --plan goes on, fix --start refuses', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  renameSync(join(p.nunchi, 'runs'), join(p.nunchi, 'runs-away'));
  try {
    assert.equal(F.planFixes(two.ctx()).code, 0);
    const r = await F.startFix(two.ctx(), p.group, { url: 'http://127.0.0.1:3001' });
    assert.deepEqual([r.code, r.lines], [1, ['The last capture (run 0001) was made in another folder of this repository, which nunchi cannot find now: capture again (nunchi capture --url <your local server>) on the branch you ship from.']]);
  } finally { renameSync(join(p.nunchi, 'runs-away'), join(p.nunchi, 'runs')); }
});
