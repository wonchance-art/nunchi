// Hunt answers per agent (design 0.1-c §7, M6): agent and vendor in the answers file's header, a cell seen when any
// agent answered it completely, a re-hunt that replaces answers within the same agent only, one finding per defect
// whoever claimed it, and answers files written before M6 read as before. Synthetic run folders; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planHunt, recordHunt, writeRecord } from '../src/hunt.mjs';
import * as H from '../src/hunt-agents.mjs';
import * as A from '../src/agents.mjs';
import { stableJson } from '../src/stable.mjs';
import { huntProject, answerAll, answerSome, deleteAll, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-hunt-agents-xdg-');

const CLAUDE = { agent: 'Claude Code', vendor: 'Anthropic' }, CODEX = { agent: 'Codex', vendor: 'OpenAI' };
// one agent's hunt --record, as the CLI makes it: what the run holds, this call's files, written back
function record(p, plan, docs) {
  const r = H.recordHunts({ runDir: p.runDir, plan, answers: docs, root: p.cwd, prior: H.readAgentRecords(p.runDir) });
  H.writeAgentRecords(p.runDir, r.records);
  writeRecord(p.runDir, r);
  return r;
}
const unitOf = (plan, lens, route = '/tasks', state = 'normal') => plan.units.find(u => u.lens === lens && u.scenes[0].route === route && u.scenes[0].state === state);
const cellsOf = (r, unit) => r.coverage.cells.filter(c => c.unit === unit.id);

test('agents: declared names are data (40 characters, no control characters), compared without regard to case', () => {
  assert.deepEqual(A.declaredName('  Claude   Code '), { name: 'Claude Code' });
  assert.deepEqual(A.declaredName(undefined), { name: null });
  assert.match(A.declaredName('Codex\u202e').error, /control characters/);
  assert.match(A.declaredName('x'.repeat(41)).error, /at most 40/);
  assert.match(A.declaredName(42, 'vendor').error, /^vendor must be a short name/);
  assert.match(A.declaredName('   ').error, /leave it out/);
  assert.equal(A.sameName('OpenAI', 'openai'), true);
  assert.deepEqual(A.agentList([CODEX, { agent: 'codex', vendor: 'openai' }, CLAUDE, { agent: null, vendor: null }, { agent: 'bad\u0007' }]), [CLAUDE, CODEX], 'each once, in one order; nothing undeclared or unreadable');
  assert.equal(A.agentsText([CODEX, CLAUDE]), 'Claude Code (Anthropic) and Codex (OpenAI), as declared');
});

test('answers without a header record exactly as before M6: no hunt-agents.json, no agents', () => {
  const p = huntProject();
  const plan = planHunt({ runDir: p.runDir, lenses: p.lenses, lensIds: ['L9'], runId: '0001' });
  const u = unitOf(plan, 'L9');
  const docs = [{ plan: plan.id, units: [answerAll(u, 'none', deleteAll())] }];
  const before = recordHunt({ runDir: p.runDir, plan, answers: docs, root: p.cwd });
  const now = record(p, plan, docs);
  assert.equal(stableJson({ findings: now.findings, rejected: now.rejected, coverage: now.coverage }), stableJson(before), 'the same record');
  assert.equal(existsSync(join(p.runDir, H.AGENTS_FILE)), false);
  assert.ok(!readFileSync(join(p.runDir, 'ai-findings.json'), 'utf8').includes('agents'));
  // the undeclared agent alone re-records: still the same files, written over as before
  const again = record(p, plan, [{ plan: plan.id, units: [answerAll(u, 'none')] }]);
  assert.deepEqual(again.findings, [], 'its own re-hunt replaced its answer');
});

test('two agents: a cell is seen when any agent answered it completely; a re-hunt replaces answers within the same agent only; one finding per defect with agents', () => {
  const p = huntProject();
  const plan = planHunt({ runDir: p.runDir, lenses: p.lenses, lensIds: ['L9', 'L6'], runId: '0001' });
  const l9 = unitOf(plan, 'L9'), l6 = unitOf(plan, 'L6', '/tasks', 'error');
  // Claude Code answers L9 completely and claims "Delete all"; Codex answers L6, and L9 only in part
  let r = record(p, plan, [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none', deleteAll())] }]);
  assert.deepEqual(r.findings.map(f => [f.rule, f.agents]), [['L9.destructive-without-confirm', [CLAUDE]]]);
  r = record(p, plan, [{ plan: plan.id, ...CODEX, units: [answerAll(l6, 'none'), answerSome(l9, 'none')] }]);
  assert.ok(cellsOf(r, l9).every(c => c.status === 'seen'), 'Claude Code answered L9 completely: seen, though Codex did not');
  assert.ok(cellsOf(r, l6).every(c => c.status === 'seen'));
  assert.deepEqual(r.findings.map(f => [f.rule, f.agents]), [['L9.destructive-without-confirm', [CLAUDE]]], 'Codex\'s record left Claude Code\'s answers standing');
  assert.equal(r.coverage.summary.units.seen, 2);
  assert.deepEqual(r.coverage.agents.map(a => [a.agent, a.units]), [['Claude Code', 1], ['Codex', 1]]);
  // Codex claims the same defect, lower: one finding, both agents; with no verdict yet the first agent's claim speaks
  // for it (M6 review: the claim a verdict backs would, test/verdicts-agents.test.mjs)
  r = record(p, plan, [{ plan: plan.id, ...CODEX, units: [answerAll(l6, 'none'), answerAll(l9, 'none', deleteAll('tasks.guest.normal.m', { severity: 'medium', claim: 'No confirm step.' }))] }]);
  assert.deepEqual(r.findings.map(f => [f.severity, f.evidence.claim, f.agents, f.protect]), [['high', 'Deletes every task at once, with no confirmation or undo.', [CLAUDE, CODEX], undefined]]);
  // Claude Code re-hunts L9 and finds nothing: its claim goes, Codex's stands
  r = record(p, plan, [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none')] }]);
  assert.deepEqual(r.findings.map(f => [f.severity, f.agents]), [['medium', [CODEX]]]);
  // …and claims it again, higher: Claude Code's comes first still, Codex's lower claim cannot lower what protects it
  r = record(p, plan, [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none', deleteAll('tasks.guest.normal.m', { severity: 'blocker' }))] }]);
  assert.deepEqual(r.findings.map(f => [f.severity, f.protect]), [['blocker', undefined]]);
  r = record(p, plan, [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none', deleteAll('tasks.guest.normal.m', { severity: 'low' }))] }]);
  assert.deepEqual(r.findings.map(f => [f.severity, f.protect]), [['low', 'medium']], 'shown as the first agent claimed it, protected as the most severe claim');
  r = record(p, plan, [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none')] }]);
  // in one call, a later file replaces a unit's answer only within the same agent
  const q = huntProject();
  const qp = planHunt({ runDir: q.runDir, lenses: q.lenses, lensIds: ['L9'], runId: '0001' });
  const u = unitOf(qp, 'L9');
  const both = record(q, qp, [{ plan: qp.id, ...CLAUDE, units: [answerAll(u, 'none', deleteAll())] }, { plan: qp.id, ...CODEX, units: [answerAll(u, 'none')] }]);
  assert.deepEqual(both.findings.map(f => f.agents), [[CLAUDE]], 'Codex\'s later file did not replace Claude Code\'s answer');
  const same = record(q, qp, [{ plan: qp.id, ...CLAUDE, units: [answerAll(u, 'none', deleteAll())] }, { plan: qp.id, agent: 'claude code', units: [answerAll(u, 'none')] }]);
  assert.deepEqual(same.findings, [], 'the same agent (case aside): its later file is a re-hunt');
  assert.deepEqual(same.records.map(x => x.agent), ['claude code', 'Codex'], 'Codex\'s record from the call before stands');
});

test('the order agents record in does not matter: the same files give the same ai-findings.json and coverage.json', () => {
  const run = order => {
    const p = huntProject();
    const plan = planHunt({ runDir: p.runDir, lenses: p.lenses, lensIds: ['L9', 'L6'], runId: '0001' });
    const l9 = unitOf(plan, 'L9'), l6 = unitOf(plan, 'L6', '/tasks', 'error');
    const calls = { a: [{ plan: plan.id, ...CLAUDE, units: [answerAll(l9, 'none', deleteAll())] }], b: [{ plan: plan.id, ...CODEX, units: [answerAll(l6, 'none'), answerAll(l9, 'none', deleteAll('tasks.guest.normal.d'))] }] };
    for (const k of order) record(p, plan, calls[k]);
    return ['ai-findings.json', 'coverage.json', H.AGENTS_FILE].map(n => readFileSync(join(p.runDir, n), 'utf8')).join('\n');
  };
  assert.equal(run(['a', 'b']), run(['b', 'a']));
});

test('header: a name that cannot be read refuses that file (said, its answers unused); nothing readable at all records nothing', () => {
  const p = huntProject();
  const plan = planHunt({ runDir: p.runDir, lenses: p.lenses, lensIds: ['L9'], runId: '0001' });
  const u = unitOf(plan, 'L9');
  const r = record(p, plan, [{ plan: plan.id, agent: 'Codex\u0000', units: [answerAll(u, 'none', deleteAll())] }, { plan: plan.id, ...CLAUDE, units: [answerAll(u, 'none')] }]);
  assert.deepEqual(r.findings, [], 'the file with the unreadable name was not used');
  assert.deepEqual(r.rejected.map(x => [x.reason, x.detail]), [['bad-shape', 'answers file 1: agent must not hold control characters; its answers were not used']]);
  assert.throws(() => H.recordHunts({ runDir: p.runDir, plan, answers: [{ plan: plan.id, vendor: 7, units: [] }], root: p.cwd }), e => e.code === 'BAD_ANSWERS' && /answers file 1: vendor must be a short name/.test(e.message));
  // a vendor alone names no agent: two agents of one vendor would share one record (M6 review)
  const alone = record(p, plan, [{ plan: plan.id, vendor: 'OpenAI', units: [answerAll(u, 'none', deleteAll())] }, { plan: plan.id, ...CLAUDE, units: [answerAll(u, 'none')] }]);
  assert.deepEqual([alone.findings, alone.rejected.map(x => x.detail)], [[], ['answers file 1: a vendor without an agent: name the agent too ("agent"), so two agents of one vendor keep answers of their own; its answers were not used']]);
  // a unit answer still refuses unknown keys: the header is the place for who answered (design §7)
  const inUnit = record(p, plan, [{ plan: plan.id, units: [{ ...answerAll(u, 'none'), agent: 'Codex' }] }]);
  assert.deepEqual(inUnit.rejected.map(x => x.detail), ['unknown key(s) agent']);
});

test('a run recorded before M6 keeps what it recorded when another agent records: taken as the undeclared agent\'s, its verdicts left to the verify key', () => {
  const p = huntProject();
  const plan = planHunt({ runDir: p.runDir, lenses: p.lenses, lensIds: ['L9', 'L6'], runId: '0001' });
  const l9 = unitOf(plan, 'L9'), l6 = unitOf(plan, 'L6', '/tasks', 'error');
  // as M5 and before wrote it: ai-findings.json (here with a verdict verify --record wrote) and coverage.json
  const old = recordHunt({ runDir: p.runDir, plan, answers: [{ plan: plan.id, units: [answerAll(l9, 'none', deleteAll())] }], root: p.cwd });
  writeRecord(p.runDir, { ...old, findings: old.findings.map(f => ({ ...f, status: 'confirmed', verification: { verdict: 'confirmed', claimedSeverity: 'high', severity: 'medium', verifier: 'same-model check' }, severity: 'medium' })) });
  const r = record(p, plan, [{ plan: plan.id, ...CODEX, units: [answerAll(l6, 'none')] }]);
  assert.deepEqual(r.findings.map(f => [f.status, f.severity, f.agents]), [['claimed', 'high', undefined]], 'kept, as claimed (the ledger takes verdicts from the key)');
  assert.ok(cellsOf(r, l9).every(c => c.status === 'seen') && cellsOf(r, l6).every(c => c.status === 'seen'));
  const stored = JSON.parse(readFileSync(join(p.runDir, H.AGENTS_FILE), 'utf8')).records;
  assert.deepEqual(stored.map(x => [x.agent, x.vendor]), [[null, null], ['Codex', 'OpenAI']]);
  // a hunt-agents.json that is not a record is an error, never "no other agent"
  writeFileSync(join(p.runDir, H.AGENTS_FILE), '{"records": [{"agent": 7}]}');
  assert.throws(() => H.readAgentRecords(p.runDir), e => e.code === 'CORRUPT' && /is not the record of a hunt/.test(e.message));
});

test('cli: hunt --record says each agent\'s part, as declared; --json carries it', () => {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, 'hunt', ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('--plan', '--lens', 'L9', '--json'));
  const u = plan.units.find(x => x.scenes[0].route === '/tasks');
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, ...CLAUDE, units: [answerAll(u, 'none', deleteAll())] }));
  writeFileSync(join(p.cwd, 'b.json'), JSON.stringify({ plan: plan.id, ...CODEX, units: [answerSome(u, 'none')] }));
  assert.match(run('--record', 'a.json'), /^by agent, as declared: Claude Code \(Anthropic\) 1\/\d+ units seen \(recorded now\)$/m);
  const j = JSON.parse(run('--record', 'b.json', '--json'));
  assert.deepEqual(j.agents.map(a => [a.agent, a.vendor, a.units]), [['Claude Code', 'Anthropic', 1], ['Codex', 'OpenAI', 0]]);
  const ai = JSON.parse(readFileSync(join(p.runDir, 'ai-findings.json'), 'utf8'));
  assert.deepEqual(ai.findings.map(f => f.agents), [[CLAUDE]]);
  assert.deepEqual(ai.rejected, [], 'an incomplete unit is not a rejection');
  const bad = spawnSync('node', [CLI, 'hunt', '--record', 'c.json'], { cwd: p.cwd, encoding: 'utf8', input: '' });
  assert.equal(bad.status, 1, 'a file that is not there');
  writeFileSync(join(p.cwd, 'c.json'), JSON.stringify({ plan: plan.id, agent: ['x'], units: [] }));
  const none = spawnSync('node', [CLI, 'hunt', '--record', 'c.json'], { cwd: p.cwd, encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /nothing recorded: answers file 1: agent must be a short name/);
});
