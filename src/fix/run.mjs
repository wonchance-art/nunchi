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
import { join, delimiter } from 'node:path';
import { scrubSecrets } from '../rules.mjs';
import { redactText } from '../network.mjs';
import { CHECK_SCRIPTS } from '../checks.mjs';

export const CHECK_TIMEOUT_MS = 10 * 60e3;
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
  if (platform === 'win32' && /\.cmd$/i.test(bin)) {
    // cmd expands %VAR% even inside quotes, and a quote would end ours: such a path is not run
    if (/["%\n]/.test(bin)) return { refused: `the path of ${pm.name} (${bin}) holds a character cmd.exe would read as its own` };
    const root = /^[A-Za-z]:\\[^"%&|<>^\n]*$/.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows';
    // /s strips the outer pair of quotes and keeps the rest as it is: the whole line goes in one more pair, as node
    // does for shell: true, so a path with spaces ("C:\Program Files\nodejs\npm.cmd") stays one word
    return { cmd: join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', `""${bin}" ${args.join(' ')}"`], opts: { windowsVerbatimArguments: true } };
  }
  return { cmd: bin, args, opts: {} };
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
export function killTree(child, platform = process.platform) {
  try {
    if (platform === 'win32') spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}
// → { exit, signal, timedOut, output, ms }
export function runProcess({ cmd, args, opts = {}, cwd, env, timeout = CHECK_TIMEOUT_MS, platform = process.platform }) {
  return new Promise(res => {
    const t0 = Date.now();
    let out = '';
    let child;
    try { child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
    catch (e) { res({ exit: null, signal: null, timedOut: false, output: cleanOutput(String(e.message)), ms: 0, error: true }); return; }
    const take = d => { out += d.toString('utf8'); if (out.length > 4 * OUTPUT_KEEP * 16) out = out.slice(-4 * OUTPUT_KEEP * 8); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child, platform); }, timeout);
    child.on('error', e => { out += `\n${e.message}`; });
    child.on('close', (exit, signal) => {
      clearTimeout(timer);
      const text = cleanOutput(out);
      res({ exit, signal, timedOut, output: text.length > OUTPUT_KEEP ? text.slice(-OUTPUT_KEEP) : text, count: countOf(text), ms: Date.now() - t0 });
    });
  });
}

// Every check of the profile, in order. → { pm, results: { build: { status, exit, count, output, ms } | { status:
// 'missing' }, … } }. status: pass | fail | timeout | refused | missing.
export async function runChecks({ root, profile, env = process.env, platform = process.platform, timeout = CHECK_TIMEOUT_MS, names = CHECK_SCRIPTS }) {
  const pm = packageManagerOf(root, profile);
  const bin = findBinary(pm.name, { env, platform });
  const results = {};
  for (const name of names) {
    if (!profile || profile.scripts?.[name] === undefined) { results[name] = { status: 'missing' }; continue; }
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
    if (c.status === 'missing') { lines.push(`no ${name} script — nunchi relies on re-capture.`); continue; }
    if (c.status === 'refused') { lines.push(`${name} not run: ${c.why}.`); if (b.status !== 'refused' && b.status !== 'missing') blocking.push(name); continue; }
    if (c.status === 'pass') { lines.push(`${name} passes.`); continue; }
    const failing = c.status === 'fail' || c.status === 'timeout';
    if (!failing) continue;
    const timedOut = c.status === 'timeout' ? ' (timed out after 10 minutes)' : '';
    if (b.status === 'pass' || b.status === 'missing' || b.status === 'refused') { blocking.push(name); lines.push(`${name} newly fails${what(c)}${timedOut}: fix it before committing.`); continue; }
    if (n(b) !== null && n(c) !== null && n(c) > n(b)) { blocking.push(name); lines.push(`${name} was already failing before this fix${what(b)}, and now has ${n(c)}: fix the new ones before committing.`); continue; }
    lines.push(`${name} was already failing before this fix${what(b)} — not blocking${n(c) !== null ? `; ${n(b) === n(c) ? 'still' : 'now'} ${n(c)} after` : ''}.`);
  }
  return { blocking, lines };
}
