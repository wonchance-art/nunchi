// Hunt planner and answer recorder (spec §4) on a synthetic run folder: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLenses } from '../src/lenses.mjs';
import { planHunt, recordHunt, jpegSize, imageTokens, IMAGE_TOKENS_MAX } from '../src/hunt.mjs';
import { stableJson, sha } from '../src/stable.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-hunt-')));

// A JPEG header is all the estimate reads: SOI, a baseline SOF0 with the size, EOI.
function fakeJpeg(width, height) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}

const VP = { m: [390, 844], d: [1280, 800] };
// Pebble Garden, an invented app: '/' and '/tasks' captured at both widths, '/tasks' also in its error
// state, '/notes' failed to load, '/old' redirected.
function makeRun(dir) {
  const scenes = [];
  const add = (slug, route, state, vp, extra = {}) => {
    const id = `${slug}.guest.${state}.${vp}`;
    scenes.push({ id, route, path: route, person: 'guest', state, viewport: vp, status: 'captured', reason: null, ...extra });
    if (extra.status === 'capture-failed') return;
    const d = join(dir, id);
    mkdirSync(d, { recursive: true });
    const [w, h] = VP[vp];
    writeFileSync(join(d, 'top.jpg'), fakeJpeg(w, h));
    writeFileSync(join(d, 'full.jpg'), fakeJpeg(w, route === '/tasks' ? 2400 : h));
    const text = state === 'error' ? 'Pebble Garden\nOops! Something went wrong.\n' : route === '/' ? 'Pebble Garden\nWelcome back, Mira.\nSee tasks\n' : 'Tasks\nWater the fern\nAdd Task\nDelete all\n';
    writeFileSync(join(d, 'text.txt'), text);
    writeFileSync(join(d, 'aria.yml'), route === '/tasks' ? '- heading "Tasks" [level=1]\n- paragraph: Oops! Something went wrong.\n- button "Delete all"\n- link "Home":\n  - /url: /\n' : '- heading "Pebble Garden" [level=1]\n- link "See tasks":\n  - /url: /tasks\n');
    const controls = route === '/tasks'
      ? [{ selector: 'button#add-task', name: 'Add Task', box: [16, vp === 'm' ? 900 : 120, 120, 40], tag: 'button' }, { selector: 'button#delete-all', name: 'Delete all', box: [150, 120, 100, 40], tag: 'button' }]
      : [{ selector: 'a#see-tasks', name: 'See tasks', box: [16, 200, 90, 24], tag: 'a', href: '/tasks' }];
    writeFileSync(join(d, 'controls.json'), JSON.stringify(controls, null, 2));
    writeFileSync(join(d, 'styles.json'), JSON.stringify([{ selector: 'main > p', role: 'text', color: 'rgb(29, 31, 35)' }], null, 2));
    writeFileSync(join(d, 'links.json'), JSON.stringify(route === '/' ? [{ path: '/tasks', selector: 'a#see-tasks', visible: true, landmark: null }] : [], null, 2));
    writeFileSync(join(d, 'measure.json'), JSON.stringify({ clipped: [], images: [], scrollers: [], hiddenControls: [], viewport: { width: w, height: h } }, null, 2));
  };
  for (const vp of ['m', 'd']) {
    add('~', '/', 'normal', vp);
    add('tasks', '/tasks', 'normal', vp);
  }
  add('tasks', '/tasks', 'error', 'm');
  add('notes', '/notes', 'normal', 'm', { status: 'capture-failed', reason: 'no-dom' });
  add('old', '/old', 'normal', 'm', { reason: 'redirected to /' });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, health: { status: 'ok', problems: [] }, scenes }, null, 2));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id: '0001' }));
  return dir;
}

function setup() {
  const cwd = tmp();
  const runDir = makeRun(join(cwd, '.nunchi', 'runs', '0001'));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), '0001\n');
  mkdirSync(join(cwd, 'app'), { recursive: true });
  writeFileSync(join(cwd, 'app', 'tasks.tsx'), 'export default function Tasks() {\n  return <button onClick={() => store.clear()}>Delete all</button>;\n}\n');
  return { cwd, runDir, lenses: loadLenses({ root: cwd }).lenses };
}

// Answer every item of a unit with `answer`; override some items.
const answerAll = (unit, answer, over = {}) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.map(c => [c.id, over[c.id] ?? { answer }])) });

test('jpeg size and image tokens', () => {
  assert.deepEqual(jpegSize(fakeJpeg(1280, 800)), { width: 1280, height: 800 });
  assert.equal(imageTokens(fakeJpeg(1280, 800)), Math.ceil(1280 * 800 / 750));
  assert.equal(imageTokens(fakeJpeg(390, 5000)), Math.ceil(122 * 1568 / 750), 'tall pages are scaled to 1568 px');
  assert.equal(imageTokens(Buffer.from('not a jpeg')), IMAGE_TOKENS_MAX);
});

test('plan: units group viewports, carry a reference scene, list the reviewed scene last', () => {
  const { runDir, lenses } = setup();
  const plan = planHunt({ runDir, lenses, runId: '0001' });
  const l6 = plan.units.filter(u => u.lens === 'L6');
  const tasks = l6.find(u => u.scenes[0].route === '/tasks' && u.scenes[0].state === 'normal');
  assert.deepEqual(tasks.scenes.map(s => s.scene), ['tasks.guest.normal.d', 'tasks.guest.normal.m'], 'one unit for both widths');
  assert.equal(tasks.reference.route, '/', 'reference is another route');
  assert.equal(tasks.reference.viewport, 'd'); assert.equal(tasks.reference.person, 'guest');
  assert.ok(tasks.files[0].startsWith('~.guest.normal.d/'), 'reference first');
  assert.ok(tasks.files[tasks.files.length - 1].startsWith('tasks.guest.normal.m/'), 'reviewed scene last');
  assert.ok(tasks.tokens > 0);
  // the error state: L2 applies (forced states only), its reference prefers the same state, else normal
  const l2 = plan.units.filter(u => u.lens === 'L2');
  assert.deepEqual(l2.map(u => u.scenes.map(s => s.scene)), [['tasks.guest.error.m']]);
  assert.equal(l2[0].reference.scene, '~.guest.normal.m');
  assert.deepEqual(l2[0].checklist.map(c => c.id), ['L2.what-happened', 'L2.next-step', 'L2.looks-normal', 'L2.endless-loading'], 'slow-only item left out');
  // L10's phone-only item names the phone scene
  const l10 = plan.units.find(u => u.lens === 'L10' && u.scenes[0].route === '/tasks');
  assert.deepEqual(l10.checklist.find(c => c.id === 'L10.primary-not-in-first-view').scenes, ['tasks.guest.normal.m']);
  // not huntable scenes are listed, never dropped
  assert.ok(plan.notSeen.some(n => n.scene === 'notes.guest.normal.m' && n.reason === 'no-dom'));
  assert.ok(plan.notSeen.some(n => n.scene === 'old.guest.normal.m' && n.reason === 'redirected'));
  assert.ok(plan.units.every(u => u.status === 'planned'));
  assert.equal(plan.estimate.total, plan.units.reduce((n, u) => n + u.tokens, 0));
});

test('plan: deterministic — two plans are byte-identical, unit ids stable', () => {
  const { runDir, lenses } = setup();
  const a = stableJson(planHunt({ runDir, lenses, runId: '0001' }));
  const b = stableJson(planHunt({ runDir, lenses: loadLenses({ root: tmp() }).lenses, runId: '0001' }));
  assert.equal(a, b);
  const other = setup();
  assert.equal(stableJson(planHunt({ runDir: other.runDir, lenses: other.lenses, runId: '0001' })), a, 'a different folder with the same evidence gives the same plan');
});

test('plan: budget cuts units into not-seen: budget, never drops them; --lens filters', () => {
  const { runDir, lenses } = setup();
  const full = planHunt({ runDir, lenses });
  const first = full.units[0].tokens;
  const cut = planHunt({ runDir, lenses, budget: first + 1 });
  assert.equal(cut.units.length, full.units.length, 'nothing dropped');
  assert.deepEqual(cut.units.map(u => u.id), full.units.map(u => u.id));
  assert.equal(cut.units[0].status, 'planned');
  assert.ok(cut.units.slice(1).every(u => u.status === 'not-seen' && u.reason === 'budget'));
  assert.equal(cut.estimate.planned, first);
  assert.equal(cut.estimate.units.cut, full.units.length - 1);
  assert.equal(full.units[0].scenes[0].state, 'normal', 'normal screens are spent on first');
  const only = planHunt({ runDir, lenses, lensIds: ['L6'] });
  assert.ok(only.units.length && only.units.every(u => u.lens === 'L6'));
  assert.throws(() => planHunt({ runDir, lenses, lensIds: ['L3'] }), e => e.code === 'BAD_ARGS');
});

test('record: grounded claims accepted, image-only and invented selectors rejected, coverage per cell', () => {
  const { cwd, runDir, lenses } = setup();
  const plan = planHunt({ runDir, lenses, runId: '0001' });
  const l6 = plan.units.find(u => u.lens === 'L6' && u.scenes[0].state === 'error');
  const l5 = plan.units.find(u => u.lens === 'L5' && u.scenes[0].route === '/tasks' && u.scenes[0].state === 'normal');
  const l9 = plan.units.find(u => u.lens === 'L9' && u.scenes[0].route === '/tasks');
  const l1 = plan.units.find(u => u.lens === 'L1' && u.scenes[0].route === '/tasks');
  const l7 = plan.units.find(u => u.lens === 'L7' && u.scenes[0].route === '/');
  const answers = { schema: 1, plan: plan.id, units: [
    answerAll(l6, 'none', { 'L6.vague-error': { answer: 'defect', defects: [{ scene: 'tasks.guest.error.m', selector: 'aria=paragraph: Oops! Something went wrong.', claim: 'The error says nothing about what failed or what to do.', severity: 'medium' }] } }),
    answerAll(l5, 'none', { 'L5.mixed-capitalisation': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.d', selector: 'button#add-task', claim: '"Add Task" is Title Case; "Delete all" is Sentence case.', severity: 'low' }] } }),
    answerAll(l9, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.m', selector: 'button#delete-all', source: 'app/tasks.tsx:2', claim: '"Delete all" clears the store on click, no confirmation or undo.', severity: 'high' }] } }),
    // image-only claim: the only defect of its item is rejected, so the unit is not seen
    answerAll(l1, 'none', { 'L1.overlap': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.m', claim: 'The header overlaps the list in the screenshot.', severity: 'medium' }] } }),
    // a selector that is not in the evidence, and one checklist item left out
    { unit: l7.id, items: { ...answerAll(l7, 'cannot-judge').items, 'L7.debug-ui': { answer: 'defect', defects: [{ scene: '~.guest.normal.d', selector: 'div.debug-panel', claim: 'A debug panel.', severity: 'high' }] }, 'L7.drifted-nav': undefined } },
    { unit: 'ffffffffffff', items: {} },
  ] };
  const r = recordHunt({ runDir, plan, answers, root: cwd });
  assert.deepEqual(r.findings.map(f => [f.lens, f.rule, f.scene, f.selector, f.severity]), [
    ['L9', 'L9.destructive-without-confirm', 'tasks.guest.normal.m', 'button#delete-all', 'high'],
    ['L6', 'L6.vague-error', 'tasks.guest.error.m', 'aria=paragraph: Oops! Something went wrong.', 'medium'],
    ['L5', 'L5.mixed-capitalisation', 'tasks.guest.normal.d', 'button#add-task', 'low'],
  ]);
  const l9f = r.findings[0];
  assert.deepEqual(l9f.box, [150, 120, 100, 40], 'box from controls.json');
  assert.equal(l9f.source, 'ai'); assert.equal(l9f.status, 'claimed'); assert.equal(l9f.route, '/tasks'); assert.equal(l9f.viewport, 'm');
  assert.deepEqual(l9f.evidence, { claim: '"Delete all" clears the store on click, no confirmation or undo.', unit: l9.id, groundedIn: ['controls.json', 'source'], file: 'app/tasks.tsx', line: 2 });
  assert.equal(r.findings[1].box, null, 'aria nodes have no box');
  const reasons = r.rejected.map(x => x.reason).sort();
  assert.deepEqual(reasons, ['selector-not-in-evidence', 'ungrounded', 'unknown-unit']);
  const cell = (lens, scene) => r.coverage.cells.find(c => c.lens === lens && c.scene === scene);
  assert.equal(cell('L6', 'tasks.guest.error.m').status, 'seen');
  assert.equal(cell('L9', 'tasks.guest.normal.d').status, 'seen', 'both scenes of a unit are seen together');
  assert.deepEqual([cell('L1', 'tasks.guest.normal.m').status, cell('L1', 'tasks.guest.normal.m').reason, cell('L1', 'tasks.guest.normal.m').missing], ['not-seen', 'incomplete', ['L1.overlap']]);
  assert.deepEqual(cell('L7', '~.guest.normal.m').missing, ['L7.debug-ui', 'L7.drifted-nav'], 'missing item and rejected defect both leave the unit unseen');
  assert.equal(cell('L2', 'tasks.guest.error.m').reason, 'not-answered');
  assert.equal(cell('L6', 'notes.guest.normal.m').reason, 'no-dom');
  assert.equal(r.coverage.summary.units.seen, 3);
  // same answers → same output, whatever the order they come in
  const again = recordHunt({ runDir, plan, answers: { ...answers, units: answers.units.slice().reverse() }, root: cwd });
  assert.equal(stableJson(again), stableJson(r));
});

test('record: answers are data — bad shapes, path escapes and stale plans are refused, nothing is run', () => {
  const { cwd, runDir, lenses } = setup();
  const plan = planHunt({ runDir, lenses, lensIds: ['L9'], budget: 1 });
  const unit = plan.units.find(u => u.scenes[0].route === '/tasks');
  const d = over => ({ scene: 'tasks.guest.normal.m', claim: 'x', severity: 'high', ...over });
  const r = recordHunt({ runDir, plan, root: cwd, answers: { units: [
    answerAll(unit, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: [
      d({ source: '../../etc/passwd:1' }),
      d({ source: 'app/tasks.tsx:99' }),
      d({ source: '.nunchi/runs/0001/manifest.json:1' }),
      d({ selector: 'button#delete-all', scene: '~.guest.normal.m' }),
      d({ selector: 'button#delete-all', severity: 'critical' }),
      d({ selector: 'button#delete-all', exec: 'process.exit(1)' }),
      d({ selector: 'button#delete-all', claim: '' }),
    ] }, 'L9.input-lost-on-leave': { answer: 'maybe' } }),
  ] } });
  assert.equal(r.findings.length, 0);
  const why = r.rejected.map(x => x.reason + (x.detail ? `: ${x.detail}` : ''));
  assert.ok(why.some(x => /outside the app root/.test(x)), why.join('\n'));
  assert.ok(why.some(x => /line 99 is outside the file/.test(x)));
  assert.ok(why.some(x => /not \.nunchi/.test(x)));
  assert.ok(why.some(x => /^scene-not-under-review/.test(x)));
  assert.ok(why.some(x => /^bad-severity/.test(x)));
  assert.ok(why.some(x => /^bad-shape: unknown key\(s\) exec/.test(x)));
  assert.ok(why.some(x => /^bad-claim/.test(x)));
  assert.ok(why.some(x => /^bad-answer: answer must be one of/.test(x)));
  const cells = r.coverage.cells.filter(c => c.unit === unit.id);
  assert.ok(cells.every(c => c.status === 'not-seen' && c.reason === 'incomplete'));
  // a unit cut by the budget and not answered keeps that reason
  assert.ok(r.coverage.cells.some(c => c.unit !== unit.id && c.reason === 'budget'));
  assert.throws(() => recordHunt({ runDir, plan, root: cwd, answers: { plan: '000000000000', units: [] } }), e => e.code === 'STALE_ANSWERS');
});

test('record: each built-in lens turns a grounded defect into a finding and "none" into nothing', () => {
  const { cwd, runDir, lenses } = setup();
  const plan = planHunt({ runDir, lenses });
  const firstUnit = id => plan.units.find(u => u.lens === id);
  for (const lens of lenses) {
    const unit = firstUnit(lens.id);
    assert.ok(unit, `${lens.id} has a unit on the fixture run`);
    const item = unit.checklist[0];
    const scene = (item.scenes || unit.scenes.map(s => s.scene))[0];
    const selector = JSON.parse(readFileSync(join(runDir, scene, 'controls.json'), 'utf8'))[0].selector;
    const hit = recordHunt({ runDir, plan, root: cwd, answers: { units: [answerAll(unit, 'none', { [item.id]: { answer: 'defect', defects: [{ scene, selector, claim: `${item.id} seen here`, severity: 'medium' }] } })] } });
    assert.deepEqual(hit.findings.map(f => f.rule), [item.id], lens.id);
    const quiet = recordHunt({ runDir, plan, root: cwd, answers: { units: [answerAll(unit, 'none')] } });
    assert.equal(quiet.findings.length, 0, lens.id);
    assert.ok(quiet.coverage.cells.filter(c => c.unit === unit.id).every(c => c.status === 'seen'));
  }
});

test('cli: hunt --plan writes the same plan twice, --record writes ai-findings.json and coverage.json', () => {
  const { cwd, runDir } = setup();
  const run = (...a) => execFileSync('node', [CLI, 'hunt', ...a], { cwd, encoding: 'utf8' });
  const text = run('--plan', '--budget', '20000');
  assert.match(text, /^hunt plan [0-9a-f]{12} for run 0001: \d+ work units over 8 lens\(es\), estimated \d+ tokens/);
  assert.match(text, /budget 20000 tokens: \d+ unit\(s\) planned/);
  const one = readFileSync(join(runDir, 'hunt-plan.json'));
  const plan = JSON.parse(run('--plan', '--budget', '20000', '--json'));
  assert.ok(one.equals(readFileSync(join(runDir, 'hunt-plan.json'))), 'byte-identical hunt-plan.json');
  const unit = plan.units.find(u => u.lens === 'L6');
  writeFileSync(join(cwd, 'answers.json'), JSON.stringify({ plan: plan.id, units: [answerAll(unit, 'none')] }));
  const rec = JSON.parse(run('--record', 'answers.json', '--json'));
  assert.equal(rec.summary.units.seen, 1);
  assert.ok(existsSync(join(runDir, 'ai-findings.json')) && existsSync(join(runDir, 'coverage.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'ai-findings.json'), 'utf8')), { schema: 1, plan: plan.id, findings: [], rejected: [] });
  // a tampered external pack stops the plan
  const pack = JSON.stringify({ lenses: [{ id: 'L6', extends: 'L6', name: 'Copy quality (pinned)' }] });
  writeFileSync(join(cwd, 'pack.json'), pack + ' ');
  writeFileSync(join(cwd, '.nunchi', 'lenses.lock.json'), JSON.stringify({ packs: [{ path: 'pack.json', sha256: createHash('sha256').update(pack).digest('hex') }] }));
  const bad = spawnSync('node', [CLI, 'hunt', '--plan'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /sha256 .* Refusing to load it/);
});

// A run-level inventory.json as capture writes it (spec §2.4), for the invented Pebble Garden: the tasks page
// renders /tasks; another file renders only /notes (not hunted). No file renders '/'.
function addInventory(runDir) {
  const inv = {
    schema: 1, scope: 'routes', summary: {},
    files: [
      { file: 'app/notes/page.tsx', routes: ['/notes'], client: false, loadsData: null,
        strings: [{ kind: 'text', role: 'button', text: 'Erase note', line: 4 }], states: [], actions: [{ line: 4, label: 'Erase note', handler: 'erase', confirm: null, undo: null }], dialogs: [], raw: [], landmarks: [] },
      { file: 'app/tasks/page.tsx', routes: ['/tasks'], client: true, loadsData: { line: 3, client: true },
        strings: [{ kind: 'text', role: 'button', text: 'Delete all', line: 9 }, { kind: 'state-message', text: 'Oops! Something went wrong.', line: 7 }],
        states: [{ state: 'error', line: 7, strings: ['Oops! Something went wrong.'], elements: [] }],
        actions: [{ line: 9, label: 'Delete all', handler: 'clearAll', confirm: null, undo: null }], dialogs: [], raw: [{ line: 8, via: 'jsx', expression: 'err.message' }], landmarks: [] },
    ],
    candidates: [
      { candidate: true, lens: 'L5', kind: 'verb-variants', concept: 'delete', variants: [
        { forms: ['Delete'], count: 1, occurrences: [{ file: 'app/tasks/page.tsx', line: 9, text: 'Delete all' }] },
        { forms: ['Erase'], count: 1, occurrences: [{ file: 'app/notes/page.tsx', line: 4, text: 'Erase note' }] }] },
      { candidate: true, lens: 'L6', kind: 'vague-error', file: 'app/tasks/page.tsx', line: 7, text: 'Oops! Something went wrong.' },
      { candidate: true, lens: 'L9', kind: 'unguarded-destructive', file: 'app/notes/page.tsx', line: 4, label: 'Erase note', handler: 'erase' },
      { candidate: true, lens: 'L9', kind: 'unguarded-destructive', file: 'app/tasks/page.tsx', line: 9, label: 'Delete all', handler: 'clearAll' },
    ],
    skipped: [],
  };
  writeFileSync(join(runDir, 'inventory.json'), JSON.stringify(inv, null, 2));
}
const SLICE = route => `hunt/source/${sha(route, 12)}.json`;

test('plan: source lenses get the route\'s inventory slice after the reference and before the reviewed scenes', () => {
  const { runDir, lenses } = setup();
  const before = planHunt({ runDir, lenses, runId: '0001' });
  addInventory(runDir);
  const plan = planHunt({ runDir, lenses, runId: '0001' });
  assert.deepEqual(plan.units.map(u => u.id), before.units.map(u => u.id), 'same units');
  const tasks = plan.units.find(u => u.lens === 'L6' && u.scenes[0].route === '/tasks' && u.scenes[0].state === 'normal');
  const slice = SLICE('/tasks');
  const at = tasks.files.indexOf(slice);
  assert.ok(at > 0, tasks.files.join('\n'));
  assert.ok(tasks.files.slice(0, at).every(f => f.startsWith('~.guest.normal.d/')), 'reference files come first');
  assert.ok(tasks.files.slice(at + 1).every(f => f.startsWith('tasks.guest.normal.')), 'then the scenes under review');
  assert.ok(tasks.files[tasks.files.length - 1].startsWith('tasks.guest.normal.m/'), 'reviewed scene still last');
  const old = before.units.find(u => u.id === tasks.id);
  assert.equal(tasks.tokens, old.tokens + Math.ceil(statSync(join(runDir, slice)).size / 4), 'the slice is in the estimate');
  // the slice: only files that render /tasks, their strings/states/actions/dialogs, candidates touching them
  const s = JSON.parse(readFileSync(join(runDir, slice), 'utf8'));
  assert.equal(s.schema, 1); assert.equal(s.route, '/tasks');
  assert.deepEqual(s.files.map(f => f.file), ['app/tasks/page.tsx']);
  assert.deepEqual(Object.keys(s.files[0]).sort(), ['actions', 'dialogs', 'file', 'states', 'strings']);
  assert.equal(s.files[0].states[0].line, 7);
  assert.deepEqual(s.candidates.map(c => `${c.lens} ${c.kind}`), ['L5 verb-variants', 'L6 vague-error', 'L9 unguarded-destructive']);
  assert.ok(s.candidates.every(c => c.file !== 'app/notes/page.tsx'), 'the /notes-only candidate is left out');
  // every source lens on /tasks gets it; L1 (no `source`) does not; a route no inventory file renders gets none
  for (const u of plan.units.filter(u => u.scenes[0].route === '/tasks')) {
    assert.equal(u.files.includes(slice), !!plan.lenses.find(l => l.id === u.lens).source, `${u.lens} ${u.scenes[0].scene}`);
  }
  assert.ok(plan.units.some(u => u.lens === 'L1' && u.scenes[0].route === '/tasks'));
  const home = plan.units.filter(u => u.scenes[0].route === '/');
  assert.ok(home.some(u => u.lens === 'L6'));
  assert.ok(home.every(u => !u.files.some(f => f.startsWith('hunt/'))), 'no slice for a route without inventory files');
  assert.ok(!existsSync(join(runDir, SLICE('/'))));
  // deterministic: planning again gives the same plan and the same slice bytes
  const bytes = readFileSync(join(runDir, slice));
  assert.equal(stableJson(planHunt({ runDir, lenses, runId: '0001' })), stableJson(plan));
  assert.ok(bytes.equals(readFileSync(join(runDir, slice))));
});

test('plan: no inventory.json, no slices and nothing written', () => {
  const { runDir, lenses } = setup();
  const plan = planHunt({ runDir, lenses, runId: '0001' });
  assert.ok(plan.units.length);
  assert.ok(plan.units.every(u => !u.files.some(f => f.startsWith('hunt/'))));
  assert.ok(!existsSync(join(runDir, 'hunt')));
});
