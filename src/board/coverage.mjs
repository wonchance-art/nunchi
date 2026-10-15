// The Coverage view's model (M7; the mock-up the owner approved on 2026-10-15 KST, §3): what nunchi looked at in the
// latest run, and what it didn't. Only what the engine already wrote: the run's manifest (screens and why one was not
// checked), run.json (scope, full check, routes discover could not resolve), flow.json (pages and their order),
// coverage.json and hunt-plan.json (the AI hunt's cells and budget), the ledger (which run the AI reviewed, findings
// not looked at since). Nothing is captured or judged here.
//
// AI cells count only on checked screens (decision D2): a screen that did not load is counted once, under Screens
// checked, never again as missing AI cells. Strings from the app (routes, page names) go out through safe(), as
// everywhere on the board.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { listRuns } from '../runs.mjs';
import { byRun } from '../ledger.mjs';
import { redactUrl } from '../network.mjs';
import { safe, RUN_ID } from './model.mjs';
import {
  PERSONS, VPS, STATES, WHO, WIDTH, STATE_LABEL, COVERAGE as C, MARKS, plural, listText, andList, thousands, lensLabel, lensNumber,
  notCheckedText, aiReasonText, coverageMark,
} from './shared.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const readJson = p => { try { return { doc: JSON.parse(readFileSync(p, 'utf8')) }; } catch (e) { return e?.code === 'ENOENT' ? null : { error: true }; } };
const ACTIVE = new Set(['open', 'regressed', 'to-fix', 'held', 'stale']);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// a screen is checked when it was captured at its own address (summary.mjs checkedScene, the verdict's)
export const checkedScene = s => s.status === 'captured' && !/^redirected/.test(String(s.reason || '')) && !s.redirected;
// The order the hunt spends its budget in (hunt.mjs SPEND_ORDER): what "comes last" means.
const SPEND_ORDER = ['L1', 'L9', 'L6', 'L2', 'L10', 'L7', 'L5', 'L4'];
// What the rule checks of each lens look at (rules.mjs, capture.mjs, flow.mjs, system.mjs; ledger.mjs WHOLE_APP):
// `screens` per screen, `pairs` also compare a screen's states, `flow` the link graph between pages, `system` the
// design system measured over every screen, `bundle` also the browser bundle (secrets), `parity` desktop against phone
// per page and person, null: no rule check (the AI only). test/board-coverage.test.mjs pins it against the engine.
export const RULE_CHECKS = { L1: 'screens', L2: 'pairs', L3: 'flow', L4: 'system', L5: null, L6: 'screens', L7: 'screens', L8: 'screens', L9: 'bundle', L10: 'parity' };

// Every AI cell of the run the AI reviewed, for the latest run's screens. `src.run` is that run (the latest, an older
// one, or null); `error`: its coverage.json could not be read.
export function aiSource(model) {
  if (model._aiSource) return model._aiSource;
  const runsDir = model.led.st.runsDir, latest = model.latest, stream = model.led.st.root.stream;
  const folds = (Array.isArray(model.led.state.folds) ? model.led.state.folds : [])
    .filter(f => f && f.source === 'ai' && (f.stream ?? 'main') === stream && RUN_ID.test(String(f.run))).map(f => String(f.run));
  const aiRuns = [...new Set(folds)].sort(byRun);
  const complete = new Set(listRuns(runsDir).complete);
  const out = { run: null, latest: false, older: false, error: false, cells: [], last: null, plan: null };
  const take = run => {
    const r = readJson(join(runsDir, run, 'coverage.json'));
    if (!r) return false;
    out.run = run; out.latest = run === latest; out.older = run !== latest;
    if (r.error || !Array.isArray(r.doc?.cells)) { out.error = true; return true; }
    out.cells = r.doc.cells.filter(isObj);
    const plan = readJson(join(runsDir, run, 'hunt-plan.json'));
    // the plan beside the record, only when it is the plan that record answers (a newer --plan replaces it)
    if (plan?.doc && plan.doc.id === r.doc.plan) out.plan = plan.doc;
    return true;
  };
  if (latest && complete.has(latest) && take(latest)) return (model._aiSource = out);
  if (latest && aiRuns.includes(latest)) { out.run = latest; out.latest = true; out.error = true; return (model._aiSource = out); }
  const older = aiRuns.filter(r => latest && byRun(r, latest) < 0 && complete.has(r));
  for (const r of older.reverse()) if (take(r)) return (model._aiSource = out);
  out.last = aiRuns.length ? aiRuns[aiRuns.length - 1] : null;
  return (model._aiSource = out);
}

// The latest run's scenes with what the board needs to judge them, and the AI cells by scene id.
function context(model) {
  if (model._covCtx) return model._covCtx;
  const ev = model.latestEv;
  const src = aiSource(model);
  const runsDir = model.led.st.runsDir;
  const scenes = ev ? ev.scenes : [];
  const raw = new Map((Array.isArray(ev?.manifest?.scenes) ? ev.manifest.scenes : []).filter(s => s && typeof s.id === 'string' && s.canary === undefined).map(s => [s.id, s]));
  // the AI run's own manifest (the same scene ids, another run): its canary copies and checked screens
  const aiEv = src.run && src.older ? model.evidenceOf(src.run) : ev;
  const aiRaw = src.run && src.older ? new Map((Array.isArray(aiEv?.manifest?.scenes) ? aiEv.manifest.scenes : []).filter(s => s && typeof s.id === 'string' && s.canary === undefined).map(s => [s.id, s])) : raw;
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
  // open findings by scene (the latest run's, as the wall shows them)
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
  return (model._covCtx = { ev, src, scenes, raw, aiRaw, cellsBy, found, openBy });
}

const lensName = (model, id) => lensLabel(id, model.lenses?.[id]?.name);
const lensOrder = (a, b) => lensNumber(a) - lensNumber(b) || cmp(a, b);

// One scene's AI cells: seen of applicable, and each lens with its reason in the board's words.
function aiOf(model, cx, s) {
  if (!cx.src.run || cx.src.error) return null;
  const lenses = [...(cx.cellsBy.get(s.id)?.values() || [])].sort((a, b) => lensOrder(a.lens, b.lens)).map(c => {
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
function sayOf(cell, s) {
  if (!cell.checked) {
    if (s.redirected || s.reason === 'redirected-off-origin') return null;
    return s.reason === 'login-expired' ? { say: C.say.again, sentence: C.loginThen } : { say: C.say.again, sentence: C.startThen };
  }
  if (!cell.ai) return { say: C.say.run, sentence: C.tell(C.say.run) };
  const by = r => cell.ai.lenses.find(l => l.reason === r);
  const canary = by('canary-missed');
  if (canary) { const say = C.say.hunt(canary.lens, cell.route); return { say, sentence: C.tell(say) }; }
  if (by('budget')) return { say: C.say.budget, sentence: C.tell(C.say.budget) };
  if (by('not-answered') || by('incomplete')) return { say: C.say.finish, sentence: C.tell(C.say.finish) };
  return null;
}

// One map cell (a scene of the latest run) as /api/coverage and the Screen detail give it.
export function cellOf(model, s) {
  const cx = context(model);
  const checked = checkedScene(s);
  const route = safe(s.route, 200);
  const cell = {
    key: s.key, id: safe(s.id, 200), route, person: s.person, viewport: s.viewport, state: s.state, checked,
    why: checked ? null : safe(notCheckedText({ ...s, finalPath: s.finalPath ? redactUrl(s.finalPath) : null }), 300),
    ai: checked ? aiOf(model, cx, s) : null,
    open: cx.openBy.get(s.id) || {},
  };
  // the AI looked at an older run: did this screen change since? (its pixels or text)
  if (cell.ai && cx.src.older) {
    const a = cx.aiRaw.get(s.id), b = cx.raw.get(s.id);
    cell.changed = !!(a && b && (a.top !== b.top || a.full !== b.full || a.textHash !== b.textHash));
  }
  cell.say = sayOf(cell, s);
  return cell;
}

// Where a set of screens is, for a gap row: "/checkout · Signed in · Offline" (widths folded), up to 3.
const whereOf = list => listText([...new Set(list.map(s => `${s.route} · ${WHO[s.person] || s.person} · ${STATE_LABEL[s.state] || s.state}`))].map(x => safe(x, 200)), 3);
const commonState = list => { const st = [...new Set(list.map(s => s.state))]; return st.length === 1 ? st[0] : 'all'; };
const commonLens = lenses => (lenses.length === 1 ? lenses[0] : 'all');

// /api/coverage (mock-up §3.7): totals, the gaps with what to do, the map's rows and cells, the lens table.
export function coverageView(model) {
  if (model._coverage) return model._coverage;
  const cx = context(model);
  const { ev, src, scenes } = cx;
  const sum = model.summary;
  const runsDir = model.led.st.runsDir;
  if (!ev || !model.latest) return (model._coverage = { run: null });
  const run = ev.runId;
  const meta = isObj(ev.meta) ? ev.meta : {};
  const scope = isObj(meta.scope) ? meta.scope : {};
  const flow = readJson(join(runsDir, run, 'flow.json'))?.doc || {};
  const problems = Array.isArray(sum.health?.problems) ? sum.health.problems : [];
  const kind = meta.kind === 'quick' ? 'quick' : meta.kind === 'fix-probe' ? 'fix-probe' : 'sweep';
  const persons = PERSONS.filter(p => (Array.isArray(scope.persons) ? scope.persons : scenes.map(s => s.person)).includes(p));
  const vps = VPS.filter(v => (Array.isArray(scope.viewports) ? scope.viewports : scenes.map(s => s.viewport)).includes(v));
  const states = STATES.filter(x => (Array.isArray(scope.states) ? scope.states : scenes.map(s => s.state)).includes(x));
  const cells = new Map(scenes.map(s => [s.id, cellOf(model, s)]));
  const checked = scenes.filter(checkedScene);
  const unresolved = (Array.isArray(meta.unresolved) ? meta.unresolved : []).filter(r => typeof r === 'string').sort();
  const nodes = (Array.isArray(flow.nodes) ? flow.nodes : []).filter(n => isObj(n) && typeof n.route === 'string');
  const sceneRoutes = new Set(scenes.map(s => s.route));
  const hasParam = r => /\[|:/.test(r);
  const needsSample = scope.changedSince ? [] : nodes.filter(n => !n.captured && !sceneRoutes.has(n.route) && hasParam(n.route) && !unresolved.includes(n.route)).map(n => n.route).sort();
  // pages: the routes discover resolved (flow.json nodes) and those it could not (run.json unresolved)
  const pages = nodes.length ? { opened: nodes.filter(n => n.captured).length, total: nodes.length + unresolved.length }
    : { opened: new Set(checked.filter(s => s.state === 'normal').map(s => s.route)).size, total: sceneRoutes.size + unresolved.length };
  const appDown = problems.some(p => p.status === 'app-unreachable');
  const fullCheck = meta.wholeApp === true && kind === 'sweep';
  const notFullWhy = kind === 'quick' ? 'a first look' : appDown ? 'most screens didn’t load' : needsSample.length ? `${needsSample.length === 1 ? 'a page needs' : 'pages need'} a sample address`
    : scope.changedSince ? `only pages changed since ${safe(scope.changedSince, 80)}` : 'only the pages asked for';
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
  if (sum.health?.blind) warnings.push(`This run could not tell what was fixed (${safe(sum.health.blind, 40)}). Nothing was marked fixed by it.`);
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
  if (!src.run && checked.length) {
    push(gaps, { kind: 'ai-not-run', mark: MARKS.rules.sym, line: `${C.aiNotRun(run)}${src.last ? ` (last: run ${src.last})` : ''}`, ...sentence(C.say.run) });
  } else if (src.older) {
    push(gaps, { kind: 'ai-not-run', mark: MARKS.rules.sym, line: `${C.aiNotRun(run)} (last: run ${src.run})`, ...sentence(C.say.run) });
  }
  if (src.run && !src.error && loaded.length && hunted.length && hunted.length < loaded.length && hunted.every(l => loaded.includes(l))) {
    push(gaps, { kind: 'lens-subset', mark: MARKS.partly.sym, line: C.lensSubset(andList(hunted)), ...sentence(C.say.every) });
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
    push(gaps, { kind: 'needs-sample', mark: MARKS.not.sym, line: C.gap.pages(needsSample.length, routes, C.gap.needsSampleWhy), ...sentence(C.say.sample(routes)) });
  }
  if (unresolved.length) {
    const routes = listText(unresolved.map(r => safe(r, 200)), 5);
    push(gaps, { kind: 'unresolved', mark: MARKS.not.sym, line: C.gap.pages(unresolved.length, routes, C.gap.unresolvedWhy), ...sentence(C.say.routeToo(routes)) });
  }
  // not a full check (by --routes or --changed-since: the other causes have rows of their own)
  if (meta.wholeApp !== true && kind === 'sweep' && !needsSample.length && !appDown) {
    push(gaps, { kind: 'not-full', mark: '!', line: C.wholeNot(notFullWhy), ...sentence(C.say.again) });
  }
  // states not in scope
  if (Array.isArray(scope.states) && scope.states.length && STATES.some(x => !scope.states.includes(x))) {
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
    for (const s of redirected) { const k = `${s.person}\0${redactUrl(s.finalPath || '?')}`; if (!parts.has(k)) parts.set(k, []); if (!parts.get(k).includes(s.route)) parts.get(k).push(s.route); }
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
  const nameOf = route => { const mine = scenes.filter(s => s.route === route && s.h1); const n = mine.find(s => s.state === 'normal') || mine[0]; return n ? safe(n.h1, 120) : null; };
  const routes = routeOrder.map(route => ({ route: safe(route, 200), name: nameOf(route), opened: true, why: null, whyText: null,
    cells: scenes.filter(s => s.route === route).map(s => cells.get(s.id)) }));
  for (const r of needsSample) routes.push({ route: safe(r, 200), name: null, opened: false, why: 'needs-sample', whyText: C.needsSample, cells: [] });
  for (const r of unresolved) routes.push({ route: safe(r, 200), name: null, opened: false, why: 'unresolved', whyText: C.unresolved, cells: [] });

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
    if (!mine.length) return C.notInHunt;
    const seen = mine.filter(l => l.status === 'seen').length;
    const n = r => mine.filter(l => l.status !== 'seen' && l.reason === r).length;
    const notes = [n('budget') && `${n('budget')} not checked: AI budget ran out`, n('canary-missed') && `${n('canary-missed')} ${n('canary-missed') === 1 ? 'doesn’t' : 'don’t'} count: test defect missed`,
      n('not-answered') && `${n('not-answered')} not answered`, n('incomplete') && `${n('incomplete')} incomplete`].filter(Boolean);
    return [C.of(seen, mine.length), ...notes].join(' · ');
  };
  const lensIds = [...new Set([...Object.keys(RULE_CHECKS), ...Object.keys(model.lenses || {}).filter(id => /^L\d+$/.test(id))])].sort(lensOrder);
  const byLens = lensIds.map(id => ({ lens: id, name: safe(lensName(model, id), 80), rule: ruleText(id), ai: aiText(id) || C.of(aiCells.filter(l => l.lens === id && l.status === 'seen').length, aiCells.filter(l => l.lens === id).length) }));

  const quick = kind === 'quick' ? { screens: new Set(scenes.map(s => s.route)).size } : null;
  return (model._coverage = {
    run, kind, fullCheck, wholeApp: meta.wholeApp === true, quick,
    scope: { persons, viewports: vps, states },
    health: { problems: problems.map(p => ({ status: safe(p.status, 40), scenes: p.scenes, of: p.of })) },
    ai: { run: src.run, latest: src.latest, older: src.older, error: src.error, last: src.last, lenses: hunted.map(l => safe(l, 12)),
      names: Object.fromEntries([...new Set([...loaded, ...hunted])].map(l => [safe(l, 12), safe(lensName(model, l), 80)])),
      budget: planBudget === undefined ? null : planBudget, budgetDefault: !!src.plan?.budgetDefault,
      estimate: src.plan?.estimate ? { planned: Number(src.plan.estimate.planned) || 0, cut: Number(src.plan.estimate.cut) || 0 } : null },
    totals: { screens: { checked: checked.length, total: scenes.length }, ai: aiTotals, pages },
    wholeLine, aiLine,
    gaps, fine, muted, warnings,
    routes, byLens,
  });
}

// A scene's coverage for the Screen detail (§4.6): the rule checks, the AI's lenses, and its link into the map.
export function sceneCoverage(model, s) {
  const cell = cellOf(model, s);
  return { checked: cell.checked, why: cell.why, ai: cell.ai, changed: cell.changed ?? null, mark: coverageMark(cell, 'all'), link: `#/coverage/${s.run}/${encodeURIComponent(s.id)}` };
}

// The AI hunt's cells on the latest run's checked screens (D2): Progress's AI line. → { cells, seen, budget } or null.
export function aiOnChecked(model) {
  const cx = context(model);
  if (!cx.src.run || cx.src.error || cx.src.older) return null;
  const list = cx.scenes.filter(checkedScene).flatMap(s => [...(cx.cellsBy.get(s.id)?.values() || [])]);
  return { cells: list.length, seen: list.filter(c => c.status === 'seen').length, budget: list.filter(c => c.status !== 'seen' && c.reason === 'budget').length };
}

// Capture runs in progress (a `.partial` folder): the banner "A capture is running (run 0013)".
export const runningRuns = runsDir => listRuns(runsDir).partial.map(p => p.replace(/\.partial$/, '')).filter(x => RUN_ID.test(x)).sort(byRun);
