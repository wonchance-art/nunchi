// The needs-you cards that carry no action of their own (interrupted, revert) or say a screen with no baseline
// (unbaselined), and (a)'s [Undo this fix], at 390 px (owner-approved mock-ups, spec §6.6). Apart from the history rows
// (board-fix-history.test.mjs) so neither file nears the per-file time limit on Windows. The page in a real browser
// (skipped without Chromium unless NUNCHI_REQUIRE_BROWSER is set). Synthetic projects (test/fixtures/fix-project.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as P from '../src/project.mjs';
import { fixProject, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-kinds-xdg-');
const ctxOf = p => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: async () => ({ ok: true }) } });
const sd = p => P.stateOf(p.nunchi).root.dir;
async function attempt(p, edits = [['app/settings/page.jsx', 'TINY', 'ROOMY']], { verify = true } = {}) {
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  for (const e of edits) edit(p.root, ...e);
  commitWith(p.root, (await F.checkFix(ctxOf(p), p.group)).json.trailers);
  return verify ? F.verifyFix(ctxOf(p), p.group) : null;
}

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });
// one board, one page at 390 px (fixtures/board-browser.mjs: closed again, and said why, when a step fails);
// `look(group)` opens Detail and measures it in one evaluation
async function open(p) {
  const s = await openBoard(browser, p, { ctx: { viewport: { width: 390, height: 844 } } });
  const pg = s.page;
  const look = async (group, wait = '#h-detail') => {
    await pg.evaluate(id => { location.hash = `#/finding/${id}`; }, group);
    await pg.waitForSelector(wait);
    return pg.evaluate(() => {
      const n = document.querySelector('.needs');
      const rows = [...document.querySelectorAll('.attempts li')].map(li => ({ id: li.id, text: li.innerText.replace(/\s+/g, ' ').trim(),
        copies: [...li.querySelectorAll('button')].map(b => ({ name: b.getAttribute('aria-label'), h: Math.round(b.getBoundingClientRect().height) })),
        mono: [...li.querySelectorAll('.mono')].map(x => getComputedStyle(x).fontFamily) }));
      return { card: n ? [...n.children].filter(x => x.tagName === 'SPAN').map(x => x.innerText.replace(/\s+/g, ' ').trim()) : null,
        buttons: n ? [...n.querySelectorAll('button')].map(b => ({ text: b.textContent, name: b.getAttribute('aria-label') || b.textContent, h: Math.round(b.getBoundingClientRect().height) })) : [],
        rows, wide: document.documentElement.scrollWidth <= innerWidth };
    });
  };
  return { ...s, pg, look };
}

test('board e2e: interrupted says the sentence (no buttons); revert says why and the git command with [Copy]; unbaselined names the route and what it shows, with [Undo this fix] [Try again with a note…]; (a)\'s [Undo this fix] undoes', { timeout: 180000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const i = await fixProject();
  await attempt(i, undefined, { verify: false });
  F.abortFix(ctxOf(i), i.group);
  const ic = git(i.root, 'rev-parse', '--short=7', 'HEAD');
  const s = await open(i);
  try {
    const m = await s.look(i.group, '.needs');
    assert.deepEqual(m.card, [`This fix (commit ${ic}) wasn’t re-checked.`, 'Tell your AI “retry” to check it, or “undo it”.']);
    assert.deepEqual(m.buttons, []);
    assert.equal(m.rows[0].text, `Attempt 1 · Needs you — wasn’t re-checked · ${ic} Copy · just now`);
    assert.ok(m.wide);
  } finally { await s.close(); }
  // revert: signing refused the undo (the record as the engine writes it)
  const r = await fixProject();
  await attempt(r, [['app/settings/page.jsx', 'TINY', 'ROOMY'], ['app/page.jsx', 'Plant shelf', 'Plant shelf!']]);
  const rec = R.latestRecord(sd(r), r.group);
  R.update(sd(r), rec, { outcome: { kind: 'needs-you', needsYou: 'signing', reason: 'signing', commit: rec.commit, line: 'engine words' } });
  const rc = String(rec.commit).slice(0, 7);
  const s2 = await open(r);
  try {
    const m = await s2.look(r.group, '.needs');
    assert.deepEqual(m.card, [`nunchi couldn’t undo this fix (commit ${rc}): your repository requires signed commits, and signing failed.`, `Undo it yourself: git revert ${rc} Copy`]);
    assert.deepEqual(m.buttons.map(b => [b.text, b.name]), [['Copy', `Copy git revert ${rc}`]]);
    assert.ok(m.buttons.every(b => b.h >= 44));
    assert.equal(m.rows[0].text, `Attempt 1 · Needs you — nunchi couldn’t undo it · ${rc} Copy · just now`);
    assert.ok(m.wide);
    assert.deepEqual(s2.errors, []);
  } finally { await s2.close(); }
  // unbaselined
  const u = await fixProject();
  await attempt(u, [['app/settings/page.jsx', 'TINY', 'ROOMY'], ['components/panel.jsx', 'Shelf panel', 'Shelf panel HELPDEFECT']]);
  const s3 = await open(u);
  try {
    const m = await s3.look(u.group, '.needs .actions');
    assert.deepEqual(m.card, ['The fix also reaches /help, which had no screenshot before.', 'It now shows ‘Text cut off without an ellipsis’.']);
    assert.deepEqual(m.buttons.map(b => b.text), ['Undo this fix', 'Try again with a note…']);
    assert.ok(m.buttons.every(b => b.h >= 44));
    assert.ok(m.wide);
    assert.deepEqual(s3.errors, []);
  } finally { await s3.close(); }
  // (a): [Undo this fix] runs the same safe revert (no sentence dialog any more)
  const a = await fixProject();
  await attempt(a, [['app/settings/page.jsx', 'TINY', 'ROOMY SHIFT']]);
  const s4 = await open(a);
  try {
    await s4.look(a.group, '.needs .actions');
    // the undo's answer held back 1.5 s: the live update redraws first (as it did on Windows CI), and the focus must
    // still land on the history row in the very redraw that removes the card
    await s4.pg.route('**/api/fix-undo', async r => { const res = await r.fetch(); await new Promise(z => setTimeout(z, 1500)); await r.fulfill({ response: res }); });
    await s4.pg.click('#fix-undo');
    await s4.pg.waitForFunction(() => !document.querySelector('.needs') && document.getElementById('attempt-1'), null, { polling: 'raf' });
    const m = await s4.pg.evaluate(() => ({ focus: document.activeElement?.id, row: document.getElementById('attempt-1').innerText.replace(/\s+/g, ' ').trim(), dialog: document.getElementById('dialog').open }));
    assert.equal(m.focus, 'attempt-1');
    assert.match(m.row, /^Attempt 1 · Undone at your request · [0-9a-f]{7} Copy → reverted in [0-9a-f]{7} Copy · just now$/);
    assert.equal(m.dialog, false);
    assert.equal(R.latestRecord(sd(a), a.group).phase, 'undone');
    assert.deepEqual(s4.errors, []);
  } finally { await s4.close(); }
});
