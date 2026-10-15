// Runs (spec §2.4): every capture writes into its own folder, `.nunchi/runs/<id>.partial`, renamed to
// `.nunchi/runs/<id>` only when complete, so a reader never sees half a run and a crash leaves the
// previous run intact. Ids are sequential numbers (deterministic, no clock). `latest` names the newest
// complete run and is replaced atomically.
import { readdirSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, lstatSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeAtomic, retryBusy, io, privateDir, setMode, refuseLink, withLock, stableJson } from './stable.mjs';

// Windows refuses renames, removals and new folders for a moment while another capture or reader is busy in the
// same folder (EPERM, EACCES, EBUSY): those are retried with backoff (retryBusy).
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 };

const ID = /^\d{4,}$/;
const PARTIAL = /^(\d{4,})\.partial$/;

export function listRuns(dir) {
  if (!existsSync(dir)) return { complete: [], partial: [] };
  const names = readdirSync(dir);
  return {
    complete: names.filter(n => ID.test(n)).sort(),
    partial: names.filter(n => PARTIAL.test(n)).sort(),
  };
}

// A run's kind (run.json `kind`; a run without one is a sweep). Fix probes (design §4.4) are runs too, kept apart: never
// `latest`, hidden from `nunchi runs`, removed first by `gc`.
export function runKind(dir, id) {
  try { const k = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8'))?.kind; return typeof k === 'string' ? k : 'sweep'; } catch { return 'sweep'; }
}
export function latestRun(dir) {
  const f = join(dir, 'latest');
  let id = null;
  try { id = retryBusy(() => readFileSync(f, 'utf8'), 1000).trim(); } catch {}            // absent, or replaced right now
  if (id && ID.test(id) && existsSync(join(dir, id))) return id;
  const { complete } = listRuns(dir);
  const runs = complete.filter(r => runKind(dir, r) !== 'fix-probe');
  return runs.length ? runs[runs.length - 1] : null;
}
// The latest run that is not a quick first look (design 0.1-c §6: hunt, verify and what builds on them default to it):
// `latest` when it names a sweep, else the newest complete sweep. Null when there is none (only quick runs so far).
export function latestSweep(dir) {
  const id = latestRun(dir);
  if (id && runKind(dir, id) === 'sweep') return id;
  const runs = listRuns(dir).complete.filter(r => runKind(dir, r) === 'sweep');
  return runs.length ? runs[runs.length - 1] : null;
}

// How far a capture that is still being written has come (design §6): `<id>.partial/progress.json`, written by the CLI
// after each route × person × viewport and removed before the run is complete (and, with the whole `.partial` folder,
// when the capture fails or is stopped). Read as data from a folder the user's own captures write: a link, a folder or
// a file over 64 KB is not read, and every field is checked.
export const PROGRESS_FILE = 'progress.json';
// A capture that was killed (no exit handler ran) leaves its `.partial` folder: it is not "running" once its writer is
// gone (a progress file names its pid and host; on this host a pid that no longer runs is gone) or it made no progress
// for STALE_MS (review of PR #33). A folder without a progress file (a fix probe, a capture of an older nunchi) counts
// by the folder's own time.
// *No progress* (M5b): its last progress is the progress file's modification time (the CLI rewrites it after each route ×
// person × viewport), or the folder's own when it has none yet; a capture has made no progress for STALE_MS when
// now − that time ≥ STALE_MS (9:59 is still running, 10:00 is not).
export const STALE_MS = 10 * 60e3;
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Every `.partial` folder that is a capture the board can speak of, oldest first: → [{ run, state: 'running' |
// 'stopped', why, progress: { kind, wholeApp, routesGiven, routes, done, routeMs, skipped } | null }].
// `stopped` (M5b): a capture of `nunchi capture` (its folder has a progress file) that is not running any more: `why` is
// 'no-progress' (none for STALE_MS) or 'ended' (sooner: its writer, on this host, no longer runs). A folder without a
// progress file is running by its own time and is never called stopped: a fix probe's attempt says when it was
// interrupted (§6.3). A link, a folder, a progress file over 64 KB or one that does not parse is not read.
// `now`, `alive` and `host` are the clock, the process check and this machine's name (a test's own).
export function captureStates(dir, { now = Date.now(), alive = pidAlive, host = hostname() } = {}) {
  const out = [];
  for (const p of listRuns(dir).partial) {
    const run = PARTIAL.exec(p)[1];
    try {
      const folder = lstatSync(join(dir, p));
      if (!folder.isDirectory()) continue;                                      // a link is not followed
      const f = join(dir, p, PROGRESS_FILE);
      let st = null;
      try { st = lstatSync(f); } catch {}
      if (!st) { if (now - folder.mtimeMs < STALE_MS) out.push({ run, state: 'running', why: null, progress: null }); continue; }
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      const quiet = now - st.mtimeMs >= STALE_MS;
      const gone = Number.isInteger(doc?.pid) && doc.pid > 0 && doc.host === host && !alive(doc.pid);
      const state = quiet || gone ? 'stopped' : 'running', why = quiet ? 'no-progress' : gone ? 'ended' : null;
      const count = n => (Number.isInteger(n) && n >= 0 ? n : null);
      const routes = count(doc?.routes), done = count(doc?.done);
      if (routes === null || done === null || done > routes || typeof doc.kind !== 'string') { out.push({ run, state, why, progress: null }); continue; }
      const routeMs = Array.isArray(doc.routeMs) ? doc.routeMs.filter(x => Number.isFinite(x) && x >= 0).slice(0, done) : [];
      const skipped = Array.isArray(doc.skipped) ? doc.skipped.filter(s => s && typeof s.route === 'string' && typeof s.reason === 'string').slice(0, 200).map(s => ({ route: s.route, reason: s.reason })) : [];
      out.push({ run, state, why, progress: { kind: doc.kind, wholeApp: doc.wholeApp === true, routesGiven: doc.routesGiven === true, routes, done, routeMs, skipped } });
    } catch {}
  }
  return out;
}
// → [{ run, progress }] for the runs still being written (captureStates' running ones), oldest first.
export const runningCaptures = (dir, opts) => captureStates(dir, opts).filter(c => c.state === 'running').map(({ run, progress }) => ({ run, progress }));

// Reserves the next id. mkdir without `recursive` fails if the folder exists, so two captures started
// at the same moment get different ids. A capture that finished between the listing and the mkdir has already
// renamed its `<id>.partial` to `<id>`: the id is taken, so the folder just made is removed and the next id tried.
// Runs hold screenshots and data of signed-in screens: the runs folder and each run are owner-only (D12) whatever
// the umask, a runs folder an older version made included.
// `ids`: in a repository, the shared state's run-id counter (state.mjs; design §7). Worktrees share one ledger but
// each keeps its own runs, so the next id is taken after every id any worktree used, under the counter's lock, and
// run ids stay one sequence the ledger can order. A counter that cannot be read counts as 0 (the runs folder still
// gives the floor); folds are keyed by worktree too, so a collision is never mistaken for a folded run.
export function startRun(dir, { ids = null } = {}) {
  privateDir(dir);
  setMode(dir, 0o700);
  const highest = () => {
    const { complete, partial } = listRuns(dir);
    return Math.max(0, ...complete.map(Number), ...partial.map(p => Number(PARTIAL.exec(p)[1])));
  };
  if (!ids) return reserve(dir, highest());
  return withLock(ids, () => {
    let used = 0;
    try { const doc = JSON.parse(readFileSync(ids, 'utf8')); if (Number.isInteger(doc?.last) && doc.last > 0) used = doc.last; } catch {}
    const r = reserve(dir, Math.max(used, highest()));
    refuseLink(ids);
    writeAtomic(ids, stableJson({ schema: 1, note: 'the last run id any worktree of this repository used', last: Number(r.id) }), { mode: 0o600 });
    return r;
  });
}
function reserve(dir, after) {
  let n = after;
  for (;;) {
    const id = String(++n).padStart(4, '0');
    if (existsSync(join(dir, id))) continue;
    const path = join(dir, `${id}.partial`);
    try { retryBusy(() => mkdirSync(path, { mode: 0o700 })); } catch (e) { if (e.code !== 'EEXIST') throw e; continue; }
    if (existsSync(join(dir, id))) { rmSync(path, RM); continue; }
    setMode(path, 0o700);
    return { id, path, parent: latestRun(dir) };
  }
}

// `latest` is a pointer for convenience: replaced atomically, and when several captures finish at once the last
// write wins; a write that still fails is not fatal (latestRun falls back to the newest complete run).
// `latest: false` (fix probes) leaves the pointer where it is.
export function finishRun(dir, id, { latest = true } = {}) {
  const final = join(dir, id);
  retryBusy(() => io.rename(join(dir, `${id}.partial`), final));
  if (latest) { try { writeAtomic(join(dir, 'latest'), id + '\n', { mode: 0o600 }); } catch {} }
  return final;
}

// Keeps the newest `keep` complete runs (and `latest`); removes older runs and partial folders that
// nothing has written to for `staleMs`. With `folded` (the runs the ledger holds), a complete run the ledger has
// not folded is never removed. `pinned` (design §8.1): runs an open item still names (its last sighting, the
// evidence a re-check compares with) are kept too.
// Fix probes are removed first (design §3.4): they never count towards `keep`, and only a probe an open attempt
// pins (`pinned`) stays. So are quick runs a sweep came after (design §6): the first look was replaced by a check of
// the app, and a run an open item still names (what only the quick run saw) is pinned; a quick run with no sweep after
// it counts like any other run.
export function gcRuns(dir, { keep = 5, staleMs = 3600e3, now = Date.now(), folded = null, pinned = null } = {}) {
  const { complete, partial } = listRuns(dir);
  const latest = latestRun(dir);
  const kinds = new Map(complete.map(id => [id, runKind(dir, id)]));
  const sweeps = complete.filter(id => kinds.get(id) === 'sweep');
  const lastSweep = sweeps[sweeps.length - 1] ?? null;
  const probe = new Set(complete.filter(id => kinds.get(id) === 'fix-probe'));
  const replaced = new Set(complete.filter(id => kinds.get(id) === 'quick' && lastSweep !== null && Number(id) < Number(lastSweep)));
  const keepSet = new Set(complete.filter(id => !probe.has(id) && !replaced.has(id)).slice(-keep));
  if (latest) keepSet.add(latest);
  if (folded) for (const id of complete) if (!folded.has(id) && !probe.has(id)) keepSet.add(id);
  if (pinned) for (const id of complete) if (pinned.has(id)) keepSet.add(id);
  const removed = [];
  for (const id of complete) if (!keepSet.has(id)) { rmSync(join(dir, id), RM); removed.push(id); }
  for (const p of partial) {
    if (now - statSync(join(dir, p)).mtimeMs < staleMs) continue;
    rmSync(join(dir, p), RM); removed.push(p);
  }
  return { kept: [...keepSet].sort(), removed };
}

// Git with the repository's own programs switched off (design §4.7, D9). A repository's config can name an
// external diff, a textconv or diff driver, a clean filter, an fsmonitor hook or a hooks folder; a plain
// `git diff` runs them, and their output stands in for the real diff. nunchi only reads, so none may run:
// - config overrides for the fixed ones, and every filter driver the config defines gets its commands emptied.
//   They go in as GIT_CONFIG_COUNT/KEY_n/VALUE_n (git ≥ 2.31), which take any key: `-c` cannot name a filter
//   called `a=b`. Older git, or a filter command still set after the overrides, fails closed (GIT_UNSAFE):
//   workTree then reports no repository and --changed-since refuses;
// - diffs take DIFF_SAFE: no external diff, no textconv, and no git run inside a submodule (whose own config
//   could name other programs), so an edit inside a submodule is not seen;
// - no optional locks: the index is never rewritten, so no post-index-change hook;
// - the caller's GIT_* variables are dropped, except where its config files are (GIT_CONFIG_SYSTEM, GIT_CONFIG_GLOBAL,
//   GIT_CONFIG_NOSYSTEM: the overrides outrank every file); no pager, no prompt; a timeout.
// System config is read (M3 review, 2026-10-15 KST): a system `commit.gpgsign=true` or Git for Windows' `core.autocrlf`
// are the person's settings, and dropping them made unsigned commits and phantom edits. Only the keys above are
// neutralised, through the overrides, which outrank the system file as they outrank the repository's.
export const DIFF_SAFE = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
// core.hooksPath=/dev/null means "no hooks" on POSIX; Git for Windows reads it as C:\dev\null, a folder anyone could
// make, so there it is an empty folder of nunchi's own (made once per process, mode 0700, removed at exit).
let noHooksDir = null;
export function noHooksPath(platform = process.platform) {
  if (platform !== 'win32') return '/dev/null';
  if (!noHooksDir) {
    noHooksDir = mkdtempSync(join(tmpdir(), 'nunchi-nohooks-'));
    process.once('exit', () => { try { rmSync(noHooksDir, { recursive: true, force: true }); } catch {} });
  }
  return noHooksDir.replace(/\\/g, '/');
}
export const gitOverrides = (platform = process.platform) => [['core.fsmonitor', 'false'], ['core.hooksPath', noHooksPath(platform)], ['diff.external', ''], ['core.pager', 'cat']];
const PASS_GIT = new Set(['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);
export function gitEnv(env = process.env, overrides = gitOverrides()) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k) || PASS_GIT.has(k)) out[k] = v;
  out.GIT_CONFIG_COUNT = String(overrides.length);
  overrides.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
}
const gitUnsafe = why => Object.assign(new Error(`git cannot be run safely here: ${why}`), { code: 'GIT_UNSAFE' });
// → git(args, { encoding }) for one repository. Throws like execFileSync when git fails, GIT_UNSAFE when its
// programs cannot be switched off.
// A call may add `env` (only GIT_INDEX_FILE, a temporary index the fix loop hashes a working tree with) and its own
// `timeout`.
const CALL_ENV = new Set(['GIT_INDEX_FILE']);
export function gitRunner(root, { timeout = 60_000 } = {}) {
  const opts = (env, t = timeout) => ({ env, timeout: t, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const version = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], opts(gitEnv(process.env, []))).toString());
  if (!version || +version[1] < 2 || (+version[1] === 2 && +version[2] < 31)) throw gitUnsafe(`git ${version ? version[0] : '(unknown)'} is older than 2.31`);
  const run = (args, overrides, extra = {}) => {
    const env = gitEnv(process.env, overrides);
    for (const [k, v] of Object.entries(extra.env || {})) { if (!CALL_ENV.has(k)) throw new Error(`git: ${k} is not a variable a call may set`); env[k] = v; }
    const o = opts(env, extra.timeout ?? timeout);
    if (extra.input !== undefined) { o.input = extra.input; o.stdio = ['pipe', 'pipe', 'pipe']; }
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], o);
  };
  const config = (re, overrides) => {                                 // [key, value] in the order git reads them
    try { return run(['config', '-z', '--get-regexp', re], overrides).toString().split('\0').filter(Boolean).map(e => { const i = e.indexOf('\n'); return i < 0 ? [e, ''] : [e.slice(0, i), e.slice(i + 1)]; }); }
    catch (e) { if (e.status === 1) return []; throw e; }             // exit 1: no such key
  };
  const base = gitOverrides();
  const names = [...new Set(config('^filter\\.', base).map(([k]) => /^filter\.([\s\S]+)\.(clean|smudge|process|required)$/i.exec(k)?.[1]).filter(n => n !== undefined))].sort();
  const overrides = [...base, ...names.flatMap(n => [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']].map(([x, v]) => [`filter.${n}.${x}`, v]))];
  if (names.length) {
    const last = new Map(config('^filter\\..*\\.(clean|smudge|process)$', overrides));
    const live = [...last].filter(([, v]) => v !== '').map(([k]) => k);
    if (live.length) throw gitUnsafe(`filter commands still set: ${live.join(', ')}`);
  }
  return (args, { encoding, env, timeout: t, input } = {}) => { const out = run(args, overrides, { env, timeout: t, input }); return encoding ? out.toString(encoding) : out; };
}

// What the app's source looked like when it was captured. `tree` changes with any edit, committed or
// not, so "evidence is from the code you have now" can be checked without the user committing.
// nunchi's own folder is left out so writing a run does not make the tree look edited.
export function workTree(root) {
  try {
    const git = gitRunner(root);
    const commit = git(['rev-parse', 'HEAD']).toString().trim();
    const outside = ':(exclude,glob)**/.nunchi/**';
    const diff = git(['diff', ...DIFF_SAFE, 'HEAD', '--binary', '--', '.', outside]);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', outside]).toString().split('\0').filter(Boolean).sort();
    const h = createHash('sha256').update(commit).update('\0').update(diff);
    for (const f of untracked) {
      h.update('\0' + f + '\0');
      try { h.update(readFileSync(join(root, f))); } catch {}
    }
    return { commit, dirty: diff.length > 0 || untracked.length > 0, tree: h.digest('hex').slice(0, 16), repo: true };
  } catch {
    return { commit: null, dirty: null, tree: null, repo: false };
  }
}

// `.nunchi/.gitignore`: evidence, runs, recordings, login state and volatile state are local only.
export const IGNORED = ['auth.json', 'evidence/', 'har/', 'runs/', 'state/'];
export function ensureGitignore(nunchiDir) {
  mkdirSync(nunchiDir, { recursive: true });
  const f = join(nunchiDir, '.gitignore');
  const have = existsSync(f) ? readFileSync(f, 'utf8').split('\n').map(l => l.trim()) : [];
  const missing = IGNORED.filter(l => !have.includes(l));
  if (missing.length) appendFileSync(f, (have.length && have[have.length - 1] !== '' ? '\n' : '') + missing.join('\n') + '\n');
}

// The same paths are owner-only (D12). The folders a command writes into (`create`; capture: har, runs, state)
// are made 0700 before it starts, so the ledger's first write lands in a private folder; what an older version
// wrote with the default umask is tightened. A symbolic link among them is refused (UNSAFE_PATH), never followed.
export function ensurePrivate(nunchiDir, create = ['har/', 'runs/', 'state/']) {
  for (const p of IGNORED) {
    const f = join(nunchiDir, p.replace(/\/$/, ''));            // no trailing slash: lstat must see a link
    refuseLink(f);
    if (create.includes(p)) privateDir(f);
    if (existsSync(f)) setMode(f, p.endsWith('/') ? 0o700 : 0o600);
  }
}

// `.nunchi/config.json`, written by the user and never by an agent (D10): `allowHosts` lists the preview or
// staging hosts capture may visit besides local and private addresses. A file that does not parse or has the
// wrong shape is an error, never read as "nothing listed".
export function readConfig(nunchiDir) {
  const f = join(nunchiDir, 'config.json');
  if (!existsSync(f)) return { allowHosts: [] };
  const bad = why => Object.assign(new Error(`${f}: ${why}`), { code: 'BAD_CONFIG' });
  let c;
  try { c = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw bad(`not valid JSON (${String(e.message).split('\n')[0]})`); }
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('expected an object, e.g. {"allowHosts": ["preview.example.dev"]}');
  const hosts = c.allowHosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every(h => typeof h === 'string' && h.trim())) throw bad('allowHosts must be a list of host names, e.g. ["preview.example.dev"]');
  return { ...c, allowHosts: hosts.map(h => h.trim()) };
}
