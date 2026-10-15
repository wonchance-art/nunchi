// The fast first run (design 0.1-c §6, M5) without a browser: which screens a quick run picks (deterministic, every
// tie-break), the recording's coverage and merge, the presence-only fold, which run each command builds on, gc, the
// fix loop, and the board's words ("First look: …", "Too early to say", "Full check done: …"). Invented content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rankQuick, quickChoice, QUICK_MAX } from '../src/quick.mjs';
import { Recording } from '../src/network.mjs';
import { minutesLeft } from '../src/summary.mjs';
import * as L from '../src/ledger.mjs';
import * as R from '../src/runs.mjs';
import { STALE_MS } from '../src/runs.mjs';
import { withLock } from '../src/stable.mjs';
import * as F from '../src/fix/loop.mjs';
import { stableJson } from '../src/stable.mjs';
import { startBoard } from '../src/board/server.mjs';
import { writeRun, scene, tmp } from './fixtures/board-project.mjs';
import { fixProject } from './fixtures/fix-project.mjs';
import { ctxOf, stateDir, latest as latestRecord } from './fixtures/fix-loop-helpers.mjs';
import { boardRequest } from './fixtures/board-call.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-quick-xdg-');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

// ---- which screens: rankQuick -----------------------------------------------------------------------------------

const link = (path, landmark = 'nav') => ({ path, landmark, selector: 'a', visible: true });
const homeScreen = (person, viewport, links, extra = {}) => ({ id: `~.${person}.normal.${viewport}`, person, viewport, status: 'captured', links, ...extra });
const APP = ['/', '/about', '/app', '/app/notes', '/app/tasks', '/blog', '/blog/[slug]', '/careers', '/contact', '/help', '/legal', '/pricing', '/zebra'];

test('quick scope: / first, then the home page\'s navigation in the order a visitor meets it, then one per section, up to 8', () => {
  const home = [
    homeScreen('signed-in', 'd', [link('/app/tasks')]),                                 // met third: signed in, desktop
    homeScreen('guest', 'm', [link('/help'), link('/pricing')]),                         // met second: phone (a menu only it shows)
    homeScreen('guest', 'd', [link('/', 'header'), link('/pricing'), link('/about', 'header'), link('/legal', 'footer'), link('/nowhere'), link('/blog/first-light', null)]),
  ];
  const r = rankQuick({ routes: APP, home });
  assert.deepEqual(r.routes, ['/', '/pricing', '/about', '/help', '/app/tasks', '/blog', '/careers', '/contact']);
  assert.equal(r.routes.length, QUICK_MAX);
  assert.deepEqual(r.why, { '/': 'home', '/pricing': 'navigation', '/about': 'navigation', '/help': 'navigation', '/app/tasks': 'navigation', '/blog': 'section', '/careers': 'section', '/contact': 'section' });
  // a footer is not navigation, a link nowhere is skipped, a link outside a landmark is not navigation; the `app` section
  // is already in (by /app/tasks), so it gets no second route; blog is bigger than the one-route sections; legal and
  // zebra do not fit
  assert.equal(quickChoice(r), '/ (home) · /pricing, /about, /help, /app/tasks (home page navigation) · /blog, /careers, /contact (one per section)');
});

test('quick scope tie-breaks: bigger sections first, then by name; a section\'s route is the shallowest, static before dynamic, then by name', () => {
  const routes = ['/shop/[id]', '/shop/cart', '/shop/z', '/docs/a/b', '/docs/[x]', '/b', '/a', '/c/[id]', '/c/[id]/edit'];
  // no home page: sections only
  assert.deepEqual(rankQuick({ routes }).routes, ['/shop/cart', '/c/[id]', '/docs/[x]', '/a', '/b']);
  assert.deepEqual(rankQuick({ routes }).why['/shop/cart'], 'section');
  // the same app, listed in another order and with the home screens in another order: the same choice
  const home = [homeScreen('guest', 'd', [link('/b'), link('/shop/z')]), homeScreen('guest', 'm', [link('/a')])];
  const once = rankQuick({ routes: [...routes, '/'], home });
  assert.deepEqual(once.routes, ['/', '/b', '/shop/z', '/a', '/c/[id]', '/docs/[x]']);
  for (let i = 0; i < 5; i++) {
    const shuffled = [...routes, '/'].sort(() => (i % 2 ? 1 : -1)).reverse();
    assert.deepEqual(rankQuick({ routes: shuffled, home: [...home].reverse() }), once);
  }
  assert.deepEqual(rankQuick({ routes, max: 2 }).routes, ['/shop/cart', '/c/[id]'], 'the cap counts every route');
});

test('quick scope: only the site\'s navigation counts — not a footer\'s nav, a card\'s header or a link the screen does not show (review of PR #33)', () => {
  const routes = ['/', '/about', '/blog', '/legal', '/menu-only', '/pricing'];
  const home = [homeScreen('guest', 'd', [
    { path: '/legal', landmark: 'nav', navigation: false, visible: true },                // a nav inside the footer
    { path: '/blog', landmark: 'header', navigation: false, visible: true },              // a card's header in main
    { path: '/menu-only', landmark: 'nav', navigation: true, visible: false },            // a menu the screen does not show
    { path: '/pricing', landmark: 'nav', navigation: true, visible: true },
    { path: '/about', landmark: 'header', navigation: true, visible: true },              // the page banner
  ])];
  const r = rankQuick({ routes, home, max: 3 });
  assert.deepEqual(r.routes, ['/', '/pricing', '/about']);
  // links captured before `navigation` existed fall back to their nearest landmark
  assert.deepEqual(rankQuick({ routes, home: [homeScreen('guest', 'd', [link('/legal'), link('/blog', 'footer')])], max: 2 }).routes, ['/', '/legal']);
});

test('quick scope: a home screen that was not captured gives no links, a redirected one does; a link to a route without a sample is skipped', () => {
  const routes = ['/', '/inbox', '/settings', '/zz'];
  const known = [...routes, '/posts/[id]'];
  const home = [
    homeScreen('guest', 'd', [link('/settings')], { status: 'capture-failed', reason: 'no-dom' }),
    homeScreen('signed-in', 'd', [link('/posts/7'), link('/inbox')], { redirected: true, finalPath: '/inbox' }),
  ];
  const r = rankQuick({ routes, known, home });
  assert.deepEqual(r.routes, ['/', '/inbox', '/settings', '/zz']);
  assert.deepEqual([r.why['/inbox'], r.why['/settings']], ['navigation', 'section']);
  // no `/` in the app: sections only, nothing is "home"
  assert.deepEqual(rankQuick({ routes: ['/b', '/a'], home }).why, { '/a': 'section', '/b': 'section' });
});

// ---- the time left ---------------------------------------------------------------------------------------------

test('time left: the mean measured time of the routes done, times the routes left, rounded up to whole minutes', () => {
  assert.equal(minutesLeft({ routes: 25, done: 12, routeMs: Array(12).fill(27000) }), 6, '13 × 27 s = 5.85 min → about 6');
  assert.equal(minutesLeft({ routes: 25, done: 2, routeMs: [10000, 50000] }), 12, 'the mean of 30 s × 23 = 11.5 min → 12');
  assert.equal(minutesLeft({ routes: 3, done: 2, routeMs: [500, 700] }), 1, 'never "0 min": at least 1');
  assert.equal(minutesLeft({ routes: 25, done: 0, routeMs: [] }), null, 'nothing measured yet: no estimate');
  assert.equal(minutesLeft({ routes: 4, done: 4, routeMs: [1000, 1000, 1000, 1000] }), null, 'no route left: no estimate');
});

// ---- the recording: coverage and merge ------------------------------------------------------------------------------

const res = (n, extra = {}) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ n, ...extra }) });

test('recording coverage: which screens it holds; one written before coverage was kept holds every route', () => {
  const dir = tmp('nunchi-quick-har-');
  const rec = new Recording();
  assert.equal(rec.covers('/a', 'm'), false);
  rec.recorded('/a', 'm'); rec.recorded('/a', 'd'); rec.recorded('/a', 'm');
  assert.deepEqual(rec.routes, { '/a': ['d', 'm'] });
  assert.equal(rec.covers('/a', 'd'), true);
  assert.equal(rec.covers('/b', 'm'), false);
  rec.save(join(dir, 'guest.json'));
  assert.deepEqual(Recording.load(join(dir, 'guest.json')).routes, { '/a': ['d', 'm'] });
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ schema: 1, entries: { 'GET app:/x': [res(1)] } }));
  const old = Recording.load(join(dir, 'old.json'));
  assert.equal(old.routes, null);
  assert.equal(old.covers('/anything', 'm'), true, 'an older recording is replayed as before');
  old.recorded('/b', 'm');
  assert.equal(old.routes, null, 'and stays so');
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ schema: 1, entries: {}, routes: { '/a': 'm' } }));
  assert.throws(() => Recording.load(join(dir, 'bad.json')), e => e.code === 'BAD_RECORDING');
});

test('merge: a request the recording holds is answered from it (as replay would), one it lacks goes live once and is added in order', () => {
  const rec = new Recording({ 'GET app:/api/shared': [res(1)] });
  const load = rec.loader();
  assert.equal(JSON.parse(load.ask('GET app:/api/shared').res.body).n, 1);
  assert.equal(JSON.parse(load.ask('GET app:/api/shared').res.body).n, 1, 'beyond the recorded count the last repeats, never live: a screen already recorded keeps its answers');
  const a = load.ask('GET app:/api/new'), b = load.ask('GET app:/api/new');
  assert.equal(a.res, null); assert.equal(b.res, null, 'new in this page load: every ask of it goes live');
  b.add(res(3, { access_token: 'tok-secret' })); a.add(res(2));                          // answers can arrive out of order
  assert.deepEqual(rec.entries['GET app:/api/new'].map(e => JSON.parse(e.body).n), [2], 'added by the order asked, as recording adds');
  assert.equal(rec.entries['GET app:/api/shared'].length, 1, 'never extended');
  const again = rec.loader();
  assert.equal(JSON.parse(again.ask('GET app:/api/new').res.body).n, 2, 'the next page load replays what was added');
  rec.loader().ask('GET app:/api/tok').add(res(4, { access_token: 'tok-secret' }));
  assert.equal(JSON.parse(rec.entries['GET app:/api/tok'][0].body).access_token, '[redacted]', 'tokens are scrubbed as when recording');
});

test('save: a lock that stays busy never loses the run — what it recorded is written beside the file, and said (review of PR #33)', () => {
  const dir = tmp('nunchi-quick-busy-');
  const path = join(dir, 'guest.json');
  new Recording({ 'GET app:/a': [res(1)] }).save(path);
  const before = readFileSync(path, 'utf8');
  const mine = new Recording({ 'GET app:/b': [res(2)] }, { '/b': ['m'] });
  let r;
  withLock(path, () => { r = mine.save(path, { timeoutMs: 100 }); });                 // another capture holds it
  assert.equal(r.saved, false);
  assert.equal(r.side, `${path}.unsaved-${process.pid}`);
  assert.equal(readFileSync(path, 'utf8'), before, 'the recording is untouched');
  assert.deepEqual(Recording.load(r.side).routes, { '/b': ['m'] });
  assert.deepEqual(mine.save(path), { saved: true }, 'free again: saved');
  assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.lock.d')), []);
});

test('merge on save: under the person\'s lock, merged with the file as it is then; what was recorded keeps its answers; the same bytes either way', () => {
  const dir = tmp('nunchi-quick-save-');
  const path = join(dir, 'guest.json');
  const base = new Recording({ 'GET app:/a': [res(1)] }); base.recorded('/a', 'm'); base.save(path);
  // two captures loaded the same file; each records a screen; they save one after the other
  const one = Recording.load(path), two = Recording.load(path);
  one.loader().ask('GET app:/b').add(res(2)); one.recorded('/b', 'm');
  two.loader().ask('GET app:/c').add(res(3)); two.recorded('/c', 'd');
  two.entries['GET app:/a'] = [res(99)];                                              // a different answer for /a: refused
  one.save(path); two.save(path);
  const saved = Recording.load(path);
  assert.deepEqual(Object.fromEntries(Object.entries(saved.entries).map(([k, v]) => [k, v.map(e => JSON.parse(e.body).n)])), { 'GET app:/a': [1], 'GET app:/b': [2], 'GET app:/c': [3] });
  assert.deepEqual(saved.routes, { '/a': ['m'], '/b': ['m'], '/c': ['d'] });
  // a longer list with the same start is a recording run that saw more of one page load: kept
  const more = Recording.merge(saved, new Recording({ 'GET app:/a': [res(1), res(5)] }, {}));
  assert.deepEqual(more.entries['GET app:/a'].map(e => JSON.parse(e.body).n), [1, 5]);
  assert.equal(stableJson(Recording.merge(saved, two).doc()), stableJson(Recording.merge(Recording.load(path), Recording.load(path)).doc()), 'deterministic');
  assert.deepEqual(readFileSync(path, 'utf8'), stableJson(saved.doc()));
  assert.ok(!existsSync(`${path}.lock.d`), 'the lock is released');
});

// ---- the fold: presence-only ----------------------------------------------------------------------------------------

const fnd = (route, cell, name) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${route.slice(1) || '~'}.${cell}`, route, viewport: cell.split('.')[2], selector: 'main > button', box: null, evidence: { name } });
const sc = (route, cell) => { const [person, state, viewport] = cell.split('.'); return { id: `${route.slice(1) || '~'}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200 }; };

test('a quick run is presence-only: it adds and brings back, never fixes, never marks a run blind; the next sweep still fixes like for like', () => {
  const run = (id, kind, names, extra = {}) => ({ id, kind, scope: { routes: ['/a'] }, wholeApp: kind === 'sweep', scenes: [sc('/a', 'guest.normal.m')], findings: L.annotate(names.map(n => fnd('/a', 'guest.normal.m', n))), ...extra });
  let st = L.foldRun(L.emptyState(), run('0001', 'sweep', ['x']));
  st = L.foldRun(st, run('0002', 'sweep', []));
  const x = () => Object.values(st.items).find(i => i.evidence.name === 'x');
  assert.equal(x().goneAt, '0002');
  st = L.foldRun(st, run('0003', 'quick', ['x', 'y']));
  assert.deepEqual([x().goneAt, x().regressedAt], [null, '0003'], 'a quick run brings an item back');
  const y = () => Object.values(st.items).find(i => i.evidence.name === 'y');
  assert.equal(y().firstSeen, '0003', 'and adds what it saw');
  st = L.foldRun(st, run('0004', 'quick', [], { health: { problems: [{ status: 'recording-stale', scenes: 1, of: 1 }] } }));
  assert.deepEqual([x().goneAt, y().goneAt, y().lookedAt], [null, null, '0003'], 'a quick run that looked again and did not see them fixes nothing');
  assert.equal(st.blind?.['0004'], undefined, 'and says nothing about what it could not tell');
  assert.deepEqual([L.latestRunOf(st), L.latestSweepOf(st), L.foldKindOf(st, '0004'), L.foldKindOf(st, '0002')], ['0004', '0002', 'quick', 'sweep']);
  st = L.foldRun(st, run('0005', 'sweep', []));
  assert.deepEqual([x().goneAt, y().goneAt], ['0005', '0005'], 'a quick run does not hold back the next sweep');
});

// ---- which run: hunt, verify, gc ------------------------------------------------------------------------------------

function runsFolder(kinds) {
  const dir = join(tmp('nunchi-quick-runs-'), 'runs');
  kinds.forEach((kind, i) => {
    const id = String(i + 1).padStart(4, '0');
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'run.json'), JSON.stringify({ id, kind }));
    writeFileSync(join(dir, id, 'manifest.json'), JSON.stringify({ scenes: [] }));
  });
  return dir;
}

test('the latest non-quick run: what hunt and verify default to', () => {
  const dir = runsFolder(['sweep', 'quick', 'sweep', 'quick', 'fix-probe']);
  writeFileSync(join(dir, 'latest'), '0004\n');
  assert.deepEqual([R.latestRun(dir), R.latestSweep(dir)], ['0004', '0003']);
  writeFileSync(join(dir, 'latest'), '0003\n');
  assert.equal(R.latestSweep(dir), '0003');
  assert.equal(R.latestSweep(runsFolder(['quick'])), null, 'only a first look: none');
});

test('gc: quick runs a sweep came after go first (with fix probes), unless an open item names them or the ledger has not folded them', () => {
  const dir = runsFolder(['quick', 'sweep', 'quick', 'sweep', 'sweep', 'quick']);
  writeFileSync(join(dir, 'latest'), '0006\n');
  const all = new Set(['0001', '0002', '0003', '0004', '0005', '0006']);
  let r = R.gcRuns(dir, { keep: 3, folded: all, pinned: new Set(['0003']) });
  assert.deepEqual(r.removed, ['0001', '0002'], '0001 replaced by a sweep; 0002 past --keep 3 (0004–0006: a replaced first look does not count); 0003 pinned; 0006 has no sweep after it');
  assert.deepEqual(r.kept, ['0003', '0004', '0005', '0006']);
  const dir2 = runsFolder(['quick', 'sweep']);
  r = R.gcRuns(dir2, { keep: 5, folded: new Set(['0002']) });
  assert.deepEqual(r.removed, [], 'a quick run the ledger has not folded stays');
  r = R.gcRuns(dir2, { keep: 5, folded: new Set(['0001', '0002']) });
  assert.deepEqual(r.removed, ['0001'], 'once folded, the first look a sweep came after goes, whatever --keep');
});

test('the fix loop copies the last sweep, never a quick first look; with only a first look it refuses and says why', async () => {
  const p = await fixProject({ prefix: 'nunchi-quick-fix-' });
  // a first look after the sweep: one route, normal state, phone only
  await p.cap.capture({ baseUrl: 'http://127.0.0.1:3999', scenes: [{ route: '/', path: '/', person: 'guest' }], out: join(p.nunchi, 'runs', '0002'), viewports: ['m'], states: ['normal'],
    runMeta: { schema: 1, id: '0002', kind: 'quick', worktree: 'main', wholeApp: false, scope: { routes: ['/'], persons: ['guest'], viewports: ['m'], states: ['normal'], changedSince: null } } });
  writeFileSync(join(p.nunchi, 'runs', 'latest'), '0002\n');
  p.cap.calls.length = 0;
  const s = await F.startFix(ctxOf(p), p.group);
  assert.equal(s.code, 0, s.lines.join('\n'));
  const rec = latestRecord(p);
  assert.equal(rec.sweep, '0001', 'the probes copy the sweep');
  assert.deepEqual(p.cap.calls.map(c => [c.kind, c.baseUrl, c.viewports.join(',')]), [['fix-probe', 'http://127.0.0.1:3000', 'd,m']]);
  F.abortFix(ctxOf(p), p.group);
  // the same project with its sweep read as a first look
  const q = await fixProject({ prefix: 'nunchi-quick-fix2-' });
  const meta = JSON.parse(readFileSync(join(q.nunchi, 'runs', '0001', 'run.json'), 'utf8'));
  writeFileSync(join(q.nunchi, 'runs', '0001', 'run.json'), JSON.stringify({ ...meta, kind: 'quick', wholeApp: false }));
  rmSync(join(stateDir(q), 'ledger.json'));
  const r = await F.startFix(ctxOf(q), q.group);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /Only a quick first look so far: the fix loop re-checks against a full check/);
});

// ---- the board's words ------------------------------------------------------------------------------------------------

// A project whose first run is a quick first look of two screens; `progress` a full check being captured after it.
function firstLookProject() {
  const root = tmp('nunchi-quick-board-');
  const scenes = [scene('/', 'guest', 'normal', 'd'), scene('/pricing', 'guest', 'normal', 'd')];
  const f = { lens: 'L8', rule: 'target-size-min', severity: 'low', scene: scenes[0].id, route: '/', viewport: 'd', selector: 'nav a', box: null, evidence: { width: 12 } };
  writeRun(root, '0001', { scenes, findings: [f], wholeApp: false });
  const runJson = join(root, '.nunchi', 'runs', '0001', 'run.json');
  writeFileSync(runJson, JSON.stringify({ ...JSON.parse(readFileSync(runJson, 'utf8')), kind: 'quick' }));
  const progress = doc => { mkdirSync(join(root, '.nunchi', 'runs', '0002.partial'), { recursive: true }); writeFileSync(join(root, '.nunchi', 'runs', '0002.partial', 'progress.json'), JSON.stringify(doc)); };
  return { root, nunchi: join(root, '.nunchi'), scenes, progress };
}
async function boardSummary(p) {
  const b = await startBoard({ projectDir: p.root });
  try {
    const session = await (await fetch(`${b.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    return (await boardRequest(b.origin, '/api/summary', { token: session.token })).json;
  } finally { await b.close(); }
}

test('board: "First look: N key screens · full check running, i of n screens (about m min left)" and "Too early to say" until the full check lands', async () => {
  const p = firstLookProject();
  const full = { schema: 1, kind: 'sweep', wholeApp: true, routes: 25, done: 12, routeMs: Array(12).fill(27000) };
  p.progress(full);
  let s = await boardSummary(p);
  assert.equal(s.verdict.text, 'Too early to say · full check running');
  assert.deepEqual(s.now, ['First look: 2 key screens · full check running, 12 of 25 screens (about 6 min left)']);
  assert.deepEqual(s.firstLook, { run: '0001', screens: 2, full: { run: '0002', done: 12, routes: 25, minutesLeft: 6, wholeApp: true } });
  // the CLI says the same
  const out = await cli(p.root, 'findings');
  assert.match(out.stdout, /ready to ship\? Too early to say · full check running\nFirst look: 2 key screens · full check running, 12 of 25 screens \(about 6 min left\)\n/);
  // nothing measured yet: no estimate
  p.progress({ ...full, done: 0, routeMs: [] });
  assert.deepEqual((await boardSummary(p)).now, ['First look: 2 key screens · full check running, 0 of 25 screens']);
  // a sweep that is not of the whole app is matched too, and says why in capture's own words (review of PR #33)
  p.progress({ ...full, wholeApp: false, skipped: [{ route: '/posts/[id]', reason: 'needs-sample' }] });
  assert.deepEqual((await boardSummary(p)).now, ['First look: 2 key screens · full check running, 12 of 25 screens (about 6 min left) · skipped /posts/[id] (needs-sample)']);
  p.progress({ ...full, wholeApp: false, routesGiven: true, routes: 2, done: 0, routeMs: [] });
  assert.deepEqual((await boardSummary(p)).now, ['First look: 2 key screens · full check running, 0 of 2 screens · only the routes given (--routes)']);
  // another first look running: the plain line, and no word of a full check
  p.progress({ ...full, kind: 'quick' });
  s = await boardSummary(p);
  assert.deepEqual([s.verdict.text, s.now], ['Too early to say · a capture is running', ['Capture running · run 0002']]);
  // nothing running: still too early, and no line about a check that is not happening
  rmSync(join(p.nunchi, 'runs', '0002.partial'), { recursive: true });
  s = await boardSummary(p);
  assert.deepEqual([s.verdict.text, s.now], ['Too early to say', []]);
  assert.match((await cli(p.root, 'findings')).stdout, /run 0001 is a quick first look \(2 key screens\): it marks nothing fixed, and no full check is running/);
});

test('board: a capture whose writer is gone, or that wrote nothing for 10 minutes, is not "running" (review of PR #33)', async () => {
  const p = firstLookProject();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;                              // a process that has ended
  const full = { schema: 1, kind: 'sweep', wholeApp: true, routes: 25, done: 12, routeMs: Array(12).fill(27000), host: hostname() };
  p.progress({ ...full, pid: process.pid });
  assert.equal((await boardSummary(p)).verdict.text, 'Too early to say · full check running', 'its writer runs');
  p.progress({ ...full, pid: dead });
  let s = await boardSummary(p);
  assert.deepEqual([s.verdict.text, s.now], ['Too early to say', []], 'killed: its folder is left, but nothing runs');
  // another machine's writer cannot be asked: its file's time decides
  p.progress({ ...full, pid: dead, host: 'another-machine.invalid' });
  assert.equal((await boardSummary(p)).verdict.text, 'Too early to say · full check running');
  const old = new Date(Date.now() - STALE_MS - 60e3);
  utimesSync(join(p.nunchi, 'runs', '0002.partial', 'progress.json'), old, old);
  assert.deepEqual((await boardSummary(p)).now, [], 'nothing written for over 10 minutes');
  // a folder without a progress file (a fix probe, an older nunchi) counts by its own time
  rmSync(join(p.nunchi, 'runs', '0002.partial', 'progress.json'));
  assert.deepEqual((await boardSummary(p)).now, ['Capture running · run 0002']);
  utimesSync(join(p.nunchi, 'runs', '0002.partial'), old, old);
  s = await boardSummary(p);
  assert.deepEqual([s.verdict.text, s.now], ['Too early to say', []]);
  // the clock and the process check are the function's own: a test can give them
  assert.deepEqual(R.runningCaptures(join(p.nunchi, 'runs'), { now: old.getTime() + 1000 }).map(x => x.run), ['0002']);
});

test('board: "Full check done: N new groups" once the full check lands after a first look; the verdict is the formula again', async () => {
  const p = firstLookProject();
  const scenes = [...p.scenes, scene('/help', 'guest', 'normal', 'd'), scene('/help', 'guest', 'error', 'd')];
  const f = (rule, sc, selector, severity = 'medium') => ({ lens: 'L6', rule, severity, scene: sc.id, route: sc.route, viewport: 'd', selector, box: null, evidence: { text: 'x' } });
  writeRun(p.root, '0002', { scenes, parent: '0001', findings: [
    { lens: 'L8', rule: 'target-size-min', severity: 'low', scene: scenes[0].id, route: '/', viewport: 'd', selector: 'nav a', box: null, evidence: { width: 12 } },
    f('raw-error-text', scenes[3], 'main p.err'), f('dead-href', scenes[2], 'main a.more')] });
  const s = await boardSummary(p);
  assert.deepEqual(s.now, ['Full check done: 2 new groups'], 'the first look\'s group is not new');
  assert.deepEqual(s.fullCheckDone, { run: '0002', newGroups: 2 });
  assert.equal(s.verdict.text, 'Probably · rules only — the AI review hasn’t run');
  assert.match((await cli(p.root, 'findings')).stdout, /\nFull check done: 2 new groups\n/);
  // the next capture lands: the line goes
  writeRun(p.root, '0003', { scenes, parent: '0002', findings: [] });
  assert.deepEqual((await boardSummary(p)).now, []);
});
