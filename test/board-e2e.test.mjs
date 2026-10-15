// The board in a real browser (design 0.1-c §3.4): open it with the one-time link, decide with a key, undo, and check
// the ledger; accessibility (axe, landmarks and roles, 44 px targets, keyboard, reduced motion, colour not the only
// signal); the list holding still; offline. Needs Chromium (NUNCHI_BROWSER or `nunchi setup`): skipped without one
// unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import { exportHtml } from '../src/export-html.mjs';
import * as P from '../src/project.mjs';
import { smallProject, withAi, writeRun, HOSTILE } from './fixtures/board-project.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });

const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8'))); } catch { return []; } };
function project() {
  const p = smallProject();
  const ai = withAi(p, [{ lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: `The error says nothing useful ${HOSTILE}`, status: 'confirmed', severity: 'high', file: 'app/garden/page.tsx', line: 12 },
    { lens: 'L2', rule: 'L2.inconsistent-term', scene: p.scenes[0], selector: 'main > a.more', box: [40, 900, 120, 32], claim: 'Two words for one thing', status: 'claimed', severity: 'medium' }]);
  return { ...p, ai };
}
// the board, a page on it and its first view: Progress, or the label view in label mode (fixtures/board-browser.mjs:
// closed again, and said why, when a step fails). Every dialog is dismissed and kept in `dialogs`.
const open = (p, ctx = {}, opts = {}) => openBoard(browser, p, { ctx: { viewport: { width: 1280, height: 900 }, ...ctx }, board: opts, wait: opts.mode === 'label' ? '#h-label' : '#h-progress' });
const gid = (p, rule) => p.findings.find(f => f.rule === rule).group;
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 100)); } };
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}

test('board e2e: the one-time link opens it, a key decides, Z undoes — the ledger holds keep then reopen, made in the board', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    assert.ok(!page.url().includes('t='), 'the link\'s code is gone from the address bar');
    assert.match(await page.textContent('#h-progress'), /^Not yet · 1 blocker, 2 high: /);
    // the button says the number the verdict says is to decide
    const toDecide = /(\d+) to decide/.exec(await page.textContent('#h-progress'))?.[1];
    assert.equal(await page.textContent('.hero .btn-primary'), `Decide ${toDecide} →`);
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    const marked = await page.$$eval('.nav a', as => as.filter(a => getComputedStyle(a).backgroundColor !== 'rgba(0, 0, 0, 0)').map(a => a.getAttribute('data-nav')));
    assert.deepEqual(marked, ['findings'], 'the sidebar marks the view shown, and only it');
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    assert.equal(first, gid(p, 'secret-in-client-bundle'), 'the worst group has the focus');
    await page.keyboard.press('j');
    const raw = gid(p, 'raw-error-text');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-id')), raw);
    await page.keyboard.press('w');
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await page.textContent('#toast'), /^Kept \(intended\)Kept \(out of scope\) insteadUndo Z$/);
    assert.match(await until(() => page.textContent('#announce')), /^Kept \(intended\)\. Next: /);
    assert.match(await page.textContent(`#row-${raw}`), /Kept/, 'the row takes its new status in place');
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-id')), raw, 'the focus moved to the next row');
    let files = await until(() => { const d = decisions(p.nunchi); return d.length === 1 && d; });
    assert.deepEqual([files[0].decision, files[0].reason, files[0].channel, files[0].target.group], ['keep', 'intended', 'board', raw]);
    await page.keyboard.press('z');
    await until(async () => /Undone/.test(await page.textContent('#toast')));
    files = await until(() => { const d = decisions(p.nunchi); return d.length === 2 && d; });
    assert.deepEqual(files.map(d => d.decision).sort(), ['keep', 'reopen']);
    assert.ok(files.every(d => d.channel === 'board'));
    const row = P.ledgerView(P.loadLedger(p.nunchi, { root: p.root })).rows.find(r => r.group === raw);
    assert.deepEqual([row.status, row.decision], ['open', null], 'reopened in the ledger');
    const metrics = JSON.parse(readFileSync(join(p.nunchi, 'state', 'metrics.json'), 'utf8'));
    assert.equal(Object.keys(metrics.singles).length, 1, 'the decision time was kept (the undo is not a decision)');
    // undo lasts as long as its toast: once it is gone, Z undoes nothing
    await page.focus(`#row-${raw}`);
    await page.keyboard.press('w');
    await until(() => decisions(p.nunchi).length === 3);
    await page.waitForSelector('#toast[hidden]', { state: 'attached', timeout: 9000 });
    await page.keyboard.press('z');
    assert.equal(await until(async () => (await page.textContent('#announce')) === 'Nothing to undo' && 'Nothing to undo'), 'Nothing to undo');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(decisions(p.nunchi).length, 3, 'nothing written');
    // no answer from the board is said in words, not as the browser's "Failed to fetch"
    await page.route('**/api/decide', r => r.abort('connectionrefused'));
    await page.focus(`#row-${raw}`);
    await page.keyboard.press('f');
    assert.equal(await until(async () => { const a = await page.textContent('#announce'); return /^Not recorded/.test(a) && a; }), 'Not recorded: the board did not answer (is it still running? nunchi open starts it)');
    await page.unroute('**/api/decide');
    // app text is data: the hostile claim is text, never markup
    await page.click('a[data-nav=findings]');
    await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
    assert.equal(await page.locator('img').count(), 0, 'no <img> was made from app text');
    assert.ok((await page.textContent('main')).includes('<script>alert(1)</script>'));
    assert.deepEqual(s.dialogs, [], 'no alert ran');
    // offline: every request went to the board itself (or a blob of its own)
    assert.ok(s.requests.length > 5);
    for (const u of s.requests) assert.ok(u.startsWith(s.b.origin + '/') || u.startsWith('blob:'), u);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('board e2e: batches — Space selects, S decides all with one batch id, Z undoes the batch; a blocker dismissal asks first', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    assert.equal(await page.locator('.row[aria-selected=true]').count(), 2);
    await page.keyboard.press('s');
    const files = await until(() => { const d = decisions(p.nunchi); return d.length === 2 && d; });
    assert.equal(new Set(files.map(d => d.batch)).size, 1, 'one batch');
    assert.ok(files[0].batch);
    await page.waitForSelector('#toast:not([hidden])');
    await page.keyboard.press('z');
    await until(() => decisions(p.nunchi).length === 4);
    assert.equal(decisions(p.nunchi).filter(d => d.decision === 'reopen').length, 2, 'Z undid the whole batch');
    // the page is done with the undo when it says so: until then its answer can still move the focus to the reopened
    // row (the server writes the files before it answers, so the files alone do not say the page has moved on)
    await page.waitForFunction(() => /^Undone · back to open/.test(document.getElementById('toast')?.textContent || ''));
    // a dismissal of the blocker asks; Cancel (the focused choice) writes nothing
    await page.focus(`#row-${gid(p, 'secret-in-client-bundle')}`);
    await page.keyboard.press('x');
    await page.waitForSelector('dialog[open]');
    assert.match(await page.textContent('dialog'), /Mark 1 group Not a problem\? 1 is a blocker/);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'the safe choice has the focus');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    assert.equal(decisions(p.nunchi).length, 4, 'nothing written');
  } finally { await s.close(); }
});

test('board e2e: the decision bar and the toast never cover each other or the focused row; the bar stays reachable on a phone; screen markers stay inside their panel', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const [width, height] of [[1280, 560], [800, 520], [390, 640]]) {
    const p = project();
    const s = await open(p, { viewport: { width, height } });
    const { page } = s;
    // every box of one comparison in one evaluation: a live redraw between two calls would compare a detached node
    const rects = (...sels) => page.evaluate(qs => qs.map(q => { const e = document.querySelector(q); if (!e || e.hidden || !e.isConnected) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }), sels);
    try {
      await page.waitForSelector('#h-progress');
      await page.click('a[data-nav=findings]');
      await page.waitForSelector('#h-findings');
      await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.dock')).position), 'sticky', `${width}px: the bar is sticky`);
      const rows = await page.locator('.row').count();
      for (let i = 0; i < rows; i++) {
        const [dock, row] = await rects('.dock', '.row:focus');
        assert.ok(dock && row, `${width}px row ${i}: the dock and a focused row are there`);
        assert.ok(dock.bottom <= height + 1, `${width}px: the bar is in the window`);
        assert.ok(row.bottom <= dock.top + 1 && row.top >= 0, `${width}px row ${i}: the focused row is not under the bar (${row.top}–${row.bottom} vs ${dock.top})`);
        await page.keyboard.press('j');
      }
      await page.keyboard.press('k');
      await page.keyboard.press('w');
      await page.waitForSelector('#toast:not([hidden])');
      assert.equal(await page.evaluate(() => document.getElementById('toast').parentElement.classList.contains('dock')), true, 'the toast is in the dock');
      const [toast, bar, row] = await rects('#toast', '.toolbar', '.row:focus');
      assert.ok(toast && bar && row, `${width}px: the toast, the bar and the focused row are there`);
      assert.ok(!overlap(toast, bar), `${width}px: the toast is not over the bar`);
      assert.ok(!overlap(toast, row), `${width}px: the toast is not over the focused row`);
      if (width === 1280) {
        await page.click('a[data-nav=screens]');
        await page.waitForSelector('#h-screens');
        const cards = await page.locator('.card button').count();
        let checked = 0;
        for (let i = 0; i < cards; i++) {
          await page.locator('.card button').nth(i).click();
          await page.waitForSelector('#panel-h');
          // markers and panel in one evaluation: a live redraw (the decision above arriving as a new version) replaces the
          // view, and $$eval's handles from before it are detached nodes measuring 0,0
          const { nums, panel } = await page.evaluate(() => {
            const r = e => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top }; };
            // the markers drawn (one stacked into another is not: M7)
            return { nums: [...document.querySelectorAll('.screen-panel .num')].filter(n => n.getClientRects().length).map(r), panel: r(document.querySelector('.panels')) };
          });
          for (const n of nums) { assert.ok(n.left >= panel.left - 0.5 && n.top >= panel.top - 0.5, `marker at ${n.left},${n.top} inside the panel from ${panel.left},${panel.top}`); checked++; }
        }
        assert.ok(checked > 0, 'some markers were checked');
      }
    } finally { await s.close(); }
  }
});

test('board e2e: a short window (420 px or less, e.g. 200% zoom at 640 × 360) keeps the dock to a third: no sub-labels, the toast on one line, the focused row clear', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  for (const [width, height, deviceScaleFactor] of [[640, 360, 2], [800, 420, 1]]) {
    const p = project();
    const s = await open(p, { viewport: { width, height }, deviceScaleFactor });
    const { page } = s;
    // everything measured in one evaluation: a live redraw between two round trips would measure a detached node
    const measure = () => page.evaluate(() => {
      const dock = document.querySelector('.dock'), bar = dock.querySelector('.toolbar'), toast = document.getElementById('toast'), row = document.activeElement;
      const r = e => e.getBoundingClientRect();
      const shown = !toast.hidden && dock.contains(toast);
      const kids = shown ? [...toast.children].map(k => Math.round(r(k).top + r(k).height / 2)) : [];
      return {
        dock: r(dock).height / innerHeight, dockTop: r(dock).top, dockH: Math.ceil(r(dock).height),
        dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
        scrollPad: getComputedStyle(document.documentElement).scrollPaddingBottom,
        subs: [...bar.querySelectorAll('.dbtn small')].filter(e => getComputedStyle(e).display !== 'none').length,
        barRows: new Set([...bar.querySelectorAll('.dbtn')].map(b => Math.round(r(b).top))).size,
        barOverflow: bar.scrollWidth > bar.clientWidth + 1, toastOverflow: shown && toast.scrollWidth > toast.clientWidth + 1,
        toastLines: new Set(kids).size, shown,
        row: row?.classList.contains('row') ? { top: r(row).top, bottom: r(row).bottom } : null,
        targets: [...bar.querySelectorAll('.dbtn'), ...(shown ? toast.querySelectorAll('button') : [])].map(b => Math.min(r(b).width, r(b).height)),
      };
    });
    try {
      await page.waitForSelector('#h-progress');
      await page.click('a[data-nav=findings]');
      await page.waitForSelector('#h-findings');
      await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
      const a = await measure();
      assert.ok(a.dock <= 0.2, `${width}×${height}: the dock takes ${Math.round(a.dock * 100)}% of the window`);
      assert.deepEqual([a.subs, a.barRows, a.barOverflow], [0, 1, false], `${width}×${height}: one row of buttons, no sub-labels, nothing cut off`);
      assert.ok(a.targets.every(x => x >= 44), `${width}×${height}: every button is still 44 px (${a.targets.join(', ')})`);
      await page.keyboard.press('j');
      await page.keyboard.press('w');
      await page.waitForSelector('#toast:not([hidden])');
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--dock-h') === `${Math.ceil(document.querySelector('.dock').getBoundingClientRect().height)}px`);
      const b = await measure();
      assert.ok(b.shown, 'the toast is in the dock');
      assert.ok(b.dock <= 0.35, `${width}×${height}: with the toast, the dock takes ${Math.round(b.dock * 100)}% of the window (51% before)`);
      assert.deepEqual([b.toastLines, b.toastOverflow], [1, false], `${width}×${height}: the toast is on one line`);
      assert.ok(b.targets.every(x => x >= 44), `${width}×${height}: the toast's buttons are 44 px too`);
      assert.equal(b.dockVar, `${b.dockH}px`, 'the page measures the dock');
      assert.notEqual(b.scrollPad, '0px', 'and keeps the scroll padding');
      assert.ok(b.row && b.row.bottom <= b.dockTop + 1 && b.row.top >= 0, `${width}×${height}: the focused row is not under the dock (${b.row?.top}–${b.row?.bottom} vs ${b.dockTop})`);
    } finally { await s.close(); }
  }
});

test('board e2e: on a view without a dock the toast is inside main (axe region); Esc hides it and does its usual step in the same press', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    await page.keyboard.press('j');
    await page.keyboard.press('s');
    await page.waitForSelector('#toast:not([hidden])');
    await page.evaluate(() => { location.hash = '#/screens'; });
    await page.waitForSelector('#h-screens');
    const where = await page.evaluate(() => { const t = document.getElementById('toast'); return { hidden: t.hidden, inMain: !!t.closest('main'), dock: !!t.closest('.dock') }; });
    assert.deepEqual(where, { hidden: false, inMain: true, dock: false }, 'the toast shows on Screens, inside main');
    assert.deepEqual((await axe(page)).filter(v => v.id === 'region'), [], 'no content outside a landmark');
    // Esc in Detail with the toast showing: the toast goes and the view goes back to the list, in one press
    await page.evaluate(() => { location.hash = '#/findings'; });
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    await page.keyboard.press('Enter');
    await page.waitForSelector('#h-detail');
    // the first decision's toast can still be showing: wait for this decision itself to land (it moves Detail on to
    // the next finding, then shows its toast), so Esc never races the request (macos-latest, round 2)
    const hash = await page.evaluate(() => location.hash);
    await page.keyboard.press('s');
    await page.waitForFunction(h => location.hash !== h && !document.getElementById('toast').hidden, hash);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#h-findings');
    assert.equal(await page.evaluate(() => document.getElementById('toast').hidden), true, 'and the toast is gone');
    const help = await page.evaluate(() => import('/assets/shared.mjs').then(W => W.KEY_HELP.find(([k]) => k === 'Esc')[1]));
    assert.match(help, /undo toast/, 'the Keys help says so');
  } finally { await s.close(); }
});

test('board e2e: the toast waits while the pointer is over it or the focus is in it (WCAG 2.2.1); hidden with the focus inside, the focus goes back to the row', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await openBoard(browser, p, { setup: ({ page: pg }) => pg.clock.install() });
  const { page } = s;
  try {
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    const shown = () => page.evaluate(() => !document.getElementById('toast').hidden);
    const decideOne = async () => { await page.keyboard.press('j'); await page.keyboard.press('s'); await page.waitForSelector('#toast:not([hidden])'); };
    // the pointer over it: it waits; away again, 6 s later it goes
    await decideOne();
    await page.hover('#toast');
    await page.clock.runFor(9000);
    assert.equal(await shown(), true, 'held while the pointer is over it');
    await page.mouse.move(5, 5);
    await page.clock.runFor(6500);
    assert.equal(await shown(), false, 'gone 6 s after the pointer left');
    // the focus in it: it waits; Esc hides it and the focus goes back to the row
    await decideOne();
    await page.focus('#toast button');
    await page.clock.runFor(9000);
    assert.equal(await shown(), true, 'held while the focus is in it');
    await page.keyboard.press('Escape');
    assert.equal(await shown(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('row')), true, 'the focus is back on a row, not the page');
    // Undo from the toast's own button: the focus goes back to the row as well
    await decideOne();
    await page.focus('#toast button:last-child');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Undone/.test(document.getElementById('toast').textContent));
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('row')), true);
  } finally { await s.close(); }
});

test('board e2e: on a phone the Keys dialog and "More views in 0.2" are in the header, 44 px, and open', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const s = await open(project(), { viewport: { width: 390, height: 844 } });
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    for (const [id, title] of [['help-open', 'Keys'], ['more-views', 'More views in 0.2']]) {
      const r = await page.$eval(`#${id}`, e => (e.offsetParent === null ? null : { w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, top: e.getBoundingClientRect().top }));
      assert.ok(r, `#${id} is shown at 390 px`);
      assert.ok(r.w >= 43.5 && r.h >= 43.5, `#${id} is ${Math.round(r.w)}×${Math.round(r.h)}`);
      assert.ok(r.top < 300, `#${id} is in the header (top ${Math.round(r.top)})`);
      await page.click(`#${id}`);
      await page.waitForSelector('dialog[open]');
      assert.equal(await page.textContent('#dialog-title'), title);
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    }
  } finally { await s.close(); }
});

test('board a11y: non-text contrast of 3:1 or more — field, button, decision button and tick edges, the toast against the page, its buttons and its focus ring (light and dark)', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  for (const scheme of ['light', 'dark']) {
    const s = await open(p, { colorScheme: scheme });
    const { page } = s;
    try {
      await page.waitForSelector('#h-progress');
      await page.click('a[data-nav=findings]');
      await page.waitForSelector('#h-findings');
      await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
      // `edge`: the border against the element's own background and what is behind it; `ring`: the outline against
      // what is behind; `surface`: the background against what is behind and the page
      // queried and measured in one evaluation (a live redraw between the two would measure detached nodes)
      const ratios = (sel, kind = 'edge') => page.evaluate(([sel, kind]) => {
        const els = [...document.querySelectorAll(sel)];
        const rgb = c => (c.match(/[\d.]+/g) || []).map(Number);
        const clear = c => c === 'transparent' || rgb(c)[3] === 0;
        const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
        const behind = e => { for (let n = e.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!clear(c)) return c; } return 'rgb(255, 255, 255)'; };
        const page = getComputedStyle(document.body).backgroundColor;
        return els.filter(e => e.offsetParent !== null).map(e => {
          const cs = getComputedStyle(e), own = clear(cs.backgroundColor) ? behind(e) : cs.backgroundColor;
          const r = kind === 'ring' ? ratio(cs.outlineColor, own)
            : kind === 'surface' ? Math.min(ratio(cs.backgroundColor, behind(e)), ratio(cs.backgroundColor, page))
              : Math.min(ratio(cs.borderTopColor, own), ratio(cs.borderTopColor, behind(e)));
          return { e: e.outerHTML.slice(0, 60), r };
        });
      }, [sel, kind]);
      const low = list => list.filter(x => x.r < 3).map(x => `${x.e} ${x.r.toFixed(2)}`);
      for (const sel of ['#search', '#group-by', '.dbtn', '.row .tick']) {
        const list = await ratios(sel);
        assert.ok(list.length, `${sel} is there`);
        assert.deepEqual(low(list), [], `${scheme}: ${sel}`);
      }
      await page.keyboard.press('j');
      await page.keyboard.press('w');
      await page.waitForSelector('#toast:not([hidden])');
      assert.deepEqual(low(await ratios('#toast', 'surface')), [], `${scheme}: the toast against the dock and the page`);
      assert.deepEqual(low(await ratios('#toast .b')), [], `${scheme}: the toast's buttons`);
      // reached by the keyboard (Shift+Tab from the decision bar), so the focus ring shows
      await page.focus('.toolbar .dbtn[tabindex="0"]');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.getElementById('toast').contains(document.activeElement)), true, 'the toast is next to the bar in the tab order');
      assert.deepEqual(low(await ratios('#toast .b:focus-visible', 'ring')), [], `${scheme}: the focus ring in the toast`);
      assert.equal((await ratios('#toast .b:focus-visible', 'ring')).length, 1);
    } finally { await s.close(); }
  }
});

test('export a11y: the static page\'s primary button reads in dark mode too (the shared stylesheet, 4.5:1 or more)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  const out = join(p.root, 'export');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out });
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(pathToFileURL(join(out, 'index.html')).href);
      const r = await page.$eval('.btn-primary', e => {
        const rgb = c => (c.match(/[\d.]+/g) || []).map(Number).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        const lum = c => { const [r, g, b] = rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const cs = getComputedStyle(e), [x, y] = [lum(cs.color), lum(cs.backgroundColor)].sort((m, n) => n - m);
        return (x + 0.05) / (y + 0.05);
      });
      assert.ok(r >= 4.5, `${scheme}: ${r.toFixed(2)}:1`);
    } finally { await context.close(); }
  }
});

test('board e2e: a long route without a break wraps in its row; no sideways scroll at 390 px', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  const long = `/${'averyverylongpathsegmentwithoutanybreak'.repeat(4)}`;
  withAi(p, [{ lens: 'L6', rule: 'L6.vague-error', scene: { ...p.scenes[0], route: long }, selector: 'main p.err', box: [40, 300, 400, 24], claim: 'Short claim', status: 'confirmed', severity: 'high' }]);
  const s = await open(p, { viewport: { width: 390, height: 844 } });
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    const where = await page.evaluate(() => [...document.querySelectorAll('.row-where')].filter(e => e.textContent.includes('averyvery')).map(e => ({ sw: e.scrollWidth, cw: e.clientWidth, right: e.getBoundingClientRect().right })));
    assert.ok(where.length, 'the long route is shown');
    for (const w of where) assert.ok(w.sw <= w.cw + 1 && w.right <= 390 + 1, `it wraps (${w.sw} in ${w.cw}, right edge ${w.right})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll');
  } finally { await s.close(); }
});

test('board a11y: the focus never falls to the page — Z in Detail, Esc in Search, a live redraw, a board that stops; Shift+J says how many are selected', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  const focused = () => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || a.className; });
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    // Shift+J extends the selection and says so
    await page.keyboard.press('Shift+J');
    assert.match(await until(async () => { const a = await page.textContent('#announce'); return /selected/.test(a) && a; }), /^2 groups selected$/);
    await page.keyboard.press('Escape');
    // Esc in the search box: back to the row
    await page.focus('#search');
    await page.keyboard.type('a');
    await page.keyboard.press('Escape');
    assert.match(await focused(), /\brow\b/, 'Esc in Search leaves the focus on a row');
    await new Promise(r => setTimeout(r, 600));                  // the search's own redraw (250 ms later)
    assert.notEqual(await focused(), 'body', 'and the redraw keeps it');
    // Z in Detail: back on the finding it reopened, its heading focused
    const g = gid(p, 'dead-href');
    await page.evaluate(id => { location.hash = `#/finding/${id}`; }, g);
    await page.waitForFunction(id => location.hash === `#/finding/${id}` && document.getElementById('h-detail'), g);
    await page.keyboard.press('s');
    await page.waitForFunction(id => location.hash !== `#/finding/${id}`, g);
    await page.keyboard.press('z');
    await page.waitForFunction(id => location.hash === `#/finding/${id}`, g);
    await until(async () => (await focused()) === 'h-detail');
    assert.equal(await focused(), 'h-detail');
    // a live redraw (the undo bumped the version): the focus stays
    await new Promise(r => setTimeout(r, 1500));
    assert.notEqual(await focused(), 'body', 'a live update keeps the focus');
    // the board stops: said, and the focus on the message
    await s.b.close();
    await page.waitForSelector('#lost-h');
    assert.equal(await until(async () => (await focused()) === 'lost-h' && 'lost-h'), 'lost-h');
    assert.equal(await until(async () => { const a = await page.textContent('#announce'); return a === 'The board stopped.' && a; }), 'The board stopped.');
  } finally { await s.close(); }
});

test('board e2e: keys by their place — F on a Korean layout fixes, W with Caps Lock keeps as intended', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    const press = (key, code, shiftKey = false) => page.evaluate(([key, code, shiftKey]) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, code, shiftKey, bubbles: true, cancelable: true })), [key, code, shiftKey]);
    await page.keyboard.press('j');
    const first = await page.evaluate(() => document.activeElement.getAttribute('data-id'));
    await press('ㄹ', 'KeyF');                               // what a Korean (2-set) layout sends for F
    let files = await until(() => { const d = decisions(p.nunchi); return d.length === 1 && d; });
    assert.deepEqual([files[0].decision, files[0].target.group], ['fix', first]);
    await until(async () => (await page.evaluate(() => document.activeElement.getAttribute('data-id'))) !== first);
    const second = await page.evaluate(() => document.activeElement.getAttribute('data-id'));
    await press('W', 'KeyW', false);                             // Caps Lock on: W without Shift
    files = await until(() => { const d = decisions(p.nunchi); return d.length === 2 && d; });
    const kept = files.find(d => d.target.group === second);
    assert.deepEqual([kept.decision, kept.reason], ['keep', 'intended'], 'not "out of scope" (that is Shift+W)');
  } finally { await s.close(); }
});

test('board e2e: Z pressed while the decision is still on its way undoes that decision (a slow round trip)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    // every decision takes 600 ms to answer
    await page.route('**/api/decide', async route => { await new Promise(r => setTimeout(r, 600)); await route.continue(); });
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    await page.keyboard.press('j');
    await page.keyboard.press('s');
    await page.keyboard.press('z');
    const files = await until(() => { const d = decisions(p.nunchi); return d.length === 2 && d; });
    assert.deepEqual(files.map(d => d.decision).sort(), ['hold', 'reopen'], 'the undo waited for the decision and undid it');
  } finally { await s.close(); }
});

test('board e2e: live updates outlast a board that does not answer for a while; only 4 misses in a row say it is not running; the stream is tried again', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  let down = true, streams = 0, polls = 0;
  const s = await openBoard(browser, p, { setup: async ({ page: pg }) => {
    await pg.clock.install();
    // the stream never opens here; the polling gets no answer while `down`
    await pg.route('**/api/live', r => { streams++; return r.abort('connectionrefused'); });
    await pg.route('**/api/generation', r => { polls++; return down ? r.abort('connectionrefused') : r.continue(); });
  } });
  const { page } = s;
  try {
    const advance = async (ms, until = () => false) => { for (let i = 0; i < ms / 500 && !until(); i++) { await page.clock.runFor(500); await new Promise(r => setTimeout(r, 30)); } };
    const lostText = () => page.evaluate(() => document.getElementById('lost-h')?.textContent || null);
    await advance(20000, () => polls >= 2);
    assert.ok(polls >= 2, `two polls got no answer (${polls})`);
    assert.equal(await lostText(), null, 'two misses do not say the board is gone');
    const status = () => page.evaluate(() => document.getElementById('live-status').textContent);
    assert.equal(await status(), 'Reconnecting…', 'but they say it is reconnecting');
    down = false;
    const before = streams;
    await advance(30000, () => streams > before);
    assert.ok(streams > before, 'once the board answers, the stream is tried again');
    assert.equal(await lostText(), null);
    assert.equal(await status(), '', 'the next answer clears the status');
    down = true;
    await advance(90000, () => false);
    assert.equal(await lostText(), 'The board is not running.', 'four misses in a row say so');
  } finally { await s.close(); }
});

test('board e2e: a board killed hard says "Reconnecting…" within about 3 s (said politely), then "not running" after 4 misses', { timeout: 60000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  const s = await openBoard(browser, p);
  const { b, page } = s;
  try {
    await page.waitForFunction(() => document.getElementById('live-status') && document.getElementById('live-status').textContent === '');
    // killed hard: no goodbye on the stream, every connection dropped, nothing listening
    const t0 = Date.now();
    b.server.close(); b.server.closeAllConnections();
    await page.waitForFunction(() => document.getElementById('live-status').textContent === 'Reconnecting…', null, { timeout: 3500 });
    assert.ok(Date.now() - t0 <= 3500, `Reconnecting… after ${Date.now() - t0} ms`);
    assert.equal(await page.evaluate(() => document.getElementById('announce').getAttribute('aria-live')), 'polite');
    await page.waitForFunction(() => document.getElementById('announce').textContent === 'Reconnecting…', null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => document.getElementById('lost-h')), null, 'one miss does not say the board is gone');
    await page.waitForFunction(() => document.getElementById('lost-h')?.textContent === 'The board is not running.', null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.getElementById('live-status').textContent), '', 'the status gives way to the message');
  } finally { await s.close().catch(() => {}); }
});

test('board e2e: the list holds still while you work; new findings wait behind a banner until R', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    const ids = () => page.evaluate(() => [...document.querySelectorAll('.row[data-id]')].map(r => r.getAttribute('data-id')));
    const before = await ids();
    // a new capture lands: one more defect
    writeRun(p.root, '0002', { parent: '0001', scenes: p.scenes, findings: [...p.findings.map(({ fp, group, ...f }) => f),
      { lens: 'L1', rule: 'clipped-text', severity: 'high', scene: p.scenes[2].id, route: '/garden', viewport: 'd', selector: 'h2.bed', box: null, evidence: { text: 'Raised beds' } }] });
    assert.equal((await cli(p.root, 'findings')).code, 0, 'the ledger folds it (and bumps the generation)');
    await page.waitForSelector('#updates:not([hidden])', { timeout: 10000 });
    assert.match(await page.textContent('#updates'), /Updated: 1 new/);
    assert.deepEqual(await ids(), before, 'order and members did not move');
    await page.keyboard.press('r');
    await until(async () => (await ids()).length === before.length + 1);
    assert.equal((await ids()).length, before.length + 1);
  } finally { await s.close(); }
});

test('board e2e: detail — the box plus context, 0 for the whole screen, [ ] to flip, Desktop/Phone, a code location to copy', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p);
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.evaluate(id => { location.hash = `#/finding/${id}`; }, gid(p, 'dead-href'));
    await page.waitForSelector('#h-detail');
    assert.ok(await page.locator('.shot .box').count() >= 1, 'the element is outlined');
    await until(() => page.$eval('.shot', el => el.style.backgroundImage.startsWith('url("blob:')));
    assert.ok(await page.$eval('.shot', el => el.style.backgroundImage.startsWith('url("blob:')), 'the screenshot came through the key, as a blob');
    assert.match(await page.textContent('main'), /Seen on 3 screens · 1 of 2 here · \[ \/ \] to flip/);
    const ratio = () => page.$eval('.shot', el => el.style.aspectRatio);
    const cropped = await ratio();
    await page.keyboard.press('0');
    assert.notEqual(await ratio(), cropped, '0 shows the whole screen');
    await page.keyboard.press(']');
    assert.match(await page.textContent('main'), /2 of 2 here/);
    await page.click('button[aria-pressed]:has-text("Phone")');
    assert.match(await page.textContent('main'), /Visitor · Phone · Normal/);
    // an AI finding grounded in code: Copy path and an editor link into the project
    await page.evaluate(id => { location.hash = `#/finding/${id}`; }, p.ai.find(i => i.verification.status === 'confirmed').group);
    await page.waitForSelector('#h-detail');
    assert.match(await page.textContent('main'), /app\/garden\/page\.tsx:12/);
    assert.match(await page.getAttribute('a:has-text("Open in VS Code")', 'href'), /^vscode:\/\/file\/.+app\/garden\/page\.tsx:12$/);
    // J moves to the next group in the list's order
    await page.keyboard.press('j');
    await until(async () => (await page.evaluate(() => location.hash)) !== '');
    assert.match(await page.evaluate(() => location.hash), /^#\/finding\/[0-9a-f]{12}$/);
  } finally { await s.close(); }
});

test('board a11y: axe finds nothing on Progress, Findings, Detail and Screens; landmarks, roles, 44 px targets, severity in words', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  for (const [scheme, width] of [['light', 1280], ['dark', 390]]) {
    const s = await open(p, { colorScheme: scheme, viewport: { width, height: 844 } });
    const { page } = s;
    try {
      await page.waitForSelector('#h-progress');
      for (const [view, ready] of [['#/progress', '#h-progress'], ['#/findings', '#h-findings'], [`#/finding/${gid(p, 'dead-href')}`, '#h-detail'], ['#/screens', '#h-screens']]) {
        await page.evaluate(h => { location.hash = h; }, view);
        await page.waitForSelector(ready);
        if (view === '#/screens') { await page.click('.card button'); await page.waitForSelector('#panel-h'); }
        const v = await axe(page);
        assert.equal(JSON.stringify(v), '[]', `${scheme} ${width}px ${view}`);
        assert.equal(await page.locator('nav[aria-label=nunchi]').count(), 1);
        assert.equal(await page.locator('main#main').count(), 1);
        // every control is at least 44 px high (and buttons as wide)
        const small = await page.evaluate(() => [...document.querySelectorAll('main button, main [role=tab], main [role=option], main select, main input, nav .nav a, main .btn, main .tile, main .meter-row a, nav .side-foot button')]
          .filter(e => e.offsetParent !== null).map(e => ({ e: e.outerHTML.slice(0, 80), r: e.getBoundingClientRect() })).filter(x => x.r.height < 43.5 || (x.e.startsWith('<button') && x.r.width < 43.5)).map(x => `${x.e} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`));
        assert.deepEqual(small, [], `${view} at ${width}px`);
        // severity is said in words, not only by the dot's colour
        for (const text of await page.$$eval('.sev', els => els.map(e => e.textContent.trim()))) assert.match(text, /^(Blocker|High|Medium|Low)$/);
        if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${view}: no sideways scroll at 390 px (200% zoom of 780 px)`);
      }
      // the skip link, once the keyboard reaches it, is 44 px too
      await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.skip').focus(); });
      const skip = await page.$eval('.skip', e => ({ h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, focused: document.activeElement === e }));
      assert.ok(skip.focused && skip.h >= 43.5, `the skip link is ${Math.round(skip.w)}×${Math.round(skip.h)}`);
      await page.evaluate(() => { location.hash = '#/findings'; });
      await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
      assert.ok(await page.locator('[role=listbox][aria-multiselectable=true]').count() >= 1);
      assert.equal(await page.locator('[role=tablist] [role=tab][aria-selected=true]').count(), 1);
      assert.equal(await page.locator('[role=toolbar][aria-label=Decide]').count(), 1);
      assert.equal(await page.locator('#announce[aria-live=polite]').count(), 1);
      if (scheme === 'dark') assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(20, 21, 24)', 'prefers-color-scheme is honoured');
    } finally { await s.close(); }
  }
});

test('board a11y: the keyboard — tabs with arrows, the toolbar, ? for help, keys off in text fields, single-key shortcuts can be turned off; reduced motion', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p, { reducedMotion: 'reduce' });
  const { page } = s;
  try {
    await page.waitForSelector('#h-progress');
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    // tabs: arrows move and select
    await page.focus('[role=tab][aria-selected=true]');
    await page.keyboard.press('ArrowRight');
    await until(async () => (await page.getAttribute('[role=tab][aria-selected=true]', 'data-k')) === 'to-fix');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-k')), 'to-fix');
    await page.keyboard.press('ArrowLeft');
    await until(async () => (await page.getAttribute('[role=tab][aria-selected=true]', 'data-k')) === 'open');
    // the toolbar: arrows move between its buttons
    await page.focus('[role=toolbar] button[tabindex="0"]');
    await page.keyboard.press('ArrowRight');
    assert.match(await page.evaluate(() => document.activeElement?.textContent), /^Keep/);
    // keys are off in the search field
    await page.focus('#search');
    await page.keyboard.type('w');
    await new Promise(r => setTimeout(r, 600));
    assert.equal(decisions(p.nunchi).length, 0, 'typing w in search decided nothing');
    await page.fill('#search', '');
    await new Promise(r => setTimeout(r, 600));
    await page.keyboard.press('Escape');
    // ? shows the keys; the shortcuts can be turned off there (WCAG 2.1.4)
    await page.focus('.row[tabindex="0"]');
    await page.keyboard.press('?');
    await page.waitForSelector('dialog[open] table.keys');
    await page.uncheck('#keys-on');
    await page.click('dialog button:has-text("Close")');
    await page.focus('.row[tabindex="0"]');
    const here = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    await page.keyboard.press('w');
    await page.keyboard.press('j');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(decisions(p.nunchi).length, 0, 'w does nothing with the shortcuts off');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-id')), here, 'nor does j');
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('data-id')), here, 'the arrows still move');
    // the decision bar still decides, by its buttons
    await page.click('[role=toolbar] button:has-text("Later")');
    await until(() => decisions(p.nunchi).length === 1);
    assert.equal(decisions(p.nunchi)[0].decision, 'hold');
    // reduced motion: nothing moves
    assert.equal(await page.$eval('#toast', el => getComputedStyle(el).transitionDuration), '0s');
  } finally { await s.close(); }
});

test('board e2e: label mode — the banner, keys 1/2/3, no decision bar, labels saved per labeller', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = project();
  const s = await open(p, {}, { mode: 'label', labeller: 'owner' });
  const { page } = s;
  try {
    await page.waitForSelector('#h-label');
    assert.match(await page.textContent('.label-banner'), /Labelling for the precision check · 0\/2/);
    assert.equal(await page.locator('[role=toolbar]').count(), 0, 'no decision bar');
    assert.ok(!/AI · |double-checked|Blocker|High|Medium/.test(await page.textContent('main')), 'source, verdict and severity are hidden');
    await page.keyboard.press('1');
    await until(async () => /1\/2/.test(await page.textContent('.label-banner')));
    const labels = readdirSync(join(p.nunchi, 'labels', 'owner'));
    assert.equal(labels.length, 1);
    assert.equal(JSON.parse(readFileSync(join(p.nunchi, 'labels', 'owner', labels[0]), 'utf8')).label, 'correct');
    const v = await axe(page);
    assert.deepEqual(v, []);
  } finally { await s.close(); }
});
