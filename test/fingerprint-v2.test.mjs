// Secret findings (design 0.1-c §0 D8, §4.5): location and kind only, and fingerprint v2, whose secret
// fingerprint ignores the bundle's content hash. v1 state and decisions migrate instead of being orphaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { secretFindings, mask } from '../src/rules.mjs';
import * as ledger from '../src/ledger.mjs';
const { fingerprintOf, annotate, readState, view, approvalKey, FINGERPRINT_VERSION } = ledger;
// Approvals name a decision's content (approvalKey), and a decision counts once this machine has seen it: `now` is
// fixed after the decisions' dates. A moved v1 decision keeps the approval of the file as written.
const NOW = { now: Date.parse('2026-10-15T00:00:00+09:00') };
const approve = list => new Set(list.map(approvalKey));
const bundleKey = p => ledger.bundleKey(p);

const secret = (url, kind = 'stripe-live-secret-key', extra = {}) => ({ lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url, kind, ...extra } });

test('D8: a secret finding keeps its location and kind, and not one character of the value', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const stripe = 'sk_' + 'live_' + 'Q7w3E9r1T5y8U2i6O4p0A1s3';
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase' })}.${'k'.repeat(30)}`;
  const f = secretFindings([{ path: '/_next/static/chunks/1grrdrpshlkcw.js', body: `a="${stripe}";b="${jwt}"` }]);
  assert.deepEqual(f.map(x => x.evidence), [
    { url: '/_next/static/chunks/1grrdrpshlkcw.js', kind: 'stripe-live-secret-key' },
    { url: '/_next/static/chunks/1grrdrpshlkcw.js', kind: 'supabase-service-role-jwt' },
  ]);
  const out = JSON.stringify(annotate(f));
  // every 4 characters of the parts that are secret (the kind already says "sk_live_" and "a JWT")
  for (const value of [stripe.slice('sk_live_'.length), ...jwt.split('.').slice(1)]) {
    for (let i = 0; i + 4 <= value.length; i++) assert.ok(!out.includes(value.slice(i, i + 4)), `"${value.slice(i, i + 4)}" of a secret is in the finding`);
  }
  assert.ok(!out.includes('sk_l') && !out.includes('eyJ'), 'not even the prefix main kept');
  assert.equal(mask(stripe), '', 'mask keeps nothing');
});

test('fp v2: a rebuild that renames the bundle keeps the secret\'s fingerprint, whatever the bundler', () => {
  assert.equal(FINGERPRINT_VERSION, 2);
  const same = [
    ['/_next/static/chunks/1grrdrpshlkcw.js', '/_next/static/chunks/0x9pqk2mz7abc.js'],                         // Turbopack (Next 16)
    ['/_next/static/chunks/app/page-4f1c2a9b8e7d6c5b.js', '/_next/static/chunks/app/page-9e0d1c2b3a4f5e6d.js'],   // webpack
    ['/assets/index-DiwrgTda.js', '/assets/index-B_x-3aZq.js'],                                                     // Vite / Rollup
    ['/assets/index-4ed993c7.js', '/assets/index-a1b2c3d4.js'],                                                     // Vite 4
    ['/static/js/main.8f3e2a1b.js', '/static/js/main.0c9d8e7f.js'],                                                 // CRA, Parcel
    ['/build/_shared/chunk-ABCDEFGH.js', '/build/_shared/chunk-Q2W3E4R5.js'],                                       // esbuild
  ];
  for (const [a, b] of same) assert.equal(fingerprintOf(secret(a)).fp, fingerprintOf(secret(b)).fp, `${a} vs ${b}`);
  // what tells two bundles apart is kept: names, short words, words with a number, folders
  for (const [a, b] of [['/app.js', '/admin.js'], ['/assets/index-DiwrgTda.js', '/assets/settings-DiwrgTda.js'], ['/js/user-settings.js', '/js/user-profile.js'],
    ['/js/checkout2.js', '/js/payments2.js'], ['/js/facade.js', '/js/decade.js'],
    ['/a1b2c3d4e5/app.js', '/f6e5d4c3b2/app.js'], ['/_next/static/chunks/turbopack-08unf7310vpqi.js', '/_next/static/chunks/08unf7310vpqi.js']]) {
    assert.notEqual(fingerprintOf(secret(a)).fp, fingerprintOf(secret(b)).fp, `${a} vs ${b}`);
  }
  // the bench apps' real bundle names (Pebble: Next 16 + Turbopack; pegroom: Vite)
  const pebble = ['0cz1d0mv5g_q7', '0hf0csprl-qay', '1grrdrpshlkcw', '1gyiq9szzyd7y', '1jhkz7-phbjq2', '1zkag9d667vt5', '2bd9w9wjwxp4q', '2fceuzry3ehkj',
    '37_gtamvd34h5', '39d3h1v75a-x2', '3fjylfovv-ufb', '3gognr0kg886d', '3m97xjh6caoar', '3mjmeg-fol7d9', '3ulxh7l11ie-3'];
  for (const n of pebble) assert.equal(bundleKey(`/_next/static/chunks/${n}.js`), '/_next/static/chunks/[hash].js', n);
  assert.equal(bundleKey('/_next/static/chunks/2c7xnr69h5xvw.css'), '/_next/static/chunks/[hash].css');
  assert.equal(bundleKey('/_next/static/chunks/turbopack-08unf7310vpqi.js'), '/_next/static/chunks/turbopack-[hash].js');
  assert.equal(bundleKey('/assets/index-Boalzs1w.js'), '/assets/index-[hash].js');
  assert.equal(bundleKey('/assets/index-w0w4_8WA.css'), '/assets/index-[hash].css');
  assert.equal(bundleKey('/_next/static/chunks/app/tasks/%5Bid%5D/page-4f1c2a9b8e7d6c5b.js'), '/_next/static/chunks/app/tasks/%5Bid%5D/page-[hash].js');
  assert.notEqual(fingerprintOf(secret('/app.js')).fp, fingerprintOf(secret('/app.js', 'github-token')).fp, 'another kind is another defect');
  assert.deepEqual(fingerprintOf(secret('/_next/static/chunks/1grrdrpshlkcw.js')).inputs.evidence, { kind: 'stripe-live-secret-key', url: '/_next/static/chunks/[hash].js' });
  // v1 still computes the old fingerprint (migration needs it): the content hash was part of it
  assert.notEqual(fingerprintOf(secret(same[0][0]), 1).fp, fingerprintOf(secret(same[0][1]), 1).fp);
});

test('fp v2 changed only the secret fingerprint: every other rule keeps its v1 fingerprint (pinned on main 3e29b26)', () => {
  const pinned = [
    [{ lens: 'L8', rule: 'target-size-min', severity: 'medium', route: '/tasks', selector: 'main > ul > li:nth-of-type(3) > button', evidence: { width: 18, height: 18, minimum: 24, name: 'Done' } }, 'a2949802c200', 'ec8830f1263c'],
    [{ lens: 'L8', rule: 'axe-color-contrast', route: '/a', selector: '.text-muted', evidence: { impact: 'serious', summary: 'Element has insufficient color contrast of 2.98 (foreground color: #647987, background color: #113145, font size: 7.5pt (10px)' } }, '62d4f7df72c9', 'e1a538e244cc'],
    [{ lens: 'L1', rule: 'failed-request', route: '/app', selector: null, evidence: { url: '/api/x-4f1c2a9b8e7d6c5b?y=1', status: 404, method: 'GET' } }, '786570564a07', 'b933ef940898'],
    [{ lens: 'L3', rule: 'unreachable-route', route: '/reports', selector: null, evidence: { note: 'no link' } }, '5e463e56aaa1', '1078d71b80e7'],
  ];
  for (const [f, fp, group] of pinned) {
    assert.deepEqual([fingerprintOf(f).fp, fingerprintOf(f).group], [fp, group], f.rule);
    assert.deepEqual([fingerprintOf(f, 1).fp, fingerprintOf(f, 1).group], [fp, group], `${f.rule} under v1`);
  }
  // v1 secret fingerprints, as main wrote them
  assert.equal(fingerprintOf(secret('/app.js', 'stripe-live-secret-key', { masked: 'sk_l…' }), 1).fp, '8dd9e485c8d7');
  assert.equal(fingerprintOf(secret('/_next/static/chunks/1grrdrpshlkcw.js', 'stripe-live-secret-key', { masked: 'sk_l…' }), 1).fp, '02bed3a3cb83');
});

// A ledger item as main's foldRun stored it (fingerprint v1), seen in run 0001 only.
const storedV1 = f => {
  const { fp, group, inputs } = fingerprintOf(f, 1);
  return { fp, group, lens: f.lens, rule: f.rule, severity: f.severity, route: f.route, persons: [], viewports: [], states: [], places: 0, examples: [],
    selector: f.selector, evidence: f.evidence, inputs, firstSeen: '0001', lastSeen: '0001', goneAt: null, regressedAt: null };
};

test('fp v2 migration: a v1 ledger is re-keyed on read, its v1 decisions keep applying after a rebuild, stored characters go', () => {
  const before = secret('/_next/static/chunks/1grrdrpshlkcw.js', 'stripe-live-secret-key', { masked: 'sk_l…' });
  // the same secret after an earlier build, under its old chunk name: one defect in v2, so the two items merge
  const older = { ...storedV1(secret('/_next/static/chunks/7hq2kd0xw9zre.js', 'stripe-live-secret-key', { masked: 'sk_l…' })), lastSeen: '0001', firstSeen: '0001' };
  const target = { lens: 'L8', rule: 'target-size-min', severity: 'medium', route: '/tasks', selector: 'main > button', evidence: { width: 18, height: 18, minimum: 24, name: 'Done' } };
  const items = [storedV1(before), older, storedV1(target)];
  const file = join(mkdtempSync(join(tmpdir(), 'nunchi-fp2-')), 'ledger.json');
  writeFileSync(file, JSON.stringify({ schema: 1, fingerprintVersion: 1, runs: ['0001'], items: Object.fromEntries(items.map(i => [i.fp, i])) }));
  // Decisions made under v1: the secret dismissed (approved on this machine), the tap target kept as a group.
  const decisions = [
    { schema: 1, id: 'd1', target: { fp: items[0].fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'me', at: '2026-10-14T10:00:00.000+09:00', fingerprintVersion: 1 },
    { schema: 1, id: 'd2', target: { group: items[2].group }, decision: 'keep', reason: 'intended', by: 'me', at: '2026-10-14T10:01:00.000+09:00', fingerprintVersion: 1 },
  ];
  const approved = approve(decisions);

  const st = readState(file);
  assert.equal(st.fingerprintVersion, 2);
  const secrets = Object.values(st.items).filter(i => i.rule === 'secret-in-client-bundle');
  assert.deepEqual(secrets.map(i => i.fp), [fingerprintOf(before).fp], 're-keyed under v2; the two chunk names are one defect');
  assert.equal(st.items[secrets[0].fp].evidence.masked, undefined, 'the four characters v1 stored are gone');
  assert.ok(!JSON.stringify(st).includes('sk_l'));
  assert.ok(st.items[items[2].fp], 'other rules keep their fingerprint');
  assert.deepEqual(st.aliases.fp, { [items[0].fp]: secrets[0].fp, [older.fp]: secrets[0].fp });

  // The next build renames the chunk again: same fingerprint, so the next fold updates this item.
  const after = secret('/_next/static/chunks/0x9pqk2mz7abc.js');
  assert.equal(annotate([after])[0].fp, secrets[0].fp);
  const rows = view(st, decisions, approved, NOW);
  assert.equal(rows.find(r => r.rule === 'secret-in-client-bundle').status, 'dismissed', 'the v1 decision still applies');
  assert.equal(rows.find(r => r.rule === 'secret-in-client-bundle').decision.verified, true, 'approved by the content of the file as written');
  assert.equal(rows.find(r => r.rule === 'target-size-min').status, 'kept');
  assert.equal(readState(file).fingerprintVersion, 2, 'reading migrates');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).fingerprintVersion, 1, 'a read alone writes nothing');
  // The next ledger command writes the migrated state back, under the lock, with no run to fold.
  const synced = ledger.syncLedger(file, join(dirname(file), 'runs'));
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.fingerprintVersion, 2);
  assert.deepEqual(Object.keys(onDisk.items).sort(), Object.keys(st.items).sort());
  assert.deepEqual(onDisk.aliases, st.aliases);
  assert.deepEqual(synced.aliases, st.aliases);
  assert.ok(!readFileSync(file, 'utf8').includes('sk_l'), 'the stored characters are gone from the file too');

  // A v1 decision from another machine, about the chunk this machine's (v2) state holds, applies too.
  const v2item = { ...storedV1(after), ...fingerprintOf(after) };
  const fresh = { schema: 1, fingerprintVersion: 2, runs: ['0001'], items: { [v2item.fp]: v2item } };
  const remote = [{ ...decisions[0], id: 'd3', target: { fp: fingerprintOf(after, 1).fp } }];
  assert.equal(view(fresh, remote, approve(remote), NOW)[0].status, 'dismissed');
  // Moved or not, a dismissal of a secret that this machine did not approve does not count.
  assert.equal(view(fresh, remote, new Set(), NOW)[0].status, 'open');
});

test('fp v2 migration: two secrets are never merged into one dismissal; merged items with conflicting decisions stay open', () => {
  const at = m => `2026-10-14T10:0${m}:00.000+09:00`;
  const dec = (id, target, decision, reason, m) => ({ schema: 1, id, target, decision, reason, by: 'me', at: at(m), fingerprintVersion: 1 });
  // Two different bundles (not a rebuild of one): a fix decided on one, a false positive on the other.
  const checkout = storedV1(secret('/js/checkout2.js')), payments = storedV1(secret('/js/payments2.js'));
  const file = join(mkdtempSync(join(tmpdir(), 'nunchi-fp2c-')), 'ledger.json');
  writeFileSync(file, JSON.stringify({ schema: 1, fingerprintVersion: 1, runs: ['0001'], items: { [checkout.fp]: checkout, [payments.fp]: payments } }));
  const decisions = [dec('d1', { fp: checkout.fp }, 'fix', null, 1), dec('d2', { fp: payments.fp }, 'false-positive', 'not-a-problem', 2)];
  const st = readState(file);
  assert.equal(Object.keys(st.items).length, 2, 'two bundles stay two items');
  const rows = view(st, decisions, approve(decisions), NOW);
  assert.deepEqual(rows.map(r => [r.evidence.url, r.status]).sort(), [['/js/checkout2.js', 'to-fix'], ['/js/payments2.js', 'dismissed']]);
  // Two builds of one bundle do merge; if their v1 decisions disagree, the merged item is not dismissed.
  const a = storedV1(secret('/assets/index-Ab12Cd34.js')), b = { ...storedV1(secret('/assets/index-Ef56Gh78.js')), lastSeen: '0002' };
  const file2 = join(mkdtempSync(join(tmpdir(), 'nunchi-fp2c-')), 'ledger.json');
  writeFileSync(file2, JSON.stringify({ schema: 1, fingerprintVersion: 1, runs: ['0001', '0002'], items: { [a.fp]: a, [b.fp]: b } }));
  const merged = readState(file2);
  assert.equal(Object.keys(merged.items).length, 1);
  const conflicting = [dec('d1', { fp: a.fp }, 'fix', null, 1), dec('d2', { fp: b.fp }, 'false-positive', 'not-a-problem', 2)];
  assert.equal(view(merged, conflicting, approve(conflicting), NOW)[0].status, 'to-fix', 'open beats dismissed');
  assert.equal(view(merged, conflicting.slice(1), approve(conflicting.slice(1)), NOW)[0].status, 'dismissed', 'one decision, no conflict: it carries over');
});

test('fp v2 migration: merging two builds of one bundle keeps what each sighting still needs (coverage, cells, open)', () => {
  const origin = 'http://127.0.0.1:1';
  const cell = (route, c) => `${route}|${c}`;
  // Seen in run 0001, whose screens included /b signed in; the rebuild seen in run 0002, which looked at guests only.
  const older = { ...storedV1(secret('/assets/index-Ab12Cd34.js')), origin, cells: [], coverage: 'cov-1', lookedAt: '0001' };
  const newer = { ...storedV1(secret('/assets/index-Ef56Gh78.js')), origin, cells: [], coverage: 'cov-2', firstSeen: '0002', lastSeen: '0002', lookedAt: '0002' };
  const v1 = {
    schema: 1, fingerprintVersion: 1, runs: ['0001', '0002'], seenRoutes: ['/a', '/b'], items: { [older.fp]: older, [newer.fp]: newer },
    coverage: { 'cov-1': [cell('/a', 'guest.normal.m'), cell('/b', 'signed-in.normal.m')], 'cov-2': [cell('/a', 'guest.normal.m'), cell('/b', 'guest.normal.m')] },
  };
  const st = ledger.migrateState(v1);
  const [item] = Object.values(st.items);
  assert.equal(Object.keys(st.items).length, 1);
  assert.deepEqual(st.coverage[item.coverage], [cell('/a', 'guest.normal.m'), cell('/b', 'guest.normal.m'), cell('/b', 'signed-in.normal.m')], 'the coverage of both sightings');
  assert.deepEqual(Object.keys(st.coverage), [item.coverage], 'only the sets an item names are kept');
  assert.equal(item.firstSeen, '0001');
  assert.equal(item.lookedAt, '0001', 'looked at when both were');
  // A whole-app run that looks at every route, guests only, has not looked where run 0001 saw the secret.
  const scenes = list => list.map(([route, c]) => { const [person, state, viewport] = c.split('.'); return { id: `${route.slice(1)}.${c}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200 }; });
  const run = (id, list) => ({ id, scope: { routes: ['/a', '/b'] }, wholeApp: true, origin, scenes: scenes(list), findings: [] });
  const everything = [['/a', 'guest.normal.m'], ['/b', 'guest.normal.m'], ['/b', 'signed-in.normal.m']];
  assert.equal(ledger.foldRun(st, run('0003', everything.slice(0, 2))).items[item.fp].goneAt, null, 'not fixed by a run that did not look at /b signed in');
  assert.equal(ledger.foldRun(st, run('0003', everything)).items[item.fp].goneAt, '0003', 'fixed once a run looked at everything both sightings were seen with');
  // One build's item fixed, the other's still open: the merged item is open.
  const fixedNewer = { ...v1, items: { [older.fp]: older, [newer.fp]: { ...newer, goneAt: '0002' } } };
  assert.equal(view(ledger.migrateState(fixedNewer), [], new Set(), NOW)[0].status, 'open', 'open beats fixed');
  const bothFixed = { ...v1, runs: ['0001', '0002', '0003'], items: { [older.fp]: { ...older, goneAt: '0003' }, [newer.fp]: { ...newer, goneAt: '0003' } } };
  assert.equal(view(ledger.migrateState(bothFixed), [], new Set(), NOW)[0].status, 'fixed');
  // A coverage set the state no longer holds stays named: no run can call the merged item fixed.
  const lost = ledger.migrateState({ ...v1, coverage: { 'cov-2': v1.coverage['cov-2'] } });
  const lostItem = Object.values(lost.items)[0];
  assert.equal(lostItem.coverage, 'cov-1');
  assert.equal(ledger.foldRun(lost, run('0003', everything)).items[lostItem.fp].goneAt, null);
});
