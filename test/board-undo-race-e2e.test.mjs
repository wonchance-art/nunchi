// Z's answer that lands after the person moved on (CI macOS node 22, 2026-10-15 KST, "board e2e: batches"): the board
// used to take the focus to the row the undo reopened whenever the answer came, so a decision key pressed on another
// row meanwhile acted on the reopened one (X dismissed it instead of asking about the blocker). The undo's answer is
// held here until the person has focused another row, as a slow machine holds it. Needs Chromium (NUNCHI_BROWSER or
// `nunchi setup`): skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import { smallProject } from './fixtures/board-project.mjs';

let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });
const decisions = nunchi => { try { return readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8'))); } catch { return []; } };
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 100)); } };

test('board e2e: an undo answered after the person moved to another row leaves the focus there, so the next key acts on that row', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  const blocker = p.findings.find(f => f.rule === 'secret-in-client-bundle').group;
  let release;
  const held = new Promise(r => { release = r; });
  const s = await openBoard(browser, p, { setup: ({ page: pg }) => pg.route('**/api/undo', async route => { const res = await route.fetch(); await held; await route.fulfill({ response: res }); }) });
  const { page } = s;
  try {
    await page.click('a[data-nav=findings]');
    await page.waitForSelector('#h-findings');
    await page.waitForFunction(() => document.activeElement?.classList.contains('row'));
    // two groups decided as one batch (neither the blocker), then Z
    for (const k of ['j', ' ', 'j', ' ']) await page.keyboard.press(k);
    await page.keyboard.press('s');
    await until(() => decisions(p.nunchi).length === 2);
    await page.waitForSelector('#toast:not([hidden])');
    const undone = decisions(p.nunchi).map(d => d.target.group);
    assert.ok(!undone.includes(blocker));
    await page.keyboard.press('z');
    await until(() => decisions(p.nunchi).length === 4);
    // the person moves to the blocker; only then does Z's answer reach the page
    await page.focus(`#row-${blocker}`);
    release();
    await page.waitForFunction(() => /Undone/.test(document.getElementById('toast')?.textContent || ''));
    assert.equal(await page.evaluate(() => document.activeElement?.id), `row-${blocker}`, 'the focus stays where the person put it');
    await page.keyboard.press('x');
    await page.waitForSelector('dialog[open]');
    assert.match(await page.textContent('dialog'), /Mark 1 group Not a problem\? 1 is a blocker/, 'X asks about the blocker, the row the person chose');
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog:not([open])', { state: 'attached' });
    assert.equal(decisions(p.nunchi).length, 4, 'nothing written for the reopened rows');
  } finally { await s.close(); }
});
