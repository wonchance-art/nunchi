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
// - status (open, fixed, regressed, …) is computed from runs into .nunchi/state/ledger.json (git-ignored),
//   never hand-edited and never committed.
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha, stableJson } from './stable.mjs';

export const FINGERPRINT_VERSION = 1;

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
export function evidenceKey(rule, evidence = {}) {
  const out = {};
  for (const k of Object.keys(evidence || {}).sort()) {
    if (VOLATILE.has(k)) continue;
    if (k === 'text' && DROP_TEXT.has(rule)) continue;
    if (k === 'url' || k === 'href' || k === 'src' || k === 'finalPath') { out[k] = norm(String(evidence[k]).split(/[?#]/)[0]); continue; }
    out[k] = norm(evidence[k]);
  }
  return out;
}

export function fingerprintOf(f) {
  const inputs = { v: FINGERPRINT_VERSION, lens: f.lens, rule: f.rule, route: f.route ?? null, element: normalizeSelector(f.selector), evidence: evidenceKey(f.rule, f.evidence) };
  const { route, ...rest } = inputs;
  // Low contrast has one cause however many elements show it: the colour pair (a design token).
  const pair = f.rule === 'axe-color-contrast' && /foreground color: (#[0-9a-f]{3,8}), background color: (#[0-9a-f]{3,8})/i.exec(f.evidence?.summary || '');
  const groupInputs = pair ? { v: FINGERPRINT_VERSION, rule: f.rule, colors: [pair[1].toLowerCase(), pair[2].toLowerCase()] } : rest;
  return { fp: sha(stableJson(inputs), 12), group: sha(stableJson(groupInputs), 12), inputs };
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

// ---- state (local, computed) ------------------------------------------------------------------------

export function readState(file) {
  if (!existsSync(file)) return { schema: 1, fingerprintVersion: FINGERPRINT_VERSION, runs: [], items: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeAtomic(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, stableJson(value));
  renameSync(tmp, file);
}

// Fold one complete run into the state. A defect counts as gone only where the run looked: its route was in
// scope, for the persons it was seen with, and the run was healthy enough to see them.
export function foldRun(state, { id, scope = {}, health = { problems: [] }, findings }) {
  if (state.runs.includes(id)) return state;
  const next = { ...state, runs: [...state.runs, id].sort(), items: { ...state.items } };
  const present = new Map();
  for (const f of findings) {
    if (!present.has(f.fp)) present.set(f.fp, { f, persons: new Set(), viewports: new Set(), states: new Set(), scenes: [] });
    const p = present.get(f.fp);
    const scene = f.scene || '';
    const [person, state, vp] = scene.split('.').slice(-3);
    if (person) p.persons.add(person); if (state) p.states.add(state); if (vp) p.viewports.add(vp);
    if (f.scene && p.scenes.length < 20) p.scenes.push(f.scene);
  }
  for (const [fp, p] of present) {
    const old = next.items[fp];
    const base = { fp, group: p.f.group, lens: p.f.lens, rule: p.f.rule, severity: p.f.severity, route: p.f.route ?? null,
      persons: [...p.persons].sort(), viewports: [...p.viewports].sort(), states: [...p.states].sort(), places: p.scenes.length, examples: p.scenes.slice(0, 5),
      selector: p.f.selector ?? null, evidence: p.f.evidence, inputs: fingerprintOf(p.f).inputs };
    if (!old) next.items[fp] = { ...base, firstSeen: id, lastSeen: id, goneAt: null, regressedAt: null };
    else next.items[fp] = { ...old, ...base, lastSeen: id, goneAt: null, regressedAt: old.goneAt ? id : old.regressedAt };
  }
  const blind = new Set(health.problems.map(p => p.status));
  const routes = scope.routes ? new Set(scope.routes) : null;
  const persons = new Set(scope.persons || ['guest']);
  for (const [fp, item] of Object.entries(next.items)) {
    if (present.has(fp) || item.goneAt) continue;
    if (blind.has('app-unreachable')) continue;
    if (item.persons.includes('signed-in') && (blind.has('login-expired') || !persons.has('signed-in'))) continue;
    if (item.route === null ? scope.changedSince : routes && !routes.has(item.route)) continue;
    next.items[fp] = { ...item, goneAt: id };
  }
  return next;
}

export function updateState(file, run) {
  const next = foldRun(readState(file), run);
  writeAtomic(file, next);
  return next;
}

// ---- decisions (committed, append-only) ------------------------------------------------------------

export const DECISIONS = {
  fix: [],
  keep: ['intended', 'out-of-scope'],
  'false-positive': ['not-a-problem', 'wrong-place'],
  hold: [],
  reopen: [],
};

export function readDecisions(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const target of readdirSync(dir).sort()) {
    const sub = join(dir, target);
    let files;
    try { files = readdirSync(sub); } catch { continue; }
    for (const f of files.filter(f => f.endsWith('.json')).sort()) {
      try { out.push(JSON.parse(readFileSync(join(sub, f), 'utf8'))); } catch {}
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00');

export function writeDecision(dir, { target, decision, reason = null, note = null, by }) {
  if (!DECISIONS[decision]) throw Object.assign(new Error(`unknown decision "${decision}" (${Object.keys(DECISIONS).join(', ')})`), { code: 'BAD_ARGS' });
  const reasons = DECISIONS[decision];
  if (reasons.length && !reasons.includes(reason)) throw Object.assign(new Error(`"${decision}" needs --reason ${reasons.join(' | ')}`), { code: 'BAD_ARGS' });
  const key = target.fp ? `fp-${target.fp}` : `group-${target.group}`;
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const d = { schema: 1, id, target, decision, reason, note: note ? String(note).slice(0, 500) : null, by, at: kst(), fingerprintVersion: FINGERPRINT_VERSION };
  mkdirSync(join(dir, key), { recursive: true });
  writeFileSync(join(dir, key, `${id}.json`), stableJson(d));
  return d;
}

export function readApproved(file) {
  try { return new Set(JSON.parse(readFileSync(file, 'utf8')).approved || []); } catch { return new Set(); }
}
export function addApproved(file, ids) {
  const set = readApproved(file);
  for (const id of ids) set.add(id);
  writeAtomic(file, { schema: 1, note: 'decisions made or approved on this machine; anything else came through git', approved: [...set].sort() });
}

// ---- view ------------------------------------------------------------------------------------------

// Status of every fingerprint, from the state and the decisions. The latest decision on the fingerprint or
// on its group wins; an unverified one is shown but only counts when it cannot hide something serious.
export function view(state, decisions, approved = new Set()) {
  const latest = new Map();
  for (const d of decisions) latest.set(d.target.fp ? `fp:${d.target.fp}` : `group:${d.target.group}`, d);
  const rows = [];
  for (const item of Object.values(state.items)) {
    const a = latest.get(`fp:${item.fp}`), b = latest.get(`group:${item.group}`);
    let d = !a ? b : !b ? a : (a.at >= b.at ? a : b);
    const verified = d ? approved.has(d.id) : true;
    const serious = item.severity === 'blocker' || item.lens === 'L9';
    let note = null;
    if (d && !verified && serious && (d.decision === 'keep' || d.decision === 'false-positive')) { note = `a ${d.decision} decision came through git and needs approval on this machine`; d = null; }
    if (d && d.decision === 'reopen') d = null;
    let status;
    if (item.goneAt) status = 'fixed';
    else if (d?.decision === 'keep') status = 'kept';
    else if (d?.decision === 'false-positive') status = 'dismissed';
    else if (d?.decision === 'hold') status = 'held';
    else if (d?.decision === 'fix') status = 'to-fix';
    else status = item.regressedAt ? 'regressed' : 'open';
    rows.push({ ...item, status, decision: d ? { id: d.id, decision: d.decision, reason: d.reason, by: d.by, at: d.at, verified } : null, note });
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
