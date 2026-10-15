// Offering guards (design 0.1-c §5, spec §7.3): only after a verified fix of a kind that has a built-in guard, as one
// card at the end of a fix batch — "Stop these coming back? `window.confirm` (fixed twice) · `href="#"`" — with an Add
// toggle per row. Adding a guard is a person's action (the board's card, or `nunchi guard --add` in their own terminal),
// never the agent's. "≥ 5 open instances" shows only a passive "guard available" chip.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { KINDS, guardKindOf, paramsFromRows, labelOf, widening, readGuards, writeGuards, guardsPath, emptyGuards, OPEN_INSTANCES, paramsProblem } from './guard-kinds.mjs';
import { stableJson, withLock, writeStable } from './stable.mjs';
import { readPlan, latestRecords, isOpen } from './fix/records.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Read, change and write guards.json under one lock (in the state folder, so no lock folder is ever left among the
// committed files). `change(doc)` → { doc, ... }; the file is written only when the document changed.
export function changeGuards({ nunchiDir, stateDir, change }) {
  return withLock(join(stateDir, 'guards'), () => {
    const path = guardsPath(nunchiDir);
    const doc = readGuards(path) || emptyGuards();
    const r = change(doc);
    if (stableJson(r.doc) !== stableJson(doc)) writeGuards(path, r.doc);
    return r;
  }, { timeoutMs: 15000 });
}

// What the card of this batch added (`state/guard-card.json`): per kind, the params and baseline entries it added, so
// its toggle takes back exactly that and never a guard the person had before.
export const cardPath = stateDir => join(stateDir, 'guard-card.json');
export function readCard(stateDir) {
  try {
    const c = JSON.parse(readFileSync(cardPath(stateDir), 'utf8'));
    return c && c.schema === 1 && typeof c.plan === 'string' && c.added && typeof c.added === 'object' && !Array.isArray(c.added) ? c : null;
  } catch { return null; }
}
export const writeCard = (stateDir, card) => writeStable(cardPath(stateDir), { schema: 1, plan: card.plan, added: card.added });

// "(fixed twice)": how many groups of the kind the fix loop has fixed (their latest attempt verified), all batches.
export const fixedWords = n => (n <= 1 ? '' : n === 2 ? ' (fixed twice)' : ` (fixed ${n} times)`);
// The design's words: "Stop these coming back? `window.confirm` (fixed twice) · `href="#"`".
export const OFFER_TITLE = 'Stop these coming back?';
export const rowText = r => `${r.label}${fixedWords(r.fixed)}`;
export const offerLine = rows => `${OFFER_TITLE} ${rows.map(rowText).join(' · ')}`;

// The guards to offer at the end of the last fix batch (state/fix-plan.json): only once the batch is over (every group
// of the plan has an attempt since the plan, and none is still running), only after a verified fix (the latest attempt
// of a group of the batch is `fixed`) of a kind with a built-in guard, and only what guards.json does not cover
// already, or what this card added. `rows`: the ledger's rows (view()). → { plan, rows: [{ kind, params, label, fixed,
// added }] } or null.
export const batchOver = (plan, latest) => plan.groups.every(g => { const rec = latest.get(g); return !!rec && !isOpen(rec) && (rec.phases?.[0]?.at || '') >= plan.at; });
export function guardOffer({ stateDir, rows, doc }) {
  const plan = readPlan(stateDir);
  if (!plan || typeof plan.at !== 'string' || !Array.isArray(plan.groups)) return null;
  let latest;
  try { latest = latestRecords(stateDir); } catch { return null; }
  if (!batchOver(plan, latest)) return null;
  const rowsOf = new Map();
  for (const r of rows) { if (!rowsOf.has(r.group)) rowsOf.set(r.group, []); rowsOf.get(r.group).push(r); }
  const card = readCard(stateDir);
  const added = card?.plan === plan.at ? card.added : {};
  const byKind = new Map();
  for (const [g, rec] of [...latest].sort((a, b) => cmp(a[0], b[0]))) {
    if (rec?.phase !== 'fixed') continue;
    const mine = rowsOf.get(g) || [];
    const kind = guardKindOf(mine[0]);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, { fixed: 0, batch: [] });
    const e = byKind.get(kind);
    e.fixed++;
    if (plan.groups.includes(g) && (rec.phases?.[0]?.at || '') >= plan.at) e.batch.push(...mine);
  }
  const out = [];
  for (const kind of KINDS) {
    const e = byKind.get(kind);
    if (!e || !e.batch.length) continue;
    const params = paramsFromRows(kind, e.batch);
    const cur = doc?.guards.find(g => g.kind === kind)?.params ?? null;
    const mine = added[kind] && added[kind].params && paramsProblem(kind, added[kind].params) === null ? added[kind] : null;
    if (!mine && widening(kind, cur, params) === null) continue;              // guarded already
    out.push({ kind, params, label: labelOf(kind, params), fixed: e.fixed, added: !!mine && widening(kind, cur, mine.params) === null });
  }
  return { plan: plan.at, rows: out };
}

// The card's Add toggle (a person's action: the board's key, never the agent). `add`: true adds what the row offers (the
// hits there now become the baseline of what it adds); false takes back exactly what this card added.
// → { ok, status?, error?, baselined? }
export async function toggleOffer({ nunchiDir, stateDir, project, root = project, rows, kind, add, by = null }) {
  const offer = guardOffer({ stateDir, rows, doc: readGuards(guardsPath(nunchiDir)) });
  const row = offer?.rows.find(r => r.kind === kind);
  if (!row) return { ok: false, status: 409, error: 'this guard is no longer offered' };
  const card = readCard(stateDir);
  const { addGuard, removeGuard } = await import('./guards.mjs');      // the scanner (the pinned parser) only when it is needed
  const added = card?.plan === offer.plan ? { ...card.added } : {};
  if (add) {
    const r = changeGuards({ nunchiDir, stateDir, change: doc => addGuard(doc, { project, root, kind, params: row.params }) });
    if (r.added) added[kind] = { params: r.added, entries: r.baselined.map(({ kind: k, file, anchor, count }) => ({ kind: k, file, anchor, count })), channel: 'board', ...(by ? { by: String(by).slice(0, 80) } : {}) };
    writeCard(stateDir, { plan: offer.plan, added });
    return { ok: true, baselined: r.baselined.reduce((n, e) => n + e.count, 0) };
  }
  const mine = added[kind];
  if (!mine) return { ok: false, status: 409, error: 'this card did not add that guard' };
  changeGuards({ nunchiDir, stateDir, change: doc => removeGuard(doc, { kind, params: mine.params, entries: mine.entries }) });
  delete added[kind];
  writeCard(stateDir, { plan: offer.plan, added });
  return { ok: true };
}

// The passive chip ("≥ 5 open instances" → "guard available"): the rules whose findings a guard kind covers, with at
// least OPEN_INSTANCES places still open (open, came back, to fix, later), and no guard covering them yet.
export const AVAILABLE = 'guard available';
export function guardAvailable(rows, doc) {
  const open = new Map();
  for (const r of rows) {
    if (r.goneAt || !['open', 'regressed', 'to-fix', 'held'].includes(r.status)) continue;
    const kind = guardKindOf(r);
    if (!kind) continue;
    if (!open.has(r.rule)) open.set(r.rule, { kind, rows: [] });
    open.get(r.rule).rows.push(r);
  }
  const out = new Set();
  for (const [rule, e] of open) {
    if (e.rows.length < OPEN_INSTANCES) continue;
    const cur = doc?.guards.find(g => g.kind === e.kind)?.params ?? null;
    if (widening(e.kind, cur, paramsFromRows(e.kind, e.rows)) !== null) out.add(rule);
  }
  return out;
}
