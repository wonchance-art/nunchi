// Coverage and Screens in a real browser, for what axe does not measure (M7; the mock-up the owner approved on
// 2026-10-15 KST, §3.6, §4.5): the map's marks read as text (4.5:1 or more on the cell they sit on, a selected one
// included), and what is not text at 3:1 or more — the focus ring of a cell, a phone row, a card and a finding, the
// selected cell's bar, the meters, the markers on a screenshot and the list's numbers — in light and in dark; and the
// focus never falls to the page (filters, Copy, Show on map, a live redraw, Clear filters, moving between screens,
// a decision key pressed in Screens). Every measurement is one page.evaluate (a live redraw detaches handles). Needs
// Chromium (NUNCHI_BROWSER or `nunchi setup`): skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
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
const go = async (page, hash, ready) => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForSelector(ready); };
const focused = page => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || a.tagName; });
const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')); } catch { return []; } };

// The contrast of what `checks` name ([selector, kind, least ratio]), queried and measured in one evaluation. Kinds:
// `text` its colour on the background it sits on; `ring` its outline on its own background and on what is behind it
// (both are next to the ring); `bar` its box-shadow (an inset bar) on its own background; `edge` its border on its
// halo (a box-shadow ring), so a marker reads on any screenshot; `inset` its box-shadow edge on its own background and on
// what is behind it (a pressed segmented button: review of PR #35); `fill` its background on what is behind it; `shape`
// its fill or its halo on what is behind it, whichever shows the shape. → the misses, in words.
const contrast = (page, checks) => page.evaluate(checks => {
  const rgb = c => (String(c).match(/[\d.]+/g) || []).map(Number);
  const clear = c => c === 'transparent' || rgb(c)[3] === 0;
  const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (a && b ? (([x, y]) => (x + 0.05) / (y + 0.05))([lum(a), lum(b)].sort((m, n) => n - m)) : 0);
  const behind = e => { for (let n = e.parentElement; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!clear(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
  const own = e => { const c = getComputedStyle(e).backgroundColor; return clear(c) ? behind(e) : c; };
  const shadow = e => (/rgba?\([^)]*\)/.exec(getComputedStyle(e).boxShadow) || [])[0] || null;
  const out = [];
  for (const [sel, kind, min] of checks) {
    const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length);
    if (!els.length) { out.push(`${sel}: none shown`); continue; }
    for (const e of els) {
      const cs = getComputedStyle(e);
      const r = kind === 'text' ? ratio(cs.color, own(e))
        : kind === 'ring' ? Math.min(ratio(cs.outlineColor, own(e)), ratio(cs.outlineColor, behind(e)))
          : kind === 'bar' ? ratio(shadow(e), own(e))
            : kind === 'inset' ? Math.min(ratio(shadow(e), own(e)), ratio(shadow(e), behind(e)))
            : kind === 'edge' ? ratio(cs.borderTopColor, shadow(e))
              : kind === 'fill' ? ratio(cs.backgroundColor, behind(e))
                : Math.max(ratio(cs.backgroundColor, behind(e)), ratio(shadow(e), behind(e)));
      if (!(r >= min)) out.push(`${sel} (${kind}) ${e.outerHTML.slice(0, 60)}: ${r.toFixed(2)}:1`);
    }
  }
  return out;
}, checks);
const MARKS = '.cv-mk-full, .cv-mk-partly, .cv-mk-rules, .cv-mk-not, .cv-mk-none, .cv-mk-ok';

test('M7 a11y: contrast in light and dark — the map\'s marks as text (4.5:1), focus rings, the selected cell\'s bar, meters, markers and numbers (3:1)', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy();
  for (const scheme of ['light', 'dark']) {
    const s = await open(p, { colorScheme: scheme });
    const { page } = s;
    try {
      // Coverage, a cell selected: its marks on the selected background, the bar, the meters, the gaps' marks
      await go(page, '#/coverage/0004/cart.signed-in.normal.d', '#cv-panel-h');
      assert.deepEqual(await contrast(page, [[MARKS, 'text', 4.5], ['.cv-sel .cv-mk', 'text', 4.5], ['.cv-mark', 'text', 4.5], ['.cv-cell.cv-sel', 'bar', 3], ['.meter span', 'fill', 3]]), [], `${scheme}: Coverage`);
      // the focus ring on the selected cell, then on another (the arrow keys move it)
      await page.focus('#cv-3-2');
      assert.deepEqual(await contrast(page, [['.cv-cell:focus', 'ring', 3]]), [], `${scheme}: a selected cell's focus ring`);
      await page.keyboard.press('ArrowLeft');
      assert.deepEqual(await contrast(page, [['.cv-cell:focus', 'ring', 3], ['.seg-b button[aria-pressed=true]', 'text', 4.5], ['.seg-b button[aria-pressed=true]', 'inset', 3]]), [], `${scheme}: a cell's focus ring, the pressed buttons' edge`);
      // Screen detail, finding 2 focused by its key: the markers (the focused one too), their numbers, the list's numbers
      await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
      await page.keyboard.press('2');
      await page.waitForSelector('.sd-fig .box-on');
      assert.deepEqual(await contrast(page, [['.sd-fig .box', 'edge', 3], ['.sd-fig .num', 'text', 4.5], ['.sd-list .numb', 'shape', 3], ['.sd-f:focus-visible', 'ring', 3]]), [], `${scheme}: Screen detail`);
      // the toolbar's focus ring
      await page.focus('[role=toolbar] button[tabindex="0"]');
      await page.keyboard.press('ArrowRight');
      assert.deepEqual(await contrast(page, [['[role=toolbar] button:focus-visible', 'ring', 3], ['[role=toolbar] .seg-b button[aria-pressed=true]', 'inset', 3]]), [], `${scheme}: the toolbar`);
      // the wall: a card reached by J, its ring; the quick look's markers
      await go(page, '#/screens', '#h-screens');
      await page.keyboard.press('j');
      await page.waitForSelector('.card button:focus-visible');
      assert.deepEqual(await contrast(page, [['.card button:focus-visible', 'ring', 3]]), [], `${scheme}: a card`);
      await page.keyboard.press('Home');
      await page.keyboard.press(' ');
      await page.waitForSelector('#panel-h');
      assert.deepEqual(await contrast(page, [['.screen-panel .box', 'edge', 3], ['.screen-panel .num', 'text', 4.5]]), [], `${scheme}: the quick look`);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
    // the map as a list (a phone): a row's focus ring and its marks
    const m = await open(p, { colorScheme: scheme, viewport: { width: 390, height: 844 } });
    try {
      await go(m.page, '#/coverage', '#h-map');
      await m.page.focus('#cv-d-1 > summary');
      await m.page.keyboard.press('Enter');
      await m.page.keyboard.press('Tab');
      assert.equal(await focused(m.page), 'cv-1-0');
      assert.deepEqual(await contrast(m.page, [[MARKS, 'text', 4.5], ['.cv-line:focus-visible', 'ring', 3], ['.cv-line, .cv-page-d > summary', 'text', 4.5]]), [], `${scheme}: the phone list`);
      assert.deepEqual(m.errors, []);
    } finally { await m.close(); }
  }
});

test('M7 keys by their place on the keyboard (e.code): on a Korean layout J, K, B, V and C walk the map, the wall and Screen detail', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p);
  const { page } = s;
  // what a Korean (2-set) layout sends: the letter it types in `key`, the place in `code`
  const key = (code, k) => page.evaluate(([code, k]) => { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true })); }, [code, k]);
  try {
    await go(page, '#/coverage', '#h-map');
    await page.focus('#cv-0-0');
    await key('KeyJ', 'ㅓ');
    assert.equal(await focused(page), 'cv-1-0', 'ㅓ (J): the next cell with a gap');
    await key('KeyK', 'ㅏ');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'cv-1-0', 'ㅏ (K): no gap before it, the focus stays');
    await go(page, '#/screens', '#h-screens');
    await key('KeyJ', 'ㅓ');
    const second = await focused(page);
    await key('KeyK', 'ㅏ');
    const first = await focused(page);
    assert.match(second, /^card-/);
    assert.ok(first !== second && /^card-/.test(first), 'ㅓ and ㅏ walk the cards');
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    await key('KeyB', 'ㅠ');
    await page.waitForSelector('.sd-figs.sd-both');
    await key('KeyB', 'ㅠ');
    await page.waitForFunction(() => !document.querySelector('.sd-figs.sd-both'));
    await key('KeyC', 'ㅊ');
    await page.waitForFunction(() => document.getElementById('sd-cmp-run')?.getAttribute('aria-pressed') === 'true');
    await key('KeyV', 'ㅍ');
    await page.waitForFunction(() => location.hash === '#/screens/0004/~.guest.normal.m');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('M7 a11y: the focus never falls to the page — filters, Copy, Show on map and a live redraw in Coverage; filters, a redraw, Clear filters, decision keys and moving between screens in Screens', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = leafy({ probes: false });
  const s = await open(p, { viewport: { width: 1280, height: 900 } });
  const { page } = s;
  const file = join(p.nunchi, 'runs', '0004', 'coverage.json');
  let bump = 0;
  // a live redraw: the record of the latest run touched (its mtime is part of the version), the view drawn anew
  const redraw = async sel => {
    await page.evaluate(x => { document.querySelector(x).setAttribute('data-old', '1'); }, sel);
    bump += 5000;
    utimesSync(file, new Date(), new Date(Date.now() + bump));
    await page.waitForFunction(x => document.querySelector(x) && !document.querySelector(`${x}[data-old]`), sel, { timeout: 15000 });
  };
  // a key on a control, then where the focus is (and what the control says), in one evaluation
  const press = async (id, key) => { await page.focus(`[id="${id}"]`); await page.keyboard.press(key); };
  const state = (...ids) => page.evaluate(ids => ({ focus: (a => (!a || a === document.body ? 'body' : a.id || a.tagName))(document.activeElement),
    pressed: ids.map(i => document.getElementById(i)?.getAttribute('aria-pressed') ?? null) }), ids);
  try {
    // Coverage: the State and Show buttons (Enter, Space), the Checks select, Copy, Show on map, a live redraw
    await go(page, '#/coverage', '#h-map');
    await press('cv-st-empty', 'Enter');
    assert.deepEqual(await state('cv-st-empty'), { focus: 'cv-st-empty', pressed: ['true'] });
    await press('cv-show-gaps', ' ');
    assert.deepEqual(await state('cv-show-gaps'), { focus: 'cv-show-gaps', pressed: ['true'] });
    await press('cv-st-normal', 'Enter');
    await press('cv-show-all', 'Enter');
    // the Checks select changed while it has the focus. ArrowDown on a closed select changes it on Linux and Windows
    // but opens the menu on macOS, so the choice is made as the menu makes it everywhere: the option set, `input` and
    // `change` sent (selectOption moves no focus; the select keeps the one it was given)
    const checks = () => page.evaluate(() => [document.activeElement?.id, document.getElementById('cv-checks').value]);
    await page.focus('#cv-checks');
    await page.selectOption('#cv-checks', 'rules');
    assert.deepEqual(await checks(), ['cv-checks', 'rules']);
    await page.selectOption('#cv-checks', 'all');
    assert.deepEqual(await checks(), ['cv-checks', 'all']);
    await press('gap-copy-budget-0', 'Enter');
    assert.equal((await state()).focus, 'gap-copy-budget-0', 'Copy keeps the focus');
    await press('gap-show-canary-0', 'Enter');
    const cell = await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.getAttribute('aria-label')]);
    assert.equal(cell[0], 'TD', 'Show on map: a cell of the map');
    assert.match(cell[1], /^\/cart, Visitor, Desktop/, 'the first cell it names');
    await page.focus('#gap-copy-budget-0');
    await redraw('#coverage');
    assert.equal((await state()).focus, 'gap-copy-budget-0', 'a live redraw keeps the focus on its control');
    // the wall: its filter buttons, a live redraw on a card, the decision keys, Clear filters
    await go(page, '#/screens', '#h-screens');
    await press('wall-state-empty', 'Enter');
    assert.deepEqual(await state('wall-state-empty'), { focus: 'wall-state-empty', pressed: ['true'] });
    await press('wall-show-open', ' ');
    assert.deepEqual(await state('wall-show-open'), { focus: 'wall-show-open', pressed: ['true'] });
    await press('wall-state-normal', 'Enter');
    await press('wall-show-all', 'Enter');
    await page.keyboard.press('j');
    const card = (await state()).focus;
    assert.match(card, /^card-/);
    await redraw('#screens');
    assert.equal((await state()).focus, card, 'a live redraw keeps the focus on its card');
    for (const k of ['f', 'w', 'x', 's', 'z']) await page.keyboard.press(k);
    assert.deepEqual(decisions(p.nunchi), [], 'no decision key works on the wall (D4)');
    assert.equal((await state()).focus, card);
    await page.focus('#screen-search');
    await page.keyboard.type('no page is called this');
    await page.waitForSelector('#wall-clear');
    await press('wall-clear', 'Enter');
    await page.waitForFunction(() => document.getElementById('wall-shown')?.textContent === '68 shown of 68');
    assert.equal((await state()).focus, 'h-screens', 'Clear filters: the view\'s heading');
    // Screen detail: a width from its toolbar, J, C, a live redraw, Esc
    await go(page, '#/screens/0004/~.guest.normal.d', '#h-screen');
    await press('sd-w-m', 'Enter');
    await page.waitForFunction(() => location.hash === '#/screens/0004/~.guest.normal.m' && document.querySelector('.sd-head p.muted')?.textContent.includes('Phone'));
    assert.equal((await state()).focus, 'sd-w-m', 'the same control on the other width');
    await page.keyboard.press('j');
    await page.waitForFunction(() => location.hash !== '#/screens/0004/~.guest.normal.m' && document.getElementById('h-screen'));
    assert.notEqual((await state()).focus, 'body', 'J: the next screen, the focus kept');
    await page.keyboard.press('c');
    const was = (await state()).focus;
    assert.notEqual(was, 'body', 'C');
    await redraw('article.sd');
    assert.equal((await state()).focus, was, 'a live redraw keeps the focus where it was');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#h-screens');
    assert.match((await state()).focus, /^card-/, 'Esc: back on its card');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
