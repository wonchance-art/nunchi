// "Leafy", an invented plant shop for the Coverage and Screens views (M7; the mock-up's synthetic app, made smaller):
// four full checks of the same app (runs 0001–0004), the AI hunt's record of the latest (coverage.json, hunt-plan.json,
// ai-findings.json) with cells the budget cut, a missed canary and units not answered, redirects, screens that did not
// load, a route discover could not resolve, a finding fixed since the previous full check, one not looked at for three
// runs, and a fix attempt's probe runs. Invented content only; the ledger is folded as the CLI would fold it.
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldRun, runForFold, emptyState } from '../../src/ledger.mjs';
import { stableJson } from '../../src/stable.mjs';
import { tmp, scene, writeRun } from './board-project.mjs';

const write = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' ? v : stableJson(v)); };
export const STATES5 = ['normal', 'empty', 'error', 'slow', 'offline'];
// route, page name, whether it loads data (forced states), what happens to whom
export const PAGES = [
  { route: '/', h1: 'Plant shelf', data: false },
  { route: '/garden', h1: 'Garden', data: true },
  { route: '/garden/[plot]', h1: 'Plot 3', data: false },
  { route: '/cart', h1: 'Your cart', data: true },
  { route: '/checkout', h1: 'Checkout', data: true, guestTo: '/login' },
  { route: '/help', h1: 'Help', data: false },
  { route: '/login', h1: 'Sign in', data: false, signedTo: '/account' },
];
export const ORDER = PAGES.map(p => p.route);
// the AI lenses of the built-in packs and the states each looks at (lenses/*.json `scenes`)
export const AI_LENSES = { L1: ['normal'], L2: ['empty', 'error', 'slow', 'offline'], L4: ['normal'], L5: ['normal', 'empty', 'error'], L6: STATES5, L7: ['normal'], L9: ['normal'], L10: ['normal'] };

// The scenes of one run. `offlineFails`: /checkout · Signed in · Offline did not load (runs after the first).
export function leafyScenes({ offlineFails = true, changed = [] } = {}) {
  const out = [];
  for (const pg of PAGES) for (const person of ['guest', 'signed-in']) for (const vp of ['d', 'm']) {
    const to = person === 'guest' ? pg.guestTo : pg.signedTo;
    const states = pg.data && !to ? STATES5 : ['normal'];
    for (const state of states) {
      const extra = { h1: pg.h1, dataRequests: pg.data && !to ? 2 : 0 };
      if (to) Object.assign(extra, { reason: `redirected to ${to}`, redirected: true, finalPath: to });
      if (offlineFails && pg.route === '/checkout' && person === 'signed-in' && state === 'offline') Object.assign(extra, { status: 'capture-failed', reason: 'no-dom', finalPath: null, h1: null });
      if (pg.route === '/' && person === 'guest' && state === 'normal') extra.controls = vp === 'd' ? [{ selector: 'main > a.more', box: [40, 900, 120, 32] }] : [{ selector: 'main > a.more', box: [16, 700, 100, 32] }, { selector: 'nav a', box: [10, 10, 12, 12] }];
      if (pg.route === '/cart' && person === 'signed-in' && state === 'error') extra.controls = [{ selector: 'main p.err', box: vp === 'd' ? [40, 300, 400, 24] : [16, 300, 350, 24] }];
      if (pg.route === '/cart' && person === 'signed-in' && state === 'normal') extra.controls = [{ selector: 'img.hero', box: vp === 'd' ? [40, 200, 600, 300] : [16, 200, 350, 200] }];
      const s = scene(pg.route, person, state, vp, extra);
      const v = changed.includes(s.id) ? 'b' : 'a';
      if (s.status === 'captured') Object.assign(s, { top: `top-${s.id}-${v}`, full: `full-${s.id}-${v}`, textHash: `text-${s.id}-${v}` });
      else Object.assign(s, { top: null, full: null, textHash: null });
      out.push(s);
    }
  }
  return out;
}
const byId = (scenes, id) => scenes.find(s => s.id === id);
const f = (s, rule, severity, selector, evidence, lens) => ({ lens, rule, severity, scene: s.id, route: s.route, viewport: s.viewport, selector, box: null, evidence });

// The rule findings of a run: a raw error on both widths of /cart · Signed in · Error (one group), a dead link on the
// home page (one group, both widths), a small tap target on the phone only; an image that fails on /cart (fixed in
// the latest run); text cut off on /checkout · Signed in · Offline (only the first run saw that screen).
function findingsOf(scenes, n, last) {
  const g = id => byId(scenes, id);
  const list = [
    f(g('cart.signed-in.error.d'), 'raw-error-text', 'high', 'main p.err', { text: 'TypeError: Cannot read properties of undefined' }, 'L6'),
    f(g('cart.signed-in.error.m'), 'raw-error-text', 'high', 'main p.err', { text: 'TypeError: Cannot read properties of undefined' }, 'L6'),
    f(g('~.guest.normal.d'), 'dead-href', 'medium', 'main > a.more', { href: '#' }, 'L7'),
    f(g('~.guest.normal.m'), 'dead-href', 'medium', 'main > a.more', { href: '#' }, 'L7'),
    f(g('~.guest.normal.m'), 'target-size-min', 'low', 'nav a', { width: 12 }, 'L8'),
  ];
  if (n < last) list.push(f(g('cart.signed-in.normal.d'), 'broken-image', 'medium', 'img.hero', { src: '/img/hero.jpg' }, 'L1'));
  if (n === 1) list.push(f(g('checkout.signed-in.offline.d'), 'clipped-text', 'medium', 'h2.total', { text: 'Total to pay' }, 'L1'));
  return list;
}

// coverage.json of a run, as hunt --record and canaries --score leave it.
export function coverageOf(run, scenes, { canary = true } = {}) {
  const cells = [];
  const checked = s => s.status === 'captured' && !s.redirected;
  for (const [lens, states] of Object.entries(AI_LENSES)) for (const s of scenes) {
    if (!states.includes(s.state)) continue;
    const base = { lens, scene: s.id, route: s.route, person: s.person, state: s.state, viewport: s.viewport, unit: `u-${lens}-${s.id.length}`, batch: `b-${lens}-${s.route}` };
    if (s.canary) { cells.push({ ...base, status: 'seen', answers: { defect: 1, none: 2, 'cannot-judge': 0 } }); continue; }
    if (!checked(s)) { cells.push({ lens, scene: s.id, status: 'not-seen', reason: s.redirected ? 'redirected' : s.reason }); continue; }
    let reason = null;
    if (lens === 'L4' && ['/garden', '/help', '/login'].includes(s.route)) reason = 'budget';
    else if (lens === 'L6' && s.route === '/cart' && canary) reason = 'canary-missed';
    else if (lens === 'L7' && s.route === '/help' && s.person === 'guest') reason = 'not-answered';
    if (reason) cells.push({ ...base, status: 'not-seen', reason });
    else cells.push({ ...base, status: 'seen', answers: { defect: 0, none: 3, 'cannot-judge': lens === 'L7' && s.id === 'cart.signed-in.normal.d' ? 1 : 0 } });
  }
  const notSeen = {};
  for (const c of cells) if (c.status !== 'seen') notSeen[c.reason] = (notSeen[c.reason] || 0) + 1;
  return { schema: 1, plan: 'plan0000abcd', run, summary: { cells: cells.length, seen: cells.filter(c => c.status === 'seen').length, notSeen, units: { total: 90, seen: 80 } }, cells };
}
export const PLAN = { schema: 1, id: 'plan0000abcd', budget: 400000, budgetDefault: true, estimate: { total: 469500, planned: 400000, cut: 69500 },
  lenses: Object.keys(AI_LENSES).map(id => ({ id })), skippedLenses: [], units: [], notSeen: [] };

// The pages a quick first look of Leafy captures (M5: its key screens, the normal state only).
export const QUICK = ['/', '/garden', '/cart'];

// The project. `ai`: 'latest' (the hunt recorded on the last full check), 'older' (on run 0003 only), 'none';
// `probes`: a fix attempt of the raw error with its probe runs (and a second whose probes were removed); `quick`: a
// quick first look after the full checks, the latest capture (M5; not with `probes`, which take the same run ids).
export function leafy({ ai = 'latest', runs = 4, probes = true, quick = false, prefix = 'nunchi-m7-' } = {}) {
  if (quick && probes) throw new Error('leafy: a quick run and the fix probes would take the same run ids');
  const root = tmp(prefix);
  const nunchi = join(root, '.nunchi');
  const runIds = Array.from({ length: runs }, (_, i) => String(i + 1).padStart(4, '0'));
  let state = emptyState();
  let latest = null;
  for (const [i, id] of runIds.entries()) {
    const n = i + 1;
    const scenes = leafyScenes({ offlineFails: n > 1, changed: n === runs ? ['cart.signed-in.error.d', 'cart.signed-in.error.m', '~.guest.normal.d'] : [] });
    const { run } = writeRun(root, id, { scenes, findings: findingsOf(scenes, n, runs), parent: i ? runIds[i - 1] : null });
    write(join(run, 'run.json'), { schema: 1, id, parent: i ? runIds[i - 1] : null, kind: 'sweep', commit: null, dirty: null, wholeApp: true, health: { status: 'ok', problems: [] },
      scope: { routes: [...ORDER].sort(), persons: ['guest', 'signed-in'], viewports: ['d', 'm'], states: STATES5, changedSince: null }, unresolved: ['profile/edit'] });
    write(join(run, 'flow.json'), { schema: 1, complete: true, wholeApp: true, entry: '/', order: ORDER,
      groups: [{ id: '/', routes: ['/', '/cart', '/checkout', '/help', '/login'] }, { id: '/garden', routes: ['/garden', '/garden/[plot]'] }],
      nodes: [...ORDER].sort().map(r => ({ route: r, captured: true, reachedBy: r === '/' ? 'entry' : 'link' })), edges: [] });
    state = foldRun(state, { ...runForFold(run), stream: 'main' });
    latest = { id, run, scenes };
  }
  // a quick first look after them (M5, design §6): the normal screens of three key pages, rule lenses only, folded
  // as `quick`; its flow names every route, captured or not, as capture writes it
  if (quick) {
    const id = String(runs + 1).padStart(4, '0');
    const scenes = leafyScenes().filter(s => QUICK.includes(s.route) && s.state === 'normal');
    const { run } = writeRun(root, id, { scenes, findings: findingsOf(leafyScenes(), runs, runs).filter(x => scenes.some(s => s.id === x.scene)), parent: runIds[runs - 1], wholeApp: false });
    write(join(run, 'run.json'), { schema: 1, id, parent: runIds[runs - 1], kind: 'quick', commit: null, dirty: null, wholeApp: false, health: { status: 'ok', problems: [] },
      scope: { routes: [...QUICK].sort(), persons: ['guest', 'signed-in'], viewports: ['d', 'm'], states: ['normal'], changedSince: null }, skipped: [], unresolved: ['profile/edit'] });
    write(join(run, 'flow.json'), { schema: 1, complete: true, wholeApp: false, entry: '/', order: QUICK, groups: [{ id: '/', routes: ['/', '/cart'] }, { id: '/garden', routes: ['/garden'] }],
      nodes: [...ORDER].sort().map(r => ({ route: r, captured: QUICK.includes(r), reachedBy: r === '/' ? 'entry' : 'link' })), edges: [] });
    state = foldRun(state, { ...runForFold(run), stream: 'main' });
  }
  // the AI hunt: a canary copy of /cart in the manifest (never shown, never counted), its record and plan
  const huntOn = ai === 'older' ? runIds[runs - 2] : runIds[runs - 1];
  if (ai !== 'none') {
    const dir = join(nunchi, 'runs', huntOn);
    const scenes = leafyScenes({ offlineFails: true, changed: huntOn === runIds[runs - 1] ? ['cart.signed-in.error.d', 'cart.signed-in.error.m', '~.guest.normal.d'] : [] });
    const copy = { ...scene('/cart', 'guest', 'normal', 'd', { h1: 'Your cart' }), id: 'cart.guest.normal.d.canary-1', canary: { kind: 'lorem', of: 'cart.guest.normal.d' } };
    const manifest = JSON.parse(JSON.stringify(require_(join(dir, 'manifest.json'))));
    manifest.scenes.push(copy);
    write(join(dir, 'manifest.json'), manifest);
    write(join(dir, copy.id, 'measure.json'), { h1: 'Your cart' });
    write(join(dir, 'coverage.json'), coverageOf(huntOn, [...scenes, copy]));
    write(join(dir, 'hunt-plan.json'), PLAN);
    // its claims (the ledger folds them from these files, as after hunt --record): one on the home page's "more" link,
    // the same box as the dead link there, and one on the cart
    write(join(dir, 'ai-findings.json'), { schema: 1, plan: PLAN.id, rejected: [], findings: [
      { source: 'ai', lens: 'L5', rule: 'L5.inconsistent-term', scene: '~.guest.normal.d', route: '/', viewport: 'd', selector: 'main > a.more', box: [40, 900, 120, 32], severity: 'medium', evidence: { claim: 'Two words for one thing' } },
      { source: 'ai', lens: 'L5', rule: 'L5.inconsistent-term', scene: 'cart.signed-in.normal.d', route: '/cart', viewport: 'd', selector: 'img.hero', box: [40, 200, 600, 300], severity: 'medium', evidence: { claim: 'Basket and cart for one thing' } },
    ] });
  }
  mkdirSync(join(nunchi, 'state'), { recursive: true });
  writeFileSync(join(nunchi, 'state', 'ledger.json'), stableJson(state));
  // a fix attempt of the raw error: its probes P0 and P1 (fix-probe runs, folded by nobody), and a second attempt whose
  // probes nunchi gc removed
  if (probes) {
    const rawGroup = Object.values(state.items).find(x => x.rule === 'raw-error-text')?.group;
    const pick = latest.scenes.filter(s => s.route === '/cart' && s.person === 'signed-in' && s.state === 'error');
    const p0 = String(runs + 1).padStart(4, '0'), p1 = String(runs + 2).padStart(4, '0');
    for (const id of [p0, p1]) {
      const { run } = writeRun(root, id, { scenes: pick.map(s => ({ ...s, top: `${s.top}-${id}`, full: `${s.full}-${id}` })), findings: [] });
      write(join(run, 'run.json'), { schema: 1, id, kind: 'fix-probe', fixBranch: 'nunchi/fixes-1015', wholeApp: false, health: { status: 'ok', problems: [] }, scope: { routes: ['/cart'], persons: ['signed-in'], viewports: ['d', 'm'], states: ['error'], changedSince: null } });
    }
    write(join(nunchi, 'runs', 'latest'), `${latest.id}\n`);
    const dir = join(nunchi, 'state', 'fixes', rawGroup);
    write(join(dir, '1.json'), { schema: 1, group: rawGroup, attempt: 1, try: 1, phase: 'reverted', rev: 3, p0: { run: p0 }, p1: { run: p1 }, outcome: { revert: 'abcdef1234567', verdict: { outcome: 'not-fixed' } } });
    write(join(dir, '2.json'), { schema: 1, group: rawGroup, attempt: 2, try: 2, phase: 'reverted', rev: 3, p0: { run: '0099' }, p1: { run: '0100' }, outcome: { verdict: { outcome: 'not-fixed' } } });
  }
  return { root, nunchi, runs: runIds, latest: latest.id, huntOn: ai === 'none' ? null : huntOn };
}
// A JSON file, read (fixtures only).
function require_(p) { return JSON.parse(readFileSync(p, 'utf8')); }
export const drop = (p, ...files) => { for (const x of files) rmSync(join(p.nunchi, 'runs', ...x.split('/')), { force: true, recursive: true }); };
