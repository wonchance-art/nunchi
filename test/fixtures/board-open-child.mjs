// One process of test/board-open-fails.test.mjs: it opens the board in Chromium on a view that never appears, prints
// how open() failed as JSON on stdout, closes the browser and ends by itself, which it can only do when open() closed
// the board and the page it started (a board left listening keeps the process alive). `node --test` runs every file
// under test/ as a test file: without its argument this one does nothing.
import { rmSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { openBoard } from './board-browser.mjs';
import { smallProject } from './board-project.mjs';

if (process.argv[2] === 'open-fails') {
  const browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined });
  const p = smallProject();
  try {
    await openBoard(browser, p, { wait: '#never-there', timeout: 1000 });
    process.stdout.write(`${JSON.stringify({ failed: false })}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ failed: true, message: e.message.split('\n')[0], port: e.board?.port ?? null })}\n`);
  } finally {
    await browser.close();
    try { rmSync(p.root, { recursive: true, force: true, maxRetries: 3 }); } catch {}   // the project folder: never left behind
  }
}
