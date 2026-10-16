// The board's e2e helper when the first view never appears (CI Windows node 20, 2026-10-15 KST: board-coverage-e2e's
// first page did not draw #h-progress in 30 s; open() threw without closing the board it had started, so the file's
// process never ended and the runner cancelled the whole file at 240 s, hiding which test failed). open() now closes
// the page and the board before it throws, and its message names the step it was waiting on, what the board was asked
// and answered, and the longest event-loop stall. A request of the page that never reaches the board is named with
// Chromium's net:: error (CI Windows, PR #36, 2026-10-16 KST: GET /assets/screens.js, net::ERR_NO_BUFFER_SPACE), and a
// wait after the first view that fails says the same, with this machine's TCP sockets. Needs Chromium (NUNCHI_BROWSER
// or `nunchi setup`): skipped without one unless NUNCHI_REQUIRE_BROWSER is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { openBoard, closeBoards } from './fixtures/board-browser.mjs';
import { smallProject } from './fixtures/board-project.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/board-open-child.mjs', import.meta.url));
let browser = null, browserOk = true;
before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.NUNCHI_BROWSER || undefined }); }
  catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { await closeBoards(); await browser?.close(); });

// → the socket's error code, or 'connected' (then closed)
const reach = port => new Promise(res => { const s = connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); res('connected'); }); s.once('error', e => res(e.code)); });

test('board e2e helper: open() that times out on the first view closes the board and the page, and names the step it waited on, the board\'s requests and errors, the event-loop stall and what the page shows', { timeout: 60000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  t.after(() => { try { rmSync(p.root, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  // the model build holds this process (and so the board's answers) for 2.5 s the first time, as a slow runner may,
  // and then fails, so the first view never draws whichever comes first, the build or the wait
  let hold = true;
  const busy = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* a slow machine */ } };
  const afterBuild = () => { if (hold) { hold = false; busy(2500); } throw new Error('a model that cannot be built (a test)'); };
  const e = await openBoard(browser, p, { timeout: 1000, board: { testHooks: { afterBuild } } }).then(() => null, x => x);
  assert.ok(e, 'open() failed');
  const lines = e.message.split('\n');
  assert.match(lines[0], /^open\(\) of the board failed while waiting for #h-progress \(\d+ ms\): page\.waitForSelector: Timeout 1000ms exceeded\.$/);
  assert.match(lines[1], /^ {2}steps: startBoard \d+ ms · newContext \d+ ms · newPage \d+ ms · goto \d+ ms · waiting for #h-progress \d+ ms, failed$/);
  assert.ok(Number(/longest stall (\d+) ms/.exec(lines[2])?.[1]) >= 2400, e.message);
  assert.match(e.message, /\n {4}\+\d+ POST \/api\/session → 200 in \d+ ms\n/);
  assert.match(e.message, /\n {4}\+\d+ GET \/api\/summary → 500 in \d+ ms\n/, 'the request the first view waits on');
  assert.match(e.message, /\n {2}the board's errors: \+\d+ Error: a model that cannot be built \(a test\)/);
  assert.match(e.message, /\n {2}the page: complete, visible, [^;]+; #h-progress is not there; heading #err-h “The board could not read nunchi’s state”; at \/#\/progress; /);
  assert.doesNotMatch(e.message, /#t=[0-9a-f]{64}/, 'the link\'s code is not in the message');
  // closed: the board's port refuses, and the browser has no context left
  assert.equal(e.board.server.listening, false);
  assert.equal(await reach(e.board.port), 'ECONNREFUSED');
  assert.deepEqual(browser.contexts(), []);
});

test('board e2e helper: a script of the page that never reaches the board (CI Windows, PR #36: net::ERR_NO_BUFFER_SPACE) is named with its net:: error, the board never asked for it; the sockets are counted', { timeout: 60000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  t.after(() => { try { rmSync(p.root, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  // Chromium's own request for one module of the page fails before it is sent, as WSAENOBUFS made it
  const e = await openBoard(browser, p, { timeout: 2000, setup: ({ page }) => page.route('**/assets/screens.js', r => r.abort('connectionfailed')) }).then(() => null, x => x);
  assert.ok(e, 'open() failed');
  assert.match(e.message.split('\n')[0], /^open\(\) of the board failed while waiting for #h-progress \(\d+ ms\): page\.waitForSelector: Timeout 2000ms exceeded\.$/);
  assert.match(e.message, /\n {4}\+\d+ GET \/assets\/board\.js → 200 in \d+ ms\n/);
  assert.doesNotMatch(e.message, /\n {4}\+\d+ GET \/assets\/screens\.js/, 'the board never saw it');
  assert.match(e.message, /; requests that failed: \+\d+ GET \/assets\/screens\.js: net::ERR_CONNECTION_FAILED/);
  assert.match(e.message, /\n {2}the page: [^\n]*main “Opening the board…”/);
  assert.match(e.message, /\n {2}sockets: this process holds \d+ TCP connections? and \d+ listeners?; the machine's TCP sockets[:]? /);
  assert.equal(e.board.server.listening, false);
  assert.deepEqual(browser.contexts(), []);
});

test('board e2e helper: a wait after the first view that fails says the same — since when it waited, the board\'s requests, the page\'s failed ones, the stall, the sockets; a function is named by its text', { timeout: 60000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const p = smallProject();
  t.after(() => { try { rmSync(p.root, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
  const s = await openBoard(browser, p);
  try {
    // the Findings view's list request never reaches the board
    await s.page.route('**/api/groups?*', r => r.abort('addressunreachable'));
    await s.page.evaluate(() => { location.hash = '#/findings'; });
    const e = await s.page.waitForSelector('#never-there', { timeout: 1000 }).then(() => null, x => x);
    assert.ok(e, 'the wait failed');
    const lines = e.message.split('\n');
    assert.match(lines[0], /^waiting for #never-there failed after \d+ ms \(the first view came at \+\d+ ms, the wait began at \+\d+ ms\): page\.waitForSelector: Timeout 1000ms exceeded\.$/);
    assert.match(lines[1], /^ {2}this process's event loop \(the board's too\): longest stall \d+ ms$/);
    assert.match(e.message, /\n {4}\+\d+ POST \/api\/session → 200 in \d+ ms\n/, 'what the board was asked since open() began');
    assert.match(e.message, /\n {4}\+\d+ GET \/api\/live → 200, still open \(\d+ ms\)\n/);
    assert.match(e.message, /; requests that failed: \+\d+ GET \/api\/groups: net::ERR_ADDRESS_UNREACHABLE/);
    assert.match(e.message, /\n {2}the page: complete, visible, [^;]+; #never-there is not there; /);
    assert.match(e.message, /\n {2}sockets: this process holds \d+ TCP connections? and \d+ listeners?; /);
    assert.equal(e.board, s.b);
    const f = await s.page.waitForFunction(() => document.title === 'never', null, { timeout: 500 }).then(() => null, x => x);
    assert.match(f.message.split('\n')[0], /^waiting for \(\) => document\.title === 'never' failed after \d+ ms .*: page\.waitForFunction: Timeout 500ms exceeded\.$/);
    // a wait that is answered is Playwright's, unchanged
    assert.equal(await (await s.page.waitForFunction(() => 1 + 1)).jsonValue(), 2);
    assert.ok(await s.page.waitForSelector('main'));
  } finally { await s.close(); }
  // closed by the test: a wait on it fails as Playwright's own, with nothing to report
  const g = await s.page.waitForSelector('main', { timeout: 500 }).then(() => null, x => x);
  assert.ok(g && !/^waiting for/.test(g.message), g?.message);
});

test('board e2e helper: a process whose open() fails ends by itself at once — nothing it started is left running (the test file is not cancelled at the runner\'s limit)', { timeout: 90000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const child = spawn(process.execPath, [CHILD, 'open-fails'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const t0 = Date.now();
  // a fixed 60 s: far over what it takes (a few seconds on the slowest runner), far under the per-file 240 s
  const ended = await new Promise(res => {
    const timer = setTimeout(() => { child.kill(); res(null); }, 60000);
    child.once('exit', code => { clearTimeout(timer); res({ code }); });
  });
  assert.ok(ended, `the process did not end in 60 s: open() left something running (${out.trim()} ${err.trim()})`);
  assert.equal(ended.code, 0, err);
  const r = JSON.parse(out);
  assert.equal(r.failed, true);
  assert.match(r.message, /^open\(\) of the board failed while waiting for #never-there \(\d+ ms\): page\.waitForSelector: Timeout 1000ms exceeded\.$/);
  t.diagnostic(`ended after ${Date.now() - t0} ms`);
});
