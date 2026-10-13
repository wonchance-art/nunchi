// Canaries (spec §4, H2): known defects planted in copies of a few scenes, so every run can measure how
// many of them the AI hunter finds. The hit rate is an upper bound of recall: a planted defect is cleaner
// than a real one. Pure functions plus one in-page mutator; no I/O, no browser import here (capture.mjs
// runs the mutator, the CLI reads and writes the files).
import { sha, stableJson } from './stable.mjs';

// One entry per mutation kind: the AI lens that owns it and the checklist item (an id of the built-in lens
// packs, lenses/*.json) a hunter is expected to answer with a defect. Kinds follow real defects (the
// benchmark's AI-lens seeds and field-test findings), and none of them is something a rule lens already
// reports: the lenses tell the hunter not to repeat rule findings, so such a canary could only be missed.
export const CANARY_KINDS = [
  { kind: 'verb-swap', lens: 'L5', checklist: 'L5.same-action-different-verb', what: 'a control names an action with a different verb than the rest of the screen' },
  { kind: 'term-swap', lens: 'L5', checklist: 'L5.same-concept-different-name', what: 'a heading calls a concept by a different name than the rest of the screen' },
  { kind: 'vague-error', lens: 'L6', checklist: 'L6.vague-error', what: 'an error message was replaced by "Something went wrong."' },
  { kind: 'vague-confirm', lens: 'L6', checklist: 'L6.unclear-confirm', what: 'a delete confirmation no longer says what is deleted' },
  { kind: 'template-copy', lens: 'L7', checklist: 'L7.template-copy', what: 'a paragraph of copy was replaced by scaffold text' },
  { kind: 'blank-state', lens: 'L2', checklist: 'L2.what-happened', what: 'the message that explains an empty, error, loading or offline state is blank' },
  { kind: 'remove-confirm', lens: 'L9', checklist: 'L9.destructive-without-confirm', what: 'a destructive control lost its confirm step (dialog cue or ellipsis)' },
  { kind: 'fixed-cover', lens: 'L10', checklist: 'L10.fixed-covers-content', what: 'a fixed bar covers content in the first view' },
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

// Whether a kind can be hunted on a scene at all: its lens is an AI lens of the loaded packs, the lens looks
// at this scene (its `scenes` filter) and so does the expected checklist item. A canary its lens never looks
// at could only be missed. Without lenses (null) every kind applies.
const within = (filter, e) => !filter
  || ((!filter.states || filter.states.includes(e.state))
  && (!filter.viewports || filter.viewports.includes(e.viewport))
  && (!filter.persons || filter.persons.includes(e.person)));
export function kindApplies(kind, entry, lenses) {
  if (!lenses) return true;
  const info = kindInfo(kind);
  const lens = info && lenses.find(l => l.id === info.lens && l.method === 'ai');
  const item = lens && lens.checklist.find(c => c.id === info.checklist);
  return !!item && within(lens.scenes, entry) && within(item.scenes, entry);
}

// Plants up to `count` canaries. `lenses` (the loaded packs) limits each scene to the kinds a lens hunts
// there. `tryScene(entry, kinds, canaryId)` captures a copy of the scene with the
// mutator and resolves to `{ entry, canary }`, or null when no kind fits that page (the copy is then
// discarded and the next candidate is tried, at most 3 × count copies).
export async function plantCanaries({ entries, count, seed, tryScene, lenses = null }) {
  const planted = []; const used = new Set();
  let tries = 0;
  for (const base of canaryCandidates(entries, seed)) {
    if (planted.length >= count || tries >= count * 3) break;
    const kinds = kindOrder(seed, base.id, used).filter(kind => kindApplies(kind, base, lenses));
    if (!kinds.length) continue;                                        // no lens would look for one here
    tries++;
    const k = planted.length + 1;
    const id = canarySceneId(base.id, k);
    const r = await tryScene(base, kinds, id);
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
  const TEMPLATE = 'Add a short description of this section here.';

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
    // L7: scaffold copy where the screen had real copy (not lorem ipsum or TODO: those are rule findings).
    'template-copy': () => {
      const scope = document.querySelector('main') || document.body;
      for (const el of [...scope.querySelectorAll('p,li,dd,figcaption')]) {
        if (!vis(el) || el.closest('nav,header,footer,' + FIELD) || el.querySelector('*')) continue;
        const t = text(el);
        if (t.length < 20 || t === TEMPLATE) continue;
        el.textContent = TEMPLATE;
        return { el, before: t, after: TEMPLATE };
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
      // content the bar would hide: an element whose middle lies inside the band (an element that only grazes
      // the band's top edge stays readable, and a bar over empty space covers nothing)
      const under = all('p,li,a[href],button,input,select,textarea,h1,h2,h3,h4,img,td,label').some(el => { const r = el.getBoundingClientRect(); const mid = r.top + r.height / 2; return mid > innerHeight - band && mid < innerHeight; });
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
// element. `exact` says the claim also named the expected checklist item. With coverage.json, a canary whose
// cell the hunt never saw (cut by the budget, not answered, incomplete) is *not hunted*: it is listed apart and
// counts neither as planted nor as missed, since nobody looked. A cell voided by an earlier miss still counts
// as hunted, so scoring again gives the same result.
export function scoreCanaries(canaryFile, aiFindings, coverage = null) {
  const cells = Array.isArray(coverage?.cells) ? coverage.cells : null;
  const hunted = c => !cells || cells.some(x => x.scene === c.scene && x.lens === c.lens && (x.status === 'seen' || x.reason === 'canary-missed'));
  const all = canaryFile?.planted || [];
  const notHunted = all.filter(c => !hunted(c)).map(c => {
    const cell = cells.find(x => x.scene === c.scene && x.lens === c.lens);
    return { scene: c.scene, of: c.of, kind: c.kind, lens: c.lens, reason: cell?.reason || 'not-planned' };
  });
  // A claim grounded in an aria node or only in source has no box to compare: it counts when it names the
  // expected checklist item. If the scene the copy came from has a claim of that item too, the hunter flagged
  // something both share, and the copy cannot tell a planted defect from one the screen already had: such a
  // canary is *ambiguous*, listed apart and left out of the rate, like a canary nobody hunted.
  const unlocated = f => !f.box && (!f.selector || f.selector.startsWith('aria='));
  const ambiguous = [];
  const results = [];
  for (const c of all.filter(hunted)) {
    const mine = aiFindings.filter(f => f.scene === c.scene && f.lens === c.lens);
    const placed = mine.filter(f => sameLocation(f, c));
    const byItem = mine.filter(f => unlocated(f) && f.rule === c.checklist);
    const shared = aiFindings.some(g => g.scene === c.of && g.lens === c.lens && g.rule === c.checklist);
    if (!placed.length && byItem.length && shared) { ambiguous.push({ scene: c.scene, of: c.of, kind: c.kind, lens: c.lens, reason: 'the original has the same claim' }); continue; }
    const hits = [...placed, ...byItem];
    results.push({ scene: c.scene, of: c.of, kind: c.kind, lens: c.lens, checklist: c.checklist, hit: hits.length > 0, exact: hits.some(f => f.rule === c.checklist || f.checklist === c.checklist) });
  }
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
    ...(notHunted.length ? { notHunted } : {}),
    ...(ambiguous.length ? { ambiguous } : {}),
  };
}

// A missed canary voids *seen* for its batch: every cell of coverage.json (as `hunt --record` writes it)
// whose batch (one lens on one route) hunted the missed copy becomes `not-seen`, reason `canary-missed`,
// and the summary is counted again. A `canaries` block always records what was missed.
export function voidCoverage(coverage, missed) {
  const out = JSON.parse(JSON.stringify(coverage || {}));
  const cells = Array.isArray(out.cells) ? out.cells : [];
  const batches = new Set();
  for (const m of missed) for (const c of cells) if (c.scene === m.scene && c.lens === m.lens && c.batch) batches.add(c.batch);
  const units = new Set();
  for (const c of cells) {
    if (!batches.has(c.batch)) continue;
    if (c.unit) units.add(c.unit);
    c.status = 'not-seen'; c.reason = 'canary-missed';
  }
  if (out.summary && cells.length) {
    const notSeen = {};
    for (const c of cells) if (c.status !== 'seen') notSeen[c.reason] = (notSeen[c.reason] || 0) + 1;
    const byUnit = new Map();
    for (const c of cells) if (c.unit) byUnit.set(c.unit, (byUnit.get(c.unit) ?? true) && c.status === 'seen');
    out.summary = { ...out.summary, seen: cells.filter(c => c.status === 'seen').length, notSeen, units: { ...out.summary.units, seen: [...byUnit.values()].filter(Boolean).length } };
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  out.canaries = { missed: missed.map(({ scene, lens, kind }) => ({ scene, lens, kind })), voidedUnits: [...units].sort(cmp), voidedBatches: [...batches].sort(cmp) };
  return out;
}
