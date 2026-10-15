// Cross-vendor verdicts (design 0.1-c §7, §9.7, M6): a verdict whose verifier's vendor differs from the vendor of the
// agents that claimed the finding is labelled cross-vendor; one of the same vendor is a same-model check; vendors are
// declared, and a cross-vendor confirmation approves nothing (0.1 never auto-approves). Packets never say who hunted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVerify, recordVerdicts, verdictsFromKey, claimOf, verifierOf, SAME_MODEL, CROSS_VENDOR } from '../src/verify.mjs';
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

test('cross-vendor: per claim, against the vendors of the agents that claimed it; a claim with no declared vendor keeps --vendor\'s meaning', () => {
  const { packets, key } = plan();
  assert.ok(!JSON.stringify(packets).includes('Codex') && !JSON.stringify(packets).includes('OpenAI'), 'a packet never says who hunted (a decoy has no hunter)');
  assert.equal(claimOf(FINDINGS[1]).agents, undefined);
  const r = recordVerdicts({ findings: FINDINGS, key, verdicts: confirmAll(key), vendor: 'openai' });
  assert.deepEqual(r.findings.map(f => [f.verification.verifier, f.verification.vendor]), [[CROSS_VENDOR, 'openai'], [SAME_MODEL, 'openai'], [SAME_MODEL, 'openai'], [CROSS_VENDOR, 'openai']],
    'Claude Code\'s claim is cross-vendor; Codex\'s, and the one both claimed, are checked by their own vendor; an undeclared hunter as before');
  assert.deepEqual(r.verify.verifier, { label: CROSS_VENDOR, vendor: 'openai', sameVendor: 2 });
  assert.deepEqual(recordVerdicts({ findings: FINDINGS, key, verdicts: confirmAll(key) }).verify.verifier, { label: SAME_MODEL }, 'no --vendor: a same-model check');
  const onlyCodex = FINDINGS.map(f => ({ ...f, agents: [CODEX] }));
  const k2 = planVerify({ findings: onlyCodex, canaryScenes: new Set(), controlsOf: s => CONTROLS[s] || null, filesOf: s => [`${s}/top.jpg`] }).key;
  assert.deepEqual(recordVerdicts({ findings: onlyCodex, key: k2, verdicts: confirmAll(k2), vendor: 'OpenAI' }).verify.verifier, { label: SAME_MODEL, vendor: 'OpenAI' }, 'its own vendor\'s claims only');
  assert.equal(verifierOf(FINDINGS[0], null), SAME_MODEL);
  // the ledger recomputes the label from the key's recorded vendor and the findings, never from the file's word
  const fromKey = verdictsFromKey(r.findings.map(f => ({ ...f, verification: { ...f.verification, verifier: CROSS_VENDOR } })), { ...key, recorded: { verdicts: confirmAll(key), vendor: 'openai' } });
  assert.deepEqual(fromKey.map(f => f.verification.verifier), [CROSS_VENDOR, SAME_MODEL, SAME_MODEL, CROSS_VENDOR]);
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
