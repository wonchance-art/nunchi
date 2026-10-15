// Screens beyond the wall in a real browser (M7; the mock-up the owner approved on 2026-10-15 KST, §4): the wall's
// counts, Show filter, search, page groups and one tab stop; Screen detail with its numbered findings (the same number
// on both widths, one stacked marker for boxes that overlap), V, B, [ ], 0, C and 1–9; a viewer only (D4: no decision
// key works here, Enter opens the finding, Esc comes back); a screen gone after a new run; axe, 44 px, no sideways
// scroll. Every measurement is one page.evaluate. Needs Chromium (NUNCHI_BROWSER or `nunchi setup`): skipped without
// one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { writeRun } from './fixtures/board-project.mjs';
import { leafy, leafyScenes } from './fixtures/coverage-project.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await browser?.close(); });

async function open(p, ctx = {}) {
  const b = await startBoard({ projectDir: p.root });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctx });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(b.newLink());
  await page.waitForSelector('#h-progress');
  return { b, page, errors, close: async () => { await context.close(); await b.close(); } };
}
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 100)); } };
const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')); } catch { return []; } };
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}
const focused = page => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || a.tagName; });
const go = async (page, hash, ready) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(ready); };

test('screens e2e: the wall — counts on its filters, "N shown of M", Show, search (/), page groups, one tab stop; Space looks, Enter opens, Esc comes back to the card', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  const s = await open(p);
  const { page } = s;
  try {
    await page.click('a[data-nav=screens]');
    await page.waitForSelector('#h-screens');
    const w = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('.wall-filters button')].map(b => b.textContent),
      facts: document.querySelector('.facts-inline').textContent, groups: [...document.querySelectorAll('.wall-g-h')].map(h => h.textContent),
      stops: document.querySelectorAll('.card button[tabindex="0"]').length, cards: document.querySelectorAll('.card button').length,
      line: document.getElementById('card-0004/~.guest.normal.d').textContent,
    }));
    assert.deepEqual(w.buttons, ['Desktop 14', 'Phone 14', 'All', 'Visitor 7', 'Signed in 7', 'All', 'Normal 14', 'Empty 5', 'Error 5', 'Slow 5', 'Offline 5', 'All',
      'All', 'Open findings 2', 'Not checked 2', 'Changed since run 0003 1']);
    assert.equal(w.facts, '5 with open findings57 clean6 not checked14 shown of 68');
    assert.deepEqual(w.groups, ['Pages · /, /cart, /checkout, /help, /login', '/garden/*']);
    assert.deepEqual([w.stops, w.cards], [1, 14], 'one tab stop into the wall');
    assert.match(w.line, /2 open findingsAI 7 of 7 · Changed$/);
    // Show: Not checked
    await page.click('#wall-show-not');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.card .card-name')].map(x => x.textContent)), ['Checkout', 'Sign in']);
    await page.click('#wall-show-all');
    // / searches the route and the page name
    await page.focus('.card button[tabindex="0"]');
    await page.keyboard.press('/');
    assert.equal(await focused(page), 'screen-search');
    await page.keyboard.type('plot');
    await page.waitForFunction(() => document.getElementById('wall-shown').textContent === '2 shown of 68');
    await page.fill('#screen-search', 'nothing like this');
    await page.waitForSelector('#wall-clear');
    assert.match(await page.textContent('.wall-groups'), /No screen matches these filters\./);
    await page.click('#wall-clear');
    await page.waitForFunction(() => document.getElementById('wall-shown')?.textContent === '68 shown of 68');
    // the keys: arrows card to card, J/K, Space the quick look (the focus stays), Enter the screen, Esc back to its card
    await page.click('#wall-vp-d');
    await page.click('#wall-state-normal');
    await page.focus('.card button[tabindex="0"]');
    const first = await focused(page);
    await page.keyboard.press('ArrowRight');
    const second = await focused(page);
    assert.notEqual(second, first);
    await page.keyboard.press('k');
    assert.equal(await focused(page), first);
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await focused(page), first, 'the card below');
    await page.keyboard.press('Home');
    assert.equal(await focused(page), first);
    await page.keyboard.press(' ');
    await page.waitForSelector('#panel-h');
    assert.equal(await focused(page), first, 'Space shows the quick look and keeps the focus on the card');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.screen-panel .num')].map(n => n.textContent)), ['1 2'], 'two findings on one element: one stacked marker, ① not hidden under ②');
    assert.match(await page.textContent('#sp-open'), /Open this screen/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#h-screen');
    assert.equal(await page.evaluate(() => location.hash), '#/screens/0004/~.guest.normal.d');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#h-screens');
    assert.equal(await until(async () => (await focused(page)) === first && 'ok'), 'ok', 'Esc: back to the wall, the focus on the card');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('screens e2e: Screen detail — numbered by group on both widths, one stacked marker for overlapping boxes, V B [ ] 0 C 1–9, J/K said; no decision key (D4)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  const s = await open(p, { viewport: { width: 1440, height: 900 } });
  const { page } = s;
  try {
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    const d = await page.evaluate(() => ({
      h1: document.getElementById('h-screen').textContent, chips: document.querySelector('.sd-head .chips').textContent, focus: document.activeElement?.id,
      nums: [...document.querySelectorAll('.sd-fig .num')].map(n => n.textContent), list: [...document.querySelectorAll('.sd-list li')].map(li => li.textContent),
      img: document.querySelector('.sd-fig .shot').getAttribute('aria-label'), toolbar: document.querySelectorAll('[role=toolbar] button[tabindex="0"]').length,
    }));
    assert.equal(d.h1, 'Plant shelf');
    assert.match(d.chips, /^2 mediumRule checks ✓ · AI 7 of 7 lenses · Changed since run 0003Coverage ▸$/);
    assert.equal(d.focus, 'h-screen');
    assert.deepEqual(d.nums, ['1 2'], 'the dead link and the AI\'s claim share a box: one stacked marker, ① not hidden under ②');
    assert.deepEqual(d.list, ['11. Medium · Link that goes nowhere (#)Rule · Open · Desktop, Phone', '22. Medium · AI · Two words for one thingL5 · not double-checked · Open · Desktop only',
      '33. Low · Tap target smaller than 24pxRule · Open · Phone only']);
    assert.equal(d.img, 'Screenshot of /, Visitor · Desktop · Normal, 2 findings outlined and numbered');
    assert.equal(d.toolbar, 1, 'one toolbar, one tab stop');
    // 2: finding 2 focused, its box marked (thicker, number inverted)
    await page.keyboard.press('2');
    const on = await page.evaluate(() => ({ focus: document.activeElement?.id, boxes: [...document.querySelectorAll('.sd-fig .box.box-on')].map(b => b.getAttribute('data-ns')), num: document.querySelector('.sd-fig .box.box-on .num')?.textContent }));
    assert.deepEqual(on, { focus: 'sd-f-2', boxes: ['1 2', '1 2'], num: '1 2' }, 'the boxes of finding 2 (it shares its element with finding 1)');
    // B: both widths, the same number on each; V: back to one width
    await page.keyboard.press('b');
    const both = await page.evaluate(() => ({ figs: [...document.querySelectorAll('.sd-fig .sd-cap')].map(x => x.textContent), nums: [...document.querySelectorAll('.sd-fig')].map(f => [...f.querySelectorAll('.num')].map(n => n.textContent)), note: document.querySelector('.sd-side').textContent.includes('Same defect, same number on both widths.') }));
    assert.deepEqual(both, { figs: ['Desktop', 'Phone'], nums: [['1 2'], ['1', '3']], note: true });
    await page.keyboard.press('v');
    await page.keyboard.press('v');
    await page.waitForFunction(() => location.hash === '#/screens/0004/~.guest.normal.m');
    await page.waitForFunction(() => document.querySelector('.sd-head p.muted')?.textContent === '/ · Visitor · Phone · Normal');
    // [ ]: the other states of this page (a page with data)
    await go(page, '#/screens/0004/cart.signed-in.error.d', '#h-screen');
    await page.keyboard.press(']');
    await page.waitForFunction(() => location.hash === '#/screens/0004/cart.signed-in.slow.d' && document.querySelector('.sd-head p.muted')?.textContent.endsWith('· Slow'));
    await page.keyboard.press('[');
    await page.waitForFunction(() => location.hash === '#/screens/0004/cart.signed-in.error.d' && document.querySelector('.sd-head p.muted')?.textContent.endsWith('· Error'));
    // 0: the whole screen
    const ratio = () => page.evaluate(() => document.querySelector('.sd-fig .shot').style.aspectRatio);
    const firstView = await ratio();
    await page.keyboard.press('0');
    assert.notEqual(await ratio(), firstView, '0 shows the whole screen');
    // C: compare with the last full check (a slider), then each fix attempt; side by side
    await page.keyboard.press('c');
    await page.waitForSelector('#sd-slider-d');
    const cmp = await page.evaluate(() => ({ labels: document.querySelector('.cmp-labels').textContent, value: document.getElementById('sd-slider-d').getAttribute('aria-valuetext'), note: document.querySelector('.fix-compare').textContent.includes('Changed since run 0003: pixels and text differ.') }));
    assert.deepEqual(cmp, { labels: 'Before: run 0003After: run 0004', value: 'Before 50%, After 50%', note: true });
    await page.focus('#sd-slider-d');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.getElementById('sd-slider-d').getAttribute('aria-valuetext')), 'Before 55%, After 45%');
    // Esc leaves the slider first (as any field), then goes back to the wall
    await page.keyboard.press('Escape');
    assert.equal(await focused(page), 'h-screen');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#h-screens');
    await go(page, '#/screens/0004/cart.signed-in.error.d', '#h-screen');
    assert.ok(await page.$('#sd-slider-d'), 'the compare choice is kept for the session');
    await page.keyboard.press('c');
    await page.waitForFunction(() => document.querySelector('.cmp-labels')?.textContent === 'BeforeAfter (attempt 1, undone)');
    await page.keyboard.press('c');
    await page.waitForFunction(() => document.querySelector('.sd-figs')?.textContent.includes('The screens of this fix were removed (nunchi gc)'));
    await page.keyboard.press('c');
    await page.waitForFunction(() => !document.querySelector('.cmp-labels') && document.getElementById('sd-cmp-off')?.getAttribute('aria-pressed') === 'true');
    // a screen that did not change: unchanged, no slider
    await go(page, '#/screens/0004/cart.signed-in.normal.d', '#h-screen');
    await page.click('#sd-cmp-run');
    await page.waitForFunction(() => document.querySelector('.sd-figs')?.textContent.includes('Unchanged since run 0003 (same pixels and text)'));
    assert.equal(await page.$('#sd-slider-d'), null);
    assert.match(await page.textContent('.sd-side'), /Fixed here since run 0003 \(1\)✓ Image does not load · fixed in run 0004/);
    await page.click('#sd-cmp-off');
    // J/K walk the wall's order and say where they are
    await page.keyboard.press('j');
    assert.match(await until(async () => { const a = await page.textContent('#announce'); return /of \d+\.$/.test(a) && a; }), /^Checkout, Visitor · Desktop · Normal: Redirected\. 5 of 14\.$/);
    // no decision key works here (D4)
    for (const k of ['f', 'w', 'x', 's', 'z', 'W', 'X']) await page.keyboard.press(k);
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(decisions(p.nunchi), [], 'F, W, X, S and Z decide nothing in Screens');
    // ? lists the keys of Screens and Coverage in sections of their own
    await page.keyboard.press('?');
    await page.waitForSelector('dialog[open]');
    const help = await page.evaluate(() => ({ h3: [...document.querySelectorAll('dialog h3')].map(x => x.textContent), text: document.querySelector('dialog').textContent }));
    assert.deepEqual(help.h3, ['Screens', 'Coverage']);
    for (const k of ['VDesktop or phone', 'BBoth widths', '[ / ]Other states of this page', 'CCompare', '1–9Finding n', 'J / KNext / previous cell with a gap']) assert.ok(help.text.includes(k), k);
    await page.keyboard.press('Escape');
    // Enter on a finding opens it (decided in Finding detail); Esc there comes back to the screen
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#h-detail');
    assert.match(await page.getAttribute('#detail-cov', 'href'), /^#\/coverage\/0004\/~\.guest\.normal\.[dm]$/, 'Finding detail links to the screen\'s coverage');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#/screens/0004/~.guest.normal.d' && document.getElementById('h-screen'));
    // a screen sent elsewhere: judged as that page, with a way there
    await go(page, '#/screens/0004/checkout.guest.normal.d', '#h-screen');
    await page.waitForFunction(() => document.getElementById('h-screen')?.textContent === 'Checkout');
    assert.equal(await page.$('.sd-figs .shot'), null, 'no image: it showed another page');
    assert.match(await page.textContent('.sd-figs'), /Not checked: sent to \/login\. It is judged as \/login\.Open \/login/);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('screens a11y: axe finds nothing on the wall and Screen detail (light 1280, dark 390), 44 px targets, no sideways scroll; filters are selects on a phone', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  for (const [scheme, width] of [['light', 1280], ['dark', 390]]) {
    const s = await open(p, { colorScheme: scheme, viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const { page } = s;
    try {
      for (const [hash, ready] of [['#/screens', '#h-screens'], ['#/screens/0004/~.guest.normal.d', '#h-screen'], ['#/screens/0004/cart.signed-in.error.d', '#h-screen']]) {
        await go(page, hash, ready);
        if (hash === '#/screens') { await page.click('.card button'); await page.waitForSelector('#panel-h'); }
        else {
          // the screen as it opens (one width, no compare): the image has the width of its column
          await page.waitForFunction(h => location.hash === h && document.querySelector('.sd-fig .shot'), hash);
          const shown = await page.evaluate(() => [...document.querySelectorAll('.sd-fig .shot')].map(e => Math.round(e.getBoundingClientRect().width)));
          assert.ok(shown.length && shown.every(w => w >= 100), `${width}px ${hash}: the screenshot is shown (${shown.join(', ')} px wide)`);
          await page.keyboard.press('b'); await page.keyboard.press('c'); await page.waitForTimeout(150);
        }
        assert.deepEqual(await axe(page), [], `${scheme} ${width}px ${hash}`);
        const m = await page.evaluate(() => ({
          small: [...document.querySelectorAll('main button, main select, main input, main a.b, main .sd-f, main .detail-nav a')].filter(e => e.offsetParent !== null)
            .map(e => ({ e: e.outerHTML.slice(0, 70), r: e.getBoundingClientRect() })).filter(x => x.r.height < 43.5 || (x.e.startsWith('<button') && x.r.width < 43.5)).map(x => `${x.e} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`),
          sideways: document.documentElement.scrollWidth > window.innerWidth + 1, selects: [...document.querySelectorAll('.wall-filters select')].map(x => x.id),
          shots: [...document.querySelectorAll('.sd-fig .shot, .screen-panel .shot')].map(e => Math.round(e.getBoundingClientRect().width)),
        }));
        assert.ok(m.shots.length && m.shots.every(w => w >= 100), `${width}px ${hash}: every screenshot is shown (${m.shots.join(', ')} px wide)`);
        assert.deepEqual(m.small, [], `${width}px ${hash}: every control 44 px`);
        assert.equal(m.sideways, false, `${width}px ${hash}: no sideways scroll`);
        if (hash === '#/screens') assert.deepEqual(m.selects, width < 760 ? ['wall-vp', 'wall-who', 'wall-state', 'wall-show'] : []);
      }
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});

test('screens e2e: after a new run the detail follows its screen, or says it is not in that run (the focus on its heading)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  try {
    await go(page, '#/screens/0004/help.guest.normal.d', '#h-screen');
    // run 0005 without the help page
    writeRun(p.root, '0005', { parent: '0004', scenes: leafyScenes().filter(x => x.route !== '/help'), findings: [] });
    assert.equal((await cli(p.root, 'findings')).code, 0, 'the ledger folds it (and bumps the generation)');
    await page.waitForFunction(() => document.getElementById('h-screen')?.textContent === 'This screen isn’t in run 0005.', null, { timeout: 15000 });
    assert.equal(await until(async () => (await focused(page)) === 'h-screen' && 'ok'), 'ok');
    await page.click('#sd-back');
    await page.waitForSelector('#h-screens');
    // a screen the new run has: the detail moves to it
    await go(page, '#/screens/0005/cart.signed-in.error.d', '#h-screen');
    assert.equal(await page.textContent('#h-screen'), 'Your cart');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
