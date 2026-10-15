#!/usr/bin/env node
// Runs a command (CI: `npm test`) with a temporary folder of its own (TMPDIR, TEMP and TMP: POSIX and Windows), then
// fails when the command left anything in it. The tests remove every folder they make (test/fixtures/tmp.mjs);
// measured 2026-10-15 KST, before that: one run of the suite left 780 entries (113,660 files, 374 MB) in it.
//   node scripts/tmp-leftovers.mjs <command> [args…]
// → the command's exit code when it failed; else 1 when something was left (each entry is named), else 0.
// Not counted, by name (what other programs leave there, and the one folder nunchi keeps there on purpose):
// - node-compile-cache: npm's (npm 10.9 and later turn on Node's module compile cache, and keep it there);
// - .org.chromium.Chromium.XXXXXX: a shared-memory file of Chromium's (Playwright starts it with
//   --disable-dev-shm-usage, so these live in the temporary folder, not /dev/shm). A browser killed when a capture is
//   stopped leaves one (quick-cli's stopped capture: 8 of 8 runs), and now and then a browser closed normally does too
//   (seen 2026-10-16 KST after board-e2e and capture);
// - nunchi-<uid>, while empty: the folder a board's control socket goes to when the state folder's path is too long
//   for a socket (src/board/server.mjs controlPath; macOS's temporary folder is). It is kept for the next board, as
//   tmux keeps its own; a socket left in it is a board left running, and counts.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// → the entries of `dir` that count as left behind
export function leftovers(dir) {
  const empty = p => { try { return readdirSync(p).length === 0; } catch { return false; } };
  const notOurs = name => name === 'node-compile-cache' || /^\.org\.chromium\.Chromium\.\w{6}$/.test(name) || (/^nunchi-(\d+|u)$/.test(name) && empty(join(dir, name)));
  return readdirSync(dir).sort().filter(name => !notOurs(name));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { process.stderr.write('usage: node scripts/tmp-leftovers.mjs <command> [args…]\n'); process.exit(2); }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-leftovers-')));
  // Windows: npm is npm.cmd, which only a shell starts (a path, such as node's own, is started as it is)
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir }, shell: process.platform === 'win32' && !/[\\/]/.test(cmd) });
  const left = leftovers(dir);
  if (left.length) {
    process.stderr.write(`tmp-leftovers: ${cmd} ${args.join(' ')} left ${left.length} entr${left.length === 1 ? 'y' : 'ies'} in its temporary folder:\n`);
    for (const name of left.slice(0, 50)) process.stderr.write(`  ${name}\n`);
    if (left.length > 50) process.stderr.write(`  … and ${left.length - 50} more\n`);
  } else process.stdout.write(`tmp-leftovers: ${cmd} ${args.join(' ')} left nothing in its temporary folder\n`);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { process.stderr.write(`tmp-leftovers: could not remove ${dir}: ${e.code || e.message}\n`); }
  const code = r.error ? 2 : r.status ?? 1;
  process.exit(code || (left.length ? 1 : 0));
}
