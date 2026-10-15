// Coverage and Screens in a real browser: the fixes of the review of PR #35 (2026-10-15 KST), each measured in one
// page.evaluate (a live redraw detaches handles): markers of a nested small element stacked, the totals kept at 200%
// zoom, the map's layout by its own width, forced colours, one numbering for the quick look and Screen detail, J/K on
// the map's own cells, one width caption under compare, the grid's semantics, the wall's group names, the cell panel's
// order, Esc back to the finding's link, 44 px sibling links. Needs Chromium (NUNCHI_BROWSER or `nunchi setup`):
// skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { leafy } from './fixtures/coverage-project.mjs';

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
// To a view, and wait for that view's `ready` element: the view drawn for this address, never the one before it (from
// one Screen detail to another, `#h-screen` is there all along: keys pressed before the new one is drawn would go to
// the old one, as on a slow CI runner)
const go = async (page, hash, ready) => {
  const moved = await page.evaluate(h => { if (location.hash === h) return false; document.querySelector('main')?.firstElementChild?.setAttribute('data-was', '1'); location.hash = h; return true; }, hash);
  await page.waitForFunction(([r, moved]) => { const el = document.querySelector(r); return !!el && (!moved || !el.closest('[data-was]')); }, [ready, moved]);
};
const focused = page => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || a.tagName; });
// the wall's phone screens (buttons on a wide window, a select on a phone)
const phoneCards = async page => { if (await page.$('#wall-vp-m')) await page.click('#wall-vp-m'); else await page.selectOption('#wall-vp', 'm'); };
// the markers shown in `sel` (hidden ones are another marker's), and whether two of them overlap on screen
const markers = (page, sel) => page.evaluate(sel => {
  const shown = [...document.querySelectorAll(`${sel} .num`)].filter(n => n.getClientRects().length).map(n => ({ t: n.textContent, r: n.getBoundingClientRect() }));
  const overlap = shown.some((a, i) => shown.some((b, j) => j > i && a.r.left < b.r.right && b.r.left < a.r.right && a.r.top < b.r.bottom && b.r.top < a.r.bottom));
  return { nums: shown.map(x => x.t), overlap };
}, sel);

test('review: markers of a small element inside another one (1 px apart) are one stacked marker, in Screen detail and the quick look, at any width', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false, nested: true });
  for (const width of [1440, 390]) {
    const s = await open(p, { viewport: { width, height: 900 } });
    const { page } = s;
    try {
      await go(page, '#/screens/0004/~.guest.normal.m', '#h-screen');
      // stacked once the screenshot is laid out (its size on screen sets how close is too close)
      await page.waitForFunction(() => [...document.querySelectorAll('.sd-fig .num')].filter(n => n.getClientRects().length).length === 1);
      assert.deepEqual(await markers(page, '.sd-fig'), { nums: ['1 3'], overlap: false }, `${width}px: the "more" link (1) and the small link inside it (3)`);
      await go(page, '#/screens', '#h-screens');
      await phoneCards(page);
      await page.evaluate(() => { document.querySelector('[data-key="0004/~.guest.normal.m"]').click(); });
      await page.waitForSelector('#panel-h');
      await page.waitForFunction(() => [...document.querySelectorAll('.screen-panel .num')].filter(n => n.getClientRects().length).length === 1);
      assert.deepEqual(await markers(page, '.screen-panel'), { nums: ['1 3'], overlap: false }, `${width}px: the quick look too, with Screen detail's numbers`);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});

test('review: one numbering — the quick look numbers a finding as Screen detail does (by group, across the page\'s widths)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  const list = sel => page.evaluate(sel => [...document.querySelectorAll(`${sel} li`)].map(li => [li.querySelector('.numb')?.textContent, li.querySelector('.sp-what')?.textContent.replace(/^\d+\. /, '').replace(/^(High|Medium|Low|Blocker) · (AI · )?/, '')]), sel);
  try {
    await go(page, '#/screens', '#h-screens');
    await phoneCards(page);
    await page.evaluate(() => { document.querySelector('[data-key="0004/~.guest.normal.m"]').click(); });
    await page.waitForSelector('#panel-h');
    const quick = await list('.screen-panel .sp-list');
    await go(page, '#/screens/0004/~.guest.normal.m', '#h-screen');
    const detail = await list('.sd-list');
    assert.deepEqual(quick, [['1', 'Link that goes nowhere (#)'], ['3', 'Tap target smaller than 24px']], 'the phone\'s findings keep their page numbers (2 is the desktop\'s)');
    for (const [n, what] of quick) assert.ok(detail.some(([m, w]) => m === n && w === what), `${n} ${what} in Screen detail`);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('review: the totals keep every row at 200% zoom; the map is a list by its own width (768 px with the sidebar), a grid at 1024 px whose headers never break inside a word', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  for (const [width, height, dpr, grid] of [[640, 450, 2, false], [768, 900, 1, false], [1024, 900, 1, true]]) {
    const s = await open(p, { viewport: { width, height }, deviceScaleFactor: dpr });
    const { page } = s;
    try {
      await go(page, '#/coverage', '#h-map');
      const v = await page.evaluate(() => {
        // a word broken across lines has more than one line box
        const broken = [];
        for (const th of document.querySelectorAll('.cv-grid thead th')) {
          const text = th.textContent;
          for (const m of text.matchAll(/[^\s·]+/g)) {
            const range = document.createRange();
            let at = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
            const walk = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
              const len = n.textContent.length;
              if (!startNode && m.index < at + len) { startNode = n; startOff = m.index - at; }
              if (startNode && m.index + m[0].length <= at + len) { endNode = n; endOff = m.index + m[0].length - at; break; }
              at += len;
            }
            range.setStart(startNode, startOff); range.setEnd(endNode, endOff);
            const tops = new Set([...range.getClientRects()].map(r => Math.round(r.top)));
            if (tops.size > 1) broken.push(m[0]);
          }
        }
        return { rows: [...document.querySelectorAll('.cv-totals dt')].filter(d => d.getClientRects().length).map(d => d.textContent), grid: !!document.querySelector('[role=grid]'),
          list: !!document.querySelector('.cv-list'), broken, sideways: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.deepEqual(v.rows, ['Screens checked', 'AI looked at', 'Pages opened', 'Whole-app checks', 'AI review'], `${width}px: every row of the totals`);
      assert.deepEqual([v.grid, v.list, v.sideways], [grid, !grid, false], `${width}px: ${grid ? 'the grid' : 'the list'}`);
      assert.deepEqual(v.broken, [], `${width}px: no header word broken`);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});

test('review: forced colours — the selected cell, the segmented buttons\' edges and the pressed one, and the markers keep their own drawing', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p, { forcedColors: 'active' });
  const { page } = s;
  try {
    await go(page, '#/coverage/0004/cart.signed-in.normal.d', '#cv-panel-h');
    const c = await page.evaluate(() => {
      const cs = sel => getComputedStyle(document.querySelector(sel));
      return { forced: matchMedia('(forced-colors: active)').matches, sel: [cs('.cv-cell.cv-sel').outlineStyle, cs('.cv-cell.cv-sel').outlineWidth], segEdge: cs('.cv-map .seg-b button').borderTopWidth,
        pressed: cs('.cv-map .seg-b button[aria-pressed=true]').forcedColorAdjust };
    });
    assert.deepEqual(c, { forced: true, sel: ['solid', '3px'], segEdge: '1px', pressed: 'none' });
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    assert.deepEqual(await page.evaluate(() => ['.sd-fig .box', '.sd-fig .num', '.sd-list .numb'].map(x => getComputedStyle(document.querySelector(x)).forcedColorAdjust)), ['none', 'none', 'none']);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('review: J/K go to the map\'s own cells with a gap (never "Other states" or a page not opened); the grid is read-only, every cell says whether it is selected; the panel\'s heading is under the map\'s; the lenses come before what to say', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  try {
    await go(page, '#/coverage', '#h-map');
    await page.focus('#cv-0-0');
    const visited = [];
    for (let i = 0; i < 40; i++) { await page.keyboard.press('j'); visited.push(await focused(page)); }
    const cols = (await page.evaluate(() => document.querySelector('[role=grid]').getAttribute('aria-colcount'))) - 1;
    assert.ok(visited.length && visited.every(id => /^cv-\d+-\d+$/.test(id)), visited.join(' '));
    assert.deepEqual(visited.filter(id => Number(id.split('-')[2]) >= cols - 1 || id === 'cv-7-0'), [], 'no "Other states" cell, no page that was not opened');
    await page.focus('#cv-3-2');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cv-panel-h');
    const g = await page.evaluate(() => {
      const grid = document.querySelector('[role=grid]');
      const cells = [...grid.querySelectorAll('[role=gridcell]')];
      const panel = document.querySelector('.cv-panel');
      const order = [...panel.querySelectorAll('dt, .cv-lenses')].map(e => (e.tagName === 'DT' ? e.textContent : 'lenses'));
      return { readonly: grid.getAttribute('aria-readonly'), selected: cells.filter(c => c.getAttribute('aria-selected') === 'true').map(c => c.id), unsaid: cells.filter(c => !c.hasAttribute('aria-selected')).length,
        heading: document.getElementById('cv-panel-h').tagName, order };
    });
    assert.deepEqual(g, { readonly: 'true', selected: ['cv-3-2'], unsaid: 0, heading: 'H3', order: ['Rule checks', 'AI review', 'lenses', 'Open here', 'Tell your AI'] });
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('review: the wall names its Width, Who and State groups on screen; Screen detail\'s sibling links are a list, 44 px each; one width caption under compare; Esc back from a finding lands on its link', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  try {
    await go(page, '#/screens', '#h-screens');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.wall-filters [role=group]')].map(g => { const l = document.getElementById(g.getAttribute('aria-labelledby') || ''); return l && l.getClientRects().length ? l.textContent : null; })),
      ['Width', 'Who', 'State', 'Show'], 'each group named by the words beside it');
    await go(page, '#/screens/0004/cart.signed-in.normal.d', '#h-screen');
    const sibs = await page.evaluate(() => { const d = document.getElementById('sd-sibs'); d.open = true; return [...d.querySelectorAll('ul.sd-sibs-list > li > a')].map(a => Math.round(a.getBoundingClientRect().height)); });
    assert.ok(sibs.length > 5 && sibs.every(hgt => hgt >= 44), `sibling links: ${sibs.join(', ')} px`);
    // both widths, compared with the last full check (unchanged there): each width captioned once
    await page.keyboard.press('b');
    await page.click('#sd-cmp-run');
    await page.waitForFunction(() => document.querySelector('.sd-figs')?.textContent.includes('Unchanged since run 0003'));
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.sd-cap')].map(c => c.textContent)), ['Desktop', 'Phone']);
    await page.click('#sd-cmp-off');
    // a finding opened from here, then Esc: back on its link
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    await page.keyboard.press('2');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#h-detail');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => location.hash === '#/screens/0004/~.guest.normal.d' && document.getElementById('h-screen'));
    assert.equal(await focused(page), 'sd-f-2');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('review: Progress counts the AI cells as Coverage does when the AI reviewed an older run, and says which run', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false, ai: 'older' });
  const s = await open(p);
  const { page } = s;
  try {
    const line = await page.evaluate(() => document.getElementById('progress-cov')?.closest('li')?.textContent);
    assert.equal(line, 'AI looked at 232 of 264 cells on checked screens · AI review: run 0003 (not this run) · Coverage ▸');
    await go(page, '#/coverage', '#h-map');
    assert.match(await page.evaluate(() => document.querySelector('.cv-totals').textContent), /AI looked at232 of 264 cells on checked screens/);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
