// Cross-vendor verdicts (design 0.1-c §7, §9.7, M6): a verdict is labelled cross-vendor only when every agent that
// claimed the finding declared a vendor other than the verifier's; one of the same vendor, or one whose hunter did not
// declare a vendor, is a same-model check; vendors are declared, and a cross-vendor confirmation approves nothing (0.1
// never auto-approves). Packets never say who hunted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVerify, recordVerdicts, verdictsFromKey, claimOf, verifierOf, SAME_MODEL, CROSS_VENDOR } from '../src/verify.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKey } from '../src/state.mjs';
import { huntProject, answerAll } from './fixtures/hunt-run.mjs';
import { tmp } from './fixtures/tmp.mjs';
import * as L from '../src/ledger.mjs';
import { summary } from '../src/summary.mjs';
import { foldFinding } from '../src/ai-fold.mjs';

const CLAUDE = { agent: 'Claude Code', vendor: 'Anthropic' }, CODEX = { agent: 'Codex', vendor: 'OpenAI' };
const ctl = (selector, name) => ({ selector, tag: 'button', role: null, name, hasText: true, text: name, box: [16, 100 + selector.length, 120, 44], href: null, inline: false });
const SCENE = 'tasks.guest.normal.m';
const CONTROLS = { [SCENE]: [ctl('main > button:nth-of-type(1)', 'Add task'), ctl('main > button:nth-of-type(2)', 'Save'), ctl('nav > a', 'Notes'), ctl('main > form > button', 'Send'), ctl('footer > button', 'Help')] };
const claim = (i, agents) => ({ source: 'ai', status: 'claimed', lens: 'L6', rule: 'L6.vague-error', severity: 'medium', scene: SCENE, route: '/tasks', viewport: 'm',
  selector: `main > p:nth-of-type(${i + 1})`, box: [16, 40 * i, 300, 24], evidence: { claim: `claimed text ${i}`, groundedIn: ['controls.json'] }, ...(agents ? { agents } : {}) });
const FINDINGS = [claim(0, [CLAUDE]), claim(1, [CODEX]), claim(2, [CLAUDE, CODEX]), claim(3)];
const plan = () => planVerify({ findings: FINDINGS, canaryScenes: new Set(), controlsOf: s => CONTROLS[s] || null, filesOf: s => [`${s}/top.jpg`] });
const confirmAll = key => Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'high', reason: 'seen' }));

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-cross-vendor-xdg-');

test('cross-vendor: per claim, against the vendors of the agents that claimed it; a claim whose hunter declared no vendor is never cross-vendor', () => {
  const { packets, key } = plan();
  assert.ok(!JSON.stringify(packets).includes('Codex') && !JSON.stringify(packets).includes('OpenAI'), 'a packet never says who hunted (a decoy has no hunter)');
  assert.equal(claimOf(FINDINGS[1]).agents, undefined);
  const r = recordVerdicts({ findings: FINDINGS, key, verdicts: confirmAll(key), vendor: 'openai' });
  assert.deepEqual(r.findings.map(f => [f.verification.verifier, f.verification.vendor]), [[CROSS_VENDOR, 'openai'], [SAME_MODEL, 'openai'], [SAME_MODEL, 'openai'], [SAME_MODEL, 'openai']],
    'Claude Code\'s claim is cross-vendor; Codex\'s, and the one both claimed, are checked by their own vendor; the undeclared hunter\'s is no cross-vendor check (M6 review)');
  assert.deepEqual(r.verify.verifier, { label: CROSS_VENDOR, vendor: 'openai', sameVendor: 2, undeclaredVendor: 1 });
  // a hunter that named itself but not its vendor, or the undeclared agent beside a declared one: not known, not cross
  assert.equal(verifierOf({ agents: [CLAUDE, { agent: 'Some Agent', vendor: null }] }, 'OpenAI'), SAME_MODEL);
  assert.equal(verifierOf({ agents: [CLAUDE], undeclaredHunter: true }, 'OpenAI'), SAME_MODEL);
  assert.equal(verifierOf({ agents: [CLAUDE] }, '  OpenAI '), CROSS_VENDOR, 'the verifier\'s vendor read as declared');
  assert.equal(verifierOf({ agents: [CLAUDE] }, 'Open\u0007AI'), SAME_MODEL, 'one that is no name is none');
  assert.deepEqual(recordVerdicts({ findings: FINDINGS, key, verdicts: confirmAll(key) }).verify.verifier, { label: SAME_MODEL }, 'no --vendor: a same-model check');
  const onlyCodex = FINDINGS.map(f => ({ ...f, agents: [CODEX] }));
  const k2 = planVerify({ findings: onlyCodex, canaryScenes: new Set(), controlsOf: s => CONTROLS[s] || null, filesOf: s => [`${s}/top.jpg`] }).key;
  assert.deepEqual(recordVerdicts({ findings: onlyCodex, key: k2, verdicts: confirmAll(k2), vendor: 'OpenAI' }).verify.verifier, { label: SAME_MODEL, vendor: 'OpenAI' }, 'its own vendor\'s claims only');
  assert.equal(verifierOf(FINDINGS[0], null), SAME_MODEL);
  // the ledger recomputes the label from the key's recorded vendor and the findings, never from the file's word
  const fromKey = verdictsFromKey(r.findings.map(f => ({ ...f, verification: { ...f.verification, verifier: CROSS_VENDOR } })), { ...key, recorded: { verdicts: confirmAll(key), vendor: 'openai' } });
  assert.deepEqual(fromKey.map(f => f.verification.verifier), [CROSS_VENDOR, SAME_MODEL, SAME_MODEL, SAME_MODEL]);
});

test('an item is a same-model check when any finding of it was: never cross-vendor because the one that ranks first was', () => {
  const scene = v => ({ id: `tasks.guest.normal.${v}`, route: '/tasks', person: 'guest', state: 'normal', viewport: v, top: 't', full: 'f', textHash: 'x' });
  // Claude Code alone claimed it on the desktop (the screen that ranks first), both agents on the phone; Codex's vendor
  // verified both
  const desk = { ...claim(0, [CLAUDE]), scene: 'tasks.guest.normal.d', viewport: 'd', status: 'confirmed', verification: { verdict: 'confirmed', severity: 'medium', claimedSeverity: 'medium', verifier: CROSS_VENDOR, vendor: 'OpenAI' } };
  const phone = { ...desk, scene: SCENE, viewport: 'm', agents: [CLAUDE, CODEX], verification: { ...desk.verification, verifier: SAME_MODEL } };
  const fold = list => Object.values(L.foldAi(L.emptyState(), { run: '0001', key: 'k', findings: list.map(f => foldFinding(f, scene(f.viewport))), seen: [], now: Date.UTC(2026, 9, 15) }).items)[0];
  assert.deepEqual([fold([phone, desk]).verification.by, fold([desk, phone]).verification.by], [SAME_MODEL, SAME_MODEL]);
  assert.equal(fold([desk]).verification.by, CROSS_VENDOR, 'every finding cross-vendor: cross-vendor');
});

test('cli: verify --vendor is a declared name (whitespace collapsed; one with control characters refused), and says the claims it is no cross-vendor check of', () => {
  const p = huntProject();
  const run = (...a) => execFileSync('node', [CLI, ...a], { cwd: p.cwd, encoding: 'utf8' });
  const plan = JSON.parse(run('hunt', '--plan', '--lens', 'L9', '--json'));
  const u = plan.units.find(x => x.scenes[0].route === '/tasks');
  const defect = (scene, claim) => ({ 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene, selector: 'button#delete-all', claim, severity: 'high' }] } });
  writeFileSync(join(p.cwd, 'a.json'), JSON.stringify({ plan: plan.id, ...CLAUDE, units: [answerAll(u, 'none', defect('tasks.guest.normal.m', 'Deletes every task at once.'))] }));
  writeFileSync(join(p.cwd, 'b.json'), JSON.stringify({ plan: plan.id, ...CODEX, units: [answerAll(u, 'none', defect('tasks.guest.normal.d', 'No confirmation at all.'))] }));
  run('hunt', '--record', 'a.json');
  run('hunt', '--record', 'b.json');
  run('verify', '--plan');
  const key = readKey(p.runDir, 'verify-key.json');
  writeFileSync(join(p.cwd, 'v.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'high', reason: 'seen on the screen' }))));
  const bad = spawnSync('node', [CLI, 'verify', '--record', 'v.json', '--vendor', 'Open\u202eAI'], { cwd: p.cwd, encoding: 'utf8' });
  assert.deepEqual([bad.status, bad.stderr.trim()], [1, 'nunchi verify: --vendor must not hold control characters']);
  const out = run('verify', '--record', 'v.json', '--vendor', '  OpenAI  ');
  assert.match(out, /^verified by cross-vendor \(OpenAI, as declared\), a same-model check for the 1 claim\(s\) its own vendor hunted: confirmed 2 /);
  assert.equal(readKey(p.runDir, 'verify-key.json').recorded.vendor, 'OpenAI');
});

test('cross-vendor is never an approval: a confirmed AI finding stays open, to decide, until a person decides', () => {
  const { key } = plan();
  const r = recordVerdicts({ findings: FINDINGS, key, verdicts: confirmAll(key), vendor: 'OpenAI' });
  const scene = { id: SCENE, route: '/tasks', person: 'guest', state: 'normal', viewport: 'm', top: 't', full: 'f', textHash: 'x' };
  const st = L.foldAi(L.emptyState(), { run: '0001', key: 'k', findings: [foldFinding(r.findings[0], scene)], seen: [], now: Date.UTC(2026, 9, 15) });
  const item = Object.values(st.items)[0];
  assert.deepEqual([item.verification.status, item.verification.by, item.verification.vendor, item.agents], ['confirmed', CROSS_VENDOR, 'OpenAI', [CLAUDE]]);
  const rows = L.view(st, []);
  assert.deepEqual([rows[0].status, rows[0].decision, rows[0].checked], ['open', null, true], 'double-checked, and still the person\'s to decide');
  const s = summary({ state: st, rows, groups: L.groups(rows), stream: 'main', runsDir: '/nonexistent', git: null });
  assert.equal(s.toDecide, 1, 'counted to decide');
});
