// What agents are doing right now (design 0.1-c §7 "Board activity", §3.4 "Now"): the fix loop's claims
// (fix/claims.mjs) and the AI hunts in progress, which this module keeps, one record per worktree, run and declared
// agent: `state/hunts/<id>.json` {declaredAgent, declaredVendor, stream, run, plan, lenses, units, answered, complete,
// startedAt, lastActivity}.
// - `hunt --plan` starts it (its agent from --agent and --vendor) and every `hunt --record` moves it on (its agents
//   from the answers files' headers): `units` = the plan's planned units, `answered` = those this agent answered
//   completely, `complete` = those any agent did (the board's progress: "Codex · AI review L6 · 12/40 units · 3 min").
// - Running = live and not every planned unit answered. Live = touched within the last 30 minutes by the reader's
//   clock, as claims expire (a value the writer set never decides it): an agent that stopped half way drops out of
//   "Now" on its own, without a write.
// - Agent and vendor are as declared. A record holds no app text: names, run and plan ids, lens ids, counts, times.
// Written atomically under one lock (`state/hunts.lock.d`); records past 30 minutes are removed by the next write.
import { join } from 'node:path';
import { readdirSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { withLock, writeAtomic, privateDir, stableJson, sha, refuseLink } from './stable.mjs';
import { bumpGeneration } from './state.mjs';
import { nameKey, declaredName } from './agents.mjs';
import { fixingMinutes } from './board/shared.mjs';

export const HUNT_TTL_MS = 30 * 60e3;
const ID = /^[0-9a-f]{12}$/;
const LENS = /^L\d+$/;
export const huntsDir = stateDir => join(stateDir, 'hunts');
const lockOf = stateDir => join(stateDir, 'hunts');
export const huntId = ({ stream, run, agent }) => sha(`${stream}\0${run}\0${nameKey(agent)}`, 12);
const kst = ms => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');
const read = p => { try { if (!lstatSync(p).isFile()) return null; return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);

export const huntLive = (h, now = Date.now()) => { const at = Date.parse(h?.lastActivity); return Number.isFinite(at) && now - at <= HUNT_TTL_MS; };
export const huntRunning = (h, now = Date.now()) => huntLive(h, now) && count(h.units) > 0 && Math.max(count(h.complete), count(h.answered)) < count(h.units);
export const huntMinutes = (h, now = Date.now()) => { const s = Date.parse(h?.startedAt); return Number.isFinite(s) ? Math.max(0, Math.round((now - s) / 60e3)) : null; };

// Every hunt record: [{ id, hunt, live, running }], by id.
export function listHunts(stateDir, now = Date.now()) {
  let names = [];
  try { if (lstatSync(huntsDir(stateDir)).isDirectory()) names = readdirSync(huntsDir(stateDir)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^([0-9a-f]{12})\.json$/.exec(n);
    if (!m) continue;
    const h = read(join(huntsDir(stateDir), n));
    if (h && typeof h === 'object') out.push({ id: m[1], hunt: h, live: huntLive(h, now), running: huntRunning(h, now) });
  }
  return out;
}

// How far a plan's hunt is: the plan's planned units, those `agent` answered completely and those any agent did (from
// the run's records, hunt-agents.mjs), and the lenses of this agent's part (the plan's when it has none yet).
export function huntProgress(plan, records = [], agent = null) {
  const planned = (plan?.units || []).filter(u => u.status === 'planned');
  const ids = new Set(planned.map(u => u.id));
  const seenBy = r => new Set((r.cells || []).filter(c => c && c.status === 'seen' && ids.has(c.unit)).map(c => c.unit));
  const mine = records.find(r => nameKey(r.agent) === nameKey(agent));
  const answered = mine ? seenBy(mine) : new Set();
  const complete = new Set(records.flatMap(r => [...seenBy(r)]));
  const lensesOf = us => [...new Set(us.map(u => u.lens))].filter(l => LENS.test(l)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return { lenses: lensesOf(answered.size ? planned.filter(u => answered.has(u.id)) : planned), units: planned.length, answered: answered.size, complete: complete.size };
}

// Records (or moves on) the hunt of `agent` on `run`; the other agents' records of the same run and plan learn how
// many units any agent answered. → the record written. `generation`: bumped after the write (the board looks again).
// `adopt` (the caller knows the undeclared agent holds no answers of this run): a named agent takes over the record a
// plan made without a name, same worktree, run and plan, nothing answered under it, so the hunt that plan started is one
// line under the name its answers gave, started when the plan was made (M6 review: never a "Your AI" line beside it).
export function noteHunt(stateDir, { agent = null, vendor = null, stream = 'main', run, plan, lenses = [], units = 0, answered = 0, complete = 0, now = Date.now(), generation = null, adopt = false }) {
  privateDir(huntsDir(stateDir));
  const rec = withLock(lockOf(stateDir), () => {
    for (const x of listHunts(stateDir, now)) if (!x.live) rmSync(join(huntsDir(stateDir), `${x.id}.json`), { force: true });
    const id = huntId({ stream, run, agent });
    const file = join(huntsDir(stateDir), `${id}.json`);
    const old = read(file);
    const unnamedId = huntId({ stream, run, agent: null });
    const unnamed = agent && adopt && unnamedId !== id ? read(join(huntsDir(stateDir), `${unnamedId}.json`)) : null;
    const adopted = unnamed && unnamed.stream === stream && unnamed.run === run && unnamed.plan === plan && !declaredName(unnamed.declaredAgent).name && count(unnamed.answered) === 0 && huntLive(unnamed, now) ? unnamed : null;
    const starts = [old && old.run === run && huntLive(old, now) ? old.startedAt : null, adopted?.startedAt].filter(s => typeof s === 'string' && Number.isFinite(Date.parse(s)));
    const startedAt = starts.length ? starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0] : kst(now);
    const h = { schema: 1, note: 'an AI hunt in progress (design §7): live while lastActivity + 30 minutes is ahead of the reader\'s clock', declaredAgent: agent, declaredVendor: vendor,
      stream, run, plan, lenses: lenses.filter(l => LENS.test(l)), units: count(units), answered: count(answered), complete: count(complete), startedAt, lastActivity: kst(now) };
    refuseLink(file);
    writeAtomic(file, stableJson(h), { mode: 0o600 });
    if (adopted) rmSync(join(huntsDir(stateDir), `${unnamedId}.json`), { force: true });
    for (const x of listHunts(stateDir, now)) {
      if (x.id === id || x.hunt.stream !== stream || x.hunt.run !== run || x.hunt.plan !== plan || x.hunt.complete === h.complete) continue;
      const p = join(huntsDir(stateDir), `${x.id}.json`);
      refuseLink(p);
      writeAtomic(p, stableJson({ ...x.hunt, complete: h.complete }), { mode: 0o600 });
    }
    return h;
  });
  if (generation) bumpGeneration(generation);
  return rec;
}

// The running hunt of another agent on this run whose plan is the one on disk, which a new plan would leave answering
// an old one (hunt --plan refuses to write it). → { id, hunt } or null.
export function huntInTheWay(stateDir, { stream, run, agent, plan, current, now = Date.now() }) {
  if (!current || plan === current) return null;
  return listHunts(stateDir, now).find(x => x.running && x.hunt.stream === stream && x.hunt.run === run && x.hunt.plan === current && nameKey(x.hunt.declaredAgent) !== nameKey(agent)) || null;
}

// "Codex · AI review L6 · 12/40 units · 3 min" (design §7): an agent that did not say who it is (or whose name is no
// name: a record anything wrote) is "Your AI", as on a claim; more than three lenses are the first three and "+N".
export function huntLine(h, now = Date.now()) {
  const lenses = Array.isArray(h.lenses) ? h.lenses.filter(l => LENS.test(l)) : [];
  const which = lenses.length > 3 ? `${lenses.slice(0, 3).join(', ')} +${lenses.length - 3}` : lenses.join(', ');
  return `${declaredName(h.declaredAgent).name || 'Your AI'} · AI review${which ? ` ${which}` : ''} · ${count(h.answered)}/${count(h.units)} units · ${fixingMinutes(huntMinutes(h, now))}`;
}
