// A small captured run for the AI hunt's tests (M6: answers per agent, hunts in progress): the invented Pebble Garden,
// '/' and '/tasks' at both widths and '/tasks' in its error state, with the evidence files a hunter grounds a defect
// in. No browser.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLenses } from '../../src/lenses.mjs';

export const tmp = (prefix = 'nunchi-hunt-') => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const VP = { m: [390, 844], d: [1280, 800] };

export function makeRun(dir, { id = '0001', extra = {} } = {}) {
  const scenes = [];
  const add = (slug, route, state, vp) => {
    const sid = `${slug}.guest.${state}.${vp}`;
    scenes.push({ id: sid, route, path: route, person: 'guest', state, viewport: vp, status: 'captured', reason: null, top: `t-${sid}`, full: `f-${sid}`, textHash: `x-${sid}` });
    const d = join(dir, sid);
    mkdirSync(d, { recursive: true });
    const [w, h] = VP[vp];
    writeFileSync(join(d, 'top.jpg'), jpeg(w, h));
    writeFileSync(join(d, 'full.jpg'), jpeg(w, h));
    writeFileSync(join(d, 'text.txt'), state === 'error' ? 'Oops! Something went wrong.\n' : 'Tasks\nDelete all\n');
    writeFileSync(join(d, 'aria.yml'), route === '/tasks' ? '- heading "Tasks" [level=1]\n- paragraph: Oops! Something went wrong.\n- button "Delete all"\n' : '- heading "Pebble Garden" [level=1]\n');
    const controls = route === '/tasks'
      ? [{ selector: 'button#add-task', name: 'Add Task', box: [16, 120, 120, 40], tag: 'button' }, { selector: 'button#delete-all', name: 'Delete all', box: [150, 120, 100, 40], tag: 'button' }]
      : [{ selector: 'a#see-tasks', name: 'See tasks', box: [16, 200, 90, 24], tag: 'a', href: '/tasks' }];
    writeFileSync(join(d, 'controls.json'), JSON.stringify(controls, null, 2));
    writeFileSync(join(d, 'styles.json'), '[]');
    writeFileSync(join(d, 'links.json'), '[]');
    writeFileSync(join(d, 'measure.json'), JSON.stringify({ clipped: [], images: [], scrollers: [], hiddenControls: [] }));
  };
  for (const vp of ['m', 'd']) { add('~', '/', 'normal', vp); add('tasks', '/tasks', 'normal', vp); }
  add('tasks', '/tasks', 'error', 'm');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, baseUrl: 'http://127.0.0.1:3000', health: { status: 'ok', problems: [] }, scenes }, null, 2));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ schema: 1, id, kind: 'sweep', worktree: 'main', ...extra }));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schema: 1, findings: [] }));
  return dir;
}

// A project folder holding one run (0001, latest) and the app's source the hunters ground defects in.
export function huntProject({ prefix } = {}) {
  const cwd = tmp(prefix);
  const runDir = makeRun(join(cwd, '.nunchi', 'runs', '0001'));
  writeFileSync(join(cwd, '.nunchi', 'runs', 'latest'), '0001\n');
  mkdirSync(join(cwd, 'app'), { recursive: true });
  writeFileSync(join(cwd, 'app', 'tasks.tsx'), 'export default function Tasks() {\n  return <button onClick={() => store.clear()}>Delete all</button>;\n}\n');
  return { cwd, runDir, lenses: loadLenses({ root: cwd }).lenses };
}

// Answer every item of a unit with `answer`; override some items.
export const answerAll = (unit, answer, over = {}) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.map(c => [c.id, over[c.id] ?? { answer }])) });
// A unit's answer with one item left out (incomplete: the unit is not seen).
export const answerSome = (unit, answer) => ({ unit: unit.id, items: Object.fromEntries(unit.checklist.slice(1).map(c => [c.id, { answer }])) });
// The L9 defect on "Delete all", as a hunter grounds it.
export const deleteAll = (scene = 'tasks.guest.normal.m', { severity = 'high', claim = 'Deletes every task at once, with no confirmation or undo.' } = {}) =>
  ({ 'L9.destructive-without-confirm': { answer: 'defect', defects: [{ scene, selector: 'button#delete-all', claim, severity }] } });
