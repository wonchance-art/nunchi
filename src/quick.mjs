// Fast first run (design 0.1-c §6, M5): which screens `capture --quick` looks at first. Chosen from the source's
// route list and the home page's evidence only, so the same app gives the same choice (no clock, no randomness).
//
// Up to QUICK_MAX routes, in this order:
//   1. `/` (the home page), when the app has it;
//   2. the routes the home page links to from its navigation (`<nav>` / role=navigation, or the page banner: a
//      `<header>` not inside an article, aside, main, nav or section, or role=banner; never inside a footer or
//      role=contentinfo; a link the screen does not show is skipped — links.json `navigation`, `visible`), in the
//      order a visitor meets them: the screens of `/` guest before signed-in, desktop before phone, each one's links in
//      document order; a route counts once, where it is met first.
//      A screen of `/` that redirected within the app counts (its links are what `/` shows); one that was not captured
//      (no DOM, left the app) gives none;
//   3. one route per top-level segment no chosen route is in yet (`/app/...` is segment `app`), bigger segments first
//      (more routes), then by name; the segment's route is the shallowest, a static one before a dynamic one, then by
//      name.
// Only routes the capture can open count (static, or dynamic with a sample); a link to anything else is skipped.
import { routeMatcher } from './flow.mjs';

export const QUICK_MAX = 8;
// links.json says whether a link is the site's navigation (`navigation`: in a nav or the page banner, never in a footer);
// links captured before it existed fall back to the nearest landmark
const NAVIGATION = new Set(['nav', 'header']);
const isNavigation = l => (typeof l.navigation === 'boolean' ? l.navigation : NAVIGATION.has(l.landmark));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const segmentOf = r => r.split('/').filter(Boolean)[0] ?? '';
const depthOf = r => r.split('/').filter(Boolean).length;
// a route template with a parameter: Next.js [id], TanStack $id / {-$id}, React Router :id and *
const isDynamic = r => r.split('/').some(s => /^\[.+\]$/.test(s) || s.startsWith('$') || /^\{-\$.+\}$/.test(s) || s.startsWith(':') || s === '*');
// what a visitor meets first (as the flow lens walks it): guest before signed-in, desktop before phone
const visitorOrder = s => (s.person === 'guest' ? 0 : 1) * 2 + (s.viewport === 'd' ? 0 : 1);

// routes: the route templates this capture can open. known: every route template of the app (links are matched
// against all of them, so a link to a route without a sample matches that route and is skipped, never a look-alike).
// home: the captured screens of `/`, each { id, person, viewport, status, links } (links.json).
// → { routes: [in order], why: { route: 'home' | 'navigation' | 'section' } }
export function rankQuick({ routes, known = routes, home = [], max = QUICK_MAX }) {
  const candidates = [...new Set(routes)].sort(cmp);
  const can = new Set(candidates);
  const chosen = [], why = {};
  const take = (r, reason) => { if (chosen.length < max && can.has(r) && !Object.hasOwn(why, r)) { chosen.push(r); why[r] = reason; } };
  take('/', 'home');
  const match = routeMatcher([...new Set([...known, ...candidates])].sort(cmp));
  const screens = home.filter(s => s && s.status === 'captured').sort((a, b) => visitorOrder(a) - visitorOrder(b) || cmp(String(a.id), String(b.id)));
  for (const s of screens) for (const l of Array.isArray(s.links) ? s.links : []) {
    if (!l || l.visible === false || !isNavigation(l)) continue;
    const to = match(l.path);
    if (to) take(to, 'navigation');
  }
  const bySegment = new Map();
  for (const r of candidates) { const k = segmentOf(r); if (!bySegment.has(k)) bySegment.set(k, []); bySegment.get(k).push(r); }
  const inChosen = new Set(chosen.map(segmentOf));
  const segments = [...bySegment.keys()].filter(k => !inChosen.has(k)).sort((a, b) => bySegment.get(b).length - bySegment.get(a).length || cmp(a, b));
  for (const k of segments) {
    const first = bySegment.get(k).slice().sort((a, b) => depthOf(a) - depthOf(b) || Number(isDynamic(a)) - Number(isDynamic(b)) || cmp(a, b))[0];
    take(first, 'section');
  }
  return { routes: chosen, why };
}

// The CLI's one line about a quick run's choice, e.g. "/ (home) · /pricing, /about (home page navigation) · /app (one
// per section)".
export function quickChoice({ routes, why }) {
  const part = (reason, label) => { const rs = routes.filter(r => why[r] === reason); return rs.length ? `${rs.join(', ')} (${label})` : null; };
  return [part('home', 'home'), part('navigation', 'home page navigation'), part('section', 'one per section')].filter(Boolean).join(' · ');
}
