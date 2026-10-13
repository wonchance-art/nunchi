#!/usr/bin/env node
// nunchi engine CLI. The deterministic half of nunchi: everything here must give the
// same output for the same input. Judgment (sample values, lenses, fixes) lives in the plugin skill.
import { resolve, join, relative, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { discover } from './discover.mjs';
import { buildSourceMap, affectedRoutes } from './sourcemap.mjs';
import { startRun, finishRun, gcRuns, latestRun, workTree, ensureGitignore } from './runs.mjs';
import { codeNavigations } from './flow.mjs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `nunchi ${pkg.version} — notices what's off in every corner of your web app

Usage:
  nunchi setup [--check] [--no-browser] [--json]
                                            Once per install: the two pinned engine packages from the lockfile
                                            (npm ci --ignore-scripts) and Chromium (~170 MB). --check only reports
  nunchi discover [--root <dir>] [--json]   List the app's page routes and what was skipped
  nunchi capture --url <base> [options]     Capture every route at phone and desktop width,
                                            write the evidence pack and rule findings
    --root <dir>          app source (routes come from discover)     default: .
    --routes </a,/b>      capture these paths instead of discovered routes
    --samples <file.json> sample paths for dynamic routes, e.g. {"/posts/[id]": "/posts/1"}
    --out <dir>           write the evidence here, in place (no run history)
                          default: a new run folder .nunchi/runs/<id>, complete or absent
    --viewports <m,d>     m = 390x844, d = 1280x800                  default: m,d
    --browser-path <exe>  Chromium/Chrome executable (or NUNCHI_BROWSER)
    --auth <state.json>   saved login (from nunchi login) for signed-in scenes     default: .nunchi/auth.json if present
    --network <mode>      auto | record | replay | live                default: auto
                          auto replays .nunchi/har/<person>.json when it exists, otherwise records it
    --states <list>       normal,empty,error,slow,offline              default: all five
                          forced states run only on screens that load data
    --allow-host <list>   extra backend hosts the app calls from the browser (Supabase, Firebase,
                          Convex, Appwrite and Clerk hosts are recognised already)
    --json                print the summary as JSON
    --changed-since <ref> only screens whose source changed since a git ref (plus uncommitted changes)
    --plan                print the screens that would be captured and exit (no browser)
    exit code 3 when the run is not usable (login expired, app unreachable); the run is kept
  nunchi runs [--json]                      List captured runs (newest last) and which is latest
  nunchi gc [--keep 5]                      Delete old runs, keep the newest N and the latest
  nunchi map [--root <dir>] [--json]        Which source files each route renders (source ↔ scene map)
  nunchi login --url <base> [--path /login] [--out .nunchi/auth.json]
                                            open a browser window, sign in once with a test account,
                                            save the login for signed-in scenes
  nunchi --version
  nunchi --help

Status: 0.1-a in progress. AI lenses, the ledger, the fix loop and the board come later.`;

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--plan') args.plan = true;
    else if (a === '--check') args.check = true;
    else if (a === '--no-browser') args.noBrowser = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--keep') args.keep = Number(argv[++i]);
    else if (['--url', '--routes', '--samples', '--out', '--viewports', '--browser-path', '--auth', '--network', '--states', '--allow-host', '--path', '--changed-since'].includes(a)) args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else args._.push(a);
  }
  return args;
}

function printDiscover(r) {
  const lines = [`framework: ${r.framework}`, `routes: ${r.routes.length}`];
  for (const x of r.routes) {
    const p = x.params.length ? `  needs: ${x.params.map(p => `${p.name} (${p.kind})`).join(', ')}` : '';
    const n = x.needsResolution ? `  [${x.needsResolution}]` : '';
    lines.push(`  ${x.path.padEnd(32)} ${x.file}${p}${n}`);
  }
  if (r.excluded.length) {
    lines.push(`skipped: ${r.excluded.length}`);
    for (const x of r.excluded) lines.push(`  ${x.file}  (${x.reason})`);
  }
  if (r.fallback) lines.push(`no routes found in source — next step falls back to: ${r.fallback}`);
  return lines.join('\n');
}

const args = parse(process.argv.slice(2));
const cmd = args._[0];
if (args.version) { console.log(pkg.version); process.exit(0); }
if (args.help || !cmd) { console.log(HELP); process.exit(args.help ? 0 : 1); }

function changedFiles(root, ref) {
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const prefix = git(['rev-parse', '--show-prefix']).trim();
  const strip = f => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
  const diff = git(['diff', '--name-only', ref]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...diff.map(strip), ...untracked].filter(Boolean))].sort();
}

// The engine's two packages are installed by `nunchi setup`; say so instead of a stack trace.
async function engine(path) {
  try { return await import(path); }
  catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    console.error('nunchi: the engine is not set up yet (its pinned packages are missing). Run `nunchi setup` once.');
    process.exit(2);
  }
}
const inside = (dir, f) => { const r = relative(dir, f); return r && !r.startsWith('..') && !isAbsolute(r); };

if (cmd === 'setup') {
  const { setup } = await import('./setup.mjs');
  const r = await setup({ check: !!args.check, browser: !args.noBrowser });
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const [name, d] of Object.entries(r.dependencies.packages)) console.log(`${d.have === d.want ? 'ok     ' : 'missing'} ${name}@${d.want}${d.have && d.have !== d.want ? ` (found ${d.have})` : ''}`);
    console.log(`${r.browser.ok ? 'ok     ' : 'missing'} Chromium${r.browser.path ? ` ${r.browser.path}` : ''}`);
    console.log(r.ready ? 'ready' : args.check ? 'not ready: run `nunchi setup`' : 'not ready (see the messages above)');
  }
  process.exit(r.ready ? 0 : 1);
} else if (cmd === 'map') {
  const root = resolve(args.root || process.cwd());
  const map = buildSourceMap(root, discover(root).routes);
  if (args.json) console.log(JSON.stringify(map, null, 2));
  else {
    const entries = Object.entries(map.routes);
    console.log(`routes: ${entries.length} · source files reached: ${Object.keys(map.files).length}`);
    for (const [route, files] of entries) console.log(`  ${route.padEnd(32)} ${files.length} files`);
  }
} else if (cmd === 'discover') {
  const result = discover(resolve(args.root || process.cwd()));
  console.log(args.json ? JSON.stringify(result, null, 2) : printDiscover(result));
} else if (cmd === 'capture') {
  const { capture } = await engine('./capture.mjs');
  if (!args.url && !args.plan) { console.error('nunchi capture: --url is required (your local or preview server, never production)'); process.exit(1); }
  const root = resolve(args.root || process.cwd());
  const samples = args.samples ? JSON.parse(readFileSync(resolve(args.samples), 'utf8')) : {};
  const skipped = [];
  let scenes;
  if (args.routes) scenes = args.routes.split(',').map(p => ({ route: p.trim(), path: p.trim() }));
  else {
    scenes = [];
    for (const r of discover(root).routes) {
      if (r.needsResolution) { skipped.push({ route: r.path, reason: r.needsResolution }); continue; }
      if (r.params.length && !samples[r.path]) { skipped.push({ route: r.path, reason: 'needs-sample' }); continue; }
      scenes.push({ route: r.path, path: samples[r.path] || r.path });
    }
  }
  const auth = args.auth ? resolve(args.auth) : existsSync(resolve('.nunchi/auth.json')) ? resolve('.nunchi/auth.json') : null;
  if (args.changedSince) {
    const map = buildSourceMap(root, discover(root).routes);
    let changed;
    try { changed = changedFiles(root, args.changedSince); }
    catch (e) { console.error(`nunchi capture: could not read git changes since ${args.changedSince}: ${String(e.message).split('\n')[0]}`); process.exit(1); }
    const hit = affectedRoutes(map, changed);
    const keep = new Set(hit.routes);
    for (const s of scenes) if (!keep.has(s.route)) skipped.push({ route: s.route, reason: 'unchanged' });
    scenes = scenes.filter(s => keep.has(s.route));
    console.log(`changed since ${args.changedSince}: ${changed.length} file(s) → ${scenes.length} route(s)${hit.reason ? ` (${hit.reason})` : ''}`);
  }
  const persons = auth ? ['guest', 'signed-in'] : ['guest'];
  const all = scenes.flatMap(s => persons.map(person => ({ ...s, person })));
  if (args.plan) { console.log(JSON.stringify({ scenes: all, skipped }, null, 2)); process.exit(0); }
  const nunchiDir = resolve('.nunchi');
  const runsDir = join(nunchiDir, 'runs');
  // Evidence holds screenshots of the user's app and login state holds tokens: never committed.
  ensureGitignore(nunchiDir);
  const run = args.out ? null : startRun(runsDir);
  const out = run ? run.path : resolve(args.out);
  const viewports = (args.viewports || 'm,d').split(',');
  const states = (args.states || 'normal,empty,error,slow,offline').split(',').map(x => x.trim());
  const runMeta = {
    schema: 1, id: run?.id ?? null, parent: run?.parent ?? null, ...workTree(root),
    scope: { routes: [...new Set(all.map(s => s.route))].sort(), persons, viewports, states, changedSince: args.changedSince || null },
  };
  // L3 knows every route of the app when they come from the source, and the navigations the source names.
  let flow = {};
  if (!args.routes) {
    const routes = discover(root).routes;
    flow = { routes: routes.filter(r => !r.needsResolution).map(r => r.path).sort(), wholeApp: !args.changedSince, code: codeNavigations(root, buildSourceMap(root, routes)) };
  }
  if (auth) {
    try {
      const cookies = JSON.parse(readFileSync(auth, 'utf8')).cookies || [];
      const dated = cookies.filter(c => c.expires > 0);
      if (dated.length && dated.every(c => c.expires * 1000 < Date.now())) console.error('warning: every cookie in the saved login has expired; run `nunchi login` again or signed-in screens will show the sign-in page');
    } catch {}
  }
  try {
    const r = await capture({
      baseUrl: args.url, scenes: all, out, viewports, browserPath: args.browserPath, storageState: auth,
      network: args.network || 'auto', recordingDir: resolve('.nunchi/har'), states, runMeta, flow,
      allowHosts: (args.allowHost || '').split(',').map(x => x.trim()).filter(Boolean),
    });
    const by = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const f of r.findings) by[f.severity]++;
    if (!args.routes) { const { writeStable } = await import('./stable.mjs'); writeStable(join(out, 'source-map.json'), buildSourceMap(root, discover(root).routes)); }
    const final = run ? finishRun(runsDir, run.id) : out;
    const misses = r.manifest.scenes.reduce((n, x) => n + (x.replayMisses || 0), 0);
    const summary = { out: final, run: run?.id ?? null, health: r.manifest.health, scenes: r.manifest.scenes.length, network: r.run.network, replayMisses: misses, skipped, findings: by, seconds: Math.round(r.totalMs / 100) / 10 };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`captured ${summary.scenes} scenes in ${summary.seconds}s → ${final}${run ? ` (run ${run.id})` : ''}`);
      const why = { 'login-expired': 'the saved login no longer works: signed-in screens showed the sign-in page and were not judged. Run `nunchi login` again.', 'app-unreachable': 'most screens did not load at all. Is the app running at --url?', 'recording-stale': 'most screens asked for data the recording does not have. Re-record with --network record.' };
      for (const p of r.manifest.health.problems) console.log(`RUN PROBLEM ${p.status} (${p.scenes}/${p.of} screens): ${why[p.status]}`);
      console.log(`rule findings: blocker ${by.blocker} · high ${by.high} · medium ${by.medium} · low ${by.low}`);
      console.log(`network: ${Object.entries(r.run.network).map(([p, m]) => `${p} ${m}`).join(' · ')}`);
      if (misses) console.log(`replay misses: ${misses} request(s) were not in the recording and went live; re-record with --network record`);
      for (const s of skipped) console.log(`  skipped ${s.route} (${s.reason})`);
    }
    if (r.manifest.health.problems.some(p => p.status === 'login-expired' || p.status === 'app-unreachable')) process.exitCode = 3;
  } catch (e) {
    console.error(['NO_BROWSER', 'NO_AUTH', 'NO_RECORDING', 'BAD_ARGS'].includes(e.code) ? 'nunchi: ' + e.message : e.stack);
    process.exit(2);
  }
} else if (cmd === 'login') {
  const { login, loginWarnings } = await engine('./login.mjs');
  if (!args.url) { console.error('nunchi login: --url is required'); process.exit(1); }
  const target = args.url.replace(/\/$/, '') + (args.path || '');
  for (const w of loginWarnings(target)) console.error('warning: ' + w);
  const out = resolve(args.out || '.nunchi/auth.json');
  if (inside(resolve('.nunchi'), out)) ensureGitignore(resolve('.nunchi'));
  try { console.log(`saved login → ${await login({ url: target, out, browserPath: args.browserPath })} (owner-only, git-ignored)`); }
  catch (e) { console.error(e.code === 'NO_BROWSER' ? 'nunchi: ' + e.message : e.stack); process.exit(2); }
} else if (cmd === 'runs') {
  const { listRuns } = await import('./runs.mjs');
  const dir = resolve('.nunchi/runs');
  const r = { ...listRuns(dir), latest: latestRun(dir) };
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const id of r.complete) {
      let m = {};
      try { m = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')); } catch {}
      console.log(`${id}${id === r.latest ? ' (latest)' : ''}  ${m.commit ? m.commit.slice(0, 7) : 'no git'}${m.dirty ? ' + edits' : ''}  health ${m.health?.status ?? '?'}  ${m.scope?.routes?.length ?? '?'} routes`);
    }
    for (const p of r.partial) console.log(`${p}  (incomplete: still running, or interrupted; removed by nunchi gc after an hour)`);
    if (!r.complete.length && !r.partial.length) console.log('no runs yet: nunchi capture --url <your local server>');
  }
} else if (cmd === 'gc') {
  const r = gcRuns(resolve('.nunchi/runs'), { keep: Number.isInteger(args.keep) && args.keep > 0 ? args.keep : 5 });
  console.log(args.json ? JSON.stringify(r, null, 2) : `kept ${r.kept.join(', ') || 'nothing'} · removed ${r.removed.join(', ') || 'nothing'}`);
} else {
  console.error(`nunchi: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}
