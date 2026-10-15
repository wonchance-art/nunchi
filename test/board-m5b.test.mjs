// M5b (the owner's text mock-ups, 2026-10-15 KST) without a browser: the lines for a first look whose full check has not
// started, a capture running (how far, and the time left), a capture that stopped (no progress for 10 minutes: the
// boundary with an injected clock, never by waiting), and the wall's "First look" / "Not checked yet" — each with a
// fixture that triggers it and one that does not; the same words on the board's Now lines, Coverage and `findings`; the
// verdict while a capture is stopped; and the board's live version, which a capture that stops changes by the clock
// alone. Invented content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from '../src/runs.mjs';
import * as P from '../src/project.mjs';
import { summary } from '../src/summary.mjs';
import { COVERAGE, NowAnnouncer, NOW_EVERY_MS } from '../src/board/shared.mjs';
import { startBoard } from '../src/board/server.mjs';
import { writeRun, scene } from './fixtures/board-project.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { leafy } from './fixtures/coverage-project.mjs';
import { boardRequest } from './fixtures/board-call.mjs';
import { stableJson, thisMachine } from '../src/stable.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-m5b-xdg-');
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));

// the owner's words, with this fixture's numbers
const IDLE = 'First look: 2 key screens · the full check has not started — tell your AI “full check”';
const RUNNING = run => `Capture running · run ${run} · 12 of 25 screens (about 6 min left)`;
const STOPPED = run => `Capture stopped · run ${run} (no progress for 10 min) — tell your AI “capture again”`;
// a whole second, so a file system that keeps whole seconds keeps it exactly
const T = Date.UTC(2026, 9, 15, 3, 0, 0);
const MIN = 60e3;

// A project: run 0001, a full check of two pages; with `quick`, run 0002, a first look of the same pages (the latest).
function project({ quick = false } = {}) {
  const root = tmp('nunchi-m5b-');
  const scenes = [scene('/', 'guest', 'normal', 'd'), scene('/pricing', 'guest', 'normal', 'd')];
  writeRun(root, '0001', { scenes, findings: [{ lens: 'L8', rule: 'target-size-min', severity: 'low', scene: scenes[0].id, route: '/', viewport: 'd', selector: 'nav a', box: null, evidence: { width: 12 } }] });
  if (quick) {
    const { run } = writeRun(root, '0002', { scenes, parent: '0001', wholeApp: false });
    const f = join(run, 'run.json');
    writeFileSync(f, stableJson({ ...JSON.parse(readFileSync(f, 'utf8')), kind: 'quick' }));
  }
  return { root, nunchi: join(root, '.nunchi'), runs: join(root, '.nunchi', 'runs') };
}
// A capture folder being written: `doc` its progress file (none when null), its last progress at `at` (ms).
function partial(p, id, doc, at = Date.now()) {
  const dir = join(p.runs, `${id}.partial`);
  mkdirSync(dir, { recursive: true });
  if (doc) { writeFileSync(join(dir, 'progress.json'), JSON.stringify(doc)); utimesSync(join(dir, 'progress.json'), new Date(at), new Date(at)); }
  utimesSync(dir, new Date(at), new Date(at));
  return dir;
}
const SWEEP = { schema: 1, kind: 'sweep', wholeApp: true, routes: 25, done: 12, routeMs: Array(12).fill(27000), pid: process.pid, ...thisMachine() };
// the summary as the board and `findings` compute it, with the clock and the process check given
function sumAt(p, now, alive = () => true) {
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const { rows, groups } = P.ledgerView(led);
  return summary({ state: led.state, rows, groups, stream: led.st.root.stream, runsDir: led.st.runsDir, captures: R.captureStates(led.st.runsDir, { now, alive }) });
}
async function board(p) {
  const b = await startBoard({ projectDir: p.root });
  const s = await (await fetch(`${b.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
  const call = async path => (await boardRequest(b.origin, path, { token: s.token })).json;
  return { b, call };
}

test('no progress, precisely: the progress file\'s time (or the folder\'s, without one); 9:59 is running, 10:00 is stopped; a writer gone on this host stops it sooner', () => {
  const p = project();
  partial(p, '0002', SWEEP, T);
  const at = (ms, alive) => R.captureStates(p.runs, { now: T + ms, alive }).map(c => [c.run, c.state, c.why]);
  assert.deepEqual(at(10 * MIN - 1, () => true), [['0002', 'running', null]], '9:59.999');
  assert.deepEqual(at(10 * MIN, () => true), [['0002', 'stopped', 'no-progress']], '10:00');
  assert.equal(R.STALE_MS, 10 * MIN);
  assert.deepEqual(R.runningCaptures(p.runs, { now: T + 10 * MIN - 1 }).map(c => c.run), ['0002']);
  assert.deepEqual(R.runningCaptures(p.runs, { now: T + 10 * MIN }), []);
  // its writer is gone (this host): stopped at once, and the reason is that; on another machine its file's time decides
  assert.deepEqual(at(1 * MIN, () => false), [['0002', 'stopped', 'ended']]);
  assert.deepEqual(at(10 * MIN, () => false), [['0002', 'stopped', 'no-progress']], 'past 10 minutes, the owner\'s reason');
  partial(p, '0002', { ...SWEEP, host: 'another-machine.invalid' }, T);
  assert.deepEqual(at(1 * MIN, () => false), [['0002', 'running', null]]);
  // a folder without a progress file (a fix probe, an older nunchi): running by its own time, never "stopped"
  rmSync(join(p.runs, '0002.partial'), { recursive: true });
  partial(p, '0003', null, T);
  assert.deepEqual(at(10 * MIN - 1, () => true), [['0003', 'running', null]]);
  assert.deepEqual(at(10 * MIN, () => true), []);
});

test('"Capture running · run N · i of n screens (about m min left)": how far, with M5\'s time left; the plain line before the first route is done', () => {
  const p = project();
  partial(p, '0002', SWEEP, T);
  let s = sumAt(p, T + MIN);
  assert.deepEqual(s.captures, [{ run: '0002', state: 'running', text: RUNNING('0002') }]);
  assert.equal(s.verdict.text, 'Too early to say · a capture is running');
  // not yet: no route done, or no progress file
  partial(p, '0002', { ...SWEEP, done: 0, routeMs: [] }, T);
  assert.deepEqual(sumAt(p, T + MIN).captures.map(c => c.text), ['Capture running · run 0002']);
  rmSync(join(p.runs, '0002.partial'), { recursive: true });
  partial(p, '0002', null, T);
  assert.deepEqual(sumAt(p, T + MIN).captures.map(c => c.text), ['Capture running · run 0002']);
  // the time left: at least a minute, rounded up; none once no route is left
  partial(p, '0002', { ...SWEEP, routes: 3, done: 2, routeMs: [100, 300] }, T);
  assert.deepEqual(sumAt(p, T + MIN).captures.map(c => c.text), ['Capture running · run 0002 · 2 of 3 screens (about 1 min left)']);
  partial(p, '0002', { ...SWEEP, routes: 3, done: 3, routeMs: [100, 300, 200] }, T);
  assert.deepEqual(sumAt(p, T + MIN).captures.map(c => c.text), ['Capture running · run 0002 · 3 of 3 screens']);
});

test('"Capture stopped · run N (no progress for 10 min) — tell your AI “capture again”": at 10:00, not at 9:59; the verdict goes by the complete runs; a later capture answers it', () => {
  const p = project();
  const before = sumAt(p, T).verdict.text;
  assert.equal(before, 'Probably · rules only — the AI review hasn’t run');
  partial(p, '0002', SWEEP, T);
  let s = sumAt(p, T + 10 * MIN - 1);
  assert.deepEqual([s.captures, s.verdict.text], [[{ run: '0002', state: 'running', text: RUNNING('0002') }], 'Too early to say · a capture is running'], '9:59.999: still running');
  s = sumAt(p, T + 10 * MIN);
  assert.deepEqual([s.captures, s.verdict.text, s.running, s.runningRuns], [[{ run: '0002', state: 'stopped', text: STOPPED('0002') }], before, false, []], '10:00: stopped, and the verdict is as if it were not there');
  // its writer gone sooner: stopped, saying so
  assert.deepEqual(sumAt(p, T + MIN, () => false).captures.map(c => c.text), ['Capture stopped · run 0002 (its process ended) — tell your AI “capture again”']);
  // a capture running after it: only that one is said
  partial(p, '0003', SWEEP, T + 9 * MIN);
  assert.deepEqual(sumAt(p, T + 10 * MIN).captures.map(c => c.text), [RUNNING('0003')]);
  // one that completed after it: nothing about the stopped one
  rmSync(join(p.runs, '0003.partial'), { recursive: true });
  writeRun(p.root, '0003', { scenes: [scene('/', 'guest', 'normal', 'd')], parent: '0001' });
  assert.deepEqual(sumAt(p, T + 10 * MIN).captures, []);
});

test('"First look: N key screens · the full check has not started — tell your AI “full check”": only while nothing runs or stopped after the first look', () => {
  const p = project({ quick: true });
  let s = sumAt(p, T);
  assert.deepEqual([s.firstLook.text, s.captures, s.verdict.text], [IDLE, [], 'Too early to say']);
  // the full check running after it: M5's line instead
  partial(p, '0003', SWEEP, T);
  s = sumAt(p, T + MIN);
  assert.deepEqual([s.firstLook.text, s.captures], ['First look: 2 key screens · full check running, 12 of 25 screens (about 6 min left)', []]);
  // that full check stopped: the stopped line, and no "has not started"
  s = sumAt(p, T + 10 * MIN);
  assert.deepEqual([s.firstLook.text, s.captures.map(c => c.text), s.verdict.text], [null, [STOPPED('0003')], 'Too early to say']);
  // another first look running: its own line
  partial(p, '0003', { ...SWEEP, kind: 'quick' }, T);
  s = sumAt(p, T + MIN);
  assert.deepEqual([s.firstLook.text, s.captures.map(c => c.text)], [null, [RUNNING('0003')]]);
  // no first look: no such line
  assert.equal(sumAt(project(), T).firstLook, null);
});

test('the same words on the board\'s Now lines, Coverage and `findings`; a capture that stops changes the live version by the clock alone', async () => {
  const p = project();
  partial(p, '0002', SWEEP);
  const { b, call } = await board(p);
  try {
    let s = await call('/api/summary');
    assert.deepEqual([s.verdict.text, s.now], ['Too early to say · a capture is running', [RUNNING('0002')]]);
    let c = await call('/api/coverage');
    assert.deepEqual(c.capture, { run: '0002', state: 'running', text: RUNNING('0002') });
    assert.equal(COVERAGE.running(c.capture.text, c.run), `${RUNNING('0002')}. This shows run 0001 until it finishes.`);
    assert.match((await cli(p.root, 'findings')).stdout, new RegExp(`\\nready to ship\\? Too early to say · a capture is running\\n${RUNNING('0002').replace(/[()]/g, '\\$&')}\\n`));
    // its last progress 10 minutes ago: nothing else is written, and the version changes all the same
    const v1 = (await call('/api/generation')).version;
    assert.equal((await call('/api/generation')).version, v1, 'steady while nothing changes');
    const old = new Date(Date.now() - 10 * MIN - 1000);
    utimesSync(join(p.runs, '0002.partial', 'progress.json'), old, old);
    const v2 = (await call('/api/generation')).version;
    assert.notEqual(v2, v1);
    s = await call('/api/summary');
    assert.deepEqual([s.verdict.text, s.now, s.running], ['Probably · rules only — the AI review hasn’t run', [STOPPED('0002')], false]);
    c = await call('/api/coverage');
    assert.deepEqual(c.capture, { run: '0002', state: 'stopped', text: STOPPED('0002') });
    // as long as it stays stopped, the version stays (its line is not announced again each minute)
    assert.equal((await call('/api/generation')).version, v2);
    assert.match((await cli(p.root, 'findings')).stdout, /\nready to ship\? Probably · rules only — the AI review hasn’t run\nCapture stopped · run 0002 \(no progress for 10 min\) — tell your AI “capture again”\n/);
  } finally { await b.close(); }
});

test('the wall during a first look: "First look" on its key screens; before any full check, "Not checked yet" on the pages it did not open; none after a full check or without a first look', async () => {
  // a first look and nothing before it
  const p = leafy({ quick: true, probes: false, runs: 0, ai: 'none' });
  let { b, call } = await board(p);
  try {
    const w = await call('/api/screens');
    const first = w.scenes.filter(s => s.look === 'first'), notYet = w.scenes.filter(s => s.look === 'not-yet');
    assert.equal(first.length, w.scenes.length - notYet.length, 'every screen the first look captured');
    assert.deepEqual([first.length, [...new Set(first.map(s => s.route))]], [12, ['/', '/garden', '/cart']]);
    // the pages it did not open (its flow names every page), one card per person × width, in the flow's order
    // (this fixture's flow orders only the pages it opened: the others by name)
    assert.deepEqual([...new Set(notYet.map(s => s.route))], ['/checkout', '/garden/[plot]', '/help', '/login']);
    assert.deepEqual([notYet.length, notYet.slice(0, 4).map(s => `${s.person} ${s.viewport}`)], [16, ['guest d', 'guest m', 'signed-in d', 'signed-in m']]);
    assert.deepEqual(notYet[0], { key: '0001/not-yet.guest.d:/checkout', run: '0001', id: 'not-yet.guest.d:/checkout', route: '/checkout', person: 'guest', state: 'normal', viewport: 'd',
      h1: null, label: 'Visitor · Desktop · Normal', status: 'not-captured', reason: null, redirected: false, finalPath: null, finalOrigin: null, img: null, badge: 'Not checked yet', kind: 'notyet',
      note: '', findings: [], look: 'not-yet', checked: false, changed: null, ai: null, group: '/', open: 0 });
    assert.equal(notYet.find(s => s.route === '/garden/[plot]').group, '/garden', 'in its section');
    assert.deepEqual(w.groups.map(g => g.id), ['/', '/garden']);
  } finally { await b.close(); }
  // a page that needs a sample address is skipped by the full check too: not "not checked yet"
  const meta = join(p.nunchi, 'runs', '0001', 'run.json');
  writeFileSync(meta, stableJson({ ...JSON.parse(readFileSync(meta, 'utf8')), skipped: [{ route: '/garden/[plot]', reason: 'needs-sample' }] }));
  ({ b, call } = await board(p));
  try {
    assert.deepEqual([...new Set((await call('/api/screens')).scenes.filter(s => s.look === 'not-yet').map(s => s.route))], ['/checkout', '/help', '/login']);
  } finally { await b.close(); }
  // a first look written before M5b (its flow names only its own pages): its screens only
  const flow = join(p.nunchi, 'runs', '0001', 'flow.json');
  const doc = JSON.parse(readFileSync(flow, 'utf8'));
  writeFileSync(flow, stableJson({ ...doc, nodes: doc.nodes.filter(n => n.captured) }));
  ({ b, call } = await board(p));
  try {
    const w = await call('/api/screens');
    assert.deepEqual([w.scenes.length, w.scenes.every(s => s.look === 'first')], [12, true]);
  } finally { await b.close(); }
  // a first look after full checks (M5b review): the pages it did not open were checked by the last full check, which
  // Coverage shows with their findings; the wall says "First look" on its own screens and adds nothing
  const after = leafy({ quick: true, probes: false });
  ({ b, call } = await board(after));
  try {
    const w = await call('/api/screens');
    assert.deepEqual([w.run, w.baseline, w.scenes.length, w.scenes.every(s => s.look === 'first')], ['0005', '0004', 12, true]);
  } finally { await b.close(); }
  // no first look: no such word
  const q = leafy({ probes: false });
  ({ b, call } = await board(q));
  try {
    assert.ok((await call('/api/screens')).scenes.every(s => !('look' in s)));
  } finally { await b.close(); }
});

// ---- the review of PR #36 (2026-10-15 KST) ----------------------------------------------------------------------------

test('review: the same machine is the same host, boot and pid namespace — a writer of another container with the host\'s name is not asked', () => {
  const p = project();
  const machine = thisMachine();
  partial(p, '0002', { ...SWEEP, pid: 999999 }, T);
  const at = doc => { partial(p, '0002', doc, T); return R.captureStates(p.runs, { now: T + MIN, alive: () => false, machine }).map(c => [c.state, c.why]); };
  assert.deepEqual(at({ ...SWEEP }), [['stopped', 'ended']], 'this machine: its writer is gone');
  assert.deepEqual(at({ ...SWEEP, boot: 'another-boot' }), [['running', null]], 'another boot: its file\'s time decides');
  assert.deepEqual(at({ ...SWEEP, ns: 'pid:[1]' }), [['running', null]], 'another pid namespace (a container with host networking)');
  const { boot, ns, ...hostOnly } = SWEEP;
  assert.deepEqual(at(hostOnly).map(x => x[0]), [machine.boot === null && machine.ns === null ? 'stopped' : 'running'], 'a file that names the host only (an older nunchi)');
});

test('review: a capture\'s progress file is there from the moment its folder is made, and goes only as the run is completed', () => {
  const dir = join(project().runs);
  const doc = { schema: 1, kind: 'sweep', wholeApp: true, skipped: [], routes: 3, done: 0, routeMs: [], pid: process.pid, ...thisMachine() };
  const r = R.startRun(dir, { progress: doc });
  assert.deepEqual(JSON.parse(readFileSync(join(r.path, R.PROGRESS_FILE), 'utf8')), doc);
  assert.deepEqual(R.captureStates(dir).map(c => [c.run, c.state, c.progress?.done]), [[r.id, 'running', 0]]);
  // the end phase (source map, inventory) still says how far it is; finishRun takes the file away, then renames
  writeFileSync(join(r.path, 'source-map.json'), '{}');
  assert.ok(existsSync(join(r.path, R.PROGRESS_FILE)));
  const final = R.finishRun(dir, r.id);
  assert.deepEqual([existsSync(join(final, R.PROGRESS_FILE)), existsSync(join(final, 'source-map.json'))], [false, true]);
  // a fix probe makes its folder without one, as before
  const q = R.startRun(dir);
  assert.equal(existsSync(join(q.path, R.PROGRESS_FILE)), false);
});

test('review: the Now lines are announced at most every 10 s — what changed first, never only the first line, and a change inside the 10 s said once they pass', () => {
  const FCD = 'Full check done: 2 new groups', run = n => `Capture running · run 0004 · ${n} of 25 screens (about 6 min left)`, STOP = STOPPED('0004');
  const a = new NowAnnouncer();
  assert.deepEqual(a.update([FCD], 0), { say: FCD, wait: null }, 'on load: the first line');
  assert.deepEqual(a.update([FCD], 4000), { say: null, wait: null }, 'nothing changed');
  // a capture starts: its line is said though it is not the first
  assert.deepEqual(a.update([FCD, run(3)], 12000), { say: run(3), wait: null });
  // a route, then the capture stops 1 s later: nothing is said inside the 10 s, then the lines as they are by then
  assert.deepEqual(a.update([FCD, run(4)], 15000), { say: null, wait: 7000 });
  assert.deepEqual(a.update([FCD, STOP], 16000), { say: null, wait: 6000 });
  assert.deepEqual(a.update([FCD, STOP], 12000 + NOW_EVERY_MS), { say: STOP, wait: null }, 'the stop is said, never dropped');
  assert.deepEqual(a.update([FCD, STOP], 60000), { say: null, wait: null }, 'and once');
  // several new lines at once: all of them, in the board's order
  assert.deepEqual(a.update(['First look: 2 key screens · the full check has not started — tell your AI “full check”', STOP, 'A is fixing B · 1 min'], 70000),
    { say: 'First look: 2 key screens · the full check has not started — tell your AI “full check”. A is fixing B · 1 min', wait: null });
  // nothing on the board at first: the first lines that come are said
  const b = new NowAnnouncer();
  assert.deepEqual(b.update([], 0), { say: null, wait: null });
  assert.deepEqual(b.update([FCD, run(1)], 20000), { say: `${FCD}. ${run(1)}`, wait: null });
});

test('review: one order of the Now lines for the board and `findings` (the full check done, the first look, the captures)', async () => {
  const p = project({ quick: true });
  writeRun(p.root, '0003', { scenes: [scene('/', 'guest', 'normal', 'd'), scene('/pricing', 'guest', 'normal', 'd')], parent: '0002' });
  partial(p, '0004', SWEEP);
  const { b, call } = await board(p);
  try {
    const now = (await call('/api/summary')).now;
    assert.deepEqual(now, ['Full check done: 0 new groups', RUNNING('0004')]);
    const out = (await cli(p.root, 'findings')).stdout;
    assert.ok(out.includes(`\n${now.join('\n')}\n`), out);
  } finally { await b.close(); }
});

test('review: the live version changes with how far a capture is, and with why it stopped; Coverage says the newest capture', async () => {
  const p = leafy({ probes: false });
  const dir = join(p.nunchi, 'runs', '0005.partial');
  const prog = (doc, at = Date.now()) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'progress.json'), JSON.stringify(doc)); utimesSync(join(dir, 'progress.json'), new Date(at), new Date(at)); };
  prog({ ...SWEEP, done: 1, routeMs: [27000] });
  const { b, call } = await board(p);
  try {
    const version = async () => (await call('/api/generation')).version;
    await call('/api/summary');                                   // the first model folds the runs (a generation of its own)
    const v1 = await version();
    assert.equal(await version(), v1, 'steady while nothing changes');
    prog({ ...SWEEP, done: 2, routeMs: [27000, 27000] });
    const v2 = await version();
    assert.notEqual(v2, v1, 'a route done (still running)');
    // its writer gone (this machine): stopped, "its process ended"; then 10 minutes without progress: the reason changes
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    prog({ ...SWEEP, done: 2, routeMs: [27000, 27000], pid: dead });
    assert.equal((await call('/api/summary')).now[0], 'Capture stopped · run 0005 (its process ended) — tell your AI “capture again”');
    const v3 = await version();
    assert.equal(await version(), v3);
    prog({ ...SWEEP, done: 2, routeMs: [27000, 27000], pid: dead }, Date.now() - 10 * MIN - 1000);
    assert.notEqual(await version(), v3, 'still stopped, another reason');
    assert.equal((await call('/api/summary')).now[0], STOPPED('0005'));
    // two captures running: Coverage says the newest, as Progress lists both
    rmSync(dir, { recursive: true });
    partial({ runs: join(p.nunchi, 'runs') }, '0005', { ...SWEEP, done: 1, routeMs: [27000] });
    partial({ runs: join(p.nunchi, 'runs') }, '0006', SWEEP);
    const c = await call('/api/coverage');
    assert.deepEqual([c.capture?.run, c.running], ['0006', ['0005', '0006']]);
  } finally { await b.close(); }
});
