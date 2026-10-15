// The fix loop on the board (design 0.1-c §3.4 "Fix states on the board", "Undo and reopen"): a live claim, the three
// *needs you* kinds with exactly their actions, before/after for both viewports, "Looks fine" only when the defect itself
// is gone, the sentence that undoes a fix that landed. API tests here; the page in a real browser further down (skipped
// without Chromium unless NUNCHI_REQUIRE_BROWSER is set). Synthetic git projects (test/fixtures/fix-project.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as C from '../src/fix/claims.mjs';
import * as P from '../src/project.mjs';
import { FIX_WORDS } from '../src/board/shared.mjs';
import { fixProject, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-fix-xdg-');
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const ctxOf = p => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: async () => ({ ok: true }) } });
async function attempt(p, change) {
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', ...change);
  const c = await F.checkFix(ctxOf(p), p.group);
  commitWith(p.root, c.json.trailers);
  return F.verifyFix(ctxOf(p), p.group);
}
async function board(p) {
  const b = await startBoard({ projectDir: p.root });
  const origin = b.origin;
  const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
  const call = async (path, body, { token = s.token } = {}) => {
    const res = await fetch(origin + path, body === undefined ? { headers: { 'x-nunchi-token': token } } : { method: 'POST', headers: { 'x-nunchi-token': token, 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, type: res.headers.get('content-type') };
  };
  return { b, call };
}
const decisionsOf = nunchi => readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8')));

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

// ---- in a real browser -------------------------------------------------------------------------------------------------

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await browser?.close(); });
async function page(p, viewport = { width: 1280, height: 900 }) {
  const b = await startBoard({ projectDir: p.root });
  const context = await browser.newContext({ viewport });
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(String(e)));
  await pg.goto(b.newLink());
  await pg.waitForSelector('#h-progress');
  return { b, pg, errors, close: async () => { await context.close(); await b.close(); } };
}

test('board e2e: needs you (a) in Detail — the text and exactly its three actions, before/after with a slider (←/→) for both viewports, Looks fine', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = await fixProject();
  await attempt(p, ['TINY', 'ROOMY SHIFT']);
  const s = await page(p);
  const { pg } = s;
  try {
    await pg.evaluate(id => { location.hash = `#/finding/${id}`; }, p.group);
    await pg.waitForSelector('.fix-compare');
    // one evaluation: live redraws make separate handle round trips flaky
    const m = await pg.evaluate(() => {
      const needs = document.querySelector('.needs');
      const cmp = document.querySelector('.fix-compare');
      const shots = [...cmp.querySelectorAll('.cmp .shot')].map(x => { const r = x.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), clip: x.style.clipPath, label: x.getAttribute('aria-label') }; });
      const slider = cmp.querySelector('input[type=range]');
      return { text: needs.textContent, buttons: [...needs.querySelectorAll('button')].map(b => b.textContent), shots, slider: { value: slider.value, label: slider.getAttribute('aria-label'), h: slider.getBoundingClientRect().height },
        widths: [...cmp.querySelectorAll('.seg-b button')].map(b => [b.textContent, b.getAttribute('aria-pressed')]), labels: cmp.querySelector('.cmp-labels').textContent };
    });
    assert.match(m.text, /^Needs youThe fix also changed other parts of this screen \(\d+%\)\. Is that OK\?/);
    assert.deepEqual(m.buttons, ['Looks fine, mark fixed', 'Undo this fix', 'Try again with a note…']);
    assert.equal(m.shots.length, 2);
    assert.deepEqual([m.shots[0].x, m.shots[0].y, m.shots[0].w, m.shots[0].h], [m.shots[1].x, m.shots[1].y, m.shots[1].w, m.shots[1].h], 'after lies exactly over before');
    assert.deepEqual([m.shots[1].clip, m.slider.value, m.slider.label, m.labels], ['inset(0px 0px 0px 50%)', '50', 'Before and after', 'BeforeAfter']);
    assert.match(m.shots[0].label, /^Before: \/settings/);
    assert.ok(m.slider.h >= 44, 'a 44 px target');
    assert.deepEqual(m.widths, [['Desktop', 'true'], ['Phone', 'false']]);
    await pg.focus('.fix-compare input[type=range]');
    await pg.keyboard.press('ArrowRight');
    await pg.keyboard.press('ArrowRight');
    const moved = await pg.evaluate(() => ({ v: document.querySelector('.fix-compare input[type=range]').value, clip: document.querySelector('.cmp .cmp-after').style.clipPath, url: location.hash }));
    assert.deepEqual([moved.v, moved.clip], ['60', 'inset(0px 0px 0px 60%)'], '→ moves the slider; the keys never leave the field');
    await pg.click('.fix-compare .seg-b button:nth-child(2)');
    const phone = await pg.evaluate(() => ({ pressed: document.querySelector('.fix-compare .seg-b button[aria-pressed=true]').textContent, label: document.querySelector('.fix-compare .cmp .shot').getAttribute('aria-label'), m: document.querySelector('.fix-compare .cmp .shot').classList.contains('shot-m'),
      focus: document.activeElement?.id, group: document.querySelector('.fix-compare .seg-b').getAttribute('aria-label'), needsH: document.querySelector('.needs h2')?.textContent, route: document.querySelector('.cmp-route')?.textContent }));
    assert.deepEqual([phone.pressed, phone.m], ['Phone', true]);
    assert.equal(phone.focus, 'cmp-vp-m', 'the redraw gives the focus back to the toggle, not the heading');
    assert.deepEqual([phone.group, phone.needsH, phone.route], ['Before/after width', 'Needs you', 'Before and after on /settings']);
    assert.match(phone.label, /Phone/);
    // the row says it needs you (to a screen reader too)
    await pg.evaluate(() => { location.hash = '#/findings'; });
    await pg.click('[role=tab]:has-text("To fix")');
    await pg.waitForSelector('.row');
    const aria = await pg.evaluate(id => document.getElementById(`row-${id}`)?.getAttribute('aria-label'), p.group);
    assert.match(aria, /, Needs you$/);
    await pg.evaluate(id => { location.hash = `#/finding/${id}`; }, p.group);
    await pg.waitForSelector('.needs button');
    // axe on Detail with the needs-you box and the comparison
    await pg.evaluate(AXE);
    const v = await pg.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => x.id));
    assert.deepEqual(v, []);
    // [Looks fine, mark fixed]
    await pg.click('.needs button:first-child');
    await pg.waitForFunction(() => !document.querySelector('.needs') && [...document.querySelectorAll('.detail-head .st')].some(x => x.textContent === 'Fixed'));
    const landed = await pg.evaluate(() => [...document.querySelectorAll('.facts-dl dt')].map(d => [d.textContent, d.nextElementSibling.textContent]).find(([k]) => k === 'Fix'));
    assert.match(landed[1], /^Fixed by your AI in commit [0-9a-f]{7}\. To undo it, tell your AI: undo the fix of “Tap target smaller than 24px” \(nunchi fix --undo [0-9a-f]{12}\)/);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('board e2e: needs you (b) — [Try again with a note…] [Keep] [Later]; the note goes with a new Fix decision; (c) says the sentence', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = await fixProject();
  await attempt(p, ['TINY', 'WRAP']);
  await attempt(p, ['TINY', 'WRAP']);
  const s = await page(p, { width: 390, height: 844 });
  const { pg } = s;
  try {
    await pg.evaluate(id => { location.hash = `#/finding/${id}`; }, p.group);
    await pg.waitForSelector('.needs .actions');
    const m = await pg.evaluate(() => ({ text: document.querySelector('.needs').textContent, buttons: [...document.querySelectorAll('.needs button')].map(b => [b.textContent, Math.round(b.getBoundingClientRect().height)]), wide: document.documentElement.scrollWidth <= innerWidth }));
    assert.equal(m.text, 'Needs youThe AI couldn’t fix this in 2 tries.Try again with a note…KeepLater');
    assert.deepEqual(m.buttons.map(b => b[0]), ['Try again with a note…', 'Keep', 'Later']);
    assert.ok(m.buttons.every(b => b[1] >= 44), 'every action is a 44 px target');
    assert.ok(m.wide, 'no sideways scroll at 390 px');
    await pg.click('.needs button:first-child');
    await pg.fill('#fix-note', 'Use a 44 px min-height on the button itself');
    await pg.click('#dialog .b-primary');
    const note = async () => decisionsOf(p.nunchi).find(d => d.decision === 'fix' && d.note);
    for (let i = 0; i < 50 && !(await note()); i++) await new Promise(r => setTimeout(r, 100));
    const d = await note();
    assert.deepEqual([d.note, d.channel, d.target.group], ['Use a 44 px min-height on the button itself', 'board', p.group]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  // (c)
  const q = await fixProject();
  assert.equal((await F.startFix(ctxOf(q), q.group)).code, 0);
  edit(q.root, 'app/settings/page.jsx', 'TINY', 'ROOMY');
  commitWith(q.root, (await F.checkFix(ctxOf(q), q.group)).json.trailers);
  q.world.fail = ['/settings'];
  await F.verifyFix(ctxOf(q), q.group);
  const s2 = await page(q);
  try {
    await s2.pg.evaluate(id => { location.hash = `#/finding/${id}`; }, q.group);
    await s2.pg.waitForSelector('.needs');
    const c = await s2.pg.evaluate(() => ({ text: document.querySelector('.needs').textContent, buttons: document.querySelectorAll('.needs button').length }));
    assert.deepEqual(c, { text: 'Needs youCouldn’t re-check: the screen didn’t load.Start your app, then tell your AI “retry”.', buttons: 0 });
  } finally { await s2.close(); }
});
