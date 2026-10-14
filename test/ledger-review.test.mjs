// Regression tests for the adversarial review of the M1a ledger fixes (2026-10-14 KST): each failed on the code
// it reviewed (branch head 86ff694). Namespace imports, so a function that did not exist then fails its own test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync, realpathSync, renameSync, rmSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as S from '../src/stable.mjs';
import * as R from '../src/runs.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const url = p => pathToFileURL(fileURLToPath(new URL(p, import.meta.url))).href;
const LEDGER = url('../src/ledger.mjs'), STABLE = url('../src/stable.mjs'), RUNS = url('../src/runs.mjs');
const POSIX = process.platform !== 'win32';
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
const empty = () => ({ schema: 1, runs: [], items: {} });
const slug = route => route.slice(1).replace(/\//g, '~') || '~';
const fnd = (route, cell, name, extra = {}) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: route === null ? null : `${slug(route)}.${cell}`, route, viewport: cell ? cell.split('.')[2] : null, selector: 'main > button', box: null, evidence: { name }, ...extra });
const sc = (route, cell, extra = {}) => { const [person, state, viewport] = cell.split('.'); return { id: `${slug(route)}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200, textHash: `t-${route}-${cell}`, ...extra }; };
const cells = (routes, persons, states, viewports) => routes.flatMap(r => persons.flatMap(p => states.flatMap(s => viewports.map(v => sc(r, `${p}.${s}.${v}`)))));
const fold = (st, id, { routes = ['/tasks'], persons = ['guest'], states = ['normal'], viewports = ['m'], wholeApp = true, scenes, health, origin = null } = {}, findings = []) =>
  L.foldRun(st, { id, scope: { routes, persons, states, viewports, changedSince: null }, wholeApp, health: health || { status: 'ok', problems: [] }, scenes: scenes || cells(routes, persons, states, viewports), findings: L.annotate(findings), origin });
const item = (st, name) => Object.values(st.items).find(i => i.evidence?.name === name || i.rule === name);
const SECRET = { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/admin.js', kind: 'stripe-live-secret-key' } };
const run = (cmd, args, { cwd, timeout = 60000 } = {}) => new Promise(res => execFile('node', [...cmd, ...args.map(String)], { cwd, encoding: 'utf8', timeout }, (err, stdout, stderr) => res({ code: err ? (err.killed ? 'killed' : err.code) : 0, stdout, stderr })));
const cli = (cwd, args, opts = {}) => run([CLI], args, { cwd, ...opts });
const node = (code, args = [], opts = {}) => run(['--input-type=module', '-e', code], args, opts);
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
const fakeRun = (cwd, id, { routes = ['/tasks'], findings = [], torn = false } = {}) => {
  const dir = join(cwd, '.nunchi', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const scope = { routes, persons: ['guest'], states: ['normal'], viewports: ['m'], changedSince: null };
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, scope, wholeApp: true }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes: cells(routes, ['guest'], ['normal'], ['m']) }));
  writeFileSync(join(dir, 'findings.json'), torn ? '{"schema": 1, "findings": [' : JSON.stringify({ schema: 1, findings: L.annotate(findings) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
};

// ---- coverage (review 1, 2, 9, 13, 14) -------------------------------------------------------------------

test('review 1: a whole-app run that did not look at a screen the secret was seen with does not fix it', () => {
  const routes = ['/', '/admin'];
  let st = fold(empty(), '0001', { routes }, [SECRET]);
  // /admin answered 503: its bundle was never loaded
  const down = cells(routes, ['guest'], ['normal'], ['m']).map(s => (s.route === '/admin' ? { ...s, httpStatus: 503 } : s));
  st = fold(st, '0002', { routes, scenes: down }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, null, 'the screen whose bundle held it was not looked at');
  st = fold(st, '0003', { routes }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, '0003');
  // a route the app no longer has is not asked for
  st = fold(st, '0004', { routes }, [SECRET]);
  st = fold(st, '0005', { routes: ['/'] }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, '0005');
});

test('decision: a route seen before but not this time keeps whole-app items open; a route no run has seen (always broken, unresolved) does not', () => {
  const routes = ['/a', '/b', '/broken'];
  const run = down => cells(routes, ['guest'], ['normal'], ['m']).map(s => (down.includes(s.route) ? { ...s, httpStatus: 503 } : s));
  let st = fold(empty(), '0001', { routes, scenes: run(['/broken']) }, []);       // /broken answers 503 in every run
  st = fold(st, '0002', { routes, scenes: run(['/broken', '/b']) }, [SECRET]);     // seen while /b was down
  st = fold(st, '0003', { routes, scenes: run(['/broken', '/b']) }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, null, '/b was looked at before and not this time: the run is partial');
  st = fold(st, '0004', { routes, scenes: run(['/broken']) }, []);
  assert.equal(item(st, 'secret-in-client-bundle').goneAt, '0004', 'a route no run has looked at does not stop it');
  assert.deepEqual(st.seenRoutes, ['/a', '/b']);
});

test('review 2: a sighting by a narrower run keeps the cells it did not look at', () => {
  let st = fold(empty(), '0001', { viewports: ['m', 'd'] }, [fnd('/tasks', 'guest.normal.m', 'x'), fnd('/tasks', 'guest.normal.d', 'x')]);
  st = fold(st, '0002', { viewports: ['m'] }, [fnd('/tasks', 'guest.normal.m', 'x')]);
  assert.deepEqual(item(st, 'x').cells, ['guest.normal.d', 'guest.normal.m'], 'the desktop was not looked at: it stays');
  st = fold(st, '0003', { viewports: ['m'] }, []);
  assert.equal(item(st, 'x').goneAt, null, 'gone from the phone; the desktop was never looked at again');
  st = fold(st, '0004', { viewports: ['m', 'd'] }, []);
  assert.equal(item(st, 'x').goneAt, '0004');
});

test('review 9: a run at another address fixes nothing; a run whose screens all show one page fixes nothing', () => {
  const routes = Array.from({ length: 12 }, (_, i) => `/r${i}`);
  let st = fold(empty(), '0001', { routes, origin: 'http://127.0.0.1:3000' }, routes.map(r => fnd(r, 'guest.normal.m', r)));
  st = fold(st, '0002', { routes, origin: 'http://127.0.0.1:4000' }, []);
  assert.ok(routes.every(r => item(st, r).goneAt === null), 'another app, or another server');
  const generic = cells(routes, ['guest'], ['normal'], ['m']).map(s => ({ ...s, textHash: 'one-page' }));
  st = fold(st, '0003', { routes, origin: 'http://127.0.0.1:3000', scenes: generic }, []);
  assert.ok(routes.every(r => item(st, r).goneAt === null), 'every route answered with the same page');
  assert.equal(st.blind['0003'], 'one-page');
  st = fold(st, '0004', { routes, origin: 'http://127.0.0.1:3000' }, []);
  assert.ok(routes.every(r => item(st, r).goneAt === '0004'), 'the app itself, its screens looked at again');
});

test('review 13: an item no run has looked at again for 3 runs says so', () => {
  let st = fold(empty(), '0001', { viewports: ['m', 'd'] }, [fnd('/tasks', 'guest.normal.d', 'desk'), fnd('/tasks', 'guest.normal.m', 'phone')]);
  for (const id of ['0002', '0003', '0004']) st = fold(st, id, { viewports: ['m'] }, [fnd('/tasks', 'guest.normal.m', 'phone')]);
  const rows = L.view(st, []);
  assert.equal(rows.find(r => r.evidence.name === 'desk').notLookedAt, '0001');
  assert.equal(rows.find(r => r.evidence.name === 'phone').notLookedAt, null);
});

test('review 14: a late older run does not bring back an item a newer run looked at again', () => {
  let st = fold(empty(), '0001', {}, [fnd('/tasks', 'guest.normal.m', 'x')]);
  st = fold(st, '0002', {}, []);
  st = fold(st, '0004', {}, []);                                     // looked again: still gone
  st = fold(st, '0003', {}, [fnd('/tasks', 'guest.normal.m', 'x')]);   // a run a crash left unfolded
  assert.deepEqual([item(st, 'x').goneAt, item(st, 'x').regressedAt, item(st, 'x').lookedAt], ['0002', null, '0004']);
});

test('review 15: signed-in cells are not looked at when the login expired, even if a scene says captured', () => {
  let st = fold(empty(), '0001', { persons: ['guest', 'signed-in'] }, [fnd('/tasks', 'signed-in.normal.m', 'si')]);
  const health = { status: 'login-expired', problems: [{ status: 'login-expired', scenes: 2, of: 2 }] };
  st = fold(st, '0002', { persons: ['guest', 'signed-in'], health }, []);
  assert.equal(item(st, 'si').goneAt, null);
});

// ---- the lock (review 3, 4, 5) -----------------------------------------------------------------------------

test('review 3: many processes, most dying while they hold it, never hold the lock at once (slow: ~12 s)', async () => {
  const dir = tmp('nunchi-lock-stress-');
  const file = join(dir, 'ledger.json'), sentinel = join(dir, 'inside');
  const child = `import { withLock } from ${JSON.stringify(STABLE)};
import { openSync, closeSync, unlinkSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [file, sentinel, n, at, die] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
let bad = 0;
try {
  for (let i = 0; i < Number(n); i++) withLock(file, () => {
    let fd;
    try { fd = openSync(sentinel, 'wx'); } catch (e) { if (e.code !== 'EEXIST') throw e; bad++; return; }   // another process is inside
    closeSync(fd);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    unlinkSync(sentinel);
    if (die === '1') process.exit(0);                                  // dies holding it: the lock is left stale
  }, { timeoutMs: 60000 });
} catch (e) {
  // what this worker saw when it gave up: the holder named in the lock, and whether that process still runs
  let owner = null, holderAlive = null;
  try { owner = JSON.parse(readFileSync(join(file + '.lock.d', 'owner.json'), 'utf8')); } catch (r) { owner = 'unreadable: ' + r.code; }
  if (owner && owner.pid) { try { process.kill(owner.pid, 0); holderAlive = true; } catch (k) { holderAlive = k.code === 'EPERM'; } }
  let files = null;
  try { files = readdirSync(dirname(file)).sort(); } catch {}
  process.stderr.write(JSON.stringify({ worker: process.pid, die, error: e.code, message: String(e.message).split('\\n')[0], owner, holderAlive, files }));
  process.exit(1);
}
process.stdout.write(String(bad));`;
  // each death leaves a stale lock that every waiting process races to take over
  for (let batch = 0; batch < 2; batch++) {
    await node(`import { withLock } from ${JSON.stringify(STABLE)}; withLock(${JSON.stringify(file)}, () => process.exit(0));`);
    const at = Date.now() + 2500;
    const procs = [...Array.from({ length: 10 }, () => [8, 0]), ...Array.from({ length: 20 }, () => [1, 1])];
    const out = await Promise.all(procs.map(([n, die]) => node(child, [file, sentinel, n, at, die], { timeout: 120000 })));
    const failed = out.map((r, i) => ({ i, die: procs[i][1], code: r.code, stderr: r.stderr.slice(0, 2000) })).filter(r => r.code !== 0);
    let lockNow = null;
    try { lockNow = { files: readdirSync(dir).sort(), owner: readFileSync(join(`${file}.lock.d`, 'owner.json'), 'utf8') }; } catch (e) { lockNow = { files: readdirSync(dir).sort(), owner: e.code }; }
    assert.deepEqual(failed, [], `batch ${batch}: workers that failed, and the lock after the batch: ${JSON.stringify(lockNow)}`);
    assert.equal(out.reduce((s, r) => s + Number(r.stdout || 0), 0), 0, `batch ${batch}: two holders at once`);
  }
});

test('review 3 (Windows): a holder on this machine whose start time cannot be read goes stale by age too (its pid may be reused)', () => {
  const dir = tmp('nunchi-lock-win-');
  const file = join(dir, 'x.json'), lock = `${file}.lock.d`;
  S.withLock(file, () => {
    // as Windows writes it: no start time; this process is alive, as a reused pid would be
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ ...owner, start: null }));
    const old = new Date(Date.now() - 60e3);
    utimesSync(join(lock, 'owner.json'), old, old);
    assert.ok(S.lockInternals.staleOwner(lock, 30000, { posix: false }), 'Windows: untouched for 30 s, stale');
    assert.equal(S.lockInternals.staleOwner(lock, 30000, { posix: true }), null, 'POSIX: a live pid is the holder, whatever the age');
    const now = new Date();
    utimesSync(join(lock, 'owner.json'), now, now);
    assert.equal(S.lockInternals.staleOwner(lock, 30000, { posix: false }), null, 'Windows: recently touched, alive');
  });
});

test('Windows (CI 295e028): a lock release or a `latest` update refused while another process reads (EPERM) is retried; `latest` never fails a run', () => {
  const dir = tmp('nunchi-win-rename-');
  const saved = { rename: S.io.rename, posix: S.io.posix };
  const refuse = (match, times) => { let n = 0; S.io.rename = (a, b) => { if (match(a, b) && n < times) { n++; throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); } return saved.rename(a, b); }; return () => n; };
  S.io.posix = false;
  try {
    // a waiter reading owner.json keeps the holder's release from renaming the lock away, three times
    const file = join(dir, 'ledger.json');
    let refused = refuse(a => a.endsWith('.lock.d'), 3);
    S.withLock(file, () => {});
    assert.equal(refused(), 3);
    assert.ok(!existsSync(`${file}.lock.d`), 'released, not left for every other process to wait on');
    // two captures finishing at once: the `latest` pointer is replaced through refusals
    const runs = join(dir, 'runs');
    refused = refuse((a, b) => b.endsWith('latest'), 3);
    const r = R.startRun(runs);
    R.finishRun(runs, r.id);
    assert.equal(refused(), 3);
    assert.equal(readFileSync(join(runs, 'latest'), 'utf8'), `${r.id}\n`);
    // refused for good: the run is still complete, and latestRun still finds it
    refused = refuse((a, b) => b.endsWith('latest'), Infinity);
    const r2 = R.startRun(runs);
    assert.equal(R.finishRun(runs, r2.id), join(runs, r2.id));
    assert.equal(R.latestRun(runs), r.id, 'the pointer kept its last value');
    assert.deepEqual(R.listRuns(runs).complete, [r.id, r2.id]);
  } finally { Object.assign(S.io, saved); }
});

test('Windows renames: EPERM, EACCES and EBUSY are retried with backoff and then thrown; other errors at once', () => {
  let n = 0;
  const busy = code => () => { n++; if (n < 3) throw Object.assign(new Error(code), { code }); return 'done'; };
  assert.equal(S.retryBusy(busy('EPERM'), 5000, { posix: false }), 'done');
  n = 0; assert.equal(S.retryBusy(busy('EBUSY'), 5000, { posix: false }), 'done');
  n = 0; assert.throws(() => S.retryBusy(busy('EPERM'), 5000, { posix: true }), { code: 'EPERM' }, 'POSIX: not retried');
  n = 0; assert.throws(() => S.retryBusy(busy('ENOENT'), 5000, { posix: false }), { code: 'ENOENT' });
  const t0 = Date.now();
  assert.throws(() => S.retryBusy(() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, 100, { posix: false }), { code: 'EACCES' });
  assert.ok(Date.now() - t0 < 2000, 'bounded');
});

const deadLock = async file => {
  await node(`import { withLock } from ${JSON.stringify(STABLE)}; withLock(${JSON.stringify(file)}, () => process.exit(0));`);
  assert.ok(existsSync(`${file}.lock.d`));
};

test('review 3: a stale lock is removed only if it still holds the owner judged stale; a lock is released only while it is ours', () => {
  const dir = tmp('nunchi-lock-steps-');
  const file = join(dir, 'x.json'), lock = `${file}.lock.d`;
  S.withLock(file, () => {
    // judged stale a moment ago (its holder died), taken over since by a live holder: this one
    assert.equal(S.lockInternals.reap(lock, { owner: { token: 'the-dead-holder' } }, 30000), false);
    assert.ok(existsSync(join(lock, 'owner.json')), 'the live lock is left alone');
  });
  S.withLock(file, () => {
    // taken over while held (a holder elsewhere judged it stale): it is someone else's now
    renameSync(lock, `${lock}.moved`);
    rmSync(`${lock}.moved`, { recursive: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'theirs', pid: 1, host: 'elsewhere' }));
  });
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token, 'theirs', 'not released: it was not ours');
});

test('review 4: a stale lock that cannot be removed ends in LOCKED, without spinning', async () => {
  const dir = tmp('nunchi-lock-spin-');
  const file = join(dir, 'x.json');
  await deadLock(file);
  mkdirSync(`${file}.lock.d.reap`);                                    // another taker is removing it right now
  const cpu0 = process.cpuUsage(), t0 = Date.now();
  assert.throws(() => S.withLock(file, () => {}, { timeoutMs: 400 }), { code: 'LOCKED' });
  const wall = Date.now() - t0, cpu = process.cpuUsage(cpu0), used = (cpu.user + cpu.system) / 1000;
  assert.ok(wall < 3000, `${wall} ms`);
  assert.ok(used < wall * 0.5, `${used} ms of CPU in ${wall} ms: it waited, not spun`);
});

test('review 5: a live holder on this machine keeps its lock however long ago it touched it (clock jump, sleep)', () => {
  const dir = tmp('nunchi-lock-live-');
  const file = join(dir, 'x.json'), lock = `${file}.lock.d`;
  S.withLock(file, () => {
    const old = new Date(Date.now() - 3600e3);
    utimesSync(join(lock, 'owner.json'), old, old);
    utimesSync(lock, old, old);
    assert.throws(() => S.withLock(file, () => {}, { timeoutMs: 150 }), { code: 'LOCKED' });
    assert.ok(existsSync(join(lock, 'owner.json')));
  });
});

test('mutant: syncLedger folds under the ledger lock', () => {
  const cwd = tmp('nunchi-sync-lock-');
  fakeRun(cwd, '0001', { findings: [fnd('/tasks', 'guest.normal.m', 'x')] });
  const file = join(cwd, '.nunchi', 'state', 'ledger.json');
  S.withLock(file, () => {
    const r = spawnSync('node', ['--input-type=module', '-e', `import { syncLedger } from ${JSON.stringify(LEDGER)};
try { syncLedger(${JSON.stringify(file)}, ${JSON.stringify(join(cwd, '.nunchi', 'runs'))}, { timeoutMs: 300 }); console.log('folded'); } catch (e) { console.log(e.code); }`], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'LOCKED');
  });
  assert.ok(!existsSync(file));
});

// ---- writes (review 12, 15) --------------------------------------------------------------------------------

test('review 12: an atomic write keeps the mode of the file it replaces, or takes the one asked for', { skip: !POSIX && 'no POSIX modes' }, () => {
  const dir = tmp('nunchi-mode-');
  const file = join(dir, 'approved.json');
  writeFileSync(file, '{}');
  chmodSync(file, 0o600);
  S.writeStable(file, { approved: [] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  S.writeAtomic(join(dir, 'new.json'), 'x', { mode: 0o640 });
  assert.equal(statSync(join(dir, 'new.json')).mode & 0o777, 0o640);
});

test('review 15 / mutant: durable writes are synced (file and folder); a folder that fails to sync for a real reason is an error', () => {
  const dir = tmp('nunchi-fsync-');
  const orig = S.io.fsync, calls = [];
  S.io.fsync = fd => { calls.push(fd); return orig(fd); };
  try {
    S.writeAtomic(join(dir, 'a.json'), 'x', { durable: true });
    assert.equal(calls.length, POSIX ? 2 : 1, 'the file, then its folder');
    calls.length = 0;
    S.writeStable(join(dir, 'b.json'), {});
    assert.equal(calls.length, 0, 'run evidence is not synced');
    calls.length = 0;
    L.saveDecision(dir, L.buildDecision({ target: { group: 'abc123abc123' }, decision: 'fix', by: 'me' }));
    assert.ok(calls.length >= 1, 'decisions');
    calls.length = 0;
    L.addApproved(join(dir, 'approved.json'), ['x:y']);
    assert.ok(calls.length >= 1, 'approvals');
    calls.length = 0;
    fakeRun(dir, '0001');
    L.syncLedger(join(dir, '.nunchi', 'state', 'ledger.json'), join(dir, '.nunchi', 'runs'));
    assert.ok(calls.length >= 1, 'the ledger');
    if (POSIX) {
      S.io.fsync = fd => { calls.push(fd); if (calls.length % 2 === 0) throw Object.assign(new Error('i/o error'), { code: 'EIO' }); return orig(fd); };
      calls.length = 0;
      assert.throws(() => S.writeAtomic(join(dir, 'c.json'), 'x', { durable: true }), { code: 'EIO' });
    }
  } finally { S.io.fsync = orig; }
});

test('review 15: what a crash mid-write leaves is removed after an hour', async () => {
  const cwd = tmp('nunchi-leftovers-');
  ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'x')]);
  const state = join(cwd, '.nunchi', 'state');
  const old = join(state, '.ledger.json.tmp-123-deadbeef'), fresh = join(state, '.ledger.json.tmp-456-cafebabe'), oldLock = join(state, 'approved.json.lock.d.tmp-0123456789abcdef');
  writeFileSync(old, '{"half'); writeFileSync(fresh, '{"half'); mkdirSync(oldLock);
  const hour = new Date(Date.now() - 2 * 3600e3);
  utimesSync(old, hour, hour); utimesSync(oldLock, hour, hour);
  const r = await cli(cwd, ['findings']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(old) && !existsSync(oldLock), 'an hour old: removed');
  assert.ok(existsSync(fresh), 'may still be written: kept');
});

// ---- provenance (review 7, 8, 10, 11) ----------------------------------------------------------------------

test('review 7: an older approval of a dismissal on a blocker is not carried over; every one carried over is said', async () => {
  const cwd = tmp('nunchi-legacy-swap-');
  const st = ledgerWith(cwd, [SECRET, fnd('/tasks', 'guest.normal.m', 'small')]);
  const secret = item(st, 'secret-in-client-bundle'), small = item(st, 'small');
  // a pulled commit replaced the approved `fix` with a false-positive on the secret, under the same id
  plant(cwd, { schema: 1, id: 'lr-mine01', target: { fp: secret.fp }, decision: 'false-positive', reason: 'not-a-problem', note: null, by: 'someone', at: '2026-10-13T10:00:00.000+09:00', fingerprintVersion: 1 });
  plant(cwd, { schema: 1, id: 'lr-mine02', target: { group: small.group }, decision: 'fix', reason: null, note: null, by: 'me', at: '2026-10-13T10:00:00.000+09:00', fingerprintVersion: 1 });
  const file = join(cwd, '.nunchi', 'state', 'approved.json');
  writeFileSync(file, JSON.stringify({ schema: 1, approved: ['lr-mine01', 'lr-mine02'] }));
  const r = await cli(cwd, ['findings', '--all', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const groups = JSON.parse(r.stdout).groups;
  assert.equal(groups.find(g => g.group === secret.group).status, 'open', 'the blocker is not dismissed');
  assert.equal(groups.find(g => g.group === small.group).example.decision.verified, true);
  assert.match(r.stderr, /approval of decision lr-mine01 was not carried over/);
  assert.match(r.stderr, /approval of decision lr-mine02 \(fix on group-/);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc.legacy, ['lr-mine01']);
  assert.ok(doc.approved.some(k => /^lr-mine02:[0-9a-f]{64}$/.test(k)) && !doc.approved.includes('lr-mine01'));
  const again = await cli(cwd, ['findings']);
  assert.equal(again.stderr, '', 'said once');
});

test('review 8: approvals name the full SHA-256 of the record; a 64-bit key from before is carried over', () => {
  const dir = tmp('nunchi-fullhash-');
  const d = L.buildDecision({ target: { group: 'abc123abc123' }, decision: 'fix', by: 'me' });
  assert.match(L.approvalKey(d), /^[\w-]+:[0-9a-f]{64}$/);
  const file = join(dir, 'approved.json');
  writeFileSync(file, JSON.stringify({ schema: 2, approved: [`${d.id}:${L.decisionHash(d).slice(0, 16)}`] }));
  L.addApproved(file, [], { decisions: [d] });
  assert.deepEqual([...L.readApproved(file)], [L.approvalKey(d)]);
});

test('review 10: a decision is ordered by when it arrived; one dated ahead of its arrival never counts, after its date either', async () => {
  const st = fold(empty(), '0001', {}, [fnd('/tasks', 'guest.normal.m', 'small')]);
  const group = item(st, 'small').group;
  const base = { schema: 1, target: { group }, note: null, fingerprintVersion: 1 };
  const T0 = Date.parse('2026-10-14T10:00:00.000+09:00');
  const ahead = { ...base, id: 'zz-ahead', decision: 'false-positive', reason: 'not-a-problem', by: 'someone', at: '2026-10-14T11:00:00.000+09:00' };
  const mine = { ...base, id: 'zz-mine', decision: 'fix', reason: null, by: 'me', at: '2026-10-14T10:30:00.000+09:00' };
  const s = { ...st, decisionsSeen: { [L.approvalKey(ahead)]: T0, [L.approvalKey(mine)]: T0 + 30 * 60e3 } };
  const status = now => L.view(s, [ahead, mine], new Set(), { now }).find(r => r.group === group).status;
  assert.equal(status(T0 + 31 * 60e3), 'to-fix');
  assert.equal(status(T0 + 3 * 3600e3), 'to-fix', 'its date has passed: it still does not count');
  // the CLI notes when each decision was first seen, once
  const cwd = tmp('nunchi-firstseen-');
  ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'small')]);
  plant(cwd, mine);
  assert.equal((await cli(cwd, ['findings'])).code, 0);
  const seen = JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8')).decisionsSeen;
  assert.deepEqual(Object.keys(seen), [L.approvalKey(mine)]);
  assert.equal((await cli(cwd, ['findings'])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8')).decisionsSeen, seen, 'kept, not moved');
});

test('review 11: decision and state files are never followed through links, decisions have a size cap, and a parse error never shows the text', async () => {
  const cwd = tmp('nunchi-links-');
  const st = ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'small')]);
  const folder = join(cwd, '.nunchi', 'decisions', `group-${item(st, 'small').group}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(cwd, '.env.local'), 'leak1234');
  symlinkSync(join(cwd, '.env.local'), join(folder, 'lr1-abcdef.json'));
  let r = await cli(cwd, ['findings'], { timeout: 20000 });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /leak1234/);
  assert.match(r.stderr, /not a regular file/);
  rmSync(join(folder, 'lr1-abcdef.json'));
  if (POSIX) {
    symlinkSync('/dev/zero', join(folder, 'lr1-abcdef.json'));
    r = await cli(cwd, ['findings'], { timeout: 20000 });
    assert.equal(r.code, 2, 'refused at once, not read forever');
    rmSync(join(folder, 'lr1-abcdef.json'));
  }
  writeFileSync(join(folder, 'lr1-abcdef.json'), '{"note": "hunter2 is the password", "at": tru');
  r = await cli(cwd, ['findings']);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stderr, /hunter2|password/);
  writeFileSync(join(folder, 'lr1-abcdef.json'), JSON.stringify({ note: 'x'.repeat(70 * 1024) }));
  assert.throws(() => L.readDecisions(join(cwd, '.nunchi', 'decisions')), { code: 'CORRUPT', message: /larger than/ });
  rmSync(folder, { recursive: true });
  symlinkSync(join(cwd, '.env.local'), join(cwd, '.nunchi', 'state', 'approved.json'));
  r = await cli(cwd, ['findings']);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.stdout + r.stderr, /leak1234/);
});

test('mutant: the approval is written before the decision file (a decide whose approval cannot be written writes nothing)', { timeout: 60000 }, () => {
  const cwd = tmp('nunchi-approve-first-');
  const st = ledgerWith(cwd, [fnd('/tasks', 'guest.normal.m', 'small')]);
  // another nunchi process holds the approval list
  S.withLock(join(cwd, '.nunchi', 'state', 'approved.json'), () => {
    const r = spawnSync('node', [CLI, 'decide', item(st, 'small').group, 'fix'], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /locked/);
  });
  assert.ok(!existsSync(join(cwd, '.nunchi', 'decisions')), 'no decision without its approval');
});

// ---- gc and run ids (review 6, 16) -------------------------------------------------------------------------

test('review 6: gc never removes a run the ledger does not hold, and stops when it cannot bring the ledger up to date', async () => {
  const cwd = tmp('nunchi-gc-');
  for (const id of ['0001', '0002', '0003', '0004', '0005', '0006']) fakeRun(cwd, id);
  const r = await cli(cwd, ['gc', '--keep', '5', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).removed, ['0001'], 'folded first, then removed');
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8')).runs, ['0001', '0002', '0003', '0004', '0005', '0006']);
  // a run that cannot be folded: nothing is removed
  fakeRun(cwd, '0007', { torn: true });
  const before = readdirSync(join(cwd, '.nunchi', 'runs')).sort();
  const g = await cli(cwd, ['gc', '--keep', '1']);
  assert.equal(g.code, 2, g.stdout + g.stderr);
  assert.deepEqual(readdirSync(join(cwd, '.nunchi', 'runs')).sort(), before);
  // the rule itself: a complete run outside `folded` is kept
  assert.deepEqual(R.gcRuns(join(cwd, '.nunchi', 'runs'), { keep: 1, folded: new Set(['0002']) }).removed, ['0002']);
});

test('review 16: captures started at the same moment never get the same run id', async () => {
  const dir = join(tmp('nunchi-ids-'), 'runs');
  const child = `import { startRun, finishRun } from ${JSON.stringify(RUNS)};
const [dir, n, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
const ids = [];
for (let i = 0; i < Number(n); i++) { const r = startRun(dir); ids.push(r.id); finishRun(dir, r.id); }
process.stdout.write(ids.join(','));`;
  const at = Date.now() + 1500;
  const out = await Promise.all(Array.from({ length: 12 }, () => node(child, [dir, 8, at])));
  for (const r of out) assert.equal(r.code, 0, r.stderr);
  const ids = out.flatMap(r => r.stdout.split(','));
  assert.equal(new Set(ids).size, 96, 'no id twice');
  assert.equal(R.listRuns(dir).complete.length, 96);
});
