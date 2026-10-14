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
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startBoard } from '../src/board/server.mjs';
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
after(async () => { await browser?.close(); });

const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8'))); } catch { return []; } };
function project() {
  const p = smallProject();
  const ai = withAi(p, [{ lens: 'L6', rule: 'L6.vague-error', scene: p.scenes[3], selector: 'main p.err', box: [40, 300, 400, 24], claim: `The error says nothing useful ${HOSTILE}`, status: 'confirmed', severity: 'high', file: 'app/garden/page.tsx', line: 12 },
    { lens: 'L2', rule: 'L2.inconsistent-term', scene: p.scenes[0], selector: 'main > a.more', box: [40, 900, 120, 32], claim: 'Two words for one thing', status: 'claimed', severity: 'medium' }]);
  return { ...p, ai };
}
async function open(p, ctx = {}, opts = {}) {
  const b = await startBoard({ projectDir: p.root, ...opts });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...ctx });
  const page = await context.newPage();
  const requests = [], dialogs = [], errors = [];
  page.on('request', r => requests.push(r.url()));
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(b.newLink());
  return { b, context, page, requests, dialogs, errors, close: async () => { await context.close(); await b.close(); } };
}
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
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
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
    assert.equal(await page.locator('.row[aria-selected=true]').count(), 2, await page.evaluate(() => JSON.stringify([document.activeElement?.outerHTML?.slice(0, 100), location.hash, document.querySelectorAll('.row').length, document.querySelector('main').textContent.slice(0, 300)])));
    await page.keyboard.press('s');
    const files = await until(() => { const d = decisions(p.nunchi); return d.length === 2 && d; });
    assert.equal(new Set(files.map(d => d.batch)).size, 1, 'one batch');
    assert.ok(files[0].batch);
    await page.keyboard.press('z');
    await until(() => decisions(p.nunchi).length === 4);
    assert.equal(decisions(p.nunchi).filter(d => d.decision === 'reopen').length, 2, 'Z undid the whole batch');
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
    const ids = () => page.$$eval('.row[data-id]', rs => rs.map(r => r.getAttribute('data-id')));
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
        const small = await page.$$eval('main button, main [role=tab], main [role=option], main select, main input, nav .nav a, main .btn, main .tile', els => els
          .filter(e => e.offsetParent !== null).map(e => ({ e: e.outerHTML.slice(0, 80), r: e.getBoundingClientRect() })).filter(x => x.r.height < 43.5 || (x.e.startsWith('<button') && x.r.width < 43.5)).map(x => `${x.e} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`));
        assert.deepEqual(small, [], `${view} at ${width}px`);
        // severity is said in words, not only by the dot's colour
        for (const text of await page.$$eval('.sev', els => els.map(e => e.textContent.trim()))) assert.match(text, /^(Blocker|High|Medium|Low)$/);
        if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${view}: no sideways scroll at 390 px (200% zoom of 780 px)`);
      }
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
