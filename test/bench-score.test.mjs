import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../bench/score.mjs';

const manifest = { scenes: [
  { id: 'pricing.guest.normal.m', route: '/pricing', person: 'guest', state: 'normal', status: 'captured' },
  { id: 'tasks.signed-in.error.m', route: '/tasks', person: 'signed-in', state: 'error', status: 'captured' },
  { id: 'tasks.guest.error.m', route: '/tasks', person: 'guest', state: 'error', status: 'captured' },
  { id: 'about.guest.normal.m', route: '/about', person: 'guest', state: 'normal', status: 'captured' },
] };
const answers = { clean: ['/about'], defects: [
  { id: 'A', lens: 'L1', rule: 'horizontal-overflow', route: '/pricing', person: 'guest', state: 'normal', viewport: 'm' },
  { id: 'B', lens: 'L6', rule: 'raw-error-text', route: '/tasks', person: 'signed-in', state: 'error' },
  { id: 'C', lens: 'L9', rule: 'secret-in-client-bundle', route: null, evidence: { kind: 'aws-access-key-id' } },
  { id: 'D', lens: 'L4', rule: null, route: '/pricing' },
] };
const f = (scene, rule, route, extra = {}) => ({ scene, rule, route, viewport: scene ? scene.split('.').pop() : null, ...extra });

test('score: matches on rule, route, person, state, viewport and evidence', () => {
  const r = score(answers, manifest, [
    f('pricing.guest.normal.m', 'horizontal-overflow', '/pricing'),
    f('tasks.guest.error.m', 'raw-error-text', '/tasks'),                       // wrong person: does not count for B
    f(null, 'secret-in-client-bundle', null, { evidence: { kind: 'stripe-live-secret-key' } }), // wrong kind for C
    f('about.guest.normal.m', 'dead-href', '/about'),                            // clean page: false positive
  ]);
  assert.equal(r.ruleRecall.found, 1);
  assert.equal(r.ruleRecall.seeded, 3);
  assert.deepEqual(r.missed.map(m => m.id), ['B', 'C']);
  assert.equal(r.cleanFalsePositives.findings, 1);
  assert.equal(r.cleanFalsePositives.scenes, 1);
  assert.equal(r.pendingLenses, 1);
  assert.deepEqual(r.notInAnswerKey.map(x => x.finding).sort(), ['raw-error-text /tasks', 'secret-in-client-bundle']);
});
