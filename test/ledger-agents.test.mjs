// AI items from several agents (design 0.1-c §7, M6): the same fingerprint from two agents is one item with
// `agents`, and the ledger is the same whatever order the agents' folds come in (silence derived from what each hunt
// saw, a verdict folded before its claim waiting dormant, `addedAt` the earliest claim). The CLI path: two agents'
// answers in one run, folded through hunt --record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/ledger.mjs';
import { stableJson } from '../src/stable.mjs';
import { AGENTS, agentFolds, foldAll } from './fixtures/agent-folds.mjs';
import { huntProject, answerAll, deleteAll, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-ledger-agents-xdg-');
const A = { agent: AGENTS.a.agent, vendor: AGENTS.a.vendor }, B = { agent: AGENTS.b.agent, vendor: AGENTS.b.vendor };
const ai = st => Object.values(st.items).filter(i => i.source === 'ai');
const byRoute = (st, route) => ai(st).find(i => i.route === route);
// a seeded shuffle: the same "random" order every time
function shuffle(list, seed) {
  const out = list.slice();
  let x = seed;
  for (let i = out.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test('agents: the same fingerprint from two agents in two worktrees is one item with agents [...]; a rejection by one agent\'s verifier stays that agent\'s verdict', () => {
  const st = foldAll(L.emptyState(), [...agentFolds('a', 10), ...agentFolds('b', 10)]);
  const shared = byRoute(st, '/shared/3');
  assert.deepEqual(shared.agents, [A, B]);
  assert.deepEqual([...new Set(shared.hunts.filter(h => !h.silent).map(h => h.stream))], ['main', 'wt:two'], 'one item, hunts of both worktrees');
  assert.equal(ai(st).filter(i => i.route === '/shared/3').length, 1, 'never two items');
  assert.deepEqual(byRoute(st, '/own/b/2').agents, [B]);
  const disputed = byRoute(st, '/disputed/5');
  assert.deepEqual([disputed.agents, disputed.verification.status], [[A], 'rejected'], 'Codex\'s verifier rejected Claude Code\'s claim: a claim, not Codex\'s');
  assert.deepEqual(L.view(st, []).find(r => r.route === '/shared/3').agents, [A, B], 'rows carry the agents (findings --json)');
});

test('the ledger is the same whatever order the agents\' folds come in: one after the other, interleaved, reversed, shuffled', () => {
  const a = agentFolds('a', 20), b = agentFolds('b', 20);
  const ref = stableJson(foldAll(L.emptyState(), [...a, ...b]));
  const orders = {
    'Codex first': [...b, ...a],
    interleaved: a.flatMap((f, i) => [f, b[i]]),
    reversed: [...a, ...b].reverse(),
    'shuffled 1': shuffle([...a, ...b], 1), 'shuffled 2': shuffle([...a, ...b], 2), 'shuffled 3': shuffle([...a, ...b], 3),
  };
  for (const [name, folds] of Object.entries(orders)) assert.equal(stableJson(foldAll(L.emptyState(), folds)), ref, name);
  // a fold made again with the same key changes nothing; with another key it replaces only its own part
  const st = JSON.parse(ref);
  assert.equal(L.foldAi(st, a[3]), st);
  assert.equal(stableJson(L.foldAi(L.foldAi(st, { ...a[3], key: 'other', findings: [] }), a[3])), ref, 'replaced, then put back: the same ledger');
});

test('silence comes from what each hunt saw: a hunt folded before the claim it did not repeat still counts', () => {
  const [claim] = agentFolds('a', 1);                                          // run 0001 claims /shared/0
  const [, , look] = agentFolds('b', 3);                                       // run 0006 saw /shared/0 and claimed /shared/2
  const one = foldAll(L.emptyState(), [claim, look]), two = foldAll(L.emptyState(), [look, claim]);
  assert.equal(stableJson(one), stableJson(two));
  assert.deepEqual([byRoute(one, '/shared/0').silentHunts, byRoute(one, '/shared/0').lastHunted], [1, '0006']);
  // a fold written before M6 (no `seen` on its entry) keeps the silent hunt it gave
  const legacy = { ...one, folds: one.folds.map(f => (f.run === '0006' ? { run: f.run, source: f.source, key: f.key, stream: f.stream } : f)) };
  const next = L.foldAi(legacy, agentFolds('a', 2)[1]);
  assert.ok(byRoute(next, '/shared/0').hunts.some(h => h.silent && h.run === '0006'), 'kept as it was given');
});

test('a verdict folded before its claim waits dormant (never shown), then joins the item; addedAt is the earliest claim', () => {
  const [, , , , , rej] = agentFolds('b', 6);                                  // Codex's verifier rejects /disputed/5 (run 0012)
  const st = L.foldAi(L.emptyState(), rej);
  assert.equal(byRoute(st, '/disputed/5'), undefined, 'a rejection makes no item');
  assert.ok(st.dormant && Object.values(st.dormant).some(d => d.route === '/disputed/5'));
  assert.equal(L.view(st, []).some(r => r.route === '/disputed/5'), false);
  const claim = agentFolds('a', 6)[5];
  const both = L.foldAi(st, claim);
  assert.equal(byRoute(both, '/disputed/5').verification.status, 'rejected');
  assert.equal(both.dormant, undefined, 'nothing left dormant');
  assert.equal(stableJson(both), stableJson(L.foldAi(L.foldAi(L.emptyState(), claim), rej)));
  // addedAt: the earliest fold that claimed it, whichever came first
  const late = { ...claim, run: '0099', key: 'late', now: claim.now + 3600e3 };
  assert.equal(byRoute(L.foldAi(L.foldAi(L.emptyState(), late), claim), '/disputed/5').addedAt, claim.now);
});

test('cli: two agents\' answers in one run fold into one item with both agents (findings --json)', () => {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('hunt', '--plan', '--lens', 'L9', '--json'));
  const u = plan.units.find(x => x.scenes[0].route === '/tasks');
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, ...A, units: [answerAll(u, 'none', deleteAll('tasks.guest.normal.m'))] }));
  writeFileSync(join(p.cwd, 'b.json'), JSON.stringify({ plan: plan.id, ...B, units: [answerAll(u, 'none', deleteAll('tasks.guest.normal.d', { severity: 'medium' }))] }));
  run('hunt', '--record', 'a.json');
  run('hunt', '--record', 'b.json');
  const groups = JSON.parse(run('findings', '--json', '--all')).groups.filter(g => g.source === 'ai');
  assert.equal(groups.length, 1, 'the phone and the desktop claim are one fingerprint: one item');
  assert.deepEqual([groups[0].fps.length, groups[0].agents], [1, [A, B]]);
});

test('dormant: a fingerprint with nothing left is gone; one claimed once keeps when it was first claimed, whatever the order', () => {
  const [, , , , , five] = agentFolds('b', 6);
  const rej = { ...five, findings: five.findings.filter(f => f.status === 'rejected') };   // Codex's rejection only
  assert.ok(L.foldAi(L.emptyState(), rej).dormant);
  assert.equal(L.foldAi(L.foldAi(L.emptyState(), rej), { ...rej, key: 'withdrawn', findings: [] }).dormant, undefined, 'the rejection withdrawn: nothing dormant');
  // Claude Code claims /shared/0 at T0 and then withdraws it; Codex claims it an hour later
  const [a] = agentFolds('a', 1), withdrawn = { ...a, key: 'withdrawn', findings: [] };
  const b = { ...agentFolds('b', 1)[0], now: a.now + 3600e3 };
  const one = foldAll(L.emptyState(), [a, withdrawn, b]), two = foldAll(L.emptyState(), [b, a, withdrawn]);
  assert.equal(stableJson(one), stableJson(two));
  assert.equal(byRoute(one, '/shared/0').addedAt, a.now, 'first claimed at T0, by the claim since withdrawn');
  assert.deepEqual(byRoute(one, '/shared/0').agents, [B]);
});
