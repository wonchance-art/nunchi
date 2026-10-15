// The Coverage view in a real browser (M7; the mock-up the owner approved on 2026-10-15 KST, §3): what wasn't checked
// and what to say, [Show on map], the map as a grid with one tab stop (arrows, Home/End, Ctrl+Home/End, J/K to gaps,
// Enter for the cell's panel, Esc back to the cell), the list below 760 px, the Progress links (D2), axe, 44 px targets,
// no sideways scroll. Every measurement is one page.evaluate (a live redraw detaches handles). Needs Chromium
// (NUNCHI_BROWSER or `nunchi setup`): skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { stableJson } from '../src/stable.mjs';
import { leafy, coverageOf, leafyScenes } from './fixtures/coverage-project.mjs';

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctx });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => requests.push(r.url()));
  await page.goto(b.newLink());
  await page.waitForSelector('#h-progress');
  return { b, page, errors, requests, close: async () => { await context.close(); await b.close(); } };
}
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 100)); } };
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}
// every control 44 px high (buttons as wide), no sideways scroll: one evaluation
const layout = page => page.evaluate(() => ({
  small: [...document.querySelectorAll('main button, main select, main input, main a.b, main summary, main [role=gridcell], nav .nav a')].filter(e => e.offsetParent !== null)
    .map(e => ({ e: e.outerHTML.slice(0, 70), r: e.getBoundingClientRect() })).filter(x => x.r.height < 43.5 || (x.e.startsWith('<button') && x.r.width < 43.5)).map(x => `${x.e} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`),
  sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
}));
const focused = page => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || a.tagName; });

test('coverage e2e: the view at 1280 px — totals, what to do, Copy named by its sentence, [Show on map] focuses the first cell; Progress links here (D2)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  const s = await open(p);
  const { page } = s;
  try {
    // Progress: "Screens checked" goes to Coverage, and the AI line counts cells on checked screens
    const prog = await page.evaluate(() => ({ href: document.querySelector('.meter-row a').getAttribute('href'), text: document.querySelector('#progress').textContent }));
    assert.equal(prog.href, '#/coverage');
    assert.match(prog.text, /AI looked at 232 of 264 cells on checked screens · Coverage ▸/);
    assert.ok(!/cells seen/.test(prog.text), 'not the record\'s own count any more');
    await page.click('a[data-nav=coverage]');
    await page.waitForSelector('#h-map');
    const v = await page.evaluate(() => ({
      nav: document.querySelector('a[data-nav=coverage]').getAttribute('aria-current'), focus: document.activeElement?.id,
      sub: document.querySelector('#coverage .muted').textContent, totals: document.querySelector('.cv-totals').textContent,
      h2: [...document.querySelectorAll('#coverage h2')].map(x => x.textContent),
      gaps: [...document.querySelectorAll('.cv-gaps > .cv-gap-list:first-of-type > li')].map(li => li.querySelector('.cv-gap-line b').textContent),
      copy: [...document.querySelectorAll('.cv-gaps button[id^=gap-copy]')].map(b => b.getAttribute('aria-label')),
      grid: (() => { const g = document.querySelector('[role=grid]'); return { rows: g.getAttribute('aria-rowcount'), cols: g.getAttribute('aria-colcount'), stops: g.querySelectorAll('[tabindex="0"]').length, rowheaders: g.querySelectorAll('th[scope=row]').length }; })(),
      cell: document.querySelector('#cv-3-2').getAttribute('aria-label'), marks: [...document.querySelectorAll('#cv-3-2 .cv-mk')].map(m => m.getAttribute('aria-hidden')),
    }));
    assert.deepEqual([v.nav, v.focus], ['page', 'h-coverage']);
    assert.equal(v.sub, 'What nunchi looked at in run 0004 (full check), and what it didn’t');
    assert.match(v.totals, /Screens checked62 of 686 not checkedAI looked at232 of 264 cells on checked screens32 notPages opened7 of 8Whole-app checksRan over the whole app/);
    assert.deepEqual(v.h2, ['What wasn’t checked, and what to do6', 'Map', 'By lens']);
    assert.deepEqual(v.gaps, ['2 screens didn’t load', '20 AI cells don’t count: the AI missed a test defect nunchi planted', '10 AI cells not checked: AI budget ran out', '2 AI cells not answered',
      '1 page not opened: profile/edit — nunchi couldn’t work out its address from the code', '1 open finding can’t be marked fixed: not looked at since run 0001']);
    assert.deepEqual(v.copy, ['Copy “capture again”', 'Copy “hunt L6 on /cart again”', 'Copy “review what the AI budget skipped”', 'Copy “finish the AI review”', 'Copy “capture profile/edit too”']);
    assert.deepEqual(v.grid, { rows: '9', cols: '6', stops: 1, rowheaders: 8 }, 'a grid with one tab stop; the header row and 8 pages; page + 4 person·width columns + other states');
    assert.equal(v.cell, '/cart, Signed in, Desktop, Normal: partly. AI 6 of 7. L6 doesn’t count: the AI missed a test defect nunchi planted.');
    assert.deepEqual(v.marks, ['true'], 'the mark is hidden from assistive technology; the words say it');
    // [Show on map] on the budget row: Checks L4, gaps only, the focus on the first cell it names
    await page.click('#gap-show-budget-0');
    const shown = await until(async () => { const a = await page.evaluate(() => document.querySelector('#announce').textContent); return /Showing/.test(a) && a; });
    assert.equal(shown, 'Showing 5 pages with gaps');
    const after = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute('aria-label'), checks: document.getElementById('cv-checks').value, gaps: document.getElementById('cv-show-gaps').getAttribute('aria-pressed'),
      rows: [...document.querySelectorAll('[role=grid] th[scope=row] .mono')].map(x => x.textContent) }));
    assert.equal(after.focus, '/garden, Visitor, Desktop, Normal: not checked: AI budget ran out.');
    assert.deepEqual([after.checks, after.gaps], ['L4', 'true']);
    assert.deepEqual(after.rows, ['/garden', '/checkout', '/help', '/login', 'profile/edit'], 'pages with a gap for L4: cut by the budget, sent elsewhere, not opened');
    // "More views in 0.2" no longer offers the Coverage map
    await page.click('#more-views');
    await page.waitForSelector('dialog[open]');
    assert.ok(!/Coverage/.test(await page.textContent('dialog')));
    await page.keyboard.press('Escape');
    assert.deepEqual(s.errors, []);
    for (const u of s.requests) assert.ok(u.startsWith(s.b.origin + '/') || u.startsWith('blob:'), u);
  } finally { await s.close(); }
});

test('coverage e2e: the grid\'s keys — arrows, Home/End, Ctrl+Home/End, J/K to the next gap, Enter opens the cell\'s panel (focus on its heading), Esc back to the cell', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  const s = await open(p, { viewport: { width: 1440, height: 900 } });
  const { page } = s;
  try {
    await page.evaluate(() => { location.hash = '#/coverage'; });
    await page.waitForSelector('#h-map');
    await page.focus('#cv-0-0');
    const at = () => focused(page);
    await page.keyboard.press('ArrowRight'); assert.equal(await at(), 'cv-0-1');
    await page.keyboard.press('ArrowDown'); assert.equal(await at(), 'cv-1-1');
    await page.keyboard.press('End'); assert.equal(await at(), 'cv-1-4', 'the row\'s last cell (other states)');
    await page.keyboard.press('Home'); assert.equal(await at(), 'cv-1-0');
    await page.keyboard.press('Control+End'); assert.equal(await at(), 'cv-7-0', 'the grid\'s last cell: the page that was not opened');
    await page.keyboard.press('Control+Home'); assert.equal(await at(), 'cv-0-0');
    // J: the next cell with a gap (anything but ● and ·): /garden's cells are partly
    await page.keyboard.press('j'); assert.equal(await at(), 'cv-1-0');
    await page.keyboard.press('k');
    assert.equal(await until(async () => (await page.textContent('#announce')) === 'This is the first cell with a gap' && 'ok'), 'ok');
    const tabStops = await page.evaluate(() => document.querySelectorAll('[role=grid] [tabindex="0"]').length);
    assert.equal(tabStops, 1, 'one tab stop (roving focus)');
    // Enter: the panel, the focus on its heading; the cell's lenses in words; Esc: back to the cell
    await page.focus('#cv-3-2');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#cv-panel-h');
    const panel = await page.evaluate(() => ({ focus: document.activeElement?.id, hash: location.hash, text: document.querySelector('.cv-panel').textContent, side: (() => { const g = document.querySelector('.cv-grid').getBoundingClientRect(), q = document.querySelector('.cv-panel').getBoundingClientRect(); return q.left >= g.right - 1; })() }));
    assert.equal(panel.focus, 'cv-panel-h');
    assert.equal(panel.hash, '#/coverage/0004/cart.signed-in.normal.d');
    assert.ok(panel.side, 'right of the map at 1280 px and wider, one state shown');
    for (const want of ['/cart · Signed in · Desktop · Normal', 'Rule checksRan in run 0004', 'AI review6 of 7 lenses looked', 'L5 Copy consistencyLooked · 1 finding',
      'L6 Copy qualityDoesn’t count: the AI missed a test defect nunchi planted on /cart', 'L7 Vibe-coding leftoversLooked · couldn’t judge 1 question', 'Tell your AI“hunt L6 on /cart again”', 'Open this screen']) assert.ok(panel.text.includes(want), want);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('cv-panel-h'));
    assert.equal(await at(), 'cv-3-2', 'Esc closes the panel and gives the focus back to the cell');
    assert.equal(await page.evaluate(() => location.hash), '#/coverage');
    // a link from elsewhere opens the cell (Finding detail and Screen detail link here)
    await page.evaluate(() => { location.hash = '#/coverage/0004/checkout.guest.normal.d'; });
    await page.waitForSelector('#cv-panel-h');
    assert.match(await page.textContent('.cv-panel'), /Not checked: sent to \/login\. The screen is judged as \/login, in its own row\./);
    // the Checks menu: one AI lens, then the rule checks only
    await page.keyboard.press('Escape');
    await page.selectOption('#cv-checks', 'L4');
    assert.equal(await page.evaluate(() => document.getElementById('cv-1-0').textContent.trim()), '✕ Not checked: AI budget ran out');
    assert.equal(await page.evaluate(() => document.getElementById('cv-0-0').textContent.trim()), '● Looked');
    await page.selectOption('#cv-checks', 'rules');
    assert.equal(await page.evaluate(() => document.getElementById('cv-0-0').textContent.trim()), '✓ Checked');
    // State All: the panel goes below the map, one block per state
    await page.selectOption('#cv-checks', 'all');
    await page.click('#cv-st-all');
    await page.focus('#cv-3-2');
    await page.keyboard.press(' ');
    await page.waitForSelector('#cv-panel-h');
    const all = await page.evaluate(() => ({ blocks: document.querySelectorAll('.cv-pscene').length, below: document.querySelector('.cv-panel').getBoundingClientRect().top >= document.querySelector('.cv-grid').getBoundingClientRect().bottom - 1, cell: document.getElementById('cv-3-2').textContent.trim() }));
    assert.deepEqual([all.blocks, all.below], [5, true]);
    assert.equal(all.cell, '◐ 5', 'counted by mark');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('coverage a11y: axe finds nothing (light 1280, dark 390, dark 1440, 200% zoom as 640 × 450 at 2×), 44 px targets, no sideways scroll; the list below 760 px (a phone, 200% zoom) with the panel under its page', { timeout: 150000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  for (const [scheme, width, height, deviceScaleFactor] of [['light', 1280, 900, 1], ['dark', 390, 844, 1], ['dark', 1440, 900, 1], ['light', 640, 450, 2]]) {
    const s = await open(p, { colorScheme: scheme, viewport: { width, height }, deviceScaleFactor, reducedMotion: 'reduce' });
    const { page } = s;
    try {
      await page.evaluate(() => { location.hash = '#/coverage/0004/cart.signed-in.normal.d'; });
      await page.waitForSelector('#cv-panel-h');
      assert.deepEqual(await axe(page), [], `${scheme} ${width}px, a cell's panel open`);
      const l = await layout(page);
      assert.deepEqual(l.small, [], `${width}px: every control 44 px`);
      assert.equal(l.sideways, false, `${width}px: no sideways scroll`);
      if (width < 760) {
        const list = await page.evaluate(() => ({ grid: !!document.querySelector('[role=grid]'), pages: document.querySelectorAll('.cv-list > li > details').length, open: document.getElementById('cv-d-3').open,
          sum: document.querySelector('#cv-d-1 > summary').textContent, panelIn: !!document.querySelector('#cv-d-3 .cv-panel'), filters: [...document.querySelectorAll('.cv-filters select')].map(x => x.id),
          lens: document.getElementById('cv-lens-d').open, h2: document.getElementById('h-gaps').textContent }));
        assert.deepEqual([list.grid, list.pages, list.open, list.panelIn, list.lens], [false, 8, true, true, false], 'a list of pages; the cell\'s panel under its page; By lens collapsed');
        assert.match(list.sum, /^\/garden · Garden◐ 4 of 4$/, 'a page counts its four person·width cells by mark');
        assert.deepEqual(list.filters, ['cv-state', 'cv-show', 'cv-checks']);
        assert.equal(list.h2, 'What wasn’t checked (6)');
        await page.click('#cv-close');
        assert.equal(await until(async () => (await focused(page)) === 'cv-3-2' && 'ok'), 'ok', 'Close returns to the cell');
        assert.deepEqual(await axe(page), [], `${scheme} ${width}px, the list`);
      } else {
        await page.evaluate(() => { location.hash = '#/coverage'; });
        await page.waitForFunction(() => !document.getElementById('cv-panel-h'));
      }
      if (scheme === 'dark') assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(20, 21, 24)');
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});

test('coverage e2e: the view follows the live update — canaries --score voids a batch, the map redraws in place and the focus stays on its cell', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  try {
    await page.evaluate(() => { location.hash = '#/coverage'; });
    await page.waitForSelector('#h-map');
    await page.focus('#cv-1-0');
    assert.equal(await page.evaluate(() => document.getElementById('cv-1-0').textContent.trim()), '◐ 6 of 7');
    const cov = coverageOf('0004', leafyScenes());
    for (const x of cov.cells) if (x.lens === 'L1' && x.route === '/garden' && x.status === 'seen') { x.status = 'not-seen'; x.reason = 'canary-missed'; }
    const file = join(p.nunchi, 'runs', '0004', 'coverage.json');
    writeFileSync(file, stableJson(cov));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    await page.waitForFunction(() => document.getElementById('cv-1-0')?.textContent.trim() === '◐ 5 of 7', null, { timeout: 10000 });
    const now = await page.evaluate(() => ({ focus: document.activeElement?.id, gaps: document.querySelector('.cv-count').textContent }));
    assert.deepEqual(now, { focus: 'cv-1-0', gaps: '7' }, 'redrawn in place: the focus on its cell, a new gap row');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('coverage e2e: a quick first look (M5) — Coverage and the wall say "First look", the AI row has no sentence to tell, the map\'s cells are rules only; axe finds nothing', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  const s = await open(p);
  const { page } = s;
  try {
    await page.evaluate(() => { location.hash = '#/coverage'; });
    await page.waitForSelector('#h-map');
    const v = await page.evaluate(() => ({ banner: document.getElementById('cv-first-look')?.textContent, ai: document.querySelector('.cv-totals').textContent, copy: !!document.getElementById('cv-copy-ai'),
      cell: document.getElementById('cv-0-0').textContent.trim(), gaps: [...document.querySelectorAll('.cv-gaps .cv-gap-line b')].map(b => b.textContent) }));
    assert.equal(v.banner, 'First look: 3 key screens, rule checks only · the full check isn’t done yet');
    assert.match(v.ai, /AI looked atAI review hasn’t run on run 0005Pages opened3 of 8/);
    assert.equal(v.copy, false, 'no "run the AI review" to copy: the AI review hunts the full check');
    assert.equal(v.cell, '○ Rules only');
    assert.deepEqual(v.gaps, ['1 open finding can’t be marked fixed: not looked at since run 0001']);
    assert.deepEqual(await axe(page), [], 'a first look');
    await page.click('a[data-nav=screens]');
    await page.waitForSelector('#h-screens');
    assert.equal(await page.evaluate(() => document.getElementById('wall-first-look')?.textContent), 'First look: 3 key screens, rule checks only · the full check isn’t done yet');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
