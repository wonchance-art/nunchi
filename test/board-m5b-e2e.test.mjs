// M5b in a real browser: the wall during a first look — "First look" on its key screens and "Not checked yet" on the
// pages it did not open — as text in the board's chip style, 4.5:1 or more in light and dark, an edge in forced colours,
// in each card's accessible name, axe with no violation; Enter or Space on a page not opened shows what it is (nothing
// to open); and a capture that stops reaches the open board by itself (Progress's Now line, Coverage's banner). Every
// measurement is one page.evaluate (a live redraw detaches handles). Needs Chromium (NUNCHI_BROWSER or `nunchi setup`):
// skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { leafy } from './fixtures/coverage-project.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await browser?.close(); });

async function open(p, ctx = {}) {
  const b = await startBoard({ projectDir: p.root });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...ctx });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(b.newLink());
  await page.waitForSelector('#h-progress');
  return { b, page, errors, close: async () => { await context.close(); await b.close(); } };
}
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}
// The wall's chips, measured in one evaluation: their words, the contrast of their text on their own background (or
// what is behind them), their edge, and the cards' accessible names.
const chips = page => page.evaluate(() => {
  const rgb = c => (String(c).match(/[\d.]+/g) || []).map(Number);
  const clear = c => c === 'transparent' || rgb(c)[3] === 0;
  const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (([x, y]) => (x + 0.05) / (y + 0.05))([lum(a), lum(b)].sort((m, n) => n - m));
  const bg = e => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!clear(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
  const shown = sel => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length);
  const of = sel => { const els = shown(sel); return { n: els.length, words: [...new Set(els.map(e => e.textContent))], least: Math.min(...els.map(e => ratio(getComputedStyle(e).color, bg(e)))),
    edge: [...new Set(els.map(e => `${getComputedStyle(e).borderTopStyle} ${getComputedStyle(e).borderTopWidth}`))] }; };
  const name = sel => document.querySelector(sel)?.closest('button')?.getAttribute('aria-label') ?? null;
  return { first: of('.card .tag-first'), notYet: of('.card .tag-notyet'), firstName: name('.card .tag-first'), notYetName: name('.card .tag-notyet'),
    forced: matchMedia('(forced-colors: active)').matches, sideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
});

test('m5b e2e: the wall during a first look — "First look" and "Not checked yet" as text chips, 4.5:1 light and dark, named, an edge in forced colours, axe clean; a page not opened has nothing to open', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  for (const [scheme, width] of [['light', 1440], ['dark', 390]]) {
    const s = await open(p, { colorScheme: scheme, viewport: { width, height: 900 } });
    const { page } = s;
    try {
      await page.evaluate(() => { location.hash = '#/screens'; });
      await page.waitForSelector('#h-screens');
      const c = await chips(page);
      // the wall's default width is Desktop: 3 key pages and 4 not opened, for a visitor and signed in
      assert.deepEqual([c.first.n, c.first.words, c.notYet.n, c.notYet.words], [6, ['First look'], 8, ['Not checked yet']], scheme);
      assert.ok(c.first.least >= 4.5 && c.notYet.least >= 4.5, `${scheme}: ${c.first.least.toFixed(2)}:1, ${c.notYet.least.toFixed(2)}:1`);
      assert.match(c.firstName, /^Plant shelf, Visitor · Desktop · Normal: .+\. First look/);
      assert.equal(c.notYetName, '/checkout, Visitor · Desktop · Normal: Not checked yet');
      assert.equal(c.sideways, false);
      assert.deepEqual(await axe(page), [], `${scheme} at ${width} px`);
      // Enter on a page the first look did not open: what it is, and the first look's line; nothing to open
      await page.focus('[data-key="0005/not-yet.guest.d:/checkout"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sp-notyet');
      const panel = await page.evaluate(() => ({ h: document.getElementById('panel-h').textContent, chip: document.querySelector('.sp-notyet .tag-notyet')?.textContent, text: document.querySelector('.sp-notyet .small')?.textContent,
        open: !!document.getElementById('sp-open'), hash: location.hash }));
      assert.deepEqual(panel, { h: '/checkout', chip: 'Not checked yet', text: 'First look: 3 key screens · the full check has not started — tell your AI “full check”', open: false,
        hash: `#/screen/${encodeURIComponent('0005/not-yet.guest.d:/checkout')}` });
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
  // forced colours (a Windows contrast theme): the chips keep an edge, and their words
  const s = await open(p, { forcedColors: 'active' });
  try {
    await s.page.evaluate(() => { location.hash = '#/screens'; });
    await s.page.waitForSelector('#h-screens');
    const c = await chips(s.page);
    assert.deepEqual([c.forced, c.first.edge, c.notYet.edge, c.first.words, c.notYet.words], [true, ['solid 1px'], ['solid 1px'], ['First look'], ['Not checked yet']]);
  } finally { await s.close(); }
});

test('m5b e2e: a capture that stops reaches the open board by itself — Progress\'s Now line and Coverage\'s banner say "Capture stopped"', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const dir = join(p.nunchi, 'runs', '0005.partial');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ schema: 1, kind: 'sweep', wholeApp: true, routes: 25, done: 12, routeMs: Array(12).fill(27000), pid: process.pid, host: hostname() }));
  const s = await open(p);
  const { page } = s;
  try {
    const running = 'Capture running · run 0005 · 12 of 25 screens (about 6 min left)';
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.now li')].map(l => l.textContent)), [running]);
    await page.evaluate(() => { location.hash = '#/coverage'; });
    await page.waitForSelector('#cv-capture');
    assert.equal(await page.evaluate(() => document.getElementById('cv-capture').textContent), `${running}. This shows run 0004 until it finishes.`);
    // no progress for 10 minutes: nothing is written, and the board says so by itself
    const old = new Date(Date.now() - 10 * 60e3 - 1000);
    utimesSync(join(dir, 'progress.json'), old, old);
    const stopped = 'Capture stopped · run 0005 (no progress for 10 min) — tell your AI “capture again”';
    await page.waitForFunction(t => document.getElementById('cv-capture')?.textContent === t, stopped, { timeout: 15000 });
    await page.evaluate(() => { location.hash = '#/progress'; });
    await page.waitForSelector('#h-progress');
    assert.deepEqual(await page.evaluate(() => [document.getElementById('h-progress').textContent, [...document.querySelectorAll('.now li')].map(l => l.textContent)]),
      ['Not yet · 1 high: 1 to decide', [stopped]], 'the verdict goes by the complete runs, as without the stopped capture');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
