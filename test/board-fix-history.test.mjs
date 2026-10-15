// Fix history in Detail (owner-approved mock-up, spec §6.6): one row per attempt, newest first — "Attempt n · outcome ·
// commit → reverted in commit · when", the outcome in the board's words, commits 7 characters in a mono font with a
// [Copy] each — at 390 px (the other cards: board-fix-kinds.test.mjs). The page in a real browser (skipped without
// Chromium unless NUNCHI_REQUIRE_BROWSER is set). Synthetic git projects (test/fixtures/fix-project.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as P from '../src/project.mjs';
import { fixProject, edit, commitWith } from './fixtures/fix-project.mjs';
import { tmp } from './fixtures/tmp.mjs';

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
