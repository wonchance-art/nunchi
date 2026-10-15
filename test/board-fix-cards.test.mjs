// The other *needs you* kinds on the board, each with its own card (owner-approved mock-ups, spec §6.6): diff (files
// only the person can approve), unbaselined (a screen the fix reaches with nothing to compare against), interrupted (a
// commit nobody re-checked), revert (an undo that could not run). The board's own words, never the engine's chat line;
// paths, routes and commits from the record. [Undo this fix] is the same safe revert as the AI's fix --undo, its
// refusals said on the card. API tests first, then the page in a real browser (skipped without Chromium unless
// NUNCHI_REQUIRE_BROWSER is set). Synthetic git projects (test/fixtures/fix-project.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import * as F from '../src/fix/loop.mjs';
import * as R from '../src/fix/records.mjs';
import * as P from '../src/project.mjs';
import { FIX_WORDS, listText } from '../src/board/shared.mjs';
import { fixProject, edit, commitWith, git, tmp } from './fixtures/fix-project.mjs';
import { boardRequest } from './fixtures/board-call.mjs';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-board-cards-xdg-');
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const ctxOf = p => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: async () => ({ ok: true }) } });
const sd = p => P.stateOf(p.nunchi).root.dir;
// one attempt: start, the edits (file, from, to) and new files, the checks, the commit, then verify (unless asked not to)
async function attempt(p, { edits = [['app/settings/page.jsx', 'TINY', 'ROOMY']], add = {}, verify = true } = {}) {
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  for (const e of edits) edit(p.root, ...e);
  for (const [f, v] of Object.entries(add)) { mkdirSync(join(p.root, f, '..'), { recursive: true }); writeFileSync(join(p.root, f), v); git(p.root, 'add', f); }
  commitWith(p.root, (await F.checkFix(ctxOf(p), p.group)).json.trailers);
  return verify ? F.verifyFix(ctxOf(p), p.group) : null;
}
async function board(p) {
  const b = await startBoard({ projectDir: p.root });
  const origin = b.origin;
  // a trade that fails closes the board first (a board left listening keeps this file's process alive to the runner's limit)
  const s = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })
    .then(r => r.json()).catch(async e => { await b.close(); throw e; });
  // a fresh connection per request: the fix loop and git run between calls (fixtures/board-call.mjs)
  const call = (path, body) => boardRequest(origin, path, { token: s.token, body });
  return { b, call };
}
// the diff kind with seven paths outside the finding's files
const SEVEN = { add: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(x => [`public/${x}.txt`, `${x}\n`])), edits: [['app/settings/page.jsx', 'TINY', 'ROOMY'], ['app/page.jsx', 'Plant shelf', 'Plant shelf!']] };

test('words: every needs-you kind has its own entry in the one strings table (no engine line reused); several paths are five, then "and N more"', () => {
  assert.equal(FIX_WORDS.diff, 'The fix changed files only you can approve:');
  assert.equal(FIX_WORDS.unbaselined('/help', 1), 'The fix also reaches /help, which had no screenshot before.');
  assert.equal(FIX_WORDS.nowShows('‘Text cut off’'), 'It now shows ‘Text cut off’.');
  assert.equal(FIX_WORDS.interrupted('abc1234'), 'This fix (commit abc1234) wasn’t re-checked.');
  assert.equal(FIX_WORDS.interruptedThen, 'Tell your AI “retry” to check it, or “undo it”.');
  assert.equal(FIX_WORDS.revert('abc1234', FIX_WORDS.revertWhy.signing()), 'nunchi couldn’t undo this fix (commit abc1234): your repository requires signed commits, and signing failed.');
  assert.deepEqual([FIX_WORDS.revertThen, FIX_WORDS.revertSay('abc1234')], ['Undo it yourself:', 'git revert abc1234']);
  assert.equal(listText(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b, c, d, e and 2 more');
  assert.equal(listText(['a']), 'a');
  for (const k of ['a', 'b', 'c', 'diff', 'unbaselined', 'interrupted', 'revert', 'other']) assert.ok(FIX_WORDS.short[k], k);
  assert.equal(FIX_WORDS.needsRow('diff'), 'Needs you — changed files only you can approve');
  assert.deepEqual([FIX_WORDS.outcome['caused-regression'], FIX_WORDS.outcome['not-fixed'], FIX_WORDS.outcome.undone, FIX_WORDS.outcome.fixed],
    ['Broke something else — undone', 'Didn’t remove it — undone', 'Undone at your request', 'Fixed']);
});

test('board: each kind\'s card data comes from the record (paths sorted, routes and rule titles, the commit, why an undo could not run); none carries the engine\'s line', async () => {
  // diff
  const p = await fixProject();
  await attempt(p, SEVEN);
  // unbaselined: the fix also reaches /help, which then shows a clipped text
  const u = await fixProject();
  await attempt(u, { edits: [['app/settings/page.jsx', 'TINY', 'ROOMY'], ['components/panel.jsx', 'Shelf panel', 'Shelf panel HELPDEFECT']] });
  // interrupted: stopped after its commit, before the re-check
  const i = await fixProject();
  await attempt(i, { verify: false });
  F.abortFix(ctxOf(i), i.group);
  // revert: a revert signing refused (the record as the engine writes it), and an older record without a reason
  const s = await fixProject();
  await attempt(s, SEVEN);
  let rec = R.latestRecord(sd(s), s.group);
  R.update(sd(s), rec, { outcome: { kind: 'needs-you', needsYou: 'signing', reason: 'signing', commit: rec.commit, line: 'engine words' } });
  const o = await fixProject();
  await attempt(o, SEVEN);
  rec = R.latestRecord(sd(o), o.group);
  R.update(sd(o), rec, { outcome: { kind: 'needs-you', needsYou: 'revert-failed', commit: rec.commit, line: 'engine words' } });
  const got = {};
  for (const [name, q] of Object.entries({ p, u, i, s, o })) {
    const { b, call } = await board(q);
    try { got[name] = (await call(`/api/groups/${q.group}`)).json.fix; } finally { await b.close(); }
  }
  assert.deepEqual([got.p.needs, got.p.paths], ['diff', ['app/page.jsx', 'public/a.txt', 'public/b.txt', 'public/c.txt', 'public/d.txt', 'public/e.txt', 'public/f.txt']]);
  assert.deepEqual([got.u.needs, got.u.routes, got.u.shows], ['unbaselined', ['/help'], ['Text cut off without an ellipsis']]);
  assert.deepEqual([got.i.needs, got.i.landed], ['interrupted', true]);
  assert.match(got.i.commit, /^[0-9a-f]{7}$/);
  assert.deepEqual([got.s.needs, got.s.reason, got.o.needs, got.o.reason], ['revert', 'signing', 'revert', 'half-done']);
  for (const f of Object.values(got)) assert.equal(f.line, undefined, 'never the engine\'s chat line');
});

test('board: [Undo this fix] is the same safe revert as fix --undo — refused with a key and the paths (uncommitted changes), on another branch, or for an attempt that changed; done once clean', async () => {
  const p = await fixProject();
  await attempt(p, SEVEN);
  const fixCommit = git(p.root, 'rev-parse', 'HEAD');
  const attemptNo = R.latestRecord(sd(p), p.group).attempt;
  const { b, call } = await board(p);
  try {
    assert.equal((await call('/api/fix-undo', { group: p.group, attempt: attemptNo + 1 })).json.stale, true, 'another attempt than the one shown: stale');
    assert.equal((await call('/api/fix-undo', { group: p.group })).status, 400);
    writeFileSync(join(p.root, 'notes.md'), 'mine\n');
    let r = await call('/api/fix-undo', { group: p.group, attempt: attemptNo });
    assert.deepEqual([r.status, r.json.refused, r.json.paths], [409, 'dirty', ['notes.md']]);
    assert.equal(git(p.root, 'rev-parse', 'HEAD'), fixCommit, 'nothing undone');
    rmSync(join(p.root, 'notes.md'));
    const branch = git(p.root, 'branch', '--show-current');
    git(p.root, 'switch', '-q', '-c', 'elsewhere');
    r = await call('/api/fix-undo', { group: p.group, attempt: attemptNo });
    assert.deepEqual([r.json.refused, r.json.branch, r.json.on], ['wrong-branch', branch, 'elsewhere']);
    git(p.root, 'switch', '-q', branch);
    r = await call('/api/fix-undo', { group: p.group, attempt: attemptNo });
    assert.deepEqual([r.status, r.json.outcome], [200, 'undone']);
    assert.notEqual(git(p.root, 'rev-parse', 'HEAD'), fixCommit);
    const g = (await call(`/api/groups/${p.group}`)).json;
    assert.equal(g.fix.needs, null, 'the card is gone');
    assert.deepEqual(g.fixes.map(x => [x.attempt, x.outcome]), [[1, 'undone']]);
    assert.equal(g.fixes[0].commit, fixCommit.slice(0, 7));
    assert.match(g.fixes[0].revert, /^[0-9a-f]{7}$/);
    // a second undo of the same attempt: nothing left to undo, said as stale
    assert.equal((await call('/api/fix-undo', { group: p.group, attempt: attemptNo })).json.stale, true);
  } finally { await b.close(); }
});

// ---- in a real browser -------------------------------------------------------------------------------------------------

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });
// the board, a page on it and the first view (fixtures/board-browser.mjs: closed again, and said why, when a step fails)
async function page(p, viewport = { width: 390, height: 844 }) {
  const s = await openBoard(browser, p, { ctx: { viewport }, setup: async ({ b, context, page: pg }) => {
    await context.grantPermissions(['clipboard-write'], { origin: b.origin });
    // what the page hands the clipboard (the board's own policy blocks reading it back: clipboard-read=())
    await pg.addInitScript(() => { const w = navigator.clipboard.writeText.bind(navigator.clipboard); globalThis.__copied = []; navigator.clipboard.writeText = t => { globalThis.__copied.push(t); return w(t); }; });
  } });
  return { ...s, pg: s.page };
}
// the card, measured in one evaluation (live redraws make separate handle round trips flaky)
const CARD = () => {
  const n = document.querySelector('.needs');
  if (!n) return null;
  const spans = [...n.children].filter(x => x.tagName === 'SPAN').map(x => x.textContent);
  const buttons = [...n.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent, name: b.getAttribute('aria-label') || b.textContent, h: Math.round(r.height), w: Math.round(r.width), right: Math.round(r.right) }; });
  return { head: n.querySelector('h2')?.textContent, spans, buttons, msg: document.getElementById('fix-undo-msg')?.textContent ?? null, labelled: n.getAttribute('aria-labelledby'),
    wide: document.documentElement.scrollWidth <= innerWidth, focus: document.activeElement?.id || null };
};

test('board e2e: the diff card at 390 px — five paths then "and 2 more", [Copy path] copies all of them one per line, [Undo this fix] refused on the card (focus kept), then done; the history row says it', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = await fixProject();
  await attempt(p, SEVEN);
  const commit = git(p.root, 'rev-parse', '--short=7', 'HEAD');
  const s = await page(p);
  const { pg } = s;
  try {
    await pg.evaluate(id => { location.hash = `#/finding/${id}`; }, p.group);
    await pg.waitForSelector('.needs .actions');
    const m = await pg.evaluate(CARD);
    assert.equal(m.head, 'Needs you');
    assert.deepEqual(m.spans, ['The fix changed files only you can approve: app/page.jsx, public/a.txt, public/b.txt, public/c.txt, public/d.txt and 2 more']);
    assert.deepEqual(m.buttons.map(b => b.text), ['Copy path', 'Undo this fix', 'Try again with a note…']);
    assert.ok(m.buttons.every(b => b.h >= 44 && b.w >= 44 && b.right <= 390), 'every action a 44 px target, inside 390 px');
    assert.ok(m.wide, 'no sideways scroll at 390 px');
    assert.equal(m.labelled, 'fix-needs-h', 'the card is named by its heading');
    // [Copy path]: all seven, one per line
    await pg.click('#fix-copy-paths');
    await pg.waitForFunction(() => globalThis.__copied.length);
    const copied = await pg.evaluate(() => ({ text: globalThis.__copied.at(-1), focus: document.activeElement?.id }));
    assert.equal(copied.text, ['app/page.jsx', 'public/a.txt', 'public/b.txt', 'public/c.txt', 'public/d.txt', 'public/e.txt', 'public/f.txt'].join('\n'));
    assert.equal(copied.focus, 'fix-copy-paths', 'the focus stays on the button');
    // [Undo this fix] with uncommitted work: refused on the card, in the board's words; the focus stays on Undo
    writeFileSync(join(p.root, 'notes.md'), 'mine\n');
    await pg.click('#fix-undo');
    await pg.waitForFunction(() => document.getElementById('fix-undo-msg')?.textContent);
    const no = await pg.evaluate(CARD);
    assert.equal(no.msg, 'Not undone: you have changes that are not committed (notes.md). Commit or stash them, then press Undo this fix again.');
    assert.equal(no.focus, 'fix-undo');
    assert.equal(git(p.root, 'rev-parse', '--short=7', 'HEAD'), commit);
    // axe on the card with its message
    await pg.evaluate(AXE);
    assert.deepEqual(await pg.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => x.id)), []);
    // clean: undone; the card goes, the focus lands on the attempt's history row, which says it
    rmSync(join(p.root, 'notes.md'));
    // the undo's answer held back 1.5 s: the live update redraws first (as it did on Windows CI), and the focus must
    // still land on the history row in the very redraw that removes the card
    await pg.route('**/api/fix-undo', async r => { const res = await r.fetch(); await new Promise(z => setTimeout(z, 1500)); await r.fulfill({ response: res }); });
    await pg.click('#fix-undo');
    await pg.waitForFunction(() => !document.querySelector('.needs') && document.getElementById('attempt-1'), null, { polling: 'raf' });
    const done = await pg.evaluate(() => ({ focus: document.activeElement?.id, row: document.getElementById('attempt-1').innerText.replace(/\s+/g, ' '), h: document.getElementById('h-attempts')?.textContent,
      mono: getComputedStyle(document.querySelector('#attempt-1 .mono')).fontFamily, names: [...document.querySelectorAll('#attempt-1 button')].map(b => b.getAttribute('aria-label')), wide: document.documentElement.scrollWidth <= innerWidth }));
    assert.equal(done.focus, 'attempt-1');
    assert.equal(done.h, 'Fix attempts');
    assert.match(done.row, new RegExp(`^Attempt 1 · Undone at your request · ${commit} Copy → reverted in ([0-9a-f]{7}) Copy · just now$`));
    const reverted = /reverted in ([0-9a-f]{7})/.exec(done.row)[1];
    assert.deepEqual(done.names, [`Copy commit ${commit}`, `Copy commit ${reverted}`]);
    assert.match(done.mono, /mono|Menlo|Consolas|Courier/i);
    assert.ok(done.wide);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
