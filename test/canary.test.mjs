// Canaries (spec §4 H2): each planted defect on a synthetic page that has a place for it and on one that
// does not; deterministic choice; canary copies kept out of findings.json; scoring and coverage voiding.
// The browser tests need a Chromium (NUNCHI_BROWSER or `node src/cli.mjs setup`): skipped without one,
// failed when NUNCHI_REQUIRE_BROWSER is set.
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { capture, launch } from '../src/capture.mjs';
import { CANARY_KINDS, canaryMutate, canarySeed, canaryCandidates, kindOrder, plantCanaries, scoreCanaries, voidCoverage, sameLocation } from '../src/canary.mjs';

const CANARY = fileURLToPath(new URL('./fixtures/canary', import.meta.url));
const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
let server, base, browser, browserOk = true;

before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path === '/' ? join(SITE, 'index.html') : existsSync(join(CANARY, path)) ? join(CANARY, path) : join(SITE, path);
    if (!file.startsWith(CANARY) && !file.startsWith(SITE)) { res.writeHead(404); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { browser = await launch(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();
const mutate = async (page, kinds, vp = { width: 390, height: 844 }) => {
  const p = await browser.newPage({ viewport: vp });
  await p.goto(`${base}/${page}`);
  const before = await p.evaluate(() => document.body.innerHTML);
  const r = await p.evaluate(canaryMutate, { kinds });
  const after = await p.evaluate(() => ({ html: document.body.innerHTML, text: document.body.innerText }));
  await p.close();
  return { r, changed: before !== after.html, text: after.text };
};

// Where each kind lands on trigger.html, and what it leaves.
const EXPECT = {
  'verb-swap': { selector: 'main > form > button', after: 'Log in' },
  'term-swap': { selector: 'main > h1', after: 'To-dos' },
  'vague-error': { selector: 'main > p:nth-of-type(2)', after: 'Something went wrong.' },
  'vague-confirm': { selector: 'main > p:nth-of-type(4)', after: 'Are you sure?' },
  'stray-todo': { selector: 'main > p:nth-of-type(1)', after: 'Plan the week ahead and keep every errand in one calm list. TODO: replace with final copy' },
  'blank-state': { selector: 'main > p:nth-of-type(3)', after: '' },
  'remove-confirm': { selector: 'main > button', after: 'Delete list' },
  'fixed-cover': { selector: 'body > div', after: 'Get the app for the full experience' },
};

test('every catalogued kind has a lens, a checklist item and a fixture expectation', () => {
  assert.deepEqual(CANARY_KINDS.map(k => k.kind).sort(), Object.keys(EXPECT).sort());
  for (const k of CANARY_KINDS) {
    assert.match(k.lens, /^L(2|5|6|7|9|10)$/, `${k.kind} belongs to an AI lens`);
    assert.ok(k.checklist.startsWith(k.lens + '.'), k.kind);
  }
});

for (const { kind } of CANARY_KINDS) {
  test(`canary ${kind}: planted where the page has a place for it`, async t => {
    if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
    const { r, changed } = await mutate('trigger.html', [kind]);
    assert.ok(r, `${kind} should apply on trigger.html`);
    assert.equal(r.kind, kind);
    assert.equal(r.selector, EXPECT[kind].selector);
    assert.equal(r.after, EXPECT[kind].after);
    assert.ok(r.box[2] > 0 && r.box[3] > 0, `the planted element keeps a box: ${JSON.stringify(r.box)}`);
    assert.ok(changed, 'the page changed');
  });
  test(`canary ${kind}: nothing planted, page untouched, where it has no place`, async t => {
    if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
    const { r, changed } = await mutate('plain.html', [kind]);
    assert.equal(r, null);
    assert.equal(changed, false);
  });
}

test('canary kinds are tried in the order given; the first that fits is planted', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  assert.equal((await mutate('trigger.html', ['nope', 'fixed-cover', 'verb-swap'])).r.kind, 'fixed-cover');
  assert.equal((await mutate('plain.html', CANARY_KINDS.map(k => k.kind))).r, null);
  const twice = [await mutate('trigger.html', ['stray-todo']), await mutate('trigger.html', ['stray-todo'])];
  assert.deepEqual(twice[0].r, twice[1].r, 'same page, same canary');
});

test('canary choice is deterministic and comes from the run scope only', async () => {
  const scope = { routes: ['/b', '/a'], persons: ['guest'], viewports: ['m', 'd'], states: ['normal'] };
  assert.equal(canarySeed(scope), canarySeed({ ...scope, routes: ['/a', '/b'], viewports: ['d', 'm'] }), 'order of the scope does not matter');
  assert.notEqual(canarySeed(scope), canarySeed({ ...scope, routes: ['/a'] }));
  const entries = ['/a', '/b', '/c'].flatMap(route => ['m', 'd'].map(viewport => ({ id: `${route.slice(1)}.guest.normal.${viewport}`, route, person: 'guest', state: 'normal', viewport, status: 'captured', reason: null })));
  entries.push({ id: 'x.guest.normal.m', route: '/x', status: 'captured', reason: 'redirected to /login', viewport: 'm' });
  entries.push({ id: 'y.guest.normal.m', route: '/y', status: 'capture-failed', reason: 'no-dom', viewport: 'm' });
  const seed = canarySeed(scope);
  const order = canaryCandidates(entries, seed).map(e => e.id);
  assert.deepEqual(order, canaryCandidates([...entries].reverse(), seed).map(e => e.id), 'input order does not matter');
  assert.equal(order.length, 6, 'redirected and failed scenes are never copied');
  assert.deepEqual(new Set(order.slice(0, 3).map(id => id.split('.')[0])), new Set(['a', 'b', 'c']), 'one scene per route first');
  const kinds = kindOrder(seed, order[0]);
  assert.deepEqual(kinds, kindOrder(seed, order[0]));
  assert.deepEqual([...kinds].sort(), CANARY_KINDS.map(k => k.kind).sort());
  const used = new Set([kinds[0]]);
  assert.equal(kindOrder(seed, order[0], used).at(-1), kinds[0], 'kinds already planted go last');

  // plantCanaries: a scene without a place is skipped, ids count up, at most 3 × count tries.
  const tried = [];
  const r = await plantCanaries({ entries, count: 2, seed, tryScene: async (b, ks, id) => {
    tried.push(id);
    if (b.route === '/a') return null;
    return { entry: { id, route: b.route, status: 'captured', findings: 7 }, canary: { kind: ks[0], selector: 'main > p', box: [0, 0, 10, 10], before: 'x', after: 'y' } };
  } });
  assert.equal(r.canaries.length, 2);
  assert.deepEqual(r.canaries.map(c => c.scene), r.entries.map(e => e.id));
  assert.match(r.entries[0].id, /\.canary-1$/); assert.match(r.entries[1].id, /\.canary-2$/);
  assert.deepEqual(r.entries.map(e => e.findings), [0, 0], 'rule findings on canary copies are not counted');
  assert.ok(r.entries.every(e => e.canary && e.of));
  assert.notEqual(r.canaries[0].kind, r.canaries[1].kind, 'a run spreads over kinds');
  const none = await plantCanaries({ entries, count: 2, seed, tryScene: async () => null });
  assert.equal(none.canaries.length, 0);
  assert.equal(none.tries, 6);
});

test('capture plants canaries in copies, tags them in the manifest and keeps them out of findings.json; deterministic', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const scenes = ['/', '/broken.html', '/trigger.html', '/plain.html'].map(p => ({ route: p, path: p }));
  const a = mkdtempSync(join(tmpdir(), 'nunchi-canary-a-')), b = mkdtempSync(join(tmpdir(), 'nunchi-canary-b-'));
  const r = await capture({ baseUrl: base, scenes, out: a, canaries: 3 });
  const planted = JSON.parse(readFileSync(join(a, 'canaries.json'), 'utf8'));
  assert.equal(planted.planted.length, 3, JSON.stringify(planted, null, 1));
  assert.ok(planted.planted.every(c => !c.route.startsWith('/plain')), 'plain.html has no place for a canary');
  const tagged = r.manifest.scenes.filter(s => s.canary !== undefined);
  assert.deepEqual(tagged.map(s => s.id), planted.planted.map(c => c.scene));
  assert.equal(r.manifest.scenes.length, 8 + 3);
  for (const c of planted.planted) {
    assert.ok(existsSync(join(a, c.scene, 'top.jpg')) && existsSync(join(a, c.scene, 'controls.json')), `${c.scene} has its evidence`);
    assert.equal(r.manifest.scenes.find(s => s.id === c.of).canary, undefined);
    const info = CANARY_KINDS.find(k => k.kind === c.kind);
    assert.equal(c.lens, info.lens); assert.equal(c.checklist, info.checklist);
    if (c.after) assert.ok(readFileSync(join(a, c.scene, 'text.txt'), 'utf8').includes(c.after.slice(0, 20)) || c.kind === 'remove-confirm', `${c.kind}: the evidence shows the planted text`);
  }
  // the broken page's copy would carry many rule findings; none reach findings.json
  const findings = JSON.parse(readFileSync(join(a, 'findings.json'), 'utf8')).findings;
  assert.deepEqual(findings.filter(f => /\.canary-\d+$/.test(f.scene || '')), []);
  assert.ok(findings.some(f => f.scene === 'broken.html.guest.normal.m'), 'the original scene keeps its findings');
  assert.ok(tagged.every(s => s.findings === 0));
  assert.ok(!files(a).some(f => f.startsWith('plain.html') && f.includes('.canary-')), 'a copy where nothing fit leaves no folder');

  await capture({ baseUrl: base, scenes, out: b, canaries: 3 });
  const stable = f => f !== 'timing.json' && f !== 'run.json' && !f.endsWith('volatile.json');
  const fa = files(a).filter(stable);
  assert.deepEqual(fa, files(b).filter(stable));
  const diff = fa.filter(f => !readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
  assert.deepEqual(diff, [], `files that differ between runs: ${diff.join(', ')}`);
});

test('without canaries nothing changes: no canaries.json, no tagged scenes', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = mkdtempSync(join(tmpdir(), 'nunchi-nocanary-'));
  const r = await capture({ baseUrl: base, scenes: [{ route: '/trigger.html', path: '/trigger.html' }], viewports: ['m'], out });
  assert.equal(existsSync(join(out, 'canaries.json')), false);
  assert.equal(r.manifest.scenes.filter(s => s.canary !== undefined).length, 0);
});

// ── scoring ──
const CANARIES = { schema: 1, planted: [
  { scene: 'a.guest.normal.m.canary-1', of: 'a.guest.normal.m', kind: 'verb-swap', lens: 'L5', checklist: 'L5.same-action-same-verb', selector: 'main > form > button', box: [250, 287, 80, 44] },
  { scene: 'b.guest.error.d.canary-2', of: 'b.guest.error.d', kind: 'vague-error', lens: 'L6', checklist: 'L6.error-says-what-and-next', selector: 'main > p:nth-of-type(2)', box: [16, 347, 358, 24] },
  { scene: 'c.guest.normal.m.canary-3', of: 'c.guest.normal.m', kind: 'stray-todo', lens: 'L7', checklist: 'L7.no-dev-leftovers', selector: 'main > p', box: [16, 163, 358, 48] },
] };
const ai = (scene, lens, selector, box, rule = 'x') => ({ source: 'ai', status: 'claimed', lens, rule, severity: 'medium', scene, route: '/a', viewport: 'm', selector, box, evidence: {} });

test('canary score: hit by element, ancestor or overlapping box with the right lens; misses listed', () => {
  assert.ok(sameLocation({ selector: 'main > form' }, { selector: 'main > form > button' }), 'ancestor');
  assert.ok(sameLocation({ selector: 'main > form > button > span' }, { selector: 'main > form > button' }), 'descendant');
  assert.ok(!sameLocation({ selector: 'main > form > buttonx' }, { selector: 'main > form > button' }));
  assert.ok(sameLocation({ selector: 'div.x', box: [250, 290, 80, 40] }, { selector: 'main > form > button', box: [250, 287, 80, 44] }), 'same place by box');
  assert.ok(!sameLocation({ selector: 'div.x', box: [0, 0, 80, 40] }, { selector: 'main > form > button', box: [250, 287, 80, 44] }));

  const r = scoreCanaries(CANARIES, [
    ai('a.guest.normal.m.canary-1', 'L5', 'main > form > button', null, 'L5.same-action-same-verb'),
    ai('b.guest.error.d.canary-2', 'L7', 'main > p:nth-of-type(2)', null),              // right place, wrong lens
    ai('b.guest.error.d', 'L6', 'main > p:nth-of-type(2)', null),                       // the original scene, not the copy
    ai('c.guest.normal.m.canary-3', 'L7', 'main', null),                                 // ancestor
  ]);
  assert.equal(r.planted, 3); assert.equal(r.hit, 2);
  assert.deepEqual(r.byLens, { L5: { planted: 1, hit: 1, rate: 1 }, L6: { planted: 1, hit: 0, rate: 0 }, L7: { planted: 1, hit: 1, rate: 1 } });
  assert.deepEqual(r.missed.map(m => m.scene), ['b.guest.error.d.canary-2']);
  assert.deepEqual(r.results.map(x => x.exact), [true, false, false]);
  assert.match(r.note, /upper bound/);
});

test('a missed canary voids seen for its batch in coverage.json', () => {
  const coverage = { units: [
    { id: 'u1', batch: 'b1', lens: 'L6', scenes: ['b.guest.error.d.canary-2', 'x'], seen: true },
    { id: 'u2', batch: 'b1', lens: 'L6', scenes: ['y'], seen: true },
    { id: 'u3', batch: 'b2', lens: 'L6', scenes: ['z'], seen: true },
    { id: 'u4', batch: 'b3', lens: 'L5', scenes: ['b.guest.error.d.canary-2'], seen: true },
  ] };
  const out = voidCoverage(coverage, [{ scene: 'b.guest.error.d.canary-2', lens: 'L6', kind: 'vague-error' }]);
  assert.deepEqual(out.units.map(u => u.seen), [false, false, true, true]);
  assert.equal(out.units[0].notSeen, 'canary-missed');
  assert.deepEqual(out.canaries.voidedUnits, ['u1', 'u2']);
  assert.equal(coverage.units[0].seen, true, 'input untouched');
  assert.deepEqual(voidCoverage({}, []).canaries, { missed: [], voidedUnits: [], voidedBatches: [] });
});

test('CLI canaries --score: per-lens hit rate, canary-score.json, coverage.json updated', () => {
  const work = mkdtempSync(join(tmpdir(), 'nunchi-cscore-'));
  const run = join(work, '.nunchi', 'runs', '0001');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(work, '.nunchi', 'runs', 'latest'), '0001\n');
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ schema: 1, scenes: [] }));
  writeFileSync(join(run, 'canaries.json'), JSON.stringify(CANARIES));
  const cli = args => execFileSync(process.execPath, [CLI, ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => cli(['canaries', '--score']), /ai-findings\.json does not exist/);
  writeFileSync(join(run, 'ai-findings.json'), JSON.stringify({ schema: 1, findings: [ai('a.guest.normal.m.canary-1', 'L5', 'main > form > button', null), { ...ai('c.guest.normal.m.canary-3', 'L7', 'main', null), source: 'rule' }] }));
  writeFileSync(join(run, 'coverage.json'), JSON.stringify({ units: [{ id: 'u1', batch: 'b1', lens: 'L6', scenes: ['b.guest.error.d.canary-2'], seen: true }] }));
  const text = cli(['canaries', '--score']);
  assert.match(text, /canaries hit 1\/3 → AI recall ≤ 33%/);
  assert.match(text, /L5 1\/1 · L6 0\/1 · L7 0\/1/, 'rule findings do not count as AI hits');
  const json = JSON.parse(cli(['canaries', '--score', '--run', '0001', '--json']));
  assert.equal(json.hit, 1);
  assert.deepEqual(json.coverage.voidedUnits, ['u1']);
  assert.equal(JSON.parse(readFileSync(join(run, 'coverage.json'), 'utf8')).units[0].seen, false);
  assert.equal(JSON.parse(readFileSync(join(run, 'canary-score.json'), 'utf8')).planted, 3);
});
