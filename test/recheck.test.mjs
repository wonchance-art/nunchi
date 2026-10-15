// The AI re-check (design 0.1-c §2.4, M1): packets per (AI item × cell) whose screen or code changed, unchanged ones
// skipped, still-present controls on changed screens, suspect batches that fix nothing, every cell gone to fix,
// insufficient = needs you, verdicts folded from the answer key only. Synthetic runs, invented content; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as S from '../src/stable.mjs';
import * as St from '../src/state.mjs';
import * as R from '../src/recheck.mjs';
import { buildModel } from '../src/export-html.mjs';
import { tmp } from './fixtures/tmp.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-recheck-xdg-');
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const json = async (cwd, ...a) => { const r = await cli(cwd, ...a, '--json'); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };

// ---- fold-level: rows as the ledger's view gives them -----------------------------------------------------------

const SRC = 'a'.repeat(16);
const AIF = (cell, over = {}) => {
  const lens = over.lens || 'L6', rule = over.rule || 'L6.unclear-label';
  const f = { source: 'ai', lens, rule, route: '/tasks', selector: 'button#delete-all', evidence: { claim: 'The label does not say what it deletes.' }, ...(over.identity ? { identity: over.identity } : {}) };
  const { fp, group, inputs } = L.fingerprintOf(f);
  return { fp, group, inputs, lens, rule, route: '/tasks', scene: `tasks.${cell}`, cell, selector: f.selector, box: [150, 120, 100, 40], evidence: f.evidence, identity: null, status: 'confirmed', claimedSeverity: 'high', verdictSeverity: 'high', by: 'same-model check', vendor: null, suspect: false, sceneHash: { top: `top-${cell}`, full: `full-${cell}`, textHash: `text-${cell}`, src: SRC }, ...over };
};
const scene = (cell, hashes = {}, route = '/tasks') => { const [person, state, viewport] = cell.split('.'); return { id: `${route === '/' ? '~' : route.slice(1)}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200, top: `top-${cell}`, full: `full-${cell}`, textHash: `text-${cell}`, ...hashes }; };
const stateWith = (findings, now = 1000, run = '0001') => L.foldAi(L.emptyState(), { run, key: 'k', findings, now });
const sameSource = () => ({ hash: SRC, files: [] });
const plan = opts => R.planRecheck({ runId: '0002', routeSource: sameSource, ...opts });
// rule findings: a small tap target and a clipped heading on a screen (the controls)
const SMALL = (cell, route = '/tasks') => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${route === '/' ? '~' : route.slice(1)}.${cell}`, route, viewport: cell.split('.')[2], selector: 'a#home', box: [16, 10, 60, 24], evidence: { name: 'Home' } });
const CLIP = cell => ({ lens: 'L1', rule: 'clipped-text', severity: 'medium', scene: `tasks.${cell}`, route: '/tasks', viewport: cell.split('.')[2], selector: 'h1', box: [16, 60, 200, 30], evidence: { text: 'Tasks for this week' } });
const ERR = cell => ({ lens: 'L3', rule: 'page-error', severity: 'high', scene: `tasks.${cell}`, route: '/tasks', viewport: cell.split('.')[2], selector: null, box: null, evidence: { message: 'x is undefined' } });
const CELLS = ['guest.normal.m', 'guest.normal.d'];
const changed = c => scene(c, { top: `new-${c}`, full: `newfull-${c}` });
const previousWith = (findings, extra = {}) => ({ runId: '0001', manifest: { scenes: CELLS.map(c => scene(c)) }, findings: L.annotate(findings), ...extra });

test('plan: one packet per AI item × cell whose screen changed; an unchanged screen and route source is still there (no packet); a cell not captured cannot fix it', () => {
  const st = stateWith(CELLS.map(c => AIF(c)));
  const rows = L.view(st, []);
  const manifest = { scenes: [scene('guest.normal.m', { top: 'changed' }), scene('guest.normal.d')] };
  const p = plan({ manifest, rows });
  assert.deepEqual(Object.values(p.key.packets), [{ kind: 'item', fp: rows[0].fp, cell: 'guest.normal.m' }]);
  assert.deepEqual(p.key.unchanged, [{ fp: rows[0].fp, cell: 'guest.normal.d' }]);
  assert.deepEqual(p.key.controls, { planned: 3, made: 0 }, 'at least 3 controls are called for; none could be made here');
  const missing = plan({ manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows });
  assert.deepEqual(missing.key.notCaptured, [{ fp: rows[0].fp, cell: 'guest.normal.d' }]);
  // a packet: the claim, the old screen (element and box) and the new one, by alias; no diff, commit or fix brief
  const [pk] = p.packets.packets;
  assert.deepEqual(Object.keys(pk).sort(), ['claim', 'new', 'old', 'packet']);
  assert.deepEqual(pk.claim, { lens: 'L6', what: 'The label does not say what it deletes.' });
  assert.match(pk.old.scene, /^s[0-9a-f]{10}$/); assert.match(pk.new.scene, /^s[0-9a-f]{10}$/);
  assert.notEqual(pk.old.scene, pk.new.scene);
  assert.deepEqual([pk.old.selector, pk.old.box], ['button#delete-all', [150, 120, 100, 40]]);
  assert.ok(pk.old.files.every(f => f.startsWith(`recheck/${pk.old.scene}/`)));
  const text = JSON.stringify(p.packets);
  assert.ok(!/0001|0002|tasks\.guest|diff|commit|fix brief/i.test(text.replace(p.packets.instructions, '')), 'no run, scene id, diff, commit or brief');
  assert.deepEqual(plan({ manifest, rows }), p, 'deterministic');
  // items not standing are not re-checked: fixed, kept, dismissed
  const keep = { schema: 1, id: 'dk-1', target: { fp: rows[0].fp }, decision: 'keep', reason: 'intended', by: 'me', at: '2026-10-14T10:00:00.000+09:00' };
  assert.equal(plan({ manifest, rows: L.view(st, [keep], new Set([L.approvalKey(keep)]), { now: Date.parse('2026-10-15T00:00:00+09:00') }) }).packets.packets.length, 0);
});

test('plan: "unchanged" needs the route\'s source to hash the same at both captures; a behaviour lens (L9) is always asked', () => {
  const rows = L.view(stateWith([AIF('guest.normal.m')]), []);
  const manifest = { scenes: [scene('guest.normal.m')] };
  const asked = opts => Object.keys(plan({ manifest, rows, ...opts }).key.packets).length;
  assert.equal(asked({}), 0, 'same screen, same route source: still there');
  assert.equal(asked({ routeSource: () => ({ hash: 'b'.repeat(16), files: [] }) }), 1, 'the route\'s code changed: asked, though the screen did not');
  assert.equal(asked({ routeSource: () => null }), 1, 'a run without source hashes cannot say the code is the same: asked');
  const noSrc = L.view(stateWith([AIF('guest.normal.m', { sceneHash: { top: 'top-guest.normal.m', full: 'full-guest.normal.m', textHash: 'text-guest.normal.m' } })]), []);
  assert.equal(Object.keys(plan({ manifest, rows: noSrc }).key.packets).length, 1, 'seen in a run without source hashes: asked');
  const l9 = L.view(stateWith([AIF('guest.normal.m', { lens: 'L9', rule: 'L9.destructive-without-confirm' })]), []);
  const k9 = plan({ manifest, rows: l9 }).key;
  assert.deepEqual([Object.keys(k9.packets).length, k9.unchanged.length], [1, 0], 'what a destructive action does never shows on a screenshot');
});

test('plan: a grounded file outside the route\'s files decides "unchanged" only on the tree the run was captured from, by its hash', () => {
  const identity = { element: 'button#delete-all', file: 'app/tasks.tsx', anchor: 'a'.repeat(16), name: 'Delete all', component: { file: 'app/tasks.tsx', name: 'Delete all' }, fileHash: 'b'.repeat(16) };
  const rows = L.view(stateWith([AIF('guest.normal.m', { identity })]), []);
  const manifest = { scenes: [scene('guest.normal.m')] };
  const packets = opts => plan({ manifest, rows, ...opts }).key;
  assert.equal(packets({ sameTree: true, fileHashOf: () => 'b'.repeat(16) }).unchanged.length, 1, 'same screen, same code: still there');
  assert.equal(Object.keys(packets({ sameTree: true, fileHashOf: () => 'c'.repeat(16) }).packets).length, 1, 'the code changed: asked');
  assert.equal(Object.keys(packets({ sameTree: false, fileHashOf: () => 'b'.repeat(16) }).packets).length, 1, 'another tree than the run\'s: asked');
  assert.equal(packets({ routeSource: () => ({ hash: SRC, files: ['app/tasks.tsx'] }) }).unchanged.length, 1, 'a file of the route: its hash is in the route\'s');
});

test('plan: an item seen in this very run, or in a newer run, is not asked about; one a verifier rejected later still is', () => {
  const rows = L.view(stateWith([AIF('guest.normal.m')], 1000, '0002'), []);
  const same = plan({ manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows });
  assert.deepEqual([same.packets.packets.length, same.key.unchanged.length, same.key.items], [0, 0, {}], 'seen in run 0002: nothing to compare against 0002');
  const older = R.planRecheck({ runId: '0001', manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows, routeSource: sameSource });
  assert.deepEqual([older.packets.packets.length, older.key.newer, older.key.items], [0, [rows[0].fp], {}], 'seen in 0002: run 0001 cannot say it is gone');
  // an item another worktree saw last is that worktree's to re-check: asking here would only make this one its owner
  const elsewhere = R.planRecheck({ runId: '0003', manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows, routeSource: sameSource, stream: 'wt:two' });
  assert.deepEqual([elsewhere.packets.packets.length, elsewhere.key.otherWorktrees], [0, [rows[0].fp]]);
  assert.equal(R.planRecheck({ runId: '0003', manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows, routeSource: sameSource, stream: 'main' }).packets.packets.length, 1);
  // confirmed in 0001, then claimed again in 0002 and rejected there by a verifier that was not suspect: still open,
  // so still re-checked (else nothing could ever close it)
  let st = stateWith([AIF('guest.normal.m')]);
  st = L.foldAi(st, { run: '0002', key: 'k2', findings: [AIF('guest.normal.m', { status: 'rejected' })], now: 2000 });
  const r = L.view(st, []);
  assert.deepEqual([r[0].status, r[0].verification.status, r[0].verification.suspect], ['open', 'rejected', false]);
  assert.equal(R.planRecheck({ runId: '0003', manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows: r, routeSource: sameSource }).packets.packets.length, 1);
});

test('plan: controls are still-present defects on screens that changed — rule findings seen then and now, phrased as a hunter would, and canary copies against the previous run\'s copy', () => {
  const rows = L.view(stateWith(CELLS.map(c => AIF(c))), []);
  const manifest = { scenes: CELLS.map(changed) };
  const runFindings = L.annotate([...CELLS.map(c => SMALL(c)), ...CELLS.map(CLIP), ...CELLS.map(ERR)]);
  const previous = previousWith([...CELLS.map(c => SMALL(c)), ...CELLS.map(CLIP), ...CELLS.map(ERR)]);
  const p = plan({ manifest, rows, previous, runFindings });
  assert.deepEqual(p.key.controls, { planned: 3, made: 3 });
  const controls = p.packets.packets.filter(x => p.key.packets[x.packet].kind === 'control');
  // one per finding × screen (the same tap target on two screens is two controls); a rule a hunter would not claim
  // from a screen (a page error) is never one
  const claims = controls.map(c => `${c.claim.lens} ${c.claim.what}`).sort();
  for (const c of claims) assert.ok(['L1 “Home” is too small to tap reliably.', 'L1 The text “Tasks for this week” is cut off.'].includes(c), c);
  assert.ok(controls.every(c => c.claim.lens !== 'L8' && c.claim.lens !== 'L3'), 'never a rule lens: AI items are never filed under one');
  assert.ok(!JSON.stringify(controls).includes('Tap target smaller'), 'never the rule\'s title');
  assert.deepEqual(Object.keys(controls[0]).sort(), ['claim', 'new', 'old', 'packet'], 'a control has the shape of a real packet');
  const onlySmall = plan({ manifest, rows, previous: previousWith(CELLS.map(c => SMALL(c))), runFindings: L.annotate(CELLS.map(c => SMALL(c))) });
  assert.equal(onlySmall.key.controls.made, 2, 'one finding on two screens: two controls');
  // controls on screens that did not change are not made: they would be told apart from real packets
  const still = plan({ manifest: { scenes: CELLS.map(c => scene(c, { textHash: `new-${c}` })) }, rows, previous, runFindings });
  assert.deepEqual(still.key.controls, { planned: 3, made: 0 });
  // canary copies: this run's copy of a screen and kind against the previous run's copy of the same
  const copy = (run, k) => ({ scene: `tasks.guest.normal.m.canary-${k}`, of: 'tasks.guest.normal.m', kind: 'vague-error', lens: 'L6', checklist: 'L6.vague-error', selector: 'p.err', box: [0, 0, 10, 10], run });
  const withCopy = (m, salt) => ({ scenes: [...m.scenes, { ...scene('guest.normal.m', { top: `copy-${salt}` }), id: `tasks.guest.normal.m.canary-${salt === 'old' ? 2 : 1}`, canary: 1 }] });
  const viaCanary = plan({ manifest: withCopy(manifest, 'new'), rows, canaries: { planted: [copy('0002', 1)] }, previous: { ...previousWith([]), manifest: withCopy(previousWith([]).manifest, 'old'), canaries: { planted: [copy('0001', 2)] } } });
  const c = viaCanary.packets.packets.find(x => viaCanary.key.packets[x.packet].kind === 'control');
  assert.equal(c.claim.what, 'The error message does not say what went wrong or what to do.');
  assert.notEqual(c.old.scene, c.new.scene);
  assert.deepEqual(viaCanary.mirror.filter(m => m.scene.includes('canary')).map(m => [m.run, m.scene]).sort(), [['0001', 'tasks.guest.normal.m.canary-2'], ['0002', 'tasks.guest.normal.m.canary-1']], 'old side: the previous run\'s copy');
  assert.ok(!JSON.stringify(viaCanary.packets).includes('canary'));
  // without a copy in the previous run there is nothing to pair: no canary control
  assert.equal(plan({ manifest: withCopy(manifest, 'new'), rows, canaries: { planted: [copy('0002', 1)] } }).key.controls.made, 0);
});

test('record and fold: fixed only when every cell says gone and the batch is not suspect; still-there keeps it; insufficient needs you', () => {
  const st = stateWith(CELLS.map(c => AIF(c)));
  const rows = L.view(st, []);
  const fp = rows[0].fp;
  const manifest = { scenes: CELLS.map(changed) };
  const both = [...CELLS.map(c => SMALL(c)), ...CELLS.map(CLIP)];
  const p = plan({ manifest, rows, previous: previousWith(both), runFindings: L.annotate(both) });
  assert.deepEqual(p.key.controls, { planned: 3, made: 3 });
  const answer = (item, control = 'still-there', over = {}, skip = 0) => {
    let skipped = 0;
    return Object.entries(p.key.packets).filter(([, k]) => !(k.kind === 'control' && skipped++ < skip)).map(([packet, k]) => ({ packet, verdict: k.kind === 'control' ? control : (over[k.cell] ?? item), reason: 'looked at both screens' }));
  };
  const after = verdicts => {
    const r = R.recordRecheck({ key: p.key, packets: p.packets, verdicts });
    assert.deepEqual(r.problems, []);
    return { r, st: L.foldRecheck(st, { run: '0002', key: S.sha(S.stableJson(r.recheck)), ...R.recheckInput(r.recheck), now: 2000 }) };
  };
  let { r, st: s } = after(answer('gone'));
  assert.equal(r.recheck.suspect, false);
  assert.deepEqual(r.recheck.controls, { planned: 3, total: 3, answered: 3, passedThrough: 0, rate: 0 }, 'the counts are reported');
  assert.equal(Object.values(s.items)[0].goneAt, '0002');
  assert.equal(L.view(s, [])[0].status, 'fixed');
  ({ st: s } = after(answer('gone', 'still-there', { 'guest.normal.d': 'still-there' })));
  assert.deepEqual([Object.values(s.items)[0].goneAt, Object.values(s.items)[0].lastSeen], [null, '0002'], 'one cell still there: open, seen now');
  ({ st: s } = after(answer('gone', 'still-there', { 'guest.normal.d': 'insufficient' })));
  assert.equal(Object.values(s.items)[0].goneAt, null);
  assert.deepEqual(L.view(s, [])[0].needsYou, { reason: 'recheck-insufficient', run: '0002' });
  // a control answered gone: pass-through above 10%, the batch is suspect and fixes nothing
  ({ r, st: s } = after(answer('gone', 'gone')));
  assert.equal(r.recheck.suspect, true);
  assert.match(r.recheck.suspectReason, /control pass-through 3\/3/);
  assert.equal(Object.values(s.items)[0].goneAt, null);
  // a control left unanswered is a pass-through too: skipping the hard ones does not look careful
  ({ r, st: s } = after(answer('gone', 'still-there', {}, 1)));
  assert.deepEqual([r.recheck.suspect, r.recheck.controls.answered, r.recheck.controls.passedThrough], [true, 2, 1]);
  assert.match(r.recheck.suspectReason, /control pass-through 1\/3 > 10%/);
  assert.equal(Object.values(s.items)[0].goneAt, null);
  // fewer controls than planned: suspect too
  const bare = plan({ manifest, rows });
  const rb = R.recordRecheck({ key: bare.key, packets: bare.packets, verdicts: Object.keys(bare.key.packets).map(packet => ({ packet, verdict: 'gone', reason: 'ok' })) });
  assert.match(rb.recheck.suspectReason, /fewer controls than planned \(0 of 3\)/);
  assert.equal(L.foldRecheck(st, { run: '0002', key: 'x', ...R.recheckInput(rb.recheck) }).items[fp].goneAt, null);
  // a claim after it was gone brings it back
  ({ st: s } = after(answer('gone')));
  s = L.foldAi(s, { run: '0003', key: 'k3', findings: [AIF('guest.normal.m')], now: 3000 });
  assert.deepEqual([Object.values(s.items)[0].goneAt, Object.values(s.items)[0].regressedAt, L.view(s, [])[0].status], [null, '0003', 'regressed']);
  // recording again with other verdicts replaces the re-check's contribution
  ({ st: s } = after(answer('gone')));
  const again = R.recordRecheck({ key: p.key, packets: p.packets, verdicts: answer('still-there') }).recheck;
  s = L.foldRecheck(s, { run: '0002', key: 'other', ...R.recheckInput(again), now: 2500 });
  assert.equal(Object.values(s.items)[0].goneAt, null);
  assert.equal(Object.values(s.items)[0].rechecks.length, 1);
});

test('record: control pass-through above 10% is suspect (1 of 10 is not, 2 of 10 is); none answered says so', () => {
  const packets = { p001: { kind: 'item', fp: 'f'.repeat(12), cell: 'guest.normal.m' } };
  for (let i = 2; i <= 11; i++) packets[`p${String(i).padStart(3, '0')}`] = { kind: 'control', control: 'rule' };
  const key = { plan: 'x', run: '0002', controls: { planned: 10, made: 10 }, packets, unchanged: [], notCaptured: [], scenes: {} };
  const controls = Object.keys(packets).slice(1);
  // the item gone; `gone` controls answered gone, `skip` controls left unanswered, the rest still there
  const rec = (gone, skip = 0) => R.recordRecheck({ key, packets: null, verdicts: [{ packet: 'p001', verdict: 'gone', reason: 'r' },
    ...controls.slice(skip).map((packet, i) => ({ packet, verdict: i < gone ? 'gone' : 'still-there', reason: 'r' }))] }).recheck;
  assert.deepEqual([rec(1).suspect, rec(1).controls.rate], [false, 0.1], '1 of 10: exactly 10%, not above');
  assert.deepEqual([rec(2).suspect, rec(2).suspectReason], [true, 'control pass-through 2/10 > 10%']);
  // unanswered controls count the same way
  assert.deepEqual([rec(0, 1).suspect, rec(0, 1).controls.passedThrough], [false, 1]);
  assert.deepEqual([rec(0, 2).suspect, rec(0, 2).controls.passedThrough], [true, 2]);
  const none = R.recordRecheck({ key, packets: null, verdicts: [{ packet: 'p001', verdict: 'gone', reason: 'r' }] }).recheck;
  assert.deepEqual([none.suspect, none.suspectReason], [true, 'no control was answered']);
});

test('record: verdicts are data — unknown packets, other verdicts, two lines and a stale plan are refused', () => {
  const rows = L.view(stateWith([AIF('guest.normal.m')]), []);
  const p = plan({ manifest: { scenes: [scene('guest.normal.m', { top: 'x' })] }, rows });
  const id = Object.keys(p.key.packets)[0];
  const bad = R.recordRecheck({ key: p.key, packets: p.packets, verdicts: [{ packet: 'p999', verdict: 'gone', reason: 'x' }, { packet: id, verdict: 'fixed', reason: 'x\ny' }] });
  assert.equal(bad.problems.length, 3, bad.problems.join('\n'));
  assert.match(R.recordRecheck({ key: p.key, packets: { ...p.packets, plan: 'ffffffffffff' }, verdicts: [] }).problems[0], /run recheck --plan again/);
  // results without `suspect` fold as suspect: nothing they say is gone counts
  assert.equal(R.recheckInput({ results: [] }).suspect, true);
});

// ---- the CLI, end to end ----------------------------------------------------------------------------------------

const jpeg = (w, h, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);
const ctl = (selector, name, box, extra = {}) => ({ selector, tag: 'button', role: null, name, hasText: true, text: name, box, href: null, inline: false, ...extra });
const CONTROLS = [ctl('button#delete-all', 'Delete all', [150, 120, 100, 40]), ctl('button#add-task', 'Add Task', [16, 120, 120, 40]), ctl('a#home', 'Home', [16, 10, 60, 24], { tag: 'a', href: '/' })];
// salt: what every screen's pixels look like (another salt, other screenshots); the routes' source is the same
function makeRun(cwd, id, salt = 0) {
  const dir = join(cwd, '.nunchi', 'runs', id);
  const scenes = [];
  [['~', '/', 'm', 1], ['~', '/', 'd', 2], ['tasks', '/tasks', 'm', 3], ['tasks', '/tasks', 'd', 4]].forEach(([slug, route, vp, base]) => {
    const sid = `${slug}.guest.normal.${vp}`, d = join(dir, sid);
    mkdirSync(d, { recursive: true });
    const top = jpeg(vp === 'm' ? 390 : 1280, 800, base + salt), full = jpeg(vp === 'm' ? 390 : 1280, 1200, base + salt + 50), text = route === '/tasks' ? 'Tasks\nDelete all\n' : 'Home\n';
    writeFileSync(join(d, 'top.jpg'), top); writeFileSync(join(d, 'full.jpg'), full); writeFileSync(join(d, 'text.txt'), text);
    writeFileSync(join(d, 'aria.yml'), '- button "Delete all"\n');
    writeFileSync(join(d, 'controls.json'), JSON.stringify(route === '/tasks' ? CONTROLS : [ctl('a#see', 'See tasks', [1, 1, 80, 30], { tag: 'a' })]));
    for (const n of ['styles.json', 'links.json']) writeFileSync(join(d, n), '[]');
    writeFileSync(join(d, 'measure.json'), JSON.stringify({ clipped: [], images: [], scrollers: [], hiddenControls: [] }));
    scenes.push({ id: sid, route, path: route, person: 'guest', state: 'normal', viewport: vp, status: 'captured', reason: null, httpStatus: 200, top: S.sha(top), full: S.sha(full), textHash: S.sha(text) });
  });
  const health = { status: 'ok', problems: [] };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, baseUrl: 'http://127.0.0.1:3000', health, scenes }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, kind: 'sweep', scope: { routes: ['/', '/tasks'], persons: ['guest'], states: ['normal'], viewports: ['d', 'm'], changedSince: null }, wholeApp: true }));
  writeFileSync(join(dir, 'source-hashes.json'), JSON.stringify({ schema: 1, routes: { '/': 'c'.repeat(16), '/tasks': 'd'.repeat(16) } }));
  // rule findings present in every run, on every screen: the re-check's controls
  const small = (slug, route, vp, selector, name) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${slug}.guest.normal.${vp}`, route, viewport: vp, selector, box: [16, 10, 60, 24], evidence: { name } });
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: L.annotate(['m', 'd'].flatMap(vp => [small('tasks', '/tasks', vp, 'a#home', 'Home'), small('~', '/', vp, 'a#see', 'See tasks')])) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
}
const answerAll = (unit, answer, over = {}) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.map(c => [c.id, over[c.id] ?? { answer }])) });
async function huntAndVerify(cwd, id, { lens = 'L9', rule = 'L9.destructive-without-confirm' } = {}) {
  const plan = await json(cwd, 'hunt', '--plan', '--run', id, '--lens', lens);
  const units = plan.units.map(u => (u.scenes[0].route !== '/tasks' ? answerAll(u, 'none') : answerAll(u, 'none', { [rule]: { answer: 'defect', defects: ['m', 'd'].map(vp => ({ scene: `tasks.guest.normal.${vp}`, selector: 'button#delete-all', claim: 'Delete all acts at once, with no confirmation.', severity: 'high' })) } })));
  writeFileSync(join(cwd, 'answers.json'), JSON.stringify({ plan: plan.id, units }));
  assert.equal((await cli(cwd, 'hunt', '--record', 'answers.json', '--run', id)).code, 0);
  assert.equal((await cli(cwd, 'verify', '--plan', '--run', id)).code, 0);
  const key = St.readKey(join(cwd, '.nunchi', 'runs', id), 'verify-key.json');
  writeFileSync(join(cwd, 'verdicts.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'high', reason: 'ok' }))));
  const r = await cli(cwd, 'verify', '--record', 'verdicts.json', '--run', id);
  assert.equal(r.code, 0, r.stderr);
}
const aiGroup = async cwd => (await json(cwd, 'findings', '--all')).groups.find(g => g.source === 'ai');
const answerKey = (key, item = 'gone', control = 'still-there') => Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.kind === 'control' ? control : item, reason: 'compared old and new' }));

test('CLI: recheck --plan / --record — the screens changed, every cell gone, the controls still there: fixed; the review page of that run shows it', async () => {
  const cwd = tmp('nunchi-recheck-cli-');
  makeRun(cwd, '0001');
  await huntAndVerify(cwd, '0001');
  assert.equal((await aiGroup(cwd)).status, 'open');
  const run2 = makeRun(cwd, '0002', 30);
  const packets = await json(cwd, 'recheck', '--plan');
  assert.equal(packets.packets.length, 5, '2 cells + 3 controls');
  for (const p of packets.packets) for (const f of [...p.old.files, ...p.new.files]) assert.ok(existsSync(join(run2, f)), f);
  // the mirror holds copies, all with one date: neither an inode nor a time tells an older run's screen apart
  const files = packets.packets.flatMap(p => [...p.old.files, ...p.new.files]);
  assert.ok(files.every(f => statSync(join(run2, f)).mtimeMs === R.MIRROR_TIME * 1000), 'one modification time');
  const original = statSync(join(cwd, '.nunchi', 'runs', '0001', 'tasks.guest.normal.m', 'top.jpg'));
  assert.ok(files.every(f => statSync(join(run2, f)).ino !== original.ino), 'copies, not links');
  assert.ok(!existsSync(join(run2, 'recheck-key.json')), 'the key is kept outside the project');
  const key = St.readKey(run2, 'recheck-key.json');
  writeFileSync(join(cwd, 'rv.json'), JSON.stringify(answerKey(key)));
  const rec = await cli(cwd, 'recheck', '--record', 'rv.json');
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /gone 2 · still there 0/);
  assert.match(rec.stdout, /controls 3 of 3 planned, passed through \(answered gone or unanswered\) 0\/3/);
  const doc = JSON.parse(readFileSync(join(run2, 'recheck.json'), 'utf8'));
  assert.equal(doc.suspect, false);
  const g = await aiGroup(cwd);
  assert.equal(g.status, 'fixed');
  assert.equal(g.example.goneAt, '0002');
  // the review page of run 0002 (re-checked, not hunted) takes its AI rows from the ledger
  const m = buildModel({ runDir: run2, nunchiDir: join(cwd, '.nunchi') });
  assert.deepEqual(m.groups.filter(x => x.source === 'ai').map(x => [x.rule, x.status]), [['L9.destructive-without-confirm', 'fixed']]);
  makeRun(cwd, '0003', 30);
  const none = await cli(cwd, 'recheck', '--plan');
  assert.match(none.stdout, /no open AI findings to re-check/);
});

test('CLI: unchanged screens and code need no packet (recorded at once, still there); a suspect batch says so and fixes nothing', async () => {
  const cwd = tmp('nunchi-recheck-same-');
  makeRun(cwd, '0001');
  await huntAndVerify(cwd, '0001', { lens: 'L6', rule: 'L6.unclear-label' });
  const run2 = makeRun(cwd, '0002');
  const r = await cli(cwd, 'recheck', '--plan');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /nothing to ask: 2 finding × screen\(s\) unchanged/);
  let g = await aiGroup(cwd);
  assert.deepEqual([g.status, g.example.lastSeen], ['open', '0002'], 'still there, seen now');
  const m = buildModel({ runDir: run2, nunchiDir: join(cwd, '.nunchi') });
  assert.deepEqual(m.groups.filter(x => x.source === 'ai').map(x => x.status), ['open'], 'the review page of 0002 shows it still there');
  // changed screens, the controls answered gone: suspect
  const run3 = makeRun(cwd, '0003', 31);
  assert.equal((await cli(cwd, 'recheck', '--plan')).code, 0);
  const key = St.readKey(run3, 'recheck-key.json');
  writeFileSync(join(cwd, 'rv.json'), JSON.stringify(answerKey(key, 'gone', 'gone')));
  const rec = await cli(cwd, 'recheck', '--record', 'rv.json');
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /SUSPECT: control pass-through 3\/3/);
  g = await aiGroup(cwd);
  assert.equal(g.status, 'open', 'a suspect batch never sets goneAt');
});

test('CLI: the ledger folds the verdicts recorded in the re-check key, never a recheck.json written by hand', async () => {
  const cwd = tmp('nunchi-recheck-forged-');
  makeRun(cwd, '0001');
  await huntAndVerify(cwd, '0001');
  const run2 = makeRun(cwd, '0002', 30);
  assert.equal((await cli(cwd, 'recheck', '--plan')).code, 0);
  const key = St.readKey(run2, 'recheck-key.json');
  const fp = Object.values(key.packets).find(k => k.kind === 'item').fp;
  // an agent writes the outcome it wants: every cell gone, not suspect
  const forged = { schema: 1, plan: key.plan, run: '0002', suspect: false, verdicts: { gone: 2 }, controls: { planned: 3, total: 3, answered: 3, passedThrough: 0, rate: 0 },
    results: [{ fp, cells: { 'guest.normal.d': { verdict: 'gone' }, 'guest.normal.m': { verdict: 'gone' } } }] };
  writeFileSync(join(run2, 'recheck.json'), JSON.stringify(forged));
  assert.equal((await aiGroup(cwd)).status, 'open', 'not folded: no verdicts in the key');
  // the verdicts recorded in the key are what counts: still there, while recheck.json says gone
  writeFileSync(join(cwd, 'rv.json'), JSON.stringify(answerKey(key, 'still-there')));
  assert.equal((await cli(cwd, 'recheck', '--record', 'rv.json')).code, 0);
  writeFileSync(join(run2, 'recheck.json'), JSON.stringify(forged));
  const g = await aiGroup(cwd);
  assert.deepEqual([g.status, g.example.lastSeen], ['open', '0002']);
});

test('CLI: a re-check against a run older than the item\'s last sighting is refused for that item, and said', async () => {
  const cwd = tmp('nunchi-recheck-older-');
  makeRun(cwd, '0001');
  makeRun(cwd, '0002', 30);
  await huntAndVerify(cwd, '0002');
  const r = await cli(cwd, 'recheck', '--plan', '--run', '0001');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no open AI findings to re-check against run 0001 \(1 open AI finding\(s\) were seen in a run newer than 0001/);
  assert.equal((await aiGroup(cwd)).status, 'open');
});
