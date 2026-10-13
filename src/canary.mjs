// Canaries (spec §4, H2): known defects planted in copies of a few scenes, so every run can measure how
// many of them the AI hunter finds. The hit rate is an upper bound of recall: a planted defect is cleaner
// than a real one. Pure functions plus one in-page mutator; no I/O, no browser import here (capture.mjs
// runs the mutator, the CLI reads and writes the files).
import { sha, stableJson } from './stable.mjs';

// One entry per mutation kind: the AI lens that owns it and the checklist item a hunter is expected to
// answer with a defect. Kinds follow real defects (the benchmark's AI-lens seeds and field-test findings).
export const CANARY_KINDS = [
  { kind: 'verb-swap', lens: 'L5', checklist: 'L5.same-action-same-verb', what: 'a control names an action with a different verb than the rest of the screen' },
  { kind: 'term-swap', lens: 'L5', checklist: 'L5.same-concept-same-name', what: 'a heading calls a concept by a different name than the rest of the screen' },
  { kind: 'vague-error', lens: 'L6', checklist: 'L6.error-says-what-and-next', what: 'an error message was replaced by "Something went wrong."' },
  { kind: 'vague-confirm', lens: 'L6', checklist: 'L6.confirm-names-object', what: 'a delete confirmation no longer says what is deleted' },
  { kind: 'stray-todo', lens: 'L7', checklist: 'L7.no-dev-leftovers', what: 'a "TODO" note is left in visible copy' },
  { kind: 'blank-state', lens: 'L2', checklist: 'L2.state-explained', what: 'the message that explains an empty, error, loading or offline state is blank' },
  { kind: 'remove-confirm', lens: 'L9', checklist: 'L9.destructive-has-confirm', what: 'a destructive control lost its confirm step (dialog cue or ellipsis)' },
  { kind: 'fixed-cover', lens: 'L10', checklist: 'L10.fixed-not-covering', what: 'a fixed bar covers content in the first view' },
];
const BY_KIND = Object.fromEntries(CANARY_KINDS.map(k => [k.kind, k]));
export const kindInfo = kind => BY_KIND[kind] || null;

export const DEFAULT_CANARIES = 3;
export const canarySceneId = (baseId, k) => `${baseId}.canary-${k}`;

// The seed comes from the run's scope only (routes, persons, viewports, states), never from a clock or a
// random source: the same scope picks the same scenes and kinds.
export function canarySeed(scope) {
  return sha(stableJson({ routes: [...(scope.routes || [])].sort(), persons: [...(scope.persons || [])].sort(), viewports: [...(scope.viewports || [])].sort(), states: [...(scope.states || [])].sort() }));
}

// Scenes a canary may copy: captured screens of their own route (not redirected, not unseen), in seeded
// order, one per route first so the canaries spread over the app.
export function canaryCandidates(entries, seed) {
  const ok = entries.filter(e => e.status === 'captured' && !e.reason && e.canary === undefined);
  const ranked = ok.map(e => ({ e, h: sha(`${seed}:scene:${e.id}`) })).sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.e.id < b.e.id ? -1 : 1)).map(x => x.e);
  const first = []; const rest = []; const routes = new Set();
  for (const e of ranked) { if (routes.has(e.route)) rest.push(e); else { routes.add(e.route); first.push(e); } }
  return [...first, ...rest];
}

// The kinds to try on one scene, in order: kinds not planted yet in this run first, so one run covers
// several lenses. The page decides which of them fits (the first that finds a suitable element).
export function kindOrder(seed, sceneId, used = new Set()) {
  const ranked = CANARY_KINDS.map(k => k.kind).sort((a, b) => {
    const ha = sha(`${seed}:kind:${sceneId}:${a}`), hb = sha(`${seed}:kind:${sceneId}:${b}`);
    return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1;
  });
  return [...ranked.filter(k => !used.has(k)), ...ranked.filter(k => used.has(k))];
}

// Plants up to `count` canaries. `tryScene(entry, kinds, canaryId)` captures a copy of the scene with the
// mutator and resolves to `{ entry, canary }`, or null when no kind fits that page (the copy is then
// discarded and the next candidate is tried, at most 3 × count copies).
export async function plantCanaries({ entries, count, seed, tryScene }) {
  const planted = []; const used = new Set();
  let tries = 0;
  for (const base of canaryCandidates(entries, seed)) {
    if (planted.length >= count || tries >= count * 3) break;
    tries++;
    const k = planted.length + 1;
    const id = canarySceneId(base.id, k);
    const r = await tryScene(base, kindOrder(seed, base.id, used), id);
    if (!r || !r.canary) continue;
    used.add(r.canary.kind);
    const info = kindInfo(r.canary.kind);
    planted.push({
      entry: { ...r.entry, id, canary: k, of: base.id, findings: 0 },
      canary: {
        scene: id, of: base.id, route: base.route, person: base.person, state: base.state, viewport: base.viewport,
        kind: r.canary.kind, lens: info.lens, checklist: info.checklist, what: info.what,
        selector: r.canary.selector, box: r.canary.box, before: r.canary.before, after: r.canary.after,
      },
    });
  }
  return { entries: planted.map(p => p.entry), canaries: planted.map(p => p.canary), tries };
}

// Runs inside the page (serialized by Playwright, so self-contained: no module scope). Tries `kinds` in
// order and applies the first that finds a suitable element; returns where it changed the page
// ({ kind, selector, box, before, after }), or null and leaves the page untouched when none fits.
// The selector is built exactly as collect() builds it, so a hunter's finding can name the same element.
export function canaryMutate({ kinds }) {
  const vis = el => {
    if (!el.getClientRects().length) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.x + scrollX), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; };
  const sel = el => {
    const parts = [];
    let e = el;
    for (let depth = 0; e && e.nodeType === 1 && depth < 5; depth++) {
      let p = e.localName;
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift(`${p}#${e.id}`); break; }
      const tid = e.getAttribute('data-testid');
      if (tid) { parts.unshift(`${p}[data-testid="${tid}"]`); break; }
      const parent = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.localName === e.localName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(p);
      if (p === 'main' || p === 'body') break;
      e = parent;
    }
    return parts.join(' > ');
  };
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const text = el => norm(el.innerText);
  const all = q => [...document.querySelectorAll(q)].filter(vis);
  const CONTROL = 'a[href],button,[role="button"],[role="link"]';
  const FIELD = 'a[href],button,[role="button"],[role="link"],input,select,textarea';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = w => new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(w)})(?=$|[^\\p{L}\\p{N}])`, 'iu');
  const caseLike = (from, to) => (from.length > 1 && from === from.toUpperCase() ? to.toUpperCase() : from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to[0].toLowerCase() + to.slice(1));
  // Replaces the first whole-word `from` in el's text (and its aria-label), keeping child elements.
  const swap = (el, from, to) => {
    const re = word(from);
    let done = false;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n && !done; n = walk.nextNode()) {
      const m = re.exec(n.nodeValue);
      if (!m) continue;
      const at = m.index + m[1].length;
      n.nodeValue = n.nodeValue.slice(0, at) + caseLike(m[2], to) + n.nodeValue.slice(at + m[2].length);
      done = true;
    }
    const label = el.getAttribute('aria-label');
    if (label && re.test(label)) { const m = re.exec(label); const at = m.index + m[1].length; el.setAttribute('aria-label', label.slice(0, at) + caseLike(m[2], to) + label.slice(at + m[2].length)); done = true; }
    return done;
  };
  const disjoint = (a, b) => a !== b && !a.contains(b) && !b.contains(a);
  // The block that holds a matching text node: climbs out of inline wrappers (<strong>Error:</strong> …).
  const blockOf = node => {
    let el = node.parentElement;
    while (el && el !== document.body && getComputedStyle(el).display.startsWith('inline') && el.parentElement) el = el.parentElement;
    return el;
  };
  const messages = (re, max) => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!re.test(n.nodeValue)) continue;
      const p = n.parentElement;
      if (!p || !vis(p) || p.closest('pre,code,kbd,samp,script,style,template,nav,' + FIELD)) continue;
      const b = blockOf(n);
      if (!b || b === document.body || b.localName === 'main' || !vis(b) || b.querySelector(FIELD)) continue;
      const t = text(b);
      if (!t || t.length > max || out.includes(b)) continue;
      out.push(b);
    }
    return out;
  };
  const VERBS = [['Save', 'Submit'], ['Submit', 'Send'], ['Send', 'Submit'], ['Sign in', 'Log in'], ['Log in', 'Sign in'], ['Login', 'Sign in'],
    ['Sign up', 'Register'], ['Register', 'Sign up'], ['Sign out', 'Log out'], ['Log out', 'Sign out'], ['Create', 'Add'], ['Add', 'Create'],
    ['Delete', 'Remove'], ['Remove', 'Delete'], ['Continue', 'Next'], ['Next', 'Continue'], ['Update', 'Save'], ['Edit', 'Modify'],
    ['Search', 'Find'], ['Confirm', 'OK'], ['Upload', 'Attach'], ['Invite', 'Add'], ['Archive', 'Hide'], ['Subscribe', 'Join']];
  const TERMS = [['Tasks', 'To-dos'], ['Task', 'To-do'], ['Notes', 'Memos'], ['Note', 'Memo'], ['Settings', 'Preferences'], ['Projects', 'Workspaces'],
    ['Project', 'Workspace'], ['Account', 'Profile'], ['Profile', 'Account'], ['Dashboard', 'Overview'], ['Messages', 'Inbox'], ['Orders', 'Purchases'],
    ['Customers', 'Clients'], ['Team', 'Group'], ['Reports', 'Analytics'], ['Files', 'Documents'], ['Pricing', 'Plans'], ['Help', 'Support'],
    ['Archive', 'History'], ['Members', 'Users'], ['Products', 'Items'], ['Posts', 'Articles'], ['Events', 'Sessions'], ['Invoices', 'Bills']];
  const ERROR = /\b(errors?|failed|failure|couldn['’]?t|could not|unable to|went wrong|invalid|denied|expired|not found)\b/i;
  const STATE = /\b(no [\p{L}-]+ (yet|found|here)|nothing (here|yet|to show)|your [\p{L}-]+ (is|are) empty|couldn['’]?t load|could not load|failed to load|you['’]?re offline|you are offline|no results|no connection|loading)\b/iu;
  const CONFIRM = /\b(delete|remove|discard|erase|clear)\b[^?!]{1,80}\?/i;
  const DESTRUCTIVE = /\b(delete|remove|clear|discard|erase|reset|destroy|wipe)\b/i;
  const VAGUE = 'Something went wrong.';

  const M = {
    // L5: the same action named with two verbs. Only where the screen uses the verb elsewhere too.
    'verb-swap': () => {
      const controls = all(CONTROL);
      const others = all('h1,h2,h3,h4,label,legend,th,' + CONTROL);
      for (const el of controls) {
        const t = text(el);
        if (!t || t.length > 40) continue;
        for (const [from, to] of VERBS) {
          const re = word(from);
          if (!re.test(t) || word(to).test(t)) continue;
          if (!others.some(o => disjoint(o, el) && re.test(text(o)))) continue;
          if (swap(el, from, to)) return { el, before: t, after: text(el) };
        }
      }
      return null;
    },
    // L5: one concept, two names. A heading renamed while another element keeps the name.
    'term-swap': () => {
      const others = all('a[href],button,[role="button"],[role="tab"],h1,h2,h3,h4,label,th,legend');
      for (const h of all('h1,h2,h3')) {
        const t = text(h);
        if (!t || t.length > 80) continue;
        for (const [from, to] of TERMS) {
          const re = word(from);
          if (!re.test(t) || word(to).test(t)) continue;
          if (!others.some(o => disjoint(o, h) && re.test(text(o)))) continue;
          if (swap(h, from, to)) return { el: h, before: t, after: text(h) };
        }
      }
      return null;
    },
    // L6: an error message that says neither what happened nor what to do.
    'vague-error': () => {
      const roles = all('[role="alert"],[role="status"],[aria-live]').filter(el => ERROR.test(text(el)) && text(el).length <= 240 && !el.querySelector(FIELD));
      for (const el of [...roles, ...messages(ERROR, 240)]) {
        const t = text(el);
        if (t === VAGUE) continue;
        el.textContent = VAGUE;
        return { el, before: t, after: VAGUE };
      }
      return null;
    },
    // L6: a delete confirmation that does not say what is deleted.
    'vague-confirm': () => {
      for (const el of messages(CONFIRM, 200)) {
        const t = text(el);
        el.textContent = 'Are you sure?';
        return { el, before: t, after: 'Are you sure?' };
      }
      return null;
    },
    // L7: a developer note left in the copy.
    'stray-todo': () => {
      const scope = document.querySelector('main') || document.body;
      for (const el of [...scope.querySelectorAll('p,li,dd,figcaption,h2,h3')]) {
        if (!vis(el) || el.closest('nav,header,footer,' + FIELD) || el.querySelector(FIELD)) continue;
        const t = text(el);
        if (t.length < 20 || /\bTODO\b/.test(t)) continue;
        el.appendChild(document.createTextNode(' TODO: replace with final copy'));
        return { el, before: t, after: text(el) };
      }
      return null;
    },
    // L2: the line that tells the user what state the screen is in is gone (a blank line is left, so
    // the element keeps its box).
    'blank-state': () => {
      for (const el of messages(STATE, 200)) {
        const t = text(el);
        el.textContent = '\u00a0';
        return { el, before: t, after: '' };
      }
      return null;
    },
    // L9: a destructive control that announced a confirm step (dialog cue, ellipsis) no longer does.
    'remove-confirm': () => {
      for (const el of all(CONTROL)) {
        const t = text(el) || norm(el.getAttribute('aria-label'));
        if (!DESTRUCTIVE.test(t)) continue;
        const hp = el.getAttribute('aria-haspopup');
        const cues = [];
        if (hp && hp !== 'false') cues.push(`aria-haspopup=${hp}`);
        for (const a of ['aria-controls', 'data-confirm']) if (el.hasAttribute(a)) cues.push(a);
        if (/(…|\.\.\.)\s*$/.test(t)) cues.push('ellipsis');
        if (!cues.length) continue;
        for (const a of ['aria-haspopup', 'aria-controls', 'aria-expanded', 'data-confirm']) el.removeAttribute(a);
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/\s*(…|\.\.\.)(\s*)$/, '$2');
        const label = el.getAttribute('aria-label');
        if (label) el.setAttribute('aria-label', label.replace(/\s*(…|\.\.\.)\s*$/, ''));
        return { el, before: `${t} [${cues.join(', ')}]`, after: text(el) || norm(el.getAttribute('aria-label')) };
      }
      return null;
    },
    // L10: a fixed bar over the bottom of the first view, where the page has content.
    'fixed-cover': () => {
      const band = Math.max(96, Math.round(innerHeight * 0.2));
      const under = all('p,li,a[href],button,input,select,textarea,h1,h2,h3,h4,img,td,label').some(el => { const r = el.getBoundingClientRect(); return r.bottom > innerHeight - band && r.top < innerHeight - 8; });
      if (!under) return null;
      const bar = document.createElement('div');
      bar.setAttribute('style', `position:fixed;left:0;right:0;bottom:0;height:${band}px;z-index:2147483000;box-sizing:border-box;padding:0 16px;background:#ffffff;color:#1d1f23;border-top:1px solid #d0d4da;display:flex;align-items:center;justify-content:center;text-align:center;font:600 16px/1.4 system-ui,sans-serif`);
      bar.textContent = 'Get the app for the full experience';
      document.body.appendChild(bar);
      return { el: bar, before: '', after: bar.textContent };
    },
  };
  for (const kind of kinds) {
    const fn = M[kind];
    const r = fn ? fn() : null;
    if (r) return { kind, selector: sel(r.el), box: box(r.el), before: r.before.slice(0, 160), after: r.after.slice(0, 160) };
  }
  return null;
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────────────

const overlap = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return false;
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min(a[2] * a[3], b[2] * b[3]);
  return smaller > 0 && w * h >= 0.5 * smaller;
};
// Same element, its ancestor or its descendant (selectors share a ' > ' path prefix), or boxes that
// overlap by at least half of the smaller one.
export function sameLocation(f, c) {
  const a = f.selector, b = c.selector;
  if (a && b && (a === b || a.startsWith(b + ' > ') || b.startsWith(a + ' > '))) return true;
  return overlap(f.box, c.box);
}

// A canary is hit when the hunter claimed a defect of the canary's lens on the canary scene at the planted
// element. `exact` says the claim also named the expected checklist item.
export function scoreCanaries(canaryFile, aiFindings) {
  const planted = canaryFile?.planted || [];
  const results = planted.map(c => {
    const hits = aiFindings.filter(f => f.scene === c.scene && f.lens === c.lens && sameLocation(f, c));
    return { scene: c.scene, of: c.of, kind: c.kind, lens: c.lens, checklist: c.checklist, hit: hits.length > 0, exact: hits.some(f => f.rule === c.checklist || f.checklist === c.checklist) };
  });
  const byLens = {};
  for (const r of results) {
    const l = (byLens[r.lens] ||= { planted: 0, hit: 0, rate: 0 });
    l.planted++; if (r.hit) l.hit++;
    l.rate = l.hit / l.planted;
  }
  const hit = results.filter(r => r.hit).length;
  return {
    schema: 1, note: 'canary hit rate is an upper bound of recall: planted defects are easier than real ones',
    planted: results.length, hit, rate: results.length ? hit / results.length : null, byLens, results,
    missed: results.filter(r => !r.hit).map(({ scene, of, kind, lens }) => ({ scene, of, kind, lens })),
  };
}

// A missed canary voids *seen* for the batch that hunted it. coverage.json is written by the hunting
// planner; the shape read here is `units: [{ id, batch?, lens, scenes: [...] | scene, seen }]`. Units of
// that batch get `seen: false, notSeen: 'canary-missed'`; a `canaries` block always records what was
// missed, so nothing depends on the unit shape matching.
export function voidCoverage(coverage, missed) {
  const out = JSON.parse(JSON.stringify(coverage || {}));
  const units = Array.isArray(out.units) ? out.units : [];
  const scenesOf = u => (Array.isArray(u.scenes) ? u.scenes : u.scene ? [u.scene] : []);
  const batchOf = u => u.batch ?? u.id;
  const batches = new Set();
  for (const m of missed) for (const u of units) if (scenesOf(u).includes(m.scene) && (!u.lens || u.lens === m.lens)) batches.add(batchOf(u));
  const voided = [];
  for (const u of units) if (batches.has(batchOf(u))) { u.seen = false; u.notSeen = 'canary-missed'; voided.push(String(u.id ?? batchOf(u))); }
  out.canaries = { missed: missed.map(({ scene, lens, kind }) => ({ scene, lens, kind })), voidedUnits: voided.sort(), voidedBatches: [...batches].map(String).sort() };
  return out;
}
