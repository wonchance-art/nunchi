#!/usr/bin/env node
// nunchi engine CLI. The deterministic half of nunchi: everything here must give the
// same output for the same input. Judgment (sample values, lenses, fixes) lives in the plugin skill.
import { resolve, join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { discover } from './discover.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `nunchi ${pkg.version} — notices what's off in every corner of your web app

Usage:
  nunchi discover [--root <dir>] [--json]   List the app's page routes and what was skipped
  nunchi capture --url <base> [options]     Capture every route at phone and desktop width,
                                            write the evidence pack and rule findings
    --root <dir>          app source (routes come from discover)     default: .
    --routes </a,/b>      capture these paths instead of discovered routes
    --samples <file.json> sample paths for dynamic routes, e.g. {"/posts/[id]": "/posts/1"}
    --out <dir>           evidence folder                            default: .nunchi/evidence/latest
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
    else if (a === '--root') args.root = argv[++i];
    else if (['--url', '--routes', '--samples', '--out', '--viewports', '--browser-path', '--auth', '--network', '--states', '--allow-host', '--path'].includes(a)) args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
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

if (cmd === 'discover') {
  const result = discover(resolve(args.root || process.cwd()));
  console.log(args.json ? JSON.stringify(result, null, 2) : printDiscover(result));
} else if (cmd === 'capture') {
  const { capture } = await import('./capture.mjs');
  if (!args.url) { console.error('nunchi capture: --url is required (your local or preview server, never production)'); process.exit(1); }
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
  const persons = auth ? ['guest', 'signed-in'] : ['guest'];
  const all = scenes.flatMap(s => persons.map(person => ({ ...s, person })));
  const out = resolve(args.out || '.nunchi/evidence/latest');
  // Evidence holds screenshots of the user's app and login state holds tokens: never committed.
  const nunchiDir = resolve('.nunchi');
  if (out.startsWith(nunchiDir + '/') && !existsSync(join(nunchiDir, '.gitignore'))) {
    mkdirSync(nunchiDir, { recursive: true });
    writeFileSync(join(nunchiDir, '.gitignore'), 'evidence/\nauth.json\nhar/\n');
  }
  try {
    const r = await capture({
      baseUrl: args.url, scenes: all, out, viewports: (args.viewports || 'm,d').split(','), browserPath: args.browserPath, storageState: auth,
      network: args.network || 'auto', recordingDir: resolve('.nunchi/har'),
      states: (args.states || 'normal,empty,error,slow,offline').split(',').map(x => x.trim()),
      allowHosts: (args.allowHost || '').split(',').map(x => x.trim()).filter(Boolean),
    });
    const by = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const f of r.findings) by[f.severity]++;
    const misses = r.manifest.scenes.reduce((n, x) => n + (x.replayMisses || 0), 0);
    const summary = { out, scenes: r.manifest.scenes.length, network: r.run.network, replayMisses: misses, skipped, findings: by, seconds: Math.round(r.totalMs / 100) / 10 };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`captured ${summary.scenes} scenes in ${summary.seconds}s → ${out}`);
      console.log(`rule findings: blocker ${by.blocker} · high ${by.high} · medium ${by.medium} · low ${by.low}`);
      console.log(`network: ${Object.entries(r.run.network).map(([p, m]) => `${p} ${m}`).join(' · ')}`);
      if (misses) console.log(`replay misses: ${misses} request(s) were not in the recording and went live; re-record with --network record`);
      for (const s of skipped) console.log(`  skipped ${s.route} (${s.reason})`);
    }
  } catch (e) {
    console.error(['NO_BROWSER', 'NO_AUTH', 'NO_RECORDING', 'BAD_ARGS'].includes(e.code) ? 'nunchi: ' + e.message : e.stack);
    process.exit(2);
  }
} else if (cmd === 'login') {
  const { login, loginWarnings } = await import('./login.mjs');
  if (!args.url) { console.error('nunchi login: --url is required'); process.exit(1); }
  const target = args.url.replace(/\/$/, '') + (args.path || '');
  for (const w of loginWarnings(target)) console.error('warning: ' + w);
  const out = resolve(args.out || '.nunchi/auth.json');
  const nunchiDir = resolve('.nunchi');
  if (out.startsWith(nunchiDir + '/') && !existsSync(join(nunchiDir, '.gitignore'))) {
    mkdirSync(nunchiDir, { recursive: true });
    writeFileSync(join(nunchiDir, '.gitignore'), 'evidence/\nauth.json\nhar/\n');
  }
  try { console.log(`saved login → ${await login({ url: target, out, browserPath: args.browserPath })} (owner-only, git-ignored)`); }
  catch (e) { console.error(e.code === 'NO_BROWSER' ? 'nunchi: ' + e.message : e.stack); process.exit(2); }
} else {
  console.error(`nunchi: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}
