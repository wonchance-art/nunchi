// Screens beyond the wall (M7; the mock-up the owner approved on 2026-10-15 KST, §4): what the wall gains (whether a
// screen changed since the last full check, its AI cells, its page group) and one screen at a time (the Screen
// detail: its findings numbered by group across both widths, what was fixed here, compare with the last full check or
// a fix's probes, its coverage). Screens is a viewer (decision D4): nothing here decides.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { byRun } from '../ledger.mjs';
import { allRecords } from '../fix/records.mjs';
import { redactUrl } from '../network.mjs';
import { screenWall, sceneOut, safe, RUN_ID } from './model.mjs';
import { cellOf, sceneCoverage, checkedScene } from './coverage.mjs';
import { SEV, VPS, STATUS_LABEL, MORE_STATUS, SCREENS as T, drawable, listText } from './shared.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const rawOf = ev => new Map((Array.isArray(ev?.manifest?.scenes) ? ev.manifest.scenes : []).filter(x => x && typeof x.id === 'string' && x.canary === undefined).map(x => [x.id, x]));
const sameShot = (a, b) => !!(a && b && a.top && b.top && a.top === b.top && a.full === b.full && a.textHash === b.textHash);
const pathOf = p => String(p || '').split(/[?#]/)[0];

// The full check a screen is compared with: the last one before the latest run (the previous full check when the
// latest run is one itself).
export function baselineOf(model) {
  const s = model.summary;
  if (!s.fullCheck) return null;
  return s.fullCheck === model.latest ? s.previousFullCheck || null : s.fullCheck;
}

// The wall's page groups (flow.json `groups`; the same rule when a run has none: routes sharing a first path segment
// with another route are one group, single pages are "Pages").
function groupsOf(model) {
  const ev = model.latestEv;
  const routes = [...new Set(ev.scenes.map(s => s.route))];
  let flow = null;
  try { flow = JSON.parse(readFileSync(join(model.led.st.runsDir, ev.runId, 'flow.json'), 'utf8')); } catch {}
  const of = new Map();
  for (const g of Array.isArray(flow?.groups) ? flow.groups : []) if (isObj(g) && typeof g.id === 'string' && Array.isArray(g.routes)) for (const r of g.routes) if (typeof r === 'string') of.set(r, g.id);
  const first = r => r.split('/').filter(Boolean)[0] || '';
  const count = new Map(); for (const r of routes) count.set(first(r), (count.get(first(r)) || 0) + 1);
  for (const r of routes) if (!of.has(r)) of.set(r, r === '/' || (count.get(first(r)) || 0) < 2 ? '/' : `/${first(r)}`);
  return of;
}

// /api/screens: the wall (model.mjs screenWall) with, per screen, `changed` (pixels or text differ from the same screen
// in the last full check; null when there is none to compare), `ai` (its AI cells: seen of applicable), `group` and
// `open` (open findings), and the page groups in the wall's order.
export function wallOut(model) {
  if (model._wall) return model._wall;
  const w = screenWall(model);
  if (!w.run) return (model._wall = { ...w, baseline: null, groups: [] });
  const ev = model.latestEv;
  const base = baselineOf(model);
  const now = rawOf(ev), then = base ? rawOf(model.evidenceOf(base)) : null;
  const groupOf = groupsOf(model);
  const scenes = w.scenes.map((s, i) => {
    const e = ev.scenes[i];
    const cell = cellOf(model, e);
    const a = now.get(e.id), b = then?.get(e.id);
    const changed = !then || !b || !cell.checked || !checkedScene(b) ? null : !sameShot(a, b);
    const ai = cell.ai ? { seen: cell.ai.seen, of: cell.ai.of, budget: cell.ai.of > 0 && cell.ai.seen === 0 && cell.ai.lenses.every(l => l.reason === 'budget') } : null;
    return { ...s, checked: cell.checked, changed, ai, group: safe(groupOf.get(e.route) || '/', 200), open: Object.values(cell.open).reduce((x, y) => x + y, 0) };
  });
  const groups = [];
  for (const [i, s] of scenes.entries()) {
    let g = groups.find(x => x.id === s.group);
    if (!g) groups.push((g = { id: s.group, routes: [] }));
    const r = ev.scenes[i].route;
    if (!g.routes.includes(r)) g.routes.push(r);
  }
  return (model._wall = { run: w.run, baseline: base, scenes, groups: groups.map(g => ({ id: g.id, title: safe(g.id === '/' ? `${T.pages} · ${listText(g.routes, 5)}` : `${g.id}/*`, 300) })) });
}

const statusText = s => STATUS_LABEL[s] || MORE_STATUS[s] || 'Mixed';

// /api/screens/:run/:scene (§4.6): one screen of the latest run, with the same page (route, person, state) on the other
// width. → null when the run is not the latest or the scene is not one of its screens.
export function screenDetail(model, run, sceneId) {
  const ev = model.latestEv;
  if (!ev || !RUN_ID.test(String(run)) || run !== ev.runId || typeof sceneId !== 'string') return null;
  const s = ev.sceneById.get(sceneId);
  if (!s) return null;
  const wall = wallOut(model);
  const card = wall.scenes.find(x => x.key === s.key) || null;
  const page = ev.scenes.filter(x => x.route === s.route && x.person === s.person && x.state === s.state);
  const pageIds = new Set(page.map(x => x.id));
  const widths = Object.fromEntries(VPS.map(v => [v, (() => { const x = page.find(p => p.viewport === v); return x ? wall.scenes.find(c => c.key === x.key) || sceneOut(x) : null; })()]));

  // the findings on this page, numbered by group: the same defect has the same number on both widths
  const items = [];
  for (const g of model.groups) {
    const here = g._inst.filter(f => f.run === ev.runId && f.scene && pageIds.has(f.scene));
    if (!here.length) continue;
    const at = {};
    for (const f of here) { const sc = ev.sceneById.get(f.scene); if (sc && !at[sc.viewport]) at[sc.viewport] = { box: f.box, ...drawable(f, sc.img) }; }
    const others = new Set(g._inst.filter(f => f.scene && !(f.run === ev.runId && pageIds.has(f.scene))).map(f => `${f.run}/${f.scene}`)).size;
    items.push({ g, at, others });
  }
  items.sort((a, b) => SEV[a.g.severity] - SEV[b.g.severity] || cmp(a.g.headline, b.g.headline) || cmp(a.g.id, b.g.id));
  const findings = items.map(({ g, at, others }, i) => ({
    group: g.id, n: i + 1, severity: g.severity, source: g.source, lens: g.lens, status: g.status, statusText: statusText(g.status), headline: g.headline, active: g.active,
    checked: g.source === 'ai' ? g.checked : true, viewports: VPS.filter(v => at[v]), others,
    at: Object.fromEntries(VPS.map(v => [v, at[v] ? { box: at[v].box, ok: at[v].ok, why: at[v].ok ? null : at[v].why } : null])),
  }));

  // fixed here since the last full check: items gone after it whose last sightings were on this page
  const base = baselineOf(model);
  const after = id => typeof id === 'string' && (!base || byRun(id, base) > 0);
  const fixedHere = [];
  for (const g of model.groups) {
    const gone = g._rows.filter(r => r.goneAt && after(r.goneAt) && g._inst.some(f => f.fp === r.fp && f.scene && pageIds.has(f.scene)));
    if (!gone.length) continue;
    fixedHere.push({ group: g.id, title: g.headline, run: gone.map(r => r.goneAt).sort(byRun).pop() });
  }
  fixedHere.sort((a, b) => byRun(b.run, a.run) || cmp(a.title, b.title));

  // compare: the last full check, then each fix attempt's probes (P0 → P1) that captured this page
  const compare = [];
  if (base) {
    const bev = model.evidenceOf(base), braw = rawOf(bev), now = rawOf(ev);
    const per = {};
    for (const x of page) {
      const b = bev.sceneById.get(x.id);
      per[x.viewport] = !b ? { missing: true } : { before: sceneOut(b), after: sceneOut(x), same: sameShot(now.get(x.id), braw.get(x.id)) };
    }
    compare.push({ kind: 'run', id: 'run', run: base, label: T.runLast(base), per });
  }
  for (const gid of [...new Set([...findings.map(f => f.group), ...fixedHere.map(f => f.group)])]) {
    let recs = [];
    try { recs = allRecords(model.stateDir, gid); } catch { recs = []; }
    for (const rec of recs.filter(isObj).sort((a, b) => (a.attempt || 0) - (b.attempt || 0))) {
      const p0 = rec.p0?.run, p1 = rec.p1?.run;
      if (!RUN_ID.test(String(p0 ?? '')) || !RUN_ID.test(String(p1 ?? ''))) continue;
      const n = Number.isInteger(rec.try) ? rec.try : Number.isInteger(rec.attempt) ? rec.attempt : '?';
      const title = safe(model.byId.get(gid)?.headline || gid, 80);
      const entry = { kind: 'fix', id: `fix-${gid}-${Number.isInteger(rec.attempt) ? rec.attempt : 0}`, group: gid, attempt: n, label: T.fixOf(title, n), undone: !!(rec.outcome?.revert || rec.revert), per: {} };
      const A = model.evidenceOf(String(p0)), B = model.evidenceOf(String(p1));
      if (!A.scenes.length || !B.scenes.length) { entry.gone = true; compare.push(entry); continue; }
      for (const x of page) { const a = A.sceneById.get(x.id), b = B.sceneById.get(x.id); if (a?.img && b?.img) entry.per[x.viewport] = { before: sceneOut(a), after: sceneOut(b) }; }
      if (Object.keys(entry.per).length) compare.push(entry);
    }
  }

  // a screen sent elsewhere is judged as that page: its own screen, when this run has it
  let judged = null;
  if (s.status === 'captured' && s.redirected && s.finalPath) {
    const to = pathOf(s.finalPath);
    const t = ev.scenes.find(x => x.route === to && x.person === s.person && x.viewport === s.viewport && x.state === s.state && checkedScene(x))
      || ev.scenes.find(x => x.route === to && x.person === s.person && x.viewport === s.viewport && checkedScene(x));
    judged = { path: safe(redactUrl(to), 200), key: t ? t.key : null, id: t ? safe(t.id, 200) : null };
  }
  const name = (page.find(x => x.h1) || ev.scenes.find(x => x.route === s.route && x.h1))?.h1;
  return {
    run: ev.runId, key: s.key, id: safe(s.id, 200), scene: card || sceneOut(s), baseline: base,
    page: { route: safe(s.route, 200), person: s.person, state: s.state, name: name ? safe(name, 120) : null },
    widths, findings, fixedHere: fixedHere.map(f => ({ ...f, title: safe(f.title, 160) })), compare,
    coverage: Object.fromEntries(VPS.map(v => [v, (() => { const x = page.find(p => p.viewport === v); return x ? sceneCoverage(model, x) : null; })()])),
    siblings: ev.scenes.filter(x => x.route === s.route && x.id !== s.id).map(x => ({ key: x.key, id: safe(x.id, 200), person: x.person, viewport: x.viewport, state: x.state, checked: checkedScene(x) })),
    judged,
  };
}
