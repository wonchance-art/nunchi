// The fix loop on the board, continued from test/board-fix.test.mjs (split for the per-file timeout on the slowest CI
// runner): its own kind for a fix that touched files only the person approves, a live claim against a dismissal, the
// handoff count, the check profile of --root, needs you (a) by geometry alone. Synthetic git projects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as F from '../src/fix/loop.mjs';
import * as P from '../src/project.mjs';
import { fixProject, edit, commitWith } from './fixtures/fix-project.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { ctxOf, attempt, board } from './fixtures/board-fix-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-fix-cases-xdg-');

test('board: a fix that touched files only the person can approve is its own kind (diff), with the paths from the record and never the engine\'s line', async () => {
  const p = await fixProject();
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  edit(p.root, 'app/page.jsx', 'Plant shelf', 'Plant shelf!');            // a file outside the finding's own
  commitWith(p.root, (await F.checkFix(ctxOf(p), p.group)).json.trailers);
  await F.verifyFix(ctxOf(p), p.group);
  const { b, call } = await board(p);
  try {
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([g.fix.needs, g.fix.kind, g.fix.landed, g.fix.paths], ['diff', 'diff', true, ['app/page.jsx']]);
    assert.equal(g.fix.line, undefined, 'the board says it in its own words');
    assert.match(g.fix.commit, /^[0-9a-f]{7}$/);
  } finally { await b.close(); }
});

test('board: deciding against a live claim asks about the claim inside the dismissal\'s question, not never', async () => {
  const p = await fixProject({ world: { secret: true } });
  assert.equal((await F.startFix(ctxOf(p), p.group, { agent: 'Claude Code' })).code, 0);
  const secret = p.groups.find(g => g.rule === 'secret-in-client-bundle').group;
  const { b, call } = await board(p);
  try {
    const ask = await call('/api/decide', { targets: [p.group, secret], decision: 'false-positive', reason: 'not-a-problem' });
    assert.equal(ask.status, 409);
    assert.match(ask.json.confirm.text, /^Mark 2 groups Not a problem\? 1 is a blocker.*Claude Code is fixing one of them right now: this stops that\.$/);
    assert.equal(ask.json.confirm.ok, 'Stop and mark');
  } finally { await b.close(); }
});

test('handoff: a group whose fix waits for the person is not "to fix" for the AI; Decisions and findings count it apart', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'WRAP']);
  await attempt(p, ['TINY', 'WRAP']);
  const { buildBoardModel } = await import('../src/board/model.mjs');
  const s = buildBoardModel({ nunchiDir: p.nunchi, projectDir: p.root }).summary;
  assert.deepEqual([s.toFix, s.fixNeedsYou, s.handoff], [0, 1, null]);
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'findings'], { cwd: p.root, encoding: 'utf8' });
  assert.match(out, /1 group\(s\) to fix need you: their fix waits for you in the board \(nunchi open\), not for your AI/);
});

test('board: the check profile shown and approved is the one of the folder the fix loop asked for (--root)', async () => {
  const p = await fixProject();
  const web = join(p.root, 'web');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(web);
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'web', scripts: { test: 'vitest run' } }));
  mkdirSync(join(P.stateOf(p.nunchi).root.dir), { recursive: true });
  writeFileSync(join(P.stateOf(p.nunchi).root.dir, 'checks-request.json'), JSON.stringify({ schema: 1, hash: 'x', root: web }));
  const { b, call } = await board(p);
  try {
    const s = (await call('/api/summary')).json;
    assert.deepEqual(Object.keys(s.checks.profile.scripts), ['test']);
    assert.equal((await call('/api/approve-checks', { profile: s.checks.profile.hash })).status, 200);
    const { checkProfile, approvedProfiles, scriptsApprovedPath } = await import('../src/checks.mjs');
    assert.ok(approvedProfiles(scriptsApprovedPath(P.stateOf(p.nunchi).root.dir)).has(checkProfile(web).hash));
  } finally { await b.close(); }
});

test('board: needs you (a) by geometry alone says what moved (the card is not handed a share of pixels nobody measured over the line)', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'ROOMY MOVE']);
  const { b, call } = await board(p);
  try {
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.equal(g.fix.needs, 'a');
    assert.equal(g.fix.pixels, false);
    assert.ok(g.fix.moved >= 1);
  } finally { await b.close(); }
});
