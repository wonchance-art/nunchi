// The AI re-check (design 0.1-c §2.4, M1): packets per (AI item × cell) whose screen changed, unchanged screens skipped,
// still-present controls, suspect batches that fix nothing, every cell gone to fix, insufficient = needs you.
// Synthetic runs, invented content; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as S from '../src/stable.mjs';
import * as St from '../src/state.mjs';
import * as R from '../src/recheck.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
process.env.XDG_STATE_HOME = tmp('nunchi-recheck-xdg-');
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const json = async (cwd, ...a) => { const r = await cli(cwd, ...a, '--json'); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };

// ---- fold-level: rows as the ledger's view gives them -----------------------------------------------------------

const AIF = (cell, over = {}) => {
  const f = { source: 'ai', lens: 'L9', rule: 'L9.destructive-without-confirm', route: '/tasks', selector: 'button#delete-all', evidence: { claim: 'Delete all acts at once.' }, ...(over.identity ? { identity: over.identity } : {}) };
  const { fp, group, inputs } = L.fingerprintOf(f);
  return { fp, group, inputs, lens: f.lens, rule: f.rule, route: '/tasks', scene: `tasks.${cell}`, cell, selector: f.selector, box: [150, 120, 100, 40], evidence: f.evidence, identity: null, status: 'confirmed', claimedSeverity: 'high', verdictSeverity: 'high', by: 'same-model check', vendor: null, suspect: false, sceneHash: { top: `top-${cell}`, full: `full-${cell}`, textHash: `text-${cell}` }, ...over };
};
const scene = (cell, hashes = {}) => { const [person, state, viewport] = cell.split('.'); return { id: `tasks.${cell}`, route: '/tasks', person, state, viewport, status: 'captured', reason: null, httpStatus: 200, top: `top-${cell}`, full: `full-${cell}`, textHash: `text-${cell}`, ...hashes }; };
const stateWith = (findings, now = 1000) => L.foldAi(L.emptyState(), { run: '0001', key: 'k', findings, now });
const RULE = cell => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `tasks.${cell}`, route: '/tasks', viewport: cell.split('.')[2], selector: 'a#home', box: [16, 10, 60, 24], evidence: { name: 'Home' } });

test('plan: one packet per AI item × cell whose screen changed; an unchanged screen is still there (no packet); a cell not captured cannot fix it', () => {
  const st = stateWith([AIF('guest.normal.m'), AIF('guest.normal.d')]);
  const rows = L.view(st, []);
  const manifest = { scenes: [scene('guest.normal.m', { top: 'changed' }), scene('guest.normal.d')] };
  const plan = R.planRecheck({ runId: '0002', manifest, rows });
  assert.deepEqual(Object.values(plan.key.packets), [{ kind: 'item', fp: rows[0].fp, cell: 'guest.normal.m' }]);
  assert.deepEqual(plan.key.unchanged, [{ fp: rows[0].fp, cell: 'guest.normal.d' }]);
  assert.deepEqual(plan.key.controls, { planned: 1, made: 0 }, 'one control called for, none could be made here');
  const missing = R.planRecheck({ runId: '0002', manifest: { scenes: [scene('guest.normal.m', { top: 'changed' })] }, rows });
  assert.deepEqual(missing.key.notCaptured, [{ fp: rows[0].fp, cell: 'guest.normal.d' }]);
  // a packet: the claim, the old screen (element and box) and the new one, by alias; no diff, commit or fix brief
  const [p] = plan.packets.packets;
  assert.deepEqual(Object.keys(p).sort(), ['claim', 'new', 'old', 'packet']);
  assert.deepEqual(p.claim, { lens: 'L9', what: 'Delete all acts at once.' });
  assert.match(p.old.scene, /^s[0-9a-f]{10}$/); assert.match(p.new.scene, /^s[0-9a-f]{10}$/);
  assert.notEqual(p.old.scene, p.new.scene);
  assert.deepEqual([p.old.selector, p.old.box], ['button#delete-all', [150, 120, 100, 40]]);
  assert.ok(p.old.files.every(f => f.startsWith(`recheck/${p.old.scene}/`)));
  const text = JSON.stringify(plan.packets);
  assert.ok(!/0001|0002|tasks\.guest|diff|commit|fix brief/i.test(text.replace(plan.packets.instructions, '')), 'no run, scene id, diff, commit or brief');
  assert.deepEqual(R.planRecheck({ runId: '0002', manifest, rows }), plan, 'deterministic');
  // items not standing are not re-checked: fixed, kept, dismissed
  const keep = { schema: 1, id: 'dk-1', target: { fp: rows[0].fp }, decision: 'keep', reason: 'intended', by: 'me', at: '2026-10-14T10:00:00.000+09:00' };
  assert.equal(R.planRecheck({ runId: '0002', manifest, rows: L.view(st, [keep], new Set([L.approvalKey(keep)]), { now: Date.parse('2026-10-15T00:00:00+09:00') }) }).packets.packets.length, 0);
});

test('plan: a grounded source file decides "unchanged" only on the tree the run was captured from, by its hash', () => {
  const identity = { element: 'button#delete-all', file: 'app/tasks.tsx', anchor: 'a'.repeat(16), component: { file: 'app/tasks.tsx', name: 'Delete all' }, fileHash: 'b'.repeat(16) };
  const rows = L.view(stateWith([AIF('guest.normal.m', { identity })]), []);
  const manifest = { scenes: [scene('guest.normal.m')] };
  const packets = opts => R.planRecheck({ runId: '0002', manifest, rows, ...opts }).key;
  assert.equal(packets({ sameTree: true, fileHashOf: () => 'b'.repeat(16) }).unchanged.length, 1, 'same screen, same code: still there');
  assert.equal(Object.keys(packets({ sameTree: true, fileHashOf: () => 'c'.repeat(16) }).packets).length, 1, 'the code changed: asked');
  assert.equal(Object.keys(packets({ sameTree: false, fileHashOf: () => 'b'.repeat(16) }).packets).length, 1, 'another tree than the run\'s: asked');
});

test('plan: controls are still-present defects — rule findings present in the previous run and this one, and canary copies — screens that changed first', () => {
  const rows = L.view(stateWith(['guest.normal.m', 'guest.normal.d', 'signed-in.normal.m', 'signed-in.normal.d'].map(c => AIF(c))), []);
  const changed = c => scene(c, { top: `new-${c}` });
  const manifest = { scenes: ['guest.normal.m', 'guest.normal.d', 'signed-in.normal.m', 'signed-in.normal.d'].map(changed) };
  const previous = { runId: '0001', manifest: { scenes: ['guest.normal.m', 'guest.normal.d'].map(c => scene(c)) }, findings: L.annotate([RULE('guest.normal.m'), RULE('guest.normal.d')]) };
  const canaries = { planted: [{ scene: 'tasks.guest.normal.m.canary-1', kind: 'vague-error', lens: 'L6', checklist: 'L6.vague-error', selector: 'p.err', box: [0, 0, 10, 10] }] };
  manifest.scenes.push({ ...scene('guest.normal.m'), id: 'tasks.guest.normal.m.canary-1', canary: 1 });
  const plan = R.planRecheck({ runId: '0002', manifest, rows, previous, runFindings: L.annotate([RULE('guest.normal.m')]), canaries });
  assert.equal(plan.key.controls.planned, 1, '4 real packets call for 1 control');
  const controls = Object.entries(plan.key.packets).filter(([, k]) => k.kind === 'control');
  assert.deepEqual(controls.map(([, k]) => k.control), ['rule'], 'a changed screen before an identical canary copy');
  const p = plan.packets.packets.find(x => x.packet === controls[0][0]);
  assert.equal(p.claim.what, 'Tap target smaller than 24px: “Home”.');
  assert.deepEqual(Object.keys(p).sort(), ['claim', 'new', 'old', 'packet'], 'a control has the shape of a real packet');
  // with no rule control, the canary copy serves; its old and new side go by different names
  const viaCanary = R.planRecheck({ runId: '0002', manifest, rows, canaries });
  const c = viaCanary.packets.packets.find(x => viaCanary.key.packets[x.packet].kind === 'control');
  assert.equal(c.claim.what, 'The error message does not say what went wrong or what to do.');
  assert.notEqual(c.old.scene, c.new.scene);
  assert.ok(!JSON.stringify(viaCanary.packets).includes('canary'));
});

test('record and fold: fixed only when every cell says gone and the batch is not suspect; still-there keeps it; insufficient needs you', () => {
  const st = stateWith([AIF('guest.normal.m'), AIF('guest.normal.d')]);
  const rows = L.view(st, []);
  const fp = rows[0].fp;
  const manifest = { scenes: [scene('guest.normal.m', { top: 'x' }), scene('guest.normal.d', { top: 'y' })] };
  const previous = { runId: '0001', manifest: { scenes: [scene('guest.normal.m')] }, findings: L.annotate([RULE('guest.normal.m')]) };
  const plan = R.planRecheck({ runId: '0002', manifest, rows, previous, runFindings: L.annotate([RULE('guest.normal.m')]) });
  assert.deepEqual(plan.key.controls, { planned: 1, made: 1 });
  const answer = (item, control = 'still-there', over = {}) => Object.entries(plan.key.packets).map(([packet, k]) => ({ packet, verdict: k.kind === 'control' ? control : (over[k.cell] ?? item), reason: 'looked at both screens' }));
  const after = verdicts => {
    const r = R.recordRecheck({ key: plan.key, packets: plan.packets, verdicts });
    assert.deepEqual(r.problems, []);
    return { r, st: L.foldRecheck(st, { run: '0002', key: S.sha(S.stableJson(r.recheck)), ...R.recheckInput(r.recheck), now: 2000 }) };
  };
  let { r, st: s } = after(answer('gone'));
  assert.equal(r.recheck.suspect, false);
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
  assert.match(r.recheck.suspectReason, /control pass-through 1\/1/);
  assert.equal(Object.values(s.items)[0].goneAt, null);
  // fewer controls than planned: suspect too
  const bare = R.planRecheck({ runId: '0002', manifest, rows });
  const rb = R.recordRecheck({ key: bare.key, packets: bare.packets, verdicts: Object.keys(bare.key.packets).map(packet => ({ packet, verdict: 'gone', reason: 'ok' })) });
  assert.match(rb.recheck.suspectReason, /fewer controls than planned \(0 of 1\)/);
  assert.equal(L.foldRecheck(st, { run: '0002', key: 'x', ...R.recheckInput(rb.recheck) }).items[fp].goneAt, null);
  // a claim after it was gone brings it back
  ({ st: s } = after(answer('gone')));
  s = L.foldAi(s, { run: '0003', key: 'k3', findings: [AIF('guest.normal.m')], now: 3000 });
  assert.deepEqual([Object.values(s.items)[0].goneAt, Object.values(s.items)[0].regressedAt, L.view(s, [])[0].status], [null, '0003', 'regressed']);
  // recording again with other verdicts replaces the re-check's contribution
  ({ st: s } = after(answer('gone')));
  const again = R.recordRecheck({ key: plan.key, packets: plan.packets, verdicts: answer('still-there') }).recheck;
  s = L.foldRecheck(s, { run: '0002', key: 'other', ...R.recheckInput(again), now: 2500 });
  assert.equal(Object.values(s.items)[0].goneAt, null);
  assert.equal(Object.values(s.items)[0].rechecks.length, 1);
});

test('record: verdicts are data — unknown packets, other verdicts, two lines and a stale plan are refused', () => {
  const rows = L.view(stateWith([AIF('guest.normal.m')]), []);
  const plan = R.planRecheck({ runId: '0002', manifest: { scenes: [scene('guest.normal.m', { top: 'x' })] }, rows });
  const id = Object.keys(plan.key.packets)[0];
  const bad = R.recordRecheck({ key: plan.key, packets: plan.packets, verdicts: [{ packet: 'p999', verdict: 'gone', reason: 'x' }, { packet: id, verdict: 'fixed', reason: 'x\ny' }] });
  assert.equal(bad.problems.length, 3, bad.problems.join('\n'));
  assert.match(R.recordRecheck({ key: plan.key, packets: { ...plan.packets, plan: 'ffffffffffff' }, verdicts: [] }).problems[0], /run recheck --plan again/);
  // recheck.json without `suspect` folds as suspect: nothing it says is gone counts
  assert.equal(R.recheckInput({ results: [] }).suspect, true);
});

// ---- the CLI, end to end ----------------------------------------------------------------------------------------

const jpeg = (w, h, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);
const ctl = (selector, name, box, extra = {}) => ({ selector, tag: 'button', role: null, name, hasText: true, text: name, box, href: null, inline: false, ...extra });
const CONTROLS = [ctl('button#delete-all', 'Delete all', [150, 120, 100, 40]), ctl('button#add-task', 'Add Task', [16, 120, 120, 40]), ctl('a#home', 'Home', [16, 10, 60, 24], { tag: 'a', href: '/' })];
function makeRun(cwd, id, salts = {}) {
  const dir = join(cwd, '.nunchi', 'runs', id);
  const scenes = [];
  for (const [slug, route, vp, salt] of [['~', '/', 'm', 1], ['~', '/', 'd', 2], ['tasks', '/tasks', 'm', salts.m ?? 3], ['tasks', '/tasks', 'd', salts.d ?? 4]]) {
    const sid = `${slug}.guest.normal.${vp}`, d = join(dir, sid);
    mkdirSync(d, { recursive: true });
    const top = jpeg(vp === 'm' ? 390 : 1280, 800, salt), full = jpeg(vp === 'm' ? 390 : 1280, 1200, salt + 50), text = route === '/tasks' ? 'Tasks\nDelete all\n' : 'Home\n';
    writeFileSync(join(d, 'top.jpg'), top); writeFileSync(join(d, 'full.jpg'), full); writeFileSync(join(d, 'text.txt'), text);
    writeFileSync(join(d, 'aria.yml'), '- button "Delete all"\n');
    writeFileSync(join(d, 'controls.json'), JSON.stringify(route === '/tasks' ? CONTROLS : [ctl('a#see', 'See tasks', [1, 1, 80, 30], { tag: 'a' })]));
    for (const n of ['styles.json', 'links.json']) writeFileSync(join(d, n), '[]');
    writeFileSync(join(d, 'measure.json'), JSON.stringify({ clipped: [], images: [], scrollers: [], hiddenControls: [] }));
    scenes.push({ id: sid, route, path: route, person: 'guest', state: 'normal', viewport: vp, status: 'captured', reason: null, httpStatus: 200, top: S.sha(top), full: S.sha(full), textHash: S.sha(text) });
  }
  const health = { status: 'ok', problems: [] };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, baseUrl: 'http://127.0.0.1:3000', health, scenes }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, kind: 'sweep', scope: { routes: ['/', '/tasks'], persons: ['guest'], states: ['normal'], viewports: ['d', 'm'], changedSince: null }, wholeApp: true }));
  // a rule finding present in every run: the re-check's control
  const small = vp => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `tasks.guest.normal.${vp}`, route: '/tasks', viewport: vp, selector: 'a#home', box: [16, 10, 60, 24], evidence: { name: 'Home' } });
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: L.annotate([small('m'), small('d')]) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
}
const answerAll = (unit, answer, over = {}) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.map(c => [c.id, over[c.id] ?? { answer }])) });
async function huntAndVerify(cwd, id) {
  const plan = await json(cwd, 'hunt', '--plan', '--run', id, '--lens', 'L9');
  const units = plan.units.map(u => (u.scenes[0].route !== '/tasks' ? answerAll(u, 'none') : answerAll(u, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: ['m', 'd'].map(vp => ({ scene: `tasks.guest.normal.${vp}`, selector: 'button#delete-all', claim: 'Delete all acts at once, with no confirmation.', severity: 'high' })) } })));
  writeFileSync(join(cwd, 'answers.json'), JSON.stringify({ plan: plan.id, units }));
  assert.equal((await cli(cwd, 'hunt', '--record', 'answers.json', '--run', id)).code, 0);
  assert.equal((await cli(cwd, 'verify', '--plan', '--run', id)).code, 0);
  const key = St.readKey(join(cwd, '.nunchi', 'runs', id), 'verify-key.json');
  writeFileSync(join(cwd, 'verdicts.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'high', reason: 'ok' }))));
  const r = await cli(cwd, 'verify', '--record', 'verdicts.json', '--run', id);
  assert.equal(r.code, 0, r.stderr);
}
const aiGroup = async cwd => (await json(cwd, 'findings', '--all')).groups.find(g => g.source === 'ai');

test('CLI: recheck --plan / --record — the screens changed, every cell gone, the control still there: fixed; nothing left to ask afterwards', async () => {
  const cwd = tmp('nunchi-recheck-cli-');
  makeRun(cwd, '0001');
  await huntAndVerify(cwd, '0001');
  assert.equal((await aiGroup(cwd)).status, 'open');
  const run2 = makeRun(cwd, '0002', { m: 30, d: 40 });
  const packets = await json(cwd, 'recheck', '--plan');
  assert.equal(packets.packets.length, 3, '2 cells + 1 control');
  for (const p of packets.packets) for (const f of [...p.old.files, ...p.new.files]) assert.ok(existsSync(join(run2, f)), f);
  assert.ok(!existsSync(join(run2, 'recheck-key.json')), 'the key is kept outside the project');
  const key = St.readKey(run2, 'recheck-key.json');
  writeFileSync(join(cwd, 'rv.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.kind === 'control' ? 'still-there' : 'gone', reason: 'compared old and new' }))));
  const rec = await cli(cwd, 'recheck', '--record', 'rv.json');
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /gone 2 · still there 0/);
  const doc = JSON.parse(readFileSync(join(run2, 'recheck.json'), 'utf8'));
  assert.equal(doc.suspect, false);
  const g = await aiGroup(cwd);
  assert.equal(g.status, 'fixed');
  assert.equal(g.example.goneAt, '0002');
  makeRun(cwd, '0003', { m: 30, d: 40 });
  const none = await cli(cwd, 'recheck', '--plan');
  assert.match(none.stdout, /no open AI findings to re-check/);
});

test('CLI: unchanged screens need no packet (recorded at once, still there); a suspect batch says so and fixes nothing', async () => {
  const cwd = tmp('nunchi-recheck-same-');
  makeRun(cwd, '0001');
  await huntAndVerify(cwd, '0001');
  makeRun(cwd, '0002');
  const r = await cli(cwd, 'recheck', '--plan');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /nothing to ask: 2 finding × screen\(s\) unchanged/);
  let g = await aiGroup(cwd);
  assert.deepEqual([g.status, g.example.lastSeen], ['open', '0002'], 'still there, seen now');
  // changed screens, the control answered gone: suspect
  const run3 = makeRun(cwd, '0003', { m: 31, d: 41 });
  assert.equal((await cli(cwd, 'recheck', '--plan')).code, 0);
  const key = St.readKey(run3, 'recheck-key.json');
  writeFileSync(join(cwd, 'rv.json'), JSON.stringify(Object.keys(key.packets).map(packet => ({ packet, verdict: 'gone', reason: 'gone' }))));
  const rec = await cli(cwd, 'recheck', '--record', 'rv.json');
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /SUSPECT: control pass-through 1\/1/);
  g = await aiGroup(cwd);
  assert.equal(g.status, 'open', 'a suspect batch never sets goneAt');
});
