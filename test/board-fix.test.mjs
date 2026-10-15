// The fix loop on the board (design 0.1-c §3.4 "Fix states on the board", "Undo and reopen"): a live claim, the three
// *needs you* kinds with exactly their actions, before/after for both viewports, "Looks fine" only when the defect itself
// is gone, the sentence that undoes a fix that landed. API tests here; the page in a real browser further down (skipped
// without Chromium unless NUNCHI_REQUIRE_BROWSER is set). Synthetic git projects (test/fixtures/fix-project.mjs).
// (Split in three for the per-file timeout on the slowest CI runner: these five, board-fix-cases.test.mjs and
// board-fix-e2e.test.mjs; helpers in test/fixtures/board-fix-helpers.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as P from '../src/project.mjs';
import { FIX_WORDS } from '../src/board/shared.mjs';
import { fixProject, edit, commitWith, tmp } from './fixtures/fix-project.mjs';
import { ctxOf, attempt, board } from './fixtures/board-fix-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-fix-xdg-');

test('board: needs you (a) — the share, before/after for both viewports (the probes P0 and P1), "Looks fine" marks it fixed once, as the person', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'ROOMY SHIFT']);
  const rec = R.latestRecord(P.stateOf(p.nunchi).root.dir, p.group);
  const { b, call } = await board(p);
  try {
    const d = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([d.fix.needs, d.fix.defectGone, d.fix.before, d.fix.after, d.fix.record, d.fix.attempt, d.needsYou.reason], ['a', true, rec.p0.run, rec.p1.run, rec.attempt, 1, 'fix-a']);
    assert.ok(d.fix.share > 0.01);
    assert.deepEqual(d.compare.map(c => [c.viewport, c.before.run, c.after.run, c.before.id === c.after.id]), [['d', rec.p0.run, rec.p1.run, true], ['m', rec.p0.run, rec.p1.run, true]]);
    const img = await call(d.compare[0].after.img.thumb);
    assert.deepEqual([img.status, img.type], [200, 'image/jpeg'], 'a probe\'s screenshot is served like any run\'s');
    // it stands in the way as "needs you" (the verdict names blocker and high only; this one is medium)
    const { buildBoardModel } = await import('../src/board/model.mjs');
    assert.equal(buildBoardModel({ nunchiDir: p.nunchi, projectDir: p.root }).summary.standing['needs-you'].medium, 1);
    assert.equal(FIX_WORDS.a('4%'), 'The fix also changed other parts of this screen (4%). Is that OK?');
    // [Looks fine, mark fixed]: the person's key only; once
    assert.equal((await call('/api/fix-accept', { group: p.group, attempt: rec.attempt }, { token: 'f'.repeat(64) })).status, 401);
    assert.equal((await call('/api/fix-accept', { group: p.group, attempt: 'x' })).status, 400);
    const ok = await call('/api/fix-accept', { group: p.group, attempt: rec.attempt });
    assert.deepEqual([ok.status, ok.json.ok], [200, true]);
    const after = R.latestRecord(P.stateOf(p.nunchi).root.dir, p.group);
    assert.deepEqual([after.phase, after.accepted.channel], ['fixed', 'board']);
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([g.status, g.fix.needs, g.fix.landed, g.fix.commit], ['fixed', null, true, after.commit.slice(0, 7)]);
    assert.equal((await call('/api/fix-accept', { group: p.group, attempt: rec.attempt })).status, 409, 'it no longer waits');
  } finally { await b.close(); }
});

test('board: needs you (b) clears once the person keeps it (or says Later); (c) waits for "retry"; a live claim shows who is fixing and asks before deciding against it', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'WRAP']);
  await attempt(p, ['TINY', 'WRAP']);
  const { b, call } = await board(p);
  try {
    assert.equal((await call(`/api/groups/${p.group}`)).json.fix.needs, 'b');
    const kept = await call('/api/decide', { targets: [p.group], decision: 'keep', reason: 'intended', confirmed: true });
    assert.equal(kept.status, 200);
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([g.status, g.fix.needs, g.needsYou], ['kept', null, null], 'answered by the person');
  } finally { await b.close(); }
  const q = await fixProject();
  assert.equal((await F.startFix(ctxOf(q), q.group, { agent: 'Claude Code' })).code, 0);
  const { b: b2, call: call2 } = await board(q);
  try {
    const s = (await call2('/api/summary')).json;
    assert.ok(s.now.some(l => /^Claude Code is fixing Tap target smaller than 24px · just started$/.test(l)), s.now.join('\n'));
    assert.deepEqual((await call2(`/api/groups/${q.group}`)).json.fixing, { agent: 'Claude Code', minutes: 0 });
    const ask = await call2('/api/decide', { targets: [q.group], decision: 'false-positive', reason: 'not-a-problem' });
    assert.deepEqual([ask.status, ask.json.confirm.text], [409, 'Claude Code is fixing this right now. Stop and mark Not a problem?']);
    // (c): the screens did not load at verify
    edit(q.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
    commitWith(q.root, (await F.checkFix(ctxOf(q), q.group)).json.trailers);
    q.world.fail = ['/settings'];
    await F.verifyFix(ctxOf(q), q.group);
    const g = (await call2(`/api/groups/${q.group}`)).json;
    assert.deepEqual([g.fix.needs, g.needsYou.reason, g.fixing], ['c', 'fix-c', null]);
  } finally { await b2.close(); }
});

// ---- M3 review: the board's fix states ------------------------------------------------------------------------------------

test('board: before/after shows the screen the fix changed most (drift is measured over the whole scope), and names its route', async () => {
  const { compareOf } = await import('../src/board/model.mjs');
  const sc = (run, route, vp) => ({ run, id: `${route.slice(1)}.guest.normal.${vp}`, route, person: 'guest', state: 'normal', viewport: vp, status: 'captured', img: { w: 10, h: 10, dpr: 1, vh: 10, file: 'full.jpg', thumb: 'top.jpg' } });
  const ev = run => { const scenes = ['/settings', '/help'].flatMap(r => ['d', 'm'].map(v => sc(run, r, v))); return { scenes, sceneById: new Map(scenes.map(s => [s.id, s])) }; };
  const model = { evidenceOf: run => ev(run) };
  const g = { fix: { before: '0002', after: '0003', drift: ['help.guest.normal.d'] }, _rows: [{ route: '/settings' }] };
  const c = compareOf(model, g);
  assert.deepEqual(c.map(x => [x.viewport, x.route, x.after.id]), [['d', '/help', 'help.guest.normal.d'], ['m', '/settings', 'settings.guest.normal.m']]);
});

test('board: "Try again with a note…" answers needs you (a): the card goes, and "Looks fine" can no longer mark it fixed', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'ROOMY SHIFT']);
  const rec = R.latestRecord(P.stateOf(p.nunchi).root.dir, p.group);
  const { b, call } = await board(p);
  try {
    assert.equal((await call(`/api/groups/${p.group}`)).json.fix.needs, 'a');
    assert.equal((await call('/api/decide', { targets: [p.group], decision: 'fix', reason: null, note: 'keep the panel where it was', confirmed: true })).status, 200);
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([g.fix.needs, g.needsYou], [null, null]);
    assert.equal(g.fix.landed, true, 'the kept commit is still on the branch: the undo sentence stays');
    assert.equal((await call('/api/fix-accept', { group: p.group, attempt: rec.attempt })).status, 409);
  } finally { await b.close(); }
});

test('board: Keep after needs you (a) still shows how to undo the commit left on the branch; (b)\'s after reads "Attempt 2 (undone)"', async () => {
  const p = await fixProject();
  await attempt(p, ['TINY', 'ROOMY SHIFT']);
  const { b, call } = await board(p);
  try {
    assert.equal((await call('/api/decide', { targets: [p.group], decision: 'keep', reason: 'intended', confirmed: true })).status, 200);
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.deepEqual([g.fix.needs, g.fix.landed], [null, true]);
  } finally { await b.close(); }
  const q = await fixProject();
  await attempt(q, ['TINY', 'WRAP']);
  await attempt(q, ['TINY', 'WRAP']);
  const { b: b2, call: call2 } = await board(q);
  try {
    const g = (await call2(`/api/groups/${q.group}`)).json;
    assert.deepEqual([g.fix.needs, g.fix.afterLabel, g.fix.landed], ['b', 'Attempt 2 (undone)', false]);
  } finally { await b2.close(); }
});
