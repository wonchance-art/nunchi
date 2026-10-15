// An attempt held in another folder (design 0.1-c §7, M6 review): a fix command run in one worktree never judges another
// worktree's attempt with its own HEAD. It reads that attempt's commit from its branch (branch refs are shared), never
// cancels or undoes it from here, closes it as needs you on an expired claim (naming the folder and the branch), and
// refuses a second attempt while its commit waits there; one whose folder is gone can be stopped with fix --abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as F from '../src/fix/loop.mjs';
import * as C from '../src/fix/claims.mjs';
import * as P from '../src/project.mjs';
import { fixProject, fakeCapture, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';
import { proveOk, ctxOf, stateDir, latest, trailers, TITLE } from './fixtures/fix-loop-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-fix-away-xdg-');
// A linked worktree on a fix branch, with the decisions as they were (they travel as files); Codex fixes there.
function linked(p, name) {
  const wt = join(tmp('nunchi-wt-'), name);
  git(p.root, 'worktree', 'add', '-q', wt, '-b', `nunchi/fixes-${name}`);
  cpSync(join(p.nunchi, 'decisions'), join(wt, '.nunchi', 'decisions'), { recursive: true });
  const cap = fakeCapture(wt);
  return { wt, cap, ctx: (extra = {}) => F.openFix({ cwd: wt, root: wt, deps: { capture: cap.capture, prove: proveOk, ...extra } }) };
}
// Codex starts, edits, checks and commits its fix in the linked worktree. → the commit
async function codexCommits(p, two) {
  assert.equal((await F.startFix(two.ctx(), p.group, { agent: 'Codex', url: 'http://127.0.0.1:3001' })).code, 0);
  edit(two.wt, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(two.ctx(), p.group);
  assert.equal(c.code, 0, c.lines.join('\n'));
  commitWith(two.wt, trailers(c));
  return git(two.wt, 'rev-parse', 'HEAD');
}
const tip = (p, branch) => git(p.root, 'rev-parse', `refs/heads/${branch}`);

test('a Keep decided while another folder holds a committed fix: nothing is cancelled or undone from here; that folder undoes it on its next command', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  const commit = await codexCommits(p, two);
  P.recordDecisions(P.loadLedger(p.nunchi, { root: p.root }), { targets: [{ group: p.group }], decision: 'keep', reason: 'intended', by: 'Tester', channel: 'board' });
  const r = await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' });
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^You decided Keep on this finding while it is being fixed in another folder \(.*two, branch nunchi\/fixes-two\): that attempt stops \(and its commit [0-9a-f]{7} is undone\) when the next nunchi fix command runs in that folder\. Nothing was changed from here\.$/);
  assert.deepEqual([latest(p).phase, latest(p).commit], ['committed', commit], 'still open, its commit read from the branch');
  assert.ok(C.readClaim(stateDir(p), p.group), 'the claim is still Codex\'s');
  assert.equal(tip(p, 'nunchi/fixes-two'), commit, 'nothing reverted');
  // the decision reaches that folder (a commit, here a copy): its next command undoes the fix there
  cpSync(join(p.nunchi, 'decisions'), join(two.wt, '.nunchi', 'decisions'), { recursive: true });
  const v = await F.verifyFix(two.ctx(), p.group);
  assert.match(v.lines.join('\n'), /Stopped fixing 'Tap target smaller than 24px': you decided Keep while I was fixing it/);
  assert.notEqual(tip(p, 'nunchi/fixes-two'), commit, 'undone by a revert commit there');
  assert.equal(latest(p).phase, 'cancelled');
});

test('a claim that expired while another folder held a committed fix: needs you, naming that folder and branch; no second attempt while the commit waits there', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  const commit = await codexCommits(p, two);
  const later = Date.now() + 31 * 60e3;
  const r = await F.startFix(ctxOf(p, { now: () => later }), p.group, { agent: 'Claude Code' });
  assert.equal(r.code, 1);
  assert.match(r.lines[0], new RegExp(`^The fix of this finding in another folder \\(.*two, branch nunchi/fixes-two\\) \\(commit ${commit.slice(0, 7)}\\) was not re-checked before its claim expired\\. It needs you: in that folder, tell your AI “retry” to re-check it, or “undo it”\\.$`));
  assert.match(r.lines[1], new RegExp(`^The last fix of '${TITLE}' \\(commit ${commit.slice(0, 7)}\\) waits on branch nunchi/fixes-two in another folder \\(.*two\\), not re-checked: re-check it there \\(nunchi fix --verify ${p.group}\\), or undo it there \\(nunchi fix --undo ${p.group}\\)\\.$`));
  const rec = latest(p);
  assert.deepEqual([rec.attempt, rec.phase, rec.outcome.needsYou, rec.outcome.commit, rec.outcome.branch], [1, 'needs-you', 'interrupted', commit, 'nunchi/fixes-two'], 'no second attempt');
  assert.equal(tip(p, 'nunchi/fixes-two'), commit);
  // that folder re-checks it ("retry")
  const v = await F.verifyFix(two.ctx({ now: () => later }), p.group, { url: 'http://127.0.0.1:3001' });
  assert.match(v.lines.at(-1), new RegExp(`^Fixed '${TITLE}'`));
});

test('an attempt whose folder is gone is never waited for: fix --start says to stop it, and fix --abort does, from here', async () => {
  const p = await fixProject();
  const two = linked(p, 'two');
  assert.equal((await F.startFix(two.ctx(), p.group, { agent: 'Codex', url: 'http://127.0.0.1:3001' })).code, 0);
  rmSync(two.wt, { recursive: true, force: true });
  const r = await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' });
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), new RegExp(`^The fix of '${TITLE}' was started in a folder that is no longer there \\(.*two, branch nunchi/fixes-two\\): stop it with \`nunchi fix --abort ${p.group}\`, or wait (29|30) min for its claim to expire\\.$`));
  const a = await F.abortFix(ctxOf(p), p.group);
  assert.deepEqual([a.code, a.lines.at(-1)], [0, `Stopped fixing '${TITLE}' before a commit. It is still to fix.`]);
  assert.equal(C.readClaim(stateDir(p), p.group), null, 'the claim is released');
  assert.equal((await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' })).code, 0, 'and it can be fixed here now');
});
