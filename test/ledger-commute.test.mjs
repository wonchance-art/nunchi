// Folds commute (design 0.1-c §7, M6; review of PR #34): a seeded property test. Each case is a made-up history of
// two or three agents in worktrees of their own: hunts (claims), verifies and re-hunts of a run (re-folds of one
// (run, "ai", stream)), re-checks (some of a fingerprint no claim has reached yet), fix probes (P1's re-check; one undone
// and done again), and the capture folds around them, sweeps and quick first looks. Folded in many orders, it must give
// one ledger and one view, byte for byte. The orders keep what has an order of its own: the folds of one (run, source,
// stream), one after the other as their keys replace each other, and the capture folds (the rule fold is monotonic,
// §5.1: an older sweep folded after a newer one only adds); everything else goes anywhere. Fixed seed, so the same
// cases every time; bounded, so it is quick on CI. Invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/ledger.mjs';
import { stableJson } from '../src/stable.mjs';

const SEED = 20261015, CASES = 100, ORDERS = 12;
const T0 = Date.UTC(2026, 9, 15, 0, 0, 0);
const AGENTS = [
  { stream: 'main', agent: 'Claude Code', vendor: 'Anthropic' },
  { stream: 'wt:two', agent: 'Codex', vendor: 'OpenAI' },
  { stream: 'wt:three', agent: 'Third Agent', vendor: 'Example Labs' },
];
const CELLS = ['guest.normal.m', 'guest.normal.d'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];

// mulberry32: a small seeded generator, the same numbers on every machine
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function scenario(seed) {
  const r = rng(seed);
  const pick = list => list[Math.floor(r() * list.length)];
  const chance = p => r() < p;
  const agents = AGENTS.slice(0, chance(0.5) ? 3 : 2);
  // the defects the agents can find: one fingerprint each, on a route of its own, in one or both cells
  const defects = Array.from({ length: 3 + Math.floor(r() * 3) }, (_, k) => {
    const l9 = k % 2 === 0;
    const d = { route: `/p/${String.fromCharCode(97 + k)}`, lens: l9 ? 'L9' : 'L6', rule: l9 ? 'L9.destructive-without-confirm' : 'L6.vague-error', selector: l9 ? 'button.go' : 'main p.err', cells: chance(0.5) ? CELLS : [CELLS[0]] };
    return { ...d, ...L.fingerprintOf({ source: 'ai', lens: d.lens, rule: d.rule, route: d.route, scene: `${d.route.slice(1).replace(/\//g, '~')}.${CELLS[0]}`, selector: d.selector, evidence: {} }) };
  });
  const scene = (d, cell) => `${d.route.slice(1).replace(/\//g, '~')}.${cell}`;
  const finding = (d, cell, status, who) => ({
    fp: d.fp, group: d.group, inputs: d.inputs, lens: d.lens, rule: d.rule, route: d.route, scene: scene(d, cell), cell, selector: d.selector, box: [1, 2, 3, 4],
    evidence: { claim: `${who.map(w => w.agent).join(' and ')}: ${d.selector} on ${d.route}` }, identity: null, status,
    claimedSeverity: pick(SEVERITIES), verdictSeverity: status === 'claimed' ? null : pick(SEVERITIES), by: status === 'claimed' ? null : pick(['same-model check', 'cross-vendor']),
    vendor: null, suspect: status !== 'claimed' && chance(0.1), ...(status !== 'claimed' && chance(0.1) ? { tooFewDecoys: true } : {}), ...(chance(0.1) ? { protectSeverity: 'blocker' } : {}),
    sceneHash: { top: `t${d.route}${cell}`, full: `f${d.route}${cell}`, textHash: `x${d.route}`, src: null }, agents: who.map(w => ({ agent: w.agent, vendor: w.vendor })),
  });
  let n = 0;
  const nextRun = () => String(++n).padStart(4, '0');
  const at = () => T0 + n * 60e3 + Math.floor(r() * 30e3);
  const chains = [], rule = [];
  const chain = ops => chains.push(ops);
  const sweeps = [];
  for (let step = 0; step < 6 + Math.floor(r() * 4); step++) {
    const who = pick(agents), run = nextRun();
    // a capture: a quick first look (rule fold only: its hunts never fold) or a sweep the agent hunts
    const quick = chance(0.25);
    const rd = pick(defects);
    rule.push({ op: 'rule', args: { id: run, kind: quick ? 'quick' : 'sweep', stream: who.stream, scope: { routes: [rd.route] }, wholeApp: false,
      scenes: [{ id: scene(rd, CELLS[0]), route: rd.route, person: 'guest', state: 'normal', viewport: 'm', status: 'captured', reason: null, httpStatus: 200 }],
      findings: L.annotate(chance(0.5) ? [{ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: scene(rd, CELLS[0]), route: rd.route, viewport: 'm', selector: 'main > button', box: null, evidence: { name: rd.route } }] : []) } });
    if (quick) continue;
    sweeps.push({ run, stream: who.stream });
    const by = chance(0.15) ? agents : [who];
    const claimed = defects.filter(() => chance(0.5));
    const seen = [...new Set(defects.filter(d => claimed.includes(d) || chance(0.6)).flatMap(d => d.cells.map(c => `${d.lens}|${d.route}|${c}`)))].sort();
    const hunt = claimed.flatMap(d => d.cells.filter(() => chance(0.8)).map(c => finding(d, c, 'claimed', by)));
    const ops = [{ op: 'ai', args: { run, stream: who.stream, key: `${run}-hunt`, findings: hunt, seen, now: at() } }];
    // verify: every claim gets a verdict (some suspect, some from a run with too few decoys)
    if (chance(0.6)) ops.push({ op: 'ai', args: { run, stream: who.stream, key: `${run}-verify`, findings: hunt.map(f => finding(defects.find(d => d.fp === f.fp), f.cell, pick(['confirmed', 'rejected', 'insufficient', 'claimed']), by)), seen, now: at() + 1 } });
    // a re-hunt of the run that no longer claims one of them
    if (hunt.length && chance(0.25)) { const drop = pick(hunt).fp; ops.push({ op: 'ai', args: { run, stream: who.stream, key: `${run}-rehunt`, findings: hunt.filter(f => f.fp !== drop), seen, now: at() + 2 } }); }
    chain(ops);
  }
  // re-checks of a run (any fingerprint, also one nothing claims before the end), one re-folded; one re-check fold per run
  for (let k = 0; k < 1 + Math.floor(r() * 3) && sweeps.length; k++) {
    const { run, stream } = sweeps.splice(Math.floor(r() * sweeps.length), 1)[0];
    const results = () => defects.filter(() => chance(0.5)).map(d => ({ fp: d.fp, cells: Object.fromEntries(d.cells.map(c => [c, { verdict: pick(['gone', 'gone', 'still-there', 'insufficient', 'unchanged', 'unanswered']), scene: scene(d, c), top: `t2${d.route}`, full: null, textHash: null, src: null }])) }));
    const ops = [{ op: 'recheck', args: { run, stream, key: `${run}-recheck-1`, suspect: chance(0.15), results: results(), now: T0 + (n + 1) * 60e3 + k } }];
    if (chance(0.3)) ops.push({ op: 'recheck', args: { run, stream, key: `${run}-recheck-2`, suspect: false, results: results(), now: T0 + (n + 2) * 60e3 + k } });
    chain(ops);
  }
  // fix probes: P1's re-check of one group's fingerprints; one undone and done again with another key
  for (let k = 0; k < Math.floor(r() * 3); k++) {
    const d = pick(defects), run = nextRun(), stream = pick(agents).stream;
    const fix = key => ({ op: 'fix', args: { run, stream, key, group: d.group, gone: [], rechecks: [{ fp: d.fp, cells: Object.fromEntries(d.cells.map(c => [c, { verdict: 'gone' }])) }], now: at() } });
    chain(chance(0.3) ? [fix(`${run}-fix-1`), { op: 'unfix', args: { run, stream } }, fix(`${run}-fix-2`)] : [fix(`${run}-fix-1`)]);
  }
  chains.push(rule);
  const dismissed = pick(defects);
  const decisions = [{ schema: 1, id: `dk-${seed}`, target: { group: dismissed.group }, decision: 'false-positive', reason: 'not-a-problem', by: 'me', at: new Date(T0 + Math.floor(n / 2) * 60e3).toISOString(), fingerprintVersion: 2 }];
  return { chains: chains.filter(c => c.length), decisions, end: T0 + (n + 10) * 60e3, seed };
}

const FOLD = { ai: L.foldAi, recheck: L.foldRecheck, fix: L.foldFix, unfix: L.unfoldFix, rule: L.foldRun };
const foldAll = ops => ops.reduce((s, o) => FOLD[o.op](s, o.args), L.emptyState());
// an order: each chain's folds one after the other, the chains interleaved at random
function interleave(chains, r) {
  const left = chains.map(c => c.slice()), out = [];
  while (left.some(c => c.length)) { const open = left.filter(c => c.length); out.push(open[Math.floor(r() * open.length)].shift()); }
  return out;
}

test(`folds commute: ${CASES} seeded histories of two or three agents (claims, verdicts, re-hunts, re-checks, fix probes, sweeps and quick first looks), each folded in ${ORDERS + 2} orders, give one ledger and one view`, t => {
  const r = rng(SEED);
  let folds = 0, items = 0, dormant = 0, compared = 0;
  for (let c = 0; c < CASES; c++) {
    const s = scenario(SEED + c);
    const ref = foldAll(s.chains.flat());
    const refJson = stableJson(ref);
    const viewOf = st => stableJson(L.view(st, s.decisions, new Set(s.decisions.map(L.approvalKey)), { now: s.end }));
    const refView = viewOf(ref);
    const orders = [s.chains.slice().reverse().flat(), ...Array.from({ length: ORDERS }, () => interleave(s.chains, r)), interleave(s.chains.slice().reverse(), r)];
    for (const [i, order] of orders.entries()) {
      const st = foldAll(order);
      assert.equal(stableJson(st), refJson, `case ${c} (seed ${s.seed}), order ${i}: the ledger`);
      assert.equal(viewOf(st), refView, `case ${c} (seed ${s.seed}), order ${i}: the view`);
      compared++;
    }
    folds += s.chains.flat().length;
    items += Object.values(ref.items).filter(x => x.source === 'ai').length;
    dormant += Object.keys(ref.dormant || {}).length;
  }
  t.diagnostic(`${CASES} cases, ${compared} orders compared, ${folds} folds per order in all; at the end ${items} AI items and ${dormant} dormant fingerprints`);
  assert.ok(items > CASES && dormant > 0, 'the cases make items and leave some fingerprints dormant');
});
