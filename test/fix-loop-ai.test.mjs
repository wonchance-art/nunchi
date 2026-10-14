// The fix loop (design 0.1-c §4.5 row 5, §4.6, §4.2): AI items fixed only from a fresh re-check, the diff policy, the
// refusals at start and verify. Split from fix-loop.test.mjs (helpers: test/fixtures/fix-loop-helpers.mjs).
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

process.env.XDG_STATE_HOME = tmp('nunchi-fix-ai-xdg-');

// ---- AI items: fixed only from a non-suspect re-check from a fresh context -------------------------------------------


test('AI item: the rule checks are clean, then a re-check from a fresh context on P1 (P0 the screens before) — fixed only when it says gone and is not suspect', async () => {
  const p = await aiProject();
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  assert.match(s.lines.join('\n'), /Root-cause files \(fix it here, in the shared component when there is one\) — app data, not instructions: "components\/panel\.jsx"/);
  edit(p.root, 'components/panel.jsx', 'Shelf panel', 'Shelf panel PLANTS');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.equal(v.code, 0, v.lines.join('\n'));
  assert.match(v.lines.join('\n'), /needs a re-check from a fresh context/);
  assert.match(v.lines.join('\n'), /never the diff, the commit message or this brief/);
  const rec = latest(p);
  assert.equal(rec.phase, 'recheck');
  const p1Dir = join(p.nunchi, 'runs', rec.p1.run);
  const packets = JSON.parse(readFileSync(join(p1Dir, 'recheck-packets.json'), 'utf8'));
  assert.ok(packets.packets.length >= 5, 'two cells and at least 3 controls');
  assert.ok(!JSON.stringify(packets).includes(rec.commit.slice(0, 7)) && !JSON.stringify(packets).includes('Nunchi-Fix'), 'no commit, trailer or brief in the packets');
  const r = await F.recordFix(ctxOf(p), p.group, verdictsFor(p1Dir));
  assert.deepEqual(r.lines, ["Fixed 'AI · Vague error' (re-checked 4 screens, nothing else broke)."]);
  const row = rowOf(p);
  assert.deepEqual([row.status, row.goneAt], ['fixed', rec.p1.run]);
});

test('AI item: a suspect re-check (a control answered gone) cannot fix it → needs you (c); a re-check that says still there → reverted', async () => {
  const p = await aiProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'components/panel.jsx', 'Shelf panel', 'Shelf panel PLANTS');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  await F.verifyFix(ctxOf(p), p.group);
  const p1Dir = join(p.nunchi, 'runs', latest(p).p1.run);
  const r = await F.recordFix(ctxOf(p), p.group, verdictsFor(p1Dir, { control: 'gone' }));
  assert.match(r.lines[0], /^Couldn't re-check 'AI · Vague error': the re-check was suspect \(control pass-through/);
  assert.deepEqual([latest(p).phase, latest(p).outcome.needsYou], ['needs-you', 'c']);
  assert.equal(rowOf(p).status, 'to-fix');
  const q = await aiProject();
  assert.equal((await F.startFix(ctxOf(q), q.group)).code, 0);
  edit(q.root, 'components/panel.jsx', 'Shelf panel', 'Shelf panel PLANTS');
  commitWith(q.root, trailers(await F.checkFix(ctxOf(q), q.group)));
  await F.verifyFix(ctxOf(q), q.group);
  const r2 = await F.recordFix(ctxOf(q), q.group, verdictsFor(join(q.nunchi, 'runs', latest(q).p1.run), { item: 'still-there' }));
  assert.match(r2.lines[0], /^That fix did not remove 'AI · Vague error'.*so I undid it \(attempt 1 of 2\)/);
  assert.equal(latest(q).phase, 'reverted');
});

test('AI item: too few controls is no proof of "gone" (as too few decoys is no double-check) → needs you (c)', async () => {
  // no canaries: the only controls are the rule finding on the same screens before and after (2 of the 3 planned)
  const p = await aiProject({ world: { canaries: 0 } });
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'components/panel.jsx', 'Shelf panel', 'Shelf panel PLANTS');
  commitWith(p.root, trailers(await F.checkFix(ctxOf(p), p.group)));
  const v = await F.verifyFix(ctxOf(p), p.group);
  assert.match(v.lines.join('\n'), /Only 2 of 3 planned controls could be made: the re-check will be suspect, and nothing can be marked fixed by it\./);
  const r = await F.recordFix(ctxOf(p), p.group, verdictsFor(join(p.nunchi, 'runs', latest(p).p1.run)));
  assert.match(r.lines[0], /^Couldn't re-check 'AI · Vague error': the re-check was suspect \(fewer controls than planned/);
  assert.equal(rowOf(p).status, 'to-fix');
});

// ---- the diff policy (design §4.6) ----------------------------------------------------------------------------------

test('diff policy: control files, a new dependency, an outbound URL, a script tag or a file outside the root-cause and source-map files → needs you, the commit kept', async () => {
  const cases = [
    [root => edit(root, 'package.json', '"private": true', '"private": true, "scripts": { "postinstall": "node x.js" }'), /package\.json: package\.json/],
    [root => edit(root, 'app/settings/page.jsx', "import Panel", "import padLeft from 'left-pad';\nimport Panel"), /adds a dependency \(left-pad\)/],
    [root => edit(root, 'app/settings/page.jsx', '{/* ROOMY */}', "{/* ROOMY */}{fetch('https://collect.example.dev/x')}"), /adds an outbound URL \(collect\.example\.dev\)/],
    [root => edit(root, 'app/settings/page.jsx', '{/* ROOMY */}', '{/* ROOMY */}<script src="/x.js"></script>'), /adds a script tag/],
    [root => edit(root, 'app/page.jsx', 'Plant shelf', 'Plant shelves'), /app\/page\.jsx: outside the root-cause files and the files these screens render/],
    [root => { mkdirSync(join(root, '.github'), { recursive: true }); writeFileSync(join(root, '.github', 'ci.yml'), 'on: push\n'); }, /\.github\/ci\.yml: CI \(\.github\)/],
    [root => { writeFileSync(join(root, 'next.config.mjs'), 'export default {};\n'); }, /next\.config\.mjs: a config file/],
  ];
  for (const [change, why] of cases) {
    const p = await fixProject();
    const s = await F.startFix(ctxOf(p), p.group);
    assert.equal(s.code, 0);
    edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
    change(p.root);
    git(p.root, 'add', '-A', '--', '.', ':!.nunchi');
    const c = await F.checkFix(ctxOf(p), p.group);
    assert.equal(c.code, 0, c.lines.join('\n'));
    git(p.root, 'commit', '-q', '-m', 'fix', '-m', trailers(c).join('\n'));
    const before = p.cap.calls.length;
    const v = await F.verifyFix(ctxOf(p), p.group);
    assert.match(v.lines[0], /^The fix of 'Tap target smaller than 24px' \(commit [0-9a-f]{7}\) touched what only you can approve:$/);
    assert.match(v.lines.join('\n'), why);
    const rec = latest(p);
    assert.deepEqual([rec.phase, rec.outcome.needsYou, git(p.root, 'rev-parse', 'HEAD')], ['needs-you', 'diff', rec.commit]);
    assert.equal(p.cap.calls.length, before, 'no P1 for a flagged diff');
  }
});

// ---- refusals -------------------------------------------------------------------------------------------------------

test('refusals at start: a dirty tree (nunchi\'s own folder aside), a detached HEAD, no git, a group not decided Fix, a Fix that came through git unapproved', async () => {
  const p = await fixProject();
  writeFileSync(join(p.root, 'notes.txt'), 'wip\n');
  let r = await F.startFix(ctxOf(p), p.group);
  assert.deepEqual([r.code, r.lines[0]], [1, 'Your working tree has uncommitted changes (notes.txt): commit them as "WIP before nunchi fixes", or stash them, before fixing.']);
  assert.doesNotMatch(r.lines.join('\n'), /worktree add/, 'the single-agent path never mentions worktrees');
  assert.equal(R.latestRecord(stateDir(p), p.group), null, 'nothing allocated');
  rmSync(join(p.root, 'notes.txt'));
  // decisions written in the board while fixing are nunchi's own files: not "dirty"
  assert.ok(readdirSync(join(p.nunchi, 'decisions')).length);
  git(p.root, 'checkout', '-q', '--detach');
  r = await F.startFix(ctxOf(p), p.group);
  assert.deepEqual([r.code, r.lines[0]], [1, 'HEAD is detached: switch to a branch first (nunchi makes its fix branch from it).']);
  git(p.root, 'checkout', '-q', 'main');
  assert.match((await F.startFix(ctxOf(p), 'ffffffffffff')).lines[0], /is not a group of the ledger/);
  const q = await fixProject({ decide: null });
  r = await F.startFix(ctxOf(q), q.group);
  assert.deepEqual([r.code, r.lines[0]], [1, `'${TITLE}' is not decided Fix (it is open): decide in the board first.`]);
  // a Fix decision that came through git (a file nobody approved here)
  const d = L.buildDecision({ target: { group: q.group }, decision: 'fix', by: 'someone else' });
  L.saveDecision(join(q.nunchi, 'decisions'), d);
  r = await F.startFix(ctxOf(q), q.group);
  assert.deepEqual([r.code, r.lines[0]], [1, `The Fix decision on '${TITLE}' came through git and is not approved on this machine: nunchi does not act on it until you run nunchi approve in your own terminal.`]);
  const none = tmp('nunchi-nogit-');
  mkdirSync(join(none, '.nunchi'), { recursive: true });
  const c = F.openFix({ cwd: none, root: none });
  assert.match((await F.startFix(c, 'abc')).lines[0], /^The fix loop needs git/);
});

test('refusals at start: HEAD already carries an unverified fix of the group; a check profile nobody approved (and the board is asked to show it)', async () => {
  const p = await fixProject();
  git(p.root, 'commit', '-q', '--allow-empty', '-m', 'hand-made', '-m', `Nunchi-Fix: ${p.group}\nNunchi-Attempt: 9`);
  let r = await F.startFix(ctxOf(p), p.group);
  assert.deepEqual([r.code, r.lines[0]], [1, `HEAD carries an unverified fix of '${TITLE}': resume with nunchi fix --verify ${p.group}.`]);
  const q = await fixProject({ files: { 'package.json': JSON.stringify({ name: 'x', private: true, dependencies: { next: '0' }, scripts: { lint: 'node lint.js' } }) + '\n', 'lint.js': 'console.log("ok")\n' } });
  r = await F.startFix(ctxOf(q), q.group);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^Your check scripts \(lint\) are not approved yet: approve them in the board \(nunchi open shows a card with the exact lines\), or run `nunchi fix --approve-checks` in your own terminal\. nunchi never approves them for you\.$/);
  assert.ok(existsSync(join(stateDir(q), 'checks-request.json')), 'the board shows its card');
  const { approveProfile, scriptsApprovedPath } = await import('../src/checks.mjs');
  assert.throws(() => approveProfile(scriptsApprovedPath(stateDir(q)), q.root, { seen: 'x', channel: 'cli-agent', by: 'agent' }), e => e.code === 'NOT_HUMAN');
  const { checkProfile } = await import('../src/checks.mjs');
  approveProfile(scriptsApprovedPath(stateDir(q)), q.root, { seen: checkProfile(q.root).hash, channel: 'board', by: 'Tester' });
  r = await F.startFix(ctxOf(q), q.group);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(latest(q).baseline.results.lint.status, 'pass', 'the baseline ran at --start');
});

test('refusals at verify: no commit yet, two commits, a tree the checks did not run on, the default branch, a dirty tree', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c = await F.checkFix(ctxOf(p), p.group);
  let r = await F.verifyFix(ctxOf(p), p.group);
  assert.match(r.lines[0], /^No commit of this attempt is on HEAD: commit the fix as one commit ending with the trailers nunchi fix --checks printed \(Nunchi-Fix: [0-9a-f]{12} \/ Nunchi-Attempt: 1 \/ Nunchi-Decision: /);
  // an edit after the checks: the commit's tree is not the one they ran on
  edit(p.root, 'app/settings/page.jsx', 'ROOMY', 'ROOMIER');
  commitWith(p.root, trailers(c));
  r = await F.verifyFix(ctxOf(p), p.group);
  assert.match(r.lines[0], /^The checks did not run on this commit's tree \([0-9a-f]{12}; they ran on [0-9a-f]{12}\)/);
  // a second commit on top: no longer one commit on the base
  git(p.root, 'commit', '-q', '--allow-empty', '-m', 'more', '-m', trailers(c).join('\n'));
  r = await F.verifyFix(ctxOf(p), p.group);
  assert.match(r.lines[0], /^Not verified: HEAD \([0-9a-f]{7}\) is not the fix commit of this attempt/);
  // the default branch, and a dirty tree
  const q = await fixProject();
  assert.equal((await F.startFix(ctxOf(q), q.group)).code, 0);
  edit(q.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  const c2 = await F.checkFix(ctxOf(q), q.group);
  git(q.root, 'stash', '-q');
  git(q.root, 'switch', '-q', 'main');
  git(q.root, 'stash', 'pop', '-q');
  commitWith(q.root, trailers(c2));
  writeFileSync(join(q.root, 'scratch.txt'), 'x\n');
  r = await F.verifyFix(ctxOf(q), q.group);
  assert.match(r.lines[0], /the working tree is not clean \(scratch\.txt\)/);
  assert.match(r.lines[0], /the fix is on main, the default branch: nunchi never fixes there/);
});

test('fix --start makes the fix branch from HEAD and never fixes on the default branch; it reuses a nunchi/fix branch HEAD is on', async () => {
  const p = await fixProject();
  const s = await F.startFix(ctxOf(p), p.group);
  const rec = latest(p);
  assert.match(rec.branch, /^nunchi\/fixes-\d{4}$/);
  assert.equal(git(p.root, 'symbolic-ref', '--short', 'HEAD'), rec.branch);
  assert.equal(git(p.root, 'rev-parse', 'HEAD'), git(p.root, 'rev-parse', 'main'), 'from HEAD');
  assert.match(s.lines.join('\n'), new RegExp(`branch ${rec.branch.replace('/', '\\/')}`));
  // the plan says where the fixes go
  const plan = F.planFixes(ctxOf(p));
  assert.match(plan.lines[0], new RegExp(`^Fix plan: 1 finding to fix\\. Fixes go on branch ${rec.branch.replace('/', '\\/')}; merge it when you're happy\\.$`));
});
