#!/usr/bin/env node
// The fix-loop gate harness (design 0.1-c §9.4): runs nunchi's fix loop on a benchmark app with recorded fixes, so the
// gate can be measured later. It prints what the engine said for each seed; it claims nothing about the gate (the gate
// is pre-registered and run apart: docs/prereg-fix.md, its own sample and the detector-sensitivity sets).
//
//   node bench/fix-gate.mjs [--app <dir>] [--fixes <file>] [--seeds P03,P18] [--fresh] [--keep]
//     --app    the benchmark app (default bench/pebble); its bench.json says how to install it, its samples and login
//     --fixes  the recorded fixes (default bench/fixes/<name>.json): per seed, the edits a fixer would make
//     --fresh  each seed is an independent trial from a fresh copy (§9.4); default: one sequential pass on one copy
//     --keep   leave the copies in place (their paths are printed)
//
// Per trial: a fresh git repository of the app (dependencies hard-linked from the app folder), the check profile approved
// by the operator running this script (their own terminal: channel cli-tty), the app built and served once for a
// sweep (`nunchi capture --network record`), the seeds' groups (found by rule, route and match) decided Fix as the AI
// would record it from chat, `fix --plan`; then per seed: `fix --start --serve start` (baseline checks, P0); the recorded edit;
// `fix --checks`; one commit with the trailers it printed; `fix --verify --serve start` (P1, the judgement). The engine's
// own lines are printed as they are, then a table and `fix --summary`.
// Needs Chromium (NUNCHI_BROWSER or `nunchi setup`) and npm.
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { approveProfile, checkProfile, scriptsApprovedPath } from '../src/checks.mjs';
import { stateOf } from '../src/project.mjs';
import { freePort } from '../src/fix/probe.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.mjs');
const arg = (name, fallback = null) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const APP = resolve(arg('--app', join(HERE, 'pebble')));
const BENCH = JSON.parse(readFileSync(join(APP, 'bench.json'), 'utf8'));
const FIXES = JSON.parse(readFileSync(resolve(arg('--fixes', join(HERE, 'fixes', `${BENCH.name}.json`))), 'utf8'));
const only = arg('--seeds') ? new Set(arg('--seeds').split(',').map(s => s.trim())) : null;
const seeds = FIXES.fixes.filter(f => !only || only.has(f.seed));
const fresh = process.argv.includes('--fresh'), keep = process.argv.includes('--keep');
const log = m => process.stderr.write(m + '\n');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
const git = (cwd, ...a) => sh('git', ['-c', 'user.name=fix-gate', '-c', 'user.email=fix-gate@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd }).trim();
const nunchi = (cwd, ...a) => {
  try { return { code: 0, out: sh(process.execPath, [CLI, ...a], { cwd, timeout: 20 * 60e3 }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
const json = r => { try { return JSON.parse(r.out); } catch { return { code: r.code, lines: r.out.trim().split('\n') }; } };

if (!existsSync(join(APP, BENCH.installed))) { log('installing the app\'s dependencies (first run only)…'); sh(BENCH.install[0], BENCH.install.slice(1), { cwd: APP, stdio: 'inherit' }); }

// A fresh copy of the app as a git repository: sources only, dependencies hard-linked, nunchi's files and builds ignored.
function freshCopy() {
  const base = mkdtempSync(join(tmpdir(), `nunchi-fix-gate-${BENCH.name}-`));
  try { return makeCopy(base); } catch (e) { rmSync(base, { recursive: true, force: true }); throw e; }
}
function makeCopy(base) {
  const root = join(base, BENCH.name);
  cpSync(APP, root, { recursive: true, filter: src => !/[\\/](node_modules|\.next|out|dist)$/.test(src) && basename(src) !== 'next-env.d.ts' });
  // Turbopack refuses a node_modules symlink that leaves the project, so the dependencies are hard-linked (no extra
  // space) where `cp -al` exists, copied otherwise.
  try { sh('cp', ['-al', join(APP, 'node_modules'), join(root, 'node_modules')]); }
  catch { rmSync(join(root, 'node_modules'), { recursive: true, force: true }); cpSync(join(APP, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true }); }
  writeFileSync(join(root, '.gitignore'), 'node_modules\n.next/\nnext-env.d.ts\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'fix-gate');
  git(root, 'config', 'user.email', 'fix-gate@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `${BENCH.name}: the benchmark app`);
  mkdirSync(join(root, '.nunchi'), { recursive: true });
  writeFileSync(join(root, '.nunchi', 'samples.json'), JSON.stringify(BENCH.samples || {}));
  if (BENCH.auth) writeFileSync(join(root, '.nunchi', 'auth.json'), JSON.stringify(BENCH.auth));
  // the operator approves the check profile in their own terminal (this script is their run of the gate)
  const st = stateOf(join(root, '.nunchi'));
  approveProfile(scriptsApprovedPath(st.root.dir), root, { seen: checkProfile(root).hash, channel: 'cli-tty', by: 'fix-gate operator' });
  return { base, root };
}

// Build and serve the copy once, capture the sweep the fixes start from, stop the server.
async function sweep(root) {
  const port = await freePort();
  const env = { ...process.env, ...(BENCH.env || {}) };
  if (BENCH.build) sh(BENCH.build[0], BENCH.build.slice(1), { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const start = BENCH.start.map(x => x.replace('{port}', String(port)));
  const server = spawn(start[0], start.slice(1), { cwd: root, env, stdio: 'ignore', detached: process.platform !== 'win32' });
  const stop = () => { try { process.platform === 'win32' ? server.kill() : process.kill(-server.pid, 'SIGTERM'); } catch {} };
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(url + BENCH.ready)).ok) break; } catch {} await delay(200); }
    const r = nunchi(root, 'capture', '--url', url, '--root', root, '--samples', '.nunchi/samples.json', '--network', 'record', '--json');
    if (r.code) throw new Error(`the sweep failed: ${r.out.slice(-800)}`);
    return url;
  } finally { stop(); }
}

function groupOf(root, fix) {
  const gs = JSON.parse(nunchi(root, 'findings', '--all', '--json').out).groups;
  const hits = gs.filter(g => g.rule === fix.rule && (fix.route === null ? !g.routes.length : g.routes.includes(fix.route))
    && (!fix.match || Object.entries(fix.match).every(([k, v]) => String(g.example?.evidence?.[k] ?? '') === v)));
  return hits.length === 1 ? hits[0] : { error: `${hits.length} groups match ${fix.rule} on ${fix.route}` };
}

// The seeds' groups decided Fix (as the AI records a decision from chat), then the fix plan the batch line reports on.
function plan(copy, fixes) {
  for (const fix of fixes) { const g = groupOf(copy.root, fix); if (!g.error) nunchi(copy.root, 'decide', g.group, 'fix', '--from-chat'); }
  for (const l of json(nunchi(copy.root, 'fix', '--plan', '--json')).lines || []) log(`  ${l}`);
}

async function trial(copy, fix) {
  const t0 = Date.now();
  const g = groupOf(copy.root, fix);
  if (g.error) return { seed: fix.seed, outcome: 'harness: no group', line: g.error, ms: Date.now() - t0 };
  const start = json(nunchi(copy.root, 'fix', '--start', g.group, '--serve', 'start', '--agent', 'fix-gate harness', '--json'));
  if (start.code) return { seed: fix.seed, group: g.group, outcome: 'start refused', line: (start.lines || []).join(' / ').slice(0, 300), ms: Date.now() - t0 };
  for (const e of fix.edits) {
    const p = join(copy.root, e.file);
    const text = readFileSync(p, 'utf8');
    if (!text.includes(e.from)) return { seed: fix.seed, group: g.group, outcome: 'harness: edit does not apply', line: `${e.file}: ${e.from}`, ms: Date.now() - t0 };
    writeFileSync(p, text.replace(e.from, e.to));
  }
  const checks = json(nunchi(copy.root, 'fix', '--checks', g.group, '--json'));
  for (const l of checks.lines || []) log(`    ${l}`);
  if (checks.code) return { seed: fix.seed, group: g.group, outcome: 'checks block', line: (checks.lines || []).slice(-1)[0], ms: Date.now() - t0 };
  git(copy.root, 'add', '--', ...fix.edits.map(e => e.file));
  git(copy.root, 'commit', '-q', '-m', `Fix ${fix.seed}: ${fix.rule} on ${fix.route}`, '-m', checks.trailers.join('\n'));
  const v = json(nunchi(copy.root, 'fix', '--verify', g.group, '--serve', 'start', '--json'));
  return { seed: fix.seed, group: g.group, outcome: v.outcome ? `${v.outcome}${v.needsYou ? ` (${v.needsYou})` : ''}` : `exit ${v.code}`, line: (v.lines || []).join(' / '), ms: Date.now() - t0 };
}

const results = [];
let copy = null;
const copies = [];
try {
  for (const fix of seeds) {
    if (!copy || fresh) {
      copy = freshCopy();
      copies.push(copy);
      log(`copy: ${copy.root}`);
      log('building and capturing the sweep…');
      await sweep(copy.root);
      plan(copy, fresh ? [fix] : seeds);
    }
    log(`${fix.seed} (${fix.rule} on ${fix.route})…`);
    const r = await trial(copy, fix);
    log(`  → ${r.outcome}: ${r.line}`);
    results.push(r);
  }
  const summary = copy ? nunchi(copy.root, 'fix', '--summary').out.trim() : '';
  console.log(`fix-gate harness · ${BENCH.name} · ${results.length} seed(s) · ${fresh ? 'independent trials' : 'one sequential pass'}`);
  console.log('seed  outcome                 seconds  what the engine said');
  for (const r of results) console.log(`${r.seed.padEnd(5)} ${r.outcome.padEnd(23)} ${String(Math.round(r.ms / 1000)).padStart(7)}  ${r.line}`);
  if (summary) console.log(`batch${fresh ? ' (the last trial)' : ''}: ${summary}`);
  console.log('A harness run, not the gate: the gate is pre-registered and measured apart (design §9.4).');
} finally {
  if (!keep) for (const c of copies) rmSync(c.base, { recursive: true, force: true });
  else for (const c of copies) console.log(`kept: ${c.root}`);
}
