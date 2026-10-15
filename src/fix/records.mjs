// Fix records (design 0.1-c §4.8): `state/fixes/<group>/<n>.json`, one per attempt. The attempt number is allocated
// with `wx` (two commands never get one number), and the record's `phase` is written before every side effect (a
// branch switch, a claim, a capture, a revert, a fold), so a command that died between two phases can be resumed: every
// fix command reconciles the record with what git, the claims and the runs say before it does anything (loop.mjs).
// Times in records are KST and live only in the state, never in evidence (design §8.2).
import { join } from 'node:path';
import { openSync, writeSync, fsyncSync, closeSync, readdirSync, lstatSync, readFileSync } from 'node:fs';
import { writeAtomic, privateDir, refuseLink, stableJson, withLock, retryBusy } from '../stable.mjs';
import { bumpGeneration, corrupt } from '../state.mjs';

const GROUP = /^[0-9a-f]{12}$/;
export const fixesDir = stateDir => join(stateDir, 'fixes');
export const groupDir = (stateDir, group) => join(fixesDir(stateDir), group);
export const recordPath = (stateDir, group, n) => join(groupDir(stateDir, group), `${n}.json`);
export const kst = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');

// The phases of an attempt (design §4.9). Open ones can be resumed; closed ones are an outcome.
export const OPEN = new Set(['starting', 'branching', 'claiming', 'snapshot', 'baseline', 'p0', 'started', 'checking', 'checked', 'committed', 'verifying', 'p1', 'recheck', 'folding', 'reverting', 'undoing']);
export const CLOSED = new Set(['fixed', 'reverted', 'needs-you', 'cancelled', 'aborted', 'undone']);
export const isOpen = r => !!r && OPEN.has(r.phase);
const FIX_MAX = 4 * 1024 * 1024;

// Windows refuses a read for a moment while another command renames a new version into place (EPERM/EBUSY): those are
// waited out (retryBusy), never read as "no record".
function readRecord(file) {
  let st;
  try { st = retryBusy(() => lstatSync(file)); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
  if (!st.isFile()) throw corrupt(file, 'is not a regular file: remove it (nunchi then forgets that attempt; git still counts it)');
  if (st.size > FIX_MAX) throw corrupt(file, 'is too large to be a fix record: remove it');
  let text;
  try { text = retryBusy(() => readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  // the allocation is the record's first write: a crash inside it leaves an empty file, which is an attempt that
  // never started (no side effect happens before its first phase is written)
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { throw corrupt(file, 'is not valid JSON: remove it (nunchi then forgets that attempt; git still counts it)'); }
}
export function attemptNumbers(stateDir, group) {
  if (!GROUP.test(group)) return [];
  let names = [];
  try { names = readdirSync(groupDir(stateDir, group)); } catch { return []; }
  return names.map(n => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}
// The latest attempt's record of a group, or null: the newest open one when there is one (a later number that closed
// at once, a refused start, must not hide an attempt still in flight), else the newest.
export function latestRecord(stateDir, group) {
  const ns = attemptNumbers(stateDir, group);
  let newest = null;
  for (let i = ns.length - 1; i >= 0; i--) {
    const r = readRecord(recordPath(stateDir, group, ns[i]));
    if (!r) continue;
    if (OPEN.has(r.phase)) return r;
    newest ||= r;
  }
  return newest;
}
// This attempt's record as it is on disk now.
export const currentRecord = (stateDir, rec) => readRecord(recordPath(stateDir, rec.group, rec.attempt));
// A record write is a compare-and-swap on `rev`: one written since `rec` was read (an --abort from another terminal,
// say) is never overwritten. → throws RECORD_CHANGED.
function writeRecord(stateDir, rec, next) {
  const file = recordPath(stateDir, rec.group, rec.attempt);
  refuseLink(file);
  return withLock(join(groupDir(stateDir, rec.group), 'records'), () => {
    const cur = readRecord(file);
    if (cur && (cur.rev ?? 0) !== (rec.rev ?? 0)) throw Object.assign(new Error(`fix attempt ${rec.attempt} of ${rec.group} changed while this command ran (it is ${cur.phase} now)`), { code: 'RECORD_CHANGED', current: cur });
    const out = { ...next, rev: (rec.rev ?? 0) + 1 };
    writeAtomic(file, stableJson(out), { durable: true, mode: 0o600 });
    return out;
  });
}
export function allRecords(stateDir, group) {
  return attemptNumbers(stateDir, group).map(n => readRecord(recordPath(stateDir, group, n))).filter(Boolean);
}
// Every group with a record, and its latest record.
export function latestRecords(stateDir) {
  let names = [];
  try { names = readdirSync(fixesDir(stateDir)).filter(n => GROUP.test(n)).sort(); } catch { return new Map(); }
  const out = new Map();
  for (const g of names) { const r = latestRecord(stateDir, g); if (r) out.set(g, r); }
  return out;
}

// A new attempt: the next number, created with `wx` and written in the same open (fsynced), phase `starting`.
export function allocate(stateDir, group, fields, { generation = null, now = Date.now() } = {}) {
  if (!GROUP.test(group)) throw new Error('a fix record names a 12-hex group');
  privateDir(groupDir(stateDir, group));
  for (let n = (attemptNumbers(stateDir, group).pop() || 0) + 1; ; n++) {
    const file = recordPath(stateDir, group, n);
    refuseLink(file);
    const rec = { schema: 1, note: 'one attempt of the fix loop (design §4.8); phases are written before each side effect', group, attempt: n, ...fields, phase: 'starting', phases: [{ phase: 'starting', at: kst(now) }], rev: 1 };
    let fd;
    try { fd = openSync(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { writeSync(fd, stableJson(rec)); fsyncSync(fd); } finally { closeSync(fd); }
    if (generation) bumpGeneration(generation);
    return rec;
  }
}

// The record with a new phase (and any fields), written atomically and synced; the generation is bumped so the board
// sees it. → the record as written.
export function setPhase(stateDir, rec, phase, fields = {}, { generation = null, now = Date.now() } = {}) {
  if (!OPEN.has(phase) && !CLOSED.has(phase)) throw new Error(`unknown fix phase ${phase}`);
  const next = writeRecord(stateDir, rec, { ...rec, ...fields, phase, phases: [...(rec.phases || []), { phase, at: kst(now) }] });
  if (generation) bumpGeneration(generation);
  return next;
}
// Fields only, the phase unchanged (results of a step that has its own phase already).
export function update(stateDir, rec, fields, { generation = null } = {}) {
  const next = writeRecord(stateDir, rec, { ...rec, ...fields });
  if (generation) bumpGeneration(generation);
  return next;
}

// The fix plan the skill showed the person (design U19: one consent): `state/fix-plan.json`, so `fix --summary` knows
// which attempts the batch holds.
export const planPath = stateDir => join(stateDir, 'fix-plan.json');
export function writePlan(stateDir, plan, { now = Date.now() } = {}) {
  const file = planPath(stateDir);
  refuseLink(file);
  privateDir(stateDir);
  writeAtomic(file, stableJson({ schema: 1, note: 'the groups the last fix plan named (design §4.10 batch summary)', at: kst(now), ...plan }), { mode: 0o600 });
}
export function readPlan(stateDir) {
  try { const p = JSON.parse(readFileSync(planPath(stateDir), 'utf8')); return p && Array.isArray(p.groups) ? p : null; } catch { return null; }
}
