// Hunt answers per agent (design 0.1-c §7, M6). Several agents may hunt one run. Each says who it is in its answers
// file's header, `{"plan", "agent", "vendor", "units"}` (declared, never checked: agents.mjs). The run keeps what each
// agent's latest `hunt --record` gave (`hunt-agents.json`), and ai-findings.json and coverage.json are made from all
// of them:
// - a re-hunt replaces answers within the same agent only: in one call a later file replaces a unit's earlier answer
//   only when both files are the same agent's, and a call replaces only the records of the agents whose answers it
//   holds (another agent's stand);
// - a cell is seen when any agent answered its unit completely;
// - the same defect (rule, scene, element and file:line) claimed by two agents is one finding with `agents: [...]`, so
//   the verifier gets one packet for it; the ledger then keeps one item per fingerprint whoever claimed it, in
//   whatever run (ledger.mjs foldAi).
// Answers files without a header (written before M6, or by an agent that does not say) are the undeclared agent's. A
// run only that agent hunted records exactly what it recorded before M6: no hunt-agents.json and no `agents`. A run
// recorded before M6 (ai-findings.json and coverage.json, no hunt-agents.json) is taken as the undeclared agent's
// record, so another agent's answers are added to it, never written over it.
// Answers are data: parsed and compared as strings (hunt.mjs recordHunt does the checking, once per agent).
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { recordHunt } from './hunt.mjs';
import { lensNumber } from './lenses.mjs';
import { stableJson, writeStable } from './stable.mjs';
import { present, readJsonFile } from './state.mjs';
import { asClaim, claimHash } from './verify.mjs';
import { declaredName, nameKey, agentList, vendorOnly } from './agents.mjs';

export const AGENTS_FILE = 'hunt-agents.json';
const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// Why a cell is not seen, most telling first: someone answered it, but not every item; a canary of it was missed;
// nobody answered it. The plan's own reasons (budget, not captured, …) come after.
const NOT_SEEN_RANK = ['incomplete', 'canary-missed', 'not-answered'];
const notSeenRank = r => { const i = NOT_SEEN_RANK.indexOf(r); return i < 0 ? NOT_SEEN_RANK.length : i; };

// Who wrote one answers file. → { agent, vendor, key } (both null and key '' when it does not say) or { error }.
export function answersHeader(doc) {
  if (!isObj(doc)) return { agent: null, vendor: null, key: '' };             // recordHunt refuses the shape
  const a = declaredName(doc.agent, 'agent'), v = declaredName(doc.vendor, 'vendor');
  if (a.error || v.error) return { error: a.error || v.error };
  const alone = vendorOnly(a.name, v.name, '"agent"');
  if (alone) return { error: alone };
  return { agent: a.name, vendor: v.name, key: nameKey(a.name) };
}

// ---- the records a run keeps --------------------------------------------------------------------------------------

const FIX = `remove ${AGENTS_FILE} from the run folder, then record every agent's answers again (hunt --record)`;
const validRecord = r => isObj(r) && !declaredName(r.agent).error && !declaredName(r.vendor).error && (r.plan === null || typeof r.plan === 'string')
  && ['findings', 'rejected', 'cells'].every(k => Array.isArray(r[k]) && r[k].every(isObj));
// What each agent's latest record gave, oldest agent key first: from hunt-agents.json, else (a run recorded before M6,
// or only by the undeclared agent) its ai-findings.json and coverage.json as the undeclared agent's record, else none.
// A hunt-agents.json that cannot be read is an error (CORRUPT), never "no other agent".
export function readAgentRecords(runDir) {
  const file = join(runDir, AGENTS_FILE);
  if (present(file)) {
    const doc = readJsonFile(file, FIX, { max: 256 * 1024 * 1024, retry: true });
    if (!isObj(doc) || !Array.isArray(doc.records) || !doc.records.every(validRecord)) throw Object.assign(new Error(`${file} is not the record of a hunt: ${FIX}`), { code: 'CORRUPT', file });
    const by = new Map();
    for (const r of doc.records) by.set(nameKey(declaredName(r.agent).name), { agent: declaredName(r.agent).name, vendor: declaredName(r.vendor).name, plan: r.plan, findings: r.findings, rejected: r.rejected, cells: r.cells });
    return [...by.entries()].sort(([a], [b]) => cmp(a, b)).map(([, r]) => r);
  }
  const fp = join(runDir, 'ai-findings.json'), cp = join(runDir, 'coverage.json');
  if (!present(fp) && !present(cp)) return [];
  const doc = present(fp) ? readJsonFile(fp, `fix or remove ${fp}`, { retry: true }) : null;
  const cov = present(cp) ? readJsonFile(cp, `fix or remove ${cp}`, { retry: true }) : null;
  const raw = Array.isArray(doc) ? doc : Array.isArray(doc?.findings) ? doc.findings : [];
  return [{
    agent: null, vendor: null, plan: typeof cov?.plan === 'string' ? cov.plan : typeof doc?.plan === 'string' ? doc.plan : null,
    // as claimed: a verdict verify --record wrote into the file is the verify key's to say (ledger), never the record's
    findings: raw.filter(f => isObj(f) && f.source === 'ai').map(asClaim),
    rejected: Array.isArray(doc?.rejected) ? doc.rejected.filter(isObj) : [],
    cells: Array.isArray(cov?.cells) ? cov.cells.filter(isObj) : [],
  }];
}
// hunt-agents.json when some agent said who it is; none (and an older one removed) when only the undeclared agent
// hunted, so such a run's files are as they were before M6.
export function writeAgentRecords(runDir, records) {
  const file = join(runDir, AGENTS_FILE);
  if (!records.some(r => r.agent || r.vendor)) { rmSync(file, { force: true }); return false; }
  writeStable(file, { schema: 1, note: 'what each agent\'s latest hunt --record gave (design §7); hunt --record makes ai-findings.json and coverage.json from all of them', records });
  return true;
}

// ---- recording ------------------------------------------------------------------------------------------------------

const defectKey = f => stableJson([f.rule, f.scene, f.selector ?? null, f.evidence?.file ? `${f.evidence.file}:${f.evidence.line}` : null]);
const byFinding = (a, b) => SEV[a.severity] - SEV[b.severity] || cmp(a.scene, b.scene) || cmp(a.rule, b.rule) || cmp(String(a.selector), String(b.selector)) || cmp(stableJson(a), stableJson(b));
const rejectedKey = a => stableJson([a.unit ?? '', a.item ?? '', a.scene ?? '', a.reason, a.detail ?? '', a.claim ?? '', a.agent ?? '']);
// The units of `plan` an agent's record saw (every cell of the unit seen: recordHunt marks a unit's cells together).
const unitsSeen = (cells, ids) => new Set(cells.filter(c => c.status === 'seen' && ids.has(c.unit)).map(c => c.unit));

// answers: the files of this call (in name order). prior: readAgentRecords(runDir). `backed`: the claim hashes the
// run's verify key holds a verdict for (verify.mjs backedClaims). → { findings, rejected, coverage, records, agents:
// [{ agent, vendor, units }] (this call's agents, each with the units of the plan it saw) }.
// Throws BAD_ANSWERS when no file of the call says who wrote it in a way that can be read (nothing is recorded).
export function recordHunts({ runDir, plan, answers, root, key = null, prior = [], backed = new Set() }) {
  const docs = Array.isArray(answers) ? answers : [answers];
  const headerProblems = [];
  const groups = new Map();
  docs.forEach((doc, i) => {
    const h = answersHeader(doc);
    if (h.error) { headerProblems.push({ reason: 'bad-shape', detail: `answers file ${i + 1}: ${h.error}; its answers were not used` }); return; }
    if (!groups.has(h.key)) groups.set(h.key, { key: h.key, agent: null, vendor: null, docs: [], files: [] });
    const g = groups.get(h.key);
    g.docs.push(doc); g.files.push(i + 1);
    if (h.agent) g.agent = h.agent;                                              // the latest file's spelling
    if (h.vendor) g.vendor = h.vendor;
  });
  if (!groups.size) throw Object.assign(new Error(`nothing recorded: ${headerProblems.map(p => p.detail).join('; ') || 'no answers file'}`), { code: 'BAD_ANSWERS' });
  const ids = new Set(plan.units.map(u => u.id));
  const records = new Map(prior.map(r => [nameKey(r.agent), r]));
  const fresh = new Map();
  for (const g of [...groups.values()].sort((a, b) => cmp(a.key, b.key))) {
    const r = recordHunt({ runDir, plan, answers: g.docs, root, key, files: g.files });
    fresh.set(g.key, r);
    records.set(g.key, { agent: g.agent, vendor: g.vendor, plan: plan.id, findings: r.findings, rejected: r.rejected, cells: r.coverage.cells });
  }
  const list = [...records.entries()].sort(([a], [b]) => cmp(a, b)).map(([, r]) => r);
  const agents = [...groups.values()].sort((a, b) => cmp(a.key, b.key)).map(g => ({ agent: g.agent, vendor: g.vendor, units: unitsSeen(records.get(g.key).cells, ids).size }));
  // only the undeclared agent: what recordHunt gave, as before M6
  if (list.length === 1 && !list[0].agent && !list[0].vendor) {
    const r = fresh.get('');
    return { findings: r.findings, rejected: [...r.rejected, ...headerProblems].sort((a, b) => cmp(rejectedKey(a), rejectedKey(b))), coverage: r.coverage, records: list, agents };
  }
  // findings: one per defect, with every agent that claimed it. The claim that speaks for it is the one the verify key
  // holds a verdict for (so a verdict outlives another agent's record, M6 review), else the first agent's; a more
  // severe claim of another agent raises only what protects it (`protect`), never what is shown or verified.
  const byKey = new Map();
  for (const r of list) {
    const who = r.agent || r.vendor ? [{ agent: r.agent, vendor: r.vendor }] : [];
    for (const f of r.findings) {
      const k = defectKey(f);
      const have = byKey.get(k);
      if (!have) { byKey.set(k, { f, agents: [...(f.agents || []), ...who], sevs: [f.severity, f.protect], undeclared: !who.length }); continue; }
      have.agents.push(...(f.agents || []), ...who);
      have.sevs.push(f.severity, f.protect);
      if (!who.length) have.undeclared = true;
      if (!backed.has(claimHash(have.f)) && backed.has(claimHash(f))) have.f = f;
    }
  }
  const findings = [...byKey.values()].map(({ f, agents: a, sevs, undeclared }) => {
    const { agents: _drop, protect: _p, undeclaredHunter: _u, ...rest } = f;
    const names = agentList(a);
    const top = sevs.filter(s => Object.hasOwn(SEV, s)).sort((x, y) => SEV[x] - SEV[y])[0];
    // a hunter that did not say who it is: no verifier counts as another vendor's for this claim (verify.mjs)
    return { ...rest, ...(names.length ? { agents: names } : {}), ...(names.length && undeclared ? { undeclaredHunter: true } : {}), ...(top && SEV[top] < SEV[rest.severity] ? { protect: top } : {}) };
  }).sort(byFinding);
  const rejected = [...list.flatMap(r => r.rejected.map(x => (r.agent ? { ...x, agent: r.agent } : x))), ...headerProblems].sort((a, b) => cmp(rejectedKey(a), rejectedKey(b)));
  // cells: seen when any agent saw it; otherwise the most telling reason it was not
  const cells = new Map();
  for (const r of list) for (const c of r.cells) {
    const k = `${c.lens}\0${c.scene}`;
    const have = cells.get(k);
    if (!have || (have.status !== 'seen' && (c.status === 'seen' || notSeenRank(c.reason) < notSeenRank(have.reason)))) cells.set(k, c);
  }
  const all = [...cells.values()].sort((a, b) => lensNumber(a.lens) - lensNumber(b.lens) || cmp(a.scene, b.scene));
  const byReason = {};
  for (const c of all) if (c.status !== 'seen') byReason[c.reason] = (byReason[c.reason] || 0) + 1;
  const coverage = {
    schema: 1, plan: plan.id, run: plan.run,
    summary: { cells: all.length, seen: all.filter(c => c.status === 'seen').length, notSeen: byReason, units: { total: plan.units.length, seen: unitsSeen(all, ids).size } },
    // every agent's part, as declared (the undeclared agent as null)
    agents: list.map(r => ({ agent: r.agent, vendor: r.vendor, units: unitsSeen(r.cells, ids).size, plan: r.plan })),
    cells: all,
  };
  return { findings, rejected, coverage, records: list, agents };
}

// One line for `hunt --record` when agents said who they are: each agent's part of the plan, as declared.
const whoText = a => (a.agent ? `${a.agent}${a.vendor ? ` (${a.vendor})` : ''}` : a.vendor ? `an agent of ${a.vendor}` : 'an agent that did not say who it is');
export function formatAgents({ coverage, agents = [] }) {
  if (!Array.isArray(coverage?.agents)) return null;
  const now = new Set(agents.map(a => nameKey(a.agent)));
  const total = coverage.summary.units.total;
  return `by agent, as declared: ${coverage.agents.map(a => `${whoText(a)} ${a.units}/${total} units seen${now.has(nameKey(a.agent)) ? ' (recorded now)' : ''}${a.plan && a.plan !== coverage.plan ? ` (answers of plan ${a.plan})` : ''}`).join(' · ')}`;
}
