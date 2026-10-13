#!/usr/bin/env node
// nunchi engine CLI. The deterministic half of nunchi: everything here must give the
// same output for the same input. Judgment (sample values, lenses, fixes) lives in the plugin skill.
import { resolve, join, relative, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { discover } from './discover.mjs';
import { buildSourceMap, affectedRoutes } from './sourcemap.mjs';
import { startRun, finishRun, gcRuns, latestRun, workTree, ensureGitignore } from './runs.mjs';
import { codeNavigations } from './flow.mjs';
import { updateState, readState, readDecisions, writeDecision, readApproved, addApproved, view, groups as groupRows, titleOf, DECISIONS } from './ledger.mjs';
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
    --canaries <n>        plant known defects in copies of n scenes, to measure the AI hunt   default: 0
                          (use 3 when the AI lenses will run: a capture without them gains nothing)
                          (tagged \`canary\` in manifest.json, listed in canaries.json, never in findings.json)
    exit code 3 when the run is not usable (login expired, app unreachable); the run is kept
  nunchi findings [--rule <rule>] [--all] [--status open,to-fix,…] [--json]
                                            What is open: one row per kind of defect; --rule lists its groups
                                            (a group = one defect, however many screens it is on)
  nunchi decide <id…> fix|keep|false-positive|hold|reopen [--reason …] [--note …]
                                            Record a decision on a group or fingerprint (prefix of its id is enough).
                                            keep needs --reason intended|out-of-scope; false-positive needs
                                            --reason not-a-problem|wrong-place. Decisions are files under .nunchi/decisions/
  nunchi approve <decision id…> | --all     Accept decisions that came through git (made on another machine)
  nunchi trust [--json]                     Per-lens precision from your decisions (fix ÷ (fix + false positive))
  nunchi runs [--json]                      List captured runs (newest last) and which is latest
  nunchi gc [--keep 5]                      Delete old runs, keep the newest N and the latest
  nunchi map [--root <dir>] [--json]        Which source files each route renders (source ↔ scene map)
  nunchi canaries --score [--run <id>] [--json]
                                            Score the AI hunt (ai-findings.json) against the run's canaries:
                                            hit rate per lens, an upper bound of recall; a missed canary
                                            voids *seen* for its batch in coverage.json
  nunchi verify --plan [--run <id>] [--json]
                                            One packet per claimed AI finding (claim + evidence, no hunter
                                            reasoning) with decoys mixed in → verify-packets.json; the answer
                                            key goes to verify-key.json, which the verifier never reads
  nunchi verify --record <verdicts.json> [--run <id>] [--vendor <name>]
                                            Record verdicts (confirmed | rejected | insufficient, severity, one-line
                                            reason) into ai-findings.json and verify.json; decoy pass-through
                                            > 10% marks the run's verifications suspect. --vendor only when the
                                            user opted into a different vendor's model (default: same-model check)
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
    else if (a === '--score') args.score = true;
    else if (a === '--check') args.check = true;
    else if (a === '--no-browser') args.noBrowser = true;
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--keep') args.keep = Number(argv[++i]);
    else if (a === '--all') args.all = true;
    else if (['--reason', '--note', '--run', '--status', '--rule'].includes(a)) args[a.slice(2)] = argv[++i];
    else if (['--url', '--routes', '--samples', '--out', '--viewports', '--browser-path', '--auth', '--network', '--states', '--allow-host', '--path', '--changed-since', '--vendor', '--record', '--canaries'].includes(a)) args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
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
// The run a command reads: --run <id> (or a folder written with capture --out), else the latest run.
function runDirOf(args, cmdName) {
  const dir = resolve('.nunchi/runs');
  const p = args.run ? (/^\d{4,}$/.test(args.run) ? join(dir, args.run) : resolve(args.run)) : (latestRun(dir) ? join(dir, latestRun(dir)) : null);
  if (!p || !existsSync(join(p, 'manifest.json'))) { console.error(`nunchi ${cmdName}: ${args.run ? `no run at ${p}` : 'no runs yet: nunchi capture --url <your local server>'}`); process.exit(1); }
  return p;
}
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const aiFindingsOf = (dir, cmdName) => {
  const p = join(dir, 'ai-findings.json');
  if (!existsSync(p)) { console.error(`nunchi ${cmdName}: ${p} does not exist yet: the AI hunt writes it`); process.exit(1); }
  const doc = readJson(p);
  return { path: p, doc, findings: Array.isArray(doc) ? doc : doc.findings || [] };
};
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
  const { DEFAULT_CANARIES } = await import('./canary.mjs');
  const canaries = args.canaries === undefined ? 0 : Number(args.canaries);
  if (!Number.isInteger(canaries) || canaries < 0) { console.error('nunchi capture: --canaries takes a whole number (0 = none)'); process.exit(1); }
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
      allowHosts: (args.allowHost || '').split(',').map(x => x.trim()).filter(Boolean), canaries,
    });
    const by = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const f of r.findings) by[f.severity]++;
    if (!args.routes) { const { writeStable } = await import('./stable.mjs'); writeStable(join(out, 'source-map.json'), buildSourceMap(root, discover(root).routes)); }
    const final = run ? finishRun(runsDir, run.id) : out;
    // fold the run into the local ledger state (what is open, fixed, back again)
    if (run) updateState(join(nunchiDir, 'state', 'ledger.json'), { id: run.id, scope: runMeta.scope, health: r.manifest.health, findings: r.findings });
    const misses = r.manifest.scenes.reduce((n, x) => n + (x.replayMisses || 0), 0);
    const canaryCount = r.canaries ? r.canaries.planted.length : 0;
    const summary = { out: final, run: run?.id ?? null, health: r.manifest.health, scenes: r.manifest.scenes.length - canaryCount, canaries: canaryCount, network: r.run.network, replayMisses: misses, skipped, findings: by, seconds: Math.round(r.totalMs / 100) / 10 };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`captured ${summary.scenes} scenes${canaryCount ? ` (+ ${canaryCount} canary copies)` : ''} in ${summary.seconds}s → ${final}${run ? ` (run ${run.id})` : ''}`);
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
} else if (['findings', 'decide', 'approve', 'trust'].includes(cmd)) {
  const nunchiDir = resolve('.nunchi');
  const stateFile = join(nunchiDir, 'state', 'ledger.json');
  const decisionsDir = join(nunchiDir, 'decisions');
  const approvedFile = join(nunchiDir, 'state', 'approved.json');
  const state = readState(stateFile);
  const rows = view(state, readDecisions(decisionsDir), readApproved(approvedFile));
  const gs = groupRows(rows);
  if (!Object.keys(state.items).length && cmd !== 'approve') { console.error('nunchi: nothing captured yet (run nunchi capture first)'); process.exit(1); }
  if (cmd === 'findings') {
    const want = args.status ? new Set(args.status.split(',')) : args.all ? null : new Set(['open', 'regressed', 'to-fix', 'mixed']);
    const shown = gs.filter(g => (!want || want.has(g.status)) && (!args.rule || g.rule === args.rule));
    const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
    const kinds = [];
    for (const g of shown) {
      let k = kinds.find(x => x.rule === g.rule);
      if (!k) kinds.push((k = { rule: g.rule, lens: g.lens, title: g.title, severity: g.severity, groups: 0, routes: new Set(), places: 0 }));
      k.groups++; k.places += g.places; g.routes.forEach(r => k.routes.add(r));
      if (SEV[g.severity] < SEV[k.severity]) k.severity = g.severity;
    }
    kinds.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.routes.size - a.routes.size || (a.rule < b.rule ? -1 : 1));
    if (args.json) console.log(JSON.stringify({ run: state.runs[state.runs.length - 1], kinds: kinds.map(k => ({ ...k, routes: [...k.routes].sort() })), groups: shown }, null, 2));
    else {
      const count = st => rows.filter(r => r.status === st).length;
      console.log(`run ${state.runs[state.runs.length - 1]} · ${rows.length} unique defects in ${gs.length} groups · open ${count('open') + count('regressed')} · to fix ${count('to-fix')} · fixed ${count('fixed')} · kept ${count('kept')} · dismissed ${count('dismissed')}`);
      if (!args.rule) {
        for (const k of kinds) console.log(`${k.severity.padEnd(7)} ${k.title} — ${k.groups} group(s) on ${k.routes.size || 'no'} screen(s), ${k.places} place(s)   nunchi findings --rule ${k.rule}`);
        if (!kinds.length) console.log(want ? 'nothing open — `nunchi findings --all` lists everything' : 'no findings');
      }
      for (const g of args.rule ? shown : []) {
        const where = g.routes.length > 1 ? `${g.routes.length} screens` : (g.routes[0] ?? 'whole app');
        console.log(`${g.severity.padEnd(7)} ${g.title} — ${where}, ${g.places} place(s) [${g.status}]  ${g.group}`);
        const ex = g.example;
        console.log(`        ${g.rule} · e.g. ${ex.route ?? ''} ${ex.selector ?? ''}`.trimEnd());
      }
      if (args.rule && !shown.length) console.log(`no ${want ? 'open ' : ''}groups for ${args.rule}`);
    }
  } else if (cmd === 'decide') {
    const [, ...rest] = args._;
    const decision = rest.find(x => DECISIONS[x]);
    const ids = rest.filter(x => !DECISIONS[x]);
    if (!decision || !ids.length) { console.error('usage: nunchi decide <group or fingerprint id…> fix|keep|false-positive|hold|reopen [--reason …] [--note …]'); process.exit(1); }
    const { execFileSync: run } = await import('node:child_process');
    let by = process.env.USER || 'unknown';
    try { by = run('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || by; } catch {}
    const made = [];
    for (const id of ids) {
      const g = gs.filter(x => x.group.startsWith(id)), f = rows.filter(x => x.fp.startsWith(id));
      if (g.length + f.length !== 1) { console.error(`nunchi: "${id}" matches ${g.length + f.length} groups/fingerprints; give more characters`); process.exit(1); }
      const target = g.length ? { group: g[0].group } : { fp: f[0].fp };
      try { made.push(writeDecision(decisionsDir, { target, decision, reason: args.reason || null, note: args.note || null, by })); }
      catch (e) { console.error('nunchi: ' + e.message); process.exit(1); }
    }
    addApproved(approvedFile, made.map(d => d.id));
    console.log(args.json ? JSON.stringify(made, null, 2) : made.map(d => `${d.decision} → ${d.target.group ? 'group ' + d.target.group : 'fingerprint ' + d.target.fp} (${d.id})`).join('\n'));
  } else if (cmd === 'approve') {
    const all = readDecisions(decisionsDir);
    const approved = readApproved(approvedFile);
    const pending = all.filter(d => !approved.has(d.id));
    const ids = args.all ? pending.map(d => d.id) : args._.slice(1).filter(id => pending.some(d => d.id === id));
    if (!ids.length) { console.log(pending.length ? `${pending.length} decision(s) from git wait for approval: nunchi approve <id…> or --all\n` + pending.map(d => `  ${d.id}  ${d.decision} ${d.target.group || d.target.fp} by ${d.by} at ${d.at}`).join('\n') : 'no decisions waiting for approval'); process.exit(0); }
    addApproved(approvedFile, ids);
    console.log(`approved ${ids.length} decision(s)`);
  } else {
    const { trust } = await import('./ledger.mjs');
    const t = trust(rows, readDecisions(decisionsDir));
    if (args.json) console.log(JSON.stringify(t, null, 2));
    else for (const [lens, x] of Object.entries(t)) console.log(`${lens.padEnd(4)} precision ${x.precision === null ? '—' : Math.round(x.precision * 100) + '%'} (${x.fix} fix · ${x.falsePositive} false positive of the last ${x.window})${x.suspect ? '  SUSPECT: new findings need a closer look' : ''}  · fixed ${x.fixed}/${x.decidedFix}`);
  }
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
} else if (cmd === 'canaries') {
  if (!args.score) { console.error('nunchi canaries: use --score [--run <id>] after the AI hunt has written ai-findings.json'); process.exit(1); }
  const { scoreCanaries, voidCoverage } = await import('./canary.mjs');
  const { writeStable } = await import('./stable.mjs');
  const dir = runDirOf(args, 'canaries');
  if (!existsSync(join(dir, 'canaries.json'))) { console.error(`nunchi canaries: ${dir} has no canaries.json (captured with --canaries 0, or before canaries existed)`); process.exit(1); }
  const { findings } = aiFindingsOf(dir, 'canaries');
  const r = scoreCanaries(readJson(join(dir, 'canaries.json')), findings.filter(f => f.source === 'ai'));
  const coveragePath = join(dir, 'coverage.json');
  let coverage = null;
  if (existsSync(coveragePath)) { coverage = voidCoverage(readJson(coveragePath), r.missed); writeStable(coveragePath, coverage); }
  writeStable(join(dir, 'canary-score.json'), r);
  if (args.json) console.log(JSON.stringify({ ...r, coverage: coverage ? coverage.canaries : null }, null, 2));
  else {
    const pct = x => (x === null ? '–' : `${Math.round(x * 100)}%`);
    console.log(`canaries hit ${r.hit}/${r.planted} → AI recall ≤ ${pct(r.rate)} (an upper bound: planted defects are easier than real ones)`);
    console.log('  ' + Object.entries(r.byLens).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([l, v]) => `${l} ${v.hit}/${v.planted}`).join(' · '));
    for (const m of r.missed) console.log(`  missed ${m.scene} (${m.lens} ${m.kind}): *seen* is void for the batch that hunted it; hunt that batch again`);
    if (r.missed.length) console.log(coverage ? `coverage.json updated: ${coverage.canaries.voidedUnits.length} unit(s) no longer seen` : 'no coverage.json in this run: the batches above are not seen until hunted again');
  }
} else if (cmd === 'verify') {
  const V = await import('./verify.mjs');
  const { writeStable, stableJson } = await import('./stable.mjs');
  const dir = runDirOf(args, 'verify');
  const { path: aiPath, doc, findings } = aiFindingsOf(dir, 'verify');
  const manifest = readJson(join(dir, 'manifest.json'));
  // Scene ids in ai-findings come from the hunter: only scenes of this run's manifest are opened.
  const known = new Set(manifest.scenes.map(s => s.id));
  const canaryScenes = new Set(manifest.scenes.filter(s => s.canary !== undefined).map(s => s.id));
  if (args.plan) {
    const controlsOf = scene => (known.has(scene) && existsSync(join(dir, scene, 'controls.json')) ? readJson(join(dir, scene, 'controls.json')) : null);
    const filesOf = scene => (known.has(scene) ? ['top.jpg', 'full.jpg', 'aria.yml', 'text.txt', 'controls.json', 'styles.json', 'links.json', 'measure.json'].filter(f => existsSync(join(dir, scene, f))).map(f => `${scene}/${f}`) : []);
    const { packets, key } = V.planVerify({ findings, canaryScenes, controlsOf, filesOf });
    if (!key.claims) { console.log('no claimed AI findings to verify (rule- and computed-lens findings skip the verifier)'); process.exit(0); }
    writeStable(join(dir, 'verify-packets.json'), packets);
    writeStable(join(dir, 'verify-key.json'), key);
    if (args.json) process.stdout.write(stableJson(packets));
    else {
      console.log(`${packets.packets.length} packets → ${join(dir, 'verify-packets.json')}`);
      console.log('Give the verifier only verify-packets.json and the files it names, in a fresh context. verify-key.json is the answer key: never show it to the verifier.');
    }
  } else if (args.record) {
    const keyPath = join(dir, 'verify-key.json');
    if (!existsSync(keyPath)) { console.error('nunchi verify: no verify-key.json in this run; run verify --plan first'); process.exit(1); }
    const r = V.recordVerdicts({ findings, key: readJson(keyPath), verdicts: readJson(resolve(args.record)), vendor: args.vendor || null });
    if (r.problems.length) { for (const p of r.problems) console.error('nunchi verify: ' + p); process.exit(1); }
    writeStable(aiPath, Array.isArray(doc) ? r.findings : { ...doc, findings: r.findings });
    writeStable(join(dir, 'verify.json'), r.verify);
    if (args.json) console.log(JSON.stringify(r.verify, null, 2));
    else {
      const c = r.verify.claims, d = r.verify.decoys;
      console.log(`verified by ${r.verify.verifier.label}${r.verify.verifier.vendor ? ` (${r.verify.verifier.vendor})` : ''}: confirmed ${c.confirmed} · rejected ${c.rejected} · insufficient ${c.insufficient}${c.unanswered ? ` · unanswered ${c.unanswered}` : ''}`);
      console.log(`decoys passed through: ${d.passedThrough}/${d.answered}${d.answered < d.total ? ` (${d.total - d.answered} unanswered)` : ''}`);
      if (r.verify.suspect) console.log(`SUSPECT: ${r.verify.suspectReason}. This run's verifications are marked suspect; verify again in a fresh context.`);
    }
  } else { console.error('nunchi verify: use --plan, or --record <verdicts.json>'); process.exit(1); }
} else if (cmd === 'gc') {
  const r = gcRuns(resolve('.nunchi/runs'), { keep: Number.isInteger(args.keep) && args.keep > 0 ? args.keep : 5 });
  console.log(args.json ? JSON.stringify(r, null, 2) : `kept ${r.kept.join(', ') || 'nothing'} · removed ${r.removed.join(', ') || 'nothing'}`);
} else {
  console.error(`nunchi: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}
