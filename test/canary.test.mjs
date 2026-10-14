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
import { CANARY_KINDS, canaryMutate, canarySeed, canaryCandidates, kindOrder, kindApplies, plantCanaries, scoreCanaries, voidCoverage, sameLocation } from '../src/canary.mjs';
import { loadLenses, BUILTIN_DIR } from '../src/lenses.mjs';
import { DECOY_TEMPLATES } from '../src/verify.mjs';

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
  'template-copy': { selector: 'main > p:nth-of-type(1)', after: 'Add a short description of this section here.' },
  'blank-state': { selector: 'main > p:nth-of-type(3)', after: '' },
  'remove-confirm': { selector: 'main > button', after: 'Delete list' },
  'fixed-cover': { selector: 'body > div', after: 'Get the app for the full experience' },
};

const BUILTIN = loadLenses({ root: BUILTIN_DIR }).lenses;

test('every catalogued kind has a lens, a checklist item and a fixture expectation', () => {
  assert.deepEqual(CANARY_KINDS.map(k => k.kind).sort(), Object.keys(EXPECT).sort());
  for (const k of CANARY_KINDS) {
    assert.match(k.lens, /^L(2|5|6|7|9|10)$/, `${k.kind} belongs to an AI lens`);
    assert.ok(k.checklist.startsWith(k.lens + '.'), k.kind);
  }
});

test('canary checklist ids and decoy rule ids are checklist items of the built-in AI lenses', () => {
  const items = new Set(BUILTIN.filter(l => l.method === 'ai').flatMap(l => l.checklist.map(c => c.id)));
  for (const k of CANARY_KINDS) assert.ok(items.has(k.checklist), `canary ${k.kind}: ${k.checklist}`);
  for (const t of DECOY_TEMPLATES) assert.ok(items.has(t.rule), `decoy ${t.id}: ${t.rule}`);
});

test('a canary kind is planted only where its lens and checklist item look', () => {
  const at = (state, viewport = 'm') => ({ id: `x.guest.${state}.${viewport}`, route: '/x', person: 'guest', state, viewport });
  assert.equal(kindApplies('blank-state', at('normal'), BUILTIN), false, 'L2 hunts forced states only');
  assert.equal(kindApplies('blank-state', at('error'), BUILTIN), true);
  assert.equal(kindApplies('template-copy', at('error'), BUILTIN), false, 'L7 hunts normal screens only');
  assert.equal(kindApplies('vague-error', at('error'), BUILTIN), true, 'L6 hunts every state');
  assert.equal(kindApplies('verb-swap', at('slow'), BUILTIN), false);
  assert.equal(kindApplies('verb-swap', at('slow'), null), true, 'without lenses every kind applies');
  // a project pack that turns the item off: no canary for it
  const off = BUILTIN.map(l => (l.id === 'L10' ? { ...l, checklist: l.checklist.filter(c => c.id !== 'L10.fixed-covers-content') } : l));
  assert.equal(kindApplies('fixed-cover', at('normal'), off), false);
  assert.equal(kindApplies('fixed-cover', at('normal'), BUILTIN), true);
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
  const twice = [await mutate('trigger.html', ['template-copy']), await mutate('trigger.html', ['template-copy'])];
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
  // with lenses, a scene only gets the kinds hunted there: a slow screen only L2 and L6 kinds
  const slow = entries.filter(e => !e.reason && e.status === 'captured').map(e => ({ ...e, id: e.id.replace('normal', 'slow'), state: 'slow' }));
  const offered = [];
  await plantCanaries({ entries: slow, count: 1, seed, lenses: BUILTIN, tryScene: async (b, ks) => { offered.push(...ks); return null; } });
  assert.ok(offered.length > 0);
  assert.deepEqual([...new Set(offered)].sort(), ['blank-state', 'vague-confirm', 'vague-error']);
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
  { scene: 'a.guest.normal.m.canary-1', of: 'a.guest.normal.m', kind: 'verb-swap', lens: 'L5', checklist: 'L5.same-action-different-verb', selector: 'main > form > button', box: [250, 287, 80, 44] },
  { scene: 'b.guest.error.d.canary-2', of: 'b.guest.error.d', kind: 'vague-error', lens: 'L6', checklist: 'L6.vague-error', selector: 'main > p:nth-of-type(2)', box: [16, 347, 358, 24] },
  { scene: 'c.guest.normal.m.canary-3', of: 'c.guest.normal.m', kind: 'template-copy', lens: 'L7', checklist: 'L7.template-copy', selector: 'main > p', box: [16, 163, 358, 48] },
] };
const ai = (scene, lens, selector, box, rule = 'x') => ({ source: 'ai', status: 'claimed', lens, rule, severity: 'medium', scene, route: '/a', viewport: 'm', selector, box, evidence: {} });

test('canary score: hit by element, ancestor or overlapping box with the right lens; misses listed', () => {
  assert.ok(sameLocation({ selector: 'main > form' }, { selector: 'main > form > button' }), 'ancestor');
  assert.ok(sameLocation({ selector: 'main > form > button > span' }, { selector: 'main > form > button' }), 'descendant');
  assert.ok(!sameLocation({ selector: 'main > form > buttonx' }, { selector: 'main > form > button' }));
  assert.ok(sameLocation({ selector: 'div.x', box: [250, 290, 80, 40] }, { selector: 'main > form > button', box: [250, 287, 80, 44] }), 'same place by box');
  assert.ok(!sameLocation({ selector: 'div.x', box: [0, 0, 80, 40] }, { selector: 'main > form > button', box: [250, 287, 80, 44] }));

  const r = scoreCanaries(CANARIES, [
    ai('a.guest.normal.m.canary-1', 'L5', 'main > form > button', null, 'L5.same-action-different-verb'),
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

// coverage.json as hunt --record writes it: one cell per lens × scene, with its unit and batch
const cell = (lens, scene, unit, batch, status = 'seen') => ({ lens, scene, route: '/b', person: 'guest', state: 'error', viewport: 'd', unit, batch, status, ...(status === 'seen' ? {} : { reason: 'not-answered' }) });
const COVERAGE = { schema: 1, plan: 'p1', run: '0001',
  summary: { cells: 5, seen: 4, notSeen: { 'not-answered': 1 }, units: { total: 4, seen: 3 } },
  cells: [
    cell('L6', 'b.guest.error.d.canary-2', 'u1', 'b1'),
    cell('L6', 'b.guest.error.d', 'u2', 'b1'),
    cell('L6', 'b.guest.error.m', 'u2', 'b1'),
    cell('L6', 'z.guest.error.d', 'u3', 'b2', 'not-seen'),
    cell('L5', 'b.guest.error.d.canary-2', 'u4', 'b3'),
  ] };

test('a missed canary voids seen for its batch in coverage.json', () => {
  const out = voidCoverage(COVERAGE, [{ scene: 'b.guest.error.d.canary-2', lens: 'L6', kind: 'vague-error' }]);
  assert.deepEqual(out.cells.map(c => c.status), ['not-seen', 'not-seen', 'not-seen', 'not-seen', 'seen'], 'the copy and the screens it was copied from, for that lens only');
  assert.deepEqual(out.cells.slice(0, 3).map(c => c.reason), ['canary-missed', 'canary-missed', 'canary-missed']);
  assert.equal(out.cells[3].reason, 'not-answered', 'other not-seen reasons stay');
  assert.deepEqual(out.summary, { cells: 5, seen: 1, notSeen: { 'canary-missed': 3, 'not-answered': 1 }, units: { total: 4, seen: 1 } });
  assert.deepEqual(out.canaries, { missed: [{ scene: 'b.guest.error.d.canary-2', lens: 'L6', kind: 'vague-error' }], voidedUnits: ['u1', 'u2'], voidedBatches: ['b1'] });
  assert.equal(COVERAGE.cells[0].status, 'seen', 'input untouched');
  assert.deepEqual(voidCoverage({}, []).canaries, { missed: [], voidedUnits: [], voidedBatches: [] });
});

test('canary score: a claim without a box (aria node, source only) counts by its checklist item, unless the original has the same claim', () => {
  const aria = (scene, rule) => ({ source: 'ai', status: 'claimed', lens: 'L6', rule, severity: 'medium', scene, route: '/b', viewport: 'd', selector: 'aria=paragraph', box: null, evidence: {} });
  assert.equal(scoreCanaries(CANARIES, [aria('b.guest.error.d.canary-2', 'L6.vague-error')]).results[1].hit, true);
  assert.equal(scoreCanaries(CANARIES, [aria('b.guest.error.d.canary-2', 'L6.unclear-label')]).results[1].hit, false, 'another item: not the planted defect');
  const both = scoreCanaries(CANARIES, [aria('b.guest.error.d.canary-2', 'L6.vague-error'), aria('b.guest.error.d', 'L6.vague-error')]);
  assert.deepEqual(both.ambiguous, [{ scene: 'b.guest.error.d.canary-2', of: 'b.guest.error.d', kind: 'vague-error', lens: 'L6', reason: 'the original has the same claim' }], 'the original has it too: neither hit nor miss');
  assert.equal(both.planted, 2); assert.ok(!both.missed.some(m => m.kind === 'vague-error'), 'and it voids nothing');
  const located = { ...aria('b.guest.error.d.canary-2', 'L6.vague-error'), selector: 'main > h1', box: [0, 0, 10, 10] };
  assert.equal(scoreCanaries(CANARIES, [located]).results[1].hit, false, 'a claim with a place is judged by its place');
});

test('a canary the hunt never saw (budget, not answered) is not hunted: neither planted nor missed', () => {
  const cov = { schema: 1, cells: [
    cell('L5', 'a.guest.normal.m.canary-1', 'u1', 'b1'),
    { ...cell('L6', 'b.guest.error.d.canary-2', 'u2', 'b2', 'not-seen'), reason: 'budget' },
  ] };
  const r = scoreCanaries(CANARIES, [ai('a.guest.normal.m.canary-1', 'L5', 'main > form > button', null)], cov);
  assert.equal(r.planted, 1); assert.equal(r.hit, 1); assert.equal(r.rate, 1);
  assert.deepEqual(r.missed, []);
  assert.deepEqual(r.notHunted.map(n => [n.scene, n.reason]), [['b.guest.error.d.canary-2', 'budget'], ['c.guest.normal.m.canary-3', 'not-planned']]);
  assert.deepEqual(voidCoverage(cov, r.missed).cells.map(c => c.status), ['seen', 'not-seen'], 'nothing voided for a canary nobody hunted');
  // scoring again after a miss voided a batch gives the same result
  const miss = scoreCanaries(CANARIES, [], { cells: [cell('L5', 'a.guest.normal.m.canary-1', 'u1', 'b1')] });
  const voided = voidCoverage({ cells: [cell('L5', 'a.guest.normal.m.canary-1', 'u1', 'b1')] }, miss.missed);
  assert.deepEqual(scoreCanaries(CANARIES, [], voided).missed, miss.missed);
  // without coverage.json every canary counts, as before
  assert.equal(scoreCanaries(CANARIES, []).planted, 3);
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
  // every canary was hunted: its lens saw its copy
  const hunted = { ...COVERAGE, cells: [...COVERAGE.cells, cell('L5', 'a.guest.normal.m.canary-1', 'u5', 'b4'), cell('L7', 'c.guest.normal.m.canary-3', 'u6', 'b5')] };
  writeFileSync(join(run, 'coverage.json'), JSON.stringify(hunted));
  const text = cli(['canaries', '--score']);
  assert.match(text, /canaries hit 1\/3 → AI recall ≤ 33%/);
  assert.match(text, /L5 1\/1 · L6 0\/1 · L7 0\/1/, 'rule findings do not count as AI hits');
  const json = JSON.parse(cli(['canaries', '--score', '--run', '0001', '--json']));
  assert.equal(json.hit, 1);
  assert.deepEqual(json.coverage.voidedUnits, ['u1', 'u2', 'u6'], 'the L6 and L7 canaries were missed');
  assert.equal(JSON.parse(readFileSync(join(run, 'coverage.json'), 'utf8')).cells[0].status, 'not-seen');
  assert.equal(JSON.parse(readFileSync(join(run, 'canary-score.json'), 'utf8')).planted, 3);
});

test('canary blank-state: never where the message is the main area\'s only text (that is the blank-state rule)', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const { r, changed } = await mutate('lonely.html', ['blank-state']);
  assert.equal(r, null);
  assert.equal(changed, false, 'the message is put back');
});

test('canary score: a fixed bar is hit by a claim of its item anywhere on the copy, other kinds stay located', () => {
  const file = { schema: 1, planted: [
    { scene: 't.guest.normal.d.canary-1', of: 't.guest.normal.d', kind: 'fixed-cover', lens: 'L10', checklist: 'L10.fixed-covers-content', selector: 'body > div:nth-of-type(2)', box: [0, 640, 1280, 160] },
    { scene: 'p.guest.error.d.canary-2', of: 'p.guest.error.d', kind: 'vague-error', lens: 'L6', checklist: 'L6.vague-error', selector: 'main > p', box: [16, 200, 900, 24] },
  ] };
  // the hunter cites the footer link the bar hides once the page is scrolled: far below the first-view band
  const footer = ai('t.guest.normal.d.canary-1', 'L10', 'footer > nav > a', [16, 989, 60, 20], 'L10.fixed-covers-content');
  assert.deepEqual(scoreCanaries(file, [footer]).results.map(x => x.hit), [true, false]);
  assert.equal(scoreCanaries(file, [{ ...footer, rule: 'L10.primary-not-in-first-view' }]).results[0].hit, false, 'another item is not the bar');
  const far = ai('p.guest.error.d.canary-2', 'L6', 'footer > p', [16, 900, 300, 20], 'L6.vague-error');
  assert.equal(scoreCanaries(file, [far]).results[1].hit, false, 'a located kind still needs the planted element');
  const shared = scoreCanaries(file, [footer, { ...footer, scene: 't.guest.normal.d' }]);
  assert.deepEqual(shared.ambiguous?.map(x => x.kind), ['fixed-cover'], 'the original has the same claim: ambiguous');
});
