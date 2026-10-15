// The board in a real browser, for the tests that open it in Chromium. openBoard() starts a board on a project, opens a
// page on its one-time link and waits for the first view. When a step fails it closes what it started (the page's
// context and the board) before it throws: a board left listening keeps the test file's process alive until the
// runner cancels the whole file at its per-file limit, which hides the test that failed (CI Windows node 20,
// 2026-10-15 KST: the first page of board-coverage-e2e never drew #h-progress in 30 s, then the file ran 240 s). The
// error says which step it was waiting on, how long each step took, what the board was asked and answered, the errors
// it hit, the longest stall of this process's event loop (the board runs in it, so a model build that holds it holds
// the page's answers too) and what the page showed. closeBoards() in a file's after() closes whatever a test left open.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { startBoard } from '../../src/board/server.mjs';

const live = new Set();                                   // the close() of every page and board not closed yet
const firstLine = s => String(s ?? '').split('\n')[0];
// a launch code is a key: never in a message
const redact = s => String(s).replace(/#t=[0-9a-f]{64}/g, '#t=…');
const pathOf = u => { try { const x = new URL(u); return x.protocol === 'blob:' ? 'blob:…' : x.pathname; } catch { return '?'; } };
const MAX_LINES = 40;
const keep = (list, line) => { if (list.length < MAX_LINES) list.push(redact(line)); };

// Closes every page and board a test of this file left open (call it in after(), before the browser closes).
export async function closeBoards() {
  for (const close of [...live]) await close().catch(() => {});
}

// → { b, context, page, errors, requests, dialogs, close() }. `ctx`: the context's options; `board`: startBoard's
// options; `setup({ b, context, page })`: runs before the page goes to the link (routes, a clock, init scripts);
// `wait`: the selector of the first view (null: none); `timeout`: that wait's, when not Playwright's own.
export async function openBoard(browser, p, { ctx = { viewport: { width: 1280, height: 900 } }, board = {}, setup = null, wait = '#h-progress', timeout } = {}) {
  const t0 = performance.now(), at = () => Math.round(performance.now() - t0);
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const steps = [], served = [], boardErrors = [], failed = [], consoleLines = [], events = [];
  const errors = [], requests = [], dialogs = [];
  let b = null, context = null, page = null, closed = false, opening = true;
  const close = async () => {
    if (closed) return;
    closed = true;
    live.delete(close);
    let first = null;
    try { await context?.close(); } catch (e) { first = e; }
    try { await b?.close(); } catch (e) { first ??= e; }
    if (first) throw first;
  };
  const step = async (name, fn) => { const s = { name, from: at(), to: null }; steps.push(s); const v = await fn(); s.to = at(); return v; };
  try {
    const hooks = board.testHooks || {};
    b = await step('startBoard', () => startBoard({ projectDir: p.root, ...board,
      testHooks: { ...hooks, error: e => { if (opening) keep(boardErrors, `+${at()} ${e?.stack || e}`.split('\n').slice(0, 4).join(' ⏎ ')); hooks.error?.(e); } } }));
    live.add(close);
    // what the board was asked, and when it answered (first, before the board's own handler sees the request); the
    // page's failed requests, console errors and a crash: kept while it opens, for the report
    const asked = (req, res) => {
      const r = { at: at(), what: `${req.method} ${firstLine(req.url).split('?')[0]}`, res, end: null };
      served.push(r);
      res.once('close', () => { r.end = at(); });
    };
    b.server.prependListener('request', asked);
    context = await step('newContext', () => browser.newContext(ctx));
    page = await step('newPage', () => context.newPage());
    page.on('pageerror', e => errors.push(String(e)));
    page.on('request', r => requests.push(r.url()));
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    const onFailed = r => keep(failed, `+${at()} ${r.method()} ${pathOf(r.url())}: ${r.failure()?.errorText}`);
    const onConsole = m => { if (m.type() === 'error' || m.type() === 'warning') keep(consoleLines, `+${at()} ${m.type()}: ${m.text()}`); };
    const onCrash = () => keep(events, `the page crashed at +${at()} ms`);
    page.on('requestfailed', onFailed).on('console', onConsole).on('crash', onCrash);
    if (setup) await step('setup', () => setup({ b, context, page }));
    await step('goto', () => page.goto(b.newLink()));
    if (wait) await step(`waiting for ${wait}`, () => page.waitForSelector(wait, timeout === undefined ? undefined : { timeout }));
    // opened: the rest of the test runs without the report's listeners
    opening = false;
    lag.disable();
    b.server.removeListener('request', asked);
    page.off('requestfailed', onFailed).off('console', onConsole).off('crash', onCrash);
    return { b, context, page, errors, requests, dialogs, close };
  } catch (e) {
    lag.disable();
    let why;
    try { why = await report(e, { at, steps, lag, served, boardErrors, page, wait, errors, consoleLines, failed, events }); }
    catch (r) { why = `open() of the board failed: ${redact(firstLine(e?.message))} (and its report failed: ${firstLine(r?.message)})`; }
    await close().catch(() => {});
    throw Object.assign(new Error(why, { cause: e }), { board: b });
  }
}

// `promise`, or `late` when it takes longer than `ms` (a timer of this process: a page's own may be a test's fake clock)
async function within(promise, ms, late) {
  let timer;
  try { return await Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(late), ms); })]); } finally { clearTimeout(timer); }
}
// What the page shows, in one evaluation that has 3 s to answer (a page whose script hangs never does), and whether it
// draws frames (one within 1 s).
async function lookAt(page, wait) {
  const facts = page.evaluate(sel => {
    const el = sel ? document.querySelector(sel) : null;
    const h = document.querySelector('main h1, main h2');
    return {
      ready: document.readyState, shown: document.visibilityState,
      target: !sel ? null : !el ? 'is not there' : el.getClientRects().length ? 'is there and visible' : 'is there, not visible',
      heading: h ? `${h.id ? `#${h.id} ` : ''}“${h.textContent.trim().slice(0, 100)}”` : 'none',
      main: (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      at: /^#t=/.test(location.hash) ? `${location.pathname}#t=… (the link's code, not traded yet)` : location.pathname + location.hash,
    };
  }, wait).then(v => ({ v }), e => ({ e }));
  const frame = page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(true)))).then(() => 'drawing frames', () => 'no frame');
  const [f, drawn] = await Promise.all([within(facts, 3000, null), within(frame, 1000, 'no frame in 1 s')]);
  if (!f) return 'did not answer in 3 s (its script is busy or hung)';
  if (f.e) return `could not be read (${firstLine(f.e?.message)})`;
  const v = f.v;
  return `${v.ready}, ${v.shown}, ${drawn}; ${wait ? `${wait} ${v.target}; ` : ''}heading ${v.heading}; at ${v.at}; main “${v.main}”`;
}

async function report(e, { at, steps, lag, served, boardErrors, page, wait, errors, consoleLines, failed, events }) {
  const now = at();
  const stuck = steps.find(s => s.to === null);
  const out = [`open() of the board failed while ${stuck ? `${stuck.name} (${now - stuck.from} ms)` : 'setting up'}: ${redact(firstLine(e?.message))}`];
  out.push(`  steps: ${steps.map(s => `${s.name} ${s.to === null ? `${now - s.from} ms, failed` : `${s.to - s.from} ms`}`).join(' · ')}`);
  out.push(`  this process's event loop (the board's too): longest stall ${Math.round(lag.max / 1e6)} ms`);
  const answer = r => (r.end !== null ? `${r.res.statusCode} in ${r.end - r.at} ms${r.res.writableFinished ? '' : ' (cut off)'}`
    : r.res.headersSent ? `${r.res.statusCode}, still open (${now - r.at} ms)` : `no answer yet (${now - r.at} ms)`);
  out.push(`  the board was asked (+ms since open() began):${served.length ? '' : ' nothing'}`);
  for (const r of served.slice(-15)) out.push(`    +${r.at} ${r.what} → ${answer(r)}`);
  out.push(`  the board's errors: ${boardErrors.length ? boardErrors.join(' | ') : 'none'}`);
  out.push(`  the page: ${page ? await lookAt(page, wait) : 'not opened'}`);
  out.push(`  page errors: ${errors.length ? errors.map(x => redact(firstLine(x))).join(' | ') : 'none'}; console: ${consoleLines.join(' | ') || 'none'}; requests that failed: ${failed.join(' | ') || 'none'}${events.length ? `; ${events.join('; ')}` : ''}`);
  return out.join('\n');
}
