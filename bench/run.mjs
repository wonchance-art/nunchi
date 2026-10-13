#!/usr/bin/env node
// Builds the benchmark app, captures it with the nunchi CLI exactly as a user would, and scores
// the result against the answer key. Usage: node bench/run.mjs [--app <dir>] [--twice]
//   --app    the benchmark app folder (default bench/pebble); its bench.json says how to install, build and
//            start it, which answer key scores it, the sample paths and the saved login
//   --twice  capture twice and check the evidence is byte-identical (determinism gate)
// Needs Chromium (NUNCHI_BROWSER or `node src/cli.mjs setup`) and network
// access to the npm registry for the first install.
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { score, reportMarkdown } from './score.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const argAt = process.argv.indexOf('--app');
const APP = argAt > 0 ? resolve(process.argv[argAt + 1]) : join(HERE, 'pebble');
const BENCH = JSON.parse(readFileSync(join(APP, 'bench.json'), 'utf8'));
const ANSWERS = JSON.parse(readFileSync(resolve(APP, BENCH.answers), 'utf8'));
const CLI = join(HERE, '..', 'src', 'cli.mjs');
const OUT = argAt > 0 ? join(HERE, 'out', BENCH.name) : join(HERE, 'out');
const PORT = BENCH.port;
const twice = process.argv.includes('--twice');
const fill = list => list.map(x => x.replace('{port}', String(PORT)));

const log = m => process.stderr.write(m + '\n');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

// Secret-shaped values are made here, at build time, so none is ever committed.
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const buildEnv = {
  ...process.env,
  ...(BENCH.env || {}),
  NEXT_PUBLIC_PAYMENT_KEY: 'sk_' + 'live_' + 'PebbleBench0000000000000001',
  NEXT_PUBLIC_DB_KEY: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'service_role', ref: 'pebble-demo' })}.${'b'.repeat(43)}`,
};

if (!existsSync(join(APP, BENCH.installed))) {
  log('installing benchmark app dependencies (first run only)…');
  run(BENCH.install[0], BENCH.install.slice(1), { cwd: APP, stdio: 'inherit' });
}
log(`building the benchmark app (${BENCH.name})…`);
if (BENCH.build) run(BENCH.build[0], BENCH.build.slice(1), { cwd: APP, env: buildEnv, stdio: ['ignore', 'ignore', 'inherit'] });

const start = fill(BENCH.start);
const server = spawn(start[0], start.slice(1), { cwd: APP, env: buildEnv, stdio: 'ignore', detached: true });
const base = `http://127.0.0.1:${PORT}`;
const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch {} };
process.on('exit', stop);
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + BENCH.ready)).ok) break; } catch {} await delay(200); }

const capture = (label, harFrom) => {
  const work = mkdtempSync(join(tmpdir(), `nunchi-bench-${label}-`));
  mkdirSync(join(work, '.nunchi'), { recursive: true });
  if (harFrom) cpSync(join(harFrom, '.nunchi', 'har'), join(work, '.nunchi', 'har'), { recursive: true });
  writeFileSync(join(work, '.nunchi', 'samples.json'), JSON.stringify(BENCH.samples || {}));
  // Signed-in scenes use a saved session, as `nunchi login` would produce.
  if (BENCH.auth) writeFileSync(join(work, '.nunchi', 'auth.json'), JSON.stringify(BENCH.auth));
  const t = Date.now();
  const summary = JSON.parse(run('node', [CLI, 'capture', '--url', base, '--root', APP, '--samples', '.nunchi/samples.json', '--canaries', '3', '--json'], { cwd: work }));
  return { work, out: summary.out, summary, seconds: Math.round((Date.now() - t) / 100) / 10 };
};

log('capturing (run 1)…');
const a = capture('a');
let determinism = null;
let stability = null;
if (twice) {
  log('capturing (run 2, replay)…');
  const b = capture('b', a.work);
  // second run replays run 1's recording so both see the same data
  const files = d => readdirSync(d, { recursive: true }).filter(f => statSync(join(d, f)).isFile() && f !== 'timing.json' && f !== 'run.json' && !f.endsWith('volatile.json')).sort();
  const fa = files(a.out), fb = files(b.out);
  const differ = fa.filter(f => !fb.includes(f) || !readFileSync(join(a.out, f)).equals(readFileSync(join(b.out, f))));
  determinism = differ.length ? `${differ.length} file(s) differ (${differ.slice(0, 5).join(', ')})` : `identical (${fa.length} files)`;
  // fingerprint stability (spec §8): the same defects get the same fingerprints when nothing changed
  const fps = d => new Set(JSON.parse(readFileSync(join(d, 'findings.json'), 'utf8')).findings.map(f => f.fp));
  const pa = fps(a.out), pb = fps(b.out);
  const both = [...pa].filter(x => pb.has(x)).length, any = new Set([...pa, ...pb]).size;
  stability = { same: both, total: any, rate: any ? both / any : 1 };
}
stop();

const manifest = JSON.parse(readFileSync(join(a.out, 'manifest.json'), 'utf8'));
const { findings } = JSON.parse(readFileSync(join(a.out, 'findings.json'), 'utf8'));
const r = score(ANSWERS, manifest, findings);
const when = new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' KST';
const scenes = manifest.scenes.filter(s => s.canary === undefined).length;
const canaries = manifest.scenes.length - scenes;
const md = reportMarkdown(r, { app: ANSWERS.app, when, scenes, canaries, seconds: a.seconds, determinism, stability });
// only this run's report is replaced: bench/out also holds other apps' reports and the AI-gate packets
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'report.md'), md);
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...r, determinism, stability, seconds: a.seconds, scenes, canaries }, null, 2) + '\n');
console.log(md);
const pass = r.ruleRecall.rate === 1 && r.cleanFalsePositives.perScene <= 0.1 && (!twice || (determinism.startsWith('identical') && stability.rate >= 0.95));
process.exit(pass ? 0 : 1);
