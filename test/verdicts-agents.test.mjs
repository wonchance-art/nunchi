// A verdict outlives another agent's hunt --record (M6 review): verdicts are matched to claims by claim hash, never by
// their place in ai-findings.json, and never dropped as a whole round; when two agents claim one defect, the claim the
// verify key backs speaks for it, and a more severe claim raises only what protects it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from '../src/project.mjs';
import { readKey } from '../src/state.mjs';
import { verdictsFromKey, claimHash, roundsStillValid } from '../src/verify.mjs';
import { huntProject, answerAll, tmp } from './fixtures/hunt-run.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-verdicts-agents-xdg-');
const CLAUDE = { agent: 'Claude Code', vendor: 'Anthropic' }, CODEX = { agent: 'Codex', vendor: 'OpenAI' };
const defect = (scene, severity, claim) => ({ scene, selector: 'button#delete-all', claim, severity });
const answer = (unit, defects) => answerAll(unit, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects } });

test('a confirmed low stays confirmed and low when another agent claims the same defect high, on that screen and on another one', () => {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('hunt', '--plan', '--lens', 'L9', '--json'));
  const u = plan.units.find(x => x.scenes[0].route === '/tasks');
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, ...CLAUDE, units: [answer(u, [defect('tasks.guest.normal.m', 'low', 'Deletes every task at once.')])] }));
  run('hunt', '--record', 'a.json');
  run('verify', '--plan');
  const key = readKey(p.runDir, 'verify-key.json');
  writeFileSync(join(p.cwd, 'v.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'low', reason: 'seen on the screen' }))));
  run('verify', '--record', 'v.json');
  // Codex claims the same defect, high, on the same screen and on the desktop one
  writeFileSync(join(p.cwd, 'b.json'), JSON.stringify({ plan: plan.id, ...CODEX, units: [answer(u, [defect('tasks.guest.normal.m', 'high', 'No confirmation at all.'), defect('tasks.guest.normal.d', 'high', 'No confirmation at all.')])] }));
  run('hunt', '--record', 'b.json');
  const ai = JSON.parse(readFileSync(join(p.runDir, 'ai-findings.json'), 'utf8')).findings;
  const phone = ai.find(f => f.scene === 'tasks.guest.normal.m'), desk = ai.find(f => f.scene === 'tasks.guest.normal.d');
  assert.deepEqual([phone.status, phone.severity, phone.evidence.claim, phone.protect, phone.agents.map(a => a.agent)], ['confirmed', 'low', 'Deletes every task at once.', 'high', ['Claude Code', 'Codex']],
    'Claude Code\'s verified claim speaks for the defect, its status kept in ai-findings.json; Codex\'s high only protects it');
  assert.deepEqual([desk.status, desk.severity], ['claimed', 'high'], 'the new screen is a claim of its own');
  const item = Object.values(P.loadLedger(join(p.cwd, '.nunchi'), { root: p.cwd }).state.items).find(i => i.source === 'ai');
  assert.deepEqual([item.verification.status, item.severity, item.protect], ['confirmed', 'low', 'high'], 'the ledger: still confirmed, shown low, protected as high');
});

test('verdicts are matched by claim hash: a re-sorted or grown ai-findings.json keeps every verdict; a claim reworded since stays a claim', () => {
  const f = (i, claim = `claim ${i}`) => ({ source: 'ai', status: 'claimed', lens: 'L9', rule: 'L9.destructive-without-confirm', severity: 'medium', scene: `s${i}.guest.normal.m`, route: `/r${i}`, viewport: 'm', selector: 'button.x', box: [0, 0, 1, 1], evidence: { claim } });
  const claims = [f(0), f(1), f(2)];
  const packets = Object.fromEntries(claims.map((c, i) => [`p${i}`, { finding: i, hash: claimHash(c) }]));
  packets.d1 = { decoy: true }; packets.d2 = { decoy: true }; packets.d3 = { decoy: true };
  const key = { packets, decoysPlanned: 3, recorded: { vendor: null, verdicts: [...claims.map((_, i) => ({ packet: `p${i}`, verdict: 'confirmed', severity: 'low', reason: 'r' })), ...['d1', 'd2', 'd3'].map(packet => ({ packet, verdict: 'rejected', reason: 'r' }))] } };
  const moved = [f(9), claims[2], f(1, 'reworded'), claims[0]];
  assert.deepEqual(verdictsFromKey(moved, key).map(x => [x.scene, x.status]), [['s9.guest.normal.m', 'claimed'], ['s2.guest.normal.m', 'confirmed'], ['s1.guest.normal.m', 'claimed'], ['s0.guest.normal.m', 'confirmed']]);
  assert.equal(roundsStillValid(moved, key).length, 1, 'the round still counts');
  assert.equal(roundsStillValid([f(9)], key).length, 0, 'none of its claims is left: dropped');
});
