// Fix history in Detail (owner-approved mock-up, spec §6.6): one row per attempt, newest first — "Attempt n · outcome ·
// commit → reverted in commit · when", the outcome in the board's words, commits 7 characters in a mono font with a
// [Copy] each — and the needs-you cards that carry no action of their own (interrupted, revert) or say a screen with
// no baseline (unbaselined), at 390 px. The page in a real browser (skipped without Chromium unless
// NUNCHI_REQUIRE_BROWSER is set); the rows' data through the API. Synthetic git projects (test/fixtures/fix-project.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as P from '../src/project.mjs';
import { fixProject, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-history-xdg-');
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
after(async () => { await browser?.close(); });
// one board, one page at 390 px; `look(group)` opens Detail and measures it in one evaluation
async function open(p) {
  const b = await startBoard({ projectDir: p.root });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await context.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(String(e)));
  await pg.goto(b.newLink());
  await pg.waitForSelector('#h-progress');
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
  return { b, pg, errors, look, close: async () => { await context.close(); await b.close(); } };
}

test('board e2e: history rows, newest first — two attempts that did not remove it (the second needs you), a fix that broke something else, one that landed; commits in mono with a named [Copy] each, 44 px, no overflow at 390 px', { timeout: 180000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = await fixProject();
  await attempt(p, [['app/settings/page.jsx', 'TINY', 'WRAP']]);
  await attempt(p, [['app/settings/page.jsx', 'TINY', 'WRAP']]);
  const q = await fixProject();
  await attempt(q, [['app/settings/page.jsx', 'TINY', 'ROOMY CLIP']]);           // broke the panel heading: undone
  await attempt(q);                                                              // fixed
  const recs = { p: R.allRecords(sd(p), p.group), q: R.allRecords(sd(q), q.group) };
  const c7 = x => String(x).slice(0, 7);
  const s = await open(p);
  try {
    const m = await s.look(p.group, '.attempts li');
    assert.deepEqual(m.rows.map(r => r.id), ['attempt-2', 'attempt-1'], 'newest first');
    assert.equal(m.rows[0].text, `Attempt 2 · Needs you — the AI couldn’t fix this in 2 tries · ${c7(recs.p[1].commit)} Copy → reverted in ${c7(recs.p[1].outcome.revert)} Copy · just now`);
    assert.equal(m.rows[1].text, `Attempt 1 · Didn’t remove it — undone · ${c7(recs.p[0].commit)} Copy → reverted in ${c7(recs.p[0].outcome.revert)} Copy · just now`);
    assert.deepEqual(m.rows[0].copies.map(c => c.name), [`Copy commit ${c7(recs.p[1].commit)}`, `Copy commit ${c7(recs.p[1].outcome.revert)}`]);
    assert.ok(m.rows.every(r => r.copies.every(c => c.h >= 44)), '44 px targets');
    assert.ok(m.rows.every(r => r.mono.length === 2 && r.mono.every(f => /mono|Menlo|Consolas|Courier/i.test(f))), 'commits in a mono font');
    assert.ok(m.wide, 'no sideways scroll at 390 px');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  const s2 = await open(q);
  try {
    const m = await s2.look(q.group, '.attempts li');
    assert.deepEqual(m.rows.map(r => r.text), [
      `Attempt 2 · Fixed · ${c7(recs.q[1].commit)} Copy · just now`,
      `Attempt 1 · Broke something else — undone · ${c7(recs.q[0].commit)} Copy → reverted in ${c7(recs.q[0].outcome.revert)} Copy · just now`,
    ]);
    assert.ok(m.wide);
    assert.deepEqual(s2.errors, []);
  } finally { await s2.close(); }
});

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
    await s4.pg.click('#fix-undo');
    await s4.pg.waitForFunction(() => !document.querySelector('.needs') && document.getElementById('attempt-1'));
    const m = await s4.pg.evaluate(() => ({ focus: document.activeElement?.id, row: document.getElementById('attempt-1').innerText.replace(/\s+/g, ' ').trim(), dialog: document.getElementById('dialog').open }));
    assert.equal(m.focus, 'attempt-1');
    assert.match(m.row, /^Attempt 1 · Undone at your request · [0-9a-f]{7} Copy → reverted in [0-9a-f]{7} Copy · just now$/);
    assert.equal(m.dialog, false);
    assert.equal(R.latestRecord(sd(a), a.group).phase, 'undone');
    assert.deepEqual(s4.errors, []);
  } finally { await s4.close(); }
});
