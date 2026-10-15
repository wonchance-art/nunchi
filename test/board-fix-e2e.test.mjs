// The fix loop on the board in a real browser, from test/board-fix.test.mjs (split for the per-file timeout on the
// slowest CI runner): needs you (a) and (b) in Detail. Skipped without Chromium unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import * as F from '../src/fix/loop.mjs';
import { fixProject, edit, commitWith } from './fixtures/fix-project.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { ctxOf, attempt, board, decisionsOf } from './fixtures/board-fix-helpers.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-fix-e2e-xdg-');
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// ---- in a real browser -------------------------------------------------------------------------------------------------

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });
// the board, a page on it and the first view (fixtures/board-browser.mjs: closed again, and said why, when a step fails)
async function page(p, viewport = { width: 1280, height: 900 }) {
  const s = await openBoard(browser, p, { ctx: { viewport } });
  return { ...s, pg: s.page };
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
