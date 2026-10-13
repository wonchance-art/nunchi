// L3 flow lens (spec §3): the app's link graph as captured, plus the navigations its source names.
// Deterministic, computed from the evidence and the source; no AI. Produces flow.json (the map the
// board draws, and the wall's order) and three kinds of findings:
//   link-to-missing-route  an internal link whose target matches no route of the app (users hit a 404)
//   unreachable-route      no captured link and no navigation in the source leads to this route
//                          (0.1 only knows <a href> and literal navigations: a button that navigates
//                          in code it does not see would make this wrong, hence severity low)
//   dead-end               a screen with no visible internal link, on every viewport, and no navigation
//                          in its source: the user can only go back with the browser
// The signed-in-bounced rule (a signed-in person sent to a sign-in page) lives in capture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Route template → matcher. Next.js [id] [...rest] [[...rest]], TanStack $id $ {-$id}, React Router :id :id? *.
export function routeMatcher(templates) {
  const compiled = templates.map(t => {
    const segs = t.split('/').filter(Boolean);
    let re = '^';
    let weight = 0;                                                           // more literal segments win
    for (const s of segs) {
      if (/^\[\[\.\.\..+\]\]$/.test(s)) re += '(?:/.*)?';
      else if (/^\[\.\.\..+\]$/.test(s) || s === '$' || s === '*') re += '/.+';
      else if (/^\[.+\]$/.test(s) || /^\$.+/.test(s) || /^:[^?]+$/.test(s)) re += '/[^/]+';
      else if (/^\{-\$.+\}$/.test(s) || /^:.+\?$/.test(s)) re += '(?:/[^/]+)?';
      else { re += '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); weight += 2; }
    }
    re += '/?$';
    return { t, re: new RegExp(re), weight };
  }).sort((a, b) => b.weight - a.weight || (a.t < b.t ? -1 : 1));
  return path => {
    if (typeof path !== 'string') return null;
    const p = (path.split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/';
    if (p === '/') return templates.includes('/') ? '/' : (compiled.find(c => c.re.test('/'))?.t ?? null);
    return compiled.find(c => c.re.test(p))?.t ?? null;
  };
}

// Literal navigations in source: router.push/replace('/x'), redirect('/x'), navigate('/x'),
// location.assign('/x'), href="/x", href={'/x'}, href: '/x', to="/x". Template literals keep their
// static prefix with each ${…} standing for one segment value.
const NAV = [
  /\b(?:push|replace|redirect|permanentRedirect|navigate|assign)\(\s*(['"`])(\/[^'"`\n]*)\1/g,
  /\b(?:href|to)\s*=\s*\{?\s*(['"`])(\/[^'"`\n]*)\1/g,
  /\b(?:href|to|pathname)\s*:\s*(['"`])(\/[^'"`\n]*)\1/g,
  /\b(?:window\.)?location(?:\.href)?\s*=\s*(['"`])(\/[^'"`\n]*)\1/g,
];
export function codeNavigations(root, sourceMap) {
  const out = [];
  const files = Object.keys(sourceMap.files).filter(f => /\.(m|c)?(t|j)sx?$/.test(f)).sort();
  for (const file of files) {
    let src;
    try { src = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    const seen = new Set();
    for (const re of NAV) for (const m of src.matchAll(re)) {
      const to = m[2].replace(/\$\{[^}]*\}/g, 'x');
      if (to.startsWith('//')) continue;                                    // protocol-relative: not internal
      const line = src.slice(0, m.index).split('\n').length;
      const key = `${to}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const from of sourceMap.files[file]) out.push({ from, to, file, line });
    }
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.file, b.file) || a.line - b.line);
}

const ASSET = /\.(?!html?$)[a-z0-9]{1,5}$/i;
const LANDMARK = new Set(['nav', 'header', 'footer']);

// entries: manifest scenes. sceneLinks: Map(scene id → links.json). routes: known route templates.
// complete: routes come from the app's source (discover), so a link to anything else is a dead link.
// wholeApp: every route was in scope (not --changed-since), so a route nothing leads to is worth saying.
export function buildFlow({ entries, sceneLinks, routes, complete, wholeApp = complete, code = [] }) {
  const match = routeMatcher(routes);
  const findings = [];
  const seen = entries.filter(e => e.status === 'captured' && e.state === 'normal' && !e.redirected);
  // Order the walk by what a visitor meets first: guest before signed-in, desktop before phone.
  const rank = e => (e.person === 'guest' ? 0 : 1) * 2 + (e.viewport === 'd' ? 0 : 1);
  const ordered = [...seen].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));

  // Sections: routes sharing a first path segment with at least one other route (/app/*); single
  // top-level pages (/about, /pricing) belong to the root section.
  const firstSeg = r => r.split('/').filter(Boolean)[0] || '';
  const segCount = new Map();
  for (const r of routes) segCount.set(firstSeg(r), (segCount.get(firstSeg(r)) || 0) + 1);
  const groupOf = r => (r === '/' || (segCount.get(firstSeg(r)) || 0) < 2 ? '/' : '/' + firstSeg(r));

  // Shared navigation: a link to the same target inside nav/header/footer on ≥80% of a person's
  // screens in that section (the app menu of /app/*, the site header of the public pages).
  const global = new Set();
  for (const key of [...new Set(seen.map(e => `${e.person}|${groupOf(e.route)}`))]) {
    const [person, grp] = key.split('|');
    const mine = seen.filter(e => e.person === person && groupOf(e.route) === grp);
    const count = new Map();
    for (const e of mine) {
      const targets = new Set((sceneLinks.get(e.id) || []).filter(l => LANDMARK.has(l.landmark)).map(l => match(l.path)).filter(Boolean));
      for (const t of targets) count.set(t, (count.get(t) || 0) + 1);
    }
    for (const [t, n] of count) if (mine.length >= 3 && n >= 0.8 * mine.length) global.add(`${key}|${t}`);
  }

  const edges = new Map();
  const edge = (from, to, via) => {
    const k = `${from}|${to}|${via}`;
    if (!edges.has(k)) edges.set(k, { from, to, via, persons: new Set(), viewports: new Set(), global: true, evidence: [] });
    return edges.get(k);
  };
  const dead = new Map();
  const visibleLinks = new Map();                                           // route|person → visible internal links on any viewport
  for (const e of ordered) {
    const vk = `${e.route}|${e.person}`;
    if (!visibleLinks.has(vk)) visibleLinks.set(vk, { n: 0, scenes: [] });
    visibleLinks.get(vk).scenes.push(e);
    for (const l of sceneLinks.get(e.id) || []) {
      const to = match(l.path);
      if (l.visible && to !== e.route) visibleLinks.get(vk).n++;
      if (!to) {
        if (!complete || ASSET.test(l.path) || l.path.startsWith('/api/')) continue;
        const k = `${e.route}|${e.person}|${l.path}|${l.selector}`;
        if (!dead.has(k)) dead.set(k, { e, l });
        continue;
      }
      if (to === e.route) continue;
      const ed = edge(e.route, to, 'link');
      ed.persons.add(e.person); ed.viewports.add(e.viewport);
      if (!global.has(`${e.person}|${groupOf(e.route)}|${to}`) || !LANDMARK.has(l.landmark)) ed.global = false;
      if (ed.evidence.length < 3) ed.evidence.push({ scene: e.id, selector: l.selector });
    }
  }
  for (const { e, l } of [...dead.values()]) {
    findings.push({ lens: 'L3', rule: 'link-to-missing-route', severity: 'high', scene: e.id, route: e.route, viewport: e.viewport, selector: l.selector, box: null, evidence: { href: l.path, note: 'no route of the app matches this link' } });
  }
  const codeFrom = new Set();
  for (const c of code) {
    const to = match(c.to);
    if (!to || to === c.from) continue;
    codeFrom.add(c.from);
    const ed = edge(c.from, to, 'code');
    ed.global = false;
    if (ed.evidence.length < 3) ed.evidence.push({ file: c.file, line: c.line });
  }

  // Wall order: breadth-first from the entry over the links in the order visitors meet them.
  const entry = routes.includes('/') ? '/' : (ordered[0]?.route ?? routes[0] ?? null);
  const adj = new Map();
  for (const ed of edges.values()) {
    if (!adj.has(ed.from)) adj.set(ed.from, []);
    if (!adj.get(ed.from).includes(ed.to)) adj.get(ed.from).push(ed.to);
  }
  const order = [];
  const queue = entry ? [entry] : [];
  const done = new Set(queue);
  while (queue.length) {
    const r = queue.shift();
    order.push(r);
    for (const t of adj.get(r) || []) if (!done.has(t)) { done.add(t); queue.push(t); }
  }
  for (const r of [...routes].sort()) if (!done.has(r)) order.push(r);

  const redirectTargets = new Set(entries.filter(e => e.redirected && e.finalPath).map(e => match(e.finalPath)).filter(Boolean));
  const inbound = new Map();
  for (const ed of edges.values()) { if (!inbound.has(ed.to)) inbound.set(ed.to, new Set()); inbound.get(ed.to).add(ed.via); }
  const reach = r => (r === entry ? 'entry' : inbound.get(r)?.has('link') ? 'link' : inbound.get(r)?.has('code') ? 'code' : redirectTargets.has(r) ? 'redirect' : null);
  const capturedRoutes = new Set(seen.map(e => e.route));
  if (complete && wholeApp) {
    for (const r of [...routes].sort()) {
      if (reach(r)) continue;
      const s = seen.find(e => e.route === r && e.viewport === 'm') || seen.find(e => e.route === r) || null;
      findings.push({ lens: 'L3', rule: 'unreachable-route', severity: 'low', scene: s ? s.id : null, route: r, viewport: s ? s.viewport : null, selector: null, box: null, evidence: { note: 'no captured link and no navigation in the source leads here; a button that navigates in code nunchi cannot read would make this wrong', screensChecked: capturedRoutes.size } });
    }
  }
  for (const [k, v] of [...visibleLinks].sort()) {
    const [route] = k.split('|');
    if (v.n > 0 || codeFrom.has(route)) continue;
    if (v.scenes.every(e => e.httpStatus >= 400)) continue;                  // an error page is its own finding
    const s = v.scenes.find(e => e.viewport === 'm') || v.scenes[0];
    findings.push({ lens: 'L3', rule: 'dead-end', severity: 'low', scene: s.id, route, viewport: s.viewport, selector: 'body', box: null, evidence: { note: 'no visible link to another screen on any viewport, and no navigation in its source' } });
  }

  const groups = [];
  for (const r of order) {
    const id = groupOf(r);
    let g = groups.find(x => x.id === id);
    if (!g) groups.push((g = { id, routes: [] }));
    g.routes.push(r);
  }
  const flow = {
    schema: 1, complete, wholeApp, entry,
    nodes: [...routes].sort().map(r => ({ route: r, captured: capturedRoutes.has(r), reachedBy: reach(r) })),
    edges: [...edges.values()].map(ed => ({ ...ed, persons: [...ed.persons].sort(), viewports: [...ed.viewports].sort() }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.via < b.via ? -1 : 1)),
    order, groups,
  };
  return { flow, findings };
}
