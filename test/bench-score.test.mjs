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

test('scoreAi: lens, route, state, and a checklist id or a matching word; canary copies and rejected claims do not count', async () => {
  const { scoreAi } = await import('../bench/score.mjs');
  const m = { scenes: [
    { id: 'app.signed-in.error.m', route: '/app', person: 'signed-in', state: 'error' },
    { id: 'notes.signed-in.slow.m', route: '/notes', person: 'signed-in', state: 'slow' },
    { id: 'notes.signed-in.error.m', route: '/notes', person: 'signed-in', state: 'error' },
    { id: 'notes.signed-in.error.m.canary-1', route: '/notes', person: 'signed-in', state: 'error', canary: 1 },
    { id: 'about.guest.normal.m', route: '/about', person: 'guest', state: 'normal' },
  ] };
  const ans = { clean: ['/about'], defects: [
    { id: 'S1', lens: 'L6', rule: null, route: '/app', ai: { match: ['something went wrong'] } },
    { id: 'S2', lens: 'L2', rule: null, route: '/notes', ai: { states: ['slow'], rules: ['L2.no-loading-indicator'] } },
    { id: 'S3', lens: 'L9', rule: null, route: '/tasks', ai: { match: ['clear all'] } },
    { id: 'S4', lens: 'L5', rule: null, route: '/x' },                          // no hint: not scored
  ] };
  const c = (scene, lens, rule, claim, extra = {}) => ({ source: 'ai', status: 'claimed', scene, route: m.scenes.find(s => s.id === scene).route, lens, rule, selector: 'p', evidence: { claim }, ...extra });
  const r = scoreAi(ans, m, [
    c('app.signed-in.error.m', 'L6', 'L6.vague-error', 'It says "Something went wrong." and nothing else.'),
    c('notes.signed-in.error.m', 'L2', 'L2.no-loading-indicator', 'nothing shows'),               // wrong state
    c('notes.signed-in.error.m.canary-1', 'L2', 'L2.no-loading-indicator', 'x'),                  // a canary copy
    c('about.guest.normal.m', 'L7', 'L7.template-copy', 'Looks like template copy.'),
    { ...c('app.signed-in.error.m', 'L6', 'L6.vague-error', 'something went wrong'), status: 'rejected' },
  ]);
  assert.equal(r.seeded, 3); assert.equal(r.found, 1);
  assert.deepEqual(r.results.map(x => [x.id, x.found]), [['S1', true], ['S2', false], ['S3', false]]);
  assert.equal(r.results[0].hits.length, 1, 'the rejected claim is not a hit');
  assert.deepEqual(r.byLens, { L6: { seeded: 1, found: 1 }, L2: { seeded: 1, found: 0 }, L9: { seeded: 1, found: 0 } });
  assert.equal(r.cleanClaims.length, 1);
});
