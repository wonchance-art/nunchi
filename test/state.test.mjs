// The state store (design 0.1-c §8.1, M1): the shared state root of a repository, revision-checked writes with a
// generation file and a .prev backup, the run-id counter worktrees share, and answer keys outside the project.
// Namespace imports, so a function that did not exist before M1 fails its own test, not the whole file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as St from '../src/state.mjs';
import * as L from '../src/ledger.mjs';
import * as R from '../src/runs.mjs';
import * as S from '../src/stable.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const url = p => pathToFileURL(fileURLToPath(new URL(p, import.meta.url))).href;
const STATE = url('../src/state.mjs'), RUNS = url('../src/runs.mjs');
const POSIX = process.platform !== 'win32';
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
process.env.XDG_STATE_HOME = tmp('nunchi-state-xdg-');
const run = (cmd, args, { cwd, env } = {}) => new Promise(res => execFile('node', [...cmd, ...args.map(String)], { cwd, env: env ? { ...process.env, ...env } : process.env, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const cli = (cwd, ...a) => run([CLI], a, { cwd });
const node = (code, args = []) => run(['--input-type=module', '-e', code], args);
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
const repo = () => {
  const root = tmp('nunchi-repo-');
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 't@example.invalid'); git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'README.md'), 'an invented app\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
  return root;
};
const slug = route => route.slice(1).replace(/\//g, '~') || '~';
const fnd = (route, cell, name) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${slug(route)}.${cell}`, route, viewport: cell.split('.')[2], selector: 'main > button', box: null, evidence: { name } });
const sc = (route, cell) => { const [person, state, viewport] = cell.split('.'); return { id: `${slug(route)}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200 }; };
const fakeRun = (cwd, id, findings = [], extra = {}) => {
  const dir = join(cwd, '.nunchi', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const scope = { routes: ['/tasks'], persons: ['guest'], states: ['normal'], viewports: ['m'], changedSince: null };
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, scope, wholeApp: true, ...extra }));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes: [sc('/tasks', 'guest.normal.m')] }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: L.annotate(findings) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
};

// ---- the state root -----------------------------------------------------------------------------------------

test('state root: .nunchi/state without git; the common git folder in a repository, one per app, shared by every worktree', () => {
  const plain = tmp('nunchi-nogit-');
  assert.deepEqual(St.stateRoot(plain), { dir: join(plain, '.nunchi', 'state'), shared: false, stream: 'main', legacy: null, gitCommonDir: null, prefix: null });
  const root = repo();
  const main = St.stateRoot(root);
  assert.equal(main.shared, true);
  assert.ok(main.dir.endsWith(join('nunchi', 'root', 'state')), main.dir);
  // under the repository's own git folder (compared by real path: Windows may name the temp folder two ways)
  assert.equal(realpathSync.native(dirname(dirname(dirname(main.dir)))), realpathSync.native(join(root, '.git')));
  assert.equal(main.stream, 'main');
  assert.equal(main.legacy, join(root, '.nunchi', 'state'));
  // a linked worktree: the same state, its own stream
  const wt = join(tmp('nunchi-wt-'), 'second');
  git(root, 'worktree', 'add', '-q', wt);
  const linked = St.stateRoot(wt);
  assert.equal(linked.dir, main.dir, 'one ledger for every worktree');
  assert.equal(linked.stream, 'wt:second');
  // an app in a subfolder of the repository has its own state, in every worktree alike
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(wt, 'apps', 'web'), { recursive: true });
  const sub = St.stateRoot(join(root, 'apps', 'web'));
  assert.notEqual(sub.dir, main.dir);
  assert.match(sub.dir, /nunchi[\\/]app-[0-9a-f]{12}[\\/]state$/);
  assert.equal(St.stateRoot(join(wt, 'apps', 'web')).dir, sub.dir);
});

test('state root: the CLI keeps the ledger in the shared folder; a worktree sees it, and its own runs fold beside the main worktree\'s', async () => {
  const root = repo();
  fakeRun(root, '0001', [fnd('/tasks', 'guest.normal.m', 'in-main')]);
  const one = await cli(root, 'findings', '--json');
  assert.equal(one.code, 0, one.stderr);
  const shared = St.stateRoot(root);
  assert.ok(existsSync(join(shared.dir, 'ledger.json')), 'written in the shared folder');
  assert.ok(!existsSync(join(root, '.nunchi', 'state', 'ledger.json')), 'not in .nunchi/state');
  if (POSIX) assert.equal(statSync(shared.dir).mode & 0o777, 0o700, 'owner-only');
  // a second worktree whose first run has the same id (runs are numbered per folder): folded too, as its own stream
  const wt = join(tmp('nunchi-wt2-'), 'two');
  git(root, 'worktree', 'add', '-q', wt);
  fakeRun(wt, '0001', [fnd('/tasks', 'guest.normal.m', 'in-worktree')]);
  const two = await cli(wt, 'findings', '--all', '--json');
  assert.equal(two.code, 0, two.stderr);
  const seen = JSON.parse(two.stdout).groups.map(g => [g.example.evidence.name, g.status]).sort();
  // one ledger: both worktrees' findings. The worktree's run looked at the same screen like for like and did not see
  // the main worktree's finding, but only the worktree that last saw an item can say it is gone: another branch's
  // capture does not fix it (else the two would fix and bring back each other's items in turn)
  assert.deepEqual(seen, [['in-main', 'open'], ['in-worktree', 'open']]);
  const state = JSON.parse(readFileSync(join(shared.dir, 'ledger.json'), 'utf8'));
  assert.deepEqual(state.folds.filter(f => f.source === 'rule').map(f => [f.run, f.stream]), [['0001', 'main'], ['0001', 'wt:two']]);
  // and the run-id counter the two share gives the next capture of either an id neither used
  const ids = join(shared.dir, 'run-ids.json');
  const a = R.startRun(join(root, '.nunchi', 'runs'), { ids }), b = R.startRun(join(wt, '.nunchi', 'runs'), { ids });
  assert.deepEqual([a.id, b.id], ['0002', '0003']);
  // the main worktree's newer run: the worktree's page still says its own latest run, and its next run does not make
  // main's run old (the watermark is per worktree)
  fakeRun(root, '0004', [fnd('/tasks', 'guest.normal.m', 'in-main')]);
  assert.equal((await cli(root, 'findings')).code, 0);
  assert.match((await cli(wt, 'findings')).stdout, /^run 0001 · /);
  assert.match((await cli(root, 'findings')).stdout, /^run 0004 · /);
  // main's own next run that does not see its item does fix it; the worktree's item stays the worktree's
  fakeRun(root, '0005', []);
  const after = JSON.parse((await cli(root, 'findings', '--all', '--json')).stdout).groups.map(g => [g.example.evidence.name, g.status]).sort();
  assert.deepEqual(after, [['in-main', 'fixed'], ['in-worktree', 'open']]);
});

test('state root: a .nunchi/state an older nunchi wrote is moved into the shared folder once, and said; a second worktree\'s is merged', async () => {
  const root = repo();
  const legacy = join(root, '.nunchi', 'state');
  fakeRun(root, '0001', [fnd('/tasks', 'guest.normal.m', 'x')]);
  const m1a = L.foldRun({ schema: 1, fingerprintVersion: 2, runs: [], items: {} }, L.runForFold(join(root, '.nunchi', 'runs', '0001')));
  // as M1a wrote it: schema 1, no folds, no source on items
  const old = { schema: 1, fingerprintVersion: 2, runs: m1a.runs, items: Object.fromEntries(Object.entries(m1a.items).map(([k, { source, ...i }]) => [k, i])), seenRoutes: m1a.seenRoutes, coverage: m1a.coverage, decisionsSeen: { 'd1:aa': 1000 } };
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'ledger.json'), JSON.stringify(old));
  writeFileSync(join(legacy, 'approved.json'), JSON.stringify({ schema: 2, approved: ['d1:aa'] }));
  const r = await cli(root, 'findings', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /moved \.nunchi\/state\/ledger\.json into the repository's shared state/);
  assert.match(r.stderr, /moved \.nunchi\/state\/approved\.json/);
  const dir = St.stateRoot(root).dir;
  const state = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  assert.equal(state.schema, 2);
  assert.deepEqual(state.folds, [{ run: '0001', source: 'rule', key: null, stream: 'main' }], 'its runs are not folded again');
  assert.equal(state.decisionsSeen, undefined, 'when decisions were first seen is never taken from a moved file');
  assert.ok(Object.values(state.items).every(i => i.stream === 'main'), 'its items are this worktree\'s');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'approved.json'), 'utf8')).approved, ['d1:aa']);
  assert.ok(existsSync(join(legacy, 'ledger.json.moved')) && !existsSync(join(legacy, 'ledger.json')), 'kept beside, never deleted');
  const again = await cli(root, 'findings');
  assert.doesNotMatch(again.stderr, /moved/, 'once');
  // another worktree with a ledger of its own, holding an open item of a run since removed: carried over as that
  // worktree's (only it can say the item is gone); a fixed one is history and is not; the times it says decisions
  // were first seen are not taken; approvals are added
  const wt = join(tmp('nunchi-wt3-'), 'three');
  git(root, 'worktree', 'add', '-q', wt);
  mkdirSync(join(wt, '.nunchi', 'state'), { recursive: true });
  const there = L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0007', scope: { routes: ['/notes'] }, scenes: [sc('/notes', 'guest.normal.m')], findings: L.annotate([fnd('/notes', 'guest.normal.m', 'only-there')]) });
  const fixedThere = L.foldRun(L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0005', scope: { routes: ['/old'] }, wholeApp: true, scenes: [sc('/old', 'guest.normal.m')], findings: L.annotate([fnd('/old', 'guest.normal.m', 'fixed-there')]) }),
    { id: '0006', scope: { routes: ['/old'] }, wholeApp: true, scenes: [sc('/old', 'guest.normal.m')], findings: [] });
  assert.equal(Object.values(fixedThere.items)[0].goneAt, '0006');
  const strip = items => Object.fromEntries(Object.entries(items).map(([k, { source, stream, ...i }]) => [k, i]));
  const wtLedger = { ...old, runs: [...old.runs, '0005', '0006', '0007'], items: { ...old.items, ...strip(there.items), ...strip(fixedThere.items) }, decisionsSeen: { 'd1:aa': 500, 'd2:bb': 2000 } };
  writeFileSync(join(wt, '.nunchi', 'state', 'ledger.json'), JSON.stringify(wtLedger));
  writeFileSync(join(wt, '.nunchi', 'state', 'approved.json'), JSON.stringify({ schema: 2, approved: ['d2:bb'] }));
  fakeRun(wt, '0001');
  const w = await cli(wt, 'findings');
  assert.equal(w.code, 0, w.stderr);
  assert.match(w.stderr, /1 open item\(s\) of \.nunchi\/state\/ledger\.json it did not have were carried over; not carried over: 1 item\(s\) already fixed there \(history only\); which of its runs were folded/);
  const merged = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'));
  const carried = Object.values(merged.items).find(i => i.evidence?.name === 'only-there');
  assert.deepEqual([carried.stream, carried.goneAt], ['wt:three', null]);
  assert.ok(!Object.values(merged.items).some(i => i.evidence?.name === 'fixed-there'), 'a fixed item is history, not carried');
  assert.equal(merged.decisionsSeen, undefined, 'never taken from a moved file');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'approved.json'), 'utf8')).approved, ['d1:aa', 'd2:bb']);
});

test('adoption never takes when decisions were first seen: neither the move (state.mjs) nor the ledger it becomes (ledger.mjs)', () => {
  const base = tmp('nunchi-adopt-seen-');
  const root = { dir: join(base, 'shared', 'state'), shared: true, stream: 'wt:a', legacy: join(base, 'project', '.nunchi', 'state') };
  mkdirSync(root.legacy, { recursive: true });
  const ledger = { schema: 2, runs: ['0001'], folds: [{ run: '0001', source: 'rule', key: null, stream: 'main' }], items: {}, decisionsSeen: { 'd1:aa': 1 } };
  writeFileSync(join(root.legacy, 'ledger.json'), JSON.stringify(ledger));
  const r = St.adoptLegacy(root);                                            // the move alone: no migration given
  assert.deepEqual(r.moved, ['ledger.json']);
  assert.equal(JSON.parse(readFileSync(join(root.dir, 'ledger.json'), 'utf8')).decisionsSeen, undefined);
  const adopted = L.adoptLedger(ledger, 'wt:a');                             // the migration alone
  assert.equal(adopted.decisionsSeen, undefined);
  assert.deepEqual(adopted.folds.map(f => f.stream), ['wt:a'], 'its folds are the adopting worktree\'s');
  const cur = { ...L.emptyState(), decisionsSeen: { 'd2:bb': 5 } };
  assert.deepEqual(L.carryLedger(cur, ledger, 'wt:a').doc.decisionsSeen, { 'd2:bb': 5 }, 'carrying over leaves the shared ledger\'s own times alone');
});

test('state root: a .nunchi/state file committed to git is never adopted (said instead), and a fallback state folder that is committed is refused', async () => {
  const root = repo();
  fakeRun(root, '0001', [fnd('/tasks', 'guest.normal.m', 'x')]);
  const legacy = join(root, '.nunchi', 'state');
  mkdirSync(legacy, { recursive: true });
  // a ledger and approvals that came through git: anyone with push access could have written them
  const planted = L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0009', scope: { routes: ['/a'] }, scenes: [sc('/a', 'guest.normal.m')], findings: L.annotate([fnd('/a', 'guest.normal.m', 'planted')]) });
  writeFileSync(join(legacy, 'ledger.json'), JSON.stringify({ ...planted, decisionsSeen: { 'd9:99': 1 } }));
  writeFileSync(join(legacy, 'approved.json'), JSON.stringify({ schema: 2, approved: ['d9:99'] }));
  git(root, 'add', '-f', '.nunchi/state/ledger.json', '.nunchi/state/approved.json');
  git(root, 'commit', '-qm', 'state');
  const r = await cli(root, 'findings', '--all', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\.nunchi\/state\/approved\.json is committed to git, so it was not moved/);
  assert.match(r.stderr, /\.nunchi\/state\/ledger\.json is committed to git, so it was not moved/);
  assert.deepEqual(JSON.parse(r.stdout).groups.map(g => g.example.evidence.name), ['x'], 'nothing of the committed ledger');
  assert.ok(existsSync(join(legacy, 'ledger.json')) && !existsSync(join(legacy, 'ledger.json.moved')), 'left where it is');
  const dir = St.stateRoot(root).dir;
  assert.ok(!existsSync(join(dir, 'approved.json')) || !JSON.parse(readFileSync(join(dir, 'approved.json'), 'utf8')).approved.includes('d9:99'));
  // the same files where the state falls back to .nunchi/state: refused, never read
  writeFileSync(join(legacy, St.FALLBACK), JSON.stringify({ schema: 1 }));
  const f = await cli(root, 'findings');
  assert.equal(f.code, 2, f.stdout + f.stderr);
  assert.match(f.stderr, /\.nunchi\/state\/approved\.json, \.nunchi\/state\/ledger\.json committed to git: state that came through git is never read/);
});

test('state root: a shared folder that cannot be written falls back to .nunchi/state, says so once and keeps to it', async () => {
  const root = repo();
  fakeRun(root, '0001', [fnd('/tasks', 'guest.normal.m', 'x')]);
  // `nunchi` in the git folder is a file: the shared state folder cannot be made (ENOTDIR)
  writeFileSync(join(root, '.git', 'nunchi'), 'not a folder\n');
  const r = await cli(root, 'findings', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /cannot be written \((ENOTDIR|EEXIST)\); this worktree keeps its state in \.nunchi\/state instead \(recorded in \.nunchi\/state\/fallback\.json/);
  assert.ok(existsSync(join(root, '.nunchi', 'state', 'ledger.json')), 'the ledger is in .nunchi/state');
  assert.ok(existsSync(join(root, '.nunchi', 'state', St.FALLBACK)));
  // the next command picks the same root, silently, also once the shared folder could be written again
  rmSync(join(root, '.git', 'nunchi'));
  const again = await cli(root, 'findings', '--json');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stderr, '');
  assert.deepEqual(St.stateRoot(root).fallback, true);
  assert.ok(!existsSync(join(root, '.git', 'nunchi', 'root', 'state', 'ledger.json')), 'the shared folder is not used');
  // a probe that is refused (a read-only or foreign-owned git folder) falls back the same way; another error does not
  const other = repo();
  const probe = St.stateIo.probe;
  try {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      St.stateIo.probe = () => { throw Object.assign(new Error('no'), { code }); };
      const plain = repo();
      const fb = St.resolveStateRoot(plain);
      assert.deepEqual([fb.shared, fb.fallback, fb.dir], [false, true, join(plain, '.nunchi', 'state')], code);
      assert.match(fb.warning, new RegExp(`cannot be written \\(${code}\\)`));
      assert.equal(St.resolveStateRoot(plain).warning, undefined, 'said once');
    }
    St.stateIo.probe = () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); };
    assert.throws(() => St.resolveStateRoot(other), /boom/);
  } finally { St.stateIo.probe = probe; }
});

// ---- revision-checked writes ----------------------------------------------------------------------------------

test('store: every commit raises rev, keeps the file it replaces as .prev and bumps the generation; nothing to write writes nothing', () => {
  const dir = tmp('nunchi-store-');
  const file = join(dir, 'ledger.json'), gen = join(dir, 'generation');
  const add = n => St.updateDoc(file, doc => ({ ...(doc || {}), count: (doc?.count || 0) + n }), { generation: gen });
  assert.deepEqual(add(1), { count: 1, rev: 1 });
  assert.ok(!existsSync(`${file}.prev`), 'nothing to keep yet');
  assert.deepEqual(add(2), { count: 3, rev: 2 });
  assert.deepEqual(JSON.parse(readFileSync(`${file}.prev`, 'utf8')), { count: 1, rev: 1 }, 'the previous version');
  assert.equal(St.readGeneration(gen), 2);
  const before = readFileSync(file);
  const same = St.updateDoc(file, doc => doc, { generation: gen });
  assert.deepEqual(same, { count: 3, rev: 2 });
  assert.ok(readFileSync(file).equals(before));
  assert.equal(St.readGeneration(gen), 2, 'no write, no new generation');
  if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('store: a writer that read an old revision re-reads and redoes its change (no lost update); a stale commit is refused', () => {
  const dir = tmp('nunchi-store-race-');
  const file = join(dir, 'state.json');
  St.updateDoc(file, () => ({ items: ['a'] }));
  let calls = 0;
  const out = St.updateDoc(file, doc => {
    calls++;
    // another process commits between this writer's read and its write, once
    if (calls === 1) St.commitDoc(file, { items: [...doc.items, 'b'] }, { expect: doc.rev });
    return { items: [...doc.items, 'c'] };
  });
  assert.equal(calls, 2, 'read again after the conflict');
  assert.deepEqual(out.items, ['a', 'b', 'c'], 'both changes kept');
  assert.equal(out.rev, 3);
  assert.throws(() => St.commitDoc(file, { items: [] }, { expect: 1 }), { code: 'CONFLICT' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).items, ['a', 'b', 'c'], 'untouched');
});

test('store: a file that cannot be read is an error, never "empty"; a read that fails once (a rename on Windows) is read again', () => {
  const dir = tmp('nunchi-store-corrupt-');
  const file = join(dir, 'ledger.json');
  writeFileSync(file, '{"rev": 4, "items": [');
  assert.throws(() => St.updateDoc(file, doc => ({ ...doc, x: 1 })), { code: 'CORRUPT' });
  assert.equal(readFileSync(file, 'utf8'), '{"rev": 4, "items": [', 'left as it was');
  assert.throws(() => L.readState(file), { code: 'CORRUPT' });
  writeFileSync(file, JSON.stringify({ schema: 9, runs: [], folds: [], items: {} }));
  assert.throws(() => L.readState(file), e => e.code === 'CORRUPT' && /newer nunchi/.test(e.message));
  writeFileSync(file, JSON.stringify({ rev: 1, n: 1 }));
  const real = St.readIo.readOnce;
  let n = 0;
  St.readIo.readOnce = (...a) => { if (n++ === 0) throw Object.assign(new Error(`${file} cannot be read (EBUSY): x`), { code: 'CORRUPT' }); return real(...a); };
  try { assert.deepEqual(St.readDoc(file).doc, { rev: 1, n: 1 }); } finally { St.readIo.readOnce = real; }
  assert.equal(n, 2, 'read twice');
});

test('store: many processes updating one file at once lose no update; revs and the generation count every write (slow: ~10 s)', async () => {
  const dir = tmp('nunchi-store-stress-');
  const file = join(dir, 'ledger.json'), gen = join(dir, 'generation');
  const child = `import { updateDoc } from ${JSON.stringify(STATE)};
const [file, gen, who, n, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
for (let i = 0; i < Number(n); i++) updateDoc(file, doc => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);       // work between read and write widens the race
  return { count: (doc?.count || 0) + 1, by: { ...(doc?.by || {}), [who]: (doc?.by?.[who] || 0) + 1 } };
}, { generation: gen, timeoutMs: 60000 });`;
  const at = Date.now() + 1500, n = 12, procs = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const out = await Promise.all(procs.map(who => node(child, [file, gen, who, n, at])));
  for (const r of out) assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(doc.count, procs.length * n, 'no lost update');
  assert.deepEqual(Object.values(doc.by), procs.map(() => n));
  assert.equal(doc.rev, procs.length * n, 'one rev per write');
  assert.equal(St.readGeneration(gen), procs.length * n);
  assert.deepEqual(readdirSync(dir).sort(), ['generation', 'ledger.json', 'ledger.json.prev'], 'no lock or temp file left');
});

test('run ids: worktrees sharing the counter never get the same id, also when captures start at once', async () => {
  const base = tmp('nunchi-runids-');
  const ids = join(base, 'state', 'run-ids.json');
  const child = `import { startRun, finishRun } from ${JSON.stringify(RUNS)};
const [dir, ids, n, at] = process.argv.slice(1);
while (Date.now() < Number(at)) {}
const out = [];
for (let i = 0; i < Number(n); i++) { const r = startRun(dir, { ids }); out.push(r.id); finishRun(dir, r.id); }
process.stdout.write(out.join(','));`;
  const at = Date.now() + 1500;
  const dirs = [join(base, 'a', 'runs'), join(base, 'b', 'runs'), join(base, 'c', 'runs')];
  const out = await Promise.all(dirs.flatMap(d => [node(child, [d, ids, 6, at]), node(child, [d, ids, 6, at])]));
  for (const r of out) assert.equal(r.code, 0, r.stderr);
  const all = out.flatMap(r => r.stdout.split(','));
  assert.equal(new Set(all).size, 36, 'no id twice across worktrees');
  assert.equal(JSON.parse(readFileSync(ids, 'utf8')).last, 36);
  // a counter that cannot be read counts as 0: the runs folder still gives the floor
  writeFileSync(ids, '{"last": ');
  assert.equal(R.startRun(dirs[0], { ids }).id, String(Math.max(...R.listRuns(dirs[0]).complete.map(Number)) + 1).padStart(4, '0'));
});

// ---- answer keys outside the project ------------------------------------------------------------------------

test('answer keys: under $XDG_STATE_HOME (Windows: %LOCALAPPDATA%), else ~/.local/state; owner-only; one folder per run', () => {
  assert.equal(St.userStateBase({ XDG_STATE_HOME: '/x/state' }, 'linux'), join('/x/state', 'nunchi'));
  assert.equal(St.userStateBase({ XDG_STATE_HOME: 'relative/state' }, 'linux'), join(homedir(), '.local', 'state', 'nunchi'), 'a relative XDG path is ignored');
  assert.equal(St.userStateBase({}, 'darwin'), join(homedir(), '.local', 'state', 'nunchi'));
  assert.equal(St.userStateBase({ LOCALAPPDATA: '/users/x/appdata/local' }, 'win32'), join('/users/x/appdata/local', 'nunchi'));
  assert.equal(St.userStateBase({ LOCALAPPDATA: '/users/x/appdata/local' }, 'linux'), join(homedir(), '.local', 'state', 'nunchi'));
  const xdg = tmp('nunchi-keys-xdg-'), env = { XDG_STATE_HOME: xdg };
  const project = tmp('nunchi-keys-');
  const runDir = join(project, '.nunchi', 'runs', '0003');
  mkdirSync(runDir, { recursive: true });
  const p = St.writeKey(runDir, 'verify-key.json', { packets: { p001: { decoy: true } } }, env);
  assert.ok(p.startsWith(join(xdg, 'nunchi')), p);
  assert.ok(!p.startsWith(project), 'outside the project');
  assert.equal(dirname(p).split(/[\\/]/).pop(), '0003');
  assert.deepEqual(St.readKey(runDir, 'verify-key.json', env), { packets: { p001: { decoy: true } } });
  if (POSIX) {
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(p)).mode & 0o777, 0o700);
  }
  assert.notEqual(St.keysDir(join(project, '.nunchi', 'runs', '0004'), env), St.keysDir(runDir, env), 'one folder per run');
  assert.notEqual(St.keysDir(join(tmp('nunchi-keys-other-'), '.nunchi', 'runs', '0003'), env), St.keysDir(runDir, env), 'and per project folder');
  assert.throws(() => St.writeKey(runDir, 'manifest.json', {}, env), /not an answer key/);
});

test('answer keys: a run reached through a linked folder has the same key folder, also once the run folder is gone', { skip: !POSIX && 'symbolic links need privileges on Windows' }, () => {
  const env = { XDG_STATE_HOME: tmp('nunchi-keys-link-xdg-') };
  const real = tmp('nunchi-keys-real-');
  const runDir = join(real, '.nunchi', 'runs', '0001');
  mkdirSync(runDir, { recursive: true });
  const link = join(tmp('nunchi-keys-linkdir-'), 'project');
  symlinkSync(real, link);
  const viaLink = join(link, '.nunchi', 'runs', '0001');
  assert.equal(St.keysDir(viaLink, env), St.keysDir(runDir, env));
  St.writeKey(viaLink, 'hunt-key.json', { plan: 'p' }, env);
  rmSync(runDir, { recursive: true });
  assert.equal(St.keysDir(viaLink, env), St.keysDir(runDir, env), 'gc computes it after removing the run');
  St.removeKeys(viaLink, env);
  assert.ok(!existsSync(St.keysDir(runDir, env)));
});

test('answer keys: one an older nunchi left inside the run is read once and moved out', () => {
  const env = { XDG_STATE_HOME: tmp('nunchi-keys-move-') };
  const runDir = join(tmp('nunchi-keys-old-'), '.nunchi', 'runs', '0001');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'hunt-key.json'), JSON.stringify({ plan: 'abc', scenes: { s0123456789: 'tasks.guest.normal.m' } }));
  assert.deepEqual(St.readKey(runDir, 'hunt-key.json', env), { plan: 'abc', scenes: { s0123456789: 'tasks.guest.normal.m' } });
  assert.ok(!existsSync(join(runDir, 'hunt-key.json')), 'moved out of the project');
  assert.ok(existsSync(St.keyPath(runDir, 'hunt-key.json', env)));
  assert.deepEqual(St.readKey(runDir, 'hunt-key.json', env).plan, 'abc', 'read from its new place');
  assert.equal(St.readKey(runDir, 'recheck-key.json', env), null, 'no key: null, never an empty one');
  // a key in the project could have been written by anything: its plan is taken, never recorded verdicts
  writeFileSync(join(runDir, 'verify-key.json'), JSON.stringify({ seed: 's', packets: { p001: { decoy: true } }, recorded: { verdicts: [{ packet: 'p001', verdict: 'rejected', reason: 'x' }] }, earlier: [{ seed: 'e' }] }));
  assert.deepEqual(St.readKey(runDir, 'verify-key.json', env), { seed: 's', packets: { p001: { decoy: true } } });
  assert.deepEqual(JSON.parse(readFileSync(St.keyPath(runDir, 'verify-key.json', env), 'utf8')), { seed: 's', packets: { p001: { decoy: true } } });
  // re-check keys were never kept in the project: one there is not read
  writeFileSync(join(runDir, 'recheck-key.json'), JSON.stringify({ plan: 'x', run: '0001', packets: {}, recorded: { verdicts: [] } }));
  assert.equal(St.readKey(runDir, 'recheck-key.json', env), null);
  assert.equal(St.peekKey(runDir, 'hunt-key.json', env).plan, 'abc', 'peek: a pure read of the key outside the project');
});

test('answer keys: a symbolic link among nunchi\'s key folders, from the state base down, is refused', { skip: !POSIX && 'symbolic links need privileges on Windows' }, () => {
  const env = { XDG_STATE_HOME: tmp('nunchi-keys-link-') };
  const runDir = join(tmp('nunchi-keys-linkrun-'), '.nunchi', 'runs', '0001');
  mkdirSync(runDir, { recursive: true });
  const elsewhere = tmp('nunchi-keys-elsewhere-');
  const keys = St.keysDir(runDir, env);
  // <base>/<project hash> → a folder elsewhere: writing through it would put the key where the link points
  mkdirSync(join(env.XDG_STATE_HOME, 'nunchi'), { recursive: true });
  symlinkSync(elsewhere, dirname(dirname(keys)));
  assert.throws(() => St.writeKey(runDir, 'verify-key.json', { packets: {} }, env), e => e.code === 'UNSAFE_PATH');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  rmSync(dirname(dirname(keys)));
  // the base itself as a link: refused too
  rmSync(join(env.XDG_STATE_HOME, 'nunchi'), { recursive: true });
  symlinkSync(elsewhere, join(env.XDG_STATE_HOME, 'nunchi'));
  assert.throws(() => St.writeKey(runDir, 'verify-key.json', { packets: {} }, env), e => e.code === 'UNSAFE_PATH');
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('streams: "not looked at for 3 runs" counts the item\'s own worktree\'s runs; another worktree\'s runs neither age nor fix it', () => {
  const base = (id, route) => ({ id, scope: { routes: [route] }, wholeApp: false, scenes: [sc(route, 'guest.normal.m')] });
  let st = L.foldRun(L.emptyState(), { ...base('0001', '/a'), findings: L.annotate([fnd('/a', 'guest.normal.m', 'in-wt')]), stream: 'wt:x' });
  for (const id of ['0002', '0003', '0004', '0005']) st = L.foldRun(st, { ...base(id, '/b'), findings: [], stream: 'main' });
  const row = () => L.view(st, []).find(r => r.evidence.name === 'in-wt');
  assert.equal(row().notLookedAt, null, 'four runs of the main worktree: not this item\'s runs');
  // main looks at the same screen and does not see it: still open (only the worktree that saw it can fix it)
  st = L.foldRun(st, { ...base('0006', '/a'), findings: [], stream: 'main' });
  assert.equal(row().status, 'open');
  for (const id of ['0007', '0008', '0009']) st = L.foldRun(st, { ...base(id, '/b'), findings: [], stream: 'wt:x' });
  assert.equal(row().notLookedAt, '0001', 'three runs of its own worktree that did not look at it');
  assert.deepEqual([L.latestRunOf(st, 'main'), L.latestRunOf(st, 'wt:x')], ['0006', '0009']);
});

test('gc: a removed run takes its answer keys with it; a run an open item still names is kept', async () => {
  const cwd = tmp('nunchi-gc-keys-');
  for (const id of ['0001', '0002', '0003']) fakeRun(cwd, id, id === '0001' ? [fnd('/tasks', 'guest.normal.m', 'once')] : []);
  for (const id of ['0002', '0003']) St.writeKey(join(cwd, '.nunchi', 'runs', id), 'verify-key.json', { id });
  // 0001's finding is gone in 0002: nothing pins 0001; 0002 goes, its key with it
  let r = await cli(cwd, 'gc', '--keep', '1', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).removed, ['0001', '0002']);
  assert.ok(!existsSync(St.keysDir(join(cwd, '.nunchi', 'runs', '0002'))));
  assert.ok(existsSync(St.keyPath(join(cwd, '.nunchi', 'runs', '0003'), 'verify-key.json')));
  // an open item last seen in an older run pins it (design §8.1)
  const cwd2 = tmp('nunchi-gc-pin-');
  fakeRun(cwd2, '0001', [fnd('/tasks', 'guest.normal.m', 'stays')]);
  fakeRun(cwd2, '0002', [], { scope: { routes: ['/other'], persons: ['guest'], states: ['normal'], viewports: ['m'], changedSince: null }, wholeApp: false });
  writeFileSync(join(cwd2, '.nunchi', 'runs', '0002', 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes: [sc('/other', 'guest.normal.m')] }));
  fakeRun(cwd2, '0003', [], { scope: { routes: ['/other'], persons: ['guest'], states: ['normal'], viewports: ['m'], changedSince: null }, wholeApp: false });
  writeFileSync(join(cwd2, '.nunchi', 'runs', '0003', 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes: [sc('/other', 'guest.normal.m')] }));
  r = await cli(cwd2, 'gc', '--keep', '1', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).removed, ['0002'], '0001 holds the last sighting of an open item');
});

test('CLI: every ledger write bumps the state\'s generation file', async () => {
  const cwd = tmp('nunchi-gen-');
  fakeRun(cwd, '0001', [fnd('/tasks', 'guest.normal.m', 'x')]);
  assert.equal((await cli(cwd, 'findings')).code, 0);
  const gen = join(cwd, '.nunchi', 'state', 'generation');
  const g1 = St.readGeneration(gen);
  assert.ok(g1 >= 1);
  const groups = JSON.parse((await cli(cwd, 'findings', '--json')).stdout).groups;
  assert.equal(St.readGeneration(gen), g1, 'a read writes nothing');
  assert.equal((await cli(cwd, 'decide', groups[0].group, 'fix')).code, 0);
  assert.ok(St.readGeneration(gen) > g1, 'the approval write');
  const rev = JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8')).rev;
  assert.ok(Number.isInteger(rev) && rev >= 1);
});
