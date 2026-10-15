// Folds of AI hunts by two agents in two worktrees (M6), as ledger.mjs foldAi takes them: Claude Code hunts the main
// worktree's runs (odd ids), Codex a linked worktree's (even ids; run ids are one sequence across worktrees). Each
// hunt claims one of ten defects both agents find (on /shared/<k>), one of its own, and every fifth one a defect the
// other agent's verifier rejects; each sees every shared screen, so the defects it did not claim get a silent hunt.
// The i-th fold of either agent has the same time, so the final ledger is one function of the folds. Invented content.
import * as L from '../../src/ledger.mjs';

export const AGENTS = { a: { agent: 'Claude Code', vendor: 'Anthropic', stream: 'main' }, b: { agent: 'Codex', vendor: 'OpenAI', stream: 'wt:two' } };
export const T0 = Date.UTC(2026, 9, 15, 3, 0, 0);
const runOf = (who, i) => String(who === 'a' ? 2 * i + 1 : 2 * i + 2).padStart(4, '0');
const CELL = 'guest.normal.m';

function finding(who, { route, selector, status = 'claimed', severity = 'medium', lens = 'L6', rule = 'L6.vague-error' }) {
  const f = { source: 'ai', lens, rule, route, scene: `${route.slice(1).replace(/\//g, '~')}.${CELL}`, selector, severity, evidence: { claim: `${who}: ${selector} says nothing useful` } };
  const { fp, group, inputs } = L.fingerprintOf(f);
  const judged = status !== 'claimed';
  return { fp, group, inputs, lens, rule, route, scene: f.scene, cell: CELL, selector, box: [10, 20, 30, 40], evidence: f.evidence, identity: null, status,
    claimedSeverity: severity, verdictSeverity: judged ? severity : null, by: judged ? 'same-model check' : null, vendor: null, suspect: false,
    sceneHash: { top: `t${route}`, full: `f${route}`, textHash: `x${route}`, src: null }, agents: [{ agent: AGENTS[who].agent, vendor: AGENTS[who].vendor }] };
}

// The n folds of one agent: [{ run, stream, key, findings, seen, now }].
export function agentFolds(who, n = 50) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = i % 10;
    const findings = [
      finding(who, { route: `/shared/${k}`, selector: 'main p.err', status: i % 3 === 0 ? 'confirmed' : 'claimed' }),
      finding(who, { route: `/own/${who}/${i % 7}`, selector: `main p.n${i}` }),
    ];
    // every fifth hunt: a defect Claude Code claims and Codex's verifier rejects, folded in either order
    if (i % 5 === 0) findings.push(finding(who, { route: `/disputed/${i}`, selector: 'main button.go', lens: 'L9', rule: 'L9.destructive-without-confirm', severity: 'high', status: who === 'a' ? 'claimed' : 'rejected' }));
    const seen = [...Array.from({ length: 10 }, (_, j) => `L6|/shared/${j}|${CELL}`), `L6|/own/${who}/${i % 7}|${CELL}`].sort();
    out.push({ run: runOf(who, i), stream: AGENTS[who].stream, key: `${who}-${i}`, findings, seen, now: T0 + i * 60e3 });
  }
  return out;
}

// Folds them, in this order, into `state`.
export const foldAll = (state, folds) => folds.reduce((s, f) => L.foldAi(s, f), state);
