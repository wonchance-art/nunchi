// The Coverage view's model (M7; the mock-up the owner approved on 2026-10-15 KST, §3): what nunchi looked at in the
// run Progress's verdict rests on (the last full check, else the latest capture), and what it didn't. Only what the
// engine already wrote: the run's manifest (screens and why one was not checked), run.json (scope, full check, routes
// discover could not resolve), flow.json (pages and their order), coverage.json and hunt-plan.json (the AI hunt's cells
// and budget), the loaded lens packs (which AI lenses apply to a screen), the ledger (which run the AI reviewed,
// findings not looked at since). Nothing is captured or judged here.
//
// AI cells count only on checked screens (decision D2): a screen that did not load is counted once, under Screens
// checked, never again as missing AI cells. Strings from the app (routes, page names) go out through safe(), as
// everywhere on the board.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { listRuns } from '../runs.mjs';
import { byRun } from '../ledger.mjs';
import { redactUrl } from '../network.mjs';
// the hunt's own order of spending and its rule for which screens a lens looks at; the summary's checked screen (the
// verdict's): imported, so the board cannot drift from them
import { SPEND_ORDER, matches } from '../hunt.mjs';
import { checkedScene } from '../summary.mjs';
import { safe, RUN_ID } from './model.mjs';
import {
  PERSONS, VPS, STATES, WHO, WIDTH, STATE_LABEL, COVERAGE as C, MARKS, plural, listText, andList, thousands, lensLabel, lensNumber,
  notCheckedText, aiReasonText, coverageMark,
} from './shared.mjs';

export { checkedScene };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const readJson = p => { try { return { doc: JSON.parse(readFileSync(p, 'utf8')) }; } catch (e) { return e?.code === 'ENOENT' ? null : { error: true }; } };
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// a path as the board says it: no query or fragment (they can carry tokens and say nothing about the page)
const pathOf = p => String(p || '').split(/[?#]/)[0];
// What the rule checks of each lens look at (rules.mjs, capture.mjs, flow.mjs, system.mjs; ledger.mjs WHOLE_APP):
// `screens` per screen, `pairs` also compare a screen's states, `flow` the link graph between pages, `system` the
// design system measured over every screen, `bundle` also the browser bundle (secrets), `parity` desktop against phone
// per page and person, null: no rule check (the AI only). test/board-coverage.test.mjs pins it against the engine.
export const RULE_CHECKS = { L1: 'screens', L2: 'pairs', L3: 'flow', L4: 'system', L5: null, L6: 'screens', L7: 'screens', L8: 'screens', L9: 'bundle', L10: 'parity' };
const kindOf = meta => (meta?.kind === 'quick' ? 'quick' : meta?.kind === 'fix-probe' ? 'fix-probe' : 'sweep');
// A quick first look (M5, design §6: some key screens, the normal state, rule lenses only): the AI review hunts a full
// check, never one of these (`hunt` refuses it), so no AI cell of another run is put on its screens, and the gaps the
// full check after it settles (states, pages not opened, the AI review) are not listed for it.
export const isQuick = (model, run = model.latest) => !!run && kindOf(model.evidenceOf(run)?.meta) === 'quick';
// The run Coverage shows (review of PR #35): the one Progress's verdict rests on, the last full check, when there is
// one, so a newer partial run (capture --routes) or first look never hides the full check's gaps (the view notes it);
// else the latest capture.
export function shownRun(model) {
  const f = model.summary?.fullCheck;
  if (f && RUN_ID.test(String(f)) && model.evidenceOf(String(f))?.scenes?.length) return String(f);
  return model.latest;
}

// Every AI cell of the run the AI reviewed, for the screens of `run`. `src.run` is that run (`run` itself, an older one,
// or null); `error`: its coverage.json could not be read.
export function aiSource(model, run = shownRun(model)) {
  model._aiSources ||= new Map();
  if (model._aiSources.has(run)) return model._aiSources.get(run);
  const runsDir = model.led.st.runsDir, stream = model.led.st.root.stream;
  const folds = (Array.isArray(model.led.state.folds) ? model.led.state.folds : [])
    .filter(f => f && f.source === 'ai' && (f.stream ?? 'main') === stream && RUN_ID.test(String(f.run))).map(f => String(f.run));
  const aiRuns = [...new Set(folds)].sort(byRun);
  const complete = new Set(listRuns(runsDir).complete);
  const out = { run: null, latest: false, older: false, error: false, cells: [], last: null, plan: null };
  const done = () => { model._aiSources.set(run, out); return out; };
  if (!run || isQuick(model, run)) return done();
  const take = r => {
    const doc = readJson(join(runsDir, r, 'coverage.json'));
    if (!doc) return false;
    out.run = r; out.latest = r === run; out.older = r !== run;
    if (doc.error || !Array.isArray(doc.doc?.cells)) { out.error = true; return true; }
    out.cells = doc.doc.cells.filter(isObj);
    const plan = readJson(join(runsDir, r, 'hunt-plan.json'));
    // the plan beside the record, only when it is the plan that record answers (a newer --plan replaces it)
    if (plan?.doc && plan.doc.id === doc.doc.plan) out.plan = plan.doc;
    return true;
  };
  if (complete.has(run) && take(run)) return done();
  if (aiRuns.includes(run)) { out.run = run; out.latest = true; out.error = true; return done(); }
  const older = aiRuns.filter(r => byRun(r, run) < 0 && complete.has(r));
  for (const r of older.reverse()) if (take(r)) return done();
  out.last = aiRuns.length ? aiRuns[aiRuns.length - 1] : null;
  return done();
}

// A run's scenes with what the board needs to judge them, and the AI cells by scene id.
function context(model, run) {
  model._covCtx ||= new Map();
  if (model._covCtx.has(run)) return model._covCtx.get(run);
  const ev = run ? model.evidenceOf(run) : null;
  const src = aiSource(model, run);
  const runsDir = model.led.st.runsDir;
  const scenes = ev ? ev.scenes : [];
  const rawOf = e => new Map((Array.isArray(e?.manifest?.scenes) ? e.manifest.scenes : []).filter(s => s && typeof s.id === 'string' && s.canary === undefined).map(s => [s.id, s]));
  const raw = rawOf(ev);
  // the AI run's own manifest (the same scene ids, another run): its canary copies and checked screens
  const aiRaw = src.run && src.older ? rawOf(model.evidenceOf(src.run)) : raw;
  const cellsBy = new Map();
  for (const c of src.cells) {
    if (typeof c.scene !== 'string' || typeof c.lens !== 'string') continue;
    const rs = aiRaw.get(c.scene);
    if (!rs || !checkedScene(rs)) continue;                       // canary copies and screens that were not checked
    if (!cellsBy.has(c.scene)) cellsBy.set(c.scene, new Map());
    if (!cellsBy.get(c.scene).has(c.lens)) cellsBy.get(c.scene).set(c.lens, c);
  }
  // AI findings by scene and lens (what "Looked · 1 finding" counts)
  const found = new Map();
  if (src.run && !src.error) {
    const af = readJson(join(runsDir, src.run, 'ai-findings.json'))?.doc?.findings;
    for (const f of Array.isArray(af) ? af : []) if (isObj(f) && typeof f.scene === 'string' && typeof f.lens === 'string') found.set(`${f.scene}|${f.lens}`, (found.get(`${f.scene}|${f.lens}`) || 0) + 1);
  }
  // open findings by scene (this run's, as the wall shows them)
  const openBy = new Map();
  for (const g of model.groups) {
    if (!g.active) continue;
    const seen = new Set();
    for (const f of g._inst) {
      if (f.run !== ev?.runId || !f.scene || seen.has(f.scene)) continue;
      seen.add(f.scene);
      if (!openBy.has(f.scene)) openBy.set(f.scene, {});
      openBy.get(f.scene)[g.severity] = (openBy.get(f.scene)[g.severity] || 0) + 1;
    }
  }
  // the AI lenses loaded now (the board's lens table): a screen's AI cells are every one whose pack's `scenes` match it
  // (hunt.mjs `matches`), so a hunt of some lenses never reads as a full look (review of PR #35)
  const aiLenses = Object.values(model.lenses || {}).filter(l => isObj(l) && l.method === 'ai' && /^L\d+$/.test(String(l.id)));
  const cx = { run, ev, src, scenes, raw, aiRaw, cellsBy, found, openBy, quick: isQuick(model, run), aiLenses };
  model._covCtx.set(run, cx);
  return cx;
}

const lensName = (model, id) => lensLabel(id, model.lenses?.[id]?.name);
const lensOrder = (a, b) => lensNumber(a) - lensNumber(b) || cmp(a, b);

// One scene's AI cells: seen of applicable, and each lens with its reason in the board's words. Applicable: the lenses
// the hunt recorded a cell for, and the loaded AI lenses whose `scenes` match the screen (one the hunt left out is
// "Not checked: not in this hunt").
function aiOf(model, cx, s) {
  if (!cx.src.run || cx.src.error) return null;
  const have = cx.cellsBy.get(s.id) || new Map();
  const ids = [...new Set([...have.keys(), ...cx.aiLenses.filter(l => matches(l.scenes, s)).map(l => String(l.id))])].sort(lensOrder);
  const zero = { defect: 0, none: 0, 'cannot-judge': 0 };
  const lenses = ids.map(id => {
    const c = have.get(id);
    if (!c) return { lens: safe(id, 12), name: safe(lensName(model, id), 80), status: 'not-seen', reason: 'not-hunted', answers: zero, findings: 0, text: aiReasonText('not-hunted') };
    const seen = c.status === 'seen';
    const a = isObj(c.answers) ? c.answers : {};
    const reason = seen ? null : String(c.reason || 'not-answered');
    const findings = cx.found.get(`${s.id}|${c.lens}`) || 0;
    const text = seen ? C.lookedText(findings, Number(a['cannot-judge']) || 0)
      : reason === 'canary-missed' ? `${aiReasonText(reason)} on ${safe(s.route, 200)}` : aiReasonText(reason);
    return { lens: safe(c.lens, 12), name: safe(lensName(model, c.lens), 80), status: seen ? 'seen' : 'not-seen', reason: reason ? safe(reason, 40) : null,
      answers: { defect: Number(a.defect) || 0, none: Number(a.none) || 0, 'cannot-judge': Number(a['cannot-judge']) || 0 }, findings, text: safe(text, 300) };
  });
  return { run: cx.src.run, seen: lenses.filter(l => l.status === 'seen').length, of: lenses.length, lenses };
}

// The sentence a cell's panel offers (the cell's first gap), or null.
function sayOf(cell, s, quick = false) {
  if (!cell.checked) {
    if (s.redirected || s.reason === 'redirected-off-origin') return null;
    return s.reason === 'login-expired' ? { say: C.say.again, sentence: C.loginThen } : { say: C.say.again, sentence: C.startThen };
  }
  if (!cell.ai) return quick ? null : { say: C.say.run, sentence: C.tell(C.say.run) };
  const by = r => cell.ai.lenses.find(l => l.reason === r);
  const canary = by('canary-missed');
  if (canary) { const say = C.say.hunt(canary.lens, cell.route); return { say, sentence: C.tell(say) }; }
  if (by('budget')) return { say: C.say.budget, sentence: C.tell(C.say.budget) };
  if (by('not-answered') || by('incomplete')) return { say: C.say.finish, sentence: C.tell(C.say.finish) };
  if (by('not-hunted')) return { say: C.say.every, sentence: C.tell(C.say.every) };
  return null;
}

// One map cell (a scene of its run) as /api/coverage and the Screen detail give it.
export function cellOf(model, s) {
  const cx = context(model, s.run);
  const checked = checkedScene(s);
  const route = safe(s.route, 200);
  const cell = {
    key: s.key, id: safe(s.id, 200), route, person: s.person, viewport: s.viewport, state: s.state, checked,
    why: checked ? null : safe(notCheckedText({ ...s, finalPath: s.finalPath ? redactUrl(pathOf(s.finalPath)) : null }), 300),
    ai: checked ? aiOf(model, cx, s) : null,
    open: cx.openBy.get(s.id) || {},
  };
  // the AI looked at an older run: did this screen change since? (its pixels or text)
  if (cell.ai && cx.src.older) {
    const a = cx.aiRaw.get(s.id), b = cx.raw.get(s.id);
    cell.changed = !!(a && b && (a.top !== b.top || a.full !== b.full || a.textHash !== b.textHash));
  }
  cell.say = sayOf(cell, s, cx.quick);
  return cell;
}

// Where a set of screens is, for a gap row: "/checkout · Signed in · Offline" (widths folded), up to 3.
const whereOf = list => listText([...new Set(list.map(s => `${s.route} · ${WHO[s.person] || s.person} · ${STATE_LABEL[s.state] || s.state}`))].map(x => safe(x, 200)), 3);
const commonState = list => { const st = [...new Set(list.map(s => s.state))]; return st.length === 1 ? st[0] : 'all'; };
const commonLens = lenses => (lenses.length === 1 ? lenses[0] : 'all');

// /api/coverage (mock-up §3.7): totals, the gaps with what to do, the map's rows and cells, the lens table.
// Why a run is not a full check, in the mock-up's words ("Not a full check: <why>").
const whyNotFull = (meta, { appDown = false, needsSample = 0 } = {}) => (kindOf(meta) === 'quick' ? 'a first look' : appDown ? 'most screens didn’t load'
  : needsSample ? `${needsSample === 1 ? 'a page needs' : 'pages need'} a sample address`
    : meta?.scope?.changedSince ? `only pages changed since ${safe(meta.scope.changedSince, 80)}` : 'only the pages asked for');
const problemsOf = ev => (Array.isArray(ev?.manifest?.health?.problems) ? ev.manifest.health.problems : []).filter(isObj)
  .map(p => ({ status: String(p.status), scenes: Number(p.scenes) || 0, of: Number(p.of) || 0 }));

export function coverageView(model) {
  if (model._coverage) return model._coverage;
  const sum = model.summary;
  const runsDir = model.led.st.runsDir;
  const run = shownRun(model);
  const cx = context(model, run);
  const { ev, src, scenes } = cx;
  if (!ev || !run || !model.latest) return (model._coverage = { run: null });
  const meta = isObj(ev.meta) ? ev.meta : {};
  const scope = isObj(meta.scope) ? meta.scope : {};
  const flow = readJson(join(runsDir, run, 'flow.json'))?.doc || {};
  const problems = problemsOf(ev);
  const kind = kindOf(meta);
  const persons = PERSONS.filter(p => (Array.isArray(scope.persons) ? scope.persons : scenes.map(s => s.person)).includes(p));
  const vps = VPS.filter(v => (Array.isArray(scope.viewports) ? scope.viewports : scenes.map(s => s.viewport)).includes(v));
  const states = STATES.filter(x => (Array.isArray(scope.states) ? scope.states : scenes.map(s => s.state)).includes(x));
  const cells = new Map(scenes.map(s => [s.id, cellOf(model, s)]));
  const checked = scenes.filter(checkedScene);
  const unresolved = (Array.isArray(meta.unresolved) ? meta.unresolved : []).filter(r => typeof r === 'string').sort();
  const nodes = (Array.isArray(flow.nodes) ? flow.nodes : []).filter(n => isObj(n) && typeof n.route === 'string');
  const sceneRoutes = new Set(scenes.map(s => s.route));
  const hasParam = r => /\[|:/.test(r);
  const quickLook = kind === 'quick';
  const needsSample = scope.changedSince || quickLook ? [] : nodes.filter(n => !n.captured && !sceneRoutes.has(n.route) && hasParam(n.route) && !unresolved.includes(n.route)).map(n => n.route).sort();
  // pages: the routes discover resolved (flow.json nodes) and those it could not (run.json unresolved)
  const pages = nodes.length ? { opened: nodes.filter(n => n.captured).length, total: nodes.length + unresolved.length }
    : { opened: new Set(checked.filter(s => s.state === 'normal').map(s => s.route)).size, total: sceneRoutes.size + unresolved.length };
  const appDown = problems.some(p => p.status === 'app-unreachable');
  const fullCheck = meta.wholeApp === true && kind === 'sweep';
  const notFullWhy = whyNotFull(meta, { appDown, needsSample: needsSample.length });
  const wholeLine = meta.wholeApp === true && !appDown && kind === 'sweep' ? C.wholeRan : C.wholeNot(notFullWhy);

  // AI totals, on checked screens only (D2)
  const aiCells = checked.flatMap(s => cells.get(s.id).ai?.lenses.map(l => ({ ...l, scene: s })) || []);
  const aiTotals = src.run && !src.error ? { seen: aiCells.filter(l => l.status === 'seen').length, of: aiCells.length } : null;
  const loaded = Object.values(model.lenses || {}).filter(l => l && l.method === 'ai').map(l => String(l.id)).sort(lensOrder);
  const hunted = src.plan && Array.isArray(src.plan.lenses) ? src.plan.lenses.map(l => String(l?.id)).filter(Boolean).sort(lensOrder) : [...new Set(src.cells.map(c => String(c.lens)))].sort(lensOrder);
  const planBudget = src.plan ? (Number.isFinite(src.plan.budget) ? src.plan.budget : null) : undefined;
  const aiLine = !src.run ? null : src.error ? C.aiUnreadable(src.run)
    : src.older ? `${C.aiOlder(src.run).replace(/^AI review: /, '')}. ${C.aiOlderMore(src.run)}`
      : planBudget === undefined ? `run ${src.run} · ${plural(hunted.length, 'lens', 'lenses')}` : C.aiLine(src.run, hunted.length, planBudget, !!src.plan.budgetDefault);

  // ---- gaps (§3.3), in the order the mock-up gives ------------------------------------------------------------------
  const gaps = [], fine = [], muted = [], warnings = [];
  const push = (list, g) => { const n = list.filter(x => x.kind === g.kind).length; list.push({ id: `${g.kind}-${n}`, where: null, why: null, say: null, sentence: null, show: null, findings: null, ...g }); };
  const sentence = (say, lead = null) => ({ say, sentence: lead || C.tell(say) });
  const showOf = (list, checks = 'all') => ({ state: commonState(list), checks, cells: list.map(s => s.key) });
  const blind = model.led.state.blind?.[run];
  if (blind) warnings.push(`This run could not tell what was fixed (${safe(blind, 40)}). Nothing was marked fixed by it.`);
  if (src.error) warnings.push(C.aiUnreadable(src.run));
  // run problems
  for (const p of problems) {
    const word = C.gap.problem[p.status];
    if (!word) continue;
    const hit = p.status === 'login-expired' ? scenes.filter(s => s.reason === 'login-expired') : p.status === 'app-unreachable' ? scenes.filter(s => s.reason === 'no-dom' || s.reason === 'browser-error-page') : [];
    push(gaps, { kind: 'problem', mark: MARKS.not.sym, line: word,
      ...(p.status === 'login-expired' ? sentence(C.say.again, C.loginThen) : p.status === 'app-unreachable' ? sentence(C.say.again, C.startThen) : sentence(C.say.record)),
      show: hit.length ? showOf(hit) : null });
  }
  // screens that did not load (redirects and screens that left the app are "usually fine", below)
  const covered = new Set([...(problems.some(p => p.status === 'login-expired') ? ['login-expired'] : []), ...(appDown ? ['no-dom', 'browser-error-page'] : [])]);
  const failed = scenes.filter(s => s.status !== 'captured' && s.reason !== 'redirected-off-origin' && !covered.has(String(s.reason || s.status)));
  const REASONS = ['no-dom', 'browser-error-page', 'redirect-loop', 'login-expired'];
  const byReason = new Map();
  for (const s of failed) { const k = String(s.reason || s.status || 'unknown'); if (!byReason.has(k)) byReason.set(k, []); byReason.get(k).push(s); }
  for (const k of [...byReason.keys()].sort((a, b) => rank(REASONS, a) - rank(REASONS, b) || cmp(a, b))) {
    const list = byReason.get(k);
    const why = k === 'no-dom' ? null : C.short(notCheckedText({ status: 'capture-failed', reason: k }));
    push(gaps, { kind: 'not-loaded', mark: MARKS.not.sym, line: C.gap.notLoaded(list.length, why ? safe(why, 120) : null), where: whereOf(list),
      ...sentence(C.say.again, k === 'login-expired' ? C.loginThen : C.startThen), show: showOf(list) });
  }
  // the AI review
  if (!src.run && checked.length && !quickLook) {
    push(gaps, { kind: 'ai-not-run', mark: MARKS.rules.sym, line: `${C.aiNotRun(run)}${src.last ? ` (last: run ${src.last})` : ''}`, ...sentence(C.say.run) });
  } else if (src.older) {
    push(gaps, { kind: 'ai-not-run', mark: MARKS.rules.sym, line: `${C.aiNotRun(run)} (last: run ${src.run})`, ...sentence(C.say.run) });
  }
  if (src.run && !src.error && loaded.length && hunted.length && hunted.length < loaded.length && hunted.every(l => loaded.includes(l))) {
    const out = aiCells.filter(l => l.reason === 'not-hunted');
    push(gaps, { kind: 'lens-subset', mark: MARKS.partly.sym, line: C.lensSubset(andList(hunted)), ...sentence(C.say.every),
      show: out.length ? showOf(out.map(l => l.scene), commonLens([...new Set(out.map(l => l.lens))])) : null });
  }
  const notSeen = reason => aiCells.filter(l => l.status !== 'seen' && l.reason === reason);
  const lensRoutes = list => {
    const ls = [...new Set(list.map(l => l.lens))].sort(lensOrder);
    const rs = [...new Set(list.map(l => l.scene.route))];
    return { ls, rs, where: `${ls.map(l => safe(lensName(model, l), 80)).join(', ')} · ${rs.length === 1 ? safe(rs[0], 200) : C.gap.pagesWhere(rs.length)}` };
  };
  // AI cells that don't count (a missed canary voids its batch: one lens on one route)
  const canary = notSeen('canary-missed');
  const batches = new Map();
  for (const l of canary) { const k = `${l.lens}\0${l.scene.route}`; if (!batches.has(k)) batches.set(k, []); batches.get(k).push(l); }
  const routeOrder = scenes.map(s => s.route).filter((r, i, a) => a.indexOf(r) === i);
  for (const k of [...batches.keys()].sort((a, b) => { const [la, ra] = a.split('\0'), [lb, rb] = b.split('\0'); return lensOrder(la, lb) || rank(routeOrder, ra) - rank(routeOrder, rb); })) {
    const list = batches.get(k);
    const [lens, route] = k.split('\0');
    push(gaps, { kind: 'canary', mark: MARKS.partly.sym, line: C.gap.canary(list.length), where: `${safe(lensName(model, lens), 80)} · ${safe(route, 200)}`,
      ...sentence(safe(C.say.hunt(lens, route), 300)), show: showOf(list.map(l => l.scene), lens) });
  }
  // the budget
  const budget = notSeen('budget');
  if (budget.length) {
    const { ls, where } = lensRoutes(budget);
    const cut = src.plan?.estimate && Number.isFinite(src.plan.estimate.cut) ? src.plan.estimate.cut : null;
    const last = ls.slice().sort((a, b) => rank(SPEND_ORDER, a) - rank(SPEND_ORDER, b) || lensOrder(a, b));
    push(gaps, { kind: 'budget', mark: MARKS.partly.sym, line: C.gap.budget(budget.length), where,
      why: cut ? C.budgetMore(last, thousands(Math.max(1000, Math.round(cut / 1000) * 1000))) : null, ...sentence(C.say.budget), show: showOf(budget.map(l => l.scene), commonLens(ls)) });
  }
  for (const [reason, line] of [['not-answered', C.gap.notAnswered], ['incomplete', C.gap.incomplete]]) {
    const list = notSeen(reason);
    if (!list.length) continue;
    const { ls, where } = lensRoutes(list);
    push(gaps, { kind: reason, mark: MARKS.partly.sym, line: line(list.length), where, ...sentence(C.say.finish), show: showOf(list.map(l => l.scene), commonLens(ls)) });
  }
  // pages not opened
  if (needsSample.length) {
    const routes = listText(needsSample.map(r => safe(r, 200)), 5);
    push(gaps, { kind: 'needs-sample', mark: MARKS.not.sym, line: C.gap.pages(needsSample.length, routes, C.gap.needsSampleWhy), ...sentence(safe(C.say.sample(needsSample.slice(0, 5)), 400)) });
  }
  if (unresolved.length && !quickLook) {
    const routes = listText(unresolved.map(r => safe(r, 200)), 5);
    push(gaps, { kind: 'unresolved', mark: MARKS.not.sym, line: C.gap.pages(unresolved.length, routes, C.gap.unresolvedWhy), ...sentence(safe(C.say.routeToo(unresolved.slice(0, 5)), 400)) });
  }
  // not a full check (by --routes or --changed-since: the other causes have rows of their own)
  if (meta.wholeApp !== true && kind === 'sweep' && !needsSample.length && !appDown) {
    push(gaps, { kind: 'not-full', mark: '!', line: C.wholeNot(notFullWhy), ...sentence(C.say.again) });
  }
  // states not in scope
  if (!quickLook && Array.isArray(scope.states) && scope.states.length && STATES.some(x => !scope.states.includes(x))) {
    push(gaps, { kind: 'states', mark: MARKS.none.sym, line: C.gap.states(andList(states.map(x => STATE_LABEL[x]))), ...sentence(C.say.states) });
  }
  // open findings that cannot be marked fixed
  const stale = model.groups.filter(g => g.active && g.notLookedAt).sort((a, b) => byRun(a.notLookedAt, b.notLookedAt) || a.order - b.order);
  const byRunNL = new Map();
  for (const g of stale) { if (!byRunNL.has(g.notLookedAt)) byRunNL.set(g.notLookedAt, []); byRunNL.get(g.notLookedAt).push(g); }
  for (const [since, list] of byRunNL) {
    push(gaps, { kind: 'not-looked', mark: '!', line: C.notLooked(list.length, since),
      findings: list.slice(0, 5).map(g => {
        const f = g._inst.find(x => x.scene) || null;
        const s = f ? model.evidenceOf(f.run).sceneById.get(f.scene) : null;
        const where = s ? `${s.route} · ${WHO[s.person] || s.person} · ${STATE_LABEL[s.state] || s.state}` : g.where.routes[0] || g.where.whole || '';
        return { group: g.id, text: safe(C.gap.wasOn(g.headline, safe(where, 200)), 400) };
      }), more: Math.max(0, list.length - 5) });
  }
  // usually fine: redirects inside the app, and screens that left it
  const redirected = scenes.filter(s => s.status === 'captured' && s.redirected);
  if (redirected.length) {
    const parts = new Map();
    for (const s of redirected) { const k = `${s.person}\0${redactUrl(pathOf(s.finalPath) || '?')}`; if (!parts.has(k)) parts.set(k, []); if (!parts.get(k).includes(s.route)) parts.get(k).push(s.route); }
    const where = [...parts].sort((a, b) => rank(PERSONS, a[0].split('\0')[0]) - rank(PERSONS, b[0].split('\0')[0]) || cmp(a[0], b[0]))
      .map(([k, rs]) => { const [p, to] = k.split('\0'); return `${WHO[p] || p} on ${listText(rs, 4)} → ${to}`; }).join(' · ');
    push(fine, { kind: 'redirects', mark: '↪', line: C.gap.redirects(redirected.length), where: safe(where, 600), show: showOf(redirected) });
  }
  const left = scenes.filter(s => s.reason === 'redirected-off-origin');
  if (left.length) {
    push(fine, { kind: 'left', mark: '↪', line: safe(C.gap.offOrigin(left.length, listText([...new Set(left.map(s => s.finalOrigin || 'another site'))].sort(), 3)), 300), where: whereOf(left), show: showOf(left) });
  }
  if (persons.length && !persons.includes('signed-in')) muted.push({ id: 'no-login-0', kind: 'no-login', line: C.gap.noLogin, hint: C.gap.loginHint, copy: C.gap.loginCmd });

  // ---- the map's rows: pages in the wall's order (flow.json), then the pages that were not opened -------------------
  // a page is named by its own checked screens; one sent elsewhere shows another page's heading, so it is the route
  const nameOf = route => { const mine = scenes.filter(s => s.route === route && s.h1 && checkedScene(s)); const n = mine.find(s => s.state === 'normal') || mine[0]; return n ? safe(n.h1, 120) : null; };
  const routes = routeOrder.map(route => ({ route: safe(route, 200), name: nameOf(route), opened: true, why: null, whyText: null,
    cells: scenes.filter(s => s.route === route).map(s => cells.get(s.id)) }));
  for (const r of needsSample) routes.push({ route: safe(r, 200), name: null, opened: false, why: 'needs-sample', whyText: C.needsSample, cells: [] });
  for (const r of quickLook ? [] : unresolved) routes.push({ route: safe(r, 200), name: null, opened: false, why: 'unresolved', whyText: C.unresolved, cells: [] });

  // ---- by lens: the rule checks (engine constants) beside the AI review's cells on checked screens -----------------
  const pairs = new Map();
  for (const s of scenes.filter(x => x.state === 'normal')) { const k = `${s.route}|${s.person}`; if (!pairs.has(k)) pairs.set(k, {}); pairs.get(k)[s.viewport] = s; }
  const both = [...pairs.values()].filter(p => p.d && p.m && checkedScene(p.d) && checkedScene(p.m)).length;
  const ruleText = id => {
    const k = RULE_CHECKS[id];
    if (k === undefined || k === null) return C.aiOnly;
    const of = `${checked.length} of ${scenes.length} screens`;
    return { screens: of, pairs: `${of} · state pairs`, bundle: `${of} + the bundle`, flow: `${fullCheck ? `${C.whole}: l` : 'L'}inks between ${plural(pages.opened, 'page')}`,
      system: `${fullCheck ? `${C.whole}: m` : 'M'}easured on ${plural(checked.length, 'screen')}`, parity: `${both} of ${pairs.size} page × who pairs, both widths` }[k];
  };
  const aiText = id => {
    if (!model.lenses?.[id] || model.lenses[id].method !== 'ai') return src.run && aiCells.some(l => l.lens === id) ? null : C.rulesOnly;
    if (!src.run || src.error) return '—';
    const mine = aiCells.filter(l => l.lens === id);
    if (!mine.length || mine.every(l => l.reason === 'not-hunted')) return C.notInHunt;
    const seen = mine.filter(l => l.status === 'seen').length;
    const n = r => mine.filter(l => l.status !== 'seen' && l.reason === r).length;
    const notes = [n('budget') && `${n('budget')} not checked: AI budget ran out`, n('canary-missed') && `${n('canary-missed')} ${n('canary-missed') === 1 ? 'doesn’t' : 'don’t'} count: test defect missed`,
      n('not-answered') && `${n('not-answered')} not answered`, n('incomplete') && `${n('incomplete')} incomplete`].filter(Boolean);
    return [C.of(seen, mine.length), ...notes].join(' · ');
  };
  const lensIds = [...new Set([...Object.keys(RULE_CHECKS), ...Object.keys(model.lenses || {}).filter(id => /^L\d+$/.test(id))])].sort(lensOrder);
  const byLens = lensIds.map(id => ({ lens: id, name: safe(lensName(model, id), 80), rule: ruleText(id), ai: aiText(id) || C.of(aiCells.filter(l => l.lens === id && l.status === 'seen').length, aiCells.filter(l => l.lens === id).length) }));

  // the latest capture when it is a first look: its key screens (pages, as M5 counts them) and, while the full check
  // after it runs, the summary's line ("First look: 8 key screens · full check running, 12 of 25 screens (about 6 min
  // left)"); a newer partial sweep than the run shown: "Run 0007 · Not a full check: only the pages asked for. …"
  const latestEv = model.latestEv;
  const first = sum.firstLook && sum.firstLook.run === model.latest ? sum.firstLook : null;
  const quick = isQuick(model, model.latest)
    ? { run: model.latest, screens: Number.isInteger(first?.screens) && first.screens > 0 ? first.screens : new Set((latestEv?.scenes || []).map(s => s.route)).size, text: first?.text ? safe(first.text, 300) : null } : null;
  let newer = null;
  if (!quick && model.latest !== run && latestEv) {
    const lmeta = isObj(latestEv.meta) ? latestEv.meta : {};
    const why = whyNotFull(lmeta, { appDown: problemsOf(latestEv).some(p => p.status === 'app-unreachable'), needsSample: (Array.isArray(lmeta.skipped) ? lmeta.skipped : []).filter(x => x?.reason === 'needs-sample').length });
    newer = { run: model.latest, text: `Run ${model.latest} · ${C.wholeNot(why)}` };
  }
  // captures being written by a writer that is still there (summary.mjs, M5: a killed one's folder is not "running");
  // the full check after a first look is said by the first look's line instead, as on Progress
  const running = (Array.isArray(sum.runningRuns) ? sum.runningRuns : []).map(String).filter(r => RUN_ID.test(r) && r !== sum.firstLook?.full?.run).sort(byRun);
  // the summary's line for the newest of them, or for a capture that stopped (M5b): one source, summary.mjs, so Coverage
  // says what Progress and `findings` say
  const cap = (Array.isArray(sum.captures) ? sum.captures : []).filter(c => c && RUN_ID.test(String(c.run)) && typeof c.text === 'string').pop() ?? null;
  const capture = cap ? { run: String(cap.run), state: cap.state === 'stopped' ? 'stopped' : 'running', text: safe(cap.text, 300) } : null;
  return (model._coverage = {
    run, kind, fullCheck, wholeApp: meta.wholeApp === true, quick, newer,
    scope: { persons, viewports: vps, states },
    health: { problems: problems.map(p => ({ status: safe(p.status, 40), scenes: p.scenes, of: p.of })) },
    ai: { run: src.run, latest: src.latest, older: src.older, error: src.error, last: src.last, lenses: hunted.map(l => safe(l, 12)),
      names: Object.fromEntries([...new Set([...loaded, ...hunted])].map(l => [safe(l, 12), safe(lensName(model, l), 80)])),
      budget: planBudget === undefined ? null : planBudget, budgetDefault: !!src.plan?.budgetDefault,
      estimate: src.plan?.estimate ? { planned: Number(src.plan.estimate.planned) || 0, cut: Number(src.plan.estimate.cut) || 0 } : null },
    totals: { screens: { checked: checked.length, total: scenes.length }, ai: aiTotals, pages },
    wholeLine, aiLine,
    gaps, fine, muted, warnings,
    routes, byLens, running, capture,
  });
}

// A scene's coverage for the Screen detail (§4.6): the rule checks, the AI's lenses, and its link into the map.
export function sceneCoverage(model, s) {
  const cell = cellOf(model, s);
  return { checked: cell.checked, why: cell.why, ai: cell.ai, changed: cell.changed ?? null, mark: coverageMark(cell, 'all'), link: `#/coverage/${s.run}/${encodeURIComponent(s.id)}` };
}

// Progress's AI line (D2): Coverage's own count, so the two views never disagree (review of PR #35): the AI cells on
// the checked screens of the run Coverage shows, and which run the AI reviewed. → { cells, seen, budget, run, aiRun }
// or null.
export function aiOnChecked(model) {
  const v = coverageView(model);
  if (!v.run || !v.totals?.ai) return null;
  const lenses = v.routes.flatMap(r => r.cells).filter(c => c.checked && c.ai).flatMap(c => c.ai.lenses);
  return { cells: v.totals.ai.of, seen: v.totals.ai.seen, budget: lenses.filter(l => l.reason === 'budget').length, run: v.run, aiRun: v.ai.run };
}

