// Ledger schema 2 and AI findings in the ledger (design 0.1-c §2.1–§2.5, M1): folds keyed by (run, source), run
// kinds, the AI fold with its grounding re-check, the AI fingerprint and group, verdict precedence, severity
// protection, group decisions on AI items, trust by (lens, source), staleness. Synthetic runs, invented content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as L from '../src/ledger.mjs';
import * as S from '../src/stable.mjs';
import * as St from '../src/state.mjs';
import * as V from '../src/verify.mjs';
import { aiIdentity } from '../src/ai-identity.mjs';
import { aiFoldInput, foldFinding } from '../src/ai-fold.mjs';
import { planHunt, recordHunt } from '../src/hunt.mjs';
import { loadLenses } from '../src/lenses.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
process.env.XDG_STATE_HOME = tmp('nunchi-ai-xdg-');
const cli = (cwd, ...a) => new Promise(res => execFile('node', [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
const json = async (cwd, ...a) => { const r = await cli(cwd, ...a, '--json'); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };

// ---- a synthetic project: '/' and '/tasks' at both widths, the tasks page grounded in app/tasks.tsx ----------------

const jpeg = (w, h, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);
const ctl = (selector, name, box, extra = {}) => ({ selector, tag: 'button', role: null, name, hasText: true, text: name, box, href: null, inline: false, ...extra });
const TASKS_CONTROLS = [ctl('button#delete-all', 'Delete all', [150, 120, 100, 40]), ctl('button#add-task', 'Add Task', [16, 120, 120, 40]), ctl('a#home', 'Home', [16, 10, 60, 24], { tag: 'a', href: '/' })];
const SOURCE = 'export default function Tasks() {\n  return <button onClick={() => store.clear()}>Delete all</button>;\n}\n';
function project() {
  const cwd = tmp('nunchi-ai-');
  mkdirSync(join(cwd, 'app'), { recursive: true });
  writeFileSync(join(cwd, 'app', 'tasks.tsx'), SOURCE);
  return cwd;
}
// salts: what each screen's pixels look like (a changed salt is a changed screenshot)
function makeRun(cwd, id, { salts = {}, rule = [], kind } = {}) {
  const dir = join(cwd, '.nunchi', 'runs', id);
  const scenes = [];
  const add = (slug, route, vp, salt) => {
    const sid = `${slug}.guest.normal.${vp}`;
    const d = join(dir, sid);
    mkdirSync(d, { recursive: true });
    const [w, h] = vp === 'm' ? [390, 844] : [1280, 800];
    const top = jpeg(w, h, salt), full = jpeg(w, h + 400, salt + 50);
    const text = route === '/tasks' ? 'Tasks\nDelete all\nAdd Task\nHome\n' : 'Home\nSee tasks\n';
    writeFileSync(join(d, 'top.jpg'), top); writeFileSync(join(d, 'full.jpg'), full); writeFileSync(join(d, 'text.txt'), text);
    writeFileSync(join(d, 'aria.yml'), route === '/tasks' ? '- heading "Tasks" [level=1]\n- button "Delete all"\n- button "Add Task"\n- link "Home":\n  - /url: /\n' : '- heading "Home" [level=1]\n- link "See tasks":\n  - /url: /tasks\n');
    writeFileSync(join(d, 'controls.json'), JSON.stringify(route === '/tasks' ? TASKS_CONTROLS : [ctl('a#see-tasks', 'See tasks', [16, 200, 90, 24], { tag: 'a', href: '/tasks' })]));
    writeFileSync(join(d, 'styles.json'), '[]'); writeFileSync(join(d, 'links.json'), '[]');
    writeFileSync(join(d, 'measure.json'), JSON.stringify({ clipped: [], images: [], scrollers: [], hiddenControls: [], viewport: { width: w, height: h } }));
    scenes.push({ id: sid, route, path: route, person: 'guest', state: 'normal', viewport: vp, status: 'captured', reason: null, httpStatus: 200, finalPath: route, redirected: false, top: S.sha(top), full: S.sha(full), textHash: S.sha(text) });
  };
  add('~', '/', 'm', salts.homeM ?? 1); add('~', '/', 'd', salts.homeD ?? 2);
  add('tasks', '/tasks', 'm', salts.tasksM ?? 3); add('tasks', '/tasks', 'd', salts.tasksD ?? 4);
  const health = { status: 'ok', problems: [] };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, baseUrl: 'http://127.0.0.1:3000', health, scenes }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, ...(kind === null ? {} : { kind: kind || 'sweep' }), scope: { routes: ['/', '/tasks'], persons: ['guest'], states: ['normal'], viewports: ['d', 'm'], changedSince: null }, wholeApp: true, health }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: L.annotate(rule) }));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), id + '\n');
  return dir;
}
const SMALL = vp => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `tasks.guest.normal.${vp}`, route: '/tasks', viewport: vp, selector: 'a#home', box: [16, 10, 60, 24], evidence: { width: 60, height: 20, minimum: 24, name: 'Home' } });
const answerAll = (unit, answer, over = {}) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.map(c => [c.id, over[c.id] ?? { answer }])) });

// hunt (L9) and verify a run through the CLI, as the skill does
async function huntAndVerify(cwd, id, { cells = ['m', 'd'], verdict = 'confirmed', severity = 'high', claimed = 'high', decoys = 'rejected', source = true, claim = 'Delete all clears the store at once.' } = {}) {
  const plan = await json(cwd, 'hunt', '--plan', '--run', id, '--lens', 'L9');
  const units = plan.units.map(u => (u.scenes[0].route !== '/tasks' ? answerAll(u, 'none') : answerAll(u, 'none', cells.length ? { 'L9.destructive-without-confirm': { answer: 'defect', defects: cells.map(vp => ({ scene: `tasks.guest.normal.${vp}`, selector: 'button#delete-all', ...(source ? { evidence: { file: 'app/tasks.tsx', line: 2 } } : {}), claim, severity: claimed })) } } : {})));
  writeFileSync(join(cwd, `answers-${id}.json`), JSON.stringify({ plan: plan.id, units }));
  assert.equal((await cli(cwd, 'hunt', '--record', `answers-${id}.json`, '--run', id)).code, 0);
  if (!cells.length) return null;
  const v = await cli(cwd, 'verify', '--plan', '--run', id, '--json');
  assert.equal(v.code, 0, v.stderr);
  const key = St.readKey(join(cwd, '.nunchi', 'runs', id), 'verify-key.json');
  const verdicts = Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? decoys : verdict, ...(k.decoy ? {} : { severity }), reason: 'checked against the evidence' }));
  writeFileSync(join(cwd, `verdicts-${id}.json`), JSON.stringify(verdicts));
  return cli(cwd, 'verify', '--record', `verdicts-${id}.json`, '--run', id);
}
const aiGroups = async cwd => {
  const r = await cli(cwd, 'findings', '--all', '--json');
  if (r.code === 1 && /nothing captured yet/.test(r.stderr)) return [];                // an empty ledger
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).groups.filter(g => g.source === 'ai');
};

// ---- schema 2 ----------------------------------------------------------------------------------------------------

// A ledger as M1a (schema 1) wrote it: runs, items without a source, coverage sets, first-seen times, aliases, blind.
const fnd = (route, cell, name, extra = {}) => ({ lens: 'L8', rule: 'target-size-min', severity: 'medium', scene: `${route.slice(1) || '~'}.${cell}`, route, viewport: cell.split('.')[2], selector: 'main > button', box: null, evidence: { name }, ...extra });
const sc = (route, cell) => { const [person, state, viewport] = cell.split('.'); return { id: `${route.slice(1) || '~'}.${cell}`, route, person, state, viewport, status: 'captured', reason: null, httpStatus: 200 }; };
function m1aState() {
  const SECRET = { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/app.js', kind: 'stripe-live-secret-key' } };
  let st = L.foldRun({ schema: 1, fingerprintVersion: 2, runs: [], items: {} }, { id: '0001', scope: { routes: ['/a'] }, wholeApp: true, scenes: [sc('/a', 'guest.normal.m')], findings: L.annotate([fnd('/a', 'guest.normal.m', 'x'), SECRET]) });
  st = L.foldRun(st, { id: '0002', scope: { routes: ['/a'] }, wholeApp: true, scenes: [sc('/a', 'guest.normal.m')], findings: L.annotate([SECRET]) });
  const strip = ({ source, ...i }) => i;
  return { schema: 1, fingerprintVersion: 2, runs: st.runs, items: Object.fromEntries(Object.entries(st.items).map(([k, i]) => [k, strip(i)])), coverage: st.coverage, seenRoutes: st.seenRoutes, decisionsSeen: { 'd1:00': 5 }, aliases: { fp: {}, group: {} } };
}

test('schema 2: a schema-1 ledger M1a wrote is migrated on read (folds from its runs, items say their source), written back with a rev; statuses unchanged', () => {
  const dir = tmp('nunchi-s2-');
  const file = join(dir, 'ledger.json');
  const old = m1aState();
  writeFileSync(file, JSON.stringify(old));
  const st = L.readState(file);
  assert.equal(st.schema, 2);
  assert.deepEqual(st.folds, [{ run: '0001', source: 'rule', key: null, stream: 'main' }, { run: '0002', source: 'rule', key: null, stream: 'main' }]);
  assert.ok(Object.values(st.items).every(i => i.source === 'rule'));
  for (const k of ['runs', 'coverage', 'seenRoutes', 'decisionsSeen', 'aliases']) assert.deepEqual(st[k], old[k], k);
  assert.deepEqual(L.view(st, []).map(r => [r.rule, r.status]), L.view(old, []).map(r => [r.rule, r.status]), 'the same statuses');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schema, 1, 'a read alone writes nothing');
  const synced = L.syncLedger(file, join(dir, 'runs'));
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.schema, 2);
  assert.equal(disk.rev, 1);
  assert.deepEqual(synced, disk);
  assert.deepEqual(JSON.parse(readFileSync(`${file}.prev`, 'utf8')), old, 'the schema-1 file is kept as .prev');
  // a v1 fingerprint state of schema 1 goes through both migrations
  const v1 = { schema: 1, fingerprintVersion: 1, runs: ['0001'], items: {} };
  assert.deepEqual([L.migrateState(L.upgrade(v1)).schema, L.migrateState(L.upgrade(v1)).fingerprintVersion], [2, 2]);
});

test('schema 2: a corrupt ledger is an error (exit 2) naming the way back, never "empty"; nothing is written', async () => {
  const cwd = project();
  makeRun(cwd, '0001', { rule: [SMALL('m')] });
  mkdirSync(join(cwd, '.nunchi', 'state'), { recursive: true });
  const torn = '{"schema": 2, "runs": ["0001"], "folds": [';
  writeFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), torn);
  const r = await cli(cwd, 'findings');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /ledger\.json is not valid JSON.*ledger\.json\.prev/);
  assert.equal(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8'), torn);
  writeFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), JSON.stringify({ schema: 2, runs: [], items: {} }));
  assert.equal((await cli(cwd, 'findings')).code, 2, 'schema 2 without folds is not a ledger');
});

test('run kinds: only a sweep folds as one; a quick run is presence-only; a fix probe or an unknown kind is not folded by the catch-up', () => {
  const base = (id, extra = {}) => ({ id, scope: { routes: ['/a'] }, wholeApp: true, scenes: [sc('/a', 'guest.normal.m')], ...extra });
  let st = L.foldRun({ schema: 1, runs: [], items: {} }, { ...base('0001'), findings: L.annotate([fnd('/a', 'guest.normal.m', 'x')]) });
  const quick = L.foldRun(st, { ...base('0002', { kind: 'quick' }), findings: L.annotate([fnd('/a', 'guest.normal.m', 'new')]) });
  assert.equal(Object.values(quick.items).find(i => i.evidence.name === 'x').goneAt, null, 'a quick run never fixes');
  assert.ok(Object.values(quick.items).some(i => i.evidence.name === 'new'), 'but adds what it saw');
  assert.deepEqual(quick.folds.find(f => f.run === '0002'), { run: '0002', source: 'rule', key: null, stream: 'main', kind: 'quick' });
  for (const kind of ['fix-probe', 'something-new']) {
    const probe = L.foldRun(st, { ...base('0002', { kind }), findings: L.annotate([fnd('/a', 'guest.normal.m', 'probe')]) });
    assert.deepEqual(probe.items, st.items, `${kind}: nothing folded`);
    assert.deepEqual(probe.runs, ['0001']);
    assert.equal(probe.folds.find(f => f.run === '0002').kind, kind, 'recorded, so the catch-up does not read it again');
  }
  // the catch-up reads the kind from run.json
  const cwd = project();
  makeRun(cwd, '0001', { rule: [SMALL('m')] });
  makeRun(cwd, '0002', { rule: [], kind: 'fix-probe' });
  const s = L.syncLedger(join(cwd, '.nunchi', 'state', 'ledger.json'), join(cwd, '.nunchi', 'runs'));
  assert.equal(Object.values(s.items)[0].goneAt, null, 'the probe did not fix it');
  assert.deepEqual(s.runs, ['0001']);
});

test('fold keys: a (run, source) folded again with the same inputs changes nothing; a rule fold is never re-done', () => {
  const st = L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0001', scope: {}, key: 'k1', findings: L.annotate([fnd('/a', 'guest.normal.m', 'x')]) });
  assert.equal(L.foldRun(st, { id: '0001', scope: {}, key: 'k2', findings: [] }), st);
  const ai = L.foldAi(st, { run: '0001', key: 'a1', findings: [], now: 1 });
  assert.equal(L.foldAi(ai, { run: '0001', key: 'a1', findings: [], now: 2 }), ai);
  assert.deepEqual(ai.folds.map(f => [f.run, f.source, f.key]), [['0001', 'rule', 'k1'], ['0001', 'ai', 'a1']]);
});

// ---- the AI fingerprint (§2.3) -------------------------------------------------------------------------------------

test('§2.3 contract: two hunts with a different reference scene, other claim wording and the source line moved by 3 give the same fingerprint', () => {
  const cwd = project();
  const runDir = makeRun(cwd, '0001');
  const lenses = loadLenses({ root: cwd }).lenses;
  const plan = planHunt({ runDir, lenses, lensIds: ['L9'], runId: '0001' });
  const unit = plan.units.find(u => u.scenes[0].route === '/tasks');
  const hunt = (p, u, claim, line) => recordHunt({ runDir, plan: p, root: cwd, answers: { units: [answerAll(u, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.m', selector: 'button#delete-all', source: `app/tasks.tsx:${line}`, claim, severity: 'high' }] } })] } }).findings[0];
  const first = hunt(plan, unit, 'Delete all clears the store with no confirmation.', 2);
  // the second hunt: another reference screen (so another unit), other words, and the code moved down by 3 lines
  writeFileSync(join(cwd, 'app', 'tasks.tsx'), `// a comment\n// another\n\n${SOURCE}`);
  const other = { ...unit, id: 'f'.repeat(12), reference: { ...unit.reference, scene: '~.guest.normal.d', viewport: 'd' } };
  const second = hunt({ ...plan, units: plan.units.map(u => (u.id === unit.id ? other : u)) }, other, 'No confirm or undo before everything is deleted.', 5);
  assert.notEqual(first.evidence.unit, second.evidence.unit);
  assert.notEqual(first.evidence.claim, second.evidence.claim);
  assert.deepEqual([first.evidence.line, second.evidence.line], [2, 5]);
  const [a, b] = L.annotate([first, second]);
  assert.equal(a.fp, b.fp, 'same fingerprint');
  assert.equal(a.group, b.group, 'same group');
  // what does change it: another element, or another line's content
  assert.notEqual(L.annotate([{ ...first, selector: 'button#add-task', identity: aiIdentity({ finding: { ...first, selector: 'button#add-task' }, controls: TASKS_CONTROLS, root: cwd }) }])[0].fp, a.fp);
  const moved = { ...first, evidence: { ...first.evidence, line: 1 } };
  assert.notEqual(L.annotate([{ ...moved, identity: aiIdentity({ finding: moved, controls: TASKS_CONTROLS, root: cwd }) }])[0].fp, a.fp);
  // rule fingerprints are untouched (pinned in fingerprint-v2.test.mjs); the AI recipe is its own
  assert.deepEqual(a.inputs ?? L.fingerprintOf(first).inputs, { v: L.AI_RECIPE, source: 'ai', lens: 'L9', rule: 'L9.destructive-without-confirm', route: '/tasks', evidence: { anchor: first.identity.anchor, element: 'button#delete-all', file: 'app/tasks.tsx', name: 'Delete all' } });
});

test('§2.3: an aria= selector is the controls.json selector when exactly one control has that name; the group is the component, never every similar button', () => {
  const byAria = aiIdentity({ finding: { selector: 'aria=button "Delete all"', route: '/tasks', evidence: {} }, controls: TASKS_CONTROLS });
  const byCss = aiIdentity({ finding: { selector: 'button#delete-all', route: '/tasks', evidence: {} }, controls: TASKS_CONTROLS });
  assert.equal(byAria.element, 'button#delete-all');
  assert.deepEqual(byAria, byCss);
  const twice = [...TASKS_CONTROLS, ctl('div > button#delete-all-2', 'Delete all', [1, 1, 50, 20])];
  // two controls share the name: the first in document order, so a second one added further down does not move it
  assert.equal(aiIdentity({ finding: { selector: 'aria=button "Delete all"', route: '/tasks', evidence: {} }, controls: twice }).element, 'button#delete-all');
  assert.equal(aiIdentity({ finding: { selector: 'aria=button "Delete all"', route: '/tasks', evidence: {} }, controls: [twice[3], ...TASKS_CONTROLS] }).element, 'div > button#delete-all-#', 'the first in document order');
  const f = (route, selector, extra = {}) => ({ source: 'ai', lens: 'L6', rule: 'L6.unclear-label', route, selector, evidence: {}, ...extra });
  // no file, no inventory: the group is the fingerprint, so two similar buttons are two groups
  const g1 = L.fingerprintOf(f('/a', 'main > button.save')), g2 = L.fingerprintOf(f('/b', 'main > button.save'));
  assert.equal(g1.group, g1.fp);
  assert.notEqual(g1.group, g2.group);
  // the inventory names the one file that renders the control's name: one component, one group across screens
  const inventory = { files: [{ file: 'app/save.tsx', routes: ['/a', '/b'], strings: [{ text: 'Save', line: 3 }] }, { file: 'app/other.tsx', routes: ['/a'], strings: [{ text: 'Cancel', line: 1 }] }] };
  const controls = [ctl('main > button.save', 'Save', [0, 0, 40, 20])];
  const id = route => aiIdentity({ finding: { route, selector: 'main > button.save', evidence: {} }, controls, inventory });
  assert.deepEqual(id('/a').component, { file: 'app/save.tsx', name: 'Save' });
  const h1 = L.fingerprintOf(f('/a', 'main > button.save', { identity: id('/a') })), h2 = L.fingerprintOf(f('/b', 'main > button.save', { identity: id('/b') }));
  assert.equal(h1.group, h2.group);
  assert.notEqual(h1.fp, h2.fp);
  // another accessible name in the same file is another component
  assert.notEqual(L.fingerprintOf(f('/a', 'x', { identity: { ...id('/a'), component: { file: 'app/save.tsx', name: 'Discard' } } })).group, h1.group);
});

// ---- the AI fold (§2.2) ----------------------------------------------------------------------------------------

test('AI fold: verify --record folds the run\'s AI findings; canary copies and hand-written ungrounded claims stay out; a run without an id is refused', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001', { rule: [SMALL('m')] });
  const r = await huntAndVerify(cwd, '0001');
  assert.equal(r.code, 0, r.stderr);
  const [g] = await aiGroups(cwd);
  assert.equal(g.rule, 'L9.destructive-without-confirm');
  assert.equal(g.example.verification.status, 'confirmed');
  assert.equal(g.example.verification.by, 'same-model check');
  assert.deepEqual(g.example.cells, ['guest.normal.d', 'guest.normal.m']);
  assert.equal(g.checked, true);
  // the review page reads it from the ledger now
  const page = await cli(cwd, 'export', '--html', 'review');
  assert.equal(page.code, 0, page.stderr);
  const html = readFileSync(join(cwd, 'review', 'index.html'), 'utf8');
  assert.match(html, /Delete all clears the store at once\./);
  // findings by hand: on a canary copy, with a selector the scene does not have, a file the run does not know
  const doc = JSON.parse(readFileSync(join(dir, 'ai-findings.json'), 'utf8'));
  const base = doc.findings[0];
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.scenes.push({ ...manifest.scenes[2], id: 'tasks.guest.normal.m.canary-1', canary: 1, of: 'tasks.guest.normal.m' });
  mkdirSync(join(dir, 'tasks.guest.normal.m.canary-1'), { recursive: true });
  writeFileSync(join(dir, 'tasks.guest.normal.m.canary-1', 'controls.json'), JSON.stringify(TASKS_CONTROLS));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  doc.findings.push(
    { ...base, scene: 'tasks.guest.normal.m.canary-1', rule: 'L9.input-lost-on-leave', identity: undefined },
    { ...base, rule: 'L9.input-lost-on-leave', selector: 'div.invented', evidence: { claim: 'invented' }, identity: undefined },
    { ...base, rule: 'L9.input-lost-on-leave', selector: null, evidence: { claim: 'invented', file: 'app/nowhere.tsx', line: 1 }, identity: undefined },
    { ...base, rule: 'L9.input-lost-on-leave', selector: null, evidence: { claim: 'nothing at all' }, identity: undefined },
  );
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify(doc));
  const input = aiFoldInput(dir, { root: cwd });
  assert.deepEqual(input.rejected.map(x => x.reason).sort(), ['selector-not-in-evidence', 'source-not-found', 'ungrounded']);
  assert.ok(input.findings.every(f => f.rule === 'L9.destructive-without-confirm'), 'the canary copy is left out, not an item');
  // the catch-up of the next command folds the changed file: still one AI item
  assert.equal((await aiGroups(cwd)).length, 1);
  // an --out folder has no id: recorded, not folded
  const out = join(cwd, 'out');
  makeRun(cwd, '0009');
  const fs = await import('node:fs');
  fs.renameSync(join(cwd, '.nunchi', 'runs', '0009'), out);
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), '0001\n');
  const runJson = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  writeFileSync(join(out, 'run.json'), JSON.stringify({ ...runJson, id: null }));
  const { verification, ...claimOnly } = base;
  writeFileSync(join(out, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [{ ...claimOnly, status: 'claimed', scene: 'tasks.guest.normal.m' }] }));
  const vp = await cli(cwd, 'verify', '--plan', '--run', out);
  assert.equal(vp.code, 0, vp.stderr);
  const key = St.readKey(out, 'verify-key.json');
  writeFileSync(join(cwd, 'v-out.json'), JSON.stringify(Object.keys(key.packets).map(packet => ({ packet, verdict: key.packets[packet].decoy ? 'rejected' : 'confirmed', reason: 'ok' }))));
  const rec = await cli(cwd, 'verify', '--record', 'v-out.json', '--run', out);
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stderr, /not folded into the ledger: it has no run id/);
});

test('answer keys: a plan of a run with canaries whose key went missing is refused, never recorded under aliases', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.scenes.push({ ...manifest.scenes[2], id: 'tasks.guest.normal.m.canary-1', canary: 1, of: 'tasks.guest.normal.m' });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const fs = await import('node:fs');
  fs.cpSync(join(dir, 'tasks.guest.normal.m'), join(dir, 'tasks.guest.normal.m.canary-1'), { recursive: true });
  const plan = await json(cwd, 'hunt', '--plan', '--lens', 'L9');
  assert.ok(plan.units.every(u => u.scenes.every(s => /^s[0-9a-f]{10}$/.test(s.scene))), 'aliases');
  assert.ok(existsSync(St.keyPath(dir, 'hunt-key.json')));
  St.removeKey(dir, 'hunt-key.json');
  writeFileSync(join(cwd, 'a.json'), JSON.stringify({ plan: plan.id, units: plan.units.map(u => answerAll(u, 'none')) }));
  const r = await cli(cwd, 'hunt', '--record', 'a.json');
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /answer key of this plan \(hunt-key\.json\) is missing/);
  assert.ok(!existsSync(join(dir, 'ai-findings.json')), 'nothing recorded');
});

test('run files: a command writing into a run waits for the run\'s lock, and ends in an error rather than writing beside another (slow: ~15 s)', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [{ source: 'ai', status: 'claimed', lens: 'L9', rule: 'L9.destructive-without-confirm', severity: 'high', scene: 'tasks.guest.normal.m', route: '/tasks', viewport: 'm', selector: 'button#delete-all', box: [150, 120, 100, 40], evidence: { claim: 'c' } }] }));
  let r;
  S.withLock(join(dir, 'run-files'), () => { r = spawnSync('node', [CLI, 'verify', '--plan'], { cwd, encoding: 'utf8' }); });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /locked by another nunchi process/);
  assert.ok(!existsSync(join(dir, 'verify-packets.json')), 'nothing written while another held the run');
  assert.equal(spawnSync('node', [CLI, 'verify', '--plan'], { cwd, encoding: 'utf8' }).status, 0, 'free again: it works');
});

test('AI fold: a verify --record whose fold could not happen (the ledger was busy) is folded by the next ledger command', async () => {
  const cwd = project();
  makeRun(cwd, '0001');
  // nothing yet (since M5 a run that found nothing is said as such, not as "nothing captured")
  assert.equal((await cli(cwd, 'findings', '--all')).stdout.split('\n')[0], 'run 0001 · 0 unique defects in 0 groups · groups open 0 · to fix 0 · later 0 · fixed 0 · kept 0 · not a problem 0');
  let r;
  S.withLock(join(cwd, '.nunchi', 'state', 'ledger.json'), () => {
    // the hunt and verify run while another nunchi holds the ledger (a synchronous child, so the lock stays held)
    const plan = JSON.parse(spawnSync('node', [CLI, 'hunt', '--plan', '--lens', 'L9', '--json'], { cwd, encoding: 'utf8' }).stdout);
    const units = plan.units.map(u => (u.scenes[0].route !== '/tasks' ? answerAll(u, 'none') : answerAll(u, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.m', selector: 'button#delete-all', claim: 'Deletes at once.', severity: 'high' }] } })));
    writeFileSync(join(cwd, 'a.json'), JSON.stringify({ plan: plan.id, units }));
    spawnSync('node', [CLI, 'hunt', '--record', 'a.json'], { cwd, encoding: 'utf8' });
    spawnSync('node', [CLI, 'verify', '--plan'], { cwd, encoding: 'utf8' });
    const key = St.readKey(join(cwd, '.nunchi', 'runs', '0001'), 'verify-key.json');
    writeFileSync(join(cwd, 'v.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', reason: 'ok' }))));
    r = spawnSync('node', [CLI, 'verify', '--record', 'v.json'], { cwd, encoding: 'utf8' });
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /recorded in run 0001, but not in the ledger yet/);
  const groups = await aiGroups(cwd);
  assert.deepEqual(groups.map(g => [g.rule, g.example.verification.status]), [['L9.destructive-without-confirm', 'confirmed']]);
});

test('decide: an AI item that is its own group (no component known) is decided on its fingerprint by that one id', async () => {
  const cwd = project();
  makeRun(cwd, '0001');
  assert.equal((await huntAndVerify(cwd, '0001', { source: false })).code, 0);
  const [g] = await aiGroups(cwd);
  assert.equal(g.group, g.fps[0], 'no file, no inventory: the group is the fingerprint');
  const r = await cli(cwd, 'decide', g.group, 'fix', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout)[0].target, { fp: g.group });
  assert.equal((await aiGroups(cwd))[0].status, 'to-fix');
});

test('AI fold: re-verifying replaces the run\'s contribution; rejected and insufficient never make an item', async () => {
  const cwd = project();
  makeRun(cwd, '0001');
  const r = await huntAndVerify(cwd, '0001', { verdict: 'rejected' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(await aiGroups(cwd), [], 'a rejected claim is no item');
  // a second hunt on a new run, confirmed by a verifier that also confirmed the decoy (suspect): an item; verifying
  // that run again (--again) as insufficient takes it away again
  makeRun(cwd, '0002');
  assert.equal((await huntAndVerify(cwd, '0002', { verdict: 'confirmed', decoys: 'confirmed' })).code, 0);
  assert.equal((await aiGroups(cwd)).length, 1);
  assert.equal((await cli(cwd, 'verify', '--plan', '--again', '--run', '0002')).code, 0);
  const key = St.readKey(join(cwd, '.nunchi', 'runs', '0002'), 'verify-key.json');
  assert.equal(key.earlier.length, 1, 'the first round is kept in the key');
  writeFileSync(join(cwd, 'v-again.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'insufficient', reason: 'cannot tell from the evidence' }))));
  const rec = await cli(cwd, 'verify', '--record', 'v-again.json', '--run', '0002');
  assert.equal(rec.code, 0, rec.stderr);
  assert.deepEqual(await aiGroups(cwd), [], 'replaced: the run now says insufficient');
  const state = JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8'));
  assert.equal(state.folds.filter(f => f.source === 'ai').length, 2, 'one AI fold per run');
});

// ---- #1: verdicts come from the answer key, never from files in the project ----------------------------------------

test('AI fold: statuses and "suspect" written by hand into ai-findings.json or verify.json never reach the ledger; only the key\'s recorded verdicts do', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  // the verifier confirmed the decoy too: the run is suspect
  assert.equal((await huntAndVerify(cwd, '0001', { decoys: 'confirmed' })).code, 0);
  let [g] = await aiGroups(cwd);
  assert.deepEqual([g.example.verification.status, g.example.verification.suspect, g.checked], ['confirmed', true, false]);
  // an agent rewrites the run's files: not suspect, confirmed by a cross-vendor verifier
  const doc = JSON.parse(readFileSync(join(dir, 'ai-findings.json'), 'utf8'));
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify({ ...doc, findings: doc.findings.map(f => ({ ...f, status: 'confirmed', verification: { ...f.verification, suspect: false, verifier: 'cross-vendor', vendor: 'other' } })) }));
  const v = JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8'));
  writeFileSync(join(dir, 'verify.json'), JSON.stringify({ ...v, suspect: false, suspectReason: undefined, decoys: { ...v.decoys, passedThrough: 0, rate: 0 } }));
  [g] = await aiGroups(cwd);
  assert.deepEqual([g.example.verification.status, g.example.verification.suspect, g.example.verification.by, g.checked], ['confirmed', true, 'same-model check', false], 'the key still says suspect');
  // a claim the key does not back (a hunt never verified, a status written by hand) is a claim
  const dir2 = makeRun(cwd, '0002', { salts: { tasksM: 33, tasksD: 44 } });
  await huntAndVerify(cwd, '0002', { cells: [] });
  const base = doc.findings[0];
  writeFileSync(join(dir2, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [{ ...base, rule: 'L9.input-lost-on-leave', status: 'confirmed', identity: undefined, verification: { packet: 'p001', verdict: 'confirmed', severity: 'blocker', claimedSeverity: 'high', reason: 'forged', verifier: 'same-model check' } }] }));
  const forged = (await aiGroups(cwd)).find(x => x.rule === 'L9.input-lost-on-leave');
  assert.deepEqual([forged.example.verification.status, forged.severity, forged.checked], ['claimed', 'high', false], 'no key backs it: claimed, as severe as the claim');
  // and a key whose recorded verdicts were for other claims backs nothing: the round no longer matches
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify({ ...doc, findings: doc.findings.map(f => ({ ...f, evidence: { ...f.evidence, claim: 'reworded after the verdicts' } })) }));
  [g] = (await aiGroups(cwd)).filter(x => x.rule === 'L9.destructive-without-confirm');
  assert.equal(g.example.verification.status, 'claimed', 'the claim changed since it was verified');
});

test('AI fold: a hunt that claimed nothing folds from its coverage, so two silent hunts make an item stale', async () => {
  const cwd = project();
  makeRun(cwd, '0001');
  assert.equal((await huntAndVerify(cwd, '0001')).code, 0);
  for (const id of ['0002', '0003']) {
    makeRun(cwd, id);
    assert.equal(await huntAndVerify(cwd, id, { cells: [] }), null);
  }
  const state = JSON.parse(readFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), 'utf8'));
  assert.deepEqual(state.folds.filter(f => f.source === 'ai').map(f => f.run), ['0001', '0002', '0003'], 'each hunt folded, also with no claim');
  const [g] = await aiGroups(cwd);
  assert.equal(g.status, 'stale');
  assert.match((await cli(cwd, 'findings')).stdout, /1 AI group\(s\) stale: 2 later hunts saw their screens/);
});

test('AI fold: the grounding check is hunt --record\'s — a scene not in the run, a file not under the root, a line past its end, a blank line for a file-only claim are refused', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  // the run's source map names a file that is not under the app root: knowing its name is not enough
  writeFileSync(join(dir, 'source-map.json'), JSON.stringify({ routes: { '/tasks': ['app/tasks.tsx', 'app/gone.tsx'] }, files: { 'app/tasks.tsx': ['/tasks'], 'app/gone.tsx': ['/tasks'] } }));
  writeFileSync(join(cwd, 'app', 'blank.tsx'), 'export const a = 1;\n\nexport const b = 2;\n');
  const f = (over = {}) => ({ source: 'ai', status: 'claimed', lens: 'L9', rule: 'L9.destructive-without-confirm', severity: 'high', scene: 'tasks.guest.normal.m', route: '/tasks', viewport: 'm', selector: null, box: null, evidence: { claim: 'c', file: 'app/tasks.tsx', line: 2 }, ...over });
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [
    f(),
    f({ scene: 'nowhere.guest.normal.m' }),
    f({ scene: '../tasks.guest.normal.m' }),
    f({ evidence: { claim: 'c', file: 'app/gone.tsx', line: 1 } }),
    f({ evidence: { claim: 'c', file: 'app/tasks.tsx', line: 3 } }),
    f({ evidence: { claim: 'c', file: 'app/tasks.tsx', line: 5 } }),
    f({ evidence: { claim: 'c', file: 'app/blank.tsx', line: 2 } }),
    f({ selector: 'button#delete-all', evidence: { claim: 'c', file: 'app/blank.tsx', line: 2 } }),
  ] }));
  const input = aiFoldInput(dir, { root: cwd });
  assert.deepEqual(input.rejected.map(x => [x.finding, x.reason]), [[1, 'scene-not-in-run'], [2, 'scene-not-in-run'], [3, 'source-not-found'], [5, 'source-not-found'], [6, 'source-line-blank']]);
  assert.deepEqual(input.findings.length, 3, 'line 3 is inside the file (5 is one past its end); a blank line beside a selector is fine');
  // hunt --record refuses a file-only claim on a blank line too
  const lenses = loadLenses({ root: cwd }).lenses;
  const plan = planHunt({ runDir: dir, lenses, lensIds: ['L9'], runId: '0001' });
  const unit = plan.units.find(u => u.scenes[0].route === '/tasks');
  const r = recordHunt({ runDir: dir, plan, root: cwd, answers: { units: [answerAll(unit, 'none', { 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene: 'tasks.guest.normal.m', evidence: { file: 'app/blank.tsx', line: 2 }, claim: 'c', severity: 'high' }] } })] } });
  assert.deepEqual(r.rejected.map(x => [x.reason, /blank line/.test(x.detail)]), [['source-not-found', true]]);
});

// ---- #5: the AI fingerprint neither merges two defects nor splits one ------------------------------------------

test('§2.3: two controls whose selectors normalise alike but whose names differ are two items; one name with a count in it is one', () => {
  const rows = [ctl('ul > li:nth-of-type(1) > button', 'Delete', [0, 0, 40, 20]), ctl('ul > li:nth-of-type(2) > button', 'Archive', [0, 30, 40, 20]), ctl('ul > li:nth-of-type(3) > button', 'Archive 3 items', [0, 60, 40, 20])];
  const fpOf = sel => { const finding = { source: 'ai', lens: 'L6', rule: 'L6.unclear-label', route: '/tasks', selector: sel, evidence: {} }; return L.fingerprintOf({ ...finding, identity: aiIdentity({ finding, controls: rows }) }).fp; };
  assert.equal(L.normalizeSelector(rows[0].selector), L.normalizeSelector(rows[1].selector));
  assert.notEqual(fpOf(rows[0].selector), fpOf(rows[1].selector), 'Delete and Archive: two defects');
  const counted = n => aiIdentity({ finding: { route: '/tasks', selector: 'b', evidence: {} }, controls: [ctl('b', `Archive ${n} items`, [0, 0, 1, 1])] }).name;
  assert.equal(counted(3), counted(12), 'data in the name does not split it');
});

test('§2.3: the line anchor survives a reformat, and tells apart the same text on two lines of a file', async () => {
  const { lineAnchor } = await import('../src/ai-identity.mjs');
  const a = 'function A() {\n  return (\n    <button>Delete</button>\n  );\n}\nfunction B() {\n  return (\n    <p>x</p>\n  );\n}\n';
  const reformatted = 'function A() {\n    return  (\n\t<button>Delete</button>\n  );\n}\nfunction B() {\n  return (\n    <p>x</p>\n  );\n}\n';
  assert.equal(lineAnchor(a, 3), lineAnchor(reformatted, 3), 'whitespace does not move it');
  assert.equal(lineAnchor(a, 2), lineAnchor(reformatted, 2));
  assert.notEqual(lineAnchor(a, 2), lineAnchor(a, 7), 'the first `return (` and the second are two lines');
  assert.equal(lineAnchor(a, 7), lineAnchor(`// header\n${a}`, 8), 'the second stays the second when the file moves down');
  assert.equal(lineAnchor('a\n\nb\n', 2), null, 'a blank line names nothing');
  assert.equal(lineAnchor('a\n', 9), null);
});

test('§2.3: the fold keeps the element the hunt canonicalised when it still fits; one that does not fit is recomputed', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  const f = (identity, selector = 'aria=button "Delete all"') => ({ source: 'ai', status: 'claimed', lens: 'L6', rule: 'L6.unclear-label', severity: 'medium', scene: 'tasks.guest.normal.m', route: '/tasks', viewport: 'm', selector, box: null, evidence: { claim: 'c' }, identity });
  // a second "Delete all" control on the screen since: the hunt's choice stays (one of the controls of that name)
  const controls = JSON.parse(readFileSync(join(dir, 'tasks.guest.normal.m', 'controls.json'), 'utf8'));
  writeFileSync(join(dir, 'tasks.guest.normal.m', 'controls.json'), JSON.stringify([ctl('header > button.delete', 'Delete all', [0, 0, 10, 10]), ...controls]));
  const hunted = { element: 'button#delete-all', file: null, anchor: null, name: 'Delete all', component: null, fileHash: null };
  writeFileSync(join(dir, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [f(hunted), f({ ...hunted, element: 'main > a.invented' })] }));
  const [kept, recomputed] = aiFoldInput(dir, { root: cwd }).findings;
  assert.equal(kept.identity.element, 'button#delete-all', 'the hunt\'s element: the fingerprint does not move');
  assert.equal(recomputed.identity.element, 'header > button.delete', 'an element that is no control of that name is not taken');
  assert.notEqual(kept.fp, recomputed.fp);
});

// fold-level fixtures: an AI finding of a run, as aiFoldInput gives it
const AIF = (over = {}) => {
  const f = { source: 'ai', lens: 'L9', rule: 'L9.destructive-without-confirm', route: '/tasks', scene: 'tasks.guest.normal.m', selector: 'button#delete-all', severity: 'high', evidence: { claim: 'c' } };
  const { fp, group, inputs } = L.fingerprintOf(f);
  return { fp, group, inputs, lens: f.lens, rule: f.rule, route: f.route, scene: f.scene, cell: 'guest.normal.m', selector: f.selector, box: null, evidence: f.evidence, identity: null, status: 'claimed', claimedSeverity: 'high', verdictSeverity: null, by: null, vendor: null, suspect: false, sceneHash: { top: 't', full: 'f', textHash: 'x' }, ...over };
};
const fold = (st, run, findings, extra = {}) => L.foldAi(st, { run, key: `${run}:${JSON.stringify(findings)}`, findings, now: Number(run) * 1000, ...extra });
const only = st => Object.values(st.items).find(i => i.source === 'ai');

test('verdict precedence: the latest verdict that was not suspect, else the latest suspect one, else claimed; a decision beats them all', () => {
  let st = fold(L.emptyState(), '0001', [AIF()]);
  assert.equal(only(st).verification.status, 'claimed');
  st = fold(st, '0002', [AIF({ status: 'confirmed', verdictSeverity: 'medium', by: 'same-model check' })]);
  assert.deepEqual([only(st).verification.status, only(st).verification.run, only(st).severity], ['confirmed', '0002', 'medium']);
  st = fold(st, '0003', [AIF({ status: 'rejected', by: 'same-model check', suspect: true })]);
  assert.deepEqual([only(st).verification.status, only(st).verification.run], ['confirmed', '0002'], 'a suspect verdict does not outrank one that was not');
  st = fold(st, '0004', [AIF({ status: 'insufficient', by: 'same-model check' })]);
  assert.deepEqual([only(st).verification.status, only(st).verification.run], ['insufficient', '0004'], 'the latest one that was not suspect');
  const suspectOnly = fold(fold(L.emptyState(), '0001', [AIF()]), '0002', [AIF({ status: 'confirmed', suspect: true })]);
  assert.deepEqual([only(suspectOnly).verification.status, only(suspectOnly).verification.suspect], ['confirmed', true], 'a suspect verdict beats a bare claim');
  const fp = only(st).fp;
  const d = { schema: 1, id: 'dz-1', target: { fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'me', at: '2026-10-14T10:00:00.000+09:00', fingerprintVersion: 2 };
  assert.equal(L.view(st, [d], new Set([L.approvalKey(d)]), { now: Date.parse('2026-10-15T00:00:00+09:00') })[0].status, 'dismissed', 'the human decision');
  // rejected and insufficient never make an item
  assert.deepEqual(fold(L.emptyState(), '0001', [AIF({ status: 'rejected' }), AIF({ status: 'insufficient', scene: 'x.guest.normal.d', cell: 'guest.normal.d' })]).items, {});
});

test('severity: display takes the corrected severity, protection the most severe given; a verifier that lowers a blocker cannot let a git dismissal hide it', () => {
  const st = fold(L.emptyState(), '0001', [AIF({ lens: 'L6', rule: 'L6.vague-error', claimedSeverity: 'blocker', status: 'confirmed', verdictSeverity: 'low', by: 'same-model check' })]);
  const item = only(st);
  assert.deepEqual([item.severity, item.claimedSeverity, item.protect], ['low', 'blocker', 'blocker']);
  assert.equal(L.seriousTarget(st)({ fp: item.fp }), true);
  const git = { schema: 1, id: 'dz-2', target: { fp: item.fp }, decision: 'false-positive', reason: 'not-a-problem', by: 'someone', at: '2026-10-14T10:00:00.000+09:00', fingerprintVersion: 2 };
  const NOW = { now: Date.parse('2026-10-15T00:00:00+09:00') };
  assert.equal(L.view(st, [git], new Set(), NOW)[0].status, 'open', 'not approved here, and a blocker by protection');
  assert.equal(L.view(st, [git], new Set([L.approvalKey(git)]), NOW)[0].status, 'dismissed');
});

test('group decisions on AI items: only when double-checked or decided after its latest verification; a blocker or L9 group decision never covers a new fingerprint', () => {
  const T = s => Date.parse(`2026-10-14T${s}:00.000+09:00`);
  const NOW = { now: T('23:00') };
  const L6 = (over = {}) => AIF({ lens: 'L6', rule: 'L6.vague-error', selector: 'p.err', identity: { element: 'p.err', file: 'app/err.tsx', anchor: null, component: { file: 'app/err.tsx', name: null } }, claimedSeverity: 'medium', ...over });
  const fix = (L6args) => { const a = L.fingerprintOf({ source: 'ai', lens: 'L6', rule: 'L6.vague-error', route: '/tasks', selector: 'p.err', identity: L6args.identity, evidence: {} }); return { ...L6args, fp: a.fp, group: a.group, inputs: a.inputs }; };
  const keep = (group, at) => ({ schema: 1, id: `dk-${at.replace(/\D/g, '')}`, target: { group }, decision: 'keep', reason: 'intended', by: 'me', at: `2026-10-14T${at}:00.000+09:00`, fingerprintVersion: 2 });
  // claimed only: a group decision does not cover it; one on its fingerprint does
  let st = L.foldAi(L.emptyState(), { run: '0001', key: 'k1', findings: [fix(L6())], now: T('09:00') });
  const item = only(st);
  const d1 = keep(item.group, '10:00');
  let row = L.view(st, [d1], new Set([L.approvalKey(d1)]), NOW)[0];
  assert.equal(row.status, 'open');
  assert.match(row.note, /not double-checked/);
  const onFp = { ...d1, id: 'dk-fp', target: { fp: item.fp } };
  assert.equal(L.view(st, [onFp], new Set([L.approvalKey(onFp)]), NOW)[0].status, 'kept');
  // verified (suspect) at 11:00: a group decision made after it covers it, one made before does not
  st = L.foldAi(st, { run: '0002', key: 'k2', findings: [fix(L6({ status: 'confirmed', suspect: true, by: 'same-model check' }))], now: T('11:00') });
  assert.equal(L.view(st, [d1], new Set([L.approvalKey(d1)]), NOW)[0].status, 'open');
  const d2 = keep(item.group, '12:00');
  assert.equal(L.view(st, [d2], new Set([L.approvalKey(d2)]), NOW)[0].status, 'kept');
  // confirmed and not suspect: covered by the group decision whenever it was made
  st = L.foldAi(st, { run: '0003', key: 'k3', findings: [fix(L6({ status: 'confirmed', by: 'same-model check' }))], now: T('13:00') });
  assert.equal(L.view(st, [d1], new Set([L.approvalKey(d1)]), NOW)[0].status, 'kept');
  // L9 (or a blocker): a group decision made before the fingerprint was first seen never covers it, confirmed or not
  const L9 = AIF({ status: 'confirmed', by: 'same-model check', identity: { element: 'button#delete-all', file: 'app/tasks.tsx', anchor: null, component: { file: 'app/tasks.tsx', name: 'Delete all' } } });
  const nine = { ...L9, ...(({ fp, group, inputs }) => ({ fp, group, inputs }))(L.fingerprintOf({ source: 'ai', lens: 'L9', rule: L9.rule, route: '/tasks', selector: 'button#delete-all', identity: L9.identity, evidence: {} })) };
  const s9 = L.foldAi(L.emptyState(), { run: '0001', key: 'k', findings: [nine], now: T('15:00') });
  const before = keep(only(s9).group, '14:00'), after = keep(only(s9).group, '16:00');
  row = L.view(s9, [before], new Set([L.approvalKey(before)]), NOW)[0];
  assert.equal(row.status, 'open');
  assert.match(row.note, /before this AI finding was first seen/);
  assert.equal(L.view(s9, [after], new Set([L.approvalKey(after)]), NOW)[0].status, 'kept');
});

test('group decisions on AI items: one made after a verification with too few decoys does not cover the item (no double-check, like a bare claim)', () => {
  const T = s => Date.parse(`2026-10-14T${s}:00.000+09:00`);
  const NOW = { now: T('23:00') };
  const identity = { element: 'p.err', file: 'app/err.tsx', anchor: null, component: { file: 'app/err.tsx', name: null } };
  const fp = L.fingerprintOf({ source: 'ai', lens: 'L6', rule: 'L6.vague-error', route: '/tasks', selector: 'p.err', identity, evidence: {} });
  const L6 = (over = {}) => AIF({ lens: 'L6', rule: 'L6.vague-error', selector: 'p.err', identity, claimedSeverity: 'medium', fp: fp.fp, group: fp.group, inputs: fp.inputs, ...over });
  const keep = (target, at) => ({ schema: 1, id: `dk-${at.replace(/\D/g, '')}`, target, decision: 'keep', reason: 'intended', by: 'me', at: `2026-10-14T${at}:00.000+09:00`, fingerprintVersion: 2 });
  // verified at 11:00 in a run with too few decoys: confirmed, not suspect, not double-checked
  const st = L.foldAi(L.emptyState(), { run: '0001', key: 'k1', findings: [L6({ status: 'confirmed', tooFewDecoys: true, by: 'same-model check' })], now: T('11:00') });
  const item = only(st);
  assert.deepEqual([item.verification.status, item.verification.tooFewDecoys, item.verification.at, L.checkedAi(item)], ['confirmed', true, T('11:00'), false]);
  const after = keep({ group: item.group }, '12:00');
  const row = L.view(st, [after], new Set([L.approvalKey(after)]), NOW)[0];
  assert.equal(row.status, 'open', 'a group decision after a too-few-decoys verification does not cover it');
  assert.match(row.note, /too few decoys to check the checker/);
  // the same timing after a suspect verification still covers it (design §2.2: decided after its latest verification)
  const sus = L.foldAi(L.emptyState(), { run: '0001', key: 'k1', findings: [L6({ status: 'confirmed', suspect: true, by: 'same-model check' })], now: T('11:00') });
  assert.equal(L.view(sus, [after], new Set([L.approvalKey(after)]), NOW)[0].status, 'kept');
  // a decision on the fingerprint itself still applies, as for any AI item
  const onFp = keep({ fp: item.fp }, '12:30');
  assert.equal(L.view(st, [onFp], new Set([L.approvalKey(onFp)]), NOW)[0].status, 'kept');
});

test('trust is kept per lens and source: the rule lens and the AI lens of the same name never share a record', () => {
  let st = L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0001', scope: {}, findings: L.annotate(['/a', '/b', '/c', '/d', '/e'].map(r => fnd(r, 'guest.normal.m', r, { lens: 'L6', rule: 'raw-error-text', evidence: { text: r } }))) });
  st = L.foldAi(st, { run: '0001', key: 'k', findings: ['p.a', 'p.b'].map(s => AIF({ lens: 'L6', rule: 'L6.vague-error', selector: s, ...(({ fp, group, inputs }) => ({ fp, group, inputs }))(L.fingerprintOf({ source: 'ai', lens: 'L6', rule: 'L6.vague-error', route: '/tasks', selector: s, evidence: {} })) })), now: 1 });
  const rows = L.view(st, []);
  const dec = (r, decision) => ({ schema: 1, id: `d-${r.fp}`, target: { fp: r.fp }, decision, reason: decision === 'false-positive' ? 'not-a-problem' : null, by: 'me', at: '2026-10-14T10:00:00.000+09:00' });
  const decisions = [...rows.filter(r => r.source === 'rule').map(r => dec(r, 'fix')), ...rows.filter(r => r.source === 'ai').map(r => dec(r, 'false-positive'))];
  const t = L.trust(rows, decisions);
  assert.deepEqual(Object.keys(t), ['L6', 'L6/ai']);
  assert.deepEqual([t.L6.source, t.L6.fix, t.L6.falsePositive, t.L6.precision], ['rule', 5, 0, 1]);
  assert.deepEqual([t['L6/ai'].source, t['L6/ai'].fix, t['L6/ai'].falsePositive, t['L6/ai'].precision], ['ai', 0, 2, 0]);
});

test('staleness: after 2 hunts that saw its screen and did not claim it, an AI item is stale (shown apart); a claim brings it back', () => {
  const seen = ['L9|/tasks|guest.normal.m'];
  let st = fold(L.emptyState(), '0001', [AIF()]);
  st = L.foldAi(st, { run: '0002', key: 'a', findings: [], seen, now: 2 });
  assert.deepEqual([only(st).silentHunts, L.view(st, [])[0].status], [1, 'open']);
  st = L.foldAi(st, { run: '0003', key: 'b', findings: [], seen: ['L6|/tasks|guest.normal.m'], now: 3 });
  assert.equal(only(st).silentHunts, 1, 'another lens saw the screen: says nothing about this item');
  st = L.foldAi(st, { run: '0004', key: 'c', findings: [], seen, now: 4 });
  assert.deepEqual([only(st).silentHunts, only(st).lastHunted, L.view(st, [])[0].status, L.view(st, [])[0].stale], [2, '0004', 'stale', true]);
  st = fold(st, '0005', [AIF()]);
  assert.deepEqual([only(st).silentHunts, only(st).lastSeen, L.view(st, [])[0].status], [0, '0005', 'open']);
});

test('a capture never fixes an AI item: a sweep that looked at its screen and found nothing leaves it open (only a re-check can, §2.4)', () => {
  let st = L.foldRun({ schema: 1, runs: [], items: {} }, { id: '0001', scope: { routes: ['/tasks'] }, wholeApp: true, scenes: [sc('/tasks', 'guest.normal.m')], findings: [] });
  st = fold(st, '0001', [AIF()]);
  st = L.foldRun(st, { id: '0002', scope: { routes: ['/tasks'] }, wholeApp: true, scenes: [sc('/tasks', 'guest.normal.m')], findings: [] });
  assert.equal(only(st).goneAt, null);
  assert.equal(L.view(st, [])[0].status, 'open');
});

test('verify: a run with fewer decoys than planned has too few decoys to check the checker: not suspect, and not double-checked', () => {
  const claims = Array.from({ length: 4 }, (_, i) => ({ source: 'ai', status: 'claimed', lens: 'L6', rule: 'L6.vague-error', severity: 'medium', scene: 's', route: '/', viewport: 'm', selector: `p:nth-of-type(${i + 1})`, box: [0, 0, 1, 1], evidence: { claim: `c${i}` } }));
  const { key } = V.planVerify({ findings: claims });
  assert.deepEqual([key.decoys, key.decoysPlanned], [0, 3], 'at least 3 decoys are planned for any claim');
  const r = V.recordVerdicts({ findings: claims, key, verdicts: Object.keys(key.packets).map(packet => ({ packet, verdict: 'confirmed', reason: 'ok' })) });
  // before the review of PR #29 (round 2) this was suspect whatever the verifier did
  assert.deepEqual([r.verify.suspect, r.verify.outcome, r.verify.suspectReason], [false, 'too-few-decoys', undefined]);
  assert.match(r.verify.tooFewDecoys, /^too few decoys to check the checker \(0 of 3: the screens offered too few decoy targets\); these findings are not double-checked$/);
  assert.ok(r.findings.every(f => f.verification.tooFewDecoys === true && f.verification.suspect === undefined));
  // into the ledger: confirmed, not suspect, and still not double-checked
  const st = L.foldAi(L.emptyState(), { run: '0001', key: 'k', findings: r.findings.map(f => foldFinding(f)), now: 1 });
  for (const it of Object.values(st.items)) {
    assert.deepEqual([it.verification.status, it.verification.suspect, it.verification.tooFewDecoys, L.checkedAi(it)], ['confirmed', false, true, false]);
  }
  // a rejection in such a run is no double-check either: the claim stays
  const later = L.foldAi(st, { run: '0002', key: 'k2', findings: r.findings.map(f => foldFinding({ ...f, status: 'rejected', verification: { ...f.verification, verdict: 'rejected' } })), now: 2 });
  assert.ok(Object.keys(st.items).length > 0);
  assert.deepEqual(Object.keys(later.items), Object.keys(st.items), 'a rejection by an unchecked verifier keeps the item');
  // with a decoy the verifier confirmed, a run short of decoys is suspect as before
  const two = { ...key, decoysPlanned: 3, decoys: 1, packets: { ...key.packets, p999: { decoy: true, template: 'unclear-label' } } };
  const s2 = V.recordVerdicts({ findings: claims, key: two, verdicts: Object.keys(two.packets).map(packet => ({ packet, verdict: 'confirmed', reason: 'ok' })) });
  assert.deepEqual([s2.verify.suspect, s2.verify.outcome, s2.verify.suspectReason], [true, 'suspect', 'decoy pass-through 1/1 > 10%']);
});

test('verify: too few decoys through the CLI — said by verify --record, findings, the summary and the board model; --again says why it cannot help', async () => {
  const cwd = project();
  const dir = makeRun(cwd, '0001');
  // the home screens offer no control: only Add Task and Home are left for decoys (2 of 3)
  for (const vp of ['m', 'd']) writeFileSync(join(dir, `~.guest.normal.${vp}`, 'controls.json'), '[]');
  const rec = await huntAndVerify(cwd, '0001');
  assert.equal(rec.code, 0, rec.stderr);
  assert.doesNotMatch(rec.stdout, /SUSPECT/);
  assert.match(rec.stdout, /NOT DOUBLE-CHECKED: too few decoys to check the checker \(2 of 3/);
  const verify = JSON.parse(readFileSync(join(dir, 'verify.json'), 'utf8'));
  assert.deepEqual([verify.outcome, verify.suspect, verify.decoys.total, verify.decoysPlanned], ['too-few-decoys', false, 2, 3]);
  const [g] = await aiGroups(cwd);
  assert.deepEqual([g.example.verification.status, g.example.verification.suspect, g.example.verification.tooFewDecoys, g.checked], ['confirmed', false, true, false]);
  const text = (await cli(cwd, 'findings')).stdout;
  assert.match(text, /AI, not double-checked: 1 group\(s\) \(.*too few decoys to check the checker\)/);
  assert.match(text, /1 AI group\(s\) verified in a run with too few decoys to check the checker: not suspect, and not double-checked either/);
  const sum = (await json(cwd, 'findings')).summary;
  assert.deepEqual([sum.ai.doubleChecked, sum.ai.notDoubleChecked, sum.ai.suspect, sum.ai.tooFewDecoys], [0, 1, false, true]);
  assert.match(sum.verdict.text, /not double-checked/);
  assert.doesNotMatch(sum.verdict.text, /suspect/);
  // the static export says it the same way
  assert.equal((await cli(cwd, 'export', '--html', 'review')).code, 0);
  const html = readFileSync(join(cwd, 'review', 'index.html'), 'utf8');
  assert.match(html, /AI · not double-checked \(too few decoys to check the checker\)/);
  assert.match(html, /0 double-checked .*too few decoys to check the checker/);
  const M = await import('../src/board/model.mjs');
  const model = M.buildBoardModel({ nunchiDir: join(cwd, '.nunchi'), projectDir: cwd });
  const d = M.groupDetail(model, g.group);
  assert.deepEqual([d.checked, d.suspect, d.tooFewDecoys, d.verification.tooFewDecoys, d.verification.suspect], [false, false, true, true, false]);
  const again = await cli(cwd, 'verify', '--plan', '--again');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /not suspect: it had too few decoys to check the checker/);
});

test('verify --plan --again re-verifies a suspect run (its suspect verdicts become claims again); a run that is not suspect is refused', async () => {
  const cwd = project();
  makeRun(cwd, '0001');
  // the verifier confirmed the decoy too: suspect
  assert.equal((await huntAndVerify(cwd, '0001', { decoys: 'confirmed' })).code, 0);
  let [g] = await aiGroups(cwd);
  assert.deepEqual([g.example.verification.status, g.example.verification.suspect, g.checked], ['confirmed', true, false]);
  // not double-checked: kept apart, collapsed into one line
  const text = await cli(cwd, 'findings');
  assert.match(text.stdout, /AI, not double-checked: 1 group\(s\)/);
  assert.doesNotMatch(text.stdout, /AI · L9/);
  const again = await cli(cwd, 'verify', '--plan', '--again', '--json');
  assert.equal(again.code, 0, again.stderr);
  const packets = JSON.parse(again.stdout).packets;
  const key = St.readKey(join(cwd, '.nunchi', 'runs', '0001'), 'verify-key.json');
  assert.equal(key.claims, 2, 'both suspect verdicts are claims again');
  assert.ok(packets.every(p => p.claim.severity === 'high'), 'judged as claimed, not as the earlier verifier corrected it');
  writeFileSync(join(cwd, 'v2.json'), JSON.stringify(Object.entries(key.packets).map(([packet, k]) => ({ packet, verdict: k.decoy ? 'rejected' : 'confirmed', severity: 'high', reason: 'ok' }))));
  const rec = await cli(cwd, 'verify', '--record', 'v2.json');
  assert.equal(rec.code, 0, rec.stderr);
  assert.doesNotMatch(rec.stdout, /SUSPECT/);
  [g] = await aiGroups(cwd);
  assert.deepEqual([g.example.verification.status, g.example.verification.suspect, g.checked], ['confirmed', false, true], 'the fold was replaced');
  assert.match((await cli(cwd, 'findings')).stdout, /^high +AI · L9\.destructive-without-confirm — 1 group\(s\) on 1 screen\(s\)/m);
  const refused = await cli(cwd, 'verify', '--plan', '--again');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not suspect/);
});
