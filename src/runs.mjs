// Runs (spec §2.4): every capture writes into its own folder, `.nunchi/runs/<id>.partial`, renamed to
// `.nunchi/runs/<id>` only when complete, so a reader never sees half a run and a crash leaves the
// previous run intact. Ids are sequential numbers (deterministic, no clock). `latest` names the newest
// complete run and is replaced atomically.
import { readdirSync, mkdirSync, renameSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
// at the same moment get different ids. A capture that finished between the listing and the mkdir has already
// renamed its `<id>.partial` to `<id>`: the id is taken, so the folder just made is removed and the next id tried.
export function startRun(dir) {
  mkdirSync(dir, { recursive: true });
  const { complete, partial } = listRuns(dir);
  let n = Math.max(0, ...complete.map(Number), ...partial.map(p => Number(PARTIAL.exec(p)[1])));
  for (;;) {
    const id = String(++n).padStart(4, '0');
    if (existsSync(join(dir, id))) continue;
    const path = join(dir, `${id}.partial`);
    try { mkdirSync(path); } catch (e) { if (e.code !== 'EEXIST') throw e; continue; }
    if (existsSync(join(dir, id))) { rmSync(path, { recursive: true, force: true }); continue; }
    return { id, path, parent: latestRun(dir) };
  }
}

export function finishRun(dir, id) {
  const final = join(dir, id);
  renameSync(join(dir, `${id}.partial`), final);
  const tmp = join(dir, `latest.${process.pid}.tmp`);
  writeFileSync(tmp, id + '\n');
  renameSync(tmp, join(dir, 'latest'));
  return final;
}

// Keeps the newest `keep` complete runs (and `latest`); removes older runs and partial folders that
// nothing has written to for `staleMs`. Runs referenced by open reviews will be kept too (0.1-c). With
// `folded` (the runs the ledger holds), a complete run the ledger has not folded is never removed.
export function gcRuns(dir, { keep = 5, staleMs = 3600e3, now = Date.now(), folded = null } = {}) {
  const { complete, partial } = listRuns(dir);
  const latest = latestRun(dir);
  const keepSet = new Set(complete.slice(-keep));
  if (latest) keepSet.add(latest);
  if (folded) for (const id of complete) if (!folded.has(id)) keepSet.add(id);
  const removed = [];
  for (const id of complete) if (!keepSet.has(id)) { rmSync(join(dir, id), { recursive: true, force: true }); removed.push(id); }
  for (const p of partial) {
    if (now - statSync(join(dir, p)).mtimeMs < staleMs) continue;
    rmSync(join(dir, p), { recursive: true, force: true }); removed.push(p);
  }
  return { kept: [...keepSet].sort(), removed };
}

// What the app's source looked like when it was captured. `tree` changes with any edit, committed or
// not, so "evidence is from the code you have now" can be checked without the user committing.
// nunchi's own folder is left out so writing a run does not make the tree look edited.
export function workTree(root) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  try {
    const commit = git(['rev-parse', 'HEAD']).toString().trim();
    const outside = ':(exclude,glob)**/.nunchi/**';
    const diff = git(['diff', 'HEAD', '--binary', '--', '.', outside]);
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
