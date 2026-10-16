// The capture bar and the chat's start and end lines (the owner's text mock-up, 2026-10-16 KST, approved as
// recommended) without a browser: the summary's `bar` for each state — the full check running (how far, the time left,
// none before the first route, "no progress", a partial check's "skipped"), another capture running (M5b's words, with
// and without a progress file), a capture stopped, the full check done — each with a fixture that shows it and one that
// does not; which Now lines it stands for (they are not listed twice) while `findings` keeps them all; the percentage's
// bounds; the same bar on /api/summary; the announcer's words for it (only when a capture starts, finishes or stops);
// the start line's "about N min" from a measured basis only; the skill's words; and the page's storage kept in
// try/catch. Invented content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../src/runs.mjs';
import * as P from '../src/project.mjs';
import { summary, barPct, timeBasis, minutesFor, fullCheckStartedText, fullCheckDoneOf } from '../src/summary.mjs';
import { barSay, BAR_WORDS, NowAnnouncer } from '../src/board/shared.mjs';
import { startBoard } from '../src/board/server.mjs';
import { writeRun, scene } from './fixtures/board-project.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { boardRequest } from './fixtures/board-call.mjs';
import { stableJson, thisMachine } from '../src/stable.mjs';

process.env.XDG_STATE_HOME = tmp('nunchi-bar-xdg-');
const T = Date.UTC(2026, 9, 16, 3, 0, 0);
const MIN = 60e3;
const SCENES = [scene('/', 'guest', 'normal', 'd'), scene('/pricing', 'guest', 'normal', 'd')];

// run 0001, a full check of two pages; with `quick`, run 0002, a first look of them (the latest capture)
function project({ quick = true } = {}) {
  const root = tmp('nunchi-bar-');
  writeRun(root, '0001', { scenes: SCENES, findings: [{ lens: 'L8', rule: 'target-size-min', severity: 'low', scene: SCENES[0].id, route: '/', viewport: 'd', selector: 'nav a', box: null, evidence: { width: 12 } }] });
  if (quick) {
    const { run } = writeRun(root, '0002', { scenes: SCENES, parent: '0001', wholeApp: false });
    writeFileSync(join(run, 'run.json'), stableJson({ ...JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')), kind: 'quick' }));
  }
  return { root, nunchi: join(root, '.nunchi'), runs: join(root, '.nunchi', 'runs') };
}
function partial(p, id, doc, at = T) {
  const dir = join(p.runs, `${id}.partial`);
  mkdirSync(dir, { recursive: true });
  if (doc) { writeFileSync(join(dir, 'progress.json'), JSON.stringify(doc)); utimesSync(join(dir, 'progress.json'), new Date(at), new Date(at)); }
  utimesSync(dir, new Date(at), new Date(at));
}
const sweep = (done, routes = 72, ms = 24000) => ({ schema: 1, kind: 'sweep', wholeApp: true, routes, done, routeMs: Array(done).fill(ms), pid: process.pid, ...thisMachine() });
function sumAt(p, now = T + MIN, alive = () => true) {
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const { rows, groups } = P.ledgerView(led);
  return summary({ state: led.state, rows, groups, stream: led.st.root.stream, runsDir: led.st.runsDir, captures: R.captureStates(led.st.runsDir, { now, alive }) });
}
const lineOf = s => s.bar && [s.bar.state, s.bar.full, s.bar.run, s.bar.line, s.bar.done, s.bar.routes, s.bar.pct, s.bar.minutesLeft, s.bar.replaces.map(i => s.now[i])];

test('the full check running after a first look: "Full check running · 33 of 72 screens · about 16 min left", 46%; none before the first route; "no progress"; a partial check\'s "skipped"', () => {
  const p = project();
  // no capture: no bar (the first look's own line stays a Now line)
  let s = sumAt(p);
  assert.equal(s.bar, null);
  assert.deepEqual(s.now, ['First look: 2 key screens · the full check has not started — tell your AI “full check”']);
  partial(p, '0003', sweep(33));
  s = sumAt(p);
  assert.deepEqual(lineOf(s), ['running', true, '0003', 'Full check running · 33 of 72 screens · about 16 min left', 33, 72, 46, 16,
    ['First look: 2 key screens · full check running, 33 of 72 screens (about 16 min left)']]);
  // `findings` keeps every Now line as it was: only the board says it once, in the bar
  assert.deepEqual(s.now, ['First look: 2 key screens · full check running, 33 of 72 screens (about 16 min left)']);
  partial(p, '0003', sweep(0));
  assert.deepEqual(lineOf(sumAt(p)).slice(3, 8), ['Full check running · 0 of 72 screens', 0, 72, null, null], 'before the first route: no percentage, no time');
  // its writer here, no progress for 10 minutes: said in place of the time left (still running: M5b ③)
  partial(p, '0003', sweep(33));
  assert.equal(sumAt(p, T + 10 * MIN).bar.line, 'Full check running · 33 of 72 screens · no progress for 10 min');
  // a partial check says why, as the first look's line does
  partial(p, '0003', { ...sweep(12, 25, 27000), wholeApp: false, skipped: [{ route: '/posts/[id]', reason: 'needs-sample' }] });
  assert.equal(sumAt(p).bar.line, 'Full check running · 12 of 25 screens · about 6 min left · skipped /posts/[id] (needs-sample)');
});

test('another capture running: M5b\'s "Capture running · run N · …" with the same meter, or none without a progress file; a capture stopped; the bar says one capture, the full check first', () => {
  const p = project({ quick: false });
  assert.equal(sumAt(p).bar, null, 'a full check and nothing running: no bar');
  partial(p, '0002', sweep(12, 25, 27000));
  let s = sumAt(p);
  assert.deepEqual(lineOf(s), ['running', false, '0002', 'Capture running · run 0002 · 12 of 25 screens (about 6 min left)', 12, 25, 48, 6, ['Capture running · run 0002 · 12 of 25 screens (about 6 min left)']]);
  // a folder without a progress file (a fix probe): the plain line, no meter
  rmSync(join(p.runs, '0002.partial'), { recursive: true });
  partial(p, '0002', null);
  assert.deepEqual(lineOf(sumAt(p)), ['running', false, '0002', 'Capture running · run 0002', null, null, null, null, ['Capture running · run 0002']]);
  // stopped: its writer gone
  rmSync(join(p.runs, '0002.partial'), { recursive: true });
  partial(p, '0002', sweep(12, 25, 27000));
  s = sumAt(p, T + MIN, () => false);
  assert.deepEqual(lineOf(s), ['stopped', false, '0002', 'Capture stopped · run 0002 (its process ended) — tell your AI “capture again”', null, null, null, null, ['Capture stopped · run 0002 (its process ended) — tell your AI “capture again”']]);
  // a later capture answers it: the newest running one is the bar's; with a first look, its full check is (the other
  // capture's line stays a Now line)
  partial(p, '0003', { ...sweep(2, 25, 27000), kind: 'quick' });
  s = sumAt(p);
  assert.deepEqual([s.bar.run, s.bar.line, s.now.length - s.bar.replaces.length], ['0003', 'Capture running · run 0003 · 2 of 25 screens (about 11 min left)', 1]);
  const q = project();
  partial(q, '0003', sweep(33));
  partial(q, '0004', { ...sweep(1, 5, 60000), kind: 'quick' });
  s = sumAt(q);
  assert.deepEqual([s.bar.run, s.bar.full, s.now.filter((_, i) => !s.bar.replaces.includes(i))], ['0003', true, ['Capture running · run 0004 · 1 of 5 screens (about 4 min left)']]);
});

test('the full check done: "Full check done · 3 screens · 1 new group" (one wording for the bar, `findings` and capture\'s end), until the next capture lands', () => {
  const p = project();
  const scenes = [...SCENES, scene('/help', 'guest', 'normal', 'd')];
  writeRun(p.root, '0003', { scenes, parent: '0002', findings: [{ lens: 'L3', rule: 'dead-href', severity: 'medium', scene: scenes[2].id, route: '/help', viewport: 'd', selector: 'main a.more', box: null, evidence: { href: '#' } }] });
  let s = sumAt(p);
  assert.deepEqual(lineOf(s), ['done', true, '0003', 'Full check done · 3 screens · 1 new group', null, null, null, null, ['Full check done · 3 screens · 1 new group']]);
  assert.deepEqual([s.fullCheckDone.text, s.fullCheckDone.screens, s.fullCheckDone.newGroups], ['Full check done · 3 screens · 1 new group', 3, 1]);
  // the function capture calls once its run is folded: the same object
  const led = P.loadLedger(p.nunchi, { root: p.root });
  assert.deepEqual(fullCheckDoneOf({ state: led.state, stream: led.st.root.stream, runsDir: led.st.runsDir, rows: P.ledgerView(led).rows }), s.fullCheckDone);
  // a capture running after it: the bar says that one; "Full check done" stays a Now line
  partial(p, '0004', sweep(3, 25, 27000));
  s = sumAt(p);
  assert.deepEqual([s.bar.state, s.now.filter((_, i) => !s.bar.replaces.includes(i))], ['running', ['Full check done · 3 screens · 1 new group']]);
  rmSync(join(p.runs, '0004.partial'), { recursive: true });
  writeRun(p.root, '0004', { scenes, parent: '0003' });
  s = sumAt(p);
  assert.deepEqual([s.bar, s.fullCheckDone, s.now], [null, null, []], 'the next capture landed: no bar');
});

test('how far, in whole percent: none before a route is done, 1 to 99 while one is left, 100 once every route is', () => {
  assert.deepEqual([[0, 72], [33, 72], [1, 300], [199, 200], [200, 200], [3, 0], [null, 72]].map(([d, r]) => barPct(d, r)), [null, 46, 1, 99, 100, null, null]);
});

test('/api/summary: the bar as the summary says it, which Now lines it stands for, and its line cleaned (a partial check\'s routes are data)', async () => {
  const p = project();
  partial(p, '0003', { ...sweep(12, 25, 27000), host: 'another-machine.invalid', wholeApp: false, skipped: [{ route: '/posts/ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', reason: 'needs-sample' }] }, Date.now());
  const b = await startBoard({ projectDir: p.root });
  try {
    const session = await (await fetch(`${b.origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    const s = (await boardRequest(b.origin, '/api/summary', { token: session.token })).json;
    assert.deepEqual([s.bar.state, s.bar.full, s.bar.run, s.bar.done, s.bar.routes, s.bar.pct, s.bar.replaces], ['running', true, '0003', 12, 25, 48, [0]]);
    assert.match(s.bar.line, /^Full check running · 12 of 25 screens · about 6 min left · skipped \/posts\/\[secret-shaped: [^\]]+\] \(needs-sample\)$/);
    assert.doesNotMatch(s.bar.line, /ghp_/);
    assert.match(s.now[0], /^First look: 2 key screens · full check running, 12 of 25 screens/);
  } finally { await b.close(); }
});

test('the announcer\'s words for the bar: its line when the capture starts, finishes or stops — the same words while its state holds, so no route is said', () => {
  const bar = (state, run, line, full = true) => ({ state, run, full, line });
  let say = barSay(null, bar('running', '0006', 'Full check running · 1 of 72 screens · about 29 min left'));
  assert.deepEqual(say, { key: 'running:0006:full', text: 'Full check running · 1 of 72 screens · about 29 min left' });
  const a = new NowAnnouncer();
  assert.equal(a.update([say.text], 0).say, say.text, 'it starts: said');
  say = barSay(say, bar('running', '0006', 'Full check running · 2 of 72 screens · about 28 min left'));
  assert.equal(say.text, 'Full check running · 1 of 72 screens · about 29 min left', 'a route lands: the same words');
  assert.deepEqual(a.update([say.text], 20000), { say: null, wait: null }, 'nothing said');
  say = barSay(say, bar('stopped', '0006', 'Capture stopped · run 0006 (no progress for 10 min) — tell your AI “capture again”', false));
  assert.equal(a.update([say.text], 40000).say, 'Capture stopped · run 0006 (no progress for 10 min) — tell your AI “capture again”', 'it stops: said');
  say = barSay(say, bar('done', '0006', 'Full check done · 72 screens · 16 new groups'));
  assert.equal(a.update([say.text], 60000).say, 'Full check done · 72 screens · 16 new groups', 'it finishes: said');
  assert.equal(barSay(say, null), null, 'no bar: nothing');
  // its words on the page (the owner's)
  assert.deepEqual([BAR_WORDS.mark, BAR_WORDS.note, BAR_WORDS.review, BAR_WORDS.meterText(33, 72, 46), BAR_WORDS.meterText(0, 72, null)],
    [{ running: '◐', done: '✓', stopped: '!' }, 'You can keep deciding; findings update as screens land.', 'Review findings →', '33 of 72 screens, 46%', '0 of 72 screens']);
});

test('the start line: "Full check started in the background · 72 screens · about 20 min. …", the time only from a measured basis (the newest run\'s time per screen and how many of its pages loaded data)', () => {
  assert.equal(fullCheckStartedText(72, 20), 'Full check started in the background · 72 screens · about 20 min. The board shows how far it is; you can keep deciding.');
  assert.equal(fullCheckStartedText(72, null), 'Full check started in the background · 72 screens. The board shows how far it is; you can keep deciding.');
  assert.equal(fullCheckStartedText(1, null), 'Full check started in the background · 1 screen. The board shows how far it is; you can keep deciding.');
  const p = project();
  // no run with its timing: no basis, no time
  assert.equal(timeBasis(p.runs), null);
  assert.equal(minutesFor(null, { routes: 72, persons: 2, viewports: 2, states: ['normal', 'empty'] }), null);
  // the first look measured 1.5 s a screen, and one of its two normal screens loaded data
  const scenes = [scene('/', 'guest', 'normal', 'd', { dataRequests: 0 }), scene('/pricing', 'guest', 'normal', 'd', { dataRequests: 2 })];
  writeFileSync(join(p.runs, '0002', 'manifest.json'), stableJson({ schema: 1, scenes }));
  writeFileSync(join(p.runs, '0002', 'timing.json'), stableJson({ totalMs: 3500, scenes: [{ scene: scenes[0].id, ms: 1000 }, { scene: scenes[1].id, ms: 2000 }] }));
  const basis = timeBasis(p.runs);
  assert.deepEqual(basis, { run: '0002', sceneMs: 1500, dataShare: 0.5 });
  // 72 routes × 2 persons × 2 widths = 288 normal screens, and half of them in 4 forced states: 864 screens × 1.5 s
  assert.equal(minutesFor(basis, { routes: 72, persons: 2, viewports: 2, states: ['normal', 'empty', 'error', 'slow', 'offline'] }), 22);
  assert.equal(minutesFor(basis, { routes: 72, persons: 2, viewports: 2, states: ['normal'] }), 8);
  assert.equal(minutesFor(basis, { routes: 1, persons: 1, viewports: 1, states: ['normal'] }), 1, 'at least 1');
  // a fix probe is no basis (a few screens, captured its own way); the newest run with a timing is
  const { run } = writeRun(p.root, '0003', { scenes: SCENES, parent: '0002' });
  writeFileSync(join(run, 'run.json'), stableJson({ ...JSON.parse(readFileSync(join(run, 'run.json'), 'utf8')), kind: 'fix-probe' }));
  writeFileSync(join(run, 'timing.json'), stableJson({ totalMs: 1, scenes: [{ scene: SCENES[0].id, ms: 60000 }] }));
  assert.equal(timeBasis(p.runs).run, '0002');
  writeFileSync(join(p.runs, '0001', 'timing.json'), stableJson({ totalMs: 1, scenes: [{ scene: SCENES[0].id, ms: 9000 }] }));
  assert.equal(timeBasis(p.runs).run, '0002', 'the newest');
  rmSync(join(p.runs, '0002', 'timing.json'));
  assert.deepEqual(timeBasis(p.runs), { run: '0001', sceneMs: 9000, dataShare: 1 });
  writeFileSync(join(p.runs, '0001', 'timing.json'), 'not json');
  assert.equal(timeBasis(p.runs), null, 'a timing that does not parse is no basis');
});

test('the skill says the start at once and the done line first, in the engine\'s words (step 5 and 6)', () => {
  const skill = readFileSync(fileURLToPath(new URL('../skills/nunchi/SKILL.md', import.meta.url)), 'utf8');
  const step = n => { const m = new RegExp(`\\n${n}\\. ([\\s\\S]*?)\\n\\d+a?\\. `).exec(skill); assert.ok(m, `step ${n}`); return m[1].replace(/\s+/g, ' '); };
  const five = step(5), six = step(6);
  assert.ok(five.includes(fullCheckStartedText(72, 20)), 'the start line, as capture prints it');
  for (const words of ['at once', 'in their own language', 'in the background', 'how many screens', 'about how long', 'the board shows how far', 'keep deciding', 'Full check running · 33 of 72 screens · about 16 min left', 'when the background command finishes', 'Full check done · 72 screens · 16 new groups', 'first, unprompted, before anything else'])
    assert.ok(five.toLowerCase().includes(words.toLowerCase()), `step 5: ${words}`);
  assert.ok(!/Full check done: /.test(skill), 'no older wording');
  assert.ok(six.includes('"Full check done · 72 screens · 16 new groups"'), 'step 6: the done line');
});

test('the page keeps its tab storage in try/catch, and the bar is a status region that is not live itself', () => {
  const js = readFileSync(fileURLToPath(new URL('../src/board/assets/board.js', import.meta.url)), 'utf8');
  const uses = js.split('\n').filter(l => /sessionStorage/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(uses.length, 1, uses.join('\n'));
  assert.match(uses[0], /^const tabStore = \{ get: k => \{ try \{ return sessionStorage\.getItem\(k\); \} catch \{ return null; \} \}, set: \(k, v\) => \{ try \{ sessionStorage\.setItem\(k, v\); \} catch \{\} \} \};$/);
  assert.match(js, /const BAR = h\('div', \{ id: 'runbar', class: 'runbar', role: 'status', 'aria-live': 'off', hidden: true \}\);/);
});
