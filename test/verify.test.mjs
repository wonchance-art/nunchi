// Verifier packets, decoys and verdicts (spec §4 H3, H7). Pure functions plus the CLI on a synthetic run.
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { planVerify, recordVerdicts, claimOf, decoyCount, decoysWanted, MIN_CONTROLS, DECOY_TEMPLATES, SAME_MODEL } from '../src/verify.mjs';
import { keyPath } from '../src/state.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// answer keys live in the user's state folder (design §2.2): a private one for these tests, inherited by the CLI
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'nunchi-verify-state-'));

// Synthetic scene evidence: controls.json rows as collect() writes them.
const ctl = (selector, name, extra = {}) => ({ selector, tag: 'button', role: null, name, hasText: true, text: name, box: [16, 100 + selector.length, 120, 44], href: null, inline: false, ...extra });
const CONTROLS = {
  'app~tasks.signed-in.normal.m': [
    ctl('main > button:nth-of-type(1)', 'Add task'), ctl('main > button:nth-of-type(2)', 'Save'), ctl('main > form > button', 'Save'),
    ctl('nav > a:nth-of-type(1)', 'Tasks', { tag: 'a', href: '/app/tasks' }), ctl('nav > a:nth-of-type(2)', 'Notes', { tag: 'a', href: '/app/notes' }),
    ctl('main > button:nth-of-type(3)', 'Clear all tasks'), ctl('main > div > button', '', { hasText: false, text: '', name: 'Close' }),
  ],
  'pricing.guest.normal.d': [ctl('header > a', 'Log in', { tag: 'a', href: '/login' }), ctl('main > a', 'Start free', { tag: 'a', href: '/login' }), ctl('main > button', 'Compare plans')],
};
const claim = (i, extra = {}) => ({
  source: 'ai', status: 'claimed', lens: ['L5', 'L6', 'L9'][i % 3], rule: ['L5.same-action-different-verb', 'L6.vague-error', 'L9.destructive-without-confirm'][i % 3],
  severity: 'medium', scene: i % 2 ? 'pricing.guest.normal.d' : 'app~tasks.signed-in.normal.m', route: i % 2 ? '/pricing' : '/app/tasks', viewport: i % 2 ? 'd' : 'm',
  selector: `main > p:nth-of-type(${i + 1})`, box: [16, 40 * i, 300, 24],
  // the shape hunt --record writes, plus reasoning a hunter might have slipped in
  evidence: { claim: `claimed text ${i}`, unit: `unit${i % 4}`, groundedIn: ['controls.json'], reasoning: `the hunter thought hard about ${i}` },
  rationale: 'hunter-only notes', ...extra,
});
const FINDINGS = [
  ...Array.from({ length: 8 }, (_, i) => claim(i)),
  { lens: 'L8', rule: 'axe-button-name', severity: 'medium', scene: 'app~tasks.signed-in.normal.m', selector: 'main > div > button', box: [0, 0, 44, 44], evidence: {}, source: 'rule' },
  claim(8, { scene: 'app~tasks.signed-in.normal.m.canary-1' }),
  claim(9, { status: 'confirmed' }),
];
const plan = (findings = FINDINGS) => planVerify({ findings, canaryScenes: new Set(['app~tasks.signed-in.normal.m.canary-1']), controlsOf: s => CONTROLS[s] || null, filesOf: s => [`${s}/top.jpg`, `${s}/controls.json`] });

test('packets: claimed AI findings only, the claim and its evidence without the hunter\'s reasoning', () => {
  const { packets, key } = plan();
  assert.equal(key.claims, 8, 'rule findings, canary scenes and already verified findings are not packets');
  assert.equal(key.decoys, decoysWanted(8));
  assert.equal(decoyCount(8), 2); assert.equal(decoyCount(1), 1); assert.equal(decoyCount(0), 0);
  // at least MIN_CONTROLS decoys for any claim (review of PR #29): one decoy passes a verifier that confirms at random half the time
  assert.deepEqual([MIN_CONTROLS, decoysWanted(8), decoysWanted(1), decoysWanted(0), decoysWanted(40)], [3, 3, 3, 0, 10]);
  assert.equal(packets.packets.length, 11);
  const text = JSON.stringify(packets);
  assert.ok(!/reasoning|rationale|hunter thought|hunter-only|decoy|canary/i.test(text), 'packets carry no reasoning and do not say which are decoys');
  for (const p of packets.packets) {
    assert.deepEqual(Object.keys(p).sort(), ['claim', 'files', 'packet']);
    assert.deepEqual(p.files, [`${p.claim.scene}/top.jpg`, `${p.claim.scene}/controls.json`]);
    assert.ok(p.claim.selector && p.claim.box, 'every claim names an element');
  }
  assert.deepEqual(claimOf(FINDINGS[0]).evidence, { claim: 'claimed text 0', groundedIn: ['controls.json'] }, 'no reasoning, no hunt unit');
  // the key maps each packet back to the finding it came from
  for (const [id, k] of Object.entries(key.packets)) if (!k.decoy) assert.equal(packets.packets.find(p => p.packet === id).claim.selector, FINDINGS[k.finding].selector);
});

test('decoys: false claims about fine elements of the same scenes, never on a claimed element; deterministic', () => {
  const a = plan(), b = plan();
  assert.deepEqual(a, b, 'same claims, same packets and key');
  const decoyIds = Object.entries(a.key.packets).filter(([, k]) => k.decoy).map(([id]) => id);
  assert.equal(decoyIds.length, 3);
  const claimed = new Set(FINDINGS.map(f => `${f.scene}|${f.selector}`));
  for (const id of decoyIds) {
    const c = a.packets.packets.find(p => p.packet === id).claim;
    const row = CONTROLS[c.scene].find(x => x.selector === c.selector);
    assert.ok(row, 'built from the scene\'s own evidence');
    assert.ok(!claimed.has(`${c.scene}|${c.selector}`));
    const t = DECOY_TEMPLATES.find(x => x.rule === c.rule);
    assert.ok(t, c.rule);
    if (t.id === 'destructive') assert.doesNotMatch(row.name, /clear|delete|close/i, 'a destructive-action decoy is never on a destructive control');
    if (t.id === 'unclear-label') assert.ok(row.name.length > 0, 'an unclear-label decoy names a labelled control');
    if (t.id === 'verb-mismatch') { const q = c.evidence.claim.match(/“[^”]*”/g); assert.equal(q[0], q[1], 'the two "different" words are the same word'); }
    // a decoy looks like a real claim: same keys, same grounding, a checklist id of its lens
    assert.deepEqual(Object.keys(c.evidence).sort(), Object.keys(claimOf(FINDINGS[0]).evidence).sort());
    assert.ok(c.rule.startsWith(c.lens + '.'));
  }
  // shuffled: decoys are not all at the end
  const order = Object.values(a.key.packets).map(k => k.decoy);
  assert.notDeepEqual(order, [...order].sort((x, y) => x - y));
  // a different claim set gives a different plan
  assert.notDeepEqual(plan(FINDINGS.slice(1)).key.seed, a.key.seed);
  // no scene evidence → no decoys can be built, and none are made up
  const bare = planVerify({ findings: FINDINGS });
  assert.equal(bare.key.decoys, 0);
});

test('decoys: when the claimed scenes run out of fine elements, any other captured scene of the run gives them (never a canary copy, never a claimed element); deterministic', () => {
  // one claim, on a scene whose only control is the claimed one
  const one = [claim(0, { scene: 'login.guest.normal.d', route: '/login', viewport: 'd', selector: 'main > button' })];
  const controls = {
    'login.guest.normal.d': [ctl('main > button', 'Sign in')],
    ...CONTROLS,
    'app~tasks.signed-in.normal.m.canary-1': [ctl('main > a', 'Open the planted copy', { tag: 'a' })],
  };
  const scenes = [{ id: 'login.guest.normal.d', route: '/login', viewport: 'd' }, { id: 'app~tasks.signed-in.normal.m', route: '/app/tasks', viewport: 'm' },
    { id: 'pricing.guest.normal.d', route: '/pricing', viewport: 'd' }, { id: 'app~tasks.signed-in.normal.m.canary-1', route: '/app/tasks', viewport: 'm' }];
  const args = { findings: one, controlsOf: s => controls[s] || null, scenes, canaryScenes: new Set(['app~tasks.signed-in.normal.m.canary-1']) };
  const a = planVerify(args);
  assert.deepEqual([a.key.decoys, a.key.decoysPlanned], [3, 3], 'three decoys for one claim');
  const made = Object.entries(a.key.packets).filter(([, k]) => k.decoy).map(([id]) => a.packets.packets.find(p => p.packet === id).claim);
  for (const c of made) {
    assert.notEqual(c.scene, 'app~tasks.signed-in.normal.m.canary-1', 'never on a canary copy');
    assert.ok(!(c.scene === 'login.guest.normal.d' && c.selector === 'main > button'), 'never on the claimed element');
    const s = scenes.find(x => x.id === c.scene);
    assert.deepEqual([c.route, c.viewport], [s.route, s.viewport], 'the route and viewport of the scene it is on');
    assert.ok(controls[c.scene].some(x => x.selector === c.selector), 'built from that scene\'s own evidence');
  }
  assert.deepEqual(planVerify(args), a, 'deterministic');
  // without the run's other scenes (the old pool), the claimed scene alone offers none: fewer than planned, suspect
  assert.deepEqual([planVerify({ ...args, scenes: [] }).key.decoys, planVerify({ ...args, scenes: [] }).key.decoysPlanned], [0, 3]);
});

const verdictsFor = (key, decoyVerdict, n = Infinity) => {
  let left = n;
  return Object.entries(key.packets).map(([packet, k]) => ({
    packet, verdict: k.decoy ? (left-- > 0 ? decoyVerdict : 'rejected') : 'confirmed', severity: k.decoy ? undefined : 'high', reason: 'matches the evidence',
  }));
};

test('verdicts: written back to the findings; corrected severity; same-model check by default', () => {
  const { key } = plan();
  const r = recordVerdicts({ findings: FINDINGS, key, verdicts: verdictsFor(key, 'rejected') });
  assert.deepEqual(r.problems, []);
  const verified = r.findings.filter(f => f.verification);
  assert.equal(verified.length, 8);
  for (const f of verified) {
    assert.equal(f.status, 'confirmed');
    assert.equal(f.severity, 'high');
    assert.equal(f.verification.claimedSeverity, 'medium');
    assert.equal(f.verification.verifier, SAME_MODEL);
    assert.equal(f.verification.suspect, undefined);
  }
  assert.equal(r.findings[8].verification, undefined, 'rule findings skip the verifier');
  assert.equal(FINDINGS[0].status, 'claimed', 'input untouched');
  assert.deepEqual(r.verify.verifier, { label: SAME_MODEL });
  assert.equal(r.verify.suspect, false);
  assert.deepEqual(r.verify.decoys, { total: 3, answered: 3, passedThrough: 0, rate: 0 });
  assert.equal(r.verify.complete, true);
  const x = recordVerdicts({ findings: FINDINGS, key, verdicts: { verdicts: verdictsFor(key, 'rejected') }, vendor: 'other-vendor' });
  assert.deepEqual(x.verify.verifier, { label: 'cross-vendor', vendor: 'other-vendor' });
  // rejected and insufficient keep the claimed severity
  const real = Object.entries(key.packets).find(([, k]) => !k.decoy)[0];
  const y = recordVerdicts({ findings: FINDINGS, key, verdicts: [{ packet: real, verdict: 'rejected', severity: 'low', reason: 'the button has a label' }] });
  const f = y.findings[key.packets[real].finding];
  assert.equal(f.status, 'rejected'); assert.equal(f.severity, 'medium'); assert.equal(f.verification.severity, 'low');
  assert.equal(y.verify.complete, false);
  assert.equal(y.verify.suspect, true, 'no decoy answered: the check cannot be trusted');
});

test('decoy pass-through above 10% marks the run\'s verifications suspect', () => {
  // 40 claims → 10 decoys, so one passed decoy is exactly 10% (not suspect) and two are 20% (suspect)
  const findings = Array.from({ length: 40 }, (_, i) => claim(i, { selector: `main > li:nth-of-type(${i + 1})` }));
  const controls = Object.fromEntries(Object.entries(CONTROLS).map(([s, rows]) => [s, [...rows, ...Array.from({ length: 12 }, (_, j) => ctl(`main > ul > li:nth-of-type(${j + 1}) > button`, `Open item ${j + 1}`))]]));
  const { key } = planVerify({ findings, controlsOf: s => controls[s] });
  assert.equal(key.decoys, 10);
  const one = recordVerdicts({ findings, key, verdicts: verdictsFor(key, 'confirmed', 1) });
  assert.equal(one.verify.decoys.rate, 0.1); assert.equal(one.verify.suspect, false);
  const two = recordVerdicts({ findings, key, verdicts: verdictsFor(key, 'confirmed', 2) });
  assert.equal(two.verify.decoys.passedThrough, 2); assert.equal(two.verify.suspect, true);
  assert.match(two.verify.suspectReason, /2\/10 > 10%/);
  assert.ok(two.findings.every(f => f.verification.suspect === true));
  const insufficient = recordVerdicts({ findings, key, verdicts: verdictsFor(key, 'insufficient', 10) });
  assert.equal(insufficient.verify.suspect, false, '"insufficient" on a decoy is not a pass-through');
  // a decoy left unanswered counts as passed through: skipping the hard ones does not make a verifier look careful
  const decoyIds = Object.keys(key.packets).filter(id => key.packets[id].decoy);
  const skip = n => verdictsFor(key, 'rejected').filter(v => !decoyIds.slice(0, n).includes(v.packet));
  const oneLeft = recordVerdicts({ findings, key, verdicts: skip(1) });
  assert.deepEqual([oneLeft.verify.decoys.answered, oneLeft.verify.decoys.passedThrough, oneLeft.verify.suspect], [9, 1, false]);
  const twoLeft = recordVerdicts({ findings, key, verdicts: skip(2) });
  assert.deepEqual([twoLeft.verify.decoys.passedThrough, twoLeft.verify.suspect], [2, true]);
  assert.match(twoLeft.verify.suspectReason, /decoy pass-through 2\/10 > 10%/);
});

test('bad verdicts are refused and nothing is recorded', () => {
  const { key } = plan();
  const ids = Object.keys(key.packets);
  const bad = recordVerdicts({ findings: FINDINGS, key, verdicts: [
    { packet: 'p999', verdict: 'confirmed', reason: 'x' },
    { packet: ids[0], verdict: 'yes', reason: 'x' },
    { packet: ids[1], verdict: 'confirmed', severity: 'urgent', reason: 'x' },
    { packet: ids[2], verdict: 'confirmed', reason: 'line one\nline two' },
    { packet: ids[3], verdict: 'confirmed', reason: 'ok' }, { packet: ids[3], verdict: 'rejected', reason: 'ok' },
  ] });
  assert.equal(bad.findings, undefined);
  assert.equal(bad.problems.length, 5, bad.problems.join('\n'));
  const changed = FINDINGS.map(f => ({ ...f, selector: f.selector + ' > span' }));
  const real = ids.find(id => !key.packets[id].decoy);
  assert.match(recordVerdicts({ findings: changed, key, verdicts: [{ packet: real, verdict: 'confirmed', reason: 'ok' }] }).problems[0], /changed since the plan/);
});

test('CLI verify --plan / --record on a run folder', () => {
  const work = mkdtempSync(join(tmpdir(), 'nunchi-verify-'));
  const run = join(work, '.nunchi', 'runs', '0003');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(work, '.nunchi', 'runs', 'latest'), '0003\n');
  const scenes = [...Object.keys(CONTROLS).map(id => ({ id })), { id: 'app~tasks.signed-in.normal.m.canary-1', canary: 1, of: 'app~tasks.signed-in.normal.m' }];
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ schema: 1, scenes }));
  for (const [s, rows] of Object.entries(CONTROLS)) { mkdirSync(join(run, s)); writeFileSync(join(run, s, 'controls.json'), JSON.stringify(rows)); writeFileSync(join(run, s, 'top.jpg'), 'x'); }
  const cli = args => execFileSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => cli(['verify', '--plan']), /ai-findings\.json does not exist/);
  // the hunter names a scene outside the run: never opened
  writeFileSync(join(run, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [...FINDINGS, claim(11, { scene: '../../outside' })] }));
  assert.match(cli(['verify', '--plan']), /12 packets → .*verify-packets\.json/);
  const packets = JSON.parse(readFileSync(join(run, 'verify-packets.json'), 'utf8'));
  // the answer key is kept outside the project (design §2.2), owner-only
  assert.ok(!existsSync(join(run, 'verify-key.json')), 'no answer key inside the project');
  const key = JSON.parse(readFileSync(keyPath(run, 'verify-key.json'), 'utf8'));
  assert.equal(key.claims, 9); assert.equal(key.decoys, 3);
  assert.deepEqual(packets.packets.find(p => p.claim.scene === '../../outside').files, []);
  assert.deepEqual(packets.packets.find(p => p.claim.scene === 'pricing.guest.normal.d').files, ['pricing.guest.normal.d/top.jpg', 'pricing.guest.normal.d/controls.json']);
  assert.equal(cli(['verify', '--plan', '--json', '--run', '0003']), readFileSync(join(run, 'verify-packets.json'), 'utf8'), 'deterministic, and --json prints the packets only');
  const verdicts = join(work, 'verdicts.json');
  writeFileSync(verdicts, JSON.stringify(verdictsFor(key, 'confirmed')));
  const out = cli(['verify', '--record', verdicts]);
  assert.match(out, /verified by same-model check: confirmed 9 · rejected 0 · insufficient 0/);
  assert.match(out, /decoys passed through: 3\/3/);
  assert.match(out, /SUSPECT/);
  const v = JSON.parse(readFileSync(join(run, 'verify.json'), 'utf8'));
  assert.equal(v.suspect, true);
  const saved = JSON.parse(readFileSync(join(run, 'ai-findings.json'), 'utf8'));
  assert.equal(saved.schema, 1, 'the file keeps its shape');
  assert.equal(saved.findings.filter(f => f.status === 'confirmed' && f.verification).length, 9);
  // a plan made again now has nothing left to verify
  assert.match(cli(['verify', '--plan']), /no claimed AI findings to verify/);
  writeFileSync(verdicts, JSON.stringify([{ packet: 'p001', verdict: 'maybe', reason: 'x' }]));
  assert.throws(() => cli(['verify', '--record', verdicts]), /verdict must be/);
  assert.ok(existsSync(keyPath(run, 'verify-key.json')), 'a refused record keeps the key');
});
