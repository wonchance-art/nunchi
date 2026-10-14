// Runs (spec §2.4): every capture writes into its own folder, `.nunchi/runs/<id>.partial`, renamed to
// `.nunchi/runs/<id>` only when complete, so a reader never sees half a run and a crash leaves the
// previous run intact. Ids are sequential numbers (deterministic, no clock). `latest` names the newest
// complete run and is replaced atomically.
import { readdirSync, mkdirSync, renameSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { privateDir, setMode } from './stable.mjs';

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

export function latestRun(dir) {
  const f = join(dir, 'latest');
  if (existsSync(f)) { const id = readFileSync(f, 'utf8').trim(); if (ID.test(id) && existsSync(join(dir, id))) return id; }
  const { complete } = listRuns(dir);
  return complete.length ? complete[complete.length - 1] : null;
}

// Reserves the next id. mkdir without `recursive` fails if the folder exists, so two captures started
// at the same moment get different ids. Runs hold screenshots and data of signed-in screens: the runs
// folder and each run are owner-only (D12) whatever the umask, a runs folder an older version made included.
export function startRun(dir) {
  privateDir(dir);
  setMode(dir, 0o700);
  const { complete, partial } = listRuns(dir);
  let n = Math.max(0, ...complete.map(Number), ...partial.map(p => Number(PARTIAL.exec(p)[1])));
  for (;;) {
    const id = String(++n).padStart(4, '0');
    if (existsSync(join(dir, id))) continue;
    const path = join(dir, `${id}.partial`);
    try { mkdirSync(path, { mode: 0o700 }); setMode(path, 0o700); return { id, path, parent: latestRun(dir) }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

export function finishRun(dir, id) {
  const final = join(dir, id);
  renameSync(join(dir, `${id}.partial`), final);
  const tmp = join(dir, `latest.${process.pid}.tmp`);
  writeFileSync(tmp, id + '\n', { mode: 0o600 });
  setMode(tmp, 0o600);
  renameSync(tmp, join(dir, 'latest'));
  return final;
}

// Keeps the newest `keep` complete runs (and `latest`); removes older runs and partial folders that
// nothing has written to for `staleMs`. Runs referenced by open reviews will be kept too (0.1-c).
export function gcRuns(dir, { keep = 5, staleMs = 3600e3, now = Date.now() } = {}) {
  const { complete, partial } = listRuns(dir);
  const latest = latestRun(dir);
  const keepSet = new Set(complete.slice(-keep));
  if (latest) keepSet.add(latest);
  const removed = [];
  for (const id of complete) if (!keepSet.has(id)) { rmSync(join(dir, id), { recursive: true, force: true }); removed.push(id); }
  for (const p of partial) {
    if (now - statSync(join(dir, p)).mtimeMs < staleMs) continue;
    rmSync(join(dir, p), { recursive: true, force: true }); removed.push(p);
  }
  return { kept: [...keepSet].sort(), removed };
}

// Git with the repository's own programs switched off (design §4.7, D9). A repository's config can name an
// external diff, a textconv or diff driver, a clean filter, an fsmonitor hook or a hooks folder; a plain
// `git diff` runs them, and their output stands in for the real diff. nunchi only reads, so none may run:
// - `-c` for the fixed ones, and every filter driver the config defines gets its commands emptied;
// - diffs take DIFF_SAFE: no external diff, no textconv, and no git run inside a submodule (whose own config
//   could name other programs), so an edit inside a submodule is not seen;
// - no optional locks: the index is never rewritten, so no post-index-change hook;
// - the caller's GIT_* variables are dropped; no system config, no pager, no prompt; a timeout.
export const DIFF_SAFE = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
const GIT_SAFE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat'];
export function gitEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^GIT_/i.test(k)) out[k] = v;
  return { ...out, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' };
}
// → git(args, { encoding }) for one repository. Throws like execFileSync when git fails.
export function gitRunner(root, { timeout = 60_000 } = {}) {
  const run = (args, extra = []) => execFileSync('git', [...GIT_SAFE, ...extra, '-C', root, ...args], { env: gitEnv(), timeout, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let filters = [];
  try {
    const names = run(['config', '--name-only', '--get-regexp', '^filter\\.']).toString().split('\n').map(k => /^filter\.(.+)\.(clean|smudge|process|required)$/i.exec(k.trim())?.[1]);
    filters = [...new Set(names.filter(n => n && !n.includes('=')))].sort()
      .flatMap(n => ['clean=', 'smudge=', 'process=', 'required=false'].flatMap(x => ['-c', `filter.${n}.${x}`]));
  } catch {}                                                          // no filter defined: git config exits 1
  return (args, { encoding } = {}) => { const out = run(args, filters); return encoding ? out.toString(encoding) : out; };
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

// The same paths are owner-only (D12). The folders capture writes into are made 0700 before it starts (the
// ledger state's too, so its first write lands in a private folder); what an older version wrote with the
// default umask is tightened.
export function ensurePrivate(nunchiDir) {
  for (const p of IGNORED) {
    const f = join(nunchiDir, p);
    try {
      if (p !== 'evidence/' && p.endsWith('/')) privateDir(f);
      if (existsSync(f)) setMode(f, p.endsWith('/') ? 0o700 : 0o600);
    } catch {}
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
