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
//   Approval is bound to the decision's content, not to its id.
// - status (open, fixed, regressed, …) is computed from runs into .nunchi/state/ledger.json (git-ignored),
//   never hand-edited and never committed. Every complete run is folded, in run order, like for like.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha, stableJson, writeAtomic, withLock } from './stable.mjs';
import { listRuns } from './runs.mjs';

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

// A file nunchi wrote and can no longer read is an error, never "empty": an empty ledger or approval list
// written back over it would lose what it held.
const corrupt = (file, why) => Object.assign(new Error(`${file} ${why}`), { code: 'CORRUPT', file });
const readJsonStrict = (file, fix) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw corrupt(file, `cannot be read (${String(e.message).split('\n')[0]}): ${fix}`); }
};
const REBUILD = 'delete it and the next nunchi command rebuilds it from the runs on disk';

export function readState(file) {
  if (!existsSync(file)) return { schema: 1, fingerprintVersion: FINGERPRINT_VERSION, runs: [], items: {} };
  const s = readJsonStrict(file, REBUILD);
  if (!s || !Array.isArray(s.runs) || !s.items || typeof s.items !== 'object') throw corrupt(file, `is not a nunchi ledger: ${REBUILD}`);
  return s;
}

// Run ids are digits, zero-padded to 4 and longer past 9999: shorter is older.
export const byRun = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const minRun = (a, b) => (byRun(a, b) <= 0 ? a : b);

// A cell is where a finding was seen on its route: person.state.viewport (the end of the scene id).
const cellOfScene = id => { const [person, state, vp] = String(id).split('.').slice(-3); return person && state && vp ? { person, state, vp, cell: `${person}.${state}.${vp}` } : null; };
// Scenes that show their own route: captured, not redirected, not an error page, not a canary copy.
const looked = s => s.status === 'captured' && s.canary === undefined && !s.redirected && !/^redirected/.test(s.reason || '') && !(s.httpStatus >= 400);
// Whole-app detectors judge every route at once (secrets in any bundle, the link graph, the design system's
// one-offs): only a run over the whole app, with at least the persons, states and viewports of the run that
// last saw the finding, can say it is gone.
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

// Did this run look again, like for like, everywhere the item was last seen?
function lookedAgain(item, run) {
  const cells = cellsOf(item);
  if (wholeAppItem(item)) {
    if (!run.wholeApp) return false;
    const was = item.runScope || {};
    for (const k of ['persons', 'states', 'viewports']) if ((was[k] || []).some(x => !(run.scope[k] || []).includes(x))) return false;
  } else if (!cells.length) return false;
  const need = new Set(cells);
  if (PARTNER[item.rule]) for (const c of cells) need.add(PARTNER[item.rule](c.split('.')));
  for (const c of need) {
    if (run.loginExpired && c.startsWith('signed-in.')) return false;
    if (!run.covered.has(`${item.route}|${c}`)) return false;
  }
  return true;
}

// Fold one complete run into the state (design 0.1-c §2.1).
// - Gone only like for like: an item gets `goneAt` only when this run captured every cell it was last seen in
//   (captured and showing its own route), ran its detector over the same scope (whole-app detectors need a
//   whole-app run; parity and state comparisons need both sides), and the app was reachable, the recording
//   current and the login working. A partial run (--states, --viewports, --routes, --changed-since) fixes
//   nothing it did not look at.
// - Monotonic: a run older than the newest folded run only adds what it saw. It never sets `goneAt`, never moves
//   `lastSeen` back, and brings an item back only when it saw it after the run that found it gone.
// - Folding the same run twice changes nothing.
export function foldRun(state, { id, scope = {}, wholeApp = false, health = { problems: [] }, scenes = [], findings }) {
  if (state.runs.includes(id)) return state;
  const newest = !state.runs.some(r => byRun(r, id) > 0);
  const next = { ...state, runs: [...state.runs, id].sort(byRun), items: { ...state.items } };
  const present = new Map();
  for (const f of findings) {
    if (!present.has(f.fp)) present.set(f.fp, { f, persons: new Set(), viewports: new Set(), states: new Set(), cells: new Set(), scenes: [] });
    const p = present.get(f.fp);
    const c = f.scene ? cellOfScene(f.scene) : null;
    if (c) { p.persons.add(c.person); p.states.add(c.state); p.viewports.add(c.vp); p.cells.add(c.cell); }
    if (f.scene && p.scenes.length < 20) p.scenes.push(f.scene);
  }
  const runScope = { persons: [...(scope.persons || [])].sort(), states: [...(scope.states || [])].sort(), viewports: [...(scope.viewports || [])].sort() };
  for (const [fp, p] of present) {
    const old = next.items[fp];
    const base = { fp, group: p.f.group, lens: p.f.lens, rule: p.f.rule, severity: p.f.severity, route: p.f.route ?? null,
      persons: [...p.persons].sort(), viewports: [...p.viewports].sort(), states: [...p.states].sort(), cells: [...p.cells].sort(), places: p.scenes.length, examples: p.scenes.slice(0, 5),
      selector: p.f.selector ?? null, evidence: p.f.evidence, inputs: fingerprintOf(p.f).inputs };
    if (wholeAppItem(base)) base.runScope = runScope;
    if (!old) { next.items[fp] = { ...base, firstSeen: id, lastSeen: id, goneAt: null, regressedAt: null }; continue; }
    const later = byRun(id, old.lastSeen) > 0;                         // a newer sighting than the one on record
    const back = !!old.goneAt && byRun(id, old.goneAt) > 0;             // seen after the run that found it gone
    next.items[fp] = { ...old, ...(later ? base : {}), firstSeen: minRun(old.firstSeen, id), lastSeen: later ? id : old.lastSeen,
      goneAt: back ? null : old.goneAt, regressedAt: back ? id : old.regressedAt };
  }
  if (!newest) return next;
  const blind = new Set((health.problems || []).map(p => p.status));
  if (blind.has('app-unreachable') || blind.has('recording-stale')) return next;
  const run = { scope, wholeApp: wholeApp === true, loginExpired: blind.has('login-expired'),
    covered: new Set(scenes.filter(looked).map(s => `${s.route}|${s.person}.${s.state}.${s.viewport}`)) };
  for (const [fp, item] of Object.entries(next.items)) {
    if (present.has(fp) || item.goneAt) continue;
    if (lookedAgain(item, run)) next.items[fp] = { ...item, goneAt: id };
  }
  return next;
}

// What a complete run folder gives the fold. A file of it that cannot be read is an error: a run is never
// skipped quietly, or the ledger would say nothing about what it saw.
export function runForFold(runDir) {
  const fix = `fix or remove the run folder ${runDir}`;
  const meta = readJsonStrict(join(runDir, 'run.json'), fix);
  const manifest = readJsonStrict(join(runDir, 'manifest.json'), fix);
  const doc = readJsonStrict(join(runDir, 'findings.json'), fix);
  if (!Array.isArray(manifest?.scenes) || !Array.isArray(doc?.findings)) throw corrupt(runDir, `is not a complete capture run (no scenes in manifest.json or no findings in findings.json): ${fix}`);
  return { id: basename(runDir), scope: meta?.scope || {}, wholeApp: meta?.wholeApp === true, health: manifest.health || { problems: [] }, scenes: manifest.scenes,
    findings: doc.findings.map(f => (f.fp ? f : { ...f, fp: fingerprintOf(f).fp, group: fingerprintOf(f).group })) };
}

// Brings the ledger up to date with the runs on disk: every complete run not folded yet is folded, oldest
// first, under the ledger lock. A crash after a run is complete and before its fold leaves nothing behind:
// the next command folds it. Nothing to fold: nothing is written.
export function syncLedger(stateFile, runsDir) {
  const pending = s => listRuns(runsDir).complete.filter(id => !s.runs.includes(id)).sort(byRun);
  const state = readState(stateFile);
  if (!pending(state).length) return state;
  return withLock(stateFile, lock => {
    let s = readState(stateFile);
    for (const id of pending(s)) { s = foldRun(s, runForFold(join(runsDir, id))); lock.touch(); }
    writeAtomic(stateFile, stableJson(s), { durable: true });
    return s;
  });
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
// Decisions are ordered by their time (an unreadable time sorts last and never counts, see view), then id.
const timeOf = d => { const t = Date.parse(d.at); return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
const byTime = (a, b) => timeOf(a) - timeOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every decision file, oldest first. A file that is not valid JSON (a torn write, a bad merge), is not a
// decision, or does not match its place (file name = id, folder = target) is an error naming the file, never
// skipped: a decision that silently drops out changes what the ledger says.
export function readDecisions(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const folder of readdirSync(dir).sort()) {
    const sub = join(dir, folder);
    if (!statSync(sub).isDirectory()) continue;
    for (const f of readdirSync(sub).filter(f => f.endsWith('.json')).sort()) {
      const file = join(sub, f);
      const d = readJsonStrict(file, 'a torn write or a bad merge; restore it from git or delete it');
      if (!isDecision(d)) throw corrupt(file, 'is not a nunchi decision; restore it from git or delete it');
      if (`${d.id}.json` !== f || folderOf(d.target) !== folder) throw corrupt(file, `does not match its place (decision ${d.id} belongs in ${folderOf(d.target)}/${d.id}.json): moved, copied or edited by hand; restore it from git or delete it`);
      out.push(d);
    }
  }
  return out.sort(byTime);
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
// An approval names a decision's content, not only its id: `<id>:<hash of the record>`. A decision file that
// reuses an approved id with other content (copied, edited or forged) is not approved.
export const decisionHash = d => sha(stableJson(d), 16);
export const approvalKey = d => `${d.id}:${decisionHash(d)}`;

export function readApproved(file) {
  if (!existsSync(file)) return new Set();
  const fix = 'nothing was written; fix it by hand, or delete it (decisions made here then need nunchi approve again)';
  const doc = readJsonStrict(file, fix);
  if (!doc || !Array.isArray(doc.approved) || !doc.approved.every(x => typeof x === 'string')) throw corrupt(file, `has no "approved" list: ${fix}`);
  return new Set(doc.approved);
}

// Approvals written before content binding name a bare id. Each binds to the one decision file that has that
// id now; an id that two files share (one copied or forged) binds to neither and stays as it was.
export function bindApproved(approved, decisions) {
  const byId = new Map();
  for (const d of decisions) byId.set(d.id, [...(byId.get(d.id) || []), d]);
  const out = new Set();
  for (const k of approved) {
    const same = k.includes(':') ? null : byId.get(k);
    out.add(same && same.length === 1 ? approvalKey(same[0]) : k);
  }
  return out;
}

// Under a lock, so two decides at once both count; a file that cannot be read stops the write.
export function addApproved(file, keys, decisions = []) {
  withLock(file, () => {
    const set = bindApproved(readApproved(file), decisions);
    for (const k of keys) set.add(k);
    writeAtomic(file, stableJson({ schema: 2, note: 'decisions made or approved on this machine, by id and content; anything else came through git', approved: [...set].sort() }), { durable: true });
  });
}

// ---- view ------------------------------------------------------------------------------------------

// A decision dated more than this ahead of the clock does not count: it would outrank every later decision.
export const FUTURE_SLACK_MS = 5 * 60e3;

// Status of every fingerprint, from the state and the decisions. The latest decision on the fingerprint or on
// its group that may count wins (at the same instant, the fingerprint's). Shown in `note` and not counted: a
// decision dated in the future, and a keep or false-positive on a blocker or an L9 finding that was not made or
// approved on this machine (came through git).
export function view(state, decisions, approved = new Set(), { now = Date.now() } = {}) {
  const on = new Map();
  for (const d of decisions) {
    const k = d.target.fp ? `fp:${d.target.fp}` : `group:${d.target.group}`;
    if (!on.has(k)) on.set(k, []);
    on.get(k).push(d);
  }
  const known = new Map();
  const verifiedOf = d => { if (!known.has(d)) known.set(d, approved.has(approvalKey(d))); return known.get(d); };
  const rows = [];
  for (const item of Object.values(state.items)) {
    const mine = [...(on.get(`group:${item.group}`) || []).map(d => [d, 0]), ...(on.get(`fp:${item.fp}`) || []).map(d => [d, 1])]
      .sort((a, b) => timeOf(a[0]) - timeOf(b[0]) || a[1] - b[1] || byTime(a[0], b[0])).map(x => x[0]);
    const serious = item.severity === 'blocker' || item.lens === 'L9';
    let d = null, note = null;
    for (let i = mine.length - 1; i >= 0 && !d; i--) {
      const x = mine[i];
      if (!(timeOf(x) <= now + FUTURE_SLACK_MS)) { note ||= `a ${x.decision} decision dated ${x.at} (in the future, or no readable time) does not count`; continue; }
      if (serious && !verifiedOf(x) && (x.decision === 'keep' || x.decision === 'false-positive')) { note ||= `a ${x.decision} decision came through git and needs approval on this machine`; continue; }
      d = x;
    }
    const verified = d ? verifiedOf(d) : true;
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
