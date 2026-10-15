// Running the repository's own checks for the fix loop (design 0.1-c §4.3), so "checks passed" is not the agent's word.
// Only lines of an approved check profile run (checks.mjs), each through its package manager with the pre/post lines
// switched off where the manager can be told to (verified per manager, spec §6.4):
//   npm  10.9  `npm run --ignore-scripts <name>`                        runs the line only
//   pnpm 10.28 `pnpm --config.enable-pre-post-scripts=false run <name>` runs the line only (plain `pnpm run` runs
//              pre/post, and pnpm has no `run --ignore-scripts`)
//   yarn 1.22  `yarn run <name>` runs pre/post whatever flag is given; bun 1.4 `bun run` too: a check with a pre or
//              post line is not run there (said plainly), one without is. Yarn 2+ runs no pre/post lines.
// - shell: false. A package manager is found on PATH by nunchi (never downloaded: corepack is told not to fetch or pin);
//   a missing one is refused. On Windows the managers are .cmd shims, started through cmd.exe /d /s /c (node refuses
//   to start a .cmd without a shell); the script name is checked to be a plain word first.
// - The environment is an allow-list: PATH, HOME, LANG, TERM, CI=1, NODE_ENV=test (Windows adds SystemRoot, PATHEXT,
//   COMSPEC, TEMP, TMP, USERPROFILE, APPDATA, LOCALAPPDATA: npm cannot start without them).
// - 10 minutes per check, then the process tree is killed.
// - Output goes through the secret scanner (and loses its colour codes) before it is stored or printed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, accessSync, constants } from 'node:fs';
import { join, delimiter, win32 } from 'node:path';
import { scrubSecrets } from '../rules.mjs';
import { redactText } from '../network.mjs';
import { CHECK_SCRIPTS } from '../checks.mjs';

export const CHECK_TIMEOUT_MS = 10 * 60e3;
export const EXIT_GRACE_MS = 1500;
export const OUTPUT_KEEP = 4000;
const SCRIPT = /^[\w:.-]{1,64}$/;

// Which package manager the project uses: its `packageManager` field, else its lockfile, else npm.
export function packageManagerOf(root, profile = null) {
  const m = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(profile?.packageManager || '');
  if (m) return { name: m[1], major: Number(m[2]), from: 'packageManager' };
  const has = f => existsSync(join(root, f));
  if (has('pnpm-lock.yaml')) return { name: 'pnpm', major: null, from: 'pnpm-lock.yaml' };
  if (has('yarn.lock')) return { name: 'yarn', major: has('.yarnrc.yml') ? 2 : 1, from: 'yarn.lock' };
  if (has('bun.lockb') || has('bun.lock')) return { name: 'bun', major: null, from: 'bun lockfile' };
  return { name: 'npm', major: null, from: has('package-lock.json') ? 'package-lock.json' : 'default' };
}

// The manager's executable on PATH, or null (never downloaded).
export function findBinary(name, { env = process.env, platform = process.platform } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const names = platform === 'win32' ? [`${name}.cmd`, `${name}.exe`] : [name];
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    try {
      if (!statSync(p).isFile()) continue;
      if (platform !== 'win32') accessSync(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// The allow-listed environment of a check (or of `--serve`, without NODE_ENV and with PORT).
export function childEnv(env = process.env, platform = process.platform, { serve = false, extra = {} } = {}) {
  const out = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM']) if (typeof env[k] === 'string') out[k] = env[k];
  if (platform === 'win32') {
    for (const k of ['SystemRoot', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      const v = env[k] ?? env[Object.keys(env).find(x => x.toLowerCase() === k.toLowerCase())];
      if (typeof v === 'string') out[k] = v;
    }
    if (!out.PATH && typeof env.Path === 'string') out.PATH = env.Path;
  }
  Object.assign(out, { CI: '1', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
  if (!serve) out.NODE_ENV = 'test';
  return { ...out, ...extra };
}

// The command that runs one script line and nothing else of package.json. → { cmd, args, opts } | { refused }.
export function commandFor({ pm, script, bin, platform = process.platform, profile = null, extraArgs = [] }) {
  if (!SCRIPT.test(script)) return { refused: `"${script}" is not a script name nunchi runs` };
  const prePost = !!(profile && (profile.scripts?.[`pre${script}`] !== undefined || profile.scripts?.[`post${script}`] !== undefined || profile.serve?.[`pre${script}`] !== undefined || profile.serve?.[`post${script}`] !== undefined));
  let args;
  if (pm.name === 'npm') args = ['run', '--ignore-scripts', script];
  else if (pm.name === 'pnpm') args = ['--config.enable-pre-post-scripts=false', 'run', script];
  else if (pm.name === 'yarn' && pm.major !== null && pm.major >= 2) args = ['run', script];
  else {
    // before the PATH check: installing the manager would not lift this refusal, so "install bun" is not the answer
    if (prePost) return { refused: `${pm.name === 'yarn' ? 'yarn 1' : 'bun'} runs pre${script} and post${script} whatever it is told, so nunchi does not run ${script} (it runs only the line itself)` };
    args = ['run', script];
  }
  if (!bin) return { refused: `no ${pm.name} on PATH: nunchi never downloads a package manager (install ${pm.name}, or run nunchi where it is)` };
  const extra = extraArgs.map(String);
  if (extra.some(a => !/^[\w:.=-]{1,64}$/.test(a))) return { refused: 'extra arguments must be plain words' };
  if (extra.length) args = pm.name === 'npm' || pm.name === 'pnpm' ? [...args, '--', ...extra] : [...args, ...extra];
  return launch(bin, args, { platform, name: pm.name });
}
// How a manager's binary is started: itself, or on Windows its .cmd shim through cmd.exe.
function launch(bin, args, { platform = process.platform, name = 'the package manager' } = {}) {
  if (platform === 'win32' && /\.cmd$/i.test(bin)) {
    // cmd expands %VAR% even inside quotes, and a quote would end ours: such a path is not run
    if (/["%\n]/.test(bin)) return { refused: `the path of ${name} (${bin}) holds a character cmd.exe would read as its own` };
    const root = /^[A-Za-z]:\\[^"%&|<>^\n]*$/.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows';
    // /s strips the outer pair of quotes and keeps the rest as it is: the whole line goes in one more pair, as node
    // does for shell: true, so a path with spaces ("C:\Program Files\nodejs\npm.cmd") stays one word
    return { cmd: win32.join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], opts: { windowsVerbatimArguments: true } };
  }
  return { cmd: bin, args, opts: {} };
}

// A manager's major version from `<bin> --version`, started as checks start it (a .cmd shim through cmd.exe on
// Windows). → a number, or null.
export async function majorOf(bin, { root, env = process.env, platform = process.platform } = {}) {
  const c = launch(bin, ['--version'], { platform });
  if (c.refused) return null;
  const v = await runProcess({ ...c, cwd: root, env: childEnv(env, platform), timeout: 30e3, platform });
  const m = /^(\d+)\./m.exec(v.output || '');
  return v.exit === 0 && m ? Number(m[1]) : null;
}

// A check line that runs other scripts — through a package manager (`npm run helper`, `pnpm lint`, `yarn helper`, `bun
// run x`) or a task runner (`turbo run`, `lerna run`, `nx run`, `npm-run-all`, `concurrently "pnpm:x"`) — would start
// their pre/post lines, which nunchi cannot switch off from outside (measured: a nested `pnpm run helper` ran
// prehelper). Such a check is not run, and the line says why. The line is split as the shell splits it (quotes,
// # comments, &&, ;, |), and only command words count: `echo "use npm run build"`, `tsc # pnpm test` and `node x.js
// npm` run nothing nested; running a binary (`npx tsc`, `pnpm exec`, `yarn dlx`, `bunx`) is fine.
// A script line as the shell would split it: simple commands (separated by &&, ||, ;, |, &, newlines and parentheses),
// each a list of words with quotes removed; a # that starts a word begins a comment to the end of the line. Enough to
// find the command words of a package.json script, not a shell.
export function commandsOf(line) {
  const cmds = [];
  let words = [], word = null, quote = null;
  const end = () => { if (word !== null) { words.push(word); word = null; } };
  const cut = () => { end(); if (words.length) cmds.push(words); words = []; };
  const s = String(line || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < s.length) word += s[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; word ??= ''; continue; }
    if (ch === '\\' && i + 1 < s.length) { word = (word ?? '') + s[++i]; continue; }
    if (ch === '#' && word === null) { while (i < s.length && s[i] !== '\n') i++; cut(); continue; }
    if (/[;&|()\n]/.test(ch)) { cut(); continue; }
    if (/\s/.test(ch)) { end(); continue; }
    word = (word ?? '') + ch;
  }
  cut();
  return cmds;
}
const base = w => String(w).split(/[\\/]/).pop().replace(/\.(cmd|exe|ps1)$/i, '');
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NOT_A_RUN = new Set(['exec', 'dlx', 'x', 'add', 'install', 'i', 'ci', 'remove', 'rm', 'uninstall', 'outdated', 'audit', 'why', 'ls', 'list', 'pack', 'publish', 'version', 'config', 'help']);
const RUNNERS = new Set(['turbo', 'lerna', 'nx', 'npm-run-all', 'npm-run-all2', 'run-s', 'run-p', 'wireit', 'ultra']);
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'cross-env', 'dotenv', 'env', 'time', 'nice', 'nohup']);

// A check line that runs another script through a package manager or a task runner → what it calls, or null.
export function nestedRun(line, depth = 0) {
  for (const cmd of commandsOf(line)) {
    let w = cmd.slice();
    // FOO=bar before the command, and wrappers that run the rest as a command (npx turbo …, pnpm exec nx …)
    for (let guard = 0; guard < 8 && w.length; guard++) {
      while (w.length && /^[A-Za-z_][\w]*=/.test(w[0])) w.shift();
      if (!w.length) break;
      const c = base(w[0]);
      if (WRAPPERS.has(c)) { w = w.slice(1); while (w.length && w[0].startsWith('-')) w.shift(); continue; }
      if ((c === 'pnpm' || c === 'yarn') && ['exec', 'dlx'].includes(w[1])) { w = w.slice(2); continue; }
      if (c === 'bun' && w[1] === 'x') { w = w.slice(2); continue; }
      break;
    }
    if (!w.length) continue;
    const c = base(w[0]);
    const rest = w.slice(1).filter(x => !x.startsWith('-'));
    if (MANAGERS.has(c)) {
      const sub = rest[0];
      if (!sub || NOT_A_RUN.has(sub)) continue;
      return `${c} ${sub}`;
    }
    if (RUNNERS.has(c)) {
      if (w.slice(1).some(x => x === '--version' || x === '-v') && rest.length === 0) continue;
      return `${c}${rest[0] ? ` ${rest[0]}` : ''}`;
    }
    if (c === 'concurrently' || c === 'parallelshell') {
      for (const arg of w.slice(1)) {
        if (/^(npm|pnpm|yarn|bun):/.test(arg)) return `${c} "${arg}"`;
        if (depth < 2) { const inner = nestedRun(arg, depth + 1); if (inner) return `${c} "${inner}"`; }
      }
    }
  }
  return null;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export const cleanOutput = text => scrubSecrets(redactText(String(text || '').replace(ANSI, '')));

// The error count a check printed, when it says one (eslint, tsc, node:test, jest, vitest, a generic "N errors").
export function countOf(text) {
  const t = String(text || '');
  const pats = [/✖\s+(\d+)\s+problems?/g, /Found\s+(\d+)\s+errors?/g, /^# fail (\d+)/gm, /Tests?:\s+(\d+)\s+failed/g, /Tests?\s+(\d+)\s+failed/g, /\b(\d+)\s+(?:problems?|errors?|failures?|failed)\b/g];
  for (const re of pats) {
    let last = null;
    for (const m of t.matchAll(re)) last = Number(m[1]);
    if (last !== null) return last;
  }
  return null;
}

// Kills a process tree: its group on POSIX (it was started detached), taskkill /T on Windows.
// `run`: how taskkill is started (injected by tests, so the Windows path is checked on any machine).
export function killTree(child, platform = process.platform, { run = spawnSync, systemRoot = process.env.SystemRoot } = {}) {
  try {
    if (platform === 'win32') run(win32.join(systemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
// Every process on the machine as `ps` lists it (POSIX): [{ pid, ppid, start }] (`start` tells a pid reused later).
export function listProcs() {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(r.stdout || '').split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] }));
  } catch { return []; }
}
// The descendants of `root` in a process list, and of every process already `known` (pid → start) that is still the
// same process: a grandchild that detached (its own session) is found while its parent lives, and kept after.
// → Map pid → start.
export function descendantsOf(root, procs, known = new Map()) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const startOf = new Map(procs.map(p => [p.pid, p.start]));
  const out = new Map([...known].filter(([pid, start]) => startOf.get(pid) === start));
  const todo = [root, ...out.keys()];
  while (todo.length) for (const k of kids.get(todo.shift()) || []) if (!out.has(k.pid) && k.pid !== root) { out.set(k.pid, k.start); todo.push(k.pid); }
  return out;
}
// Watches a check's process tree (POSIX: `ps` now and then; the descendants it saw are remembered, so one that
// detached into its own session is still killed when the check ends). `kill(pid)`: its group, then itself.
export function treeWatcher(root, { platform = process.platform, procs = listProcs, every = 500, kill = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} } } = {}) {
  let seen = new Map(), t = null, first = null;
  const poll = () => { if (platform !== 'win32') seen = descendantsOf(root, procs(), seen); };
  if (platform !== 'win32') { first = setTimeout(poll, Math.min(100, every)); t = setInterval(poll, every); }
  return {
    poll,
    stop() { clearTimeout(first); clearInterval(t); },
    // every descendant seen that is still the same process
    killAll() { if (platform === 'win32') return []; poll(); const left = [...seen.keys()]; for (const pid of left) kill(pid); return left; },
  };
}
// → { exit, signal, timedOut, output, ms }
// The whole tree ends with the run (M3 review, round 2): on the timeout, and on a normal exit too, the check's process
// group is killed, and every descendant the watcher saw (a detached grandchild, `sleep 20 &` in its own session).
export function runProcess({ cmd, args, opts = {}, cwd, env, timeout = CHECK_TIMEOUT_MS, platform = process.platform, watch = treeWatcher }) {
  return new Promise(res => {
    const t0 = Date.now();
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
    catch (e) { res({ exit: null, signal: null, timedOut: false, output: cleanOutput(String(e.message)), ms: 0, error: true }); return; }
    const take = d => { out += d.toString('utf8'); if (out.length > 4 * OUTPUT_KEEP * 16) out = out.slice(-4 * OUTPUT_KEEP * 8); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const tree = watch(child.pid, { platform });
    let timedOut = false, done = false, grace = null;
    // a grandchild that keeps stdout open would hold `close` forever: the run ends at the process's own exit plus a
    // short grace for its last output, and on the timeout the tree is killed and the pipes are closed from this side
    const end = (exit, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(grace);
      tree.stop();
      killTree(child, platform);
      tree.killAll();
      for (const s of [child.stdout, child.stderr]) { try { s.destroy(); } catch {} }
      const text = cleanOutput(out);
      res({ exit, signal, timedOut, output: text.length > OUTPUT_KEEP ? text.slice(-OUTPUT_KEEP) : text, count: countOf(text), ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child, platform); grace = setTimeout(() => end(null, 'SIGKILL'), EXIT_GRACE_MS); }, timeout);
    child.on('error', e => { out += `\n${e.message}`; });
    child.on('exit', (exit, signal) => { clearTimeout(grace); grace = setTimeout(() => end(exit, signal), EXIT_GRACE_MS); });
    child.on('close', (exit, signal) => end(exit, signal));
  });
}

// Every check of the profile, in order. → { pm, results: { build: { status, exit, count, output, ms } | { status:
// 'missing' }, … } }. status: pass | fail | timeout | refused | missing.
export async function runChecks({ root, profile, env = process.env, platform = process.platform, timeout = CHECK_TIMEOUT_MS, names = CHECK_SCRIPTS }) {
  const pm = packageManagerOf(root, profile);
  const bin = findBinary(pm.name, { env, platform });
  // yarn without a packageManager field: its major version from the binary itself (the markers only guess)
  if (pm.name === 'yarn' && pm.from !== 'packageManager' && bin) {
    const major = await majorOf(bin, { root, env, platform });
    if (major !== null) Object.assign(pm, { major, from: 'yarn --version' });
  }
  const results = {};
  for (const name of names) {
    if (!profile || profile.scripts?.[name] === undefined) { results[name] = { status: 'missing' }; continue; }
    const nested = [`pre${name}`, name, `post${name}`].map(n => profile.scripts?.[n]).map(nestedRun).find(Boolean);
    if (nested) { results[name] = { status: 'refused', why: `its line runs other scripts (\`${nested}\`), whose pre/post lines nunchi cannot switch off. Put the commands in the ${name} line itself` }; continue; }
    const c = commandFor({ pm, script: name, bin, platform, profile });
    if (c.refused) { results[name] = { status: 'refused', why: c.refused }; continue; }
    const r = await runProcess({ ...c, cwd: root, env: childEnv(env, platform), timeout, platform });
    results[name] = { status: r.timedOut ? 'timeout' : r.exit === 0 ? 'pass' : 'fail', exit: r.exit, count: r.count ?? null, output: r.output, ms: r.ms };
  }
  return { pm: { name: pm.name, major: pm.major, from: pm.from, bin: bin ? 'found' : null }, results };
}

// Baseline against now (design §4.3): a check blocks the commit only when it newly fails, or its count rises.
// → { blocking: [name], lines: [text] } — the lines say each check plainly.
export function compareChecks(baseline = {}, now = {}) {
  const blocking = [], lines = [];
  const n = c => (Number.isInteger(c?.count) ? c.count : null);
  const what = c => (n(c) !== null ? ` (${n(c)} problem${n(c) === 1 ? '' : 's'})` : '');
  for (const name of CHECK_SCRIPTS) {
    const b = baseline[name] || { status: 'missing' }, c = now[name] || { status: 'missing' };
    if (c.status === 'missing' && b.status !== 'missing') { blocking.push(name); lines.push(`${name} was there when the fix started and is gone now: put it back before committing.`); continue; }
    if (c.status === 'missing') { lines.push(`no ${name} script — nunchi relies on re-capture.`); continue; }
    if (c.status === 'refused') { lines.push(`${name} not run: ${c.why}.`); if (b.status !== 'refused' && b.status !== 'missing') blocking.push(name); continue; }
    if (c.status === 'pass') { lines.push(`${name} passes.`); continue; }
    const failing = c.status === 'fail' || c.status === 'timeout';
    if (!failing) continue;
    const timedOut = c.status === 'timeout' ? ' (timed out after 10 minutes)' : '';
    if (b.status === 'pass' || b.status === 'missing' || b.status === 'refused') { blocking.push(name); lines.push(`${name} newly fails${what(c)}${timedOut}: fix it before committing.`); continue; }
    if (n(b) !== null && n(c) !== null && n(c) > n(b)) { blocking.push(name); lines.push(`${name} was already failing before this fix${what(b)}, and now has ${n(c)}: fix the new ones before committing.`); continue; }
    // a suite that crashed instead of failing: no count where there was one, another exit, a timeout where there was none
    if (n(b) !== null && n(c) === null) { blocking.push(name); lines.push(`${name} was already failing before this fix${what(b)}, and now fails without saying how many (it may have crashed)${timedOut}: look at it before committing.`); continue; }
    if (c.status !== b.status || (Number.isInteger(b.exit) && Number.isInteger(c.exit) && b.exit !== c.exit)) { blocking.push(name); lines.push(`${name} was already failing before this fix, but now fails another way (${c.status === 'timeout' ? 'it timed out' : `exit ${c.exit ?? c.signal ?? '?'} instead of ${b.exit ?? '?'}`}): look at it before committing.`); continue; }
    lines.push(`${name} was already failing before this fix${what(b)} — not blocking${n(c) !== null ? `; ${n(b) === n(c) ? 'still' : 'now'} ${n(c)} after` : ''}.`);
  }
  return { blocking, lines };
}
