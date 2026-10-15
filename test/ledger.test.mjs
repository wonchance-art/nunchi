import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSelector, fingerprintOf, annotate, foldRun, view, groups, writeDecision, readDecisions, trust, approvalKey, buildDecision } from '../src/ledger.mjs';
import { tmp } from './fixtures/tmp.mjs';

const f = (route, extra = {}) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${route.slice(1) || '~'}.guest.normal.m`, route, viewport: 'm', selector: 'main > ul > li:nth-of-type(3) > button', box: [0, 0, 18, 18], evidence: { width: 18, height: 18, minimum: 24, name: 'Done' }, ...extra });
const empty = () => ({ schema: 1, runs: [], items: {} });
// a manifest scene entry, as capture writes it
const scene = (route, person = 'guest', state = 'normal', viewport = 'm', extra = {}) => ({ id: `${route.slice(1) || '~'}.${person}.${state}.${viewport}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200, ...extra });

test('selectors lose positions, framework ids and generated class names', () => {
  assert.equal(normalizeSelector('ul > li:nth-of-type(12) > a:nth-child(2)'), 'ul > li > a');
  assert.equal(normalizeSelector('button[aria-controls="radix-:r5:"]'), 'button[aria-controls="radix-:r:"]');
  assert.equal(normalizeSelector('.Button_primary__a1B2c.css-1x2y3z > span'), '.Button_primary > span');
  assert.equal(normalizeSelector('div[data-testid="row-12"]'), 'div[data-testid="row-#"]');
});

test('fingerprint: same defect on another viewport, state, person or row is the same; another route is the same group', () => {
  const a = fingerprintOf(f('/tasks'));
  assert.equal(fingerprintOf(f('/tasks', { scene: 'tasks.signed-in.error.d', viewport: 'd', selector: 'main > ul > li:nth-of-type(7) > button', evidence: { width: 17, height: 19, minimum: 24, name: 'Done' } })).fp, a.fp);
  const other = fingerprintOf(f('/notes'));
  assert.notEqual(other.fp, a.fp);
  assert.equal(other.group, a.group, 'the shared component is one group across routes');
  assert.notEqual(fingerprintOf(f('/tasks', { evidence: { name: 'Delete' } })).fp, a.fp, 'a different control is a different defect');
  const contrast = (sel, route) => fingerprintOf({ lens: 'L8', rule: 'axe-color-contrast', route, selector: sel, evidence: { impact: 'serious', summary: 'Element has insufficient color contrast of 2.98 (foreground color: #647987, background color: #113145, font size: 7.5pt (10px)' } });
  assert.equal(contrast('.text-muted', '/a').group, contrast('.nav-label > span', '/b').group, 'low contrast groups by its colour pair');
});

test('ledger state: new, gone where the run looked, back again; not gone where it did not look', () => {
  const scenes = routes => routes.map(r => scene(r));
  let st = foldRun(empty(), { id: '0001', scope: { routes: ['/tasks', '/notes'], persons: ['guest'] }, scenes: scenes(['/tasks', '/notes']), findings: annotate([f('/tasks'), f('/notes')]) });
  assert.deepEqual(Object.values(st.items).map(i => [i.route, i.firstSeen, i.goneAt]).sort(), [['/notes', '0001', null], ['/tasks', '0001', null]]);
  st = foldRun(st, { id: '0002', scope: { routes: ['/tasks'], persons: ['guest'], changedSince: 'HEAD' }, scenes: scenes(['/tasks']), findings: [] });
  const by = r => Object.values(st.items).find(i => i.route === r);
  assert.equal(by('/tasks').goneAt, '0002', 'captured and absent: fixed');
  assert.equal(by('/notes').goneAt, null, 'not captured this time: unknown, still open');
  st = foldRun(st, { id: '0003', scope: { routes: ['/tasks', '/notes'], persons: ['guest'] }, health: { problems: [{ status: 'app-unreachable' }] }, scenes: scenes(['/tasks', '/notes']), findings: [] });
  assert.equal(by('/notes').goneAt, null, 'an app that did not load fixes nothing');
  st = foldRun(st, { id: '0004', scope: { routes: ['/tasks', '/notes'], persons: ['guest'] }, scenes: scenes(['/tasks', '/notes']), findings: annotate([f('/tasks')]) });
  assert.equal(by('/tasks').regressedAt, '0004');
  assert.deepEqual(view(st, []).map(r => [r.route, r.status]).sort(), [['/notes', 'fixed'], ['/tasks', 'regressed']]);
  assert.deepEqual(foldRun(st, { id: '0004', scope: {}, findings: [] }), st, 'folding the same run twice changes nothing');
});

test('decisions: append-only files, latest wins, a group decision covers new screens, git-only dismissals cannot hide a blocker', () => {
  const dir = tmp('nunchi-dec-');
  const st = foldRun(empty(), { id: '0001', scope: {}, findings: annotate([f('/tasks'), f('/notes'), { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, selector: null, evidence: { url: '/app.js', kind: 'stripe-live-secret-key' } }]) });
  const [tasks] = Object.values(st.items).filter(i => i.route === '/tasks');
  const secret = Object.values(st.items).find(i => i.lens === 'L9');
  const keep = writeDecision(dir, { target: { group: tasks.group }, decision: 'keep', reason: 'intended', by: 'me' });
  assert.throws(() => writeDecision(dir, { target: { fp: tasks.fp }, decision: 'false-positive', by: 'me' }), /needs --reason/);
  const fix = writeDecision(dir, { target: { fp: tasks.fp }, decision: 'fix', by: 'me' });
  const git = writeDecision(dir, { target: { fp: secret.fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'someone else' });
  assert.equal(readdirSync(dir).length, 3, 'one folder per target, one file per decision: nothing to merge');
  const rows = view(st, readDecisions(dir), new Set([keep, fix].map(approvalKey)));
  const status = r => rows.find(x => x.fp === r.fp).status;
  assert.equal(status(tasks), 'to-fix', 'the later decision on the fingerprint wins over the group');
  assert.equal(rows.find(r => r.route === '/notes').status, 'kept', 'the group decision covers the other screen');
  assert.equal(status(secret), 'open');
  assert.match(rows.find(r => r.fp === secret.fp).note, /needs approval/);
  assert.equal(view(st, readDecisions(dir), new Set([keep, fix, git].map(approvalKey))).find(r => r.fp === secret.fp).status, 'dismissed', 'approved on this machine: honoured');
  assert.deepEqual(groups(rows).map(g => [g.rule, g.routes.length]), [['secret-in-client-bundle', 0], ['target-size-min', 2]]);
});

test('a decision note is scrubbed before it is clipped to 500 characters: no half of a key is left for no scanner to know', () => {
  const KEY = 'sk_' + 'live_' + 'FixtureOnly0000000000000003';
  for (const at of [480, 488, 495]) {
    const d = buildDecision({ target: { fp: 'aaaaaaaaaaaa' }, decision: 'fix', note: `${'x'.repeat(at)} ${KEY} and https://u:pw@x.invalid/?token=Hunter2Token`, by: 'me' });
    assert.ok(!d.note.includes('sk_' + 'live_') && !d.note.includes('FixtureOnly'), `at ${at}`);
    assert.ok([...d.note].length <= 500);
  }
  const d = buildDecision({ target: { fp: 'aaaaaaaaaaaa' }, decision: 'fix', note: `${KEY} https://u:pw@x.invalid/?token=Hunter2Token`, by: 'me' });
  assert.equal(d.note, '[secret-shaped: stripe-live-secret-key] https://x.invalid/?token=REDACTED');
  // clipped by code point: an emoji at the edge is kept whole or left out, never half
  const e = buildDecision({ target: { fp: 'aaaaaaaaaaaa' }, decision: 'fix', note: `${'x'.repeat(499)}\u{1F33F}\u{1F33F}`, by: 'me' });
  assert.equal(e.note, `${'x'.repeat(499)}\u{1F33F}`);
  assert.equal(e.note.isWellFormed(), true);
});

test('trust: precision from fix and false-positive decisions; intended keeps do not count against the lens', () => {
  const st = foldRun(empty(), { id: '0001', scope: {}, findings: annotate(['/a', '/b', '/c', '/d', '/e', '/f'].map(r => f(r, { evidence: { name: r } }))) });
  const items = Object.values(st.items);
  const dir = tmp('nunchi-tr-');
  items.slice(0, 2).forEach(i => writeDecision(dir, { target: { fp: i.fp }, decision: 'fix', by: 'me' }));
  items.slice(2, 5).forEach(i => writeDecision(dir, { target: { fp: i.fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'me' }));
  writeDecision(dir, { target: { fp: items[5].fp }, decision: 'keep', reason: 'intended', by: 'me' });
  const t = trust(view(st, readDecisions(dir)), readDecisions(dir));
  assert.deepEqual([t.L8.fix, t.L8.falsePositive, t.L8.precision, t.L8.suspect], [2, 3, 0.4, true]);
});
