// Temporary folders for the tests, every one made here (test/tmp.test.mjs fails a test file that makes one any other
// way). tmp(prefix) makes a folder under the system's temporary folder, by its real path (macOS: /var is a link to
// /private/var), and it is removed when the test file's process ends, whether its tests passed or failed (`node --test`
// runs each file in a process of its own). Measured 2026-10-15 KST, before: on a machine that had run many suites,
// /tmp held 16,286 nunchi-* folders and /dev/shm ran out of inodes (the Leafy projects are ~2,000 files each), and every
// suite then failed with ENOSPC.
// - At exit: removed synchronously (an exit handler cannot wait), with a few retries where Windows refuses to remove a
//   file still open for a moment (a board's watcher, a browser profile, a git process: close those first where the
//   test owns them). A folder that still cannot be removed never fails or holds up the run (the retries stop after
//   10 s in all): the count is printed on one stderr line, with the first of them.
// - Stopped by a signal (POSIX: the runner stops a file that ran past --test-timeout with SIGTERM, and a person with
//   Ctrl-C): removed the same way, then the signal ends the process as it would have. Windows ends a process without
//   telling it, so a file stopped there keeps its folders.
// - NUNCHI_KEEP_TMP=1 keeps them for debugging and prints where they are; a file whose tests failed says how to keep
//   them, and a test's failure message names its folder where the folder matters.
import { mkdtempSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
// POSIX only: Windows ends a stopped process without telling it (and process.kill there sends no SIGHUP)
const SIGNALS = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
let armed = false;

// → a new empty folder, `prefix` + six random characters, removed when this process ends. Every prefix starts with
// `nunchi-`, so a folder left behind says whose it is.
export function tmp(prefix = 'nunchi-') {
  if (typeof prefix !== 'string' || !/^nunchi-[\w.-]*$/.test(prefix)) throw new Error(`tmp(): a prefix starts with nunchi- and is one plain name (got ${JSON.stringify(prefix)})`);
  arm();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// Removes `dirs` (at exit: every folder tmp() made in this process), retrying a refusal until `budgetMs` has passed in
// all, then trying each once. `rm` and `now`: rmSync and Date.now (tests only). → { removed, left: those not removed }.
export function removeTmp(dirs, { rm = rmSync, now = Date.now, budgetMs = 10_000 } = {}) {
  const until = now() + budgetMs, left = [];
  let removed = 0;
  for (const dir of dirs) {
    try { rm(dir, { recursive: true, force: true, maxRetries: now() < until ? 5 : 0, retryDelay: 100 }); removed++; } catch { left.push(dir); }
  }
  return { removed, left };
}

// The one stderr line at exit, or null: what was kept, what could not be removed, or how to keep the folders of a file
// whose tests failed. `code`: the process's exit code.
export function exitLine({ code = 0, keep = false, kept = [], removed = 0, left = [] } = {}) {
  if (keep) return kept.length ? `nunchi tests: kept ${kept.length} temporary folder${kept.length === 1 ? '' : 's'} (NUNCHI_KEEP_TMP=1): ${kept.join(' ')}` : null;
  if (left.length) return `nunchi tests: ${left.length} temporary folder${left.length === 1 ? '' : 's'} could not be removed, e.g. ${left[0]}`;
  if (code && removed) return `nunchi tests: removed this file's ${removed} temporary folder${removed === 1 ? '' : 's'}; NUNCHI_KEEP_TMP=1 keeps them`;
  return null;
}

function atEnd(code) {
  const keep = process.env.NUNCHI_KEEP_TMP === '1';
  const dirs = made.splice(0);
  const line = keep ? exitLine({ keep, kept: dirs }) : exitLine({ code, ...removeTmp(dirs) });
  if (line) { try { writeSync(2, `${line}\n`); } catch {} }
}

// The exit and signal handlers, once a folder is made (a file that never makes one gets none).
function arm() {
  if (armed) return;
  armed = true;
  process.on('exit', code => atEnd(code));
  for (const sig of SIGNALS) {
    process.once(sig, () => {
      atEnd(1);
      // as if nobody had listened: the default action, unless the test listens to this signal itself
      if (!process.listenerCount(sig)) process.kill(process.pid, sig);
    });
  }
}
