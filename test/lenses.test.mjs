// Lens packs are data (spec §3): strict schema, fixed load order, sha256-pinned external packs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadLenses, lensProblems, validateLens, mergeLens, SEVERITIES } from '../src/lenses.mjs';
import { stableJson } from '../src/stable.mjs';
import { tmp as tmpDir } from './fixtures/tmp.mjs';

const tmp = () => tmpDir('nunchi-lens-');
const write = (dir, name, data) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const sha256 = s => createHash('sha256').update(s).digest('hex');

const lens = (over = {}) => ({
  schema: 1, id: 'L6', name: 'Copy quality (test)', definition: 'Text that leaves the user unsure.', method: 'ai',
  scenes: {}, evidence: ['text.txt'],
  checklist: [{ id: 'L6.vague-error', question: 'Is there an error that does not say what to do?' }],
  examples: { good: ['We could not save the pebble. Try again.'], bad: ['Oops!'] },
  severityRubric: { medium: 'an error that does not say what to do' },
  ...over,
});

test('built-in packs: valid, sorted L1 … L10, item ids carry their lens id, all AI', () => {
  const root = tmp();
  const { lenses, sources } = loadLenses({ root });
  assert.deepEqual(lenses.map(l => l.id), ['L1', 'L2', 'L4', 'L5', 'L6', 'L7', 'L9', 'L10']);
  assert.ok(sources.every(s => s.kind === 'built-in' && /^[0-9a-f]{64}$/.test(s.sha256)));
  for (const l of lenses) {
    assert.deepEqual(lensProblems(l, l.id), [], l.id);
    assert.equal(l.method, 'ai');
    assert.ok(l.checklist.length >= 2, `${l.id} has a concrete checklist`);
    for (const item of l.checklist) assert.ok(item.id.startsWith(l.id + '.'), item.id);
    assert.ok(l.examples.good.length && l.examples.bad.length, `${l.id} has good and bad examples`);
    assert.ok(Object.keys(l.severityRubric).every(k => SEVERITIES.includes(k)));
  }
  // L2 only on forced states; L10's first-view item only on the phone
  assert.deepEqual(lenses.find(l => l.id === 'L2').scenes.states, ['empty', 'error', 'slow', 'offline']);
  assert.deepEqual(lenses.find(l => l.id === 'L10').checklist.find(i => i.id === 'L10.primary-not-in-first-view').scenes, { viewports: ['m'] });
  assert.equal(stableJson(loadLenses({ root })), stableJson({ lenses, sources }), 'same files → same result');
  // the copy and safety lenses read the route's source inventory slice in the hunt (spec §4); the others do not
  assert.deepEqual(lenses.filter(l => l.source === true).map(l => l.id), ['L2', 'L5', 'L6', 'L7', 'L9']);
});

test('schema: `source` is an optional boolean, replaced by an extends overlay', () => {
  assert.deepEqual(lensProblems(lens({ source: true }), 'p'), []);
  assert.deepEqual(lensProblems(lens({ source: false }), 'p'), []);
  assert.ok(lensProblems(lens({ source: 'inventory.json' }), 'p').some(p => /source: true or false/.test(p)));
  assert.ok(lensProblems(lens({ source: { file: 'x' } }), 'p').some(p => /source: true or false/.test(p)));
  assert.deepEqual(lensProblems(lens({ reference: 'nearest' }), 'p'), []);
  assert.ok(lensProblems(lens({ reference: 'closest' }), 'p').some(p => /reference: "nearest" or "spread"/.test(p)));
  assert.equal(mergeLens(lens({ source: true }), { id: 'L6', extends: 'L6', source: false }).source, false);
  assert.equal(mergeLens(lens({ source: true }), { id: 'L6', extends: 'L6', name: 'x' }).source, true);
});

test('schema: rejects code, executable-looking keys, unknown keys and bad values', () => {
  assert.deepEqual(lensProblems(lens(), 'ok'), []);
  const fn = lensProblems(lens({ definition: () => 'hi' }), 'p');
  assert.ok(fn.some(p => /not data/.test(p)), fn.join('\n'));
  const exec = lensProblems(lens({ onLoad: 'fetch("https://x.invalid")' }), 'p');
  assert.ok(exec.some(p => /looks executable/.test(p)), exec.join('\n'));
  assert.ok(lensProblems(lens({ script: 'x' }), 'p').some(p => /looks executable/.test(p)));
  assert.ok(lensProblems(lens({ colour: 'blue' }), 'p').some(p => /unknown key/.test(p)));
  assert.ok(lensProblems(JSON.parse('{"__proto__": {"x": 1}, "id": "L6"}'), 'p').some(p => /forbidden key/.test(p)));
  assert.ok(lensProblems(lens({ method: 'llm' }), 'p').some(p => /method/.test(p)));
  assert.ok(lensProblems(lens({ id: 'L11' }), 'p').some(p => /L1 … L10/.test(p)));
  assert.ok(lensProblems(lens({ checklist: [{ id: 'L5.vague', question: 'q?' }] }), 'p').some(p => /must start with the lens id L6/.test(p)));
  assert.ok(lensProblems(lens({ checklist: [{ id: 'L6.a', question: 'q?', run: 'rm -rf' }] }), 'p').some(p => /looks executable/.test(p)));
  assert.ok(lensProblems(lens({ scenes: { states: ['broken'] } }), 'p').some(p => /scenes.states/.test(p)));
  assert.ok(lensProblems(lens({ evidence: ['../../etc/passwd'] }), 'p').some(p => /evidence/.test(p)));
  assert.ok(lensProblems(lens({ severityRubric: { critical: 'x' } }), 'p').some(p => /unknown key/.test(p)));
  const { definition, ...noDef } = lens();
  assert.ok(lensProblems(noDef, 'p').some(p => /definition: required/.test(p)));
  assert.throws(() => validateLens(lens({ method: 'llm' }), 'p'), e => e.code === 'BAD_LENS');
});

test('project pack: same id replaces the built-in lens, extends merges into it', () => {
  const root = tmp();
  write(join(root, '.nunchi', 'lenses'), 'a-l6.json', lens());
  write(join(root, '.nunchi', 'lenses'), 'b-l5.json', {
    id: 'L5', extends: 'L5',
    checklist: [
      { id: 'L5.mixed-capitalisation', off: true },
      { id: 'L5.pebble-unit', question: 'Is the pebble count called "pebbles" in one place and "stones" in another?' },
    ],
    severityRubric: { high: 'a wrong name on the checkout path' },
  });
  const { lenses, sources } = loadLenses({ root });
  const l6 = lenses.find(l => l.id === 'L6');
  assert.equal(l6.name, 'Copy quality (test)', 'replaced wholesale');
  assert.deepEqual(l6.checklist.map(c => c.id), ['L6.vague-error']);
  const l5 = lenses.find(l => l.id === 'L5');
  assert.ok(!l5.checklist.some(c => c.id === 'L5.mixed-capitalisation'), 'off removes an item');
  assert.equal(l5.checklist[l5.checklist.length - 1].id, 'L5.pebble-unit', 'new items are appended');
  assert.equal(l5.name, 'Copy consistency', 'unset fields kept');
  assert.equal(l5.severityRubric.high, 'a wrong name on the checkout path');
  assert.ok(l5.severityRubric.medium, 'rubric merged key by key');
  assert.equal(l5.extends, undefined);
  assert.deepEqual(sources.filter(s => s.kind === 'project').map(s => s.path), ['.nunchi/lenses/a-l6.json', '.nunchi/lenses/b-l5.json']);
});

test('extends: needs an earlier lens of the same id; overlays are validated after the merge', () => {
  const root = tmp();
  write(join(root, '.nunchi', 'lenses'), 'x.json', { id: 'L3', extends: 'L3', name: 'Flow' });
  assert.throws(() => loadLenses({ root }), e => e.code === 'BAD_LENS' && /no earlier pack defines it/.test(e.message));
  assert.ok(lensProblems({ id: 'L6', extends: 'L5' }, 'p').some(p => /own id/.test(p)));
  const base = lens();
  assert.throws(() => validateLens(mergeLens(base, { id: 'L6', extends: 'L6', checklist: [{ id: 'L6.vague-error', off: true }] }), 'p'), /checklist/);
});

test('external packs: loaded when the sha256 matches, refused when it does not', () => {
  const root = tmp();
  const pack = JSON.stringify({ schema: 1, name: 'garden pack', lenses: [lens({ name: 'Copy quality (garden)' })] });
  write(join(root, 'vendor'), 'garden-lenses.json', pack);
  write(join(root, '.nunchi'), 'lenses.lock.json', { schema: 1, packs: [{ path: 'vendor/garden-lenses.json', sha256: sha256(pack) }] });
  const ok = loadLenses({ root });
  assert.equal(ok.lenses.find(l => l.id === 'L6').name, 'Copy quality (garden)');
  assert.deepEqual(ok.sources.filter(s => s.kind === 'external'), [{ kind: 'external', path: 'vendor/garden-lenses.json', sha256: sha256(pack) }]);

  write(join(root, 'vendor'), 'garden-lenses.json', pack.replace('garden)', 'garden!)'));
  assert.throws(() => loadLenses({ root }), e => e.code === 'LENS_HASH_MISMATCH' && /Refusing/.test(e.message));

  write(join(root, '.nunchi'), 'lenses.lock.json', { packs: [{ path: '../outside.json', sha256: sha256(pack) }] });
  assert.throws(() => loadLenses({ root }), e => e.code === 'BAD_LENS' && /inside the project/.test(e.message));
  write(join(root, '.nunchi'), 'lenses.lock.json', { packs: [{ path: 'vendor/garden-lenses.json', sha256: sha256(pack), postinstall: 'x' }] });
  assert.throws(() => loadLenses({ root }), e => e.code === 'BAD_LENS' && /unknown key/.test(e.message));
});

test('a bundle cannot define one lens twice; broken JSON is reported with its file', () => {
  const root = tmp();
  write(join(root, '.nunchi', 'lenses'), 'dup.json', { lenses: [lens(), lens()] });
  assert.throws(() => loadLenses({ root }), e => e.code === 'BAD_LENS' && /appears twice/.test(e.message));
  const root2 = tmp();
  write(join(root2, '.nunchi', 'lenses'), 'bad.json', '{ "id": "L6", ');
  assert.throws(() => loadLenses({ root: root2 }), e => e.code === 'BAD_LENS' && /bad\.json/.test(e.message));
});

test('the project has the last word over an external pack it adopted', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const root = tmpDir('nunchi-order-');
  mkdirSync(join(root, '.nunchi', 'lenses'), { recursive: true }); mkdirSync(join(root, 'vendor'));
  const ext = JSON.stringify({ id: 'L6', extends: 'L6', name: 'from the vendor' });
  writeFileSync(join(root, 'vendor', 'v.json'), ext);
  writeFileSync(join(root, '.nunchi', 'lenses.lock.json'), JSON.stringify({ schema: 1, packs: [{ path: 'vendor/v.json', sha256: createHash('sha256').update(ext).digest('hex') }] }));
  writeFileSync(join(root, '.nunchi', 'lenses', 'mine.json'), JSON.stringify({ id: 'L6', extends: 'L6', name: 'ours' }));
  const r = loadLenses({ root });
  assert.equal(r.lenses.find(l => l.id === 'L6').name, 'ours');
  assert.deepEqual(r.sources.map(s => s.kind).filter(k => k !== 'built-in'), ['external', 'project']);
});
