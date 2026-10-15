// The guards' kinds and their file (design 0.1-c §5, spec §7.3), with no parser: what each built-in guard is called,
// which ledger findings it keeps from coming back, the typed parameters it takes, `.nunchi/guards.json` validated
// strictly, the baseline compared by content, and what weakens a guard. The scanner itself is guards.mjs (it needs
// the pinned parser that `nunchi setup` installs); the board and the fix loop need only this.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseColor } from './tokens.mjs';
import { stableJson, writeAtomic, refuseLink } from './stable.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (code, message) => Object.assign(new Error(message), { code });

// ---- the kinds ------------------------------------------------------------------------------------------------------

export const KINDS = ['native-dialog', 'dead-href', 'raw-message', 'mustache-text', 'colour-literal'];
export const CALLS = ['alert', 'confirm', 'prompt'];
export const HREFS = ['#', 'javascript:'];
export const MAX_SOURCE_BYTES = 1024 * 1024;              // design §5: source files over 1 MB are skipped (and counted)
export const MAX_GUARDS_BYTES = 4 * 1024 * 1024;
export const MAX_COLORS = 512;
export const OPEN_INSTANCES = 5;                          // design §5: "≥ 5 open instances" shows a passive chip
export const CALL_LABEL = { confirm: '`window.confirm`', alert: '`alert`', prompt: '`window.prompt`' };
export const HREF_LABEL = { '#': '`href="#"`', 'javascript:': '`javascript:` links' };

// What each kind is called where a person reads it (the card, the chat line, `check`). Backticks mark code.
export function labelOf(kind, params = {}) {
  if (kind === 'native-dialog') return (params.calls || CALLS).map(c => CALL_LABEL[c]).join(' / ');
  if (kind === 'dead-href') return (params.values || HREFS).map(v => HREF_LABEL[v]).join(' / ');
  if (kind === 'raw-message') return '`.message` in JSX';
  if (kind === 'mustache-text') return '`{{` / `}}` in JSX text';
  if (kind === 'colour-literal') return 'colour literals outside the measured tokens';
  return kind;
}
// What a single hit is, in the check's words
const HIT_LABEL = {
  'native-dialog': h => CALL_LABEL[h.what] || '`window.confirm`',
  'dead-href': h => HREF_LABEL[h.what] || '`href="#"`',
  'raw-message': () => '`.message` in JSX',
  'mustache-text': h => `\`${h.what}\` in JSX text`,
  'colour-literal': h => `colour \`${h.what}\` outside the measured tokens`,
};
export const hitLabel = h => (HIT_LABEL[h.kind] ? HIT_LABEL[h.kind](h) : h.kind);

// The ledger's finding kinds a guard keeps from coming back (design §5 "of a kind that has a built-in guard"). The
// colour guard has none yet: its findings ("move to token") come with T2 (design §6a); it is added by a person with
// `nunchi guard --add colour-literal`.
export function guardKindOf(row) {
  if (!row) return null;
  if (row.rule === 'native-dialog') return 'native-dialog';
  if (row.rule === 'dead-href') return 'dead-href';
  if (row.rule === 'raw-error-text' || row.rule === 'L6.raw-technical-text') return 'raw-message';
  if (row.rule === 'missing-value' && /\{\{/.test(String(row.evidence?.kind || ''))) return 'mustache-text';
  return null;
}
// The parameters a guard offered after a fix takes: what the fixed findings were (a `confirm` fixed → `window.confirm`).
export function paramsFromRows(kind, rows) {
  if (kind === 'native-dialog') {
    const calls = [...new Set(rows.map(r => String(r.evidence?.type || '')).filter(t => CALLS.includes(t)))].sort();
    return { calls: calls.length ? calls : [...CALLS] };
  }
  if (kind === 'dead-href') {
    const values = [...new Set(rows.map(r => hrefValue(String(r.evidence?.href ?? ''))).filter(Boolean))].sort();
    return { values: values.length ? values : [...HREFS] };
  }
  return {};
}
export const hrefValue = v => { const s = v.replace(/[\t\n\r]/g, '').trim(); return s === '#' ? '#' : /^javascript:/i.test(s) ? 'javascript:' : null; };
export function defaultParams(kind) {
  if (kind === 'native-dialog') return { calls: [...CALLS] };
  if (kind === 'dead-href') return { values: [...HREFS] };
  return {};
}

// ---- guards.json ----------------------------------------------------------------------------------------------------

export const guardsPath = nunchiDir => join(nunchiDir, 'guards.json');
const ANCHOR = /^[0-9a-f]{16}$/;
export const WHAT = /^[#a-z0-9 ().,%/:{}_+-]{1,60}$/i;
export const whatOf = t => { const w = String(t).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60); return WHAT.test(w) ? w : null; };
export const safePath = p => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.includes('\\')
  && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/.test(p) && !p.split('/').some(s => s === '' || s === '.' || s === '..');
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const subset = (v, allowed) => Array.isArray(v) && v.length > 0 && v.length <= allowed.length && v.every(x => allowed.includes(x)) && new Set(v).size === v.length;

// A colour of the token set: a value parseColor reads, written with nothing but colour-syntax characters.
export const TOKEN_COLOR = /^[a-z0-9#(),.%/ +-]{1,80}$/i;
export function paramsProblem(kind, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'params must be an object';
  if (kind === 'native-dialog') return exact(p, ['calls']) && subset(p.calls, CALLS) ? null : `params of native-dialog: { "calls": a list of ${CALLS.join(', ')} }`;
  if (kind === 'dead-href') return exact(p, ['values']) && subset(p.values, HREFS) ? null : 'params of dead-href: { "values": a list of "#", "javascript:" }';
  if (kind === 'raw-message' || kind === 'mustache-text') return exact(p, []) ? null : `${kind} takes no params ({})`;
  if (kind === 'colour-literal') {
    if (!exact(p, ['colors', 'deltaE']) || !Array.isArray(p.colors) || !p.colors.length || p.colors.length > MAX_COLORS) return `params of colour-literal: { "colors": 1–${MAX_COLORS} colours, "deltaE": a number from 0 to 0.1 }`;
    if (!p.colors.every(c => typeof c === 'string' && TOKEN_COLOR.test(c) && parseColor(c))) return 'colour-literal: every colour must be a CSS colour value (#rgb, #rrggbb, rgb(), oklch() …)';
    if (new Set(p.colors).size !== p.colors.length) return 'colour-literal: a colour is listed twice';
    if (typeof p.deltaE !== 'number' || !Number.isFinite(p.deltaE) || p.deltaE < 0 || p.deltaE > 0.1) return 'colour-literal: deltaE is a number from 0 to 0.1';
    return null;
  }
  return 'unknown kind';
}

// Validates a parsed guards.json; → the document, normalised (lists sorted). A problem throws CORRUPT (exit 2).
export function validateGuards(doc, file = 'guards.json') {
  const bad = why => { throw fail('CORRUPT', `${file} is not a guards file nunchi can use: ${why}. Fix it by hand or remove it (git checkout -- ${file} restores the committed one).`); };
  if (!exact(doc, ['schema', 'guards', 'baseline'])) bad('the top level holds only "schema", "guards" and "baseline"');
  if (doc.schema !== 1) bad('"schema" must be 1');
  if (!Array.isArray(doc.guards) || doc.guards.length > KINDS.length) bad('"guards" must be a list of the built-in kinds');
  const guards = [];
  for (const g of doc.guards) {
    if (!exact(g, ['kind', 'params']) || typeof g.kind !== 'string') bad('a guard is { "kind", "params" } and nothing else');
    if (!KINDS.includes(g.kind)) bad(`"${String(g.kind).slice(0, 40)}" is not a built-in guard (${KINDS.join(', ')})`);
    if (guards.some(x => x.kind === g.kind)) bad(`${g.kind} is listed twice`);
    const why = paramsProblem(g.kind, g.params);
    if (why) bad(why);
    guards.push({ kind: g.kind, params: normParams(g.kind, g.params) });
  }
  if (!Array.isArray(doc.baseline) || doc.baseline.length > 200000) bad('"baseline" must be a list');
  const seen = new Set();
  const baseline = [];
  for (const e of doc.baseline) {
    if (!exact(e, ['kind', 'file', 'anchor', 'count', 'what'])) bad('a baseline entry is { "kind", "file", "anchor", "count", "what" } and nothing else');
    if (!guards.some(g => g.kind === e.kind)) bad(`a baseline entry names ${String(e.kind).slice(0, 40)}, which is not among the guards`);
    if (!safePath(e.file)) bad('a baseline file must be a plain relative path (no "..", no leading "/", forward slashes)');
    if (typeof e.anchor !== 'string' || !ANCHOR.test(e.anchor)) bad('a baseline anchor is 16 hex digits');
    if (!Number.isInteger(e.count) || e.count < 1 || e.count > 100000) bad('a baseline count is a whole number from 1');
    if (e.what !== undefined && (typeof e.what !== 'string' || !WHAT.test(e.what))) bad('a baseline "what" is a short description');
    const k = `${e.kind}\0${e.file}\0${e.anchor}`;
    if (seen.has(k)) bad(`${e.file} has the same baseline entry twice`);
    seen.add(k);
    baseline.push({ kind: e.kind, file: e.file, anchor: e.anchor, count: e.count, ...(e.what !== undefined ? { what: e.what } : {}) });
  }
  return { schema: 1, guards: sortGuards(guards), baseline: sortBaseline(baseline) };
}
export const normParams = (kind, p) => (kind === 'native-dialog' ? { calls: [...p.calls].sort() } : kind === 'dead-href' ? { values: [...p.values].sort() }
  : kind === 'colour-literal' ? { colors: [...p.colors].sort(), deltaE: p.deltaE } : {});
const sortGuards = gs => [...gs].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
export const sortBaseline = bs => [...bs].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || cmp(a.file, b.file) || cmp(a.anchor, b.anchor));
export const emptyGuards = () => ({ schema: 1, guards: [], baseline: [] });

// Reads and validates a guards file's text (a file, or a blob read from git for `--base`).
export function parseGuards(text, file = 'guards.json') {
  if (Buffer.byteLength(text) > MAX_GUARDS_BYTES) throw fail('CORRUPT', `${file} is larger than ${MAX_GUARDS_BYTES / 1024 / 1024} MB`);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw fail('CORRUPT', `${file} is not valid JSON (${String(e.message).split('\n')[0]}). Fix it by hand or remove it.`); }
  return validateGuards(doc, file);
}
// → the document, or null when there is no guards file. A link, a folder or an unreadable file is an error. `name`: the
// file as messages say it (the repository's path, `web/.nunchi/guards.json`), the path itself by default.
export function readGuards(path, name = path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw fail('CORRUPT', `${name} cannot be read (${e.code})`); }
  if (st.isSymbolicLink()) throw fail('UNSAFE_PATH', `${name} is a symbolic link; nunchi reads its guards from a plain file`);
  if (!st.isFile()) throw fail('CORRUPT', `${name} is not a file`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw fail('CORRUPT', `${name} cannot be read (${e.code})`); }
  return parseGuards(text, name);
}
// guards.json as the repository names it: the app's place in it (git's prefix, '' at the top or without git)
export const guardsName = prefix => `${prefix || ''}.nunchi/guards.json`;
// Written stable (sorted keys and lists) and atomically, never through a link. A committed file: its mode stays the
// file's own (not private).
export function writeGuards(path, doc) {
  const clean = validateGuards(doc, path);
  refuseLink(path);
  writeAtomic(path, stableJson(clean), { durable: true });
  return clean;
}

export const keyOf = e => `${e.kind}\0${e.file}\0${e.anchor}`;
// Hits → baseline entries (one per kind, file and anchor, with how many there are).
export function baselineOf(hits) {
  const by = new Map();
  for (const h of hits) {
    const k = keyOf(h);
    if (!by.has(k)) by.set(k, { kind: h.kind, file: h.file, anchor: h.anchor, count: 0, ...(h.what && WHAT.test(h.what) ? { what: h.what } : {}) });
    by.get(k).count++;
  }
  return sortBaseline([...by.values()]);
}
// Hits against the baseline: within a (kind, file, anchor), the first `count` hits (in file order) are the baselined
// ones and the rest are new. `gone`: baseline entries with fewer hits now (the baseline can be tightened).
export function compareBaseline(hits, baseline = []) {
  const base = new Map(baseline.map(e => [keyOf(e), e.count]));
  const used = new Map();
  const fresh = [], known = [];
  for (const h of hits) {
    const k = keyOf(h);
    const n = used.get(k) || 0;
    used.set(k, n + 1);
    (n < (base.get(k) || 0) ? known : fresh).push(h);
  }
  const gone = baseline.filter(e => (used.get(keyOf(e)) || 0) < e.count).map(e => ({ ...e, now: used.get(keyOf(e)) || 0 }));
  return { fresh, known, gone };
}

// What a guards file at an earlier commit had that this one has not (design §5: "a guard removed since <ref> counts
// as a hit"); also a guard narrowed (fewer calls or link kinds, more allowed colours, a wider ΔE) and a baseline that
// grew for a guard both have: each is a way to let a hit through without a new hit appearing.
// The baseline is compared per kind and anchor over every file, so a file renamed or moved (`git mv`, then
// `nunchi guard --baseline`) nets out. Growth is excused for the hits there now of what the guard took on since the
// ref (a call or link kind added by a widening, which baselines what it adds): `hits` are the scanner's, so what a hit
// is comes from the source, never from the file's own `what`.
export function weakenedSince(before, after, hits = []) {
  const out = [];
  if (!before) return out;
  const now = new Map((after?.guards || []).map(g => [g.kind, g.params]));
  for (const g of before.guards) {
    const p = now.get(g.kind);
    if (!p) { out.push({ kind: g.kind, why: 'removed', label: labelOf(g.kind, g.params) }); continue; }
    if (g.kind === 'native-dialog') { const lost = g.params.calls.filter(c => !p.calls.includes(c)); if (lost.length) out.push({ kind: g.kind, why: 'narrowed', detail: lost.map(c => CALL_LABEL[c]).join(' / '), label: labelOf(g.kind, g.params) }); }
    if (g.kind === 'dead-href') { const lost = g.params.values.filter(v => !p.values.includes(v)); if (lost.length) out.push({ kind: g.kind, why: 'narrowed', detail: lost.map(v => HREF_LABEL[v]).join(' / '), label: labelOf(g.kind, g.params) }); }
    if (g.kind === 'colour-literal') {
      const more = p.colors.filter(c => !g.params.colors.includes(c));
      if (more.length || p.deltaE > g.params.deltaE) out.push({ kind: g.kind, why: 'narrowed', detail: [more.length && `${more.length} more allowed colour${more.length === 1 ? '' : 's'}`, p.deltaE > g.params.deltaE && `ΔE ${g.params.deltaE} → ${p.deltaE}`].filter(Boolean).join(', '), label: labelOf(g.kind, g.params) });
    }
  }
  // a guard added since: its baseline is new by nature; one both have is compared
  const kept = new Set(before.guards.filter(g => now.has(g.kind)).map(g => g.kind));
  const totals = doc => {
    const m = new Map();
    for (const e of doc?.baseline || []) if (kept.has(e.kind)) { const k = `${e.kind}\0${e.anchor}`; m.set(k, (m.get(k) || 0) + e.count); }
    return m;
  };
  const was = totals(before), is = totals(after);
  const then = new Map(before.guards.map(g => [g.kind, g.params]));
  const takenOn = kind => (kind === 'native-dialog' ? now.get(kind).calls.filter(c => !then.get(kind).calls.includes(c))
    : kind === 'dead-href' ? now.get(kind).values.filter(v => !then.get(kind).values.includes(v)) : []);
  for (const k of [...is.keys()].sort()) {
    const grew = is.get(k) - (was.get(k) || 0);
    if (grew <= 0) continue;
    const [kind, anchor] = k.split('\0');
    const mine = hits.filter(h => h.kind === kind && h.anchor === anchor);
    const added = takenOn(kind);
    const count = grew - Math.min(grew, mine.filter(h => added.includes(h.what)).length);
    if (!count) continue;
    const files = [...new Set(after.baseline.filter(e => e.kind === kind && e.anchor === anchor).map(e => e.file))].sort();
    out.push({ kind, why: 'baseline', file: files[0], files, anchor, count, what: mine[0]?.what ?? null, label: labelOf(kind, now.get(kind)) });
  }
  return out;
}

// ---- adding and removing ----------------------------------------------------------------------------------------------

// What `params` add to a guard's current params (null when the guard covers them already).
export function widening(kind, current, params) {
  if (!current) return params;
  if (kind === 'native-dialog') { const add = params.calls.filter(c => !current.calls.includes(c)); return add.length ? { calls: add } : null; }
  if (kind === 'dead-href') { const add = params.values.filter(v => !current.values.includes(v)); return add.length ? { values: add } : null; }
  if (kind === 'colour-literal') return null;                     // a token set is replaced only by removing the guard
  return null;
}
export const union = (kind, a, b) => (kind === 'native-dialog' ? { calls: [...new Set([...a.calls, ...b.calls])].sort() } : kind === 'dead-href' ? { values: [...new Set([...a.values, ...b.values])].sort() } : a);
