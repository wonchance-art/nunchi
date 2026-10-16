// Sharing on the board (spec §7.6; the owner's §5.3 mock-up): the summary says on or off, where, and the last send;
// [Turn off] is anyone's; [Turn on] only for a destination set up in the terminal, not stopped, and only once the person
// confirmed the question (409 with it first); the board never changes where or what goes; a change reaches an open
// board (the generation). In Chromium: the lines under the run box and on Progress, the dialog with Cancel focused, Esc
// and Enter by their keys, the focus kept on the button, axe with no violation light and dark, 4.5:1 text, forced
// colours. Synthetic projects only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import { share } from '../src/share/send.mjs';
import { readShare, updateLog, withSend, stopShare } from '../src/share/config.mjs';
import { shareProject, driveHome, setUp, now } from './fixtures/share-project.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function board(p) {
  const b = await startBoard({ projectDir: p.root });
  const origin = b.origin;
  const s = await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) }).then(r => r.json()).catch(async e => { await b.close(); throw e; });
  const call = async (path, body) => {
    const res = await fetch(origin + path, body === undefined ? { headers: { 'x-nunchi-token': s.token } } : { method: 'POST', headers: { 'x-nunchi-token': s.token, 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { b, call };
}

test('share board api: not set up, no Turn on; set up and off, Turn on asks first and then turns it on (channel board); Turn off is anyone\'s; the generation moves', async () => {
  const p = shareProject();
  const { b, call } = await board(p);
  try {
    assert.deepEqual((await call('/api/summary')).json.share, { setUp: false, on: false });
    assert.equal((await call('/api/share', { on: true })).status, 409, 'nothing set up: nothing to turn on');
    const d = driveHome(p);
    const st = setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/shop' }, { on: false });
    const v0 = (await call('/api/generation')).json.version;
    const off = (await call('/api/summary')).json.share;
    assert.deepEqual(off, { setUp: true, on: false, kind: 'drive', where: 'Google Drive · My Drive/nunchi/shop', canTurnOn: true, stopped: null, waiting: null, last: null });
    const ask = await call('/api/share', { on: true });
    assert.equal(ask.status, 409);
    assert.equal(ask.json.confirm.text, 'Send screenshots of shop to Google Drive · My Drive/nunchi/shop after each full check? Signed-in screens and page text stay out.');
    assert.match(ask.json.confirm.more, /^Sharing sends screenshots of your app off this (Mac|computer) to Google Drive · My Drive\/nunchi\/shop\. Anyone who can open/);
    assert.equal(ask.json.confirm.ok, 'Turn on');
    assert.equal(readShare(st.root.dir).on, false, 'asking turns nothing on');
    assert.deepEqual((await call('/api/share', { on: true, confirmed: true })).json, { ok: true, on: true });
    const cfg = readShare(st.root.dir);
    assert.deepEqual([cfg.on, cfg.turned.channel, cfg.dest.folder, cfg.include], [true, 'board', 'nunchi/shop', { signedIn: false, pageText: false }], 'the destination and what goes as set up');
    assert.notEqual((await call('/api/generation')).json.version, v0);
    // a send: "Last sent"
    assert.equal(share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test', deps: { now } }).code, 0);
    assert.deepEqual((await call('/api/summary')).json.share.last, { run: '0001', screens: 3, visitorOnly: true, at: '2026-10-16T17:00:00.000+09:00' });
    assert.deepEqual((await call('/api/share', { on: false })).json, { ok: true, on: false });
    assert.equal(readShare(st.root.dir).on, false);
    // stopped (the artifact is no longer private): no Turn on until the terminal sets it up again
    setUp(p, { kind: 'artifact', url: 'https://claude.ai/artifact/AbCdEf123456' });
    stopShare(st.root.dir, 'artifact-not-private', { at: 'x' });
    const stopped = (await call('/api/summary')).json.share;
    assert.deepEqual([stopped.on, stopped.canTurnOn, stopped.stopped], [false, false, 'Stopped: your artifact is no longer private. Set up again in your terminal: nunchi share --setup']);
    assert.equal((await call('/api/share', { on: true, confirmed: true })).status, 409);
    assert.equal((await call('/api/share', { on: 'yes' })).status, 400);
  } finally { await b.close(); }
});

test('share board api: an artifact pack waiting for its publish is said; the setup\'s strings are data (cleaned)', async () => {
  const p = shareProject();
  setUp(p, { kind: 'artifact', url: null });
  share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test', deps: { now } });
  const { b, call } = await board(p);
  try {
    const sh = (await call('/api/summary')).json.share;
    assert.deepEqual([sh.on, sh.where, sh.waiting, sh.last], [true, 'Claude artifact · a new private artifact', '0001', null]);
  } finally { await b.close(); }
});

// ---- in Chromium ----------------------------------------------------------------------------------------------------
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });
async function axe(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target.join(' ')).slice(0, 3) })));
}
// the Sharing blocks, measured in one evaluation: their words, the least contrast of their text, the button's edge
const blocks = page => page.evaluate(() => {
  const rgb = c => (String(c).match(/[\d.]+/g) || []).map(Number);
  const clear = c => c === 'transparent' || rgb(c)[3] === 0;
  const lum = c => { const [r, g, b] = rgb(c).slice(0, 3).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => (([x, y]) => (x + 0.05) / (y + 0.05))([lum(a), lum(b)].sort((m, n) => n - m));
  const bg = e => { for (let n = e; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!clear(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
  const of = sel => {
    const el = document.querySelector(sel);
    if (!el || !el.getClientRects().length) return null;
    const texts = [...el.querySelectorAll('p, span, button')].filter(e => e.getClientRects().length && e.textContent.trim());
    const btn = el.querySelector('button');
    return { line: el.querySelector('.share-line')?.textContent ?? null, sub: el.querySelector('.share-sub')?.textContent ?? null, button: btn?.textContent ?? null, name: btn?.getAttribute('aria-label') ?? null,
      least: Math.min(...texts.map(e => ratio(getComputedStyle(e).color, bg(e)))), edge: btn ? `${getComputedStyle(btn).borderTopStyle} ${getComputedStyle(btn).borderTopWidth}` : null,
      height: btn ? Math.round(btn.getBoundingClientRect().height) : null };
  };
  return { side: of('#sharebox .share'), progress: of('.share-p'), sideways: document.documentElement.scrollWidth > window.innerWidth + 1, forced: matchMedia('(forced-colors: active)').matches };
});

test('share board e2e: "Sharing  On · Google Drive · My Drive/nunchi/shop [Turn off]" and "Last sent: …" under the run box and on Progress; axe clean light and dark; 4.5:1; forced colours', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = shareProject();
  const d = driveHome(p);
  setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/shop' });
  share({ project: p.root, nunchiDir: p.nunchi, version: '0.0.0-test', deps: { now: () => Date.now() - 12 * 60e3 - 5000 } });
  for (const [scheme, width] of [['light', 1280], ['dark', 390]]) {
    const s = await openBoard(browser, p, { ctx: { colorScheme: scheme, viewport: { width, height: 900 } } });
    try {
      await s.page.waitForSelector('.share-p');
      const m = await blocks(s.page);
      const want = { line: 'Sharing On · Google Drive · My Drive/nunchi/shop', sub: 'Last sent: run 0001 · 3 visitor screens · 12 min ago', button: 'Turn off', name: 'Turn off sharing' };
      assert.deepEqual({ line: m.progress.line, sub: m.progress.sub, button: m.progress.button, name: m.progress.name }, want, scheme);
      if (width > 760) assert.deepEqual({ line: m.side.line, sub: m.side.sub, button: m.side.button, name: m.side.name }, want, 'the sidebar says the same');
      else assert.equal(m.side, null, 'a phone has it on Progress only');
      assert.ok(m.progress.least >= 4.5 && (!m.side || m.side.least >= 4.5), `${scheme}: ${m.progress.least.toFixed(2)}:1 · ${m.side?.least.toFixed(2)}`);
      assert.ok(m.progress.height >= 44, `${m.progress.height} px`);
      assert.equal(m.sideways, false);
      assert.deepEqual(await axe(s.page), [], `${scheme} at ${width} px`);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
  const f = await openBoard(browser, p, { ctx: { forcedColors: 'active', viewport: { width: 1280, height: 900 } } });
  try {
    await f.page.waitForSelector('.share-p');
    const m = await blocks(f.page);
    assert.deepEqual([m.forced, m.progress.edge, m.side.edge, m.progress.button], [true, 'solid 1px', 'solid 1px', 'Turn off']);
  } finally { await f.close(); }
});

test('share board e2e: Turn on asks first with Cancel focused (Esc cancels, nothing changes); Enter on Turn on turns it on; the focus stays on the button; not set up says where to set it up, with no button', { timeout: 120000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = shareProject();
  const s0 = await openBoard(browser, p);
  try {
    await s0.page.waitForSelector('.share-p');
    const m = await blocks(s0.page);
    assert.deepEqual([m.progress.line, m.progress.sub, m.progress.button], ['Sharing Off', 'Set up in your terminal: nunchi share --setup', null]);
  } finally { await s0.close(); }
  const d = driveHome(p);
  const st = setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/shop' }, { on: false });
  const s = await openBoard(browser, p);
  const { page } = s;
  try {
    await page.waitForSelector('#share-p-btn');
    assert.equal(await page.evaluate(() => document.getElementById('share-p-btn').textContent), 'Turn on');
    await page.focus('#share-p-btn');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open]');
    const dlg = await page.evaluate(() => ({ title: document.getElementById('dialog-title').textContent, more: document.querySelector('.dialog-more')?.textContent, focus: document.activeElement.textContent,
      buttons: [...document.querySelectorAll('dialog .dialog-actions button')].map(b => b.textContent) }));
    assert.deepEqual([dlg.title, dlg.focus, dlg.buttons], ['Send screenshots of shop to Google Drive · My Drive/nunchi/shop after each full check? Signed-in screens and page text stay out.', 'Cancel', ['Cancel', 'Turn on']]);
    assert.match(dlg.more, /A screenshot can still show anything that is on the screen\.$/);
    // the consent under the question is the dialog's accessible description (read with its name)
    const cdp = await page.context().newCDPSession(page);
    const ax = (await cdp.send('Accessibility.getFullAXTree')).nodes.find(n => n.role?.value === 'dialog');
    assert.deepEqual([ax?.name?.value, ax?.description?.value], [dlg.title, dlg.more]);
    await cdp.detach();
    assert.deepEqual(await axe(page), [], 'the dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(readShare(st.root.dir).on, false, 'Esc: nothing changed');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'share-p-btn');
    // Enter on Turn on: Tab from Cancel to Turn on, then Enter (keys by their place: Playwright presses by code)
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open]');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Turn on');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('share-p-btn')?.textContent === 'Turn off');
    assert.equal(readShare(st.root.dir).on, true);
    assert.equal(readShare(st.root.dir).turned.channel, 'board');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'share-p-btn', 'the focus stays on the button');
    await page.waitForFunction(() => document.getElementById('announce').textContent === 'Sharing is on.');
    // Turn off from the sidebar: no question; the focus stays on that button
    await page.focus('#share-s-btn');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('share-s-btn')?.textContent === 'Turn on');
    assert.equal(readShare(st.root.dir).on, false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'share-s-btn');
    // a change made elsewhere (the terminal) reaches the open board by itself
    updateLog(st.root.dir, l => withSend(l, { run: '0001', at: new Date(Date.now() + 9 * 3600e3).toISOString().replace('Z', '+09:00'), kind: 'drive', where: 'x', screens: 3, visitorOnly: true, files: 6, bytes: 1, state: 'sent' }), { generation: st.files.generation });
    await page.waitForFunction(() => document.querySelector('.share-p .share-sub')?.textContent === 'Last sent: run 0001 · 3 visitor screens · just now', null, { timeout: 15000 });
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
