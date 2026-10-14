#!/usr/bin/env node
// nunchi engine CLI. The deterministic half of nunchi: everything here must give the
// same output for the same input. Judgment (sample values, lenses, fixes) lives in the plugin skill.
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { discover } from './discover.mjs';
import { buildSourceMap, affectedRoutes, sourceHashes } from './sourcemap.mjs';
import { startRun, finishRun, gcRuns, latestRun, workTree, ensureGitignore, ensurePrivate, readConfig, gitRunner, DIFF_SAFE } from './runs.mjs';
import { baseUrlRefusal } from './network.mjs';
import { codeNavigations } from './flow.mjs';
import { readDecisions, approvalKey, buildDecision, view, DECISIONS, NOT_LOOKED_RUNS, STALE_HUNTS, latestRunOf } from './ledger.mjs';
import { ensureStateDir, writeKey, readKey, removeKey, removeKeys, keyPath } from './state.mjs';
import { runIdentity, routeHashes } from './ai-fold.mjs';
import { withLock } from './stable.mjs';
import * as P from './project.mjs';
import { LEDGER_ERRORS } from './project.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `nunchi ${pkg.version} — notices what's off in every corner of your web app

Usage:
  nunchi setup [--check] [--no-browser] [--json]
                                            Once per install: the pinned engine packages from the lockfile
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
  nunchi open [--no-browser] [--stop] [--label [--labeller <name>]] [--port <n>]
                                            The live board: findings, screens and decisions in your browser, updated
                                            as the ledger changes. Starts a local server (127.0.0.1 only) in the
                                            background and returns; it opens your browser with a one-time link and
                                            stops after 2 hours idle. Run again to open another tab; --stop stops it.
                                            --label: blinded labelling for the precision check
  nunchi findings [--rule <rule>] [--all] [--status open,to-fix,…] [--json]
                                            What is open: one row per kind of defect; --rule lists its groups
                                            (a group = one defect, however many screens it is on)
  nunchi decide <id…> fix|keep|false-positive|not-a-problem|hold|later|reopen [--reason …] [--note …] [--from-chat]
                                            Record a decision on a group or fingerprint (prefix of its id is enough).
                                            keep needs --reason intended|out-of-scope; false-positive needs
                                            --reason not-a-problem|wrong-place. Decisions are files under .nunchi/decisions/.
                                            In your own terminal you type a short code to confirm; run by your AI
                                            (or with --from-chat), keep and not-a-problem count for "ready to
                                            ship" once you confirm them in the board
  nunchi approve <decision id…> | --all     Accept decisions that came through git (made on another machine)
  nunchi trust [--json]                     Per-lens precision from your decisions (fix ÷ (fix + false positive)),
                                            and how long decisions in the board took (singles and batches apart)
  nunchi runs [--json]                      List captured runs (newest last) and which is latest
  nunchi gc [--keep 5]                      Delete old runs, keep the newest N and the latest
  nunchi map [--root <dir>] [--json]        Which source files each route renders (source ↔ scene map)
  nunchi canaries --score [--run <id>] [--json]
                                            Score the AI hunt (ai-findings.json) against the run's canaries:
                                            hit rate per lens, an upper bound of recall; a missed canary
                                            voids *seen* for its batch in coverage.json
  nunchi verify --plan [--run <id>] [--again] [--json]
                                            One packet per claimed AI finding (claim + evidence, no hunter
                                            reasoning) with decoys mixed in → verify-packets.json; the answer
                                            key (verify-key.json) is kept outside the project, where the verifier
                                            does not look. --again verifies a suspect run once more
  nunchi verify --record <verdicts.json> [--run <id>] [--vendor <name>] [--root <dir>]
                                            Record verdicts (confirmed | rejected | insufficient, severity, one-line
                                            reason) in the answer key (what the ledger trusts; copies in
                                            ai-findings.json and verify.json), and fold the run's AI findings into
                                            the ledger; decoy pass-through (confirmed or unanswered) > 10%, or fewer
                                            decoys than planned, marks the run's verifications suspect. --vendor only
                                            when the user opted into a different vendor's model (default: same-model)
  nunchi recheck --plan [--run <id>] [--root <dir>] [--json]
                                            Are open AI findings still there on this (newer) run? One packet per
                                            finding × screen whose screen or code changed (old evidence + new
                                            screen), with at least 3 still-present defects on changed screens mixed
                                            in as controls → recheck-packets.json
  nunchi recheck --record <verdicts.json> [--run <id>] [--json]
                                            Record gone | still-there | insufficient per packet in the answer key
                                            (a copy in recheck.json) and fold it into the ledger: a finding is fixed
                                            only when every screen it was seen on says gone and the batch is not
                                            suspect (a control answered gone or left unanswered counts against it)
  nunchi inventory [--root <dir>] [--json]  Source strings, UI states (loading/empty/error) and destructive actions
                                            with file:line, plus copy candidates for the AI lenses (not findings)
  nunchi login --url <base> [--path /login] [--out .nunchi/auth.json]
                                            open a browser window, sign in once with a test account,
                                            save the login for signed-in scenes
  nunchi hunt --plan [--run <id>] [--lens L1,L6] [--budget <tokens>|all] [--json]
                                            Cut a run into AI-lens work units (1–3 scenes × 1 lens + a reference
                                            scene), estimate tokens, write hunt-plan.json into the run.
                                            Units over the budget (default 400000 tokens, normal screens
                                            first; all = no cap) are listed as not seen: budget
  nunchi hunt --record <answers.json|dir> [--run <id>] [--root <dir>] [--json]
                                            Check the hunter's answers (every item answered, every defect
                                            grounded in a selector of the scene or a file:line under --root),
                                            write ai-findings.json and coverage.json into the run, and fold the
                                            hunt into the ledger (claims not double-checked yet; screens it saw)
  nunchi export --html <dir> [--run <id>] [--inline] [--json]
                                            A static review page of one run and the ledger: <dir>/index.html plus
                                            <dir>/img/ (screenshots, copied). --inline puts the images inside
                                            index.html (one file). Offline, no scripts or fonts from anywhere;
                                            open it in a browser. It shows screenshots of your app: sharing it
                                            sends them off this machine
  nunchi tokens [--run <id>] [--json]      Tidy: cluster the colours (text, backgrounds, borders, SVG), radii and
                                            font sizes the screens use into a token proposal with roles and WCAG
                                            contrast → tokens.json and tokens.css in the run (never your code)
  nunchi --version
  nunchi --help

Status: 0.1-c in progress. The fix loop comes later.`;

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
    else if (a === '--inline') args.inline = true;
    else if (a === '--again') args.again = true;
    else if (a === '--from-chat') args.fromChat = true;
    else if (a === '--stop') args.stop = true;
    else if (a === '--label') args.label = true;
    else if (['--reason', '--note', '--run', '--status', '--rule', '--labeller'].includes(a)) args[a.slice(2)] = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (['--url', '--routes', '--samples', '--out', '--viewports', '--browser-path', '--auth', '--network', '--states', '--allow-host', '--path', '--changed-since', '--lens', '--budget', '--record', '--vendor', '--canaries', '--html'].includes(a)) args[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
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

// git with the repository's own programs switched off (D9), like every git call of the engine
function changedFiles(root, ref) {
  const run = gitRunner(root);
  const git = args => run(args, { encoding: 'utf8' });
  const prefix = git(['rev-parse', '--show-prefix']).trim();
  const strip = f => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f);
  const diff = git(['diff', ...DIFF_SAFE, '--name-only', '--end-of-options', ref, '--']).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...diff.map(strip), ...untracked].filter(Boolean))].sort();
}

// The engine's pinned packages are installed by `nunchi setup`; say so instead of a stack trace.
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
// A ledger file that cannot be read, held by another nunchi process, or changed under it again and again (and the
// other errors project.mjs names): said plainly, exit 2, nothing written.
const ledgerGuard = fn => {
  try { return fn(); }
  catch (e) { if (!LEDGER_ERRORS.includes(e.code)) throw e; console.error('nunchi: ' + e.message); process.exit(2); }
};
const warn = m => console.error('nunchi: ' + m);
// The state store of this project, its folder made private, and the ledger, through the functions the board uses too
// (project.mjs).
const stateOf = nunchiDir => ledgerGuard(() => P.stateOf(nunchiDir, { warn }));
const openState = (nunchiDir, opts = {}) => ledgerGuard(() => P.openState(nunchiDir, { ...opts, warn }));
const adopt = st => P.adopt(st, { warn });
const syncState = P.syncState;
const sweep = P.sweep;
const loadLedger = (nunchiDir, { root } = {}) => ledgerGuard(() => P.loadLedger(nunchiDir, { root, warn }));
// Files written into a complete run after it was captured (hunt, verify, canaries, re-check) are read, changed and
// written under the run's own lock (design §8.1), so two commands on one run never lose each other's writes.
const runLock = (runDir, fn) => withLock(join(runDir, 'run-files'), fn, { timeoutMs: 15000 });
// Folding a run's AI findings or re-check verdicts after they were recorded: a ledger that cannot be brought up to
// date only warns (the verdicts are in the run; the next ledger command folds them).
// `quiet`: a run that may not fold is not said (the hunt: an --out folder is hunted and verified before it would be).
function foldAfterRecord(runDir, what, root, { quiet = false } = {}) {
  const who = runIdentity(runDir);
  const nunchiDir = resolve('.nunchi');
  if (who.why) { if (!quiet) console.error(`nunchi: ${what} not folded into the ledger: ${who.why}`); return false; }
  if (resolve(dirname(runDir)) !== join(nunchiDir, 'runs')) { if (!quiet) console.error(`nunchi: ${what} not folded into the ledger: run ${who.id} is not in this project's .nunchi/runs`); return false; }
  try {
    const st = openState(nunchiDir);
    sweep(nunchiDir, st);
    syncState(st, { decisions: readDecisions(join(nunchiDir, 'decisions')), root });
    return true;
  } catch (e) {
    if (!LEDGER_ERRORS.includes(e.code)) throw e;
    console.error(`warning: ${what} recorded in run ${who.id}, but not in the ledger yet (${e.message}); the next ledger command folds it`);
    return false;
  }
}
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
} else if (cmd === 'inventory') {
  const { buildInventory } = await engine('./inventory.mjs');
  const { stableJson } = await import('./stable.mjs');
  const root = resolve(args.root || process.cwd());
  const inv = buildInventory(root, discover(root).routes);
  if (args.json) process.stdout.write(stableJson(inv));
  else {
    const s = inv.summary;
    console.log(`inventory (${inv.scope}): ${s.files} files · ${s.strings} strings · ${s.states} states · ${s.actions} destructive actions · ${s.dialogs} native dialogs`);
    const at = (f, l) => `${f}:${l}`;
    const states = inv.files.flatMap(f => f.states.map(x => `  ${x.state.padEnd(9)} ${at(f.file, x.line)}  ${x.strings.length ? x.strings.map(t => JSON.stringify(t)).join(' · ') : x.elements.length ? x.elements.map(e => `<${e}>`).join(' ') : x.renders === 'nothing' ? '(renders nothing)' : '(no text)'}`));
    if (states.length) console.log(`states:\n${states.join('\n')}`);
    const acts = inv.files.flatMap(f => f.actions.map(a => `  ${at(f.file, a.line)}  ${a.label ? JSON.stringify(a.label) : a.handler}  confirm: ${a.confirm ? a.confirm.kind : 'none'}${a.undo ? ' · undo' : ''}`));
    if (acts.length) console.log(`destructive actions:\n${acts.join('\n')}`);
    if (inv.candidates.length) {
      console.log(`candidates for the AI lenses (not findings): ${inv.candidates.length}`);
      for (const c of inv.candidates) {
        const where = c.variants ? c.variants.map(v => `${v.forms.map(x => JSON.stringify(x)).join('/')} ×${v.count} (${at(v.occurrences[0].file, v.occurrences[0].line)})`).join(' · ')
          : c.copies ? c.copies.map(x => `${at(x.file, x.line)} [${x.labels.join(', ')}]`).join(' vs ')
          : `${at(c.file, c.line)}${c.text ? ` ${JSON.stringify(c.text)}` : c.label ? ` ${JSON.stringify(c.label)}` : c.expression ? ` {${c.expression}}` : ''}`;
        console.log(`  ${c.lens} ${c.kind}${c.concept ? ` ${c.concept}` : ''}: ${where}`);
      }
    }
    if (inv.skipped.length) { console.log(`skipped: ${inv.skipped.length}`); for (const x of inv.skipped) console.log(`  ${x.file}  (${x.reason}${x.message ? `: ${x.message}` : ''})`); }
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
  // Never production (D10): a base URL that is not local or private needs the user's own .nunchi/config.json.
  let allowBaseHosts;
  try { allowBaseHosts = readConfig(nunchiDir).allowHosts; } catch (e) { console.error('nunchi: ' + e.message); process.exit(2); }
  const refusal = baseUrlRefusal(args.url, allowBaseHosts);
  if (refusal) { console.error('nunchi capture: ' + refusal); process.exit(2); }
  // Evidence holds screenshots of the user's app and login state holds tokens: never committed, owner-only.
  ensureGitignore(nunchiDir);
  // the state store: shared by every worktree in a repository (its run-id counter keeps run ids one sequence)
  const st = stateOf(nunchiDir);
  try { ensurePrivate(nunchiDir, st.root.shared ? ['har/', 'runs/'] : undefined); if (st.root.shared) ensureStateDir(st.root); } catch (e) { console.error('nunchi: ' + e.message); process.exit(2); }
  const run = args.out ? null : startRun(runsDir, { ids: st.root.shared ? st.files.runIds : null });
  const out = run ? run.path : resolve(args.out);
  const viewports = (args.viewports || 'm,d').split(',');
  const { DEFAULT_CANARIES } = await import('./canary.mjs');
  const canaries = args.canaries === undefined ? 0 : Number(args.canaries);
  if (!Number.isInteger(canaries) || canaries < 0) { console.error('nunchi capture: --canaries takes a whole number (0 = none)'); process.exit(1); }
  // Canaries go only where a lens of this project hunts (its own packs included); a broken pack falls back to
  // the built-in ones here, and is reported by hunt --plan.
  let lenses = null;
  if (canaries > 0) {
    try { lenses = (await import('./lenses.mjs')).loadLenses({ root: process.cwd() }).lenses; }
    catch (e) { console.error(`nunchi capture: lens packs not loaded (${String(e.message).split('\n')[0]}); canaries follow the built-in packs`); }
  }
  const states = (args.states || 'normal,empty,error,slow,offline').split(',').map(x => x.trim());
  const runMeta = {
    // kind (design §2.1): a full capture is a sweep; only a sweep folds as one. worktree: whose runs these are
    // (runs stay per worktree, the ledger is shared, §7).
    schema: 1, id: run?.id ?? null, parent: run?.parent ?? null, kind: 'sweep', worktree: st.root.stream, ...workTree(root),
    scope: { routes: [...new Set(all.map(s => s.route))].sort(), persons, viewports, states, changedSince: args.changedSince || null },
    // every route the source has, none skipped for this run only (a dynamic route without a sample), so
    // whole-app detectors (secrets, the link graph, one-offs) judged the whole app. Paths discover cannot
    // resolve are skipped by every run: they never make a run partial, and are listed here so they stay visible.
    wholeApp: !args.routes && !args.changedSince && !skipped.some(s => s.reason === 'needs-sample'),
    unresolved: skipped.filter(s => s.reason !== 'needs-sample' && s.reason !== 'unchanged').map(s => s.route).sort(),
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
      allowHosts: (args.allowHost || '').split(',').map(x => x.trim()).filter(Boolean), allowBaseHosts, canaries, lenses,
    });
    const by = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const f of r.findings) by[f.severity]++;
    if (!args.routes) {
      const { writeStable } = await import('./stable.mjs');
      const routes = discover(root).routes;
      const map = buildSourceMap(root, routes);
      writeStable(join(out, 'source-map.json'), map);
      // what each route's code was at this capture: how a re-check tells a route's code did not change (§2.4)
      writeStable(join(out, 'source-hashes.json'), sourceHashes(root, map));
      // The source inventory (§2.4) feeds the AI hunt's source slices (§4). It is extra: it never fails a capture.
      const invPath = join(out, 'inventory.json');
      try {
        const { buildInventory } = await import('./inventory.mjs');
        writeStable(invPath, buildInventory(root, routes));
      } catch (e) {
        try { rmSync(invPath, { force: true }); } catch {}
        console.error(`warning: no inventory.json in this run (${String(e?.message ?? e).split('\n')[0]}); the AI hunt gets no source slices`);
      }
    }
    const final = run ? finishRun(runsDir, run.id) : out;
    // fold the run into the local ledger state (what is open, fixed, back again), with any complete run a
    // crash left unfolded; if this fails, the next ledger command folds it
    if (run) {
      try { sweep(nunchiDir, st); if (st.root.shared) adopt(st); syncState(st, { root }); }
      catch (e) { if (!LEDGER_ERRORS.includes(e.code)) throw e; console.error(`warning: run ${run.id} is complete but not in the ledger yet (${e.message})`); }
    }
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
      if (misses) console.log(`replay misses: ${misses} request(s) were not in the recording and were not sent (replay never goes live); re-record with --network record`);
      for (const s of skipped) console.log(`  skipped ${s.route} (${s.reason})`);
    }
    if (r.manifest.health.problems.some(p => p.status === 'login-expired' || p.status === 'app-unreachable')) process.exitCode = 3;
  } catch (e) {
    console.error(['NO_BROWSER', 'NO_AUTH', 'NO_RECORDING', 'BAD_RECORDING', 'URL_NOT_ALLOWED', 'BAD_ARGS'].includes(e.code) ? 'nunchi: ' + e.message : e.stack);
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
  const led = loadLedger(nunchiDir);
  const { state, decisions, approved, st } = led;
  const { rows, groups: gs } = P.ledgerView(led);
  if (!Object.keys(state.items).length && cmd !== 'approve') { console.error('nunchi: nothing captured yet (run nunchi capture first)'); process.exit(1); }
  // how a decision made here is recorded (design §1): `cli-tty` when stdin and stdout are this person's terminal and
  // they type the code shown; otherwise `cli-agent` (the agent recording what the user said in chat; --from-chat says
  // so without asking). A dismissal recorded by the agent counts for "Ready to ship" only once confirmed in the board.
  const channelHere = async what => {
    if (args.fromChat || !process.stdin.isTTY || !process.stdout.isTTY) return 'cli-agent';
    const { randomInt } = await import('node:crypto');
    const { createInterface } = await import('node:readline');
    const ABC = 'ACDEFHJKMNPRTUVWXY34679';
    const code = Array.from({ length: 4 }, () => ABC[randomInt(ABC.length)]).join('');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(res => { rl.on('close', () => res(null)); rl.question(`${what}\nType ${code} to confirm (anything else cancels): `, a => { res(a); rl.close(); }); });
    if (String(answer ?? '').trim().toUpperCase() !== code) { console.error('nunchi: not recorded (the confirmation code was not typed)'); process.exit(1); }
    return 'cli-tty';
  };
  if (cmd === 'findings') {
    const want = args.status ? new Set(args.status.split(',')) : args.all ? null : new Set(['open', 'regressed', 'to-fix', 'mixed']);
    // AI groups not double-checked (claimed, or a verdict that was suspect, rejected or insufficient, or from a run with
    // too few decoys to check the checker) are kept apart,
    // collapsed into one line (design §2.2, §3.4); --all, --status and --rule list them
    const unchecked = g => g.source === 'ai' && !g.checked;
    const collapsed = !args.all && !args.status && !args.rule ? gs.filter(g => unchecked(g) && want.has(g.status)) : [];
    const shown = gs.filter(g => (!want || want.has(g.status)) && (!args.rule || g.rule === args.rule) && !collapsed.includes(g));
    const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
    const kinds = [];
    for (const g of shown) {
      let k = kinds.find(x => x.rule === g.rule);
      if (!k) kinds.push((k = { rule: g.rule, lens: g.lens, source: g.source, title: g.source === 'ai' ? `AI · ${g.rule}` : g.title, severity: g.severity, groups: 0, routes: new Set(), places: 0 }));
      k.groups++; k.places += g.places; g.routes.forEach(r => k.routes.add(r));
      if (SEV[g.severity] < SEV[k.severity]) k.severity = g.severity;
    }
    kinds.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.routes.size - a.routes.size || (a.rule < b.rule ? -1 : 1));
    // this worktree's latest run (another worktree's newer run is not what this one sees, §7)
    const latest = latestRunOf(state, st.root.stream);
    // what a run could not tell, and what no run has looked at again: said, so "open" is not read as "checked"
    const blind = state.blind?.[latest] ?? null;
    const unlooked = new Map();
    for (const r of rows) if (r.notLookedAt && (!unlooked.has(r.group) || r.notLookedAt < unlooked.get(r.group))) unlooked.set(r.group, r.notLookedAt);
    const staleAi = gs.filter(g => g.status === 'stale').length;
    const needsYou = rows.filter(r => r.needsYou && !r.goneAt).length;
    // the board's Progress summary (one function for both, design §3.3)
    const { summary } = await import('./summary.mjs');
    let runner = null; try { runner = gitRunner(process.cwd()); } catch {}
    const sum = summary({ state, rows, groups: gs, stream: st.root.stream, runsDir: st.runsDir, git: runner });
    if (args.json) console.log(JSON.stringify({ run: latest, blind, kinds: kinds.map(k => ({ ...k, routes: [...k.routes].sort() })), groups: shown, ...(collapsed.length ? { notDoubleChecked: collapsed.map(g => g.group) } : {}), summary: sum }, null, 2));
    else {
      // groups by status, as the board's Decisions panel counts them (summary.byStatus: a group with rows in two
      // statuses counts in both; "came back" counts as open)
      const b = sum.byStatus;
      console.log(`run ${latest} · ${rows.length} unique defects in ${gs.length} groups · groups open ${b.open} · to fix ${b['to-fix']} · later ${b.held} · fixed ${b.fixed} · kept ${b.kept} · not a problem ${b.dismissed}`);
      console.log(`ready to ship? ${sum.verdict.text}`);
      const blindWhy = { 'app-unreachable': 'the app did not load', 'recording-stale': 'the recording no longer had the data', 'one-page': 'most screens showed one and the same page (another app or an error page at that address?)' };
      if (blind) console.log(`run ${latest} marked nothing fixed: ${blindWhy[blind] || blind}`);
      const stale = rows.filter(r => r.notLookedAt).length;
      if (stale) console.log(`${stale} open defect(s) not looked at again for ${NOT_LOOKED_RUNS}+ runs (their screens, states or viewports were not captured like for like): they cannot be marked fixed until a run covers them`);
      if (!args.rule) {
        for (const k of kinds) console.log(`${k.severity.padEnd(7)} ${k.title} — ${k.groups} group(s) on ${k.routes.size || 'no'} screen(s), ${k.places} place(s)   nunchi findings --rule ${k.rule}`);
        if (collapsed.length) console.log(`AI, not double-checked: ${collapsed.length} group(s) (claimed only, or a verdict that was suspect, rejected or insufficient, or from a run with too few decoys to check the checker) — nunchi findings --all lists them`);
        const fewDecoys = new Set(rows.filter(r => r.source === 'ai' && !r.goneAt && r.verification?.tooFewDecoys === true).map(r => r.group)).size;
        if (fewDecoys) console.log(`${fewDecoys} AI group(s) verified in a run with too few decoys to check the checker: not suspect, and not double-checked either`);
        if (!kinds.length && !collapsed.length) console.log(want ? 'nothing open — `nunchi findings --all` lists everything' : 'no findings');
        if (staleAi && want) console.log(`${staleAi} AI group(s) stale: ${STALE_HUNTS} later hunts saw their screens and did not claim them — nunchi findings --status stale`);
        if (needsYou) console.log(`${needsYou} AI finding(s) need you: the re-check could not tell whether they are gone`);
        if (sum.confirm.length) console.log(`${sum.confirm.length} decision(s) recorded by the AI or from git wait for you to confirm them in the board (nunchi open); until then they do not count for "ready to ship"`);
      }
      for (const g of args.rule ? shown : []) {
        const where = g.routes.length > 1 ? `${g.routes.length} screens` : (g.routes[0] ?? 'whole app');
        console.log(`${g.severity.padEnd(7)} ${g.title} — ${where}, ${g.places} place(s) [${g.status}]  ${g.group}${unlooked.has(g.group) ? `  (not looked at since run ${unlooked.get(g.group)})` : ''}`);
        const ex = g.example;
        console.log(`        ${g.rule} · e.g. ${ex.route ?? ''} ${ex.selector ?? ''}`.trimEnd());
      }
      if (args.rule && !shown.length) console.log(`no ${want ? 'open ' : ''}groups for ${args.rule}`);
    }
  } else if (cmd === 'decide') {
    const [, ...rest] = args._;
    // the board's words are accepted too (design §3.4): not-a-problem = false-positive --reason not-a-problem, later = hold
    const ALIAS = { 'not-a-problem': { decision: 'false-positive', reason: 'not-a-problem' }, later: { decision: 'hold', reason: null } };
    const word = rest.find(x => DECISIONS[x] || ALIAS[x]);
    const ids = rest.filter(x => !DECISIONS[x] && !ALIAS[x]);
    if (!word || !ids.length) { console.error('usage: nunchi decide <group or fingerprint id…> fix|keep|false-positive|not-a-problem|hold|later|reopen [--reason …] [--note …] [--from-chat]'); process.exit(1); }
    const decision = ALIAS[word]?.decision ?? word;
    const reason = args.reason || ALIAS[word]?.reason || null;
    let targets;
    try { targets = P.resolveTargets(rows, gs, ids); } catch (e) { if (e.code !== 'BAD_TARGET') throw e; console.error('nunchi: ' + e.message); process.exit(1); }
    // checked before asking for the confirmation code: a decision that cannot be made is refused first
    try { buildDecision({ target: targets[0], decision, reason, note: args.note || null, by: 'check' }); }
    catch (e) { console.error('nunchi: ' + e.message); process.exit(1); }
    const channel = await channelHere(`${decision}${reason ? ` (${reason})` : ''} on ${targets.length} target(s)`);
    const made = ledgerGuard(() => P.recordDecisions(led, { targets, decision, reason, note: args.note || null, by: P.whoAmI(), channel, batch: P.batchFor(targets) }));
    console.log(args.json ? JSON.stringify(made, null, 2) : made.map(d => `${d.decision} → ${d.target.group ? 'group ' + d.target.group : 'fingerprint ' + d.target.fp} (${d.id})`).join('\n'));
    if (!args.json && channel === 'cli-agent' && (decision === 'keep' || decision === 'false-positive')) console.log('recorded by your AI: it counts for "ready to ship" once you confirm it in the board (nunchi open)');
  } else if (cmd === 'approve') {
    const pending = decisions.filter(d => !approved.has(approvalKey(d)));
    const chosen = args.all ? pending : [];
    if (!args.all) for (const id of args._.slice(1)) {
      const same = pending.filter(d => d.id === id);
      if (same.length > 1) { console.error(`nunchi: ${same.length} decision files share the id ${id} (one was copied or forged): ${same.map(d => `${d.target.group ? 'group-' + d.target.group : 'fp-' + d.target.fp}/${id}.json`).join(', ')}; remove the one you did not make, then approve`); process.exit(1); }
      chosen.push(...same);
    }
    if (!chosen.length) { console.log(pending.length ? `${pending.length} decision(s) from git wait for approval: nunchi approve <id…> or --all\n` + pending.map(d => `  ${d.id}  ${d.decision} ${d.target.group || d.target.fp} by ${d.by} at ${d.at}`).join('\n') : 'no decisions waiting for approval'); process.exit(0); }
    const channel = await channelHere(`approve ${chosen.length} decision(s) that came through git`);
    ledgerGuard(() => P.approveDecisions(led, chosen, { channel }));
    console.log(`approved ${chosen.length} decision(s)${channel === 'cli-agent' ? ' (recorded by your AI: dismissals among them count for "ready to ship" once you confirm them in the board)' : ''}`);
  } else {
    const { trust, currentTargets } = await import('./ledger.mjs');
    const t = trust(rows, currentTargets(decisions, state));
    if (args.json) console.log(JSON.stringify(t, null, 2));
    else {
      // per lens and source (design §2.2): a rule lens and the AI lens of the same name keep separate records
      for (const x of Object.values(t)) console.log(`${(x.source === 'ai' ? `${x.lens} AI` : x.lens).padEnd(4)} precision ${x.precision === null ? '—' : Math.round(x.precision * 100) + '%'} (${x.fix} fix · ${x.falsePositive} false positive of the last ${x.window})${x.suspect ? '  SUSPECT: new findings need a closer look' : ''}  · fixed ${x.fixed}/${x.decidedFix}`);
      // decision time measured by the board (design §3.5): singles and batches apart, Later apart
      const { readMetrics, decisionTimes, formatDecisionTimes, metricsPath } = await import('./metrics.mjs');
      console.log(formatDecisionTimes(decisionTimes(ledgerGuard(() => readMetrics(metricsPath(st.root.dir))))));
    }
  }
} else if (cmd === 'open') {
  // The live board (design §3.1): a detached server; this command returns at once. The board's key never reaches this
  // output unless stdin and stdout are the person's own terminal and no browser was opened (--no-browser).
  const nunchiDir = resolve('.nunchi');
  const { openBoard, stopBoards } = await import('./board/launch.mjs');
  const st = stateOf(nunchiDir);
  if (args.stop) {
    const n = await stopBoards(st.root.dir, process.cwd());
    console.log(n ? `stopped ${n === 1 ? 'the board' : `${n} boards`}` : 'no board is running for this project');
    process.exit(0);
  }
  if (!latestRun(join(nunchiDir, 'runs'))) { console.error('nunchi open: no runs yet: nunchi capture --url <your local server>'); process.exit(1); }
  // the board writes state (decisions, approvals, metrics): the state folder is private before it starts
  const led = loadLedger(nunchiDir);
  if (args.port !== undefined && !(Number.isInteger(args.port) && args.port > 1023 && args.port < 65536)) { console.error('nunchi open: --port takes a port number from 1024 to 65535'); process.exit(1); }
  let labeller = null;
  if (args.label) {
    const { slugLabeller, LABELLER } = await import('./labels.mjs');
    labeller = args.labeller ? String(args.labeller) : slugLabeller(P.whoAmI());
    if (!LABELLER.test(labeller)) { console.error('nunchi open: --labeller takes lower-case letters of any script, digits and - (up to 40)'); process.exit(1); }
  }
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  let r;
  try { r = await openBoard({ projectDir: process.cwd(), stateDir: led.st.root.dir, mode: args.label ? 'label' : 'board', labeller, browser: !args.noBrowser, linkToTerminal: tty, port: args.port || 0 }); }
  catch (e) { console.error(`nunchi open: ${e.message}`); process.exit(2); }
  console.log(`board open on 127.0.0.1:${r.port}${r.reused ? ' (already running)' : ''}${args.label ? ` · label mode for ${labeller}` : ''}`);
  if (r.portIgnored) console.log(`--port ${r.portIgnored} is ignored: the running board keeps port ${r.port} (nunchi open --stop, then nunchi open --port ${r.portIgnored}, to move it)`);
  if (r.link) console.log(`open this link in your browser; it works once, for 2 minutes:\n  ${r.link}`);
  else if (args.noBrowser) console.log('no browser was opened; to open it, run nunchi open in your own terminal');
  else console.log(r.reused ? 'a fresh one-time link was opened in the browser' : 'the browser shows it; it stops after 2 hours idle (nunchi open --stop stops it now)');
} else if (cmd === 'runs') {
  const { listRuns } = await import('./runs.mjs');
  const dir = resolve('.nunchi/runs');
  const r = { ...listRuns(dir), latest: latestRun(dir) };
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const id of r.complete) {
      let m = null;
      try { m = JSON.parse(readFileSync(join(dir, id, 'run.json'), 'utf8')); } catch {}
      if (!m) { console.log(`${id}${id === r.latest ? ' (latest)' : ''}  run.json cannot be read (torn or removed): fix or remove this run`); continue; }
      console.log(`${id}${id === r.latest ? ' (latest)' : ''}  ${m.commit ? m.commit.slice(0, 7) : 'no git'}${m.dirty ? ' + edits' : ''}  health ${m.health?.status ?? '?'}  ${m.scope?.routes?.length ?? '?'} routes`);
    }
    for (const p of r.partial) console.log(`${p}  (incomplete: still running, or interrupted; removed by nunchi gc after an hour)`);
    if (!r.complete.length && !r.partial.length) console.log('no runs yet: nunchi capture --url <your local server>');
  }
} else if (cmd === 'hunt') {
  // AI lenses, engine side (spec §4): the plan and the record are deterministic; the judgement is the skill's.
  const { loadLenses } = await import('./lenses.mjs');
  const { planHuntWithKey, writeHuntMirror, recordHunt, writeRecord, readAnswers, formatPlan, formatRecord } = await import('./hunt.mjs');
  const { writeStable } = await import('./stable.mjs');
  const fail = (msg, code = 1) => { console.error(`nunchi hunt: ${msg}`); process.exit(code); };
  if (!!args.plan === !!args.record) fail('use either --plan or --record <answers.json>');
  const runsDir = resolve('.nunchi/runs');
  let runDir, runId = null;
  if (args.run && !/^\d{4,}$/.test(args.run)) runDir = resolve(args.run);          // a run folder or an --out folder
  else {
    runId = args.run || latestRun(runsDir);
    if (!runId) fail('no runs yet: nunchi capture --url <your local server>');
    runDir = join(runsDir, runId);
  }
  if (!existsSync(join(runDir, 'manifest.json'))) fail(`${runDir} is not a complete capture run (no manifest.json)`);
  if (!runId) { try { runId = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')).id ?? null; } catch {} }
  const planPath = join(runDir, 'hunt-plan.json');
  try {
    if (args.plan) {
      const { DEFAULT_BUDGET } = await import('./hunt.mjs');
      const budgetDefault = args.budget === undefined;
      const budget = budgetDefault ? DEFAULT_BUDGET : args.budget === 'all' ? null : Number(args.budget);
      if (budget !== null && !(Number.isInteger(budget) && budget > 0)) fail('--budget takes a whole number of tokens, or all for no cap');
      const { lenses } = loadLenses({ root: process.cwd() });
      const lensIds = args.lens ? args.lens.split(',').map(x => x.trim().toUpperCase()).filter(Boolean) : null;
      const { plan, key } = planHuntWithKey({ runDir, lenses, lensIds, budget, budgetDefault, runId });
      runLock(runDir, () => {
        writeStable(planPath, plan);
        // a run with canaries: scene aliases, their answer key (kept outside the project, design §2.2) and the
        // evidence the aliases point to
        if (key) writeKey(runDir, 'hunt-key.json', key); else removeKey(runDir, 'hunt-key.json');
        writeHuntMirror(runDir, key);
      });
      console.log(args.json ? JSON.stringify(plan, null, 2) : formatPlan(plan, planPath));
    } else {
      if (!existsSync(planPath)) fail(`no hunt-plan.json in ${runDir}: run hunt --plan first`);
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      const answersPath = resolve(args.record);
      if (!existsSync(answersPath)) fail(`${args.record} not found`);
      const result = runLock(runDir, () => {
        const key = readKey(runDir, 'hunt-key.json');
        // a plan made for a run with canaries names scenes by alias: without its key nothing can be mapped back
        const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
        if (!key && (manifest.scenes || []).some(s => s.canary !== undefined)) throw Object.assign(new Error(`the answer key of this plan (hunt-key.json) is missing from ${dirname(keyPath(runDir, 'hunt-key.json'))}: run hunt --plan again`), { code: 'STALE_ANSWERS' });
        const r = recordHunt({ runDir, plan, key, answers: readAnswers(answersPath), root: resolve(args.root || process.cwd()) });
        writeRecord(runDir, r);
        return r;
      });
      // the hunt into the ledger as (run, "ai"): its claims (not double-checked yet) and the cells it saw, so a hunt
      // that claims nothing counts towards staleness too (design §2.2, §2.4)
      foldAfterRecord(runDir, 'the AI hunt', args.root || process.cwd(), { quiet: true });
      console.log(args.json ? JSON.stringify({ plan: plan.id, run: runId, summary: result.coverage.summary, findings: result.findings.length, rejected: result.rejected }, null, 2) : formatRecord(result, runDir));
    }
  } catch (e) {
    if (['BAD_LENS', 'LENS_HASH_MISMATCH', 'BAD_ARGS', 'BAD_RUN', 'BAD_ANSWERS', 'STALE_ANSWERS', 'CORRUPT', 'LOCKED', 'UNSAFE_PATH'].includes(e.code)) fail(e.message, 2);
    throw e;
  }
} else if (cmd === 'canaries') {
  if (!args.score) { console.error('nunchi canaries: use --score [--run <id>] after the AI hunt has written ai-findings.json'); process.exit(1); }
  const { scoreCanaries, voidCoverage } = await import('./canary.mjs');
  const { writeStable } = await import('./stable.mjs');
  const dir = runDirOf(args, 'canaries');
  if (!existsSync(join(dir, 'canaries.json'))) { console.error(`nunchi canaries: ${dir} has no canaries.json (captured with --canaries 0, or before canaries existed)`); process.exit(1); }
  const coveragePath = join(dir, 'coverage.json');
  aiFindingsOf(dir, 'canaries');                                  // said before the run's lock is taken
  let coverage = null, r;
  runLock(dir, () => {
    const { findings } = aiFindingsOf(dir, 'canaries');
    const recorded = existsSync(coveragePath) ? readJson(coveragePath) : null;
    r = scoreCanaries(readJson(join(dir, 'canaries.json')), findings.filter(f => f.source === 'ai'), recorded);
    if (recorded) { coverage = voidCoverage(recorded, r.missed); writeStable(coveragePath, coverage); }
    writeStable(join(dir, 'canary-score.json'), r);
  });
  if (args.json) console.log(JSON.stringify({ ...r, coverage: coverage ? coverage.canaries : null }, null, 2));
  else {
    const pct = x => (x === null ? '–' : `${Math.round(x * 100)}%`);
    console.log(`canaries hit ${r.hit}/${r.planted} → AI recall ≤ ${pct(r.rate)} (an upper bound: planted defects are easier than real ones)`);
    console.log('  ' + Object.entries(r.byLens).sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([l, v]) => `${l} ${v.hit}/${v.planted}`).join(' · '));
    for (const m of r.missed) console.log(`  missed ${m.scene} (${m.lens} ${m.kind}): *seen* is void for the batch that hunted it; hunt that batch again`);
    for (const n of r.notHunted || []) console.log(`  not hunted ${n.scene} (${n.lens}, ${n.reason}): not counted; raise --budget or answer that unit to measure it`);
    for (const a of r.ambiguous || []) console.log(`  ambiguous ${a.scene} (${a.lens} ${a.kind}): ${a.reason}, so the copy cannot tell the planted defect apart; not counted`);
    if (r.missed.length) console.log(coverage ? `coverage.json updated: ${coverage.canaries.voidedUnits.length} unit(s) no longer seen` : 'no coverage.json in this run: the batches above are not seen until hunted again');
  }
} else if (cmd === 'verify') {
  const V = await import('./verify.mjs');
  const { writeStable, stableJson } = await import('./stable.mjs');
  const dir = runDirOf(args, 'verify');
  aiFindingsOf(dir, 'verify');
  const manifest = readJson(join(dir, 'manifest.json'));
  // Scene ids in ai-findings come from the hunter: only scenes of this run's manifest are opened.
  const known = new Set(manifest.scenes.map(s => s.id));
  const canaryScenes = new Set(manifest.scenes.filter(s => s.canary !== undefined).map(s => s.id));
  const guard = fn => { try { return runLock(dir, fn); } catch (e) { if (!['CORRUPT', 'LOCKED', 'UNSAFE_PATH'].includes(e.code)) throw e; console.error('nunchi verify: ' + e.message); process.exit(2); } };
  if (args.plan) {
    const controlsOf = scene => (known.has(scene) && existsSync(join(dir, scene, 'controls.json')) ? readJson(join(dir, scene, 'controls.json')) : null);
    const filesOf = scene => (known.has(scene) ? ['top.jpg', 'full.jpg', 'aria.yml', 'text.txt', 'controls.json', 'styles.json', 'links.json', 'measure.json'].filter(f => existsSync(join(dir, scene, f))).map(f => `${scene}/${f}`) : []);
    // --again (design §2.4): a run whose verification was suspect is verified once more, its verdicts replaced. What
    // was verified, and whether it was suspect, comes from the answer key's recorded verdicts (§2.2), never from the
    // files in the run.
    if (args.again) {
      const oldKey = guard(() => readKey(dir, 'verify-key.json'));
      const judged = V.keyRounds(oldKey).length ? V.verdictsFromKey(aiFindingsOf(dir, 'verify').findings, oldKey) : null;
      if (!judged?.some(f => f && f.source === 'ai' && f.verification?.suspect === true)) { console.error(`nunchi verify: --again verifies a suspect run once more; ${!judged ? 'this run has not been verified yet (verify --plan)' : judged.some(f => f && f.source === 'ai' && f.verification?.tooFewDecoys === true) ? `this run's verification is not suspect: it had ${V.TOO_FEW_DECOYS}, and a new plan of the same screens has no more (capture more screens)` : 'this run\'s verification is not suspect'}`); process.exit(1); }
    }
    const made = guard(() => {
      const { findings } = aiFindingsOf(dir, 'verify');
      // which findings to ask about follows ai-findings.json (a status written there by hand only leaves a finding
      // out, so it stays a claim in the ledger: the ledger counts only verdicts the key holds)
      const oldKey = readKey(dir, 'verify-key.json');
      const scenes = manifest.scenes.filter(s => s && s.canary === undefined).map(s => ({ id: s.id, route: s.route ?? null, viewport: s.viewport ?? null }));
      const { packets, key } = V.planVerify({ findings, canaryScenes, controlsOf, filesOf, scenes, again: !!args.again });
      if (!key.claims) return null;
      // the rounds recorded before keep counting, as long as their claims still match the findings
      const earlier = oldKey ? V.roundsStillValid(findings, oldKey) : [];
      writeStable(join(dir, 'verify-packets.json'), packets);
      writeKey(dir, 'verify-key.json', earlier.length ? { ...key, earlier } : key);
      return packets;
    });
    if (!made) { console.log(`no ${args.again ? 'suspect or claimed' : 'claimed'} AI findings to verify (rule- and computed-lens findings skip the verifier)`); process.exit(0); }
    if (args.json) process.stdout.write(stableJson(made));
    else {
      console.log(`${made.packets.length} packets → ${join(dir, 'verify-packets.json')}`);
      console.log(`Give the verifier only verify-packets.json and the files it names, in a fresh context. The answer key is kept outside the project (${dirname(keyPath(dir, 'verify-key.json'))}): never open it or show it to the verifier.`);
    }
  } else if (args.record) {
    const r = guard(() => {
      const { path: aiPath, doc, findings } = aiFindingsOf(dir, 'verify');
      const key = readKey(dir, 'verify-key.json');
      if (!key) return { problems: ['this run has no answer key (verify-key.json); run verify --plan first'] };
      const given = readJson(resolve(args.record));
      const list = Array.isArray(given) ? given : given?.verdicts;
      const { recorded: _replaced, ...plan } = key;
      const res = V.recordVerdicts({ findings, key, verdicts: given, vendor: args.vendor || null });
      if (res.problems.length) return res;
      // the verdicts go into the key first (outside the project): what the ledger folds; ai-findings.json and
      // verify.json are copies for people and the review page
      const kept = list.map(v => ({ packet: v.packet, verdict: v.verdict, ...(v.severity != null ? { severity: v.severity } : {}), reason: v.reason.trim() }));
      writeKey(dir, 'verify-key.json', { ...plan, recorded: { verdicts: kept, vendor: args.vendor || null } });
      writeStable(aiPath, Array.isArray(doc) ? res.findings : { ...doc, findings: res.findings });
      writeStable(join(dir, 'verify.json'), res.verify);
      return res;
    });
    if (r.problems.length) { for (const p of r.problems) console.error('nunchi verify: ' + p); process.exit(1); }
    // the run's AI findings into the ledger, keyed (run, "ai") (design §2.2)
    const folded = foldAfterRecord(dir, 'the AI findings', args.root || process.cwd());
    if (args.json) console.log(JSON.stringify({ ...r.verify, folded }, null, 2));
    else {
      const c = r.verify.claims, d = r.verify.decoys;
      console.log(`verified by ${r.verify.verifier.label}${r.verify.verifier.vendor ? ` (${r.verify.verifier.vendor})` : ''}: confirmed ${c.confirmed} · rejected ${c.rejected} · insufficient ${c.insufficient}${c.unanswered ? ` · unanswered ${c.unanswered}` : ''}`);
      console.log(`decoys passed through: ${d.passedThrough}/${d.answered}${d.answered < d.total ? ` (${d.total - d.answered} unanswered)` : ''}`);
      if (r.verify.suspect) console.log(`SUSPECT: ${r.verify.suspectReason}. This run's verifications are marked suspect; verify again in a fresh context (verify --plan --again).`);
      else if (r.verify.outcome === 'too-few-decoys') console.log(`NOT DOUBLE-CHECKED: ${r.verify.tooFewDecoys}. The verdicts are recorded, but they count as no double-check: \`findings\` keeps these AI findings with those not double-checked. A run that captures more screens offers more decoys.`);
    }
  } else { console.error('nunchi verify: use --plan, or --record <verdicts.json>'); process.exit(1); }
} else if (cmd === 'recheck') {
  // The AI re-check (design §2.4): is an open AI finding still there on this run? The engine plans and records; the
  // judgement is the skill's (a fresh context).
  const R = await import('./recheck.mjs');
  const { writeStable, stableJson, sha } = await import('./stable.mjs');
  const { listRuns } = await import('./runs.mjs');
  const { byRun } = await import('./ledger.mjs');
  const { sceneDir } = await import('./hunt.mjs');
  const { readSource } = await import('./ai-identity.mjs');
  const fail = (msg, code = 1) => { console.error(`nunchi recheck: ${msg}`); process.exit(code); };
  if (!!args.plan === !!args.record) fail('use either --plan, or --record <verdicts.json>');
  const dir = runDirOf(args, 'recheck');
  const nunchiDir = resolve('.nunchi'), runsDir = join(nunchiDir, 'runs');
  const who = ledgerGuard(() => runIdentity(dir));
  if (who.why) fail(`run ${dir} cannot be re-checked: ${who.why}`);
  if (resolve(dirname(dir)) !== runsDir) fail(`run ${who.id} is not in this project's .nunchi/runs`);
  const guard = fn => { try { return runLock(dir, fn); } catch (e) { if (!['CORRUPT', 'LOCKED', 'UNSAFE_PATH'].includes(e.code)) throw e; fail(e.message, 2); } };
  const summary = rc => `re-check of run ${rc.run}: gone ${rc.verdicts.gone} · still there ${rc.verdicts['still-there']} · insufficient ${rc.verdicts.insufficient}${rc.verdicts.unanswered ? ` · unanswered ${rc.verdicts.unanswered}` : ''} · controls ${rc.controls.total} of ${rc.controls.planned} planned, passed through (answered gone or unanswered) ${rc.controls.passedThrough}/${rc.controls.total}${rc.controls.answered < rc.controls.total ? ` (${rc.controls.total - rc.controls.answered} unanswered)` : ''}`;
  const record = verdicts => {
    const res = guard(() => {
      const key = readKey(dir, 'recheck-key.json');
      if (!key) return { problems: ['this run has no answer key (recheck-key.json); run recheck --plan first'] };
      const packets = existsSync(join(dir, 'recheck-packets.json')) ? readJson(join(dir, 'recheck-packets.json')) : null;
      const r = R.recordRecheck({ key, packets, verdicts });
      if (r.problems.length) return r;
      // the verdicts go into the key first (outside the project): the ledger folds them from there (design §2.2);
      // recheck.json is a copy for people to read
      const list = Array.isArray(verdicts) ? verdicts : verdicts.verdicts;
      const { recorded: _replaced, ...plan } = key;
      writeKey(dir, 'recheck-key.json', { ...plan, recorded: { verdicts: list.map(v => ({ packet: v.packet, verdict: v.verdict, reason: v.reason.trim() })) } });
      writeStable(join(dir, 'recheck.json'), r.recheck);
      return r;
    });
    if (res.problems.length) { for (const p of res.problems) console.error('nunchi recheck: ' + p); process.exit(1); }
    res.folded = foldAfterRecord(dir, 'the re-check', args.root || process.cwd());
    return res;
  };
  if (args.plan) {
    const { state, decisions, approved, st } = loadLedger(nunchiDir, { root: args.root });
    const rows = view(state, decisions, approved);
    const manifest = readJson(join(dir, 'manifest.json'));
    const canaries = existsSync(join(dir, 'canaries.json')) ? readJson(join(dir, 'canaries.json')) : null;
    // the run before this one, for the controls: rule findings present then and now, its canary copies against this
    // run's (screens that changed between the two)
    const prevId = listRuns(runsDir).complete.filter(id => byRun(id, who.id) < 0).sort(byRun).pop() ?? null;
    let previous = null;
    if (prevId) {
      try {
        const pc = join(runsDir, prevId, 'canaries.json');
        previous = { runId: prevId, manifest: readJson(join(runsDir, prevId, 'manifest.json')), findings: readJson(join(runsDir, prevId, 'findings.json')).findings || [], canaries: existsSync(pc) ? readJson(pc) : null };
      } catch { previous = null; }
    }
    const runFindings = readJson(join(dir, 'findings.json')).findings || [];
    // each route's source at this run's capture (source-hashes.json) and the files it renders (source-map.json)
    const srcNow = routeHashes(dir);
    let routeFiles = {};
    try { routeFiles = readJson(join(dir, 'source-map.json')).routes || {}; } catch {}
    const routeSource = route => (srcNow[route] ? { hash: srcNow[route], files: Array.isArray(routeFiles[route]) ? routeFiles[route] : [] } : null);
    // a source file's hash can say "unchanged" only on the tree the run was captured from
    const appRoot = resolve(args.root || process.cwd());
    const meta = readJson(join(dir, 'run.json'));
    const sameTree = !!meta.tree && workTree(appRoot).tree === meta.tree;
    const cache = new Map();
    const fileHashOf = file => { const t = readSource(appRoot, file, cache); return t === null ? null : sha(t, 16); };
    const sceneFolder = (run, scene) => (/^\d{4,}$/.test(run) ? sceneDir(join(runsDir, run), scene) : null);
    const hasScene = (run, scene) => { const d = sceneFolder(run, scene); return !!d && existsSync(d); };
    const filesOf = (run, scene) => { const d = sceneFolder(run, scene); return d ? R.RECHECK_FILES.filter(n => existsSync(join(d, n))) : []; };
    const plan = R.planRecheck({ runId: who.id, manifest, rows, canaries, previous, runFindings, hasScene, sameTree, fileHashOf, filesOf, routeSource, stream: st.root.stream });
    const k = plan.key;
    // an item seen in a newer run than this one is left out: re-check it against the newest run
    // and one another worktree saw last is that worktree's to re-check (only it can say it is gone)
    const newer = [k.newer.length ? `${k.newer.length} open AI finding(s) were seen in a run newer than ${who.id}: re-check against the newest run` : null,
      k.otherWorktrees?.length ? `${k.otherWorktrees.length} open AI finding(s) were last seen by another worktree: that worktree re-checks them` : null].filter(Boolean).map(x => ` (${x})`).join('');
    if (!Object.keys(k.items).length) { console.log(`no open AI findings to re-check against run ${who.id}${newer}`); process.exit(0); }
    if (newer && !args.json) console.error(`nunchi recheck: left out${newer}`);
    guard(() => {
      R.writeRecheckMirror(dir, runsDir, plan.mirror);
      writeStable(join(dir, 'recheck-packets.json'), plan.packets);
      writeKey(dir, 'recheck-key.json', k);
    });
    const real = Object.values(k.packets).filter(p => p.kind === 'item').length;
    if (!plan.packets.packets.length) {
      // nothing to judge: every screen is unchanged (still there) or not in this run; recorded at once
      const res = record([]);
      if (args.json) console.log(JSON.stringify({ packets: 0, recheck: res.recheck, folded: res.folded }, null, 2));
      else console.log(`nothing to ask: ${k.unchanged.length} finding × screen(s) unchanged since last seen (still there), ${k.notCaptured.length} not captured in run ${who.id}. Recorded in recheck.json${res.folded ? ' and the ledger' : ''}.`);
      process.exit(0);
    }
    if (args.json) process.stdout.write(stableJson(plan.packets));
    else {
      console.log(`${plan.packets.packets.length} packets (${real} finding × screen, ${k.controls.made} control${k.controls.made === 1 ? '' : 's'}) → ${join(dir, 'recheck-packets.json')}`);
      console.log(`${k.unchanged.length} finding × screen(s) unchanged since last seen (still there, no packet) · ${k.notCaptured.length} not captured in this run (cannot be fixed by it)`);
      if (k.controls.made < k.controls.planned) console.log(`only ${k.controls.made} of ${k.controls.planned} planned controls could be made: this batch will be suspect and cannot mark anything fixed`);
      console.log(`Give the re-checker only recheck-packets.json and the files it names, in a fresh context. The answer key is kept outside the project (${dirname(keyPath(dir, 'recheck-key.json'))}): never open it or show it to the re-checker.`);
    }
  } else {
    const res = record(readJson(resolve(args.record)));
    if (args.json) console.log(JSON.stringify({ ...res.recheck, folded: res.folded }, null, 2));
    else {
      console.log(summary(res.recheck));
      if (res.recheck.suspect) console.log(`SUSPECT: ${res.recheck.suspectReason}. Nothing this batch said gone is marked fixed; re-check again in a fresh context.`);
    }
  }
} else if (cmd === 'export') {
  // A static review page (spec §7): read-only, offline, byte-identical for the same run and ledger.
  if (typeof args.html !== 'string' || !args.html || args.html.startsWith('--')) { console.error('nunchi export: use --html <dir> (writes <dir>/index.html and <dir>/img/)'); process.exit(1); }
  const { exportHtml } = await import('./export-html.mjs');
  const dir = runDirOf(args, 'export');
  let r;
  // read-only on the page's side; the ledger is brought up to date first, like `findings` does
  const ledger = existsSync(resolve('.nunchi')) ? loadLedger(resolve('.nunchi')) : null;
  try { r = exportHtml({ runDir: dir, nunchiDir: resolve('.nunchi'), outDir: resolve(args.html), inline: !!args.inline, ledger }); }
  catch (e) { if (e.code !== 'EXPORT_TARGET') throw e; console.error(`nunchi export: ${e.message}`); process.exit(1); }
  if (args.json) console.log(JSON.stringify(r, null, 2));
  else {
    const mb = Math.round(r.bytes / 1e5) / 10;
    console.log(`review page → ${r.out}${r.inline ? ' (one file, images inline)' : ` (+ ${r.images} screenshots in img/)`} · ${mb} MB`);
    console.log(`run ${r.run ?? '(not numbered)'} · ${r.scenes} screens · ${r.groups} groups, ${r.open} open${r.inLedger ? '' : ' · this run is not in the local ledger: statuses come from decisions only'}`);
    console.log('Open it in a browser. It holds screenshots of your app: putting it anywhere else sends them off this machine.');
  }
} else if (cmd === 'tokens') {
  // Design supporter, Stage 0 (Tidy): a token proposal from the run's evidence. Writes into the run only.
  const { buildTokens, readRunScenes, formatTokens, tokensCss } = await import('./tokens.mjs');
  const { writeStable, stableJson } = await import('./stable.mjs');
  const dir = runDirOf(args, 'tokens');
  let scenes;
  try { scenes = readRunScenes(dir); }
  catch (e) { if (e.code !== 'BAD_RUN') throw e; console.error(`nunchi tokens: ${e.message}`); process.exit(2); }
  if (!scenes.length) { console.error(`nunchi tokens: ${dir} has no captured screens to measure`); process.exit(1); }
  const report = buildTokens({ scenes });
  writeStable(join(dir, 'tokens.json'), report);
  writeStable(join(dir, 'tokens.css'), tokensCss(report));
  if (args.json) process.stdout.write(stableJson(report));
  else console.log(formatTokens(report, [join(dir, 'tokens.json'), join(dir, 'tokens.css')]));
} else if (cmd === 'gc') {
  // a run is folded before it can be removed: if the ledger cannot be brought up to date, nothing is removed,
  // and a run the ledger does not hold is never removed. The catch-up fold may write the ledger's first file: the
  // state folder is private before it (D12).
  const st = openState(resolve('.nunchi'));
  const state = ledgerGuard(() => { sweep(resolve('.nunchi'), st); return syncState(st); });
  // folded: this worktree's runs the ledger holds (any kind); pinned (design §8.1): runs an open item still names,
  // its last sighting and, for an AI item, the screens a re-check compares with
  const folded = new Set((state.folds || []).filter(f => f.source === 'rule' && (f.stream ?? 'main') === st.root.stream).map(f => f.run));
  const pinned = new Set();
  for (const i of Object.values(state.items)) {
    if (i.goneAt) continue;
    if (i.lastSeen) pinned.add(i.lastSeen);
    for (const s of Object.values(i.seen || {})) if (s?.run) pinned.add(s.run);
  }
  const r = gcRuns(resolve('.nunchi/runs'), { keep: Number.isInteger(args.keep) && args.keep > 0 ? args.keep : 5, folded, pinned });
  // a removed run's answer keys go with it
  for (const id of r.removed) if (/^\d{4,}$/.test(id)) removeKeys(resolve('.nunchi/runs', id));
  console.log(args.json ? JSON.stringify(r, null, 2) : `kept ${r.kept.join(', ') || 'nothing'} · removed ${r.removed.join(', ') || 'nothing'}`);
} else {
  console.error(`nunchi: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(1);
}
