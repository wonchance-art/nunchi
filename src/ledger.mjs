// Ledger (spec §5, revised by the board review N1/N2/N5/N7/N8): what was found, what the person decided,
// and what became of it.
//
// - fingerprint: one defect, wherever and however often it shows. route template + rule + the element
//   (selector without positions or generated class names) + evidence with volatile values removed. Person,
//   viewport and state are not part of it: the same defect seen on the phone and on the desktop is one.
// - group: the fingerprint without the route. A shared component's defect on 17 screens is one group,
//   which is the unit a person decides on and the fix loop fixes.
// - decisions are append-only event files under .nunchi/decisions/ (committed; never conflict on merge),
//   each with who made it. A decision that arrived through git and was not made or approved on this
//   machine is "unverified": it cannot silence a blocker or a secret, and the fix loop does not act on it.
//   Approval is bound to the decision's content (SHA-256), not to its id; decisions are ordered by the earlier
//   of their date and when this machine first saw them.
// - status (open, fixed, regressed, …) is computed from runs into .nunchi/state/ledger.json (git-ignored),
//   never hand-edited and never committed. Every complete run is folded, in run order, like for like.
import { readFileSync, readdirSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha, stableJson, writeAtomic, withLock } from './stable.mjs';
import { listRuns } from './runs.mjs';

// Fingerprint versions (spec §5). A version changes the recipe of some rules only; every other rule keeps its
// version-1 recipe, so its fingerprints, and the decisions made on them, are untouched.
// - v2 (2026-10-14 KST): secret-in-client-bundle ignores the bundle's content hash (bundleKey). A v1 state is
//   migrated on read and v1 decisions follow their items (migrateState, currentTargets).
export const FINGERPRINT_VERSION = 2;
const SECRET = 'secret-in-client-bundle';
const RECIPE = { [SECRET]: 2 };
const recipeOf = (rule, version) => Math.min(version, RECIPE[rule] || 1);

// A build names a bundle after its content, so a rebuild that leaves a secret in place renames the file. Only a
// hash-like part of the file name becomes `[hash]`; folders, words and words with a number (`checkout2`) stay,
// so two bundles never become one:
// - Turbopack: the whole name is 13 characters of [0-9a-z_-] with a digit (`1grrdrpshlkcw.js`);
// - Vite/Rollup, esbuild: a `-<8 characters>` suffix with a digit, `_`, `-` or an inner capital (`index-Boalzs1w.js`);
// - webpack, CRA, Parcel, and Turbopack's own runtime: a `-`/`.`-separated part of 8+ letters and digits that is
//   lower-case hex or has a digit between letters (`page-4f1c2a9b8e7d6c5b.js`, `main.8f3e2a1b.js`).
const hashPart = p => p.length >= 8 && (/^[0-9a-f]+$/.test(p) || /[A-Za-z][0-9]+[A-Za-z]/.test(p));
export function bundleKey(path) {
  const s = String(path), cut = s.lastIndexOf('/') + 1;
  const dir = s.slice(0, cut), m = /^(.+?)((?:\.[A-Za-z0-9]{1,5})?)$/.exec(s.slice(cut));
  if (!m) return s;
  const [, stem, ext] = m;
  if (/^[0-9a-z_-]{13}$/.test(stem) && /\d/.test(stem)) return `${dir}[hash]${ext}`;
  const vite = /^(.+)-([A-Za-z0-9_-]{8})$/.exec(stem);
  if (vite && (/[0-9_-]/.test(vite[2]) || /.[A-Z]/.test(vite[2]))) return `${dir}${vite[1]}-[hash]${ext}`;
  return dir + stem.split(/([-.])/).map(p => (hashPart(p) ? '[hash]' : p)).join('') + ext;
}

// Positions, framework ids and generated class names change without the element changing.
export function normalizeSelector(sel) {
  if (!sel) return null;
  return String(sel)
    .replace(/:nth-(of-type|child|last-child|last-of-type)\([^)]*\)/g, '')
    .replace(/:r[\w-]*:|«r[\w-]*»/g, ':r:')                               // React useId / Radix ids
    .replace(/\.(css|sc|jsx|emotion|svelte)-[\w-]+/g, '')                 // emotion, styled-components, styled-jsx, svelte
    .replace(/(\.[A-Za-z][\w-]*?)__[\w-]{5,}/g, '$1')                     // CSS modules: .Button_primary__a1B2c
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// Evidence keys that describe the measurement, not the defect (they move when nothing changed).
const VOLATILE = new Set(['note', 'desktopScene', 'comparedWith', 'screensChecked', 'usualScreens', 'usual', 'scrollWidth', 'clientWidth', 'viewportWidth',
  'width', 'height', 'threshold', 'minimum', 'recommended', 'box', 'onPhone', 'path', 'masked', 'status']);
// Per rule, text that quotes the page's data is dropped (the kind is what matters).
const DROP_TEXT = new Set(['missing-value', 'placeholder-text', 'coming-soon-sprawl']);
const norm = v => (typeof v === 'number' ? (v <= 0 ? 0 : 2 ** Math.round(Math.log2(v)))
  : typeof v === 'string' ? v.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100)
  : Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? evidenceKey(null, v) : v);
export function evidenceKey(rule, evidence = {}, version = FINGERPRINT_VERSION) {
  const out = {};
  for (const k of Object.keys(evidence || {}).sort()) {
    if (VOLATILE.has(k)) continue;
    if (k === 'text' && DROP_TEXT.has(rule)) continue;
    if (k === 'url' || k === 'href' || k === 'src' || k === 'finalPath') {
      const path = String(evidence[k]).split(/[?#]/)[0];
      out[k] = norm(rule === SECRET && k === 'url' && recipeOf(rule, version) >= 2 ? bundleKey(path) : path);
      continue;
    }
    out[k] = norm(evidence[k]);
  }
  return out;
}

// `version` computes an older version's fingerprint (migration); new findings always get the current one.
export function fingerprintOf(f, version = FINGERPRINT_VERSION) {
  const v = recipeOf(f.rule, version);
  const inputs = { v, lens: f.lens, rule: f.rule, route: f.route ?? null, element: normalizeSelector(f.selector), evidence: evidenceKey(f.rule, f.evidence, version) };
  const { route, ...rest } = inputs;
  // Low contrast has one cause however many elements show it: the colour pair (a design token).
  const pair = f.rule === 'axe-color-contrast' && /foreground color: (#[0-9a-f]{3,8}), background color: (#[0-9a-f]{3,8})/i.exec(f.evidence?.summary || '');
  const groupInputs = pair ? { v, rule: f.rule, colors: [pair[1].toLowerCase(), pair[2].toLowerCase()] } : rest;
  return { fp: sha(stableJson(inputs), 12), group: sha(stableJson(groupInputs), 12), inputs };
}

// v1 → v2 on read. Items of a rule whose recipe changed get their fingerprint and group recomputed from what
// they stored (lens, rule, route, selector, evidence); items that now share a fingerprint merge (the latest
// seen one stays, first seen is the earliest); `aliases` keeps old → new so decisions made under v1 keep
// applying. The characters of a secret that v1 stored (`evidence.masked`) are dropped.
const SEEN_ORDER = (a, b) => (a.lastSeen > b.lastSeen ? -1 : a.lastSeen < b.lastSeen ? 1 : !a.goneAt !== !b.goneAt ? (a.goneAt ? 1 : -1) : a.fp < b.fp ? -1 : 1);
export function migrateState(state) {
  if (!state || !state.items || (state.fingerprintVersion || 1) >= FINGERPRINT_VERSION) return state;
  const aliases = { fp: { ...(state.aliases?.fp || {}) }, group: { ...(state.aliases?.group || {}) } };
  const items = {};
  for (const old of Object.values(state.items).sort(SEEN_ORDER)) {
    if (recipeOf(old.rule, FINGERPRINT_VERSION) === recipeOf(old.rule, state.fingerprintVersion || 1)) { items[old.fp] = old; continue; }
    const { masked, ...evidence } = old.evidence || {};
    const { fp, group, inputs } = fingerprintOf({ ...old, evidence });
    if (fp !== old.fp) aliases.fp[old.fp] = fp;
    if (group !== old.group) aliases.group[old.group] = group;
    const have = items[fp];
    const union = k => [...new Set([...(have?.[k] || []), ...(old[k] || [])])].sort();
    items[fp] = !have ? { ...old, fp, group, evidence, inputs }
      : { ...have, firstSeen: old.firstSeen < have.firstSeen ? old.firstSeen : have.firstSeen, persons: union('persons'), viewports: union('viewports'), states: union('states') };
  }
  return { ...state, fingerprintVersion: FINGERPRINT_VERSION, items, aliases };
}

// A decision names the fingerprint or group it was made on. One made under an older version follows its item:
// through the migrated state's aliases, or, for a decision from another machine, by the old fingerprint of
// what this state holds now. A moved decision keeps its id and carries `targetWas`; writtenAs(moved) is the
// decision as its file holds it, whose content approvals and first-seen times name.
const WRITTEN = new WeakMap();
export const writtenAs = d => WRITTEN.get(d) || d;
export function currentTargets(decisions, state) {
  const fp = new Map(Object.entries(state?.aliases?.fp || {})), group = new Map(Object.entries(state?.aliases?.group || {}));
  for (const item of Object.values(state?.items || {})) {
    if (recipeOf(item.rule, FINGERPRINT_VERSION) === 1) continue;
    const old = fingerprintOf(item, 1);
    if (old.fp !== item.fp && !fp.has(old.fp)) fp.set(old.fp, item.fp);
    if (old.group !== item.group && !group.has(old.group)) group.set(old.group, item.group);
  }
  const moved = decisions.map(d => {
    const t = d.target || {};
    if ((d.fingerprintVersion || 1) >= FINGERPRINT_VERSION) return d;
    const to = t.fp && fp.has(t.fp) ? { fp: fp.get(t.fp) } : t.group && group.has(t.group) ? { group: group.get(t.group) } : null;
    if (!to) return d;
    const m = { ...d, target: to, targetWas: t };
    WRITTEN.set(m, d);
    return m;
  });
  // Items merged by the migration whose old decisions disagree (one dismissed, another to fix, hold or reopen):
  // the dismissal does not carry over, so the item stays visible. Open beats dismissed.
  const key = t => (t.fp ? `fp:${t.fp}` : `group:${t.group}`);
  const lastByOld = new Map();                            // new target → old target → its latest moved decision
  for (const d of moved) if (d.targetWas) {
    const k = key(d.target);
    if (!lastByOld.has(k)) lastByOld.set(k, new Map());
    lastByOld.get(k).set(key(d.targetWas), d);
  }
  const DISMISS = new Set(['keep', 'false-positive']);
  const conflicted = new Set([...lastByOld].filter(([, olds]) => {
    const kinds = [...olds.values()].map(d => DISMISS.has(d.decision));
    return kinds.includes(true) && kinds.includes(false);
  }).map(([k]) => k));
  return moved.filter(d => !(d.targetWas && conflicted.has(key(d.target)) && DISMISS.has(d.decision)));
}

export function annotate(findings) {
  return findings.map(f => { const { fp, group } = fingerprintOf(f); return { ...f, fp, group }; });
}

// Short names for people (the board and the CLI). Rule ids stay the stable key.
export const TITLES = {
  'horizontal-overflow': 'Page is wider than the screen', 'clipped-text': 'Text cut off without an ellipsis', 'broken-image': 'Image does not load',
  'page-error': 'JavaScript error on the page', 'failed-request': 'A request the page needs fails', 'http-status': 'Page answers with an error status',
  'font-not-loaded': 'Web font failed to load', 'layout-shift': 'Content jumps while loading', 'blank-state': 'Nothing on screen in this state',
  'error-looks-empty': 'An error looks like an empty list', 'no-offline-notice': 'Going offline changes nothing on screen',
  'raw-error-text': 'Raw error message shown to users', 'missing-value': 'undefined / NaN / template text on screen', 'native-dialog': 'Browser alert or confirm box',
  'placeholder-text': 'Placeholder text left in', 'coming-soon-sprawl': '"Coming soon" in many places', 'dead-href': 'Link that goes nowhere (#)',
  'target-size-min': 'Tap target smaller than 24px', 'target-size-recommended': 'Small for a finger (under 44px)', 'placeholder-as-label': 'Field labelled only by its placeholder',
  'secret-in-client-bundle': 'Secret key in the browser bundle', 'link-to-missing-route': 'Link to a page that does not exist', 'redirect-loop': 'Redirect loop',
  'signed-in-bounced': 'Signed-in user sent to the sign-in page', 'unreachable-route': 'No link leads to this page', 'dead-end': 'Screen with no way onward',
  'one-off-button-shape': 'Button shape used on one screen only', 'one-off-heading-size': 'Heading size used on one screen only',
  'one-off-heading-color': 'Heading colour used on one screen only', 'missing-on-phone': 'On desktop, missing on the phone',
};
export const titleOf = rule => TITLES[rule] || (rule.startsWith('axe-') ? `Accessibility: ${rule.slice(4).replace(/-/g, ' ')}` : rule);

const SEVERITY = { blocker: 0, high: 1, medium: 2, low: 3 };

// ---- reading nunchi's own files -----------------------------------------------------------------------

// A file nunchi wrote and can no longer read is an error, never "empty": an empty ledger or approval list
// written back over it would lose what it held. A checkout can put anything at these paths: a link (to a
// secret, or to a device that never ends) is refused, not followed; a decision has a size cap; and a parse error
// is reported by its position only, never with the file's text.
const corrupt = (file, why) => Object.assign(new Error(`${file} ${why}`), { code: 'CORRUPT', file });
const NOFOLLOW = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const present = p => { try { lstatSync(p); return true; } catch { return false; } };
export function readJsonFile(file, fix, { max = Infinity } = {}) {
  let st;
  try { st = lstatSync(file); } catch (e) { throw corrupt(file, `cannot be read (${e.code}): ${fix}`); }
  if (!st.isFile()) throw corrupt(file, `is not a regular file (a link, a folder or a device): ${fix}`);
  let fd, buf;
  try { fd = openSync(file, constants.O_RDONLY | NOFOLLOW); } catch (e) { throw corrupt(file, `cannot be read (${e.code}): ${fix}`); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) throw corrupt(file, `is not a regular file (a link, a folder or a device): ${fix}`);
    if (s.size > max) throw corrupt(file, `is larger than ${max} bytes: ${fix}`);
    buf = readFileSync(fd);
  } finally { closeSync(fd); }
  if (buf.length > max) throw corrupt(file, `is larger than ${max} bytes: ${fix}`);
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { const at = /position (\d+)/.exec(String(e.message)); throw corrupt(file, `is not valid JSON${at ? ` (at character ${at[1]})` : ''}: ${fix}`); }
}

// ---- state (local, computed) ------------------------------------------------------------------------

const REBUILD = 'delete it and the next nunchi command rebuilds it from the runs on disk';

// A state written by an older fingerprint version is migrated as it is read (migrateState); syncLedger, which
// reads it again under the ledger lock, writes the migrated state back.
const MIGRATED = new WeakSet();
export function readState(file) {
  if (!present(file)) return { schema: 1, fingerprintVersion: FINGERPRINT_VERSION, runs: [], items: {} };
  const s = readJsonFile(file, REBUILD);
  if (!s || !Array.isArray(s.runs) || !s.items || typeof s.items !== 'object') throw corrupt(file, `is not a nunchi ledger: ${REBUILD}`);
  const m = migrateState(s);
  if (m !== s) MIGRATED.add(m);
  return m;
}

// Run ids are digits, zero-padded to 4 and longer past 9999: shorter is older.
export const byRun = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const minRun = (a, b) => (byRun(a, b) <= 0 ? a : b);
const maxRun = (a, b) => (!a ? b : byRun(a, b) >= 0 ? a : b);

// A cell is where a finding was seen on its route: person.state.viewport (the end of the scene id). A key is
// route|cell, what a run looked at.
const cellOfScene = id => { const [person, state, vp] = String(id).split('.').slice(-3); return person && state && vp ? { person, state, vp, cell: `${person}.${state}.${vp}` } : null; };
const keyOf = (route, cell) => `${route}|${cell}`;
const routeOfKey = k => k.slice(0, k.lastIndexOf('|'));
// Scenes that show their own route: captured, not redirected, not an error page, not a canary copy.
const looked = s => s.status === 'captured' && s.canary === undefined && !s.redirected && !/^redirected/.test(s.reason || '') && !(s.httpStatus >= 400);
// Whole-app detectors judge every route at once (secrets in any bundle, the link graph, the design system's
// one-offs): an item of theirs keeps what the runs that saw it looked at (`coverage`), and only a whole-app run
// that looked at all of it again can say it is gone.
const WHOLE_APP = new Set(['secret-in-client-bundle', 'unreachable-route', 'link-to-missing-route', 'one-off-button-shape', 'one-off-heading-size', 'one-off-heading-color']);
const wholeAppItem = item => item.route === null || WHOLE_APP.has(item.rule);
// A comparison needs its other side seen again too: parity compares the phone with the desktop, the state
// rules compare two states of the same screen.
const PARTNER = {
  'missing-on-phone': ([p, s]) => `${p}.${s}.d`,
  'error-looks-empty': ([p, , v]) => `${p}.empty.${v}`,
  'no-offline-notice': ([p, , v]) => `${p}.normal.${v}`,
};
// Items folded before cells were stored: every combination of what they were seen with (asks for more, never less).
const cellsOf = item => item.cells || (item.persons || []).flatMap(p => (item.states || []).flatMap(s => (item.viewports || []).map(v => `${p}.${s}.${v}`)));
export const originOf = url => { try { return new URL(url).origin; } catch { return null; } };
// A run whose screens mostly show one and the same text (another app, or one error page, at that address)
// fixes nothing when it would fix many items at once.
const ONE_PAGE = { items: 10, share: 0.5 };
function onePage(scenes) {
  const hashes = scenes.filter(looked).map(s => s.textHash).filter(Boolean);
  if (hashes.length < 4) return false;
  const count = new Map();
  for (const h of hashes) count.set(h, (count.get(h) || 0) + 1);
  return Math.max(...count.values()) > ONE_PAGE.share * hashes.length;
}

// Did this run look again, like for like, everywhere the item was last seen?
function lookedAgain(item, run, sets) {
  if ('origin' in item && item.origin !== run.origin) return false;           // another app, or another address
  const cells = cellsOf(item);
  const need = new Set(cells.map(c => keyOf(item.route, c)));
  if (PARTNER[item.rule]) for (const c of cells) need.add(keyOf(item.route, PARTNER[item.rule](c.split('.'))));
  if (wholeAppItem(item)) {
    if (!run.wholeApp) return false;
    if (item.coverage && !sets[item.coverage]) return false;
    // routes the app no longer has are not asked for
    for (const k of item.coverage ? sets[item.coverage] : []) if (run.appRoutes.has(routeOfKey(k))) need.add(k);
  } else if (!cells.length) return false;
  for (const k of need) {
    if (run.loginExpired && k.slice(k.lastIndexOf('|') + 1).startsWith('signed-in.')) return false;
    if (!run.covered.has(k)) return false;
  }
  return true;
}

const setId = keys => sha(JSON.stringify(keys), 16);

// Fold one complete run into the state (design 0.1-c §2.1).
// - Gone only like for like: an item gets `goneAt` only when this run, at the same origin, captured every cell it
//   was seen in (captured and showing its own route), ran its detector over the same scope (whole-app detectors:
//   a whole-app run that looked at everything the runs that saw the item looked at; parity and state comparisons:
//   both sides), and the app was reachable and the recording current; signed-in cells also need the login working.
//   A partial run (--states, --viewports, --routes, --changed-since, a skipped route) fixes nothing it did not
//   look at, and a sighting by a narrower run keeps the cells it did not look at.
// - Monotonic: a run older than the newest folded run only adds what it saw. It never sets `goneAt`, never moves
//   `lastSeen` back, and brings an item back only when it saw it after the last run that looked at it.
// - `lookedAt`: the last run that looked at every cell of the item (or saw it).
// - A run that would fix many items at once while most of its screens show the same text fixes nothing.
// - Folding the same run twice changes nothing.
export function foldRun(state, { id, scope = {}, wholeApp = false, health = { problems: [] }, scenes = [], findings, origin = null }) {
  if (state.runs.includes(id)) return state;
  const newest = !state.runs.some(r => byRun(r, id) > 0);
  const sets = { ...(state.coverage || {}) };
  const next = { ...state, runs: [...state.runs, id].sort(byRun), items: { ...state.items } };
  const covered = [...new Set(scenes.filter(looked).map(s => keyOf(s.route, `${s.person}.${s.state}.${s.viewport}`)))].sort();
  const coveredSet = new Set(covered);
  const appRoutes = new Set(scope.routes || []);
  // A route an earlier run looked at that this run did not (it failed, answered an error or redirected this
  // time) makes the run partial. A route no run has looked at (always broken, always redirected, or a path
  // discover cannot resolve, recorded as `unresolved` in run.json) does not: no whole-app item can have been
  // seen there, and the per-item coverage guards the rest.
  const seenBefore = new Set(state.seenRoutes || []);
  const seenNow = new Set(scenes.filter(looked).map(s => s.route));
  const whole = wholeApp === true && ![...appRoutes].some(r => seenBefore.has(r) && !seenNow.has(r));
  next.seenRoutes = [...new Set([...seenBefore, ...seenNow])].sort();
  const here = setId(covered);
  // what a whole-app item asks for after this sighting: what this run looked at, plus what earlier sightings
  // looked at that this run did not (minus routes the app no longer has, which only a whole-app run can tell)
  const merged = new Map();
  const coverageAfter = old => {
    if (!old || !sets[old]) return (sets[here] = covered, here);
    if (!merged.has(old)) {
      const keys = [...new Set([...covered, ...sets[old].filter(k => !coveredSet.has(k) && (!whole || appRoutes.has(routeOfKey(k))))])].sort();
      const h = setId(keys);
      sets[h] = keys;
      merged.set(old, h);
    }
    return merged.get(old);
  };
  const seen = new Map();
  for (const f of findings) {
    if (!seen.has(f.fp)) seen.set(f.fp, { f, persons: new Set(), viewports: new Set(), states: new Set(), cells: new Set(), scenes: [] });
    const p = seen.get(f.fp);
    const c = f.scene ? cellOfScene(f.scene) : null;
    if (c) { p.persons.add(c.person); p.states.add(c.state); p.viewports.add(c.vp); p.cells.add(c.cell); }
    if (f.scene && p.scenes.length < 20) p.scenes.push(f.scene);
  }
  for (const [fp, p] of seen) {
    const old = next.items[fp];
    const route = p.f.route ?? null;
    const base = { fp, group: p.f.group, lens: p.f.lens, rule: p.f.rule, severity: p.f.severity, route, origin,
      persons: [...p.persons].sort(), viewports: [...p.viewports].sort(), states: [...p.states].sort(), places: p.scenes.length, examples: p.scenes.slice(0, 5),
      selector: p.f.selector ?? null, evidence: p.f.evidence, inputs: fingerprintOf(p.f).inputs };
    const cellsNow = [...p.cells].sort();
    if (!old) {
      next.items[fp] = { ...base, cells: cellsNow, ...(wholeAppItem(base) ? { coverage: coverageAfter(null) } : {}), firstSeen: id, lastSeen: id, lookedAt: id, goneAt: null, regressedAt: null };
      continue;
    }
    const later = byRun(id, old.lastSeen) > 0;                                    // a newer sighting than the one on record
    const back = !!old.goneAt && byRun(id, old.lookedAt || old.goneAt) > 0;        // seen after the last run that looked
    const item = { ...old, firstSeen: minRun(old.firstSeen, id), lastSeen: later ? id : old.lastSeen, lookedAt: maxRun(old.lookedAt, id),
      goneAt: back ? null : old.goneAt, regressedAt: back ? id : old.regressedAt };
    if (later) {
      Object.assign(item, base);
      // cells this run did not look at stay: the item may still be there
      item.cells = back ? cellsNow : [...new Set([...cellsNow, ...cellsOf(old).filter(c => !coveredSet.has(keyOf(route, c)))])].sort();
      if (wholeAppItem(base)) item.coverage = coverageAfter(back ? null : old.coverage);
    }
    next.items[fp] = item;
  }
  const blind = (health.problems || []).map(p => p.status).filter(s => s === 'app-unreachable' || s === 'recording-stale');
  if (newest && blind.length) next.blind = { ...(state.blind || {}), [id]: blind[0] };
  else if (newest) {
    const run = { scope, wholeApp: whole, appRoutes, origin, covered: coveredSet, loginExpired: (health.problems || []).some(p => p.status === 'login-expired') };
    const lookedAt = [], gone = [];
    for (const [fp, item] of Object.entries(next.items)) {
      if (seen.has(fp) || !lookedAgain(item, run, sets)) continue;
      lookedAt.push(fp);
      if (!item.goneAt) gone.push(fp);
    }
    const open = Object.values(state.items).filter(i => !i.goneAt).length;
    if (gone.length >= ONE_PAGE.items && gone.length > ONE_PAGE.share * open && onePage(scenes)) next.blind = { ...(state.blind || {}), [id]: 'one-page' };
    else {
      for (const fp of lookedAt) next.items[fp] = { ...next.items[fp], lookedAt: id };
      for (const fp of gone) next.items[fp] = { ...next.items[fp], goneAt: id };
    }
  }
  // keep only the coverage sets an item still names
  const used = new Set(Object.values(next.items).map(i => i.coverage).filter(Boolean));
  next.coverage = Object.fromEntries(Object.entries(sets).filter(([h]) => used.has(h)));
  return next;
}

// What a complete run folder gives the fold. A file of it that cannot be read is an error: a run is never
// skipped quietly, or the ledger would say nothing about what it saw.
export function runForFold(runDir) {
  const fix = `fix or remove the run folder ${runDir}`;
  const meta = readJsonFile(join(runDir, 'run.json'), fix);
  const manifest = readJsonFile(join(runDir, 'manifest.json'), fix);
  const doc = readJsonFile(join(runDir, 'findings.json'), fix);
  if (!Array.isArray(manifest?.scenes) || !Array.isArray(doc?.findings)) throw corrupt(runDir, `is not a complete capture run (no scenes in manifest.json or no findings in findings.json): ${fix}`);
  return { id: basename(runDir), scope: meta?.scope || {}, wholeApp: meta?.wholeApp === true, health: manifest.health || { problems: [] }, scenes: manifest.scenes,
    origin: originOf(manifest.baseUrl), findings: doc.findings.map(f => (f.fp ? f : { ...f, fp: fingerprintOf(f).fp, group: fingerprintOf(f).group })) };
}

// When this machine first saw each decision, by id and content (design §8.3 first-seen ordering). Never
// forgotten, so a decision that leaves and comes back keeps its first arrival.
export function noteDecisions(state, decisions, now = Date.now()) {
  const seen = state.decisionsSeen || {};
  const fresh = decisions.map(approvalKey).filter(k => !Object.hasOwn(seen, k));
  if (!fresh.length) return state;
  const out = { ...seen };
  for (const k of fresh) out[k] = now;
  return { ...state, decisionsSeen: out };
}

// Brings the ledger up to date, under the ledger lock: every complete run not folded yet is folded, oldest
// first, and (with `decisions`) every decision not seen before is noted. A crash after a run is complete and
// before its fold leaves nothing behind: the next command folds it. A state of an older fingerprint version is
// written back migrated. Nothing to do: nothing is written.
export function syncLedger(stateFile, runsDir, { decisions = null, now = Date.now(), timeoutMs } = {}) {
  const pending = s => listRuns(runsDir).complete.filter(id => !s.runs.includes(id)).sort(byRun);
  const unseen = s => !!decisions && decisions.some(d => !Object.hasOwn(s.decisionsSeen || {}, approvalKey(d)));
  const state = readState(stateFile);
  if (!pending(state).length && !unseen(state) && !MIGRATED.has(state)) return state;
  return withLock(stateFile, lock => {
    let s = readState(stateFile);
    for (const id of pending(s)) { s = foldRun(s, runForFold(join(runsDir, id))); lock.touch(); }
    if (decisions) s = noteDecisions(s, decisions, now);
    writeAtomic(stateFile, stableJson(s), { durable: true });
    return s;
  }, { timeoutMs });
}

// ---- decisions (committed, append-only) ------------------------------------------------------------

export const DECISIONS = {
  fix: [],
  keep: ['intended', 'out-of-scope'],
  'false-positive': ['not-a-problem', 'wrong-place'],
  hold: [],
  reopen: [],
};

const folderOf = target => (target.fp ? `fp-${target.fp}` : `group-${target.group}`);
const isDecision = d => !!d && typeof d === 'object' && typeof d.id === 'string' && /^[\w-]+$/.test(d.id) && !!d.target && typeof d.target === 'object'
  && (typeof d.target.fp === 'string' || typeof d.target.group === 'string') && Object.hasOwn(DECISIONS, d.decision) && typeof d.at === 'string';
const dateOf = d => Date.parse(d.at);
// For listing: by date (an unreadable date last), then id.
const byDate = (a, b) => { const x = dateOf(a), y = dateOf(b); return (Number.isNaN(x) ? Infinity : x) - (Number.isNaN(y) ? Infinity : y) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); };
export const DECISION_MAX_BYTES = 64 * 1024;

// Every decision file, oldest first. A file that is not valid JSON (a torn write, a bad merge), is not a
// decision, is not a regular file, or does not match its place (file name = id, folder = target) is an error
// naming the file, never skipped: a decision that silently drops out changes what the ledger says.
export function readDecisions(dir) {
  const out = [];
  if (!present(dir)) return out;
  const fix = 'restore it from git or delete it';
  for (const folder of readdirSync(dir).sort()) {
    const sub = join(dir, folder);
    const st = lstatSync(sub);
    if (st.isSymbolicLink()) throw corrupt(sub, `is a link, not a folder (decision folders are never followed): ${fix}`);
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(sub).filter(f => f.endsWith('.json')).sort()) {
      const file = join(sub, f);
      const d = readJsonFile(file, `a torn write or a bad merge; ${fix}`, { max: DECISION_MAX_BYTES });
      if (!isDecision(d)) throw corrupt(file, `is not a nunchi decision: ${fix}`);
      if (`${d.id}.json` !== f || folderOf(d.target) !== folder) throw corrupt(file, `does not match its place (decision ${d.id} belongs in ${folderOf(d.target)}/${d.id}.json): moved, copied or edited by hand; ${fix}`);
      out.push(d);
    }
  }
  return out.sort(byDate);
}

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00');

export function buildDecision({ target, decision, reason = null, note = null, by }) {
  if (!DECISIONS[decision]) throw Object.assign(new Error(`unknown decision "${decision}" (${Object.keys(DECISIONS).join(', ')})`), { code: 'BAD_ARGS' });
  const reasons = DECISIONS[decision];
  if (reasons.length && !reasons.includes(reason)) throw Object.assign(new Error(`"${decision}" needs --reason ${reasons.join(' | ')}`), { code: 'BAD_ARGS' });
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  return { schema: 1, id, target, decision, reason, note: note ? String(note).slice(0, 500) : null, by, at: kst(), fingerprintVersion: FINGERPRINT_VERSION };
}

// Committed and shared: written to a temp file, synced, then renamed into place.
export function saveDecision(dir, d) {
  writeAtomic(join(dir, folderOf(d.target), `${d.id}.json`), stableJson(d), { durable: true });
  return d;
}

export const writeDecision = (dir, input) => saveDecision(dir, buildDecision(input));

// ---- provenance --------------------------------------------------------------------------------------
// An approval names a decision's content, not only its id: `<id>:<SHA-256 of the record>`. A decision file that
// reuses an approved id with other content (copied, edited or forged) is not approved.
export const decisionHash = d => sha(stableJson(d), 64);
export const approvalKey = d => `${d.id}:${decisionHash(d)}`;
const APPROVED_FIX = 'nothing was written; fix it by hand, or delete it (decisions made here then need nunchi approve again)';

function readApprovedDoc(file) {
  if (!present(file)) return { approved: new Set(), legacy: [] };
  const doc = readJsonFile(file, APPROVED_FIX);
  const strings = x => Array.isArray(x) && x.every(y => typeof y === 'string');
  if (!doc || !strings(doc.approved) || (doc.legacy !== undefined && !strings(doc.legacy))) throw corrupt(file, `has no "approved" list: ${APPROVED_FIX}`);
  return { approved: new Set(doc.approved), legacy: doc.legacy || [] };
}
export const readApproved = file => readApprovedDoc(file).approved;

// Is a decision on this target one that could hide something serious (a blocker or an L9 finding)? A target the
// ledger does not know counts as serious.
export function seriousTarget(state) {
  const fps = new Map(), groups = new Map();
  for (const i of Object.values(state.items)) {
    const s = i.severity === 'blocker' || i.lens === 'L9';
    fps.set(i.fp, s);
    groups.set(i.group, groups.get(i.group) || s);
  }
  return t => (t.fp ? fps.get(t.fp) ?? true : groups.get(t.group) ?? true);
}

// Approvals written by older versions, carried over to `<id>:<SHA-256>`:
// - `<id>:<16 hex>`: to the one file with that id whose content still has that hash;
// - a bare id (before content binding): to the one file with that id, unless two files share the id, or it is a
//   keep or false-positive on a blocker or L9 finding (the file holding that id may have been swapped since it
//   was approved). Those are not carried over (`left`); `nunchi approve` approves them again. A bare id with no
//   file stays as it is.
// → { approved, bound: [{ id, decision, target }], left: [{ id, why }] }
export function bindApproved(approved, decisions, { serious = () => true } = {}) {
  const byId = new Map();
  for (const d of decisions) byId.set(d.id, [...(byId.get(d.id) || []), d]);
  const out = new Set(), bound = [], left = [];
  for (const k of [...approved].sort()) {
    const short = /^([\w-]+):([0-9a-f]{16})$/.exec(k);
    if (short) {
      const d = (byId.get(short[1]) || []).find(x => decisionHash(x).slice(0, 16) === short[2]);
      out.add(d ? approvalKey(d) : k);
      continue;
    }
    if (k.includes(':')) { out.add(k); continue; }
    const same = byId.get(k) || [];
    if (!same.length) { out.add(k); continue; }
    const d = same[0];
    if (same.length > 1) left.push({ id: k, why: `${same.length} decision files have this id` });
    else if ((d.decision === 'keep' || d.decision === 'false-positive') && serious(d.target)) left.push({ id: k, why: `it is a ${d.decision} on a blocker or L9 finding, which is approved by content only` });
    else { out.add(approvalKey(d)); bound.push({ id: k, decision: d.decision, target: folderOf(d.target) }); }
  }
  return { approved: out, bound, left };
}

// Under a lock, so two decides at once both count; a file that cannot be read stops the write. Older approvals
// are carried over on the way (bindApproved); those not carried over are kept under `legacy`, never honoured.
export function addApproved(file, keys, { decisions = [], serious } = {}) {
  return withLock(file, () => {
    const doc = readApprovedDoc(file);
    const r = bindApproved(doc.approved, decisions, { serious });
    for (const k of keys) r.approved.add(k);
    const legacy = [...new Set([...doc.legacy, ...r.left.map(x => x.id)])].sort();
    writeAtomic(file, stableJson({ schema: 2, note: 'decisions made or approved on this machine, by id and content; anything else came through git', approved: [...r.approved].sort(), ...(legacy.length ? { legacy } : {}) }), { durable: true });
    return r;
  });
}

// ---- view ------------------------------------------------------------------------------------------

// A decision dated more than this after it arrived on this machine was dated ahead: it never counts.
export const FUTURE_SLACK_MS = 5 * 60e3;
// An open item no run has looked at again for this many runs is said to be so: it cannot be marked fixed.
export const NOT_LOOKED_RUNS = 3;

// Status of every fingerprint, from the state and the decisions. The latest decision on the fingerprint or on
// its group that may count wins (at the same time, the fingerprint's). A decision's time is the earlier of its
// date and when this machine first saw it (state.decisionsSeen; now, if not noted yet), so one that arrived
// late cannot outrank decisions made after it arrived. Shown in `note` and not counted: a decision dated ahead
// of its arrival (or with no readable date), and a keep or false-positive on a blocker or an L9 finding that
// was not made or approved on this machine (came through git). A decision made under an older fingerprint
// version follows its item (currentTargets); its approval and arrival stay those of the file as written.
export function view(state, decisions, approved = new Set(), { now = Date.now() } = {}) {
  decisions = currentTargets(decisions, state);
  const seenAt = state.decisionsSeen || {};
  const keys = new Map();
  const keyOfDecision = d => { if (!keys.has(d)) keys.set(d, approvalKey(writtenAs(d))); return keys.get(d); };
  const arrived = d => seenAt[keyOfDecision(d)] ?? now;
  const dated = d => !Number.isNaN(dateOf(d)) && dateOf(d) <= arrived(d) + FUTURE_SLACK_MS;
  const timeOf = d => (dated(d) ? Math.min(dateOf(d), arrived(d)) : arrived(d));
  const on = new Map();
  for (const d of decisions) {
    const k = d.target.fp ? `fp:${d.target.fp}` : `group:${d.target.group}`;
    if (!on.has(k)) on.set(k, []);
    on.get(k).push(d);
  }
  const position = new Map(state.runs.map((r, i) => [r, i]));
  const rows = [];
  for (const item of Object.values(state.items)) {
    const mine = [...(on.get(`group:${item.group}`) || []).map(d => [d, 0]), ...(on.get(`fp:${item.fp}`) || []).map(d => [d, 1])]
      .sort((a, b) => timeOf(a[0]) - timeOf(b[0]) || a[1] - b[1] || (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0)).map(x => x[0]);
    const serious = item.severity === 'blocker' || item.lens === 'L9';
    let d = null, note = null;
    for (let i = mine.length - 1; i >= 0 && !d; i--) {
      const x = mine[i];
      if (!dated(x)) { note ||= `a ${x.decision} decision dated ${x.at}, ahead of when it arrived here (or with no readable date), does not count`; continue; }
      if (serious && !approved.has(keyOfDecision(x)) && (x.decision === 'keep' || x.decision === 'false-positive')) { note ||= `a ${x.decision} decision came through git and needs approval on this machine`; continue; }
      d = x;
    }
    const verified = d ? approved.has(keyOfDecision(d)) : true;
    if (d && d.decision === 'reopen') d = null;
    let status;
    if (item.goneAt) status = 'fixed';
    else if (d?.decision === 'keep') status = 'kept';
    else if (d?.decision === 'false-positive') status = 'dismissed';
    else if (d?.decision === 'hold') status = 'held';
    else if (d?.decision === 'fix') status = 'to-fix';
    else status = item.regressedAt ? 'regressed' : 'open';
    const last = item.lookedAt || item.lastSeen;
    const notLookedAt = !item.goneAt && position.has(last) && state.runs.length - 1 - position.get(last) >= NOT_LOOKED_RUNS ? last : null;
    rows.push({ ...item, status, decision: d ? { id: d.id, decision: d.decision, reason: d.reason, by: d.by, at: d.at, verified } : null, note, notLookedAt });
  }
  return rows.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || (x.group < y.group ? -1 : x.group > y.group ? 1 : x.fp < y.fp ? -1 : 1));
}

// Rows → groups: the unit a person reads and decides on.
export function groups(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.group)) by.set(r.group, { group: r.group, lens: r.lens, rule: r.rule, title: titleOf(r.rule), severity: r.severity, routes: [], fps: [], places: 0, statuses: {}, example: r });
    const g = by.get(r.group);
    if (SEVERITY[r.severity] < SEVERITY[g.severity]) g.severity = r.severity;
    if (r.route !== null && !g.routes.includes(r.route)) g.routes.push(r.route);
    g.fps.push(r.fp);
    g.places += r.places || 1;
    g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
  }
  return [...by.values()].map(g => ({ ...g, routes: g.routes.sort(), fps: g.fps.sort(), status: Object.keys(g.statuses).length === 1 ? Object.keys(g.statuses)[0] : 'mixed' }))
    .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.routes.length - a.routes.length || b.places - a.places || (a.group < b.group ? -1 : 1));
}

// ---- trust (spec §4) ----------------------------------------------------------------------------------

// Per lens: precision = fix ÷ (fix + false positive) over the last 20 decisions of those two kinds; below 70%
// the lens's new findings are suspect. "Intended" keeps are not counted: the finding was right, the person
// wants it that way. Resolution: how many findings decided "fix" are now gone on re-capture.
export function trust(rows, decisions, { window = 20, threshold = 0.7 } = {}) {
  const lensOf = new Map();
  for (const r of rows) { lensOf.set(`fp:${r.fp}`, r.lens); lensOf.set(`group:${r.group}`, r.lens); }
  const out = {};
  const ensure = l => (out[l] ||= { window, fix: 0, falsePositive: 0, precision: null, suspect: false, decidedFix: 0, fixed: 0 });
  const per = {};
  for (const d of decisions) {
    const lens = lensOf.get(d.target.fp ? `fp:${d.target.fp}` : `group:${d.target.group}`);
    if (!lens || (d.decision !== 'fix' && d.decision !== 'false-positive')) continue;
    (per[lens] ||= []).push(d);
  }
  for (const [lens, list] of Object.entries(per)) {
    const t = ensure(lens);
    for (const d of list.slice(-window)) d.decision === 'fix' ? t.fix++ : t.falsePositive++;
    t.precision = t.fix + t.falsePositive ? t.fix / (t.fix + t.falsePositive) : null;
    t.suspect = t.precision !== null && t.fix + t.falsePositive >= 5 && t.precision < threshold;
  }
  for (const r of rows) {
    if (r.decision?.decision !== 'fix' && r.status !== 'fixed') continue;
    const t = ensure(r.lens);
    if (r.decision?.decision === 'fix') { t.decidedFix++; if (r.status === 'fixed') t.fixed++; }
  }
  return Object.fromEntries(Object.entries(out).sort());
}
