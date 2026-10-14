// The fix loop (design 0.1-c §4): the engine never edits code. The skill edits and commits; the engine plans, checks the
// preconditions, runs the approved checks, captures the probes and judges. An outcome comes only from here.
//
//   to-fix ─start(clean, branch, claim, P0, baseline checks)→ started ─checks pass(tree T)→ checked
//   checked ─skill commits (1 commit, trailer)→ committed ─verify(rev-list, trailer, tree==T, diff policy)→ verifying
//   verifying ─P1 (+ re-check for AI)→ judged by precedence
//     inconclusive → needs-you(c) │ regression|not-fixed → reverted → (attempts<2 ? to-fix : needs-you(b))
//     drift → needs-you(a) │ fixed → fold P1(group) → fixed
//   decision changed during a claim → cancelled: revert if committed, release claim
//   claim expired / abort: before commit → to-fix; after commit → needs-you (commit shown)
//
// Every command reconciles the group's latest record with git (HEAD and its trailers, a revert in flight), the claim
// and the ledger first, and resumes what a command that died left half done (records.mjs: a phase is written before
// every side effect). Functions here return { code, lines, json }: the CLI prints the lines (the chat lines the skill
// relays: one per outcome) and exits with the code; nothing here prints or exits.
import { join, basename, dirname, relative, sep, resolve } from 'node:path';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import * as P from '../project.mjs';
import { titleOf, latestRunOf, foldFix, unfoldFix, commitFix, byRun, looked } from '../ledger.mjs';
import { human } from '../board/shared.mjs';
import { readConfig, workTree } from '../runs.mjs';
import { baseUrlRefusal } from '../network.mjs';
import { discover } from '../discover.mjs';
import { buildSourceMap, affectedRoutes, frameFilesOf } from '../sourcemap.mjs';
import { checkProfile, approvedProfiles, scriptsApprovedPath, checksRequestPath, CHECK_SCRIPTS } from '../checks.mjs';
import { writeStable, stableJson, sha } from '../stable.mjs';
import { readKey, writeKey, keyPath } from '../state.mjs';
import { fixGit, fixTrailers, TRAILERS } from './git.mjs';
import { acquireClaim, renewClaim, releaseClaim, readClaim, claimLive, refusalText, whileRenewing } from './claims.mjs';
import { allocate, setPhase, update, latestRecord, currentRecord, allRecords, latestRecords, isOpen, writePlan, readPlan, groupDir, kst } from './records.mjs';
import { randomBytes } from 'node:crypto';
import { probeView, probeProblems, judgeRules, judgeAi, MAX_ATTEMPTS, FLAKY, DRIFT_PIXELS } from './judge.mjs';
import { diffPolicy, depsOf, rootCauseFiles } from './policy.mjs';
import { fixBrief } from './brief.mjs';
import { runChecks as runChecksReal, compareChecks } from './run.mjs';
import { snapshotRecordings, snapshotIntact, proveByFile, serveApp, captureProbe, recaptureScenes, measureDrift, readProbe, controlsReader, sweepProbeFiles } from './probe.mjs';

const out = (code, lines, json = {}) => ({ code, lines: [].concat(lines).filter(x => x !== null && x !== undefined), json });
const refuse = (lines, json = {}) => out(1, lines, { refused: true, ...json });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const short = s => String(s || '').slice(0, 7);
const readJson = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };

// ---- context ---------------------------------------------------------------------------------------------------------

// The project as the fix loop sees it: the ledger (through project.mjs, as every ledger command reads it), the state
// folder, git (hardened). `cwd`: the folder holding .nunchi; `root`: the app's source (capture's --root).
export function openFix({ cwd, root = cwd, warn = () => {}, deps = {} }) {
  const nunchiDir = join(cwd, '.nunchi');
  const led = P.loadLedger(nunchiDir, { root, warn });
  const view = P.ledgerView(led, deps.now ? { now: deps.now() } : {});
  let git = null, gitError = null;
  try { git = fixGit(root); git.toplevel(); } catch (e) { git = null; gitError = e; }
  sweepProbeFiles(root);
  return { cwd, root, nunchiDir, led, rows: view.rows, groups: view.groups, stateDir: led.st.root.dir, generation: led.st.files.generation, runsDir: led.st.runsDir, stream: led.st.root.stream,
    idsFile: led.st.root.shared ? led.st.files.runIds : null, git, gitError, warn, deps: { now: () => Date.now(), runChecks: runChecksReal, prove: proveByFile, serve: serveApp, ...deps } };
}
const refresh = ctx => { const led = P.loadLedger(ctx.nunchiDir, { root: ctx.root, warn: ctx.warn }); const v = P.ledgerView(led, { now: ctx.deps.now() }); Object.assign(ctx, { led, rows: v.rows, groups: v.groups }); return ctx; };
const gen = ctx => ({ generation: ctx.generation, now: ctx.deps.now() });

// One group by its id (or a prefix of it, as `decide` takes).
function findGroup(ctx, id) {
  const hits = ctx.groups.filter(g => g.group === id || (id && id.length >= 4 && g.group.startsWith(id)));
  if (hits.length !== 1) return { error: hits.length ? `"${id}" matches ${hits.length} groups; give more characters` : `"${id}" is not a group of the ledger (nunchi findings --status to-fix lists them)` };
  const g = hits[0];
  const rows = ctx.rows.filter(r => r.group === g.group);
  return { g, rows, title: g.source === 'ai' ? `AI · ${human(g.rule)}` : titleOf(g.rule) };
}
// The rows still to fix, and the fix decision they carry (the newest, by its time, then id).
function toFix(rows) {
  const open = rows.filter(r => !r.goneAt);
  const fixing = open.filter(r => r.status === 'to-fix' && r.decision?.decision === 'fix');
  const decisions = fixing.map(r => r.decision).sort((a, b) => cmp(a.at || '', b.at || '') || cmp(a.id, b.id));
  return { open, fixing, decision: decisions[decisions.length - 1] || null, unverified: fixing.filter(r => r.decision && r.decision.verified === false) };
}
// The attempts made for this decision (design §4.5), from git's trailers on every branch: distinct Nunchi-Attempt values
// of the fix commits carrying the group and this decision (a rebased copy, or the same commit on a remote branch, is
// one attempt, not two). A git error throws (fail closed).
function attemptsUsed(ctx, group, decisionId) {
  if (!ctx.git) return 0;
  return new Set(ctx.git.groupCommits(group).filter(c => (c.trailers[TRAILERS.fix] || []).includes(group) && (c.trailers[TRAILERS.decision] || [null])[0] === decisionId)
    .map(c => (c.trailers[TRAILERS.attempt] || [null])[0])).size;
}
// Whether an earlier Fix decision of this group used every attempt (needs you b): then only a person's new Fix (the
// board's "Try again with a note…", or nunchi decide in their own terminal) starts another round, never the agent's.
function exhaustedBefore(ctx, group, decisionId) {
  if (!ctx.git) return false;
  const by = new Map();
  for (const c of ctx.git.groupCommits(group)) {
    if (!(c.trailers[TRAILERS.fix] || []).includes(group)) continue;
    const d = (c.trailers[TRAILERS.decision] || [null])[0];
    if (d === decisionId) continue;
    if (!by.has(d)) by.set(d, new Set());
    by.get(d).add((c.trailers[TRAILERS.attempt] || [null])[0]);
  }
  return [...by.values()].some(s => s.size >= MAX_ATTEMPTS) || allRecords(ctx.stateDir, group).some(r => r.outcome?.needsYou === 'b' && r.decision?.id !== decisionId);
}

// The last sweep of this worktree: what the probes copy (persons, states, sample paths, the base URL).
function lastSweep(ctx) {
  const id = latestRunOf(ctx.led.state, ctx.stream);
  if (!id) return null;
  const dir = join(ctx.runsDir, id);
  const meta = readJson(join(dir, 'run.json'), {}), manifest = readJson(join(dir, 'manifest.json'), {});
  const samplePaths = {}, seenAs = {};
  for (const s of Array.isArray(manifest.scenes) ? manifest.scenes : []) if (s && s.canary === undefined && typeof s.route === 'string' && typeof s.path === 'string' && !samplePaths[s.route]) samplePaths[s.route] = s.path;
  // the persons each route was a screen for (a visitor redirected to the login page was not)
  for (const s of Array.isArray(manifest.scenes) ? manifest.scenes : []) if (s && s.canary === undefined && typeof s.route === 'string' && typeof s.person === 'string') {
    seenAs[s.route] ||= new Set();
    if (looked(s)) seenAs[s.route].add(s.person);
  }
  const personsOf = Object.fromEntries(Object.entries(seenAs).map(([r, set]) => [r, [...set].sort()]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { id, dir, meta, manifest, samplePaths, personsOf, persons: meta.scope?.persons || ['guest'], states: meta.scope?.states || ['normal'], baseUrl: manifest.baseUrl || null };
}

// Root-cause files, the routes that render them, and every file the group's routes render (design §4.6).
function causeOf(ctx, rows, sweep) {
  const routes = (ctx._routes ||= discover(ctx.root).routes);
  const map = (ctx._map ||= buildSourceMap(ctx.root, routes));
  const groupRoutes = [...new Set(rows.map(r => r.route).filter(Boolean))].sort();
  const frames = new Set(groupRoutes.flatMap(r => { const rt = routes.find(x => x.path === r); return rt ? frameFilesOf(ctx.root, rt, routes) : []; }));
  const inventory = sweep ? readJson(join(sweep.dir, 'inventory.json'), null) : null;
  // the element's accessible name, from the scene it was last seen on (controls.json)
  const names = new Map();
  for (const r of rows) {
    const scene = r.examples?.[0];
    if (!scene || !r.lastSeen || !r.selector) continue;
    const c = readJson(join(ctx.runsDir, r.lastSeen, scene, 'controls.json'), []);
    const hit = Array.isArray(c) ? c.find(x => x && x.selector === r.selector) : null;
    if (hit && typeof hit.name === 'string') names.set(r.fp, hit.name);
  }
  const rc = rootCauseFiles({ rows, inventory, routes, frames, names });
  const rendering = [...new Set(rc.files.flatMap(f => map.files[f] || []))];
  const scopeRoutes = [...new Set([...groupRoutes, ...rendering])].filter(r => routes.some(x => x.path === r && (!x.params?.length || sweep?.samplePaths?.[r]))).sort();
  const allowed = [...new Set([...rc.files, ...groupRoutes.flatMap(r => map.routes[r] || [])])].sort();
  return { rootFiles: rc.files, from: rc.from, groupRoutes, scopeRoutes, allowed, map };
}

// A repository whose files go through git filters (LFS and the like): refused up front, with the paths (design §4.7;
// M3 review: nunchi's git runs with filters off, so the tree hash never matched and an undo wrote LFS pointers).
function filterRefusal(ctx) {
  let hit;
  try { hit = ctx.git.filtered(); } catch (e) { return `nunchi could not read this repository's git attributes (${String(e.stderr || e.message).trim().split('\n')[0]}): fix by hand for now.`; }
  if (!hit.length) return null;
  return `This repository runs files through git filters (Git LFS or similar: ${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}). nunchi runs git with every filter switched off, so its checks of the commit and its undo would see the stored form of those files, not the files: the fix loop does not work here yet. Fix by hand, then capture; finding and deciding still work.`;
}

// ---- reconcile (design §4.8: every command first) ---------------------------------------------------------------------

const claimOk = (ctx, rec) => { const c = readClaim(ctx.stateDir, rec.group); return !!c && !!rec.claim?.token && c.token === rec.claim.token && claimLive(c, ctx.deps.now()); };
const COMMITTED = new Set(['committed', 'verifying', 'p1', 'recheck', 'folding']);
// HEAD is this attempt's fix commit: its trailers name the group and the attempt, its one parent is the base.
function headIsFix(ctx, rec) {
  const head = ctx.git?.head();
  if (!head || head === rec.base) return null;
  const t = ctx.git.trailers(head);
  if (!(t[TRAILERS.fix] || []).includes(rec.group) || !(t[TRAILERS.attempt] || []).includes(String(rec.attempt))) return null;
  if (rec.decision?.id && !(t[TRAILERS.decision] || []).includes(rec.decision.id)) return null;
  return head;
}
export function reconcile(ctx, group) {
  let rec = latestRecord(ctx.stateDir, group);
  if (!rec || !isOpen(rec) || !ctx.git) return { rec, said: [] };
  const said = [];
  const close = (phase, fields) => { rec = setPhase(ctx.stateDir, rec, phase, fields, gen(ctx)); if (rec.claim?.token) releaseClaim(ctx.stateDir, group, rec.claim.token, { generation: ctx.generation }); };
  // a revert or an undo that a command started and did not see through
  if (rec.phase === 'reverting' || rec.phase === 'undoing') {
    const t = ctx.git.trailers(ctx.git.head() || 'HEAD');
    if ((t[TRAILERS.revert] || []).includes(`${group} attempt ${rec.attempt}`)) { finishRevert(ctx, rec, ctx.git.head(), said); return { rec: latestRecord(ctx.stateDir, group), said }; }
    // a revert left half done is aborted only when it is nunchi's own: started by this attempt, undoing its commit
    if (ctx.git.inProgress().includes('REVERT_HEAD') && rec.revertStarted && ctx.git.revertHead() === rec.commit) ctx.git.abortRevert();
    if (ctx.git.head() === rec.commit && !ctx.git.inProgress().length) { const r = doRevert(ctx, rec, rec.revertWhy || 'resumed'); said.push(...r.lines); return { rec: latestRecord(ctx.stateDir, group), said }; }
    close('needs-you', { outcome: { kind: 'needs-you', needsYou: 'revert-failed', commit: rec.commit, line: `Couldn't undo the fix of this finding (commit ${short(rec.commit)}): HEAD moved on or a revert was left half done. It needs you.` } });
    return { rec, said: [rec.outcome.line] };
  }
  if (rec.phase === 'folding') { applyFold(ctx, rec); return { rec: latestRecord(ctx.stateDir, group), said }; }
  // the skill's commit: started/checked → committed
  if (['started', 'checking', 'checked'].includes(rec.phase)) {
    const fixCommit = headIsFix(ctx, rec);
    if (fixCommit) rec = setPhase(ctx.stateDir, rec, 'committed', { commit: fixCommit }, gen(ctx));
  }
  const committed = rec.commit || headIsFix(ctx, rec);
  // a decision changed during the claim (design U8): cancelled, the commit undone when it is still HEAD. Only a
  // decision that moved away from Fix cancels: rows a sweep folded as gone (a capture on the fix branch) do not
  const mine = ctx.rows.filter(r => r.group === group);
  const latestDecision = mine.map(r => r.decision).filter(Boolean).sort((a, b) => cmp(a.at || '', b.at || '') || cmp(a.id, b.id)).pop() || null;
  if (latestDecision?.decision !== 'fix') {
    const now = latestDecision?.decision || 'reopen';
    const word = { keep: 'Keep', 'false-positive': 'Not a problem', hold: 'Later', reopen: 'to reopen it' }[now] || now;
    if (committed && ctx.git.head() === committed) {
      rec = setPhase(ctx.stateDir, rec, 'reverting', { cancel: { decision: now }, commit: committed, revertWhy: `the person decided ${now} while it was being fixed` }, gen(ctx));
      const r = doRevert(ctx, rec, rec.revertWhy, { cancelWord: word });
      return { rec: latestRecord(ctx.stateDir, group), said: r.lines };
    }
    if (committed) { close('needs-you', { outcome: { kind: 'needs-you', needsYou: 'interrupted', commit: committed, line: `You decided ${word} while I was fixing this; the fix (commit ${short(committed)}) is no longer the last commit, so nunchi did not undo it. It needs you.` } }); return { rec, said: [rec.outcome.line] }; }
    close('cancelled', { outcome: { kind: 'cancelled', line: `Stopped fixing: you decided ${word} while I was fixing it.` } });
    return { rec, said: [rec.outcome.line] };
  }
  // the claim expired (or was taken over): before the commit → to fix again; after → needs you, the commit shown
  if (!['starting', 'claiming'].includes(rec.phase) && rec.claim?.token && !claimOk(ctx, rec)) {
    if (committed) close('needs-you', { outcome: { kind: 'needs-you', needsYou: 'interrupted', commit: committed, line: `The fix of this finding (commit ${short(committed)}) was not re-checked before its claim expired. It needs you: tell your AI “retry” to re-check it, or “undo it”.` } });
    else close('aborted', { outcome: { kind: 'aborted', line: 'Stopped fixing: the claim expired before a fix was committed. It is still to fix.' } });
    return { rec, said: [rec.outcome.line] };
  }
  return { rec, said };
}

// ---- the fix plan (U19: one consent) ------------------------------------------------------------------------------------

export function planFixes(ctx, { url = null } = {}) {
  const rows = ctx.rows;
  const want = ctx.groups.filter(g => rows.some(r => r.group === g.group && r.status === 'to-fix' && !r.goneAt && r.decision?.decision === 'fix'));
  const sweep = lastSweep(ctx);
  const items = [];
  for (const g of want.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.routes.length - a.routes.length || cmp(a.group, b.group))) {
    const mine = rows.filter(r => r.group === g.group);
    const tf = toFix(mine);
    if (!tf.fixing.length) continue;
    const rec = latestRecord(ctx.stateDir, g.group);
    const cause = causeOf(ctx, tf.fixing, sweep);
    const used = attemptsUsed(ctx, g.group, tf.decision?.id);
    const title = g.source === 'ai' ? `AI · ${human(g.rule)}` : titleOf(g.rule);
    items.push({ group: g.group, title, severity: g.severity, routes: g.routes, rootFiles: cause.rootFiles, attemptsUsed: used, needsApproval: tf.unverified.length > 0,
      notDoubleChecked: tf.fixing.some(r => r.source === 'ai' && !r.checked), routeless: !cause.groupRoutes.length, last: rec ? { attempt: rec.attempt, phase: rec.phase, needsYou: rec.outcome?.needsYou ?? null } : null });
  }
  const dirty = ctx.git ? ctx.git.status() : null;
  const branch = ctx.git ? planBranch(ctx) : null;
  const profile = checkProfile(ctx.root);
  const checks = profile ? CHECK_SCRIPTS.filter(n => profile.scripts[n] !== undefined) : [];
  let approved = !profile || (!checks.length && !Object.keys(profile.serve || {}).length);
  try { if (profile && !approved) approved = approvedProfiles(scriptsApprovedPath(ctx.stateDir)).has(profile.hash); } catch {}
  if (profile && !approved && items.length) writeChecksRequest(ctx, profile);
  const base = url || sweep?.baseUrl || null;
  writePlan(ctx.stateDir, { groups: items.map(i => i.group), branch }, { now: ctx.deps.now() });
  const lines = [];
  if (!items.length) lines.push('Nothing to fix: no group is decided Fix (decide in the board, or nunchi decide <id> fix).');
  else {
    lines.push(`Fix plan: ${items.length} finding${items.length === 1 ? '' : 's'} to fix. Fixes go on branch ${branch || 'a new nunchi/fixes branch'}; merge it when you're happy.`);
    items.forEach((i, n) => lines.push(`  ${n + 1}. ${i.severity.padEnd(7)} ${i.title} — ${i.routes.length ? i.routes.slice(0, 3).join(', ') + (i.routes.length > 3 ? ` +${i.routes.length - 3}` : '') : 'the whole app'} · fix in ${i.rootFiles.length ? i.rootFiles.join(', ') : 'the code that renders it'}${i.attemptsUsed ? ` · ${i.attemptsUsed} of ${MAX_ATTEMPTS} attempts used` : ''}${i.needsApproval ? ' · came through git: needs nunchi approve first' : ''}${i.notDoubleChecked ? ' · not double-checked' : ''}${i.routeless ? ' · no screen to re-check: fix by hand' : ''}  (group ${i.group})`));
    lines.push(checks.length ? `Checks nunchi runs before each fix is committed: ${checks.join(', ')}${approved ? ' (approved).' : ' — not approved yet: approve them in the board (a card shows the exact lines) or run `nunchi fix --approve-checks` in your own terminal.'}` : 'No build, typecheck, lint or test script: nunchi relies on re-capture.');
    if (dirty && dirty.length) lines.push(`Your working tree has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}. Choose once: 1. commit them as "WIP before nunchi fixes" (recommended), 2. stash them, or 3. stop.`);
    lines.push(base ? `The app must answer at ${base} (or start it with --serve dev|start), with the data the last capture recorded.` : 'Start the app and give its address with --url (never production).');
  }
  return out(0, lines, { plan: items, branch, dirty: dirty ? dirty.length : null, checks: { names: checks, approved, hash: profile?.hash ?? null }, url: base });
}
function writeChecksRequest(ctx, profile) {
  try { writeStable(checksRequestPath(ctx.stateDir), { schema: 1, note: 'the fix loop asks a person to approve the check profile (board card or nunchi fix --approve-checks)', hash: profile.hash, root: resolve(ctx.root), at: kst(ctx.deps.now()) }); } catch {}
}
// The branch the fix goes on (design §4.2): the nunchi/fix branch HEAD is on already; else nunchi/fixes-<MMDD> (KST),
// or nunchi/fix-<group> in a linked worktree (design §7: a per-group branch when several agents work).
function planBranch(ctx, group = null) {
  const cur = ctx.git.branch();
  if (cur && /^nunchi\/fix/.test(cur)) return cur;
  if (ctx.stream !== 'main' && group) return `nunchi/fix-${group}`;
  const d = new Date(ctx.deps.now() + 9 * 3600e3);
  return `nunchi/fixes-${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---- start (design §4.2–§4.4) -----------------------------------------------------------------------------------------

const RESUME_START = new Set(['starting', 'branching', 'claiming', 'snapshot', 'baseline', 'p0']);
export async function startFix(ctx, id, opts = {}) {
  if (!ctx.git) return refuse(`The fix loop needs git (${ctx.gitError?.message || 'no repository here'}): nunchi fixes on a branch it makes, and undoes a fix with git revert.`);
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  const { g, title } = found;
  const r0 = reconcile(ctx, g.group);
  refresh(ctx);
  let rec = r0.rec;
  const said = [...r0.said];
  const rows = ctx.rows.filter(r => r.group === g.group);
  const tf = toFix(rows);
  // an attempt that is open: resume a start that stopped half way; anything later says where to go on
  if (rec && isOpen(rec)) {
    if (!RESUME_START.has(rec.phase)) {
      if (COMMITTED.has(rec.phase)) return refuse([...said, `HEAD carries an unverified fix of '${title}' (commit ${short(rec.commit)}): resume with nunchi fix --verify ${g.group}.`]);
      return out(0, [...said, `'${title}' is being fixed already (attempt ${rec.attempt}, ${rec.phase}). Edit, then nunchi fix --checks ${g.group}.`, '', briefFor(ctx, g, rows, rec)], { attempt: rec.attempt, phase: rec.phase, resumed: true });
    }
    if (!['starting', 'claiming'].includes(rec.phase) && !claimOk(ctx, rec)) return refuse([...said, 'This start lost its claim; run nunchi fix --start again.']);
  } else rec = null;
  const early = !rec || ['starting', 'claiming', 'branching'].includes(rec.phase);
  if (!tf.fixing.length) return refuse([...said, `'${title}' is not decided Fix (it is ${g.status}): decide in the board first.`]);
  if (tf.unverified.length) return refuse([...said, `The Fix decision on '${title}' came through git and is not approved on this machine: nunchi does not act on it until you run nunchi approve in your own terminal.`]);
  // design §1: the agent may start a fix for a confirmed AI finding or a rule finding; one nobody double-checked needs a
  // person's Fix (the board asks "This hasn't been double-checked. Fix anyway?")
  if (tf.fixing.some(r => r.source === 'ai' && !r.checked && r.decision && r.decision.human !== true)) return refuse([...said, `Nobody double-checked the AI finding '${title}', and its Fix was recorded by your AI: verify it first (nunchi verify --plan), or decide Fix in the board.`]);
  const last = latestRecord(ctx.stateDir, g.group);
  const head = ctx.git.head();
  if (!rec) {
    // a fix that was kept for the person (needs you a), or that waits for them (b, c): only a newer Fix decision (the
    // board's "Try again with a note…") starts another attempt; (a)'s kept commit is undone first
    if (last && last.phase === 'needs-you') {
      const newer = tf.decision && last.decision && tf.decision.id !== last.decision.id && cmp(tf.decision.at || '', last.decision.at || '') >= 0;
      const k = last.outcome?.needsYou;
      if (newer && k === 'b' && tf.decision.human !== true) return refuse([...said, `The AI couldn't fix '${title}' in ${MAX_ATTEMPTS} tries, and only the person can start another round: ask them to choose “Try again with a note…” for it in the board (nunchi open). A Fix your AI records does not count.`]);
      if (!newer) {
        if (k === 'a') return refuse([...said, `The last fix of '${title}' waits for you in the board: it also changed other parts of the screen. Look there ("Looks fine", "Undo this fix" or "Try again with a note…").`]);
        if (k === 'b') return refuse([...said, `The AI couldn't fix '${title}' in ${MAX_ATTEMPTS} tries: it waits for you in the board ("Try again with a note…", Keep or Later).`]);
        if (last.commit && head === last.commit) return refuse([...said, `The last fix of '${title}' (commit ${short(last.commit)}) was not re-checked: start your app, then resume with nunchi fix --verify ${g.group} (retry), or undo it with nunchi fix --undo ${g.group}.`]);
      } else if (last.commit && head === last.commit && (k === 'a' || k === 'c' || k === 'diff' || k === 'unbaselined' || k === 'interrupted' || k === 'dirty')) {
        const dirty = ctx.git.uncommitted();
        if (dirty.length) return refuse([...said, dirtyLine(title, last.commit, dirty, { refusal: true })], { dirty });
        const rv = doRevert(ctx, setPhase(ctx.stateDir, last, 'reverting', { tryAgain: true, revertWhy: 'the person asked to try again with a note' }, gen(ctx)), 'the person asked to try again with a note', { quiet: true });
        if (rv.code) return rv;
        said.push(`Undid the kept fix (commit ${short(last.commit)}) to try again with your note.`);
      }
    }
    // HEAD carries an unverified fix of this group (a commit with its trailer that no closed record judged)
    const t = head ? ctx.git.trailers(head) : {};
    if ((t[TRAILERS.fix] || []).includes(g.group) && !(last && last.commit === head && !isOpen(last))) return refuse([...said, `HEAD carries an unverified fix of '${title}': resume with nunchi fix --verify ${g.group}.`]);
    const used = attemptsUsed(ctx, g.group, tf.decision.id);
    if (used >= MAX_ATTEMPTS) return refuse([...said, `The AI couldn't fix '${title}' in ${MAX_ATTEMPTS} tries: it waits for you in the board ("Try again with a note…", Keep or Later).`]);
    if (tf.decision.human !== true && exhaustedBefore(ctx, g.group, tf.decision.id)) return refuse([...said, `The AI couldn't fix '${title}' in ${MAX_ATTEMPTS} tries, and only the person can start another round: ask them to choose “Try again with a note…” for it in the board (nunchi open). A Fix your AI records does not count.`]);
  }
  if (early) {
    if (!head) return refuse('This repository has no commit yet: commit once, then fix.');
    const filtered = filterRefusal(ctx);
    if (filtered) return refuse([...said, filtered]);
    if (!ctx.git.branch()) return refuse('HEAD is detached: switch to a branch first (nunchi makes its fix branch from it).');
    const dirty = ctx.git.status();
    if (dirty.length || ctx.git.inProgress().length) return refuse([...said, `Your working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` +${dirty.length - 5} more` : ''}${ctx.git.inProgress().length ? `; a ${ctx.git.inProgress()[0]} is in progress` : ''}): commit them as "WIP before nunchi fixes", or stash them, before fixing.`], { dirty });
  }
  const sweep = lastSweep(ctx);
  if (!sweep) return refuse('No capture yet: nunchi capture --url <your local server> first.');
  const cause = rec?.scope ? null : causeOf(ctx, tf.fixing, sweep);
  if (!rec && !cause.groupRoutes.length) return refuse(`'${title}' belongs to the whole app, not to a screen nunchi can re-check: fix it by hand, then run a full capture.`);
  // the address: --url, else the last capture's (this folder's app); a linked worktree runs its own server
  const url = opts.url || rec?.url || (ctx.stream === 'main' ? sweep.baseUrl : null);
  if (!url && !opts.serve) return refuse('Start the app from this folder on a free port (e.g. `PORT=3001 npm run dev`), then start with `--url http://127.0.0.1:3001`.');
  let allowBaseHosts = [];
  try { allowBaseHosts = readConfig(ctx.nunchiDir).allowHosts; } catch (e) { return out(2, `nunchi: ${e.message}`); }
  if (url) { const no = baseUrlRefusal(url, allowBaseHosts); if (no) return out(2, `nunchi fix: ${no}`); }
  if (opts.serve && !['dev', 'start'].includes(opts.serve)) return refuse('--serve takes dev or start (the approved scripts that start your app).');
  // the check profile: approved through a person before anything of the repository runs
  const profile = checkProfile(ctx.root);
  const checkNames = profile ? CHECK_SCRIPTS.filter(n => profile.scripts[n] !== undefined) : [];
  if (profile && (checkNames.length || opts.serve)) {
    let ok = false;
    try { ok = approvedProfiles(scriptsApprovedPath(ctx.stateDir)).has(profile.hash); } catch (e) { return out(2, `nunchi: ${e.message}`); }
    if (!ok) { writeChecksRequest(ctx, profile); return refuse([...said, `Your check scripts (${[...checkNames, ...(opts.serve ? [opts.serve] : [])].join(', ')}) are not approved yet: approve them in the board (nunchi open shows a card with the exact lines), or run \`nunchi fix --approve-checks\` in your own terminal. nunchi never approves them for you.`], { checksRequested: true }); }
  }
  const persons = sweep.persons.filter(p => p !== 'signed-in' || existsSync(join(ctx.nunchiDir, 'auth.json')));
  // ---- the attempt
  if (!rec) {
    const scope = { routes: cause.scopeRoutes, persons, personsOf: Object.fromEntries(cause.scopeRoutes.map(r => [r, sweep.personsOf[r] ?? persons])), viewports: ['d', 'm'], states: sweep.states };
    rec = allocate(ctx.stateDir, g.group, {
      decision: { id: tf.decision.id, at: tf.decision.at ?? null, note: tf.decision.note ?? null }, try: attemptsUsed(ctx, g.group, tf.decision.id) + 1, base: head, startBranch: ctx.git.branch(), worktree: ctx.git.toplevel(), stream: ctx.stream,
      url: url || null, serve: opts.serve || null, agent: opts.agent || null, vendor: opts.vendor || null, allowHosts: opts.allowHosts || [], title,
      rootFiles: cause.rootFiles, rootFrom: cause.from, allowed: cause.allowed, routes: cause.groupRoutes, scope, samplePaths: sweep.samplePaths, personsOf: sweep.personsOf, sweep: sweep.id,
      fps: { rule: tf.fixing.filter(r => r.source !== 'ai').map(r => r.fp).sort(), ai: tf.fixing.filter(r => r.source === 'ai').map(r => r.fp).sort() },
    }, gen(ctx));
  }
  // claim first (design §7), then the branch
  if (rec.phase === 'starting' || rec.phase === 'claiming') {
    // the token goes into the record before the claim is taken: a command killed in between finds the claim its own
    if (rec.phase === 'starting') rec = setPhase(ctx.stateDir, rec, 'claiming', { claim: { token: randomBytes(16).toString('hex') } }, gen(ctx));
    const branch = planBranch(ctx, g.group);
    const c = acquireClaim(ctx.stateDir, { group: g.group, worktree: rec.worktree, branch, url: rec.url || 'serve', files: rec.rootFiles, agent: rec.agent, vendor: rec.vendor, mine: rec.claim?.token || null, fresh: rec.claim?.token || null, now: ctx.deps.now(), generation: ctx.generation });
    if (!c.ok) {
      setPhase(ctx.stateDir, rec, 'aborted', { outcome: { kind: 'aborted', reason: `claim-${c.why}` } }, gen(ctx));
      return refuse(refusalText(c, { me: rec.agent, folder: basename(rec.worktree), worktree: rec.worktree, now: ctx.deps.now() }), { claim: c.why });
    }
    rec = setPhase(ctx.stateDir, rec, 'branching', { claim: { token: c.token }, branch }, gen(ctx));
  }
  if (rec.phase === 'branching') {
    const cur = ctx.git.branch();
    const def = ctx.git.defaultBranch();
    if (cur !== rec.branch) {
      try { if (ctx.git.branchExists(rec.branch)) { if (ctx.git.parents(rec.branch)[0] !== ctx.git.head()) throw new Error(`branch ${rec.branch} exists and is not where HEAD is`); ctx.git.switchTo(rec.branch); } else ctx.git.switchNew(rec.branch); }
      catch (e) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'branch' }); return refuse(`Could not make the fix branch ${rec.branch} (${String(e.stderr || e.message).trim().split('\n')[0]}): nothing was changed.`); }
    }
    if (ctx.git.branch() === def) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'default-branch' }); return refuse(`${def} is the default branch: nunchi never fixes there.`); }
    rec = setPhase(ctx.stateDir, rec, 'snapshot', {}, gen(ctx));
  }
  const harDir = join(groupDir(ctx.stateDir, g.group), `${rec.attempt}-har`);
  if (rec.phase === 'snapshot') {
    const snap = snapshotRecordings(join(ctx.nunchiDir, 'har'), harDir, rec.scope.persons);
    if (snap.missing) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'no-recording' }); return refuse(`There is no recording of the app's data for ${snap.missing.join(', ')} (.nunchi/har): capture once with --network record, then fix.`); }
    rec = setPhase(ctx.stateDir, rec, 'baseline', { har: { shas: snap.shas } }, gen(ctx));
  }
  if (rec.phase === 'baseline') {
    renewClaim(ctx.stateDir, g.group, rec.claim.token, ctx.deps.now());
    const base = profile && checkNames.length ? await whileRenewing(ctx.stateDir, g.group, rec.claim.token, () => ctx.deps.runChecks({ root: ctx.root, profile }), { now: ctx.deps.now }) : { pm: null, results: {} };
    rec = setPhase(ctx.stateDir, rec, 'p0', { baseline: { pm: base.pm, results: trimResults(base.results), profile: profile?.hash ?? null } }, gen(ctx));
  }
  if (rec.phase === 'p0') {
    const p = await probe(ctx, rec, 'P0', { url: opts.url || rec.url, serve: opts.serve || rec.serve, scope: rec.scope, harDir, profile });
    rec = currentRecord(ctx.stateDir, rec);
    if (p.error) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'p0', line: p.error }); return out(p.code || 1, [`Couldn't capture the screens before the fix: ${p.error}. Start your app, then tell your AI “retry”.`]); }
    const view = probeView(readProbe(p.runDir), controlsReader(p.runDir));
    const bad = probeProblems(view);
    if (bad.length) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'p0-inconclusive', p0: { run: p.runId }, reasons: bad }); return out(1, [`Couldn't capture the screens before the fix: ${bad.map(x => x.text).join('; ')}. Start your app (and capture with --network record if the recording is stale), then tell your AI “retry”.`], { p0: p.runId }); }
    const shows = rec.fps.ai.length || view.all.some(x => rec.fps.rule.includes(x.f.fp));
    if (!shows) { closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'not-in-p0', p0: { run: p.runId } }); return out(1, `The screens before the fix no longer show '${title}': it may be fixed already. Capture again (nunchi capture) and look in the board.`, { p0: p.runId }); }
    rec = setPhase(ctx.stateDir, rec, 'started', { p0: { run: p.runId, proof: p.proof } }, gen(ctx));
  }
  refresh(ctx);
  return out(0, [...said, briefFor(ctx, g, ctx.rows.filter(r => r.group === g.group), rec)], { group: g.group, attempt: rec.attempt, branch: rec.branch, p0: rec.p0?.run ?? null, trailers: trailersOf(rec) });
}
const trimResults = results => Object.fromEntries(Object.entries(results || {}).map(([k, v]) => [k, { ...v, ...(typeof v.output === 'string' ? { output: v.output.slice(-2000) } : {}) }]));
const trailersOf = rec => fixTrailers({ group: rec.group, attempt: rec.attempt, decision: rec.decision?.id });
function closeWith(ctx, rec, phase, outcome) {
  const r = setPhase(ctx.stateDir, rec, phase, { outcome }, gen(ctx));
  if (rec.claim?.token) releaseClaim(ctx.stateDir, rec.group, rec.claim.token, { generation: ctx.generation });
  return r;
}

// The brief for the current attempt (design §4.11), from the instances P0 (or the last sweep) shows.
function briefFor(ctx, g, rows, rec) {
  const run = rec.p0?.run || rec.sweep;
  const manifest = readJson(join(ctx.runsDir, run || '', 'manifest.json'), { scenes: [] });
  const findings = readJson(join(ctx.runsDir, run || '', 'findings.json'), { findings: [] }).findings || [];
  const scenes = new Map((manifest.scenes || []).map(s => [s.id, s]));
  const fps = new Set([...(rec.fps?.rule || []), ...(rec.fps?.ai || [])]);
  const inst = findings.filter(f => fps.has(f.fp)).map(f => ({ scene: scenes.get(f.scene) || {}, selector: f.selector, box: f.box, evidence: f.evidence }));
  for (const r of rows.filter(x => x.source === 'ai' && fps.has(x.fp))) for (const [cell, s] of Object.entries(r.seen || {})) {
    const [person, state, viewport] = cell.split('.');
    inst.push({ scene: { route: r.route, person, state, viewport }, selector: s?.selector ?? r.selector, box: s?.box ?? null, evidence: r.evidence });
  }
  const profile = checkProfile(ctx.root);
  return fixBrief({ group: { id: g.group, lens: g.lens, rule: g.rule, severity: g.severity, routes: g.routes }, rows, instances: inst, rootFiles: rec.rootFiles || [],
    allowedNote: `the other files these screens render (${(rec.allowed || []).length} file${(rec.allowed || []).length === 1 ? '' : 's'}, from the source map)`, trailers: trailersOf(rec), attempt: rec.try || rec.attempt, of: MAX_ATTEMPTS,
    branch: rec.branch, note: rec.decision?.note || null, checks: profile ? CHECK_SCRIPTS.filter(n => profile.scripts[n] !== undefined) : [] }).trimEnd();
}
export function briefFix(ctx, id) {
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  const { rec } = reconcile(ctx, found.g.group);
  if (!rec || !isOpen(rec)) return refuse(`No attempt of '${found.title}' is open: nunchi fix --start ${found.g.group} starts one.`);
  return out(0, briefFor(ctx, found.g, found.rows, rec), { attempt: rec.attempt });
}

// A probe with its proof (design §4.4). → { runId, runDir, proof } or { error }.
// `keep`: the server --serve started stays up (its `stop` is returned) until the caller is done judging, so the
// re-captures of flaky rules see the same app.
// `--serve start` serves what was last built in this folder: it proves the commit only when the approved build check
// passed on this very tree (the baseline at P0; the checks whose tree verify compared with the commit's at P1).
async function probe(ctx, rec, which, { url, serve, scope, harDir, profile, keep = false }) {
  let stop = null, base = url, proof, kept = false;
  if (!snapshotIntact(harDir, rec.har?.shas)) return { error: 'the attempt\'s recording snapshot changed or is missing' };
  if (serve === 'start') {
    const built = which === 'P0' ? rec.baseline?.results?.build?.status === 'pass' : rec.checks?.results?.build?.status === 'pass';
    if (!built) {
      const why = '--serve start serves what was last built in this folder, and no approved build check passed on this commit: approve a build script, or use --serve dev, or --url with the app started from this folder';
      return which === 'P0' ? { error: why } : { noProof: why };
    }
  }
  if (serve) {
    const s = await ctx.deps.serve({ root: ctx.root, profile, script: serve, url });
    if (!s.ok) return { error: s.why };
    stop = s.stop; base = s.url; proof = { ok: true, how: 'serve', script: serve };
  }
  try {
    if (!proof) {
      proof = await ctx.deps.prove({ root: ctx.root, url: base });
      if (!proof.ok) return which === 'P0' ? { error: proof.why } : { noProof: proof.why };
    }
    if (!ctx.deps.capture) return { error: 'the engine is not set up (nunchi setup)' };
    let allowBaseHosts = [];
    try { allowBaseHosts = readConfig(ctx.nunchiDir).allowHosts; } catch {}
    const r = await whileRenewing(ctx.stateDir, rec.group, rec.claim.token, () => captureProbe({
      capture: ctx.deps.capture, root: ctx.root, nunchiDir: ctx.nunchiDir, runsDir: ctx.runsDir, idsFile: ctx.idsFile, stream: ctx.stream, url: base, scope, samplePaths: rec.samplePaths || {}, harDir,
      storageState: join(ctx.nunchiDir, 'auth.json'), allowHosts: rec.allowHosts || [], allowBaseHosts, browserPath: ctx.deps.browserPath,
      fix: { group: rec.group, attempt: rec.attempt, probe: which, har: rec.har?.shas || {} }, canaries: 3, canarySeed: sha(`${rec.group}:${rec.attempt}:canaries`, 16), canaryRoutes: rec.routes,
      onStart: runId => { rec = update(ctx.stateDir, rec, { [which === 'P0' ? 'p0' : 'p1']: { run: runId, partial: true } }); },
    }));
    kept = keep;
    return { runId: r.runId, runDir: r.runDir, proof, base, stop: kept ? stop : null };
  } catch (e) {
    if (['NO_BROWSER', 'NO_AUTH', 'NO_RECORDING', 'BAD_RECORDING', 'URL_NOT_ALLOWED', 'BAD_ARGS'].includes(e.code)) return { error: e.message, code: 2 };
    throw e;
  } finally { if (stop && !kept) stop(); }
}

// ---- checks (design §4.3) -------------------------------------------------------------------------------------------

export async function checkFix(ctx, id) {
  if (!ctx.git) return refuse('The fix loop needs git.');
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  let { rec, said } = reconcile(ctx, found.g.group);
  if (!rec || !isOpen(rec)) return refuse([...said, `No attempt of '${found.title}' is open: nunchi fix --start ${found.g.group} starts one.`]);
  if (!['started', 'checking', 'checked'].includes(rec.phase)) return refuse([...said, rec.phase === 'committed' ? `The fix is committed already (${short(rec.commit)}): nunchi fix --verify ${found.g.group}.` : `This attempt is ${rec.phase}: nunchi fix --start ${found.g.group} resumes it.`]);
  renewClaim(ctx.stateDir, rec.group, rec.claim.token, ctx.deps.now());
  const profile = checkProfile(ctx.root);
  const names = profile ? CHECK_SCRIPTS.filter(n => profile.scripts[n] !== undefined) : [];
  if (profile && names.length && profile.hash !== rec.baseline?.profile) {
    let ok = false;
    try { ok = approvedProfiles(scriptsApprovedPath(ctx.stateDir)).has(profile.hash); } catch {}
    if (!ok) { writeChecksRequest(ctx, profile); return refuse('The check scripts changed since they were approved (package.json or the package-manager settings): approve them again in the board or with `nunchi fix --approve-checks` in your own terminal.'); }
  }
  const tree = ctx.git.workingTree();
  rec = setPhase(ctx.stateDir, rec, 'checking', {}, gen(ctx));
  const now = names.length ? await whileRenewing(ctx.stateDir, rec.group, rec.claim.token, () => ctx.deps.runChecks({ root: ctx.root, profile }), { now: ctx.deps.now }) : { results: {} };
  const after = ctx.git.workingTree();
  if (after !== tree) { rec = setPhase(ctx.stateDir, rec, 'started', { checks: null }, gen(ctx)); return refuse('The checks changed your files while they ran (a formatter or generator?): look at the change, then run nunchi fix --checks again.'); }
  const cmpd = compareChecks(rec.baseline?.results || {}, now.results);
  const pass = !cmpd.blocking.length;
  rec = setPhase(ctx.stateDir, rec, pass ? 'checked' : 'started', { checks: { tree, results: trimResults(now.results), blocking: cmpd.blocking, lines: cmpd.lines, pass } }, gen(ctx));
  const lines = [...said, ...cmpd.lines];
  if (!pass) return out(1, [...lines, `Not ready to commit: ${cmpd.blocking.join(', ')} ${cmpd.blocking.length === 1 ? 'is' : 'are'} failing because of this change.`], { pass, blocking: cmpd.blocking, tree });
  lines.push(`Checks pass for this tree (${tree.slice(0, 12)}). Commit it now as one commit (never .nunchi/), its message ending with:`, ...trailersOf(rec).map(t => `  ${t}`), `then run nunchi fix --verify ${rec.group}.`);
  return out(0, lines, { pass, tree, trailers: trailersOf(rec) });
}

// ---- verify (design §4.4–§4.7) -----------------------------------------------------------------------------------------

export async function verifyFix(ctx, id, opts = {}) {
  if (!ctx.git) return refuse('The fix loop needs git.');
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  const { g, title } = found;
  const wasOpen = isOpen(latestRecord(ctx.stateDir, g.group));
  let { rec, said } = reconcile(ctx, g.group);
  if (!rec) return refuse(`No attempt of '${title}': nunchi fix --start ${g.group} starts one.`);
  // what this very call's reconcile closed (an expired claim, say) is said, not retried: a retry is asked for
  if (wasOpen && !isOpen(rec)) return out(0, said, { outcome: rec.phase, needsYou: rec.outcome?.needsYou ?? null });
  const retry = rec.phase === 'needs-you' && ['c', 'interrupted'].includes(rec.outcome?.needsYou) && rec.commit && ctx.git.head() === rec.commit;
  if (!isOpen(rec) && !retry) return refuse([...said, `The last attempt of '${title}' is closed (${rec.phase}${rec.outcome?.needsYou ? ` (${rec.outcome.needsYou})` : ''}).`]);
  if (rec.phase === 'recheck') return refuse([...said, `The re-check of '${title}' waits for its verdicts: nunchi fix --verify ${g.group} --record <verdicts.json>.`]);
  if (['started', 'checking'].includes(rec.phase)) return refuse([...said, `Run nunchi fix --checks ${g.group} first (and commit what passes).`]);
  if (rec.phase === 'checked') return refuse([...said, `No commit of this attempt is on HEAD: commit the fix as one commit ending with the trailers nunchi fix --checks printed (${trailersOf(rec).join(' / ')}), then verify.`]);
  if (retry) {
    // a retry (needs you c, or an interrupted attempt): the claim again, then P1 again
    const c = acquireClaim(ctx.stateDir, { group: g.group, worktree: rec.worktree, branch: rec.branch, url: opts.url || rec.url || 'serve', files: rec.rootFiles, agent: rec.agent, vendor: rec.vendor, mine: null, now: ctx.deps.now(), generation: ctx.generation });
    if (!c.ok) return refuse(refusalText(c, { me: rec.agent, folder: basename(rec.worktree), worktree: rec.worktree, now: ctx.deps.now() }));
    rec = setPhase(ctx.stateDir, rec, 'committed', { claim: { token: c.token }, outcome: null, retried: (rec.retried || 0) + 1 }, gen(ctx));
  }
  const filtered = filterRefusal(ctx);
  if (filtered) return refuse([...said, filtered]);
  // the commit check: one commit on the base, the trailer, a clean tree, not the default branch
  const head = ctx.git.head();
  const parents = ctx.git.parents(head);
  const t = ctx.git.trailers(head);
  const problems = [];
  if (head !== rec.commit) problems.push(`HEAD (${short(head)}) is not the fix commit of this attempt (${short(rec.commit)})`);
  if (parents.length !== 2 || parents[1] !== rec.base) problems.push(`the fix must be exactly one commit on ${short(rec.base)} (git rev-list --parents -n1 HEAD gives ${parents.map(short).join(' ')})`);
  if (!(t[TRAILERS.fix] || []).includes(g.group) || !(t[TRAILERS.attempt] || []).includes(String(rec.attempt)) || (rec.decision?.id && !(t[TRAILERS.decision] || []).includes(rec.decision.id))) problems.push(`the commit lacks the trailers ${trailersOf(rec).join(' / ')}`);
  if (rec.branch && ctx.git.branch() !== rec.branch) problems.push(`HEAD is ${ctx.git.branch() ? `on ${ctx.git.branch()}` : 'detached'}, not on the fix branch ${rec.branch}: switch back to it`);
  if (!ctx.git.clean()) problems.push(`the working tree is not clean (${ctx.git.status().slice(0, 4).join(', ')})`);
  if (ctx.git.branch() === ctx.git.defaultBranch()) problems.push(`the fix is on ${ctx.git.branch()}, the default branch: nunchi never fixes there`);
  if (problems.length) return refuse([...said, `Not verified: ${problems.join('; ')}.`]);
  // the checks ran on this very tree, and passed
  const tree = ctx.git.treeOf(head);
  if (!rec.checks?.pass || rec.checks.tree !== tree) return refuse([...said, `The checks did not run on this commit's tree (${tree.slice(0, 12)}${rec.checks?.tree ? `; they ran on ${rec.checks.tree.slice(0, 12)}` : ''}): undo the commit's extra change, or run nunchi fix --checks on it before committing.`]);
  // the diff policy (design §4.6); diff paths are the repository's, the source map's are the app's
  let prefix = '';
  // compared as real paths (Windows 8.3 names, a folder reached through a link), never as raw strings
  try { prefix = relative(realpathSync.native(ctx.git.toplevel()), realpathSync.native(ctx.root)).split(sep).join('/'); prefix = prefix ? `${prefix}/` : ''; } catch {}
  if (rec.phase === 'committed') {
    const files = ctx.git.diffNames(rec.base, head);
    const pkg = readJson(join(ctx.root, 'package.json'), {});
    const tsc = readJson(join(ctx.root, 'tsconfig.json'), null) || readJson(join(ctx.root, 'jsconfig.json'), null);
    const aliases = Object.keys(tsc?.compilerOptions?.paths || {}).map(a => a.replace(/\*$/, '').replace(/\/$/, '')).filter(Boolean);
    const pol = diffPolicy({ files, patch: ctx.git.diffPatch(rec.base, head), allowed: rec.allowed || [], deps: depsOf(pkg), aliases, prefix, links: ctx.git.diffLinks(rec.base, head) });
    if (!pol.ok) {
      const lines = [`The fix of '${title}' (commit ${short(head)}) touched what only you can approve:`, ...pol.flagged.map(f => `  ${f.file ? `${f.file}: ` : ''}${f.why}`), 'It needs you: look at the commit; tell your AI to undo it (nunchi fix --undo), or to try again within the finding\'s files.'];
      closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: 'diff', commit: head, flagged: pol.flagged, files, line: lines[0] });
      return out(0, [...said, ...lines], { outcome: 'needs-you', needsYou: 'diff', flagged: pol.flagged, files });
    }
    rec = setPhase(ctx.stateDir, rec, 'verifying', { diff: { files } }, gen(ctx));
  }
  // P1: P0's scope plus the routes the diff reaches
  const harDir = join(groupDir(ctx.stateDir, g.group), `${rec.attempt}-har`);
  const map = buildSourceMap(ctx.root, discover(ctx.root).routes);
  const reached = affectedRoutes(map, (rec.diff?.files || []).filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length))).routes;
  const extra = reached.filter(r => !rec.scope.routes.includes(r) && (!/\[/.test(r) || rec.samplePaths?.[r]));
  const scope1 = { ...rec.scope, routes: [...new Set([...rec.scope.routes, ...extra])].sort() };
  if (rec.scope.personsOf) scope1.personsOf = { ...rec.scope.personsOf, ...Object.fromEntries(extra.map(r => [r, rec.personsOf?.[r] || rec.scope.persons])) };
  const profile = checkProfile(ctx.root);
  rec = setPhase(ctx.stateDir, rec, 'p1', { p1: { scope: scope1 } }, gen(ctx));
  const p = await probe(ctx, rec, 'P1', { url: opts.url || rec.url, serve: opts.serve || rec.serve, scope: scope1, harDir, profile, keep: true });
  try {
    rec = currentRecord(ctx.stateDir, rec);
    // an --abort or a decision from elsewhere while P1 ran: what it wrote stands
    if (rec.phase !== 'p1') return out(0, [...said, `'${title}' changed while it was being re-checked (it is ${rec.phase} now): nothing more was done.`], { outcome: rec.phase });
    if (p.noProof) return finish(ctx, rec, { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'no-proof', text: p.noProof }] }, { title, said });
    if (p.error) return finish(ctx, rec, { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'p1', text: p.error }] }, { title, said });
    rec = update(ctx.stateDir, rec, { p1: { run: p.runId, proof: p.proof, scope: scope1 } }, gen(ctx));
    return await judgeAttempt(ctx, rec, { g, title, said, p, harDir, base: p.base });
  } catch (e) {
    if (e.code !== 'RECORD_CHANGED') throw e;
    return out(0, [...said, `'${title}' changed while it was being re-checked (it is ${e.current?.phase ?? 'closed'} now): nothing more was done.`], { outcome: e.current?.phase ?? null });
  } finally { if (p.stop) p.stop(); }
}

// P0 against P1 → the verdict (the rule part now; the AI part after the re-check's verdicts).
async function judgeAttempt(ctx, rec, { g, title, said, p, harDir, base }) {
  const p0Dir = join(ctx.runsDir, rec.p0.run), p1Dir = p.runDir;
  const p0 = probeView(readProbe(p0Dir), controlsReader(p0Dir)), p1 = probeView(readProbe(p1Dir), controlsReader(p1Dir));
  const rows = ctx.rows.filter(r => r.group === g.group);
  const pick = fps => rows.filter(r => fps.includes(r.fp)).map(r => ({ fp: r.fp, rule: r.rule, route: r.route, cells: r.cells || [] }));
  const group = { rule: pick(rec.fps.rule), ai: pick(rec.fps.ai) };
  const known = new Set(ctx.rows.filter(r => !r.goneAt).map(r => r.fp));
  // flaky rules (design §4.5): a would-be regression, and the group's own defect where P1 shows it gone, are captured
  // once more before they count
  const flakyCands = p1.all.filter(x => FLAKY.has(x.f.rule) && p0.looks.has(`${x.id.route}|${x.id.cell}`) && !p0.all.some(o => o.f.fp === x.f.fp)).map(x => x.f.scene);
  const ownFlaky = group.rule.filter(it => FLAKY.has(it.rule) && !p1.all.some(x => x.f.fp === it.fp))
    .flatMap(it => p0.all.filter(o => o.f.fp === it.fp).map(o => p1.looks.get(`${o.id.route}|${o.id.cell}`)?.id)).filter(Boolean);
  let again = () => undefined;
  const second = [...new Set([...flakyCands, ...ownFlaky])].sort();
  if (second.length && ctx.deps.capture) {
    let allowBaseHosts = []; try { allowBaseHosts = readConfig(ctx.nunchiDir).allowHosts; } catch {}
    const byId = new Map(p1.scenes.map(s => [s.id, s]));
    again = await recaptureScenes({ capture: ctx.deps.capture, scenes: second.map(id => byId.get(id)).filter(Boolean), url: base || rec.url, samplePaths: rec.samplePaths || {}, harDir, storageState: join(ctx.nunchiDir, 'auth.json'), allowHosts: rec.allowHosts || [], allowBaseHosts, browserPath: ctx.deps.browserPath });
  }
  // the group's boxes on each screen, before and after (they are what the fix changes)
  const p1Controls = controlsReader(p1Dir);
  const boxesOf = sceneId => {
    const out = [];
    for (const v of [p0, p1]) for (const x of v.all) if (x.f.scene === sceneId && (rec.fps.rule.includes(x.f.fp) || group.rule.some(it => p0.all.some(o => o.f.fp === it.fp && o.f.scene === sceneId && x.id.norm === o.id.norm)))) if (x.id.box) out.push(x.id.box);
    // the element the finding was on, where it is after the fix (by its selector, or its tag and name)
    for (const o of p0.all) if (o.f.scene === sceneId && rec.fps.rule.includes(o.f.fp)) {
      const hit = (p1Controls(sceneId) || []).find(c => c && Array.isArray(c.box) && (c.selector === o.f.selector || (o.id.name && c.name === o.id.name && (c.tag || '').toLowerCase() === o.id.tag)));
      if (hit) out.push(hit.box);
    }
    const cell = sceneId.split('.').slice(-3).join('.');
    for (const r of rows) if (rec.fps.ai.includes(r.fp) && r.seen?.[cell]?.box && p0.scenes.some(s => s.id === sceneId && s.route === r.route)) out.push(r.seen[cell].box);
    return out;
  };
  const drift = measureDrift({ p0Dir, p1Dir, p0Scenes: p0.scenes.filter(s => s.route && rec.scope.routes.includes(s.route)), p1Scenes: p1.scenes, boxesOf });
  const verdict = judgeRules({ group, p0, p1, known, again, proof: !!p.proof?.ok, drift });
  rec = update(ctx.stateDir, rec, { verdict: { ...verdict, drift: drift.scenes.length ? drift : undefined }, screens: p1.looks.size }, gen(ctx));
  if (verdict.outcome !== 'recheck') return finish(ctx, rec, verdict, { title, said });
  // AI items: a re-check from a fresh context (design §2.4, §4.5 row 5) on P1, P0 as the screens before
  const R = await import('../recheck.mjs');
  const p1Run = readJson(join(p1Dir, 'run.json'), {});
  const routeFiles = readJson(join(p1Dir, 'source-map.json'), {})?.routes || {};
  const hashes = readJson(join(p1Dir, 'source-hashes.json'), {})?.routes || {};
  const { readSource } = await import('../ai-identity.mjs');
  const cache = new Map();
  const previous = { runId: rec.p0.run, manifest: readProbe(p0Dir).manifest, findings: readProbe(p0Dir).findings, canaries: readJson(join(p0Dir, 'canaries.json'), null) };
  const plan = R.planRecheck({ runId: p.runId, manifest: readProbe(p1Dir).manifest, rows: rows.filter(r => rec.fps.ai.includes(r.fp)), canaries: readJson(join(p1Dir, 'canaries.json'), null), previous, runFindings: readProbe(p1Dir).findings,
    hasScene: (run, scene) => existsSync(join(ctx.runsDir, run, scene)), sameTree: !!p1Run.tree && workTree(ctx.root).tree === p1Run.tree,
    fileHashOf: f => { const t = readSource(ctx.root, f, cache); return t === null ? null : sha(t, 16); },
    filesOf: (run, scene) => R.RECHECK_FILES.filter(n => existsSync(join(ctx.runsDir, run, scene, n))), routeSource: route => (hashes[route] ? { hash: hashes[route], files: routeFiles[route] || [] } : null), stream: null });
  R.writeRecheckMirror(p1Dir, ctx.runsDir, plan.mirror);
  writeStable(join(p1Dir, 'recheck-packets.json'), plan.packets);
  writeKey(p1Dir, 'recheck-key.json', plan.key);
  rec = setPhase(ctx.stateDir, rec, 'recheck', { recheck: { run: p.runId, plan: plan.key.plan, controls: plan.key.controls } }, gen(ctx));
  if (!plan.packets.packets.length) return recordFix(ctx, g.group, []);
  const lines = [...said, `The rule checks of '${title}' are clean; its AI finding${rec.fps.ai.length === 1 ? '' : 's'} need${rec.fps.ai.length === 1 ? 's' : ''} a re-check from a fresh context:`,
    `${plan.packets.packets.length} packets → ${join(p1Dir, 'recheck-packets.json')}`,
    `Give a fresh re-checker (one that has seen neither the hunt nor this fix) only recheck-packets.json and the files it names; never the diff, the commit message or this brief. Then: nunchi fix --verify ${g.group} --record <verdicts.json>.`];
  if (plan.key.controls.made < plan.key.controls.planned) lines.push(`Only ${plan.key.controls.made} of ${plan.key.controls.planned} planned controls could be made: the re-check will be suspect, and nothing can be marked fixed by it.`);
  return out(0, lines, { outcome: 'recheck', packets: plan.packets.packets.length, run: p.runId });
}

// The re-check's verdicts (`fix --verify <group> --record <file>`).
export async function recordFix(ctx, id, verdicts) {
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  const { g, title } = found;
  let { rec, said } = reconcile(ctx, g.group);
  if (!rec || rec.phase !== 'recheck') return refuse([...said, `No re-check of '${title}' waits for verdicts.`]);
  const R = await import('../recheck.mjs');
  const p1Dir = join(ctx.runsDir, rec.recheck.run);
  const key = readKey(p1Dir, 'recheck-key.json');
  if (!key || key.plan !== rec.recheck.plan) return refuse(`The re-check's answer key is missing (${dirname(keyPath(p1Dir, 'recheck-key.json'))}): run nunchi fix --verify ${g.group} again.`);
  const packets = readJson(join(p1Dir, 'recheck-packets.json'), null);
  const r = R.recordRecheck({ key, packets, verdicts });
  if (r.problems.length) return refuse(r.problems.map(x => `nunchi fix: ${x}`));
  const list = Array.isArray(verdicts) ? verdicts : verdicts.verdicts;
  const { recorded: _r, ...plan } = key;
  writeKey(p1Dir, 'recheck-key.json', { ...plan, recorded: { verdicts: list.map(v => ({ packet: v.packet, verdict: v.verdict, reason: v.reason.trim() })) } });
  writeStable(join(p1Dir, 'recheck.json'), r.recheck);
  const rows = ctx.rows.filter(x => x.group === g.group);
  const group = { rule: [], ai: rows.filter(x => rec.fps.ai.includes(x.fp)).map(x => ({ fp: x.fp, route: x.route, cells: x.cells || [] })) };
  const verdict = judgeAi({ group, recheck: r.recheck, pending: rec.verdict?.pending || {} });
  rec = update(ctx.stateDir, rec, { recheck: { ...rec.recheck, result: { suspect: r.recheck.suspect, verdicts: r.recheck.verdicts, controls: r.recheck.controls }, results: r.recheck.results } }, gen(ctx));
  return finish(ctx, rec, verdict, { title, said });
}

// ---- outcomes -------------------------------------------------------------------------------------------------------

// A route in a chat line: as it is when it looks like a route, else quoted as data (a route comes from the app's file
// names, which are the app's data, never instructions: design §4.11).
const ROUTE_TEXT = /^\/[\w\-./[\]()@:+~%]{0,120}$/;
export const routeText = r => (ROUTE_TEXT.test(String(r)) ? String(r) : JSON.stringify(String(r).slice(0, 120)));
const where = list => [...new Set(list.map(x => x.route).filter(Boolean))].slice(0, 2).map(routeText).join(', ');
function finish(ctx, rec, verdict, { title, said = [] }) {
  // the attempt as it is now: an --abort from another terminal while P1 ran is not overwritten (records.mjs rev)
  const cur = currentRecord(ctx.stateDir, rec);
  if (cur && (cur.rev ?? 0) !== (rec.rev ?? 0)) return out(0, [...said, `'${title}' changed while it was being re-checked (it is ${cur.phase} now): nothing more was done.`], { outcome: cur.phase });
  // a decision the person made while P1 ran: Keep, Not a problem or Later cancel the attempt (its commit undone)
  refresh(ctx);
  const d = ctx.rows.filter(r => r.group === rec.group).map(r => r.decision).filter(Boolean).sort((a, b) => cmp(a.at || '', b.at || '') || cmp(a.id, b.id)).pop();
  if (d && d.decision !== 'fix') { const r = reconcile(ctx, rec.group); return out(0, [...said, ...r.said], { outcome: r.rec?.phase ?? null }); }
  if (verdict.outcome === 'fixed') {
    const screens = rec.screens || 0;
    const line = `Fixed '${title}' (re-checked ${screens} screen${screens === 1 ? '' : 's'}, nothing else broke).`;
    rec = setPhase(ctx.stateDir, rec, 'folding', { outcome: { kind: 'fixed', line } }, gen(ctx));
    applyFold(ctx, rec);
    return out(0, [...said, line], { outcome: 'fixed', screens });
  }
  if (verdict.outcome === 'regression' || verdict.outcome === 'not-fixed') {
    const other = verdict.regressions?.[0];
    const why = verdict.outcome === 'regression'
      ? `That fix broke '${titleOf(other.rule)}' on ${other.route ? routeText(other.route) : 'a screen'}`
      : `That fix did not remove '${title}' (it is still there${where(verdict.still) ? ` on ${where(verdict.still)}` : ''})`;
    rec = setPhase(ctx.stateDir, rec, 'reverting', { verdict, phrase: why, revertWhy: verdict.outcome === 'regression' ? 'caused-regression' : 'not-fixed' }, gen(ctx));
    const r = doRevert(ctx, rec, `${verdict.outcome === 'regression' ? 'caused-regression' : 'not-fixed'}: ${why}`, { title });
    return { ...r, lines: [...said, ...r.lines] };
  }
  if (verdict.outcome === 'drift' || verdict.outcome === 'unbaselined') {
    const d = verdict.drift;
    // pixels over the threshold say their share; geometry alone says what moved (a 1% that was not measured is no fact)
    const what = d && d.share > DRIFT_PIXELS ? `${Math.max(1, Math.round(d.share * 100))}%` : d ? `${d.moved} other control${d.moved === 1 ? '' : 's'} moved` : null;
    const line = verdict.outcome === 'drift'
      ? `'${title}' is gone, but the fix also changed other parts of this screen (${what}). It needs you: look at it in the board (before and after, with a slider).`
      : `'${title}' is gone, but ${where(verdict.unbaselined)} (a screen the fix reaches, with nothing to compare against) now shows '${titleOf(verdict.unbaselined[0].rule)}'. It needs you: look at it in the board.`;
    closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: verdict.outcome === 'drift' ? 'a' : 'unbaselined', defectGone: true, commit: rec.commit, share: verdict.drift?.share ?? null, moved: verdict.drift?.moved ?? null, pixels: !!(d && d.share > DRIFT_PIXELS), line });
    return out(0, [...said, line], { outcome: 'needs-you', needsYou: verdict.outcome === 'drift' ? 'a' : 'unbaselined', share: verdict.drift?.share ?? null });
  }
  // inconclusive → needs you (c): nothing reverted
  const reasons = verdict.reasons || [];
  const screenFailed = reasons.some(x => ['scene-failed', 'app-unreachable', 'p1'].includes(x.why));
  // screens that loaded before the fix and not after, while the others loaded: the fix may have broken them
  const failed = reasons.find(x => x.why === 'scene-failed');
  const brokeRoutes = failed && (failed.before || []).length && (rec.screens || 0) > 0 && !reasons.some(x => ['app-unreachable', 'p1', 'no-proof', 'replay-miss', 'login-expired', 'recording-stale'].includes(x.why))
    ? [...new Set(failed.before.map(k => k.split('|')[0]))].slice(0, 3) : null;
  const line = brokeRoutes
    ? `Couldn't re-check '${title}': after the fix, ${brokeRoutes.map(routeText).join(', ')} did not load (${brokeRoutes.length === 1 ? 'it' : 'they'} did before), so the fix may have broken ${brokeRoutes.length === 1 ? 'that screen' : 'those screens'}. Look at it, then tell me “retry”, or “undo it”.`
    : `Couldn't re-check '${title}': ${screenFailed ? 'the screen didn\'t load' : reasons.map(x => x.text).join('; ')}. ${reasons.some(x => x.why === 'no-proof') ? 'Start the app from this folder (or use --serve), then tell me “retry”.' : 'Start your app, then tell me “retry”.'}`;
  closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: 'c', commit: rec.commit, reasons, line });
  return out(0, [...said, line, ...(screenFailed ? reasons.filter(x => x.text).map(x => `  ${x.text}`) : [])], { outcome: 'needs-you', needsYou: 'c', reasons });
}

function applyFold(ctx, rec) {
  const p1 = rec.p1?.run;
  const gone = rec.fps.rule || [];
  const rechecks = (rec.recheck?.results || []).filter(x => rec.fps.ai.includes(x.fp));
  commitFix(ctx.led.st.files.ledger, s => foldFix(s, { run: p1, stream: ctx.stream, key: sha(stableJson({ group: rec.group, attempt: rec.attempt, gone, rechecks }), 16), group: rec.group, gone, rechecks, now: ctx.deps.now() }), { generation: ctx.generation });
  const done = setPhase(ctx.stateDir, rec, 'fixed', { outcome: { kind: 'fixed', ...(rec.outcome?.kind === 'fixed' ? rec.outcome : {}) } }, gen(ctx));
  if (rec.claim?.token) releaseClaim(ctx.stateDir, rec.group, rec.claim.token, { generation: ctx.generation });
  return done;
}

// The line when a fix must be undone and the person has work that is not committed: what to commit or stash.
function dirtyLine(title, commit, files, { refusal = false } = {}) {
  const list = `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;
  return `${refusal ? 'Not undone' : `Couldn't undo the fix of '${title}' (commit ${short(commit)})`}: you have changes that are not committed (${list}), and undoing now would mix them into the undo. Commit them (git commit) or stash them (git stash push --include-untracked), then tell your AI “undo it”${refusal ? '' : ' — it needs you'}.`;
}

// Undo the fix commit (only while it is HEAD; design §4.7). `rec` is in phase reverting/undoing already.
function doRevert(ctx, rec, why, { cancelWord = null, quiet = false, title = rec.title || 'this finding' } = {}) {
  const r = ctx.git.revert({ fixCommit: rec.commit, group: rec.group, attempt: rec.attempt, why: String(why).slice(0, 300), branch: rec.branch || null,
    onStart: () => { rec = update(ctx.stateDir, rec, { revertStarted: kst(ctx.deps.now()) }, gen(ctx)); } });
  if (!r.ok) {
    const kind = r.reason === 'signing' ? 'signing' : r.reason === 'dirty' ? 'dirty' : r.reason === 'wrong-branch' ? 'wrong-branch' : 'revert-failed';
    const line = r.reason === 'signing'
      ? `Couldn't undo the fix of '${title}' (commit ${short(rec.commit)}): your repository requires signed commits and signing failed. nunchi never commits unsigned: it needs you.`
      : r.reason === 'dirty' ? dirtyLine(title, rec.commit, r.files)
      : r.reason === 'wrong-branch' ? `Couldn't undo the fix of '${title}' (commit ${short(rec.commit)}): ${r.message}. Switch back to ${rec.branch}, then tell your AI “undo it” — it needs you.`
      : `Couldn't undo the fix of '${title}' (commit ${short(rec.commit)}): ${r.message}. Nothing was reset; it needs you.`;
    closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: kind, commit: rec.commit, line });
    return out(quiet ? 1 : 0, line, { outcome: 'needs-you', needsYou: kind });
  }
  const lines = [];
  finishRevert(ctx, rec, r.sha, lines, { cancelWord, title });
  return out(0, lines, { outcome: latestRecord(ctx.stateDir, rec.group)?.phase, revert: r.sha });
}
function finishRevert(ctx, rec, revertSha, lines, { cancelWord = null, title = rec.title || 'this finding' } = {}) {
  if (rec.phase === 'undoing') {
    if (rec.folded) commitFix(ctx.led.st.files.ledger, s => unfoldFix(s, { run: rec.p1.run, stream: ctx.stream }), { generation: ctx.generation });
    closeWith(ctx, rec, 'undone', { ...(rec.outcome || {}), kind: 'undone', revert: revertSha, line: `Undid the fix of '${title}' (commit ${short(rec.commit)} reverted by ${short(revertSha)}). It is to fix again.` });
    lines.push(`Undid the fix of '${title}' (commit ${short(rec.commit)} reverted by ${short(revertSha)}). It is to fix again.`);
    return;
  }
  if (rec.tryAgain) {
    closeWith(ctx, rec, 'reverted', { ...(rec.outcome || {}), kind: 'reverted', revert: revertSha, tryAgain: true, line: `Undid the kept fix of '${title}' (commit ${short(rec.commit)}) to try again with your note.` });
    return;
  }
  if (rec.cancel) {
    const line = `Stopped fixing '${title}': you decided ${cancelWord || rec.cancel.decision} while I was fixing it, so the fix was undone.`;
    closeWith(ctx, rec, 'cancelled', { kind: 'cancelled', revert: revertSha, line });
    lines.push(line);
    return;
  }
  const used = attemptsUsed(ctx, rec.group, rec.decision?.id);
  const why = rec.phrase || (rec.verdict?.outcome === 'regression' ? `That fix broke '${titleOf(rec.verdict.regressions[0].rule)}' on ${rec.verdict.regressions[0].route ? routeText(rec.verdict.regressions[0].route) : 'a screen'}` : `That fix did not remove '${title}'`);
  if (used >= MAX_ATTEMPTS) {
    const line = `${why}, so I undid it (attempt ${Math.min(used, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS}). The AI couldn't fix this in ${MAX_ATTEMPTS} tries: it needs you in the board.`;
    closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: 'b', revert: revertSha, verdict: rec.verdict, line });
    lines.push(line);
  } else {
    const line = `${why}, so I undid it (attempt ${used} of ${MAX_ATTEMPTS}). Trying another way.`;
    closeWith(ctx, rec, 'reverted', { kind: 'reverted', revert: revertSha, verdict: rec.verdict, line });
    lines.push(line);
  }
}

// ---- undo, abort, accept ----------------------------------------------------------------------------------------------

// `fix --undo <group>`: a fix that landed (fixed, or kept for the person) is reverted while it is HEAD, and its fold
// undone (design §3.4 "Undo and reopen").
export function undoFix(ctx, id) {
  if (!ctx.git) return refuse('The fix loop needs git.');
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  let { rec, said } = reconcile(ctx, found.g.group);
  if (!rec || !rec.commit || !['fixed', 'needs-you'].includes(rec.phase)) return refuse([...said, `No fix of '${found.title}' to undo (nunchi fix --status ${found.g.group}).`]);
  if (ctx.git.head() !== rec.commit) return refuse([...said, `The fix of '${found.title}' (commit ${short(rec.commit)}) is no longer the last commit: nunchi undoes only its own last commit. Undo it by hand with git revert ${short(rec.commit)}.`]);
  const dirty = ctx.git.uncommitted();
  if (dirty.length) return refuse([...said, dirtyLine(found.title, rec.commit, dirty, { refusal: true })], { dirty });
  const filtered = filterRefusal(ctx);
  if (filtered) return refuse([...said, filtered]);
  rec = setPhase(ctx.stateDir, rec, 'undoing', { folded: rec.phase === 'fixed' }, gen(ctx));
  const r = doRevert(ctx, rec, 'the person asked to undo this fix', { title: found.title });
  return { ...r, lines: [...said, ...r.lines] };
}

// `fix --abort <group>`: before the commit → to fix again; after → needs you, the commit shown (design §4.9).
export function abortFix(ctx, id) {
  const found = findGroup(ctx, id);
  if (found.error) return refuse(found.error);
  let { rec, said } = reconcile(ctx, found.g.group);
  if (!rec || !isOpen(rec)) return refuse([...said, `No attempt of '${found.title}' is open.`]);
  const committed = rec.commit || (ctx.git ? headIsFix(ctx, rec) : null);
  if (committed) {
    const line = `Stopped fixing '${found.title}' after its commit (${short(committed)}), before nunchi re-checked it. It needs you: tell your AI “retry” to re-check it, or “undo it”.`;
    closeWith(ctx, rec, 'needs-you', { kind: 'needs-you', needsYou: 'interrupted', commit: committed, line });
    return out(0, [...said, line], { outcome: 'needs-you', needsYou: 'interrupted' });
  }
  const line = `Stopped fixing '${found.title}' before a commit. It is still to fix.`;
  closeWith(ctx, rec, 'aborted', { kind: 'aborted', reason: 'abort', line });
  return out(0, [...said, line], { outcome: 'aborted' });
}

// The board's [Looks fine, mark fixed] on needs you (a) (design §3.4): only a person (the board's key), and only when
// the defect itself is gone (the judge found it gone; drift is all that stood in the way).
export function acceptDrift(ctx, group, { attempt, by }) {
  const rec = latestRecord(ctx.stateDir, group);
  if (!rec || rec.attempt !== attempt || rec.phase !== 'needs-you' || rec.outcome?.needsYou !== 'a') return { ok: false, status: 409, error: 'this fix no longer waits for you' };
  if (rec.outcome?.defectGone !== true) return { ok: false, status: 409, error: 'the defect itself is not gone: "Looks fine" cannot mark it fixed' };
  // only while the Fix decision the attempt was made for stands: a newer one ("Try again with a note…") or a Keep answered it
  const d = ctx.rows.filter(r => r.group === group).map(r => r.decision).filter(Boolean).sort((a, b) => cmp(a.at || '', b.at || '') || cmp(a.id, b.id)).pop();
  if (d?.decision !== 'fix' || (rec.decision?.id && d.id !== rec.decision.id)) return { ok: false, status: 409, error: 'this fix no longer waits for you: a newer decision answered it' };
  const r = setPhase(ctx.stateDir, rec, 'folding', { accepted: { channel: 'board', by: String(by || '').slice(0, 80), at: kst(ctx.deps.now()) },
    outcome: { kind: 'fixed', accepted: true, commit: rec.commit, line: `Fixed '${rec.title || group}': you looked at the before and after and marked it fixed.` } }, gen(ctx));
  applyFold(ctx, r);
  return { ok: true };
}

// ---- status and the batch summary (design §4.10) ----------------------------------------------------------------------

export function statusFix(ctx, id = null) {
  const recs = id ? (() => { const f = findGroup(ctx, id); if (f.error) return null; reconcile(ctx, f.g.group); return new Map([[f.g.group, latestRecord(ctx.stateDir, f.g.group)]].filter(([, r]) => r)); })() : latestRecords(ctx.stateDir);
  if (!recs) return refuse(findGroup(ctx, id).error);
  const lines = [], json = [];
  for (const [g, r] of [...recs].sort((a, b) => cmp(a[0], b[0]))) {
    lines.push(`${g}  attempt ${r.attempt}  ${r.phase}${r.outcome?.needsYou ? ` (${r.outcome.needsYou})` : ''}${r.commit ? `  commit ${short(r.commit)}` : ''}${r.branch ? `  ${r.branch}` : ''}${r.outcome?.line ? `\n    ${r.outcome.line}` : ''}`);
    json.push({ group: g, attempt: r.attempt, phase: r.phase, needsYou: r.outcome?.needsYou ?? null, commit: r.commit ?? null, branch: r.branch ?? null, line: r.outcome?.line ?? null, p0: r.p0?.run ?? null, p1: r.p1?.run ?? null });
  }
  if (!lines.length) lines.push('No fix attempts yet.');
  return out(0, lines, { attempts: json });
}

export function summaryFix(ctx) {
  const plan = readPlan(ctx.stateDir);
  if (!plan) return refuse('No fix plan yet: nunchi fix --plan.');
  let fixed = 0, screens = 0, broke = 0, unseen = 0;
  const needs = [], other = [];
  for (const g of plan.groups) {
    const recs = allRecords(ctx.stateDir, g).filter(r => (r.phases?.[0]?.at || '') >= plan.at);
    if (!recs.length) { other.push(g); continue; }
    const last = recs[recs.length - 1];
    broke += recs.filter(r => r.verdict?.outcome === 'regression').length;
    const title = last.title || g;
    if (last.phase === 'fixed') { fixed++; screens += last.screens || 0; }
    else if (last.phase === 'needs-you') { needs.push(title); if (last.outcome?.needsYou === 'unbaselined') unseen++; }
    else other.push(g);
  }
  const n = plan.groups.length;
  const tail = broke ? `${broke} fix${broke === 1 ? '' : 'es'} broke something else and ${broke === 1 ? 'was' : 'were'} undone` : unseen ? `${unseen} fix${unseen === 1 ? '' : 'es'} showed something new on a screen with nothing to compare against` : 'nothing else broke';
  const head = `Fixed ${fixed} of ${n}${fixed ? ` (re-checked ${screens} screen${screens === 1 ? '' : 's'}, ${tail})` : ''}.`;
  const line = `${head}${needs.length ? ` ${needs.length} need${needs.length === 1 ? 's' : ''} you: ${needs.map(t => `'${t}'`).join(', ')} → the board (nunchi open).` : ''}${other.length ? ` ${other.length} not finished yet.` : ''}`;
  return out(0, line, { fixed, of: n, screens, needsYou: needs, broke, open: other });
}
