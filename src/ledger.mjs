// Ledger (spec §5, revised by the board review N1/N2/N5/N7/N8): what was found, what the person decided,
// and what became of it.
//
// - fingerprint: one defect, wherever and however often it shows. route template + rule + the element
//   (selector without positions or generated class names) + evidence with volatile values removed. Person,
//   viewport and state are not part of it: the same defect seen on the phone and on the desktop is one.
//   AI findings have their own recipe (design §2.3): the element, the grounded file and a hash of the grounded
//   source line, so a re-hunt with other words, another reference screen or a moved line finds the same item.
// - group: the fingerprint without the route. A shared component's defect on 17 screens is one group,
//   which is the unit a person decides on and the fix loop fixes. An AI group is narrower: lens, checklist item
//   and the component (file and accessible name), so one dismissal never covers every similar button.
// - decisions are append-only event files under .nunchi/decisions/ (committed; never conflict on merge),
//   each with who made it. A decision that arrived through git and was not made or approved on this
//   machine is "unverified": it cannot silence a blocker or a secret, and the fix loop does not act on it.
//   Approval is bound to the decision's content (SHA-256), not to its id; decisions are ordered by the earlier
//   of their date and when this machine first saw them.
// - status (open, fixed, regressed, …) is computed into the state store's ledger.json (state.mjs; git-ignored),
//   never hand-edited and never committed. Every complete run is folded, in run order, like for like. A fold is
//   keyed by (run, source): `rule` (the capture's findings), `ai` (verified AI findings), `recheck` (the AI
//   re-check); folding a (run, source) again with other inputs replaces what it contributed (schema 2, §2.1).
import { readdirSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha, stableJson, writeAtomic } from './stable.mjs';
import { listRuns } from './runs.mjs';
import { readJsonFile as readJson, readDoc, updateDoc, corrupt, present } from './state.mjs';
import { scrubSecrets } from './rules.mjs';
import { redactText } from './network.mjs';

export { readJsonFile } from './state.mjs';

// Fingerprint versions (spec §5). A version changes the recipe of some rules only; every other rule keeps its
// version-1 recipe, so its fingerprints, and the decisions made on them, are untouched.
// - v2 (2026-10-14 KST): secret-in-client-bundle ignores the bundle's content hash (bundleKey). A v1 state is
//   migrated on read and v1 decisions follow their items (migrateState, currentTargets).
// - AI findings (`source: "ai"`) have a recipe of their own, AI_RECIPE (design §2.3), which never touches the rule
//   recipes: no AI item existed before it.
export const FINGERPRINT_VERSION = 2;
export const AI_RECIPE = 1;
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

// The identity of an AI finding (design §2.3). The words of the claim, the hunt unit, the reference screen, the
// line number and the severity change from hunt to hunt; what stays is the element, the grounded file and the
// grounded source line's content. `f.identity` is computed with the run at hand (ai-fold.mjs: an `aria=` selector
// canonicalised to its controls.json selector, the line's hash, the component that renders it); without it the
// selector, normalised, and the file stand in.
const str = v => (typeof v === 'string' && v ? v : null);
const HEX16 = /^[0-9a-f]{16}$/;
export function aiIdentityOf(f) {
  const id = f.identity && typeof f.identity === 'object' ? f.identity : {};
  const element = Object.hasOwn(id, 'element') ? str(id.element) : normalizeSelector(f.selector);
  const file = Object.hasOwn(id, 'file') ? str(id.file) : str(f.evidence?.file);
  const anchor = typeof id.anchor === 'string' && HEX16.test(id.anchor) ? id.anchor : null;
  // the element's accessible name (normalised): two rows' "Delete" and "Archive" buttons are two defects even when
  // their selectors normalise alike
  const name = Object.hasOwn(id, 'name') ? str(id.name) : null;
  const c = id.component && typeof id.component === 'object' && str(id.component.file) ? { file: id.component.file, name: str(id.component.name) } : null;
  return { element, file, anchor, name, component: c ?? (file ? { file, name } : null) };
}

// `version` computes an older version's fingerprint (migration); new findings always get the current one.
export function fingerprintOf(f, version = FINGERPRINT_VERSION) {
  if (f.source === 'ai') {
    const { element, file, anchor, name, component } = aiIdentityOf(f);
    const inputs = { v: AI_RECIPE, source: 'ai', lens: f.lens, rule: f.rule, route: f.route ?? null, evidence: { anchor, element, file, name } };
    const fp = sha(stableJson(inputs), 12);
    // Group = lens + checklist item + component identity (the grounded file, or the inventory file that renders the
    // element, plus the accessible name). When neither is known, the group is the fingerprint.
    const group = component ? sha(stableJson({ v: AI_RECIPE, source: 'ai', lens: f.lens, rule: f.rule, component }), 12) : fp;
    return { fp, group, inputs };
  }
  const v = recipeOf(f.rule, version);
  const inputs = { v, lens: f.lens, rule: f.rule, route: f.route ?? null, element: normalizeSelector(f.selector), evidence: evidenceKey(f.rule, f.evidence, version) };
  const { route, ...rest } = inputs;
  // Low contrast has one cause however many elements show it: the colour pair (a design token).
  const pair = f.rule === 'axe-color-contrast' && /foreground color: (#[0-9a-f]{3,8}), background color: (#[0-9a-f]{3,8})/i.exec(f.evidence?.summary || '');
  const groupInputs = pair ? { v, rule: f.rule, colors: [pair[1].toLowerCase(), pair[2].toLowerCase()] } : rest;
  return { fp: sha(stableJson(inputs), 12), group: sha(stableJson(groupInputs), 12), inputs };
}

// v1 → v2 on read. Items of a rule whose recipe changed get their fingerprint and group recomputed from what
// they stored (lens, rule, route, selector, evidence); items that now share a fingerprint merge (mergeSightings);
// `aliases` keeps old → new so decisions made under v1 keep applying. The characters of a secret that v1 stored
// (`evidence.masked`) are dropped. AI items are never re-keyed here (their recipe is AI_RECIPE).
const SEEN_ORDER = (a, b) => -byRun(String(a.lastSeen ?? ''), String(b.lastSeen ?? '')) || (!a.goneAt !== !b.goneAt ? (a.goneAt ? 1 : -1) : a.fp < b.fp ? -1 : 1);
export function migrateState(state) {
  if (!state || !state.items || (state.fingerprintVersion || 1) >= FINGERPRINT_VERSION) return state;
  const aliases = { fp: { ...(state.aliases?.fp || {}) }, group: { ...(state.aliases?.group || {}) } };
  const items = {};
  const sets = { ...(state.coverage || {}) };
  for (const old of Object.values(state.items).sort(SEEN_ORDER)) {
    if (old.source === 'ai' || recipeOf(old.rule, FINGERPRINT_VERSION) === recipeOf(old.rule, state.fingerprintVersion || 1)) { items[old.fp] = old; continue; }
    const { masked, ...evidence } = old.evidence || {};
    const { fp, group, inputs } = fingerprintOf({ ...old, evidence });
    if (fp !== old.fp) aliases.fp[old.fp] = fp;
    if (group !== old.group) aliases.group[old.group] = group;
    items[fp] = items[fp] ? mergeSightings(items[fp], old, sets) : { ...old, fp, group, evidence, inputs };
  }
  const out = { ...state, fingerprintVersion: FINGERPRINT_VERSION, items, aliases };
  if (state.coverage) {                                   // the coverage sets an item still names
    const used = new Set(Object.values(items).map(i => i.coverage).filter(Boolean));
    out.coverage = Object.fromEntries(Object.entries(sets).filter(([h]) => used.has(h)));
  }
  return out;
}

// Two v1 items that are one v2 defect (two builds of one bundle). The later sighting (`have`) keeps its evidence
// and examples; nothing either one still needs is dropped, so the merge never makes the defect easier to call
// fixed: the cells and whole-app coverage of both (a coverage set that cannot be found stays named, so the item
// can never be fixed, as foldRun treats it), fixed only when both were (open beats fixed), and looked at when
// both were.
function mergeSightings(have, old, sets) {
  const union = k => [...new Set([...(have[k] || []), ...(old[k] || [])])].sort();
  const out = { ...have, firstSeen: minRun(have.firstSeen, old.firstSeen), persons: union('persons'), viewports: union('viewports'), states: union('states') };
  if (have.cells || old.cells) out.cells = union('cells');
  if (have.coverage || old.coverage) {
    const lost = [have.coverage, old.coverage].find(c => c && !sets[c]);
    if (lost) out.coverage = lost;
    else {
      const keys = [...new Set([...(sets[have.coverage] || []), ...(sets[old.coverage] || [])])].sort();
      out.coverage = setId(keys);
      sets[out.coverage] = keys;
    }
  }
  if (have.lookedAt || old.lookedAt) out.lookedAt = minRun(have.lookedAt || have.lastSeen, old.lookedAt || old.lastSeen);
  const open = [have, old].filter(i => !i.goneAt);
  if (!open.length) Object.assign(out, { goneAt: maxRun(have.goneAt, old.goneAt), regressedAt: have.regressedAt ?? null });
  else Object.assign(out, { goneAt: null, regressedAt: open[0].regressedAt ?? null });
  return out;
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
    if (item.source === 'ai' || recipeOf(item.rule, FINGERPRINT_VERSION) === 1) continue;
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
// The most severe of some severities (unknown values are ignored).
const worst = list => list.filter(s => Object.hasOwn(SEVERITY, s)).sort((a, b) => SEVERITY[a] - SEVERITY[b])[0] ?? null;
// What a decision may hide: an AI item is protected by the most severe severity anyone gave it (design §2.2: a
// verifier that lowers a blocker does not lower its protection); display uses the corrected one.
export const protectOf = item => worst([item.protect, item.severity]) ?? item.severity;

// ---- state (local, computed) ------------------------------------------------------------------------

const REBUILD = 'restore ledger.json.prev beside it, or delete it and the next nunchi command rebuilds it from the runs on disk';
export const LEDGER_SCHEMA = 2;
export const emptyState = () => ({ schema: LEDGER_SCHEMA, fingerprintVersion: FINGERPRINT_VERSION, runs: [], folds: [], items: {} });
// A ledger this nunchi can read: schema 1 (before M1) or 2; a newer schema is refused, never half understood.
export const isLedger = s => !!s && typeof s === 'object' && Array.isArray(s.runs) && !!s.items && typeof s.items === 'object' && !Array.isArray(s.items)
  && (s.schema === undefined || s.schema === 1 || (s.schema === LEDGER_SCHEMA && Array.isArray(s.folds)));

// Schema 1 → 2 (design §2.5): `folds` replaces the bare run list as the record of what was folded (each run's rule
// fold, keyed by its worktree's stream), and every item says its source. Nothing else changes.
export function upgrade(state, stream = 'main') {
  if (state.schema === LEDGER_SCHEMA && Array.isArray(state.folds)) return state;
  const items = {};
  for (const [fp, i] of Object.entries(state.items || {})) items[fp] = i.source ? i : { ...i, source: 'rule' };
  return { ...state, schema: LEDGER_SCHEMA, folds: (state.runs || []).map(run => ({ run, source: 'rule', key: null, stream })).sort(byFold), items };
}
// Both migrations on read: the schema, then the fingerprint version.
const migrateAll = (s, stream) => migrateState(upgrade(s, stream));

// A ledger one folder kept (`.nunchi/state`, state.mjs adoptLegacy), taken into the repository's shared state: all it
// holds came from this worktree's runs, so its folds and items are this worktree's stream (an item another
// worktree's run never saw is not that worktree's to fix). `decisionsSeen` is never taken (adoptLegacy).
export function adoptLedger(legacy, stream = 'main') {
  const { decisionsSeen: _ignored, ...s } = upgrade(legacy, stream);
  const items = {};
  for (const [fp, it] of Object.entries(s.items || {})) {
    if (!isAi(it)) { items[fp] = { ...it, stream }; continue; }
    const retagged = { ...it, hunts: (it.hunts || []).map(h => ({ ...h, stream })), rechecks: (it.rechecks || []).map(r => ({ ...r, stream })) };
    items[fp] = deriveAi(retagged) || retagged;
  }
  return { ...s, folds: (s.folds || []).map(f => ({ ...f, stream })).sort(byFold), items };
}
// A second worktree's `.nunchi/state` ledger, when the shared ledger exists already: the open items the shared
// ledger does not have (seen in runs since removed, say) are carried over as they stand, tagged with this worktree's
// stream, with the coverage sets they name. The shared ledger's own record of an item wins. Not carried, and said:
// items that were fixed already (history only), the record of which runs were folded (this worktree's runs on disk
// are folded again by the next ledger command) and when decisions were first seen. → { doc, carried, notCarried }.
export function carryLedger(cur, legacy, stream = 'main') {
  const from = adoptLedger(legacy, stream);
  const items = { ...cur.items }, coverage = { ...(cur.coverage || {}) };
  let carried = 0, fixed = 0;
  for (const fp of Object.keys(from.items).sort()) {
    const it = from.items[fp];
    if (Object.hasOwn(cur.items, fp)) continue;
    if (it.goneAt) { fixed++; continue; }
    items[fp] = it;
    if (it.coverage && from.coverage?.[it.coverage] && !coverage[it.coverage]) coverage[it.coverage] = from.coverage[it.coverage];
    carried++;
  }
  const notCarried = [...(fixed ? [`${fixed} item(s) already fixed there (history only)`] : []), 'which of its runs were folded (this worktree\'s runs on disk are folded again)', 'when each decision was first seen (noted again from now)'];
  if (!carried) return { doc: cur, carried, notCarried };
  return { doc: { ...cur, items, coverage }, carried, notCarried };
}

// A state written by an older schema or fingerprint version is migrated as it is read; syncLedger writes the
// migrated state back. A file that cannot be read, or is not a ledger, is an error (exit 2), never "empty".
const MIGRATED = new WeakSet();
export function readState(file) {
  if (!present(file)) return emptyState();
  const s = readJson(file, REBUILD, { retry: true });
  if (!isLedger(s)) throw corrupt(file, s && s.schema > LEDGER_SCHEMA ? `was written by a newer nunchi (ledger schema ${s.schema}): ${REBUILD}` : `is not a nunchi ledger: ${REBUILD}`);
  const m = migrateAll(s);
  if (m !== s) MIGRATED.add(m);
  return m;
}

// Run ids are digits, zero-padded to 4 and longer past 9999: shorter is older.
export const byRun = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const minRun = (a, b) => (!a ? b : !b ? a : byRun(a, b) <= 0 ? a : b);
const maxRun = (a, b) => (!a ? b : !b ? a : byRun(a, b) >= 0 ? a : b);
const SOURCES = ['rule', 'ai', 'recheck', 'fix'];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byFold = (a, b) => byRun(String(a.run), String(b.run)) || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || cmp(a.stream ?? 'main', b.stream ?? 'main');
const sameFold = (f, run, source, stream) => f.run === run && f.source === source && (f.stream ?? 'main') === stream;
// The fold entry of (run, source) for a worktree's stream, or null.
export const foldOf = (state, run, source, stream = 'main') => (Array.isArray(state.folds) ? state.folds.find(f => sameFold(f, run, source, stream)) ?? null : (source === 'rule' && state.runs?.includes(run) ? { run, source, key: null, stream } : null));
const withFold = (folds, entry) => [...folds.filter(f => !sameFold(f, entry.run, entry.source, entry.stream)), entry].sort(byFold);
export const streamOf = x => x?.stream ?? 'main';
// The capture runs (sweeps and quick runs) one stream folded, oldest first. A schema-1 state has one stream.
// A run the run list names that no fold records (a ledger written before folds) is the main worktree's.
export function captureRuns(state, stream = 'main') {
  if (!Array.isArray(state.folds)) return stream === 'main' ? state.runs.slice().sort(byRun) : [];
  const rule = state.folds.filter(f => f.source === 'rule');
  const recorded = new Set(rule.map(f => f.run));
  const mine = rule.filter(f => streamOf(f) === stream && (f.kind === undefined || f.kind === 'quick')).map(f => f.run);
  const orphans = stream === 'main' ? (state.runs || []).filter(r => !recorded.has(r)) : [];
  return [...new Set([...mine, ...orphans])].sort(byRun);
}
// The latest capture run of a stream (what `findings` and the review page call "this run"), else the latest of any.
export const latestRunOf = (state, stream = 'main') => captureRuns(state, stream).pop() ?? state.runs[state.runs.length - 1] ?? null;

// A cell is where a finding was seen on its route: person.state.viewport (the end of the scene id). A key is
// route|cell, what a run looked at.
const cellOfScene = id => { const [person, state, vp] = String(id).split('.').slice(-3); return person && state && vp ? { person, state, vp, cell: `${person}.${state}.${vp}` } : null; };
const keyOf = (route, cell) => `${route}|${cell}`;
const routeOfKey = k => k.slice(0, k.lastIndexOf('|'));
// Scenes that show their own route: captured, not redirected, not an error page, not a canary copy.
export const looked = s => s.status === 'captured' && s.canary === undefined && !s.redirected && !/^redirected/.test(s.reason || '') && !(s.httpStatus >= 400);
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
const isAi = item => item.source === 'ai';
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

// Run kinds (design §2.1). Only a sweep folds as a sweep. A quick run is presence-only (it adds and brings back,
// never fixes). A fix probe (and any kind this nunchi does not know) is not folded by the catch-up: the fix loop
// folds a probe for its own group (M3). Runs written before kinds existed are sweeps.
export const RUN_KINDS = ['sweep', 'quick', 'fix-probe'];

// Fold one complete run's rule findings into the state (design 0.1-c §2.1), as the (run, "rule") fold of `stream`.
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
// - Folding the same run twice changes nothing. AI items are never touched here: a capture's silence says nothing
//   about them (only a re-check can, design §2.4).
export function foldRun(state, { id, scope = {}, wholeApp = false, health = { problems: [] }, scenes = [], findings, origin = null, kind = 'sweep', key = null, stream = 'main' }) {
  if (foldOf(state, id, 'rule', stream)) return state;
  const st = upgrade(state, stream);
  const entry = { run: id, source: 'rule', key, stream, ...(kind !== 'sweep' ? { kind } : {}) };
  if (kind !== 'sweep' && kind !== 'quick') return { ...st, folds: withFold(st.folds, entry) };
  // the watermark is per stream (worktree): another worktree's newer run does not make this one's runs old, and
  // only this stream's newest run may say what is gone (below)
  const newest = kind === 'sweep' && !captureRuns(st, stream).some(r => byRun(r, id) > 0);
  const sets = { ...(st.coverage || {}) };
  const next = { ...st, runs: [...new Set([...st.runs, id])].sort(byRun), folds: withFold(st.folds, entry), items: { ...st.items } };
  const covered = [...new Set(scenes.filter(looked).map(s => keyOf(s.route, `${s.person}.${s.state}.${s.viewport}`)))].sort();
  const coveredSet = new Set(covered);
  const appRoutes = new Set(scope.routes || []);
  // A route an earlier run looked at that this run did not (it failed, answered an error or redirected this
  // time) makes the run partial. A route no run has looked at (always broken, always redirected, or a path
  // discover cannot resolve, recorded as `unresolved` in run.json) does not: no whole-app item can have been
  // seen there, and the per-item coverage guards the rest.
  const seenBefore = new Set(st.seenRoutes || []);
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
    if (f.source === 'ai') continue;                                            // AI findings fold through foldAi
    if (!seen.has(f.fp)) seen.set(f.fp, { f, persons: new Set(), viewports: new Set(), states: new Set(), cells: new Set(), scenes: [] });
    const p = seen.get(f.fp);
    const c = f.scene ? cellOfScene(f.scene) : null;
    if (c) { p.persons.add(c.person); p.states.add(c.state); p.viewports.add(c.vp); p.cells.add(c.cell); }
    if (f.scene && p.scenes.length < 20) p.scenes.push(f.scene);
  }
  for (const [fp, p] of seen) {
    const old = next.items[fp];
    if (old && isAi(old)) continue;
    const route = p.f.route ?? null;
    const base = { fp, group: p.f.group, source: 'rule', stream, lens: p.f.lens, rule: p.f.rule, severity: p.f.severity, route, origin,
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
  if (newest && blind.length) next.blind = { ...(st.blind || {}), [id]: blind[0] };
  else if (newest) {
    const run = { scope, wholeApp: whole, appRoutes, origin, covered: coveredSet, loginExpired: (health.problems || []).some(p => p.status === 'login-expired') };
    const lookedAt = [], gone = [];
    for (const [fp, item] of Object.entries(next.items)) {
      // only the worktree that last saw an item can say it is gone: worktrees on other branches would otherwise
      // fix and bring back each other's items in turn (until M6 makes other branches' captures probes)
      if (isAi(item) || seen.has(fp) || streamOf(item) !== stream || !lookedAgain(item, run, sets)) continue;
      lookedAt.push(fp);
      if (!item.goneAt) gone.push(fp);
    }
    const open = Object.values(st.items).filter(i => !isAi(i) && !i.goneAt).length;
    if (gone.length >= ONE_PAGE.items && gone.length > ONE_PAGE.share * open && onePage(scenes)) next.blind = { ...(st.blind || {}), [id]: 'one-page' };
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
// skipped quietly, or the ledger would say nothing about what it saw. `key` names the inputs (design §2.1).
export function runForFold(runDir) {
  const fix = `fix or remove the run folder ${runDir}`;
  const meta = readJson(join(runDir, 'run.json'), fix);
  const manifest = readJson(join(runDir, 'manifest.json'), fix);
  const doc = readJson(join(runDir, 'findings.json'), fix);
  if (!Array.isArray(manifest?.scenes) || !Array.isArray(doc?.findings)) throw corrupt(runDir, `is not a complete capture run (no scenes in manifest.json or no findings in findings.json): ${fix}`);
  const kind = meta?.kind === undefined ? 'sweep' : String(meta.kind);
  const input = { id: basename(runDir), kind, scope: meta?.scope || {}, wholeApp: meta?.wholeApp === true, health: manifest.health || { problems: [] }, scenes: manifest.scenes,
    origin: originOf(manifest.baseUrl), findings: doc.findings.map(f => (f.fp ? f : { ...f, fp: fingerprintOf(f).fp, group: fingerprintOf(f).group })) };
  return { ...input, key: sha(stableJson(input), 16) };
}

// ---- AI items (design §2.2–§2.4) --------------------------------------------------------------------------
//
// An AI item keeps what each fold contributed, so a (run, source) folded again replaces its own contribution and
// nothing else:
// - `hunts`: one entry per hunt (run) that claimed it — the verdict the run's verifier gave, its severities, the
//   cells and the screens' hashes — or that saw one of its cells and did not claim it (`silent`);
// - `rechecks`: one entry per re-check, its verdict per cell.
// Everything else is derived from those (deriveAi), the same whatever order the folds came in.

const CREATES = s => s === 'confirmed' || s === 'claimed';
// A verdict that is no double-check: a suspect verifier's, or one from a run with too few decoys to check the checker.
const weak = h => !!h.suspect || !!h.tooFewDecoys;
// A hunt's claim says the defect is there unless a verifier that was checked and not suspect rejected it.
const PRESENT = h => h.claimed && !(h.status === 'rejected' && !weak(h));
const STATUS_RANK = { confirmed: 0, claimed: 1, insufficient: 2, rejected: 3 };
const byEvent = (a, b) => byRun(String(a.run), String(b.run)) || cmp(a.stream ?? 'main', b.stream ?? 'main');
export const STALE_HUNTS = 2;
const AI_VERDICTS = new Set(['confirmed', 'rejected', 'insufficient']);

// One AI item from its contributions; null when no hunt claims it as a defect any more (rejected and insufficient
// claims never make an item, design §2.2).
export function deriveAi(item) {
  const hunts = (item.hunts || []).slice().sort(byEvent);
  const rechecks = (item.rechecks || []).slice().sort(byEvent);
  const claims = hunts.filter(h => h.claimed);
  if (!claims.some(h => CREATES(h.status))) return null;
  const present = claims.filter(PRESENT);
  const latest = present[present.length - 1] || claims[claims.length - 1];
  const cells = [...new Set(present.flatMap(h => h.cells || []))].sort();
  // what happened, in run order: seen (a claim, or a re-check that found it still there or its screen unchanged),
  // gone (a re-check that was not suspect and said gone in every cell), insufficient (a re-check that could not
  // tell). In one run, gone goes first: a claim in the same run keeps it open.
  const events = [];
  for (const h of present) events.push({ run: h.run, stream: h.stream, t: 2, h });
  for (const r of rechecks) {
    const v = r.cells || {};
    const verdicts = Object.values(v).map(x => x?.verdict);
    // a re-check of a run older than a sighting already folded when it was recorded compared the wrong screens: it
    // can say "still there", never "gone" (else the later sighting would read as the defect coming back)
    const stale = present.some(h => byRun(String(h.run), String(r.run)) > 0 && Number.isFinite(h.at) && Number.isFinite(r.at) && h.at <= r.at);
    if (verdicts.some(x => x === 'still-there' || x === 'unchanged')) events.push({ run: r.run, stream: r.stream, t: 2, r });
    else if (!r.suspect && !stale && cells.length && cells.every(c => v[c]?.verdict === 'gone')) events.push({ run: r.run, stream: r.stream, t: 0, r });
    else if (verdicts.includes('insufficient')) events.push({ run: r.run, stream: r.stream, t: 1, r });
  }
  events.sort((a, b) => byEvent(a, b) || a.t - b.t);
  let goneAt = null, regressedAt = null, lastSeen = null, needsYou = null, lastStream = null;
  for (const e of events) {
    if (e.t === 2) {
      if (goneAt && byRun(e.run, goneAt) > 0) regressedAt = e.run;
      goneAt = null; needsYou = null;
      if (!lastSeen || byRun(e.run, lastSeen) >= 0) lastStream = streamOf(e);
      lastSeen = maxRun(lastSeen, e.run);
    } else if (e.t === 0) {
      // as for rule items: only the worktree that last saw it can say it is gone
      if (!goneAt && (!lastStream || streamOf(e) === lastStream)) goneAt = e.run;
      if (goneAt) needsYou = null;
    } else if (!goneAt) needsYou = { reason: 'recheck-insufficient', run: e.run };
  }
  const lastHunted = hunts.reduce((m, h) => maxRun(m, h.run), null);
  const silent = new Set(hunts.filter(h => h.silent && lastSeen && byRun(h.run, lastSeen) > 0).map(h => `${h.run}|${h.stream ?? 'main'}`));
  // the verdict: the latest one a verifier gave that was checked and not suspect, else the latest other one, else claimed
  const judged = claims.filter(h => AI_VERDICTS.has(h.status));
  const chosen = judged.filter(h => !weak(h)).pop() || judged.pop() || latest;
  const verification = {
    status: chosen.status, by: chosen.by ?? null, ...(chosen.vendor ? { vendor: chosen.vendor } : {}), suspect: !!chosen.suspect,
    ...(chosen.tooFewDecoys && !chosen.suspect ? { tooFewDecoys: true } : {}), run: chosen.run,
    ...(AI_VERDICTS.has(chosen.status) && Number.isFinite(chosen.at) ? { at: chosen.at } : {}),
  };
  // the screen it was last seen on, per cell, with its element and box there: the old evidence a re-check shows and
  // compares the new screen with. A claim sets it; a re-check moves it only when the screen was unchanged (the same
  // pixels and text, so the element and box still hold); a "still there" on a changed screen moves lastSeen only.
  const seen = {};
  const note = (cell, s, run) => { if (s && (!seen[cell] || byRun(run, seen[cell].run) >= 0)) seen[cell] = { ...s, run }; };
  const marks = [...present.map(h => ({ run: h.run, stream: h.stream, h })), ...rechecks.map(r => ({ run: r.run, stream: r.stream, r }))].sort(byEvent);
  for (const m of marks) {
    if (m.h) for (const [c, s] of Object.entries(m.h.scenes || {})) note(c, s, m.h.run);
    else for (const [c, s] of Object.entries(m.r.cells || {})) if (s?.verdict === 'unchanged' && seen[c]) note(c, { ...seen[c], scene: s.scene ?? seen[c].scene, top: s.top ?? null, full: s.full ?? null, textHash: s.textHash ?? null, src: s.src ?? null }, m.r.run);
  }
  const parts = cells.map(c => c.split('.'));
  const out = {
    fp: item.fp, group: latest.group || item.group, source: 'ai', stream: lastStream || streamOf(latest), lens: item.lens, rule: item.rule, route: item.route ?? null, inputs: item.inputs, addedAt: item.addedAt ?? null,
    // displayed: the severity a verifier that confirmed it gave; rejected and insufficient keep the claimed one
    severity: (chosen.status === 'confirmed' ? chosen.verdictSeverity : null) || latest.claimedSeverity,
    claimedSeverity: latest.claimedSeverity, protect: worst(present.flatMap(h => [h.claimedSeverity, h.verdictSeverity])) || latest.claimedSeverity,
    verification, cells, persons: [...new Set(parts.map(p => p[0]))].sort(), states: [...new Set(parts.map(p => p[1]))].sort(), viewports: [...new Set(parts.map(p => p[2]))].sort(),
    places: (latest.examples || []).length, examples: (latest.examples || []).slice(0, 5), selector: latest.selector ?? null, box: latest.box ?? null,
    evidence: latest.evidence || {}, identity: latest.identity || null, seen,
    firstSeen: present.reduce((m, h) => minRun(m, h.run), null) || latest.run, lastSeen: lastSeen || latest.run,
    lookedAt: [lastHunted, ...rechecks.map(r => r.run)].reduce(maxRun, null), lastHunted, silentHunts: silent.size,
    goneAt, regressedAt, ...(needsYou ? { needsYou } : {}),
    hunts, rechecks,
  };
  return out;
}

// Fold the (run, "ai") contribution of `stream` (design §2.2). `findings`: the run's AI findings that passed the
// grounding re-check (ai-fold.mjs aiFoldInput), each with fp, group, its cell, its verdict and severities.
// `seen`: the cells the hunt saw, as `lens|route|cell`. A finding rejected or insufficient never makes an item; on
// an existing item it is the verdict this run gave. An item of the same lens whose cell the hunt saw and did not
// claim gets a silent hunt (staleness). Folding the same inputs again changes nothing; other inputs replace.
export function foldAi(state, { run, stream = 'main', key = null, findings = [], seen = [], now = Date.now() }) {
  const prior = foldOf(state, run, 'ai', stream);
  if (prior && key !== null && prior.key === key) return state;
  const st = upgrade(state, stream);
  const items = { ...st.items };
  const touched = new Set();
  const mine = h => h.run === run && (h.stream ?? 'main') === stream;
  if (prior) for (const [fp, it] of Object.entries(items)) if (isAi(it) && (it.hunts || []).some(mine)) { items[fp] = { ...it, hunts: it.hunts.filter(h => !mine(h)) }; touched.add(fp); }
  const byFp = new Map();
  for (const f of findings) { if (!byFp.has(f.fp)) byFp.set(f.fp, []); byFp.get(f.fp).push(f); }
  for (const fp of [...byFp.keys()].sort()) {
    const list = byFp.get(fp).slice().sort((a, b) => cmp(String(a.scene), String(b.scene)) || cmp(stableJson(a), stableJson(b)));
    let it = items[fp];
    if (it && !isAi(it)) continue;
    if (!it) {
      if (!list.some(f => CREATES(f.status))) continue;
      const f = list[0];
      it = { fp, group: f.group, source: 'ai', lens: f.lens, rule: f.rule, route: f.route ?? null, inputs: f.inputs, addedAt: now, hunts: [], rechecks: [] };
    }
    const best = list.slice().sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];
    const scenes = {};
    for (const f of list) if (f.cell && f.sceneHash) scenes[f.cell] = { scene: f.scene, ...f.sceneHash, selector: f.selector ?? null, box: f.box ?? null };
    const entry = {
      run, stream, at: now, claimed: true, status: best.status, suspect: list.some(f => !!f.suspect), ...(list.some(f => !!f.tooFewDecoys) ? { tooFewDecoys: true } : {}),
      by: best.by ?? null, ...(best.vendor ? { vendor: best.vendor } : {}),
      claimedSeverity: worst(list.map(f => f.claimedSeverity)), verdictSeverity: worst(list.filter(f => AI_VERDICTS.has(f.status)).map(f => f.verdictSeverity)),
      cells: [...new Set(list.map(f => f.cell).filter(Boolean))].sort(), scenes, group: best.group,
      examples: [...new Set(list.map(f => f.scene).filter(Boolean))].sort().slice(0, 20), selector: best.selector ?? null, box: best.box ?? null,
      evidence: best.evidence || {}, identity: best.identity || null,
    };
    items[fp] = { ...it, hunts: [...(it.hunts || []).filter(h => !mine(h)), entry].sort(byEvent) };
    touched.add(fp);
  }
  // silent hunts: the hunt saw a cell of the item (same lens) and did not claim it
  const seenSet = new Set(seen);
  for (const [fp, it] of Object.entries(items)) {
    if (!isAi(it) || byFp.has(fp)) continue;
    if (!(it.cells || []).some(c => seenSet.has(`${it.lens}|${it.route}|${c}`))) continue;
    items[fp] = { ...it, hunts: [...(it.hunts || []).filter(h => !mine(h)), { run, stream, at: now, silent: true }].sort(byEvent) };
    touched.add(fp);
  }
  for (const fp of touched) { const d = deriveAi(items[fp]); if (d) items[fp] = d; else delete items[fp]; }
  return { ...st, items, folds: withFold(st.folds, { run, source: 'ai', key, stream }) };
}

// Fold the (run, "recheck") contribution (design §2.4). `results`: per AI item, its verdict per cell
// (`gone`, `still-there`, `insufficient`, `unchanged` (no packet: nothing changed), `unanswered`, `not-captured`)
// with the new screen's hashes. A suspect batch never makes anything gone; still-there and unchanged still count.
export function foldRecheck(state, { run, stream = 'main', key = null, suspect = false, results = [], now = Date.now() }) {
  const prior = foldOf(state, run, 'recheck', stream);
  if (prior && key !== null && prior.key === key) return state;
  const st = upgrade(state, stream);
  const items = { ...st.items };
  const touched = new Set();
  const mine = r => r.run === run && (r.stream ?? 'main') === stream;
  if (prior) for (const [fp, it] of Object.entries(items)) if (isAi(it) && (it.rechecks || []).some(mine)) { items[fp] = { ...it, rechecks: it.rechecks.filter(r => !mine(r)) }; touched.add(fp); }
  for (const r of results.slice().sort((a, b) => cmp(a.fp, b.fp))) {
    const it = items[r.fp];
    if (!it || !isAi(it)) continue;
    items[r.fp] = { ...it, rechecks: [...(it.rechecks || []).filter(x => !mine(x)), { run, stream, at: now, suspect: !!suspect, cells: r.cells || {} }].sort(byEvent) };
    touched.add(r.fp);
  }
  for (const fp of touched) { const d = deriveAi(items[fp]); if (d) items[fp] = d; else delete items[fp]; }
  return { ...st, items, folds: withFold(st.folds, { run, source: 'recheck', key, stream }) };
}

// Fold a fix probe (design §4.4): the (run, "fix") contribution of P1 for one group, made by the fix loop only on
// outcome `fixed`. Only the group's fingerprints move: `gone` (rule items the judge found gone, by element identity, in
// every cell they were seen in) get `goneAt` = the probe; `rechecks` (AI items, the fix loop's re-check from a fresh
// context, never suspect) are added to the item's re-checks, so it is fixed the way any re-check fixes it. Nothing
// else of the probe is folded (it saw a few routes, on a fix branch). Folding the same key again changes nothing.
export function foldFix(state, { run, stream = 'main', key = null, group, gone = [], rechecks = [], now = Date.now() }) {
  const prior = foldOf(state, run, 'fix', stream);
  if (prior && key !== null && prior.key === key) return state;
  const st = prior ? unfoldFix(state, { run, stream }) : upgrade(state, stream);
  const items = { ...st.items };
  const done = [];
  for (const fp of [...new Set(gone)].sort()) {
    const it = items[fp];
    if (!it || isAi(it) || it.group !== group || it.goneAt) continue;
    items[fp] = { ...it, goneAt: run, lookedAt: maxRun(it.lookedAt, run), fixedBy: { run, group } };
    done.push(fp);
  }
  const touched = new Set();
  for (const r of rechecks.slice().sort((a, b) => cmp(a.fp, b.fp))) {
    const it = items[r.fp];
    if (!it || !isAi(it) || it.group !== group) continue;
    items[r.fp] = { ...it, rechecks: [...(it.rechecks || []).filter(x => !(x.run === run && (x.stream ?? 'main') === stream)), { run, stream, at: now, suspect: false, via: 'fix', cells: r.cells || {} }].sort(byEvent) };
    touched.add(r.fp);
  }
  for (const fp of touched) { const d = deriveAi(items[fp]); if (d) items[fp] = d; else delete items[fp]; }
  return { ...st, items, folds: withFold(st.folds, { run, source: 'fix', key, stream, group, gone: done, ai: [...touched].sort() }) };
}
// Undo a fix fold (`fix --undo`): what that (run, "fix") fold marked gone is open again (unless a later run decided
// otherwise since), and its re-check entries go.
export function unfoldFix(state, { run, stream = 'main' }) {
  const f = foldOf(state, run, 'fix', stream);
  if (!f) return state;
  const st = upgrade(state, stream);
  const items = { ...st.items };
  for (const fp of f.gone || []) { const it = items[fp]; if (it && it.goneAt === run) { const { fixedBy: _f, ...rest } = it; items[fp] = { ...rest, goneAt: null }; } }
  for (const fp of f.ai || []) {
    const it = items[fp];
    if (!it || !isAi(it)) continue;
    const d = deriveAi({ ...it, rechecks: (it.rechecks || []).filter(x => !(x.run === run && (x.stream ?? 'main') === stream && x.via === 'fix')) });
    if (d) items[fp] = d;
  }
  return { ...st, items, folds: st.folds.filter(x => !sameFold(x, run, 'fix', stream)) };
}
// Read, fold (or unfold) one fix probe, commit (state.mjs updateDoc). → the state as written.
export function commitFix(stateFile, fn, { generation = null, timeoutMs } = {}) {
  const out = updateDoc(stateFile, doc => { const s0 = doc === null ? emptyState() : migrateAll(doc); const s = fn(s0); return s === s0 && doc !== null ? doc : s; },
    { read: { fix: REBUILD, validate: isLedger, why: 'is not a nunchi ledger' }, timeoutMs, generation });
  return out === null ? emptyState() : migrateAll(out);
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

// Brings the ledger up to date, through the state store (state.mjs updateDoc: read, fold, commit if nobody wrote in
// between, else read again; the file it replaces is kept as ledger.json.prev):
// - every complete run of `runsDir` not folded yet for `stream` is folded, oldest first (its rule findings);
// - with `loaders.ai` / `loaders.recheck` (ai-fold.mjs, recheck.mjs), every run whose verified AI findings or
//   re-check verdicts are not folded yet, or changed since (a re-verify), is folded as (run, "ai") / (run, "recheck");
// - with `decisions`, every decision not seen before is noted.
// A crash after a run is complete and before its fold leaves nothing behind: the next command folds it. A state of
// an older schema or fingerprint version is written back migrated. Nothing to do: nothing is written.
// `generation`: the state's generation file, bumped when something is written.
export function syncLedger(stateFile, runsDir, { decisions = null, now = Date.now(), timeoutMs, stream = 'main', generation = null, loaders = {} } = {}) {
  const out = updateDoc(stateFile, (doc, { lock }) => {
    const { s0, s } = catchUp(doc, runsDir, { decisions, now, stream, loaders, touch: () => lock?.touch() });
    return s !== s0 || (doc !== null && s0 !== doc) ? s : doc;
  }, { read: { fix: REBUILD, validate: isLedger, why: 'is not a nunchi ledger' }, timeoutMs, generation });
  return out === null ? emptyState() : migrateAll(out, stream);
}
// What syncLedger folds, in memory: → { s0 (the state read, migrated), s (with the runs, verdicts and decisions not
// folded yet) }.
function catchUp(doc, runsDir, { decisions = null, now = Date.now(), stream = 'main', loaders = {}, touch = () => {} } = {}) {
  const s0 = doc === null ? emptyState() : migrateAll(doc, stream);
  let s = s0;
  const ids = listRuns(runsDir).complete.slice().sort(byRun);
  for (const id of ids) if (!foldOf(s, id, 'rule', stream)) { s = foldRun(s, { ...runForFold(join(runsDir, id)), stream }); touch(); }
  for (const [source, fold] of [['ai', foldAi], ['recheck', foldRecheck]]) {
    const l = loaders[source];
    if (!l) continue;
    for (const id of ids) {
      const dir = join(runsDir, id);
      const key = l.key(dir);
      if (key === null) continue;
      if (foldOf(s, id, source, stream)?.key === key) continue;
      const input = l.input(dir);
      if (!input) continue;
      s = fold(s, { ...input, run: id, key, stream, now });
      touch();
    }
  }
  if (decisions) s = noteDecisions(s, decisions, now);
  return { s0, s };
}
// The ledger as syncLedger would leave it, without writing anything (`nunchi check`, which only reads): the file as it
// is, with what is not folded yet folded in memory. A file that cannot be read is the same error as for syncLedger.
export function peekLedger(stateFile, runsDir, { decisions = null, now = Date.now(), stream = 'main', loaders = {} } = {}) {
  const { doc } = readDoc(stateFile, { fix: REBUILD, validate: isLedger, why: 'is not a nunchi ledger' });
  return catchUp(doc, runsDir, { decisions, now, stream, loaders }).s;
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
      const d = readJson(file, `a torn write or a bad merge; ${fix}`, { max: DECISION_MAX_BYTES });
      if (!isDecision(d)) throw corrupt(file, `is not a nunchi decision: ${fix}`);
      if (`${d.id}.json` !== f || folderOf(d.target) !== folder) throw corrupt(file, `does not match its place (decision ${d.id} belongs in ${folderOf(d.target)}/${d.id}.json): moved, copied or edited by hand; ${fix}`);
      out.push(d);
    }
  }
  return out.sort(byDate);
}

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00');

// How a decision, approval or label was made (design 0.1-c §1): `board` (the board UI, with its session token),
// `cli-tty` (`nunchi decide` in the user's own terminal: stdin and stdout TTYs and a typed confirmation code),
// `cli-agent` (anything else: the agent recording what the user said in chat). `git` is never written: it is what a
// decision that arrived through a commit and was not approved here is. A decision file names the channel it was
// written by; the channel that counts is the one this machine recorded with its approval (approved.json), because a
// file from git can claim anything.
export const CHANNELS = ['board', 'cli-tty', 'cli-agent'];
export const HUMAN_CHANNELS = new Set(['board', 'cli-tty']);
const BATCH_ID = /^[\w-]{1,40}$/;
export const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

// The reason a decision takes: one of its reasons when it has some, none at all otherwise (`fix --reason intended` is
// refused, not recorded). One check for `nunchi decide` and the board (`asked`: how the reason is given there).
// → null, or what is wrong.
export function reasonProblem(decision, reason, { asked = '--reason ' } = {}) {
  const reasons = Object.hasOwn(DECISIONS, decision) ? DECISIONS[decision] : null;
  if (!reasons) return `unknown decision "${decision}" (${Object.keys(DECISIONS).join(', ')})`;
  if (reasons.length) return reasons.includes(reason) ? null : `"${decision}" needs ${asked}${reasons.join(' | ')}`;
  return reason === null || reason === undefined ? null : `"${decision}" takes no reason`;
}
// A decision's note (committed, shared through git): secrets scrubbed first, then clipped to 500 characters (code
// points), so a clip never leaves half a key that no scanner would know.
export const noteOf = note => (note ? [...scrubSecrets(redactText(String(note)))].slice(0, 500).join('').toWellFormed() : null);
export function buildDecision({ target, decision, reason = null, note = null, by, channel = null, batch = null }) {
  const bad = reasonProblem(decision, reason);
  if (bad) throw Object.assign(new Error(bad), { code: 'BAD_ARGS' });
  if (channel !== null && !CHANNELS.includes(channel)) throw Object.assign(new Error(`unknown channel "${channel}"`), { code: 'BAD_ARGS' });
  if (batch !== null && !BATCH_ID.test(String(batch))) throw Object.assign(new Error('a batch id is up to 40 letters, digits, _ or -'), { code: 'BAD_ARGS' });
  return { schema: 1, id: newId(), target, decision, reason, note: noteOf(note), by, at: kst(), fingerprintVersion: FINGERPRINT_VERSION,
    ...(channel ? { channel } : {}), ...(batch ? { batch: String(batch) } : {}) };
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
const strings = x => Array.isArray(x) && x.every(y => typeof y === 'string');
const stringMap = x => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x).every(y => typeof y === 'string');
export const isApprovedDoc = doc => !!doc && strings(doc.approved) && (doc.legacy === undefined || strings(doc.legacy))
  && (doc.channels === undefined || stringMap(doc.channels)) && (doc.confirmed === undefined || strings(doc.confirmed));
const APPROVED_READ = { fix: APPROVED_FIX, validate: isApprovedDoc, why: 'has no "approved" list' };
const NOTE = 'decisions made or approved on this machine, by id and content; anything else came through git';

function readApprovedDoc(file) {
  const { doc } = readDoc(file, APPROVED_READ);
  return doc ? { approved: new Set(doc.approved), legacy: doc.legacy || [], channels: doc.channels || {}, confirmed: doc.confirmed || [] }
    : { approved: new Set(), legacy: [], channels: {}, confirmed: [] };
}
export const readApproved = file => readApprovedDoc(file).approved;
// The approvals with how each was made (design §1): `channels` (approval key → board | cli-tty | cli-agent; an
// approval written before channels existed has none) and `confirmed` (keys a person confirmed in the board).
export function readApprovals(file) {
  const d = readApprovedDoc(file);
  return { approved: d.approved, channels: new Map(Object.entries(d.channels)), confirmed: new Set(d.confirmed) };
}
// The channels and confirmations an approval list keeps: only for keys it still approves, sorted.
function keepChannels(approved, channels = {}, confirmed = []) {
  const ch = Object.fromEntries(Object.entries(channels).filter(([k, v]) => approved.has(k) && CHANNELS.includes(v)).sort(([a], [b]) => (a < b ? -1 : 1)));
  const cf = [...new Set(confirmed)].filter(k => approved.has(k)).sort();
  return { ...(Object.keys(ch).length ? { channels: ch } : {}), ...(cf.length ? { confirmed: cf } : {}) };
}
// Two approval lists of this machine, merged (state.mjs adoptLegacy). Every approval and legacy id of both stays.
export function mergeApprovedDocs(a, b) {
  const approved = [...new Set([...(a?.approved || []), ...(b?.approved || [])])].sort();
  const legacy = [...new Set([...(a?.legacy || []), ...(b?.legacy || [])])].sort();
  return { schema: 2, note: NOTE, approved, ...(legacy.length ? { legacy } : {}),
    ...keepChannels(new Set(approved), { ...(b?.channels || {}), ...(a?.channels || {}) }, [...(a?.confirmed || []), ...(b?.confirmed || [])]) };
}

// Is a decision on this target one that could hide something serious (a blocker or an L9 finding)? A target the
// ledger does not know counts as serious. An AI item counts by its protected severity.
export function seriousTarget(state) {
  const fps = new Map(), groups = new Map();
  for (const i of Object.values(state.items)) {
    const s = protectOf(i) === 'blocker' || i.lens === 'L9';
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

// Through the state store (read, change, commit if nobody wrote in between, else again), so two decides at once
// both count; a file that cannot be read stops the write. Older approvals are carried over on the way
// (bindApproved); those not carried over are kept under `legacy`, never honoured.
// `channel` (design §1): how these approvals were made, kept per key. An approval already on record keeps the channel
// it was made with (approving a decision again does not change how it was made). `confirm`: keys a person confirmed
// in the board (a decision the agent recorded, or one that came through git), approved here too if they were not.
export function addApproved(file, keys, { decisions = [], serious, generation = null, channel = null, confirm = [] } = {}) {
  if (channel !== null && !CHANNELS.includes(channel)) throw Object.assign(new Error(`unknown channel "${channel}"`), { code: 'BAD_ARGS' });
  let r;
  updateDoc(file, doc => {
    const cur = doc ? { approved: new Set(doc.approved), legacy: doc.legacy || [], channels: doc.channels || {}, confirmed: doc.confirmed || [] }
      : { approved: new Set(), legacy: [], channels: {}, confirmed: [] };
    r = bindApproved(cur.approved, decisions, { serious });
    const channels = { ...cur.channels };
    for (const k of keys) { if (channel && !r.approved.has(k) && !channels[k]) channels[k] = channel; r.approved.add(k); }
    for (const k of confirm) r.approved.add(k);
    const legacy = [...new Set([...cur.legacy, ...r.left.map(x => x.id)])].sort();
    return { schema: 2, note: NOTE, approved: [...r.approved].sort(), ...(legacy.length ? { legacy } : {}), ...keepChannels(r.approved, channels, [...cur.confirmed, ...confirm]) };
  }, { read: APPROVED_READ, prev: false, generation });
  return r;
}

// ---- view ------------------------------------------------------------------------------------------

// A decision dated more than this after it arrived on this machine was dated ahead: it never counts.
export const FUTURE_SLACK_MS = 5 * 60e3;
// An open item no run has looked at again for this many runs is said to be so: it cannot be marked fixed.
export const NOT_LOOKED_RUNS = 3;
// An AI item double-checked by a verifier that was not suspect, in a run with enough decoys to check it.
export const checkedAi = item => item.verification?.status === 'confirmed' && !item.verification.suspect && !item.verification.tooFewDecoys;

// Status of every fingerprint, from the state and the decisions. The latest decision on the fingerprint or on
// its group that may count wins (at the same time, the fingerprint's). A decision's time is the earlier of its
// date and when this machine first saw it (state.decisionsSeen; now, if not noted yet), so one that arrived
// late cannot outrank decisions made after it arrived. Shown in `note` and not counted: a decision dated ahead
// of its arrival (or with no readable date), and a keep or false-positive on a blocker or an L9 finding that
// was not made or approved on this machine (came through git). A decision made under an older fingerprint
// version follows its item (currentTargets); its approval and arrival stay those of the file as written.
// AI items (design §2.2): a group decision covers one only when it is double-checked (confirmed, not suspect) or
// the decision came after its latest verification; on a blocker or L9 item it never covers a fingerprint first
// seen after the decision. An AI item no longer claimed by 2 hunts that saw its screen is `stale`.
// `channels` / `confirmed` (readApprovals): with them, each row's decision also says how it was made (`channel`:
// board, cli-tty, cli-agent, `unknown` for an approval from before channels, `git` when not approved here) and
// whether a person made or confirmed it (`human`, design §1).
export function view(state, decisions, approved = new Set(), { now = Date.now(), channels = null, confirmed = null } = {}) {
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
  // "not looked at for 3 runs" counts the runs of the item's own stream (worktree): another worktree's captures do
  // not look at it (only the stream that last saw an item can fix it)
  const streams = new Map();
  const runsOf = s => { if (!streams.has(s)) { const list = captureRuns(state, s); streams.set(s, { list, at: new Map(list.map((r, i) => [r, i])) }); } return streams.get(s); };
  const rows = [];
  for (const item of Object.values(state.items)) {
    const ai = isAi(item);
    const mine = [...(on.get(`group:${item.group}`) || []).map(d => [d, 0]), ...(on.get(`fp:${item.fp}`) || []).map(d => [d, 1])]
      .sort((a, b) => timeOf(a[0]) - timeOf(b[0]) || a[1] - b[1] || (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : 0)).map(x => x[0]);
    const serious = protectOf(item) === 'blocker' || item.lens === 'L9';
    let d = null, note = null;
    for (let i = mine.length - 1; i >= 0 && !d; i--) {
      const x = mine[i];
      if (!dated(x)) { note ||= `a ${x.decision} decision dated ${x.at}, ahead of when it arrived here (or with no readable date), does not count`; continue; }
      if (serious && !approved.has(keyOfDecision(x)) && (x.decision === 'keep' || x.decision === 'false-positive')) { note ||= `a ${x.decision} decision came through git and needs approval on this machine`; continue; }
      if (ai && !x.target.fp) {
        if (serious && Number.isFinite(item.addedAt) && timeOf(x) < item.addedAt) { note ||= `a group ${x.decision} decision made before this AI finding was first seen does not cover it (blocker or L9)`; continue; }
        // a verification from a run with too few decoys to check the checker is no double-check (verify.mjs): a group
        // decision made after it covers the finding no more than one made after a bare claim does
        const at = item.verification?.tooFewDecoys ? null : item.verification?.at;
        if (!checkedAi(item) && !(Number.isFinite(at) && timeOf(x) >= at)) { note ||= item.verification?.tooFewDecoys ? `a group ${x.decision} decision does not cover an AI finding verified with too few decoys to check the checker (not double-checked)` : `a group ${x.decision} decision does not cover an AI finding that was not double-checked when it was made`; continue; }
      }
      d = x;
    }
    const verified = d ? approved.has(keyOfDecision(d)) : true;
    const how = d && channels ? (() => {
      const key = keyOfDecision(d);
      const channel = !verified ? 'git' : channels.get(key) || 'unknown';
      return { channel, human: verified && (HUMAN_CHANNELS.has(channel) || !!confirmed?.has(key)), key, target: d.target, ...(d.note ? { note: d.note } : {}), ...(d.batch ? { batch: d.batch } : {}) };
    })() : null;
    if (d && d.decision === 'reopen') d = null;
    let status;
    if (item.goneAt) status = 'fixed';
    else if (d?.decision === 'keep') status = 'kept';
    else if (d?.decision === 'false-positive') status = 'dismissed';
    else if (d?.decision === 'hold') status = 'held';
    else if (d?.decision === 'fix') status = 'to-fix';
    else status = item.regressedAt ? 'regressed' : 'open';
    const stale = ai && !item.goneAt && (item.silentHunts || 0) >= STALE_HUNTS;
    if (stale && (status === 'open' || status === 'regressed')) status = 'stale';
    const last = item.lookedAt || item.lastSeen;
    const own = runsOf(streamOf(item));
    const notLookedAt = !item.goneAt && own.at.has(last) && own.list.length - 1 - own.at.get(last) >= NOT_LOOKED_RUNS ? last : null;
    rows.push({ ...item, source: item.source || 'rule', status, decision: d ? { id: d.id, decision: d.decision, reason: d.reason, by: d.by, at: d.at, verified, ...(how || {}) } : null, note, notLookedAt,
      ...(ai ? { stale, needsYou: item.needsYou ?? null, checked: checkedAi(item) } : {}) });
  }
  return rows.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || (x.group < y.group ? -1 : x.group > y.group ? 1 : x.fp < y.fp ? -1 : 1));
}

// Rows → groups: the unit a person reads and decides on.
export function groups(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.group)) by.set(r.group, { group: r.group, lens: r.lens, rule: r.rule, source: r.source || 'rule', title: titleOf(r.rule), severity: r.severity, routes: [], fps: [], places: 0, statuses: {}, example: r });
    const g = by.get(r.group);
    if (SEVERITY[r.severity] < SEVERITY[g.severity]) g.severity = r.severity;
    if (r.route !== null && !g.routes.includes(r.route)) g.routes.push(r.route);
    g.fps.push(r.fp);
    g.places += r.places || 1;
    g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
    if (r.source === 'ai') g.checked = (g.checked ?? true) && !!r.checked;
  }
  return [...by.values()].map(g => ({ ...g, routes: g.routes.sort(), fps: g.fps.sort(), status: Object.keys(g.statuses).length === 1 ? Object.keys(g.statuses)[0] : 'mixed' }))
    .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.routes.length - a.routes.length || b.places - a.places || (a.group < b.group ? -1 : 1));
}

// ---- trust (spec §4) ----------------------------------------------------------------------------------

// Per lens and source (design §2.2: rules and the AI share L1, L2, L4, L6, L7, L9 and L10, and one must not lend the
// other its record): precision = fix ÷ (fix + false positive) over the last 20 decisions of those two kinds; below
// 70% the lens's new findings are suspect. "Intended" keeps are not counted: the finding was right, the person
// wants it that way. Resolution: how many findings decided "fix" are now gone on re-capture.
// Keys: the lens for rules (as before AI items existed), `<lens>/ai` for the AI; each entry names its lens and source.
export const trustKey = (lens, source) => (source === 'ai' ? `${lens}/ai` : lens);
export function trust(rows, decisions, { window = 20, threshold = 0.7 } = {}) {
  const keyOfTarget = new Map();
  for (const r of rows) { const k = [r.lens, r.source === 'ai' ? 'ai' : 'rule']; keyOfTarget.set(`fp:${r.fp}`, k); keyOfTarget.set(`group:${r.group}`, k); }
  const out = {};
  const ensure = (lens, source) => (out[trustKey(lens, source)] ||= { lens, source, window, fix: 0, falsePositive: 0, precision: null, suspect: false, decidedFix: 0, fixed: 0 });
  const per = new Map();
  for (const d of decisions) {
    const k = keyOfTarget.get(d.target.fp ? `fp:${d.target.fp}` : `group:${d.target.group}`);
    if (!k || (d.decision !== 'fix' && d.decision !== 'false-positive')) continue;
    const id = trustKey(...k);
    if (!per.has(id)) per.set(id, { k, list: [] });
    per.get(id).list.push(d);
  }
  for (const { k, list } of per.values()) {
    const t = ensure(...k);
    for (const d of list.slice(-window)) d.decision === 'fix' ? t.fix++ : t.falsePositive++;
    t.precision = t.fix + t.falsePositive ? t.fix / (t.fix + t.falsePositive) : null;
    t.suspect = t.precision !== null && t.fix + t.falsePositive >= 5 && t.precision < threshold;
  }
  for (const r of rows) {
    if (r.decision?.decision !== 'fix' && r.status !== 'fixed') continue;
    const t = ensure(r.lens, r.source === 'ai' ? 'ai' : 'rule');
    if (r.decision?.decision === 'fix') { t.decidedFix++; if (r.status === 'fixed') t.fixed++; }
  }
  return Object.fromEntries(Object.entries(out).sort());
}
