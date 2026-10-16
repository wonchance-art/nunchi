// The capture bar in a real browser (the owner's text mock-up, 2026-10-16 KST, approved as recommended: a running
// capture impossible to miss): at the top of every view — "◐ Full check running · 33 of 72 screens · about 16 min
// left", a meter "46%" and "You can keep deciding; findings update as screens land." —, the tab's title "46% · nunchi
// board", the Now lines not said twice; "✓ Full check done · … [Review findings →]" until this tab looked at the
// findings (per tab, and right without storage); "! Capture stopped · …"; announced when a capture starts, finishes or
// stops, never route by route; a status region, a progressbar with its values and name, 4.5:1 text and 3:1 meter (fill,
// edge) light and dark, forced colours, no motion, 390 px and 200% zoom without sideways scroll, axe clean, the focus
// never taken. Every measurement is one page.evaluate (a live redraw detaches handles). Invented content only (Leafy).
// Needs Chromium (NUNCHI_BROWSER or `nunchi setup`): skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
// NUNCHI_BAR_SHOTS=<dir> saves the screenshots the PR shows there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import { leafy, leafyScenes } from './fixtures/coverage-project.mjs';
import { writeRun } from './fixtures/board-project.mjs';
import { thisMachine } from '../src/stable.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });

const open = (p, ctx = {}, opts = {}) => openBoard(browser, p, { ctx: { viewport: { width: 1440, height: 900 }, ...ctx }, ...opts });
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}
// To a view, and wait for its `ready` element drawn for this address (never the one before it)
const go = async (page, hash, ready) => {
  const moved = await page.evaluate(h => { if (location.hash === h) return false; for (const n of document.querySelector('main')?.children || []) if (n.id !== 'runbar') n.setAttribute('data-was', '1'); location.hash = h; return true; }, hash);
  await page.waitForFunction(([r, moved]) => { const el = document.querySelector(r); return !!el && (!moved || !el.closest('[data-was]')); }, [ready, moved]);
};
const shot = async (page, name) => {
  const dir = process.env.NUNCHI_BAR_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};
const listen = page => page.evaluate(() => { window.__said = []; new MutationObserver(() => { const x = document.getElementById('announce').textContent; if (x) window.__said.push(x); }).observe(document.getElementById('announce'), { childList: true, characterData: true, subtree: true }); });

// The bar as the page shows it, measured in one evaluation: where it is (main's first child, above the view's heading),
// its role and liveness, its words, the meter's values and name, the button, the Now lines left on Progress, the title,
// the contrast of its words (on the bar) and of the meter (fill on the track, edge on the track and on the bar),
// motion, forced colours, sideways scroll.
const bar = page => page.evaluate(() => {
  const rgb = c => (String(c).match(/[\d.]+/g) || []).map(Number);
  const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (([x, y]) => (x + 0.05) / (y + 0.05))([lum(a), lum(b)].sort((m, n) => n - m));
  const el = document.getElementById('runbar'), cs = e => getComputedStyle(e);
  const shown = !!el && !el.hidden && el.getClientRects().length > 0;
  const m = document.getElementById('runbar-meter'), btn = document.getElementById('runbar-review');
  const heading = document.querySelector('main h1');
  const ground = el ? cs(el).backgroundColor : null;
  const texts = shown ? [...el.querySelectorAll('.runbar-mark, .runbar-text, .runbar-pct, .runbar-note')].map(e => ratio(cs(e).color, ground)) : [];
  const parts = shown ? [el, ...el.querySelectorAll('*')] : [];
  return {
    shown, first: document.querySelector('main')?.firstElementChild === el, above: shown && heading ? el.getBoundingClientRect().bottom <= heading.getBoundingClientRect().top : null,
    role: el?.getAttribute('role'), live: el?.getAttribute('aria-live'), state: el?.className,
    mark: shown ? el.querySelector('.runbar-mark')?.textContent : null, markHidden: el?.querySelector('.runbar-mark')?.getAttribute('aria-hidden') ?? null,
    text: shown ? el.querySelector('.runbar-text')?.textContent : null, pct: el?.querySelector('.runbar-pct')?.textContent ?? null, note: el?.querySelector('.runbar-note')?.textContent ?? null,
    meter: m ? { role: m.getAttribute('role'), min: m.getAttribute('aria-valuemin'), max: m.getAttribute('aria-valuemax'), now: m.getAttribute('aria-valuenow'), text: m.getAttribute('aria-valuetext'), name: m.getAttribute('aria-label'),
      width: Math.round((m.firstElementChild.getBoundingClientRect().width / m.getBoundingClientRect().width) * 100),
      fill: ratio(cs(m.firstElementChild).backgroundColor, cs(m).backgroundColor), edgeTrack: ratio(cs(m).borderTopColor, cs(m).backgroundColor), edgeBar: ratio(cs(m).borderTopColor, ground),
      edge: `${cs(m).borderTopStyle} ${cs(m).borderTopWidth}`, fillColor: cs(m.firstElementChild).backgroundColor, trackColor: cs(m).backgroundColor } : null,
    button: btn ? { tag: btn.tagName, href: btn.getAttribute('href'), text: btn.textContent, h: Math.round(btn.getBoundingClientRect().height), w: Math.round(btn.getBoundingClientRect().width), on: ratio(cs(btn).color, cs(btn).backgroundColor), edge: ratio(cs(btn).backgroundColor, ground) } : null,
    least: texts.length ? Math.min(...texts) : null,
    barEdge: el ? `${cs(el).borderTopStyle} ${cs(el).borderTopWidth}` : null,
    motion: parts.filter(e => cs(e).animationName !== 'none' || cs(e).transitionDuration.split(',').some(t => parseFloat(t) > 0)).length,
    now: [...document.querySelectorAll('.now li')].map(l => l.textContent), title: document.title,
    forced: matchMedia('(forced-colors: active)').matches, sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
    focus: document.activeElement === document.body ? 'body' : document.activeElement?.id || document.activeElement?.tagName,
  };
});

// Leafy (four full checks, then a first look, run 0005) with the full check after the first look being captured: run
// 0006, its writer this process (`elsewhere`: another machine's, which only its file's time speaks for)
const progressDoc = (done, { routes = 72, ms = 24000, elsewhere = false, kind = 'sweep', pid = process.pid } = {}) =>
  ({ schema: 1, kind, wholeApp: true, routes, done, routeMs: Array(done).fill(ms), pid, ...thisMachine(), ...(elsewhere ? { host: 'another-machine.invalid' } : {}) });
function capturing(p, id, doc, at = Date.now()) {
  const dir = join(p.nunchi, 'runs', `${id}.partial`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'progress.json'), JSON.stringify(doc));
  utimesSync(join(dir, 'progress.json'), new Date(at), new Date(at));
  return dir;
}
// the full check lands: run `id`, after the first look, with one group the first look did not show
function landed(p, id = '0006') {
  rmSync(join(p.nunchi, 'runs', `${id}.partial`), { recursive: true, force: true });
  const scenes = leafyScenes();
  const help = scenes.find(s => s.id === 'help.guest.normal.d');
  writeRun(p.root, id, { scenes, parent: '0005', findings: [{ lens: 'L1', rule: 'clipped-text', severity: 'medium', scene: help.id, route: '/help', viewport: 'd', selector: 'main h2', box: null, evidence: { text: 'Opening hours' } }] });
}
const RUNNING = 'Full check running · 33 of 72 screens · about 16 min left';
const NOTE = 'You can keep deciding; findings update as screens land.';

test('bar e2e: a full check running — at the top of every view, the owner\'s words and a meter, the tab\'s title, its Now line not said twice; axe light 1440 and dark 390, contrast, no sideways scroll', { timeout: 180000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  capturing(p, '0006', progressDoc(33));
  const s = await open(p);
  const { page } = s;
  try {
    let b = await bar(page);
    assert.deepEqual([b.shown, b.first, b.above, b.role, b.live, b.state, b.mark, b.markHidden, b.text, b.pct, b.note], [true, true, true, 'status', 'off', 'runbar runbar-running', '◐', 'true', RUNNING, '46%', NOTE]);
    assert.deepEqual(b.meter && [b.meter.role, b.meter.min, b.meter.max, b.meter.now, b.meter.text, b.meter.name, b.meter.width], ['progressbar', '0', '72', '33', '33 of 72 screens, 46%', 'How far the full check is', 46]);
    assert.equal(b.title, '46% · nunchi board');
    // the first look's line is the bar's now: Progress lists no capture line again
    assert.deepEqual(b.now, []);
    assert.ok(b.least >= 4.5 && b.meter.fill >= 3 && b.meter.edgeTrack >= 3 && b.meter.edgeBar >= 3, `light: text ${b.least.toFixed(2)}, fill ${b.meter.fill.toFixed(2)}, edge ${b.meter.edgeTrack.toFixed(2)} / ${b.meter.edgeBar.toFixed(2)}`);
    assert.deepEqual([b.motion, b.sideways, b.button], [0, false, null]);
    assert.deepEqual(await axe(page), [], 'light 1440, Progress');
    // every view: the same bar first in main, above the view's heading
    await go(page, '#/findings', '#h-findings');
    const group = await page.evaluate(() => document.querySelector('.row[data-id]')?.getAttribute('data-id'));
    for (const [hash, ready] of [['#/findings', '#h-findings'], [`#/finding/${group}`, '#h-detail'], ['#/screens', '#h-screens'], [`#/screens/0005/${encodeURIComponent('~.guest.normal.d')}`, '#h-screen'], ['#/coverage', '#h-coverage']]) {
      await go(page, hash, ready);
      b = await bar(page);
      assert.deepEqual([hash, b.shown, b.first, b.above, b.text, b.pct, b.title], [hash, true, true, true, RUNNING, '46%', '46% · nunchi board']);
    }
    // Coverage and the wall say the first look in its own words: the bar has the capture, once
    assert.equal(await page.evaluate(() => [document.getElementById('cv-first-look')?.textContent, document.getElementById('cv-capture')?.textContent ?? null].join('|')), 'First look: 3 key screens, rule checks only · the full check isn’t done yet|');
    await go(page, '#/screens', '#h-screens');
    assert.equal(await page.evaluate(() => document.getElementById('wall-first-look')?.textContent), 'First look: 3 key screens, rule checks only · the full check isn’t done yet');
    await go(page, '#/findings', '#h-findings');
    assert.deepEqual(await axe(page), [], 'light 1440, Findings');
    await shot(page, 'running-light-1440-findings');
    // a route lands while a row has the focus: the bar says it in place, and the focus stays on the row
    await page.focus('.row[data-id]');
    const row = await page.evaluate(() => document.activeElement.id);
    capturing(p, '0006', progressDoc(36));
    await page.waitForFunction(() => document.querySelector('#runbar .runbar-text')?.textContent.startsWith('Full check running · 36 of 72'), null, { timeout: 15000 });
    b = await bar(page);
    assert.deepEqual([b.text, b.pct, b.title, b.focus], ['Full check running · 36 of 72 screens · about 15 min left', '50%', '50% · nunchi board', row]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  capturing(p, '0006', progressDoc(33));
  // dark, 390 px: the same bar, axe clean, contrast, nothing sideways
  const d = await open(p, { colorScheme: 'dark', viewport: { width: 390, height: 844 } });
  try {
    const b = await bar(d.page);
    assert.deepEqual([b.shown, b.first, b.text, b.pct, b.note, b.sideways], [true, true, RUNNING, '46%', NOTE, false]);
    assert.ok(b.least >= 4.5 && b.meter.fill >= 3 && b.meter.edgeTrack >= 3 && b.meter.edgeBar >= 3, `dark: text ${b.least.toFixed(2)}, fill ${b.meter.fill.toFixed(2)}, edge ${b.meter.edgeTrack.toFixed(2)} / ${b.meter.edgeBar.toFixed(2)}`);
    assert.deepEqual(await axe(d.page), [], 'dark 390, Progress');
    await shot(d.page, 'running-dark-390-progress');
    await go(d.page, '#/findings', '#h-findings');
    assert.deepEqual([(await bar(d.page)).sideways, await axe(d.page)], [false, []], 'dark 390, Findings');
    assert.deepEqual(d.errors, []);
  } finally { await d.close(); }
  // 200% zoom of a 1280 × 800 window: 640 × 400 CSS pixels
  const z = await open(p, { viewport: { width: 640, height: 400 } });
  try {
    for (const [hash, ready] of [['#/progress', '#h-progress'], ['#/findings', '#h-findings'], ['#/coverage', '#h-coverage']]) {
      await go(z.page, hash, ready);
      const b = await bar(z.page);
      assert.deepEqual([hash, b.shown, b.text, b.sideways], [hash, true, RUNNING, false]);
    }
  } finally { await z.close(); }
});

test('bar e2e: live — before the first route no percentage and no time; another capture (a first look, a partial run) has M5b\'s words and the same meter; no capture, no bar', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  capturing(p, '0006', progressDoc(0));
  const s = await open(p);
  const { page } = s;
  try {
    let b = await bar(page);
    assert.deepEqual([b.shown, b.text, b.pct, b.note, b.title], [true, 'Full check running · 0 of 72 screens', null, NOTE, 'nunchi board']);
    assert.deepEqual(b.meter && [b.meter.now, b.meter.max, b.meter.text, b.meter.width], ['0', '72', '0 of 72 screens', 0]);
    // the first route lands: the bar says how far, by the board's version alone (no ledger write)
    capturing(p, '0006', progressDoc(1));
    await page.waitForFunction(() => document.getElementById('runbar-meter')?.getAttribute('aria-valuenow') === '1', null, { timeout: 15000 });
    b = await bar(page);
    assert.deepEqual([b.text, b.pct, b.title], ['Full check running · 1 of 72 screens · about 29 min left', '1%', '1% · nunchi board']);
    // nothing runs: no bar; the first look's own line in the Now list (the full check has not started)
    rmSync(join(p.nunchi, 'runs', '0006.partial'), { recursive: true });
    await page.waitForFunction(() => document.getElementById('runbar')?.hidden === true, null, { timeout: 15000 });
    b = await bar(page);
    assert.deepEqual([b.shown, b.title, b.now], [false, 'nunchi board', ['First look: 3 key screens · the full check has not started — tell your AI “full check”']]);
    // another first look running: M5b's line, the same meter, its own name
    capturing(p, '0006', progressDoc(12, { routes: 25, ms: 27000, kind: 'quick' }));
    await page.waitForFunction(() => !document.getElementById('runbar')?.hidden, null, { timeout: 15000 });
    b = await bar(page);
    assert.deepEqual([b.text, b.pct, b.title, b.note, b.now], ['Capture running · run 0006 · 12 of 25 screens (about 6 min left)', '48%', '48% · nunchi board', NOTE, []]);
    assert.deepEqual(b.meter && [b.meter.now, b.meter.max, b.meter.text, b.meter.name], ['12', '25', '12 of 25 screens, 48%', 'How far run 0006 is']);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  // a partial run with no first look before it (Leafy's full checks only): M5b's words in the bar too; Coverage keeps
  // only what it adds
  const q = leafy({ probes: false });
  capturing(q, '0005', { ...progressDoc(12, { routes: 25, ms: 27000 }), wholeApp: false, routesGiven: true });
  const s2 = await open(q);
  try {
    let b = await bar(s2.page);
    assert.deepEqual([b.text, b.pct, b.now], ['Capture running · run 0005 · 12 of 25 screens (about 6 min left)', '48%', []]);
    await go(s2.page, '#/coverage', '#h-coverage');
    assert.equal(await s2.page.evaluate(() => document.getElementById('cv-capture')?.textContent), 'This shows run 0004 until it finishes.');
    // no capture at all: no bar, and the title as it was
    rmSync(join(q.nunchi, 'runs', '0005.partial'), { recursive: true });
    await s2.page.waitForFunction(() => document.getElementById('runbar')?.hidden === true && !document.getElementById('cv-capture'), null, { timeout: 15000 });
    b = await bar(s2.page);
    assert.deepEqual([b.shown, b.first, b.title], [false, true, 'nunchi board']);
    assert.deepEqual(s2.errors, []);
  } finally { await s2.close(); }
});

test('bar e2e: the full check done stays until this tab has looked at the findings — [Review findings →] (a link, 44 px) or Findings opened; per tab, and right without storage', { timeout: 150000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  landed(p);
  const DONE = 'Full check done · 7 screens · 1 new group';
  const s = await open(p);
  const { page } = s;
  try {
    let b = await bar(page);
    assert.deepEqual([b.shown, b.first, b.state, b.mark, b.text, b.meter, b.note, b.pct, b.title], [true, true, 'runbar runbar-done', '✓', DONE, null, null, null, 'nunchi board']);
    assert.deepEqual(b.button && [b.button.tag, b.button.href, b.button.text], ['A', '#/findings', 'Review findings →']);
    assert.ok(b.button.h >= 44 && b.button.w >= 44, `${b.button.w} × ${b.button.h}`);
    assert.ok(b.least >= 4.5 && b.button.on >= 4.5 && b.button.edge >= 3, `light: text ${b.least.toFixed(2)}, button ${b.button.on.toFixed(2)} / ${b.button.edge.toFixed(2)}`);
    // its line is the bar's: Progress does not list it again
    assert.deepEqual(b.now, []);
    assert.deepEqual(await axe(page), [], 'light 1440, done');
    await shot(page, 'done-light-1440-progress');
    // other views keep it (looking at Screens or Coverage is not looking at the findings)
    await go(page, '#/coverage', '#h-coverage');
    assert.equal((await bar(page)).text, DONE);
    // the button, by keyboard: Findings, the bar gone in this tab, the focus on the first row (never the page)
    await page.focus('#runbar-review');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.getElementById('runbar')?.hidden === true);
    b = await bar(page);
    assert.deepEqual([b.shown, b.focus.startsWith('row-')], [false, true]);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('nunchi.looked.0006')), '1');
    // back on Progress: no bar, and the line in the Now list again
    await go(page, '#/progress', '#h-progress');
    b = await bar(page);
    assert.deepEqual([b.shown, b.now], [false, [DONE]]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
  // another tab has not looked: the bar again; opening Findings from the sidebar is looking too
  const s2 = await open(p, { colorScheme: 'dark', viewport: { width: 390, height: 844 } });
  try {
    let b = await bar(s2.page);
    assert.deepEqual([b.text, b.sideways], [DONE, false]);
    assert.ok(b.least >= 4.5 && b.button.on >= 4.5 && b.button.edge >= 3, `dark: text ${b.least.toFixed(2)}, button ${b.button.on.toFixed(2)} / ${b.button.edge.toFixed(2)}`);
    assert.deepEqual(await axe(s2.page), [], 'dark 390, done');
    await s2.page.click('a[data-nav=findings]');
    await s2.page.waitForSelector('#h-findings');
    b = await bar(s2.page);
    assert.equal(b.shown, false);
  } finally { await s2.close(); }
  // a tab whose storage refuses every access: the bar is drawn and goes the same (this page's memory)
  const s3 = await open(p, {}, { setup: ({ page }) => page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); }) });
  try {
    assert.equal((await bar(s3.page)).text, DONE);
    await go(s3.page, '#/findings', '#h-findings');
    await go(s3.page, '#/progress', '#h-progress');
    assert.deepEqual([(await bar(s3.page)).shown, (await bar(s3.page)).now], [false, [DONE]]);
    assert.deepEqual(s3.errors, []);
  } finally { await s3.close(); }
});

test('bar e2e: said when the capture starts, finishes and stops — never route by route; a stop reaches the open board by the clock alone (dark 1440)', { timeout: 150000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  const s = await open(p, { colorScheme: 'dark' });
  const { page } = s;
  try {
    await page.waitForTimeout(400);
    await listen(page);
    // it starts (another machine's writer: its file's time speaks for it)
    capturing(p, '0006', progressDoc(1, { elsewhere: true }));
    await page.waitForFunction(() => window.__said.some(x => x.includes('Full check running · 1 of 72 screens')), null, { timeout: 25000 });
    // routes land: the bar changes in place, nothing is said (past the announcer's 10 s)
    for (const n of [2, 3, 4]) { capturing(p, '0006', progressDoc(n, { elsewhere: true })); await page.waitForFunction(n => document.getElementById('runbar-meter')?.getAttribute('aria-valuenow') === String(n), n, { timeout: 15000 }); }
    await page.waitForTimeout(11000);
    assert.deepEqual(await page.evaluate(() => window.__said.filter(x => /of 72 screens/.test(x) && !x.includes('1 of 72'))), [], 'no route is said');
    // nothing written for 10 minutes: stopped by the clock alone, and said
    capturing(p, '0006', progressDoc(4, { elsewhere: true }), Date.now() - 10 * 60e3 - 1000);
    const STOPPED = 'Capture stopped · run 0006 (no progress for 10 min) — tell your AI “capture again”';
    await page.waitForFunction(t => window.__said.some(x => x.includes(t)), STOPPED, { timeout: 30000 });
    let b = await bar(page);
    assert.deepEqual([b.state, b.mark, b.text, b.meter, b.note, b.title, b.now], ['runbar runbar-stopped', '!', STOPPED, null, null, 'nunchi board', []]);
    assert.ok(b.least >= 4.5, `dark: ${b.least.toFixed(2)}`);
    assert.deepEqual(await axe(page), [], 'dark 1440, stopped');
    await shot(page, 'stopped-dark-1440-progress');
    // capture again, and it lands: "Full check done" is said
    landed(p);
    await page.waitForFunction(() => window.__said.some(x => x.includes('Full check done · 7 screens · 1 new group')), null, { timeout: 30000 });
    b = await bar(page);
    assert.deepEqual([b.state, b.text], ['runbar runbar-done', 'Full check done · 7 screens · 1 new group']);
    assert.ok(b.least >= 4.5, `dark done: ${b.least.toFixed(2)}`);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('bar e2e: forced colours keep the bar\'s edge and the meter (track, edge, fill); a capture whose writer is gone says "its process ended"', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ quick: true, probes: false });
  capturing(p, '0006', progressDoc(33));
  const s = await open(p, { forcedColors: 'active' });
  try {
    const b = await bar(s.page);
    assert.deepEqual([b.forced, b.text, b.barEdge, b.meter.edge], [true, RUNNING, 'solid 1px', 'solid 1px']);
    assert.notEqual(b.meter.fillColor, b.meter.trackColor, 'the fill shows on the track');
    assert.ok(b.meter.fill >= 3, `forced: fill ${b.meter.fill.toFixed(2)}`);
  } finally { await s.close(); }
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  capturing(p, '0006', progressDoc(33, { pid: dead }));
  const s2 = await open(p);
  try {
    const b = await bar(s2.page);
    assert.deepEqual([b.state, b.text], ['runbar runbar-stopped', 'Capture stopped · run 0006 (its process ended) — tell your AI “capture again”']);
  } finally { await s2.close(); }
});
