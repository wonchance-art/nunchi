// A project's ledger as every ledger command reads and writes it: the CLI (`findings`, `decide`, `approve`, `trust`,
// `export`) and the live board (`nunchi open`) go through these same functions, so a decision made in the board and
// one made with `nunchi decide` are written the same way (design 0.1-c §3.3 "decide parity").
//
// Nothing here prints or exits: errors are thrown with a code (LEDGER_ERRORS are the ones a command reports and
// exits 2 on), and messages for the person go to `warn`.
import { join, dirname, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ensurePrivate } from './runs.mjs';
import { resolveStateRoot, stateRoot, trackedState, stateFiles, ensureStateDir, adoptLegacy, present, bumpGeneration } from './state.mjs';
import { syncLedger, peekLedger, newId, readDecisions, buildDecision, saveDecision, readApprovals, bindApproved, addApproved, approvalKey, seriousTarget, view, groups as groupRows,
  adoptLedger, carryLedger, isLedger, isApprovedDoc, mergeApprovedDocs, DECISIONS } from './ledger.mjs';
import { aiLoader, recheckLoader } from './ai-fold.mjs';
import { sweepLeftovers } from './stable.mjs';

// A ledger file that cannot be read, held by another nunchi process, changed under it again and again, a link where a
// file should be, state committed to git, or a state folder that cannot be made private.
export const LEDGER_ERRORS = ['CORRUPT', 'LOCKED', 'CONFLICT', 'UNSAFE_PATH', 'COMMITTED_STATE', 'STATE_PRIVATE'];
const fail = (code, message) => Object.assign(new Error(message), { code });

// The state store of this project (state.mjs, design §8.1): in a repository, the folder every worktree shares under the
// common git folder; otherwise .nunchi/state. Its files, and this worktree's stream (whose runs it folds). A shared
// folder that cannot be written falls back to .nunchi/state, said once and recorded (resolveStateRoot); state files
// committed to git are never read there.
export function stateOf(nunchiDir, { warn = () => {} } = {}) {
  const project = dirname(nunchiDir);
  const root = resolveStateRoot(project);
  if (root.warning) warn(root.warning);
  if (root.fallback) {
    const committed = trackedState(project).filter(n => n !== 'fallback.json');
    if (committed.length) throw fail('COMMITTED_STATE', `${committed.map(n => `.nunchi/state/${n}`).join(', ')} committed to git: state that came through git is never read (anyone with push access could have written it). Remove it from git (git rm --cached) and run again.`);
  }
  return { root, files: stateFiles(root.dir), runsDir: join(nunchiDir, 'runs'), nunchiDir, project };
}

// The state folder is private before anything writes its first file (D12). A `.nunchi/state` written before the state
// was shared is moved into the shared folder once, and said.
export function openState(nunchiDir, { create = existsSync(nunchiDir), warn = () => {} } = {}) {
  const st = stateOf(nunchiDir, { warn });
  try { ensurePrivate(nunchiDir, create && !st.root.shared ? ['state/'] : []); } catch (e) { throw fail('STATE_PRIVATE', e.message); }
  if (st.root.shared) adopt(st, { warn });
  return st;
}
export function adopt(st, { warn = () => {} } = {}) {
  ensureStateDir(st.root);
  const tracked = st.root.legacy && present(st.root.legacy) ? trackedState(dirname(st.nunchiDir)) : [];
  const r = adoptLegacy(st.root, { tracked, migrateLedger: adoptLedger, carryLedger, validateLedger: isLedger, validateApproved: isApprovedDoc, mergeApproved: mergeApprovedDocs });
  for (const m of r.moved) warn(`moved .nunchi/state/${m} into the repository's shared state (${st.root.dir}), which every worktree of this repository reads; the old file is kept as ${m}.moved`);
  for (const t of r.tracked) warn(`.nunchi/state/${t} is committed to git, so it was not moved into the shared state: state that came through git is never read. If it was committed by mistake: git rm --cached .nunchi/state/${t}`);
  if (r.moved.includes('ledger.json') && r.notCarried.length) warn(`the shared ledger had its own record already: ${r.carried} open item(s) of .nunchi/state/ledger.json it did not have were carried over; not carried over: ${r.notCarried.join('; ')}`);
}
// Brings the ledger up to date: runs not folded yet (their rule findings), verified AI findings and re-check verdicts
// not folded yet or changed since (design §2.1, §2.2, §2.4), and decisions not noted yet.
export const syncState = (st, { decisions = null, root = process.cwd(), timeoutMs } = {}) =>
  syncLedger(st.files.ledger, st.runsDir, { decisions, stream: st.root.stream, generation: st.files.generation, timeoutMs, loaders: { ai: aiLoader({ root: resolve(root) }), recheck: recheckLoader } });
// What a crash in the middle of a write left behind (temp files, lock folders), once it is an hour old.
export function sweep(nunchiDir, st = null) {
  const dirs = [join(nunchiDir, 'state'), join(nunchiDir, 'runs'), join(nunchiDir, 'decisions')];
  if (st?.root.shared) dirs.push(st.root.dir);
  for (const sub of ['runs', 'decisions']) {
    try { for (const e of readdirSync(join(nunchiDir, sub), { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(nunchiDir, sub, e.name)); } catch {}
  }
  for (const d of dirs) sweepLeftovers(d);
}

// The ledger as the ledger commands read it: brought up to date (runs not folded yet, decisions not noted yet), with
// approvals carried over from older versions, and how each approval was made (design §1).
// → { state, decisions, approved, channels, confirmed, serious, st }
export function loadLedger(nunchiDir, { root = process.cwd(), warn = () => {} } = {}) {
  // the state folder is private before any of these commands writes its first file there (D12)
  const st = openState(nunchiDir, { warn });
  sweep(nunchiDir, st);
  const decisions = readDecisions(join(nunchiDir, 'decisions'));
  // complete runs a crash left unfolded, and when each decision was first seen here
  const state = syncState(st, { decisions, root });
  const serious = seriousTarget(state);
  let { approved: raw, channels, confirmed } = readApprovals(st.files.approved);
  let { approved, bound, left } = bindApproved(raw, decisions, { serious });
  // approvals written by older versions: carried over once, each one said
  if (bound.length || left.length || [...approved].some(k => !raw.has(k))) {
    const r = addApproved(st.files.approved, [], { decisions, serious, generation: st.files.generation });
    for (const b of r.bound) warn(`the approval of decision ${b.id} (${b.decision} on ${b.target}) from an older nunchi now names that decision's content`);
    for (const l of r.left) warn(`the approval of decision ${l.id} was not carried over (${l.why}); if you made it, approve it again: nunchi approve ${l.id}`);
    ({ approved, channels, confirmed } = readApprovals(st.files.approved));
  }
  return { state, decisions, approved, channels, confirmed, serious, st };
}
// The ledger for a command that only reads (`nunchi check --fail-on`): the same rows loadLedger gives, with nothing
// created, moved, swept or written — runs and decisions not folded yet are folded in memory only, and approvals
// written by older versions are bound in memory only. State committed to git is refused as loadLedger refuses it.
export function readLedgerOnly(nunchiDir, { root = process.cwd() } = {}) {
  const project = dirname(nunchiDir);
  const sroot = stateRoot(project);
  if (!sroot.shared) {
    const committed = trackedState(project).filter(n => n !== 'fallback.json');
    if (committed.length) throw fail('COMMITTED_STATE', `${committed.map(n => `.nunchi/state/${n}`).join(', ')} committed to git: state that came through git is never read (anyone with push access could have written it). Remove it from git (git rm --cached) and run again.`);
  }
  const st = { root: sroot, files: stateFiles(sroot.dir), runsDir: join(nunchiDir, 'runs'), nunchiDir, project };
  const decisions = readDecisions(join(nunchiDir, 'decisions'));
  const state = peekLedger(st.files.ledger, st.runsDir, { decisions, stream: sroot.stream, loaders: { ai: aiLoader({ root: resolve(root) }), recheck: recheckLoader } });
  const serious = seriousTarget(state);
  const { approved: raw, channels, confirmed } = readApprovals(st.files.approved);
  const { approved } = bindApproved(raw, decisions, { serious });
  return { state, decisions, approved, channels, confirmed, serious, st };
}
// The rows and groups a ledger shows, with how each decision was made.
export function ledgerView(led, { now } = {}) {
  const rows = view(led.state, led.decisions, led.approved, { channels: led.channels, confirmed: led.confirmed, ...(now !== undefined ? { now } : {}) });
  return { rows, groups: groupRows(rows) };
}

// ---- decisions (the same for `nunchi decide` and the board) ------------------------------------------------------

// Who decides: git's user.name in the project (its own config too), else the login name. `cwd`: the project (the board's
// server runs in the temp folder).
export function whoAmI(cwd = process.cwd()) {
  let by = process.env.USER || process.env.USERNAME || 'unknown';
  try { by = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || by; } catch {}
  return by;
}

// Ids to targets. `prefix`: an id may be the start of a group or fingerprint id (the CLI); the board sends whole ids.
// An AI item with no component is its own group (group = fingerprint): one id, decided on the fingerprint.
// A group holding an AI finding nobody double-checked is decided on each of its fingerprints: a group decision does not
// cover such a finding (ledger view, design §2.2), so a decision on the group would be recorded and count for none of
// them. Each target once, in the order asked.
export function resolveTargets(rows, gs, ids, { prefix = true } = {}) {
  const out = [], seen = new Set();
  const push = t => { const k = t.group ? `g:${t.group}` : `f:${t.fp}`; if (!seen.has(k)) { seen.add(k); out.push(t); } };
  for (const id of ids) {
    const match = (x) => (prefix ? x.startsWith(id) : x === id);
    let g = gs.filter(x => match(x.group));
    const f = rows.filter(x => match(x.fp));
    if (g.length === 1 && f.length === 1 && g[0].group === f[0].fp) g = [];
    if (g.length + f.length !== 1) throw fail('BAD_TARGET', prefix ? `"${id}" matches ${g.length + f.length} groups/fingerprints; give more characters` : `"${id}" is not a group or fingerprint of the ledger`);
    if (!g.length) { push({ fp: f[0].fp }); continue; }
    const mine = rows.filter(r => r.group === g[0].group);
    if (mine.some(r => r.source === 'ai' && !r.checked)) for (const r of [...mine].sort((a, b) => (a.fp < b.fp ? -1 : 1))) push({ fp: r.fp });
    else push({ group: g[0].group });
  }
  return out;
}

// Several targets decided at once are one batch, from the CLI and the board alike (a group decided on its
// fingerprints included), so one undo or reopen takes them together.
export const batchFor = targets => (targets.length > 1 ? newId() : null);

// Records one decision per target, as `nunchi decide` always has: the approval first (with the channel it was made
// through), so a crash in between leaves an approval of nothing, never this user's own decision looking as if it came
// through git; then the decision files (atomic); then the generation, so a reader that saw the approvals' bump before
// the files existed looks again (design §3.3).
export function recordDecisions(led, { targets, decision, reason = null, note = null, by, channel, batch = null }) {
  if (!DECISIONS[decision]) throw fail('BAD_ARGS', `unknown decision "${decision}"`);
  const made = targets.map(target => buildDecision({ target, decision, reason, note, by, channel, batch }));
  addApproved(led.st.files.approved, made.map(approvalKey), { decisions: led.decisions, serious: led.serious, generation: led.st.files.generation, channel });
  for (const d of made) saveDecision(join(led.st.nunchiDir, 'decisions'), d);
  bumpGeneration(led.st.files.generation);
  return made;
}

// A person confirms, in the board, decisions the agent recorded or that came through git (design §1): their approval
// keys are added to `confirmed` (and approved, for one from git). Only the keys given are touched.
export function confirmDecisions(led, keys) {
  addApproved(led.st.files.approved, [], { decisions: led.decisions, serious: led.serious, generation: led.st.files.generation, confirm: keys });
  return keys.length;
}

// Approvals of decisions that came through git (`nunchi approve`), with the channel they were made through.
export function approveDecisions(led, chosen, { channel }) {
  return addApproved(led.st.files.approved, chosen.map(approvalKey), { decisions: led.decisions, serious: led.serious, generation: led.st.files.generation, channel });
}
