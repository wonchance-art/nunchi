// Regression tests for the ledger and state-write defects D1–D6 (design 0.1-c §0): each failed on the code
// before M1a. Namespace imports, so a function that did not exist yet fails its own test, not the whole file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, linkSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as S from '../src/stable.mjs';
import { windowsIo } from './fixtures/windows-io.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const LEDGER = pathToFileURL(fileURLToPath(new URL('../src/ledger.mjs', import.meta.url))).href;
const STABLE = pathToFileURL(fileURLToPath(new URL('../src/stable.mjs', import.meta.url))).href;
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
const empty = () => ({ schema: 1, runs: [], items: {} });
const slug = route => route.slice(1).replace(/\//g, '~') || '~';
// a finding seen in one cell (person.state.viewport) of a route; `name` makes it its own defect
const fnd = (route, cell, name, extra = {}) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: route === null ? null : `${slug(route)}.${cell}`, route, viewport: cell ? cell.split('.')[2] : null, selector: 'main > button', box: null, evidence: { name }, ...extra });
// a manifest scene entry as capture writes it
const sc = (route, cell, extra = {}) => { const [person, state, viewport] = cell.split('.'); return { id: `${slug(route)}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200, ...extra }; };
const cells = (routes, persons, states, viewports) => routes.flatMap(r => persons.flatMap(p => states.flatMap(s => viewports.map(v => sc(r, `${p}.${s}.${v}`)))));
const fold = (st, id, { routes = ['/tasks'], persons = ['guest'], states = ['normal'], viewports = ['m'], wholeApp = true, scenes, health, changedSince = null }, findings) =>
  L.foldRun(st, { id, scope: { routes, persons, states, viewports, changedSince }, wholeApp, health: health || { status: 'ok', problems: [] }, scenes: scenes || cells(routes, persons, states, viewports), findings: L.annotate(findings) });
const item = (st, name) => Object.values(st.items).find(i => i.evidence?.name === name || i.rule === name);

// ---- D1: like-for-like coverage --------------------------------------------------------------------------

test('D1: a run with --states normal does not fix error-state findings', () => {
  let st = fold(empty(), '0001', { states: ['normal', 'error'] }, [fnd('/tasks', 'guest.error.m', 'in-error'), fnd('/tasks', 'guest.normal.m', 'in-normal')]);
  st = fold(st, '0002', { states: ['normal'] }, []);
  assert.equal(item(st, 'in-normal').goneAt, '0002', 'looked at again and absent: fixed');
  assert.equal(item(st, 'in-error').goneAt, null, 'the error state was not captured: unknown, still open');
  st = fold(st, '0003', { states: ['normal', 'error'] }, []);
  assert.equal(item(st, 'in-error').goneAt, '0003');
});

test('D1: a run with --viewports m does not fix desktop-only or phone/desktop parity findings', () => {
  const parity = fnd('/tasks', 'guest.normal.m', 'Export', { lens: 'L10', rule: 'missing-on-phone' });
  let st = fold(empty(), '0001', { viewports: ['m', 'd'] }, [fnd('/tasks', 'guest.normal.d', 'desktop-only'), fnd('/tasks', 'guest.normal.m', 'phone'), parity]);
  st = fold(st, '0002', { viewports: ['m'] }, []);
  assert.equal(item(st, 'phone').goneAt, '0002');
  assert.equal(item(st, 'desktop-only').goneAt, null, 'the desktop was not captured');
  assert.equal(item(st, 'missing-on-phone').goneAt, null, 'parity needs the desktop too');
  st = fold(st, '0003', { viewports: ['m', 'd'] }, []);
  assert.deepEqual([item(st, 'desktop-only').goneAt, item(st, 'missing-on-phone').goneAt], ['0003', '0003']);
});

test('D1: a failed, redirected, error-page or canary scene is not looked at', () => {
  const routes = ['/a', '/b', '/c', '/d', '/e'];
  let st = fold(empty(), '0001', { routes }, routes.map(r => fnd(r, 'guest.normal.m', r)));
  const scenes = [
    sc('/a', 'guest.normal.m', { status: 'capture-failed', reason: 'no-dom' }),
    sc('/b', 'guest.normal.m', { reason: 'redirected to /login', finalPath: '/login' }),
    sc('/c', 'guest.normal.m', { httpStatus: 500 }),
    sc('/d', 'guest.normal.m'),
    sc('/e', 'guest.normal.m', { id: 'canary-1', canary: 'clip', of: 'e.guest.normal.m' }),
  ];
  st = fold(st, '0002', { routes, scenes }, []);
  assert.deepEqual(routes.map(r => [r, item(st, r).goneAt]), [['/a', null], ['/b', null], ['/c', null], ['/d', '0002'], ['/e', null]]);
});

test('D1: --routes and --changed-since do not fix whole-app findings (secrets, the link graph, one-offs)', () => {
  const routes = ['/a', '/b'];
  const whole = [
    { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/app.js', kind: 'stripe-live-secret-key' } },
    { lens: 'L3', rule: 'unreachable-route', severity: 'low', scene: null, route: '/orphan', viewport: null, selector: null, box: null, evidence: {} },
    fnd('/a', 'guest.normal.m', 'dead link', { lens: 'L3', rule: 'link-to-missing-route', severity: 'high', evidence: { href: '/gone' } }),
    fnd('/a', 'guest.normal.m', 'odd h2', { lens: 'L4', rule: 'one-off-heading-size', severity: 'low', evidence: { what: 'h2 size', value: '31px' } }),
  ];
  let st = fold(empty(), '0001', { routes }, [...whole, fnd('/a', 'guest.normal.m', 'small')]);
  st = fold(st, '0002', { routes: ['/a'], wholeApp: false }, []);
  assert.equal(item(st, 'small').goneAt, '0002', 'a per-screen finding on a route the run looked at');
  for (const r of ['secret-in-client-bundle', 'unreachable-route', 'link-to-missing-route', 'one-off-heading-size']) assert.equal(item(st, r).goneAt, null, `${r}: a --routes run did not judge the whole app`);
  st = fold(st, '0003', { routes, wholeApp: false, changedSince: 'HEAD' }, []);
  for (const r of ['secret-in-client-bundle', 'unreachable-route', 'link-to-missing-route', 'one-off-heading-size']) assert.equal(item(st, r).goneAt, null, `${r}: nor did --changed-since`);
  st = fold(st, '0004', { routes }, []);
  for (const r of ['secret-in-client-bundle', 'unreachable-route', 'link-to-missing-route', 'one-off-heading-size']) assert.equal(item(st, r).goneAt, '0004', `${r}: a whole-app run did`);
});

test('D1: a whole-app run without the signed-in person does not fix a secret first seen with it', () => {
  const secret = { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/app.js', kind: 'jwt-service-role' } };
  let st = fold(empty(), '0001', { persons: ['guest', 'signed-in'] }, [secret]);
  st = fold(st, '0002', { persons: ['guest'] }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, null, 'the signed-in bundles were not loaded');
  st = fold(st, '0003', { persons: ['guest', 'signed-in'] }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, '0003');
});

test('D1: a stale recording fixes nothing; a state comparison needs both states; an expired login fixes no signed-in cell', () => {
  const pair = fnd('/tasks', 'guest.error.m', 'same text', { lens: 'L2', rule: 'error-looks-empty', selector: 'main' });
  let st = fold(empty(), '0001', { states: ['normal', 'empty', 'error'] }, [pair, fnd('/tasks', 'guest.normal.m', 'n'), fnd('/tasks', 'signed-in.normal.m', 'si')]);
  st = fold(st, '0002', { states: ['normal', 'empty', 'error'], health: { status: 'recording-stale', problems: [{ status: 'recording-stale', scenes: 3, of: 3 }] } }, []);
  assert.deepEqual([item(st, 'n').goneAt, item(st, 'error-looks-empty').goneAt], [null, null], 'screens without their data show nothing');
  st = fold(st, '0003', { states: ['normal', 'error'] }, []);
  assert.equal(item(st, 'n').goneAt, '0003');
  assert.equal(item(st, 'error-looks-empty').goneAt, null, 'the empty state it was compared with was not captured');
  const scenes = [sc('/tasks', 'guest.normal.m'), sc('/tasks', 'signed-in.normal.m', { status: 'not-seen', reason: 'login-expired' })];
  st = fold(st, '0004', { persons: ['guest', 'signed-in'], scenes, health: { status: 'login-expired', problems: [{ status: 'login-expired', scenes: 2, of: 2 }] } }, []);
  assert.equal(item(st, 'si').goneAt, null);
});

// ---- D2: monotonic folds and catch-up --------------------------------------------------------------------

test('D2: an older run folded after a newer one never sets goneAt, moves lastSeen back or brings back what a newer run found gone', () => {
  const routes = ['/a', '/b'];
  let st = fold(empty(), '0001', { routes }, [fnd('/a', 'guest.normal.m', 'x'), fnd('/b', 'guest.normal.m', 'y')]);
  st = fold(st, '0003', { routes }, [fnd('/b', 'guest.normal.m', 'y')]);
  assert.equal(item(st, 'x').goneAt, '0003');
  st = fold(st, '0002', { routes }, [fnd('/a', 'guest.normal.m', 'x')]);            // a run a crash left unfolded
  assert.equal(item(st, 'x').goneAt, '0003', 'still gone: the newer run looked and it was not there');
  assert.equal(item(st, 'x').regressedAt, null);
  assert.equal(item(st, 'y').goneAt, null, 'an older run never says something is gone');
  assert.equal(item(st, 'y').lastSeen, '0003', 'lastSeen never moves back');
  assert.deepEqual(st.runs, ['0001', '0002', '0003']);
  // an older run that saw an item first: firstSeen moves earlier, lastSeen stays
  st = fold(st, '0005', { routes }, [fnd('/a', 'guest.normal.m', 'z'), fnd('/b', 'guest.normal.m', 'y')]);
  st = fold(st, '0004', { routes }, [fnd('/a', 'guest.normal.m', 'z')]);
  assert.deepEqual([item(st, 'z').firstSeen, item(st, 'z').lastSeen, item(st, 'z').goneAt], ['0004', '0005', null]);
  assert.equal(item(st, 'y').goneAt, null);
});

const fakeRun = (cwd, id, { routes = ['/tasks'], persons = ['guest'], states = ['normal'], viewports = ['m'], wholeApp = true, scenes, findings = [] } = {}) => {
  const dir = join(cwd, '.nunchi', 'runs', id);
  const health = { status: 'ok', problems: [] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, scope: { routes, persons, states, viewports, changedSince: null }, wholeApp, health }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, health, scenes: scenes || cells(routes, persons, states, viewports) }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: L.annotate(findings) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
};

test('D2: catch-up folds every complete run not folded yet, in run order (9999 before 10000)', () => {
  const cwd = tmp('nunchi-catchup-');
  fakeRun(cwd, '9999', { findings: [fnd('/tasks', 'guest.normal.m', 'x')] });
  fakeRun(cwd, '10000', { findings: [] });
  mkdirSync(join(cwd, '.nunchi', 'runs', '10001.partial'));                  // still running: not complete, not folded
  const file = join(cwd, '.nunchi', 'state', 'ledger.json');
  const st = L.syncLedger(file, join(cwd, '.nunchi', 'runs'));
  assert.deepEqual(st.runs, ['9999', '10000']);
  assert.equal(item(st, 'x').goneAt, '10000', 'folded oldest first: seen, then gone');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), st);
  const before = readFileSync(file);
  L.syncLedger(file, join(cwd, '.nunchi', 'runs'));
  assert.ok(readFileSync(file).equals(before), 'nothing new: nothing written');
});

// ---- D3: no complete run is left unfolded ----------------------------------------------------------------

const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

test('D3: a complete run the ledger never saw (a crash after the run finished) is folded by the next command', async () => {
  const cwd = tmp('nunchi-unfolded-');
  fakeRun(cwd, '0001', { findings: [fnd('/tasks', 'guest.normal.m', 'x')] });
  const one = await cli(cwd, 'findings', '--json');
  assert.equal(one.code, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).run, '0001');
  assert.equal(JSON.parse(one.stdout).groups.length, 1);
  fakeRun(cwd, '0002', { findings: [] });
  const two = await cli(cwd, 'findings', '--all', '--json');
  assert.equal(two.code, 0, two.stderr);
  assert.deepEqual([JSON.parse(two.stdout).run, JSON.parse(two.stdout).groups[0].status], ['0002', 'fixed']);
});

// ---- D4: provenance ----------------------------------------------------------------------------------

const SECRET = { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/app.js', kind: 'stripe-live-secret-key' } };
const ledgerWith = (cwd, findings) => {
  const st = L.foldRun(empty(), { id: '0001', scope: {}, findings: L.annotate(findings) });
  mkdirSync(join(cwd, '.nunchi', 'state'), { recursive: true });
  writeFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), S.stableJson(st));
  return st;
};
const plant = (cwd, d) => {
  const folder = join(cwd, '.nunchi', 'decisions', d.target.fp ? `fp-${d.target.fp}` : `group-${d.target.group}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${d.id}.json`), S.stableJson(d));
};
const statusOf = async (cwd, group) => { const r = await cli(cwd, 'findings', '--all', '--json'); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout).groups.find(g => g.group === group).status; };

test('D4: a committed decision that reuses an approved id with other content does not dismiss a blocker', async () => {
  const cwd = tmp('nunchi-forge-');
  const st = ledgerWith(cwd, [SECRET, fnd('/tasks', 'guest.normal.m', 'small')]);
  const secret = item(st, 'secret-in-client-bundle'), small = item(st, 'small');
  const made = await cli(cwd, 'decide', small.group, 'fix', '--json');
  assert.equal(made.code, 0, made.stderr);
  const mine = JSON.parse(made.stdout)[0];
  plant(cwd, { ...mine, target: { fp: secret.fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'someone else' });
  assert.equal(await statusOf(cwd, secret.group), 'open', 'the approval was for the other decision, not for this id');
  assert.equal(await statusOf(cwd, small.group), 'to-fix');
});

test('D4: a decision dated in the future does not outrank later decisions, and cannot dismiss a blocker even approved', async () => {
  const cwd = tmp('nunchi-future-');
  const st = ledgerWith(cwd, [SECRET, fnd('/tasks', 'guest.normal.m', 'small')]);
  const secret = item(st, 'secret-in-client-bundle'), small = item(st, 'small');
  const future = { schema: 1, reason: 'not-a-problem', note: null, by: 'someone else', at: '2099-01-01T00:00:00.000+09:00', fingerprintVersion: 1, decision: 'false-positive' };
  plant(cwd, { ...future, id: 'zz-000001', target: { group: small.group } });
  const made = await cli(cwd, 'decide', small.group, 'fix');
  assert.equal(made.code, 0, made.stderr);
  assert.equal(await statusOf(cwd, small.group), 'to-fix', 'the decision made now wins over one dated 2099');
  plant(cwd, { ...future, id: 'zz-000002', target: { fp: secret.fp } });
  const ok = await cli(cwd, 'approve', '--all');
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(await statusOf(cwd, secret.group), 'open');
  const rows = JSON.parse((await cli(cwd, 'findings', '--all', '--json')).stdout).groups.find(g => g.group === secret.group);
  assert.match(rows.example.note, /ahead of when it arrived/);
});

test('D4: approvals from before content binding are carried over to the one decision with that id; an id two files share binds to neither', async () => {
  const SECRET2 = { ...SECRET, evidence: { url: '/vendor.js', kind: 'jwt-service-role' } };
  const legacy = (cwd, secret) => {
    plant(cwd, { schema: 1, id: 'lr-legacy1', target: { fp: secret.fp }, decision: 'fix', reason: null, note: null, by: 'me', at: '2026-10-13T10:00:00.000+09:00', fingerprintVersion: 1 });
    writeFileSync(join(cwd, '.nunchi', 'state', 'approved.json'), JSON.stringify({ schema: 1, approved: ['lr-legacy1'] }));
  };
  const copy = (cwd, secret) => plant(cwd, { schema: 1, id: 'lr-legacy1', target: { fp: secret.fp }, decision: 'false-positive', reason: 'not-a-problem', note: null, by: 'someone else', at: '2026-10-14T10:00:00.000+09:00', fingerprintVersion: 1 });
  const verified = async (cwd, group) => JSON.parse((await cli(cwd, 'findings', '--all', '--json')).stdout).groups.find(g => g.group === group).example.decision?.verified;
  // bound on first read; a copy that turns up later is not approved
  let cwd = tmp('nunchi-legacy-');
  const st = ledgerWith(cwd, [SECRET, SECRET2]);
  const one = Object.values(st.items).find(i => i.evidence.kind === 'stripe-live-secret-key'), two = Object.values(st.items).find(i => i.evidence.kind === 'jwt-service-role');
  legacy(cwd, one);
  assert.equal(await verified(cwd, one.group), true, 'the approval made before the upgrade still counts');
  assert.match(readFileSync(join(cwd, '.nunchi', 'state', 'approved.json'), 'utf8'), /"lr-legacy1:[0-9a-f]{64}"/);
  copy(cwd, two);
  assert.equal(await statusOf(cwd, two.group), 'open', 'the approval names the first file\'s content, not the id');
  // both files there before the first read: neither is approved, and approve asks which one
  cwd = tmp('nunchi-legacy2-');
  ledgerWith(cwd, [SECRET, SECRET2]);
  legacy(cwd, one); copy(cwd, two);
  assert.deepEqual([await verified(cwd, one.group), await statusOf(cwd, two.group)], [false, 'open']);
  const r = await cli(cwd, 'approve', 'lr-legacy1');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /2 decision files share the id lr-legacy1/);
});

// ---- D5: approvals are never wiped -----------------------------------------------------------------------

test('D5: an approval list that cannot be read stops the write instead of being replaced by an empty one', async () => {
  const cwd = tmp('nunchi-torn-approved-');
  const st = ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'small')]);
  const file = join(cwd, '.nunchi', 'state', 'approved.json');
  const torn = '{"approved": ["lr1-abc:0123456789abcdef", "lr2-def:fedcba98';
  writeFileSync(file, torn);
  const r = await cli(cwd, 'decide', item(st, 'small').group, 'fix');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /approved\.json/);
  assert.equal(readFileSync(file, 'utf8'), torn, 'left as it was');
  assert.ok(!existsSync(join(cwd, '.nunchi', 'decisions')), 'and no decision was written without its approval');
  assert.throws(() => L.readApproved(file), { code: 'CORRUPT' });
});

test('D5: approvals written by several processes at once are all kept', async () => {
  const dir = tmp('nunchi-approve-race-');
  const file = join(dir, 'approved.json');
  const child = `import { addApproved } from ${JSON.stringify(LEDGER)};
const [file, who, n, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
for (let i = 0; i < Number(n); i++) addApproved(file, [who + '-' + i + ':0123456789abcdef']);`;
  const at = Date.now() + 1500, n = 20, procs = ['p0', 'p1', 'p2', 'p3'];
  const results = await Promise.all(procs.map(who => new Promise(res => execFile('node', ['--input-type=module', '-e', child, file, who, String(n), String(at)], (err, stdout, stderr) => res({ err, stderr })))));
  for (const r of results) assert.equal(r.err, null, r.stderr);
  assert.equal(L.readApproved(file).size, procs.length * n, 'none lost');
  assert.deepEqual(readdirSync(dir).sort(), ['approved.json'], 'no lock or temp file left behind');
});

// Fairness, measured as overtakes: for each acquisition, how many acquisitions by the other waiters came between its
// request being in line and its turn. With N waiters each holding one request at a time, a fair lock lets each be
// overtaken at most N − 1 times, however busy the machine; an unfair one lets the same process take it back again and
// again. → the largest per waiter. `acq`: [{ who, asked, got, made, renewed }] (times on one clock); `from`: the time
// counted from, 'line' (inLine) or 'asked'.
// Counted from the ticket, not from asking: no lock can order a request before the process has made it. Under load the
// process that has just held the lock for 80 ms of CPU is the one the machine sets aside next, right after it read the
// clock (up to 490 ms seen, 2026-10-15 KST), and a process that asked after it but reached the lock first was rightly
// first: 4 overtakes counted from asking, in 3 of 12 runs on a loaded core, from a lock that served every ticket in order.
const overtakes = (acq, from = 'line') => {
  const got = acq.map(a => a.got).sort((x, y) => x - y);
  const worst = {};
  for (const a of acq) {
    const start = from === 'line' ? inLine(a) : a[from];
    const between = acq.filter(b => b.who !== a.who && b.got > start && b.got < a.got).length;
    worst[a.who] = Math.max(worst[a.who] ?? 0, between);
  }
  return { worst: Object.keys(worst).sort().map(k => worst[k]), first: got[0], last: got.at(-1) };
};
// When a request was in line: from its ticket (`made`, written at its first try that finds the lock taken), or, after a
// gap of more than a second between its renewals (`renewed`; the others no longer count a ticket not renewed for
// TICKET_STALE_MS, 1 s, less 10 ms for the coarser time a new file gets), from the renewal or the take that ended the
// gap. A request that took the lock at its first try made no ticket and was passed by no one.
const STALE_GAP = 1000 - 10;
const inLine = a => {
  if (a.made === null || a.made === undefined) return a.got;
  let line = a.made, last = a.made;
  for (const t of [...a.renewed, a.got]) { if (t - last > STALE_GAP) line = t; last = t; }
  return line;
};

test('D5: the lock is fair: a process that releases and takes it again at once does not starve the others (each is overtaken at most once by each other waiter)', async () => {
  // 4 processes × 15 holds of 80 ms. Unfair (before): one process took the lock back on every release while the others
  // backed off to 100 ms polls and found it free only by luck (waits of 2–3 s here, over the 5 s limit (LOCKED) on a
  // slow Windows runner). Fair: the longest waiter's ticket goes first.
  // Each process sees when its request is in line through the lock's io: the lock writes and renews its ticket there.
  const dir = tmp('nunchi-lock-fair-');
  const file = join(dir, 'x.json');
  const child = `import { withLock, io } from ${JSON.stringify(STABLE)};
const [file, at, who] = process.argv.slice(1);
const clock = () => performance.timeOrigin + performance.now();
let req = null;
const { writeFile, touch } = io;
const ticket = p => req && p.includes('.lock.d.wait-');
io.writeFile = (p, data) => { writeFile(p, data); if (ticket(p)) req.made ??= clock(); };
io.touch = (p, t) => { touch(p, t); if (ticket(p)) req.renewed.push(clock()); };
while (Date.now() < Number(at)) {}
const acq = [];
for (let i = 0; i < 15; i++) {
  req = { who, asked: clock(), made: null, renewed: [] };
  withLock(file, () => { req.got = clock(); acq.push(req); req = null; const s = Date.now(); while (Date.now() - s < 80) {} });
}
console.log(JSON.stringify(acq));`;
  const at = Date.now() + 1500;
  const out = await Promise.all(['p0', 'p1', 'p2', 'p3'].map(who => new Promise(res => execFile('node', ['--input-type=module', '-e', child, file, String(at), who], (err, stdout, stderr) => { let acq = []; try { acq = JSON.parse(stdout); } catch {} res({ err, stderr, acq }); }))));
  for (const r of out) assert.equal(r.err, null, r.stderr);
  const acq = out.flatMap(r => r.acq);
  assert.ok(acq.filter(a => a.made !== null).length >= 30, 'the waiters were in line (tickets seen through io)');
  const o = overtakes(acq);
  assert.ok(o.worst.every(n => n <= 3), `overtaken at most (per process, from in line): ${o.worst.join(', ')}; a fair lock: at most 3 (from asking: ${overtakes(acq, 'asked').worst.join(', ')})`);
  assert.ok(o.last - o.first < 30e3, 'every waiter got the lock within 30 s');
  assert.deepEqual(readdirSync(dir), [], 'no lock, ticket or temp file left behind');
});

test('D5: the lock stays fair under Windows\' file rules (a file open elsewhere cannot be renamed over or deleted at once, a folder with an open file cannot be renamed), here on any machine', async () => {
  // In one process with Windows' rules on stable.mjs's io (test/fixtures/windows-io.mjs): 4 waiters × 12 holds of
  // 40 ms through withLockAsync, with this machine's own rules and with Windows'. A single place for the next waiter,
  // renamed over and deleted (the first fair lock), lost turns under Windows' rules; tickets, made once and never
  // renamed, keep the order.
  const run = async rules => {
    const w = rules ? windowsIo(S.io) : null;
    const dir = tmp('nunchi-lock-win-');
    const file = join(dir, 'x.json');
    const acq = [];
    const waiter = async who => {
      for (let i = 0; i < 12; i++) {
        const asked = performance.now();
        await S.withLockAsync(file, async () => { acq.push({ who, asked, got: performance.now() }); await new Promise(r => setTimeout(r, 40)); });
      }
    };
    try {
      await Promise.all(['w0', 'w1', 'w2', 'w3'].map(waiter));
      // counted from asking: in one process a waiter's first try runs in the same turn as asking, so nothing runs between
      return { ...overtakes(acq, 'asked'), stats: w?.stats, left: readdirSync(dir) };
    } finally { w?.restore(); }
  };
  for (const rules of [false, true]) {
    const r = await run(rules);
    const where = rules ? `Windows' rules (met: ${JSON.stringify(r.stats)})` : "this machine's rules";
    assert.ok(r.worst.every(n => n <= 3), `${where}: overtaken at most (per waiter): ${r.worst.join(', ')}; a fair lock: at most 3`);
    assert.ok(r.last - r.first < 30e3, 'every waiter got the lock within 30 s');
    assert.deepEqual(r.left, [], 'no lock, ticket or temp file left behind');
    if (rules) assert.ok(r.stats.renameFolderWithOpen + r.stats.deletePending > 0, `Windows' rules were met: ${JSON.stringify(r.stats)}`);
  }
});

// The interleaving behind the 4 overtakes seen under load (follow-ups, 2026-10-15 KST), replayed one step at a time
// through the lock's own steps, so it does not depend on how busy the machine is. Times are steps (one tick each).
test('D5: fairness is counted from when a waiter is in line: a waiter is in line at its first try, and one set aside between asking and that try is rightly passed by one that asked later but reached the lock first', () => {
  const I = S.lockInternals, opts = { timeoutMs: 5000, staleMs: 30000 };
  const dir = tmp('nunchi-lock-replay-');
  const file = join(dir, 'x.json');
  let tick = 0, last = 0;
  const acq = [], order = [], wait = {}, held = {};
  const asks = who => { wait[who] = { r: { who, asked: ++tick, made: null, renewed: [] } }; };
  const step = who => {
    const w = wait[who];
    if (!I.tryLock(w.l, opts)) { if (w.l.ticket && w.r.made === null) w.r.made = ++tick; return false; }
    w.r.got = ++tick; acq.push(w.r); order.push(who); held[who] = I.heldLock(w.l); delete wait[who];
    return true;
  };
  // its first try, a later millisecond than the request before it (the lock orders requests by millisecond)
  const reaches = who => { while (Date.now() <= last) { /* < 1 ms */ } wait[who].l = I.prepareLock(file); last = wait[who].l.t0; return step(who); };
  const releases = who => { held[who].release(); delete held[who]; };
  // every waiter that has reached the lock tries once; exactly one takes it
  const turn = () => { const took = Object.keys(wait).sort().filter(w => wait[w].l && step(w)); assert.equal(took.length, 1, `one taker: ${took}`); return took[0]; };

  asks('p0'); assert.equal(reaches('p0'), true, 'p0 takes the free lock');
  for (const who of ['p1', 'p2', 'p3']) {
    asks(who);
    assert.equal(reaches(who), false);
    assert.ok(wait[who].l.ticket, `${who} finds it taken and is in line at once (it was not, for its first 20 ms)`);
  }
  releases('p0'); asks('p0');                       // p0 asks again, and the machine sets it aside before its first try
  assert.equal(turn(), 'p1');
  releases('p1'); asks('p1');
  assert.equal(reaches('p1'), false, 'p1 asks again after p0 but reaches the lock first: in line behind p2 and p3');
  assert.equal(turn(), 'p2');
  assert.equal(reaches('p0'), false, 'p0 comes back: in line behind p1');
  for (const who of ['p3', 'p1', 'p0']) { releases(order.at(-1)); assert.equal(turn(), who); }
  releases('p0');
  assert.deepEqual(order, ['p0', 'p1', 'p2', 'p3', 'p1', 'p0'], 'served in the order the requests reached the lock');
  assert.deepEqual(overtakes(acq, 'asked').worst, [4, 2, 1, 2], 'counted from asking, p0 was overtaken 4 times (by p1 twice)');
  assert.deepEqual(overtakes(acq).worst, [2, 2, 1, 2], 'counted from when it was in line, twice (by p3 and p1): at most 3 for each');
  assert.deepEqual(readdirSync(dir), [], 'no lock, ticket or temp file left behind');
});

test('D5: a waiter that has not run for a second is passed until it runs again, and is then first again (one stopped waiter does not hold up the others)', () => {
  const I = S.lockInternals, opts = { timeoutMs: 5000, staleMs: 30000 };
  const dir = tmp('nunchi-lock-stopped-');
  const file = join(dir, 'x.json');
  const asks = after => { while (Date.now() <= after) { /* < 1 ms: a later request */ } return I.prepareLock(file); };
  const x = I.prepareLock(file);
  assert.equal(I.tryLock(x, opts), true);
  const hx = I.heldLock(x);
  const w = asks(x.t0), y = asks(w.t0);
  assert.equal(I.tryLock(w, opts), false);
  assert.equal(I.tryLock(y, opts), false);
  assert.ok(w.ticket && y.ticket, 'W, then Y, in line');
  // W stops (Ctrl-Z, or a machine that sets it aside): for 2 s none of its steps runs, so it renews nothing
  const ago = new Date(Date.now() - 2000);
  utimesSync(join(dir, w.ticket), ago, ago);
  w.renewed -= 2000;
  hx.release();
  assert.equal(I.tryLock(y, opts), true, 'Y takes the lock while W does not run');
  const hy = I.heldLock(y);
  assert.equal(I.tryLock(w, opts), false, 'W runs again: held by Y, it renews its ticket');
  hy.release();
  const y2 = asks(w.t0);
  assert.equal(I.tryLock(y2, opts), false, 'Y asks again and waits behind W, whose ticket kept its place');
  assert.equal(I.tryLock(w, opts), true, 'W is first again');
  I.heldLock(w).release();
  assert.equal(I.tryLock(y2, opts), true);
  I.heldLock(y2).release();
  assert.deepEqual(readdirSync(dir), [], 'no lock, ticket or temp file left behind');
});

test('D5: the lock: a dead holder is taken over, a live one is waited for and then refused, an untouched one goes stale', async () => {
  const dir = tmp('nunchi-lock-');
  const file = join(dir, 'approved.json');
  // a process that dies while holding the lock
  await new Promise((res, rej) => execFile('node', ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(STABLE)}; withLock(${JSON.stringify(file)}, () => process.exit(0));`], e => (e ? rej(e) : res())));
  assert.ok(existsSync(`${file}.lock.d`), 'left behind by the dead holder');
  assert.equal(S.withLock(file, () => 'took over'), 'took over');
  assert.ok(!existsSync(`${file}.lock.d`));
  // held by a live process (this one): another taker waits, then fails with LOCKED
  S.withLock(file, () => assert.throws(() => S.withLock(file, () => {}, { timeoutMs: 150 }), { code: 'LOCKED' }));
  // held from another machine: only age tells; fresh is refused, untouched for 30 s is stale
  mkdirSync(`${file}.lock.d`);
  writeFileSync(join(`${file}.lock.d`, 'owner.json'), JSON.stringify({ token: 'far', pid: 1, host: `not-${hostname()}`, boot: null, ns: null, start: null, at: 0 }));
  assert.throws(() => S.withLock(file, () => {}, { timeoutMs: 100 }), { code: 'LOCKED' });
  const old = new Date(Date.now() - 60e3);
  utimesSync(join(`${file}.lock.d`, 'owner.json'), old, old);
  assert.equal(S.withLock(file, () => 'stale'), 'stale');
  assert.deepEqual(readdirSync(dir), []);
});

// ---- D6: atomic writes; torn files are reported ----------------------------------------------------------

test('D6: run files are replaced by rename, never rewritten in place', () => {
  const dir = tmp('nunchi-atomic-');
  const target = join(dir, 'verify.json'), witness = join(dir, 'witness');
  writeFileSync(target, 'old\n');
  linkSync(target, witness);                      // same file: an in-place write would show through the link
  S.writeStable(target, { verdicts: [1, 2, 3] });
  assert.equal(readFileSync(witness, 'utf8'), 'old\n', 'the old file was not written over');
  assert.equal(readFileSync(target, 'utf8'), S.stableJson({ verdicts: [1, 2, 3] }));
  assert.deepEqual(readdirSync(dir).sort(), ['verify.json', 'witness'], 'no temp file left');
  // a write that fails leaves no temp file behind either
  mkdirSync(join(dir, 'busy.json', 'x'), { recursive: true });
  assert.throws(() => S.writeStable(join(dir, 'busy.json'), {}));
  assert.deepEqual(readdirSync(dir).sort(), ['busy.json', 'verify.json', 'witness']);
});

test('D6: decision files are written by rename and synced; their bytes are the stable record', () => {
  const dir = tmp('nunchi-dec-atomic-');
  const d = L.buildDecision({ target: { group: 'abc123abc123' }, decision: 'fix', by: 'me' });
  const file = join(dir, 'group-abc123abc123', `${d.id}.json`);
  mkdirSync(join(dir, 'group-abc123abc123'));
  writeFileSync(file, 'half a deci');
  linkSync(file, join(dir, 'witness'));
  L.saveDecision(dir, d);
  assert.equal(readFileSync(join(dir, 'witness'), 'utf8'), 'half a deci');
  assert.equal(readFileSync(file, 'utf8'), S.stableJson(d));
  assert.deepEqual(readdirSync(join(dir, 'group-abc123abc123')), [`${d.id}.json`]);
});

test('D6: a torn decision file is reported, never skipped', async () => {
  const cwd = tmp('nunchi-torn-dec-');
  const st = ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'small')]);
  const folder = join(cwd, '.nunchi', 'decisions', `group-${item(st, 'small').group}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'lr1-abcdef.json'), '{\n  "at": "2026-10-14T10:00:00.000+09:00",\n  "by": "me",\n  "deci');
  assert.throws(() => L.readDecisions(join(cwd, '.nunchi', 'decisions')), { code: 'CORRUPT' });
  const r = await cli(cwd, 'findings');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /lr1-abcdef\.json/);
  // a file whose name or folder does not match its record (copied or moved by hand) is reported too
  writeFileSync(join(folder, 'lr1-abcdef.json'), S.stableJson({ schema: 1, id: 'lr2-other', target: { group: item(st, 'small').group }, decision: 'fix', reason: null, note: null, by: 'me', at: '2026-10-14T10:00:00.000+09:00', fingerprintVersion: 1 }));
  assert.throws(() => L.readDecisions(join(cwd, '.nunchi', 'decisions')), { code: 'CORRUPT', message: /does not match its place/ });
});

test('D6: a complete run with a torn file is reported, never skipped by the fold', async () => {
  const cwd = tmp('nunchi-torn-run-');
  const dir = fakeRun(cwd, '0001', { findings: [fnd('/tasks', 'guest.normal.m', 'x')] });
  writeFileSync(join(dir, 'findings.json'), '{"schema": 1, "findings": [{"lens": "L8", "ru');
  const r = await cli(cwd, 'findings');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /findings\.json/);
  assert.ok(!existsSync(join(cwd, '.nunchi', 'state', 'ledger.json')), 'nothing written');
});
