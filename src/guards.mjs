// Built-in guards (design 0.1-c §5, spec §7.3): source checks that keep a fixed kind of defect from coming back. They
// run in `nunchi check` over the app's source, need no dependency of the user's and no network, and are deterministic:
// files are walked in a sorted order, every list is sorted, nothing reads the clock.
//
// - The source is parsed (@babel/parser, the inventory's pinned parser; a small CSS tokenizer for `.css`), never
//   grepped: comments, strings in code that is not JSX, tests, fixtures, config files and `node_modules` never count.
//   Source text is data: a hit is reported by file:line:column and kind, never with the source line, so a key in the
//   source never reaches the output.
// - The limits are stated: there is no data flow (`const m = e.message; <p>{m}</p>` is missed), a name is judged per
//   file (a local `confirm` anywhere in the file is taken for the local one), files over 1 MB are skipped and counted,
//   a file that does not parse is listed and not checked.
// - `.nunchi/guards.json` (committed, the person's) holds built-in kinds with typed parameters only — never a regex or
//   a selector from the file — and a baseline of the hits that were there when a guard was added, keyed by file and a
//   hash of the hit's own source (not its line), so `check` fails only on new hits. It is validated strictly: anything
//   unexpected is a state error (exit 2), never a silent pass.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSource, traverse, unwrap, calleeName, tagOf, attrName, TEST_FILE, CONFIG_FILE, IGNORE_DIRS } from './inventory.mjs';
import { parseColor, oklabOf, deltaE, MERGE_DE, ALPHA_TOLERANCE } from './tokens.mjs';
import { stableJson, writeAtomic, refuseLink } from './stable.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = p => p.split(sep).join('/');
const fail = (code, message) => Object.assign(new Error(message), { code });

// ---- the kinds ------------------------------------------------------------------------------------------------------

export const KINDS = ['native-dialog', 'dead-href', 'raw-message', 'mustache-text', 'colour-literal'];
export const CALLS = ['alert', 'confirm', 'prompt'];
export const HREFS = ['#', 'javascript:'];
export const MAX_SOURCE_BYTES = 1024 * 1024;              // design §5: source files over 1 MB are skipped (and counted)
export const MAX_GUARDS_BYTES = 4 * 1024 * 1024;
export const MAX_COLORS = 512;
export const OPEN_INSTANCES = 5;                          // design §5: "≥ 5 open instances" shows a passive chip
const CALL_LABEL = { confirm: '`window.confirm`', alert: '`alert`', prompt: '`window.prompt`' };
const HREF_LABEL = { '#': '`href="#"`', 'javascript:': '`javascript:` links' };

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
const hrefValue = v => { const s = v.replace(/[\t\n\r]/g, '').trim(); return s === '#' ? '#' : /^javascript:/i.test(s) ? 'javascript:' : null; };
export function defaultParams(kind) {
  if (kind === 'native-dialog') return { calls: [...CALLS] };
  if (kind === 'dead-href') return { values: [...HREFS] };
  return {};
}

// ---- guards.json ----------------------------------------------------------------------------------------------------

export const guardsPath = nunchiDir => join(nunchiDir, 'guards.json');
const ANCHOR = /^[0-9a-f]{16}$/;
const WHAT = /^[#a-z0-9 ().,%/:{}_+-]{1,60}$/i;
const whatOf = t => { const w = String(t).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60); return WHAT.test(w) ? w : null; };
const SAFE_PATH = p => typeof p === 'string' && p.length > 0 && p.length <= 1024 && !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.includes('\\')
  && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/.test(p) && !p.split('/').some(s => s === '' || s === '.' || s === '..');
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
const subset = (v, allowed) => Array.isArray(v) && v.length > 0 && v.length <= allowed.length && v.every(x => allowed.includes(x)) && new Set(v).size === v.length;

// A colour of the token set: a value parseColor reads, written with nothing but colour-syntax characters.
const TOKEN_COLOR = /^[a-z0-9#(),.%/ +-]{1,80}$/i;
function paramsProblem(kind, p) {
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
    if (!SAFE_PATH(e.file)) bad('a baseline file must be a plain relative path (no "..", no leading "/", forward slashes)');
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
const normParams = (kind, p) => (kind === 'native-dialog' ? { calls: [...p.calls].sort() } : kind === 'dead-href' ? { values: [...p.values].sort() }
  : kind === 'colour-literal' ? { colors: [...p.colors].sort(), deltaE: p.deltaE } : {});
const sortGuards = gs => [...gs].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
const sortBaseline = bs => [...bs].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || cmp(a.file, b.file) || cmp(a.anchor, b.anchor));
export const emptyGuards = () => ({ schema: 1, guards: [], baseline: [] });

// Reads and validates a guards file's text (a file, or a blob read from git for `--base`).
export function parseGuards(text, file = 'guards.json') {
  if (Buffer.byteLength(text) > MAX_GUARDS_BYTES) throw fail('CORRUPT', `${file} is larger than ${MAX_GUARDS_BYTES / 1024 / 1024} MB`);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw fail('CORRUPT', `${file} is not valid JSON (${String(e.message).split('\n')[0]}). Fix it by hand or remove it.`); }
  return validateGuards(doc, file);
}
// → the document, or null when there is no guards file. A link, a folder or an unreadable file is an error.
export function readGuards(path) {
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw fail('CORRUPT', `${path} cannot be read (${e.code})`); }
  if (st.isSymbolicLink()) throw fail('UNSAFE_PATH', `${path} is a symbolic link; nunchi reads its guards from a plain file`);
  if (!st.isFile()) throw fail('CORRUPT', `${path} is not a file`);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw fail('CORRUPT', `${path} cannot be read (${e.code})`); }
  return parseGuards(text, path);
}
// Written stable (sorted keys and lists) and atomically, never through a link. A committed file: its mode stays the
// file's own (not private).
export function writeGuards(path, doc) {
  const clean = validateGuards(doc, path);
  refuseLink(path);
  writeAtomic(path, stableJson(clean), { durable: true });
  return clean;
}

// ---- reading the source -----------------------------------------------------------------------------------------------

const CODE = /\.(m|c)?(t|j)sx?$/;
const CSS = /\.css$/i;
// Tests, fixtures and stories never count (inventory's TEST_FILE, plus test and fixture folders).
// (a route folder called `test` inside app/ or pages/ is a page: only the project's own top-level test folders are left out)
const NOT_APP = /^(tests?|fixtures?|stories|storybook-static|playwright|e2e)\/|(^|\/)__snapshots__\//;
export const SKIPPED_DIRS = [...IGNORE_DIRS].sort();

// The files a scan reads under `root`, as paths relative to `project` (posix), sorted. Folders nunchi skips, dot
// folders and symbolic links are never entered or read; files over 1 MB are listed in `large`.
export function sourceFiles(project, root, { css = false } = {}) {
  const files = [], large = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const rel = posix(relative(project, p));
      if (!(CODE.test(rel) || (css && CSS.test(rel)))) continue;
      if (TEST_FILE.test(rel) || NOT_APP.test(rel) || CONFIG_FILE.test(rel) || /\.config\.[cm]?[jt]sx?$/.test(rel)) continue;
      let size = 0;
      try { size = lstatSync(p).size; } catch { continue; }
      if (size > MAX_SOURCE_BYTES) { large.push(rel); continue; }
      files.push(rel);
    }
  };
  walk(root);
  return { files, large };
}

const anchorOf = (kind, text) => createHash('sha256').update(`${kind}\0${text.replace(/\s+/g, ' ').trim().slice(0, 4000)}`).digest('hex').slice(0, 16);

// Names declared anywhere in the file (a local `confirm`, a parameter called `window`): judged per file, no scopes.
function declaredNames(ast) {
  const names = new Set();
  const pat = p => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach(x => pat(x.type === 'RestElement' ? x.argument : x.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(pat);
    else if (p.type === 'AssignmentPattern') pat(p.left);
    else if (p.type === 'RestElement') pat(p.argument);
    else if (p.type === 'TSParameterProperty') pat(p.parameter);
  };
  traverse(ast.program, n => {
    if (n.type === 'VariableDeclarator') pat(n.id);
    else if (/Function/.test(n.type) || n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod') { if (n.id && n.type !== 'FunctionExpression') pat(n.id); (n.params || []).forEach(pat); }
    else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') pat(n.local);
    else if (n.type === 'ClassDeclaration' && n.id) pat(n.id);
    else if (n.type === 'CatchClause') pat(n.param);
  });
  return names;
}

// The texts a literal expression can render (a string, a template's static parts, either branch of `a ? 'x' : 'y'`).
function literalTexts(e) {
  e = unwrap(e);
  if (!e) return [];
  if (e.type === 'StringLiteral') return [{ node: e, text: e.value }];
  if (e.type === 'TemplateLiteral') return [{ node: e, text: e.quasis.map(q => q.value.cooked ?? q.value.raw).join(' '), dynamic: e.expressions.length > 0 }];
  if (e.type === 'ConditionalExpression') return [...literalTexts(e.consequent), ...literalTexts(e.alternate)];
  if (e.type === 'LogicalExpression') return [...(e.operator === '&&' ? [] : literalTexts(e.left)), ...literalTexts(e.right)];
  return [];
}
// Every string literal and template part under a node (className={cn('a', x && 'bg-[#fff]')}).
function stringsUnder(node) {
  const out = [];
  traverse(node, n => {
    if (n.type === 'StringLiteral') out.push({ node: n, text: n.value });
    else if (n.type === 'TemplateElement') out.push({ node: n, text: n.value.cooked ?? n.value.raw });
  });
  return out;
}
// Where an expression's value is rendered as it is: `e.message`, `err?.message`, `a && e.message`, `e.message ?? 'x'`,
// `ok ? 'x' : e.message`. Not a template, a concatenation or a call.
function messageEnds(e, out = []) {
  e = unwrap(e);
  if (!e) return out;
  if ((e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') && ((!e.computed && e.property.type === 'Identifier' && e.property.name === 'message') || (e.computed && e.property.type === 'StringLiteral' && e.property.value === 'message'))) out.push(e);
  else if (e.type === 'LogicalExpression') { if (e.operator !== '&&') messageEnds(e.left, out); messageEnds(e.right, out); }
  else if (e.type === 'ConditionalExpression') { messageEnds(e.consequent, out); messageEnds(e.alternate, out); }
  return out;
}

// Attributes whose value is not text a person reads: a `.message` there is a class name, a key or an id.
const NOT_TEXT_ATTR = /^(className|class|style|key|ref|id|htmlFor|for|href|src|srcSet|role|tabIndex|type|name|as|variant|size|tw|css|sx|data-.*|on[A-Z].*|aria-(describedby|labelledby|controls|owns|activedescendant|details|errormessage|flowto))$/;
// Attributes that are rendered text, for `{{` (the inventory's user-facing props)
const TEXT_ATTR = new Set(['alt', 'title', 'placeholder', 'label', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext']);
// Elements whose content is code or not shown as text: a literal `{{` in <code> is a sample, `}}` in <style> is CSS
const RAW_TAGS = new Set(['code', 'pre', 'kbd', 'samp', 'style', 'script', 'noscript']);
const NOT_SHOWN_TAGS = new Set(['style', 'script', 'noscript']);
const COLOR_ATTR = new Set(['fill', 'stroke', 'color', 'stopColor', 'stop-color', 'floodColor', 'flood-color', 'lightingColor', 'lighting-color']);
const CLASS_ATTR = new Set(['className', 'class', 'tw']);
const GLOBALS = ['window', 'globalThis', 'self'];

// One file's hits for the given guards. `src`: its text; `file`: its path (for the parser's plugins).
export function scanCode(src, file, guards) {
  const want = new Map(guards.map(g => [g.kind, g.params]));
  const ast = parseSource(src, file);
  const names = want.has('native-dialog') ? declaredNames(ast) : new Set();
  const hits = [];
  const hit = (kind, node, what, extra = '') => hits.push({ kind, line: node.loc.start.line, column: node.loc.start.column + 1, what, anchor: anchorOf(kind, `${src.slice(node.start, node.end)}\0${extra}`) });
  const colour = want.get('colour-literal');
  const allowed = colour ? allowedColours(colour) : null;
  const colourHits = (node, text, named, at = '') => {
    coloursIn(text, { named }).forEach((c, i) => { if (!colourAllowed(c.text, allowed)) hit('colour-literal', node, whatOf(c.text), `${at}\0${c.text.toLowerCase()}\0${i}`); });
  };
  // `{{` in <code> is a sample; a `.message` in <pre> is still raw text on screen (only <style>/<script> are not text)
  const rawAncestor = (anc, tags = RAW_TAGS) => anc.some(a => a.type === 'JSXElement' && tags.has(tagOf(a)));
  traverse(ast.program, (n, anc) => {
    const parent = anc[anc.length - 1];
    // window.confirm / alert / prompt (a call; a local function of that name is not the browser's)
    if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && want.has('native-dialog')) {
      const c = unwrap(n.callee);
      let call = null;
      if (c?.type === 'Identifier' && !names.has(c.name)) call = c.name;
      else if ((c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression')) {
        const obj = unwrap(c.object);
        const prop = !c.computed && c.property.type === 'Identifier' ? c.property.name : c.computed && c.property.type === 'StringLiteral' ? c.property.value
          : c.computed && c.property.type === 'TemplateLiteral' && !c.property.expressions.length ? c.property.quasis[0].value.cooked : null;
        if (obj?.type === 'Identifier' && GLOBALS.includes(obj.name) && !names.has(obj.name)) call = prop;
      }
      if (call && want.get('native-dialog').calls.includes(call)) hit('native-dialog', n, call);
    }
    if (n.type === 'JSXAttribute') {
      const name = attrName(n);
      const v = n.value;
      const texts = !v ? [] : v.type === 'StringLiteral' ? [{ node: v, text: v.value }] : v.type === 'JSXExpressionContainer' ? literalTexts(v.expression) : [];
      if (name === 'href' && want.has('dead-href')) {
        for (const t of texts) { const hv = t.dynamic ? null : hrefValue(t.text); if (hv && want.get('dead-href').values.includes(hv)) hit('dead-href', n, hv); }
      }
      if (want.has('mustache-text') && TEXT_ATTR.has(name)) {
        for (const t of texts) { const m = /\{\{|\}\}/.exec(t.text); if (m) hit('mustache-text', t.node, m[0]); }
      }
      if (colour && v) {
        if (name === 'style' && v.type === 'JSXExpressionContainer' && unwrap(v.expression)?.type === 'ObjectExpression') {
          for (const p of unwrap(v.expression).properties) {
            if (p.type !== 'ObjectProperty') continue;
            const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : '';
            if (/^--/.test(key)) continue;                                 // a custom property defines a token
            for (const s of stringsUnder(p.value)) colourHits(p, s.text, COLORISH.test(key), key);
          }
        } else if (CLASS_ATTR.has(name)) {
          for (const s of stringsUnder(v)) for (const c of arbitraryColours(s.text)) if (!colourAllowed(c.text, allowed)) hit('colour-literal', s.node, whatOf(c.text), `class\0${c.raw}\0${c.index}`);
        } else if (COLOR_ATTR.has(name)) {
          for (const t of texts) colourHits(t.node, t.text, true, name);
        }
      }
    }
    if (n.type === 'JSXExpressionContainer' && want.has('raw-message')) {
      const inChildren = parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment');
      const inAttr = parent && parent.type === 'JSXAttribute' && !NOT_TEXT_ATTR.test(attrName(parent));
      if ((inChildren && !rawAncestor(anc, NOT_SHOWN_TAGS)) || inAttr) for (const m of messageEnds(n.expression)) hit('raw-message', m, 'message');
    }
    if (want.has('mustache-text') && parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment') && !rawAncestor(anc)) {
      if (n.type === 'JSXText') { const m = /\{\{|\}\}/.exec(n.value); if (m) hit('mustache-text', n, m[0]); }
      else if (n.type === 'JSXExpressionContainer') for (const t of literalTexts(n.expression)) { const m = /\{\{|\}\}/.exec(t.text); if (m) hit('mustache-text', t.node, m[0]); }
    }
  });
  return hits;
}

// One stylesheet's colour literals: declarations only (comments and strings skipped), custom properties (`--x: …`,
// token definitions) left out.
export function scanCss(src, guards) {
  const colour = guards.find(g => g.kind === 'colour-literal');
  if (!colour) return [];
  const allowed = allowedColours(colour.params);
  const lines = lineStarts(src);
  const hits = [];
  for (const d of cssDeclarations(src)) {
    if (d.prop.startsWith('--')) continue;
    coloursIn(d.value, { named: COLORISH.test(d.prop) }).forEach((c, i) => {
      if (colourAllowed(c.text, allowed)) return;
      const at = d.valueStart + c.index;
      const line = lineOf(lines, at);
      hits.push({ kind: 'colour-literal', line, column: at - lines[line - 1] + 1, what: whatOf(c.text), anchor: anchorOf('colour-literal', `${d.prop}:${d.value}\0${c.text.toLowerCase()}\0${i}`) });
    });
  }
  return hits;
}
const lineStarts = s => { const out = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i + 1); return out; };
const lineOf = (starts, at) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; } return lo + 1; };

// Declarations of a stylesheet: { prop, value, valueStart }. Comments become spaces (offsets kept); strings and
// parentheses (a `;` inside `url(data:…)`) are respected; a selector or at-rule prelude before `{` is not one.
export function cssDeclarations(src) {
  const s = src.replace(/\/\*[\s\S]*?(\*\/|$)/g, m => m.replace(/[^\n]/g, ' '));
  const out = [];
  let depth = 0, paren = 0, start = 0;
  const flush = end => {
    if (depth < 1) return;
    const seg = s.slice(start, end);
    const colon = seg.indexOf(':');
    if (colon < 0) return;
    const prop = seg.slice(0, colon).trim();
    if (!/^-{0,2}[A-Za-z][-\w]*$/.test(prop)) return;
    const rawValue = seg.slice(colon + 1);
    const lead = rawValue.length - rawValue.trimStart().length;
    out.push({ prop: prop.toLowerCase(), value: rawValue.trim(), valueStart: start + colon + 1 + lead });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") { i = endOfString(s, i); continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { paren = Math.max(0, paren - 1); continue; }
    if (paren) continue;
    if (c === '{') { depth++; start = i + 1; }
    else if (c === '}') { flush(i); depth = Math.max(0, depth - 1); start = i + 1; }
    else if (c === ';') { flush(i); start = i + 1; }
  }
  return out;
}
const endOfString = (s, i) => { const q = s[i]; for (let j = i + 1; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === q || s[j] === '\n') return j; } return s.length; };

// ---- colour literals ------------------------------------------------------------------------------------------------

// The CSS named colours (CSS Color 4; `transparent` and `currentcolor` are not literals of a colour).
const NAMED = Object.fromEntries('aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'.split(',').map(x => x.split(':')));
// Properties that take a colour: a bare word there (`color: red`) is a named colour; elsewhere (`font-family: Tan`) not.
const COLORISH = /colou?r|background|border|outline|fill|stroke|shadow|caret|accent|decoration|column-?rule|stop|flood|lighting/i;
const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);
// Functions whose arguments are never colour literals of the page (a variable's fallback is a token's business)
const SKIP_FUNCS = new Set(['url', 'var', 'env', 'attr', 'local', 'format', 'src', 'image', 'image-set', 'counter', 'counters']);

// The colour literals in a CSS value: hex, colour functions with literal arguments, and named colours where a colour
// is expected. → [{ text, index }]
export function coloursIn(value, { named = false } = {}) {
  const s = String(value), out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '"' || c === "'") { i = endOfString(s, i) + 1; continue; }
    if (c === '#') {
      const m = /^#([0-9a-fA-F]+)(?![\w-])/.exec(s.slice(i));
      if (m && [3, 4, 6, 8].includes(m[1].length)) out.push({ text: m[0], index: i });
      i += m ? m[0].length : 1;
      continue;
    }
    if (/[A-Za-z_-]/.test(c) && (i === 0 || !/[\w-]/.test(s[i - 1]))) {
      const m = /^-?[A-Za-z_][\w-]*/.exec(s.slice(i));
      if (!m) { i++; continue; }
      const word = m[0], after = i + word.length;
      if (s[after] === '(') {
        const close = matchParen(s, after);
        const fn = word.toLowerCase();
        if (COLOR_FUNCS.has(fn)) { const text = s.slice(i, close + 1); if (!/[a-z]\(/i.test(text.slice(word.length + 1)) && literalColour(text)) out.push({ text, index: i }); i = close + 1; }
        else if (SKIP_FUNCS.has(fn)) i = close + 1;
        else i = after + 1;                                       // a gradient, color-mix(): its colours are literals too
        continue;
      }
      if (named && Object.hasOwn(NAMED, word.toLowerCase())) out.push({ text: word, index: i });
      i = after;
      continue;
    }
    i++;
  }
  return out;
}
const matchParen = (s, open) => { let d = 0; for (let j = open; j < s.length; j++) { if (s[j] === '"' || s[j] === "'") { j = endOfString(s, j); continue; } if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) return j; } return s.length - 1; };
// Tailwind arbitrary values in a class list: `bg-[#1f2937]`, `text-[rgb(0_0_0)]` (`_` is a space there).
function arbitraryColours(text) {
  const out = [];
  for (const m of String(text).matchAll(/\[(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^\]\s]*\))\]/g)) {
    const t = m[1].replace(/_/g, ' ');
    if (literalColour(t)) out.push({ text: t, raw: m[1], index: m.index });
  }
  return out;
}

const hueOf = h => { const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)(deg|grad|rad|turn)?$/i.exec(h); if (!m) return null; const v = parseFloat(m[1]); const u = (m[2] || 'deg').toLowerCase(); return u === 'deg' ? v : u === 'grad' ? v * 0.9 : u === 'rad' ? (v * 180) / Math.PI : v * 360; };
const unit = x => { if (x === 'none') return 0; const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)(%)?$/.exec(x); if (!m) return null; return m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]) / 100; };
const alphaOf = x => { if (x === undefined) return 1; const m = /^([-+]?[\d.]+)(%)?$/.exec(x); return m ? (m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1])) : null; };
function hslRgb(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
}
// A colour literal → parseColor's { lin, alpha }, or null when it is not one nunchi reads (named colours, hsl() and
// hwb() are converted to rgb() first).
export function literalColour(text) {
  const t = String(text).trim().toLowerCase();
  if (Object.hasOwn(NAMED, t)) return parseColor('#' + NAMED[t]);
  const m = /^(hsla?|hwb)\(([^()]*)\)$/.exec(t);
  if (!m) return parseColor(t);
  let body = m[2].trim(), alpha;
  if (body.includes('/')) { const p = body.split('/'); if (p.length !== 2) return null; body = p[0].trim(); alpha = p[1].trim(); }
  let parts = body.includes(',') ? body.split(',').map(x => x.trim()) : body.split(/\s+/);
  if (parts.length === 4 && alpha === undefined) { alpha = parts[3]; parts = parts.slice(0, 3); }
  if (parts.length !== 3) return null;
  const h = hueOf(parts[0]), x = unit(parts[1]), y = unit(parts[2]), a = alphaOf(alpha);
  if ([h, x, y, a].some(v => v === null || !Number.isFinite(v))) return null;
  let rgb;
  if (m[1] === 'hwb') { const sum = x + y; rgb = sum >= 1 ? [x / sum, x / sum, x / sum] : hslRgb(((h % 360) + 360) % 360, 1, 0.5).map(v => v * (1 - x - y) + x); }
  else rgb = hslRgb(((h % 360) + 360) % 360, Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y)));
  return parseColor(`rgb(${rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(' ')} / ${Math.max(0, Math.min(1, a))})`);
}
const allowedColours = params => params.colors.map(c => parseColor(c)).filter(Boolean).map(c => ({ lab: oklabOf(c), alpha: c.alpha, de: params.deltaE }));
function colourAllowed(text, allowed) {
  const c = literalColour(text);
  if (!c) return true;                                           // not a literal nunchi reads: not judged
  const lab = oklabOf(c);
  return allowed.some(t => deltaE(lab, t.lab) <= t.de + 1e-9 && Math.abs(c.alpha - t.alpha) <= ALPHA_TOLERANCE);
}
// The token set of a `nunchi tokens` report (tokens.json): each cluster's proposed value.
export function tokenColours(report) {
  const list = Array.isArray(report?.colors) ? report.colors.map(c => c?.value).filter(v => typeof v === 'string' && TOKEN_COLOR.test(v) && parseColor(v)) : [];
  return { colors: [...new Set(list)].sort().slice(0, MAX_COLORS), deltaE: MERGE_DE };
}

// ---- scanning a project ---------------------------------------------------------------------------------------------

// Every hit of the given guards under `root` (inside `project`), paths relative to `project`.
// → { hits (sorted), files (scanned), large (skipped, over 1 MB), unparsed: [{ file, line, message }] }
export function scanGuards({ project, root = project, guards }) {
  project = resolve(project); root = resolve(root);
  const r = relative(project, root);
  if (r.startsWith('..') || isAbsolute(r)) throw fail('BAD_ARGS', `--root ${root} is outside the project folder ${project}`);
  const css = guards.some(g => g.kind === 'colour-literal');
  const { files, large } = guards.length ? sourceFiles(project, root, { css }) : { files: [], large: [] };
  const hits = [], unparsed = [];
  for (const file of files) {
    let src;
    try { src = readFileSync(join(project, file), 'utf8'); } catch (e) { unparsed.push({ file, line: null, message: `unreadable (${e.code || 'read error'})` }); continue; }
    try {
      const found = extname(file).toLowerCase() === '.css' ? scanCss(src, guards) : scanCode(src, file, guards);
      for (const h of found) hits.push({ ...h, file });
    } catch (e) {
      if (e instanceof RangeError) unparsed.push({ file, line: null, message: 'nesting too deep to walk' });
      else unparsed.push({ file, line: e.loc?.line ?? null, message: String(e.reasonCode || e.code || 'parse error') });
    }
  }
  hits.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || a.column - b.column || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || cmp(a.anchor, b.anchor));
  return { hits, files: files.length, large, unparsed };
}

const keyOf = e => `${e.kind}\0${e.file}\0${e.anchor}`;
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
export function weakenedSince(before, after) {
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
  const was = new Map(before.baseline.map(e => [keyOf(e), e.count]));
  const kept = new Set(before.guards.map(g => g.kind));
  for (const e of after?.baseline || []) {
    if (!kept.has(e.kind)) continue;                               // a guard added since: its baseline is new by nature
    const n = was.get(keyOf(e)) || 0;
    if (e.count > n) out.push({ kind: e.kind, why: 'baseline', file: e.file, anchor: e.anchor, count: e.count - n, what: e.what ?? null, label: labelOf(e.kind, now.get(e.kind)) });
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
const union = (kind, a, b) => (kind === 'native-dialog' ? { calls: [...new Set([...a.calls, ...b.calls])].sort() } : kind === 'dead-href' ? { values: [...new Set([...a.values, ...b.values])].sort() } : a);

// Adds a guard (or widens one): only the hits of what it adds join the baseline, so a hit the guard already catches
// is never baselined by an add. → { doc, added (the params added, or null), baselined (entries added) }
export function addGuard(doc, { project, root = project, kind, params }) {
  if (!KINDS.includes(kind)) throw fail('BAD_ARGS', `${kind} is not a built-in guard (${KINDS.join(', ')})`);
  const why = paramsProblem(kind, params);
  if (why) throw fail('BAD_ARGS', why);
  params = normParams(kind, params);
  const cur = doc.guards.find(g => g.kind === kind);
  const add = widening(kind, cur?.params, params);
  if (!add) return { doc, added: null, baselined: [] };
  const { hits } = scanGuards({ project, root, guards: [{ kind, params: add }] });
  const entries = baselineOf(hits);
  const guards = cur ? doc.guards.map(g => (g.kind === kind ? { kind, params: union(kind, g.params, add) } : g)) : [...doc.guards, { kind, params }];
  const base = new Map(doc.baseline.map(e => [keyOf(e), e]));
  for (const e of entries) base.set(keyOf(e), base.has(keyOf(e)) ? { ...base.get(keyOf(e)), count: base.get(keyOf(e)).count + e.count } : e);
  return { doc: validateGuards({ schema: 1, guards, baseline: [...base.values()] }), added: add, baselined: entries };
}
// Removes a guard, or (with `params`) only those calls or link kinds, and the baseline entries that went with them:
// `entries` (what an add recorded), else every entry of the kind when the whole guard goes.
export function removeGuard(doc, { kind, params = null, entries = null }) {
  const cur = doc.guards.find(g => g.kind === kind);
  if (!cur) return { doc, removed: false };
  let guards;
  if (params && kind === 'native-dialog' && cur.params.calls.some(c => !params.calls.includes(c))) guards = doc.guards.map(g => (g.kind === kind ? { kind, params: { calls: g.params.calls.filter(c => !params.calls.includes(c)) } } : g));
  else if (params && kind === 'dead-href' && cur.params.values.some(v => !params.values.includes(v))) guards = doc.guards.map(g => (g.kind === kind ? { kind, params: { values: g.params.values.filter(v => !params.values.includes(v)) } } : g));
  else guards = doc.guards.filter(g => g.kind !== kind);
  const whole = !guards.some(g => g.kind === kind);
  const drop = new Map((entries || []).map(e => [keyOf(e), e.count]));
  const baseline = doc.baseline.flatMap(e => {
    if (e.kind !== kind) return [e];
    if (whole) return [];
    const n = drop.get(keyOf(e)) || 0;
    return e.count - n > 0 ? [{ ...e, count: e.count - n }] : [];
  });
  return { doc: validateGuards({ schema: 1, guards, baseline }), removed: true };
}
// The baseline set again from what is there now (a person's choice: it accepts every new hit, and drops gone ones).
export function rebaseline(doc, { project, root = project }) {
  const { hits } = scanGuards({ project, root, guards: doc.guards });
  return validateGuards({ schema: 1, guards: doc.guards, baseline: baselineOf(hits) });
}

// ---- the lint proposal (design §5) --------------------------------------------------------------------------------------

const has = (pkg, name) => !!(pkg && ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(k => pkg[k] && typeof pkg[k] === 'object' && Object.hasOwn(pkg[k], name)));
// ESLint selectors (esquery) for the guards ESLint's core rules can express; the colour guard has none.
const SELECTORS = {
  'dead-href': p => [
    ...(p.values.includes('#') ? [{ selector: "JSXAttribute[name.name='href'][value.value='#']", message: 'A link to "#" goes nowhere: link to a real page, or use a <button>.' },
      { selector: "JSXAttribute[name.name='href'] > JSXExpressionContainer > Literal[value='#']", message: 'A link to "#" goes nowhere: link to a real page, or use a <button>.' }] : []),
    ...(p.values.includes('javascript:') ? [{ selector: "JSXAttribute[name.name='href'][value.value=/^\\s*javascript:/i]", message: 'A javascript: link: use a <button> with an onClick.' }] : []),
  ],
  'raw-message': () => [
    { selector: "JSXExpressionContainer > MemberExpression[property.name='message']", message: 'Raw error text on screen: say what happened and what to do instead of showing e.message.' },
    { selector: "JSXExpressionContainer > ChainExpression > MemberExpression[property.name='message']", message: 'Raw error text on screen: say what happened and what to do instead of showing e.message.' },
  ],
  'mustache-text': () => [
    { selector: 'JSXText[value=/\\{\\{|\\}\\}/]', message: '{{ }} in JSX text is shown as it is: interpolate the value.' },
    { selector: 'JSXElement > JSXExpressionContainer > Literal[value=/\\{\\{|\\}\\}/]', message: '{{ }} in JSX text is shown as it is: interpolate the value.' },
  ],
};
// → { text, notes }: one flat-config object, core rules only, to paste into the array eslint.config.* exports. nunchi
// never writes the user's config. `pkg`: the app's package.json (for what is installed already).
export function lintProposal({ guards, pkg = null, installed = () => false }) {
  const kinds = guards.length ? guards : KINDS.filter(k => k !== 'colour-literal').map(k => ({ kind: k, params: defaultParams(k) }));
  const dialog = kinds.find(g => g.kind === 'native-dialog');
  const selectors = kinds.flatMap(g => (SELECTORS[g.kind] ? SELECTORS[g.kind](g.params) : []));
  const lines = [
    '// nunchi guards as ESLint core rules: a separate config object, scoped to your source files.',
    '// Paste it into the array your eslint.config.* exports (nunchi never writes your config).',
    '// Warning: ESLint does not merge rule options. A later config object that sets no-restricted-syntax for the same',
    '// files replaces this list instead of adding to it: keep every no-restricted-syntax selector in one object.',
    '{',
    "  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],",
    "  ignores: ['**/*.{test,spec}.*', '**/__tests__/**', '**/*.stories.*'],",
    '  rules: {',
    ...(dialog ? [`    'no-alert': 'error',${dialog.params.calls.length < CALLS.length ? ` // no-alert covers alert, confirm and prompt alike (your guard: ${dialog.params.calls.join(', ')})` : ''}`] : []),
    ...(selectors.length ? ["    'no-restricted-syntax': ['error',", ...selectors.map(s => `      { selector: ${JSON.stringify(s.selector)}, message: ${JSON.stringify(s.message)} },`), '    ],'] : []),
    '  },',
    '},',
  ];
  const notes = [];
  if (kinds.some(g => g.kind === 'colour-literal')) notes.push('colour literals: no ESLint core rule can express them; nunchi check keeps that guard.');
  // proposed only when already installed (design §5)
  if (has(pkg, 'eslint-plugin-jsx-a11y') || has(pkg, 'eslint-config-next') || installed('eslint-plugin-jsx-a11y')) {
    notes.push("eslint-plugin-jsx-a11y is installed: 'jsx-a11y/anchor-is-valid': 'error' also catches href=\"#\" and javascript: links (eslint-config-next does not turn it on).");
  }
  if ((has(pkg, 'stylelint') || installed('stylelint')) && (has(pkg, 'stylelint-declaration-strict-value') || installed('stylelint-declaration-strict-value'))) {
    notes.push("stylelint-declaration-strict-value is installed: 'scale-unlimited/declaration-strict-value': [['/color$/', 'fill', 'stroke']] keeps colours on your variables.");
  }
  if (has(pkg, '@playwright/test') || installed('@playwright/test')) notes.push('@playwright/test is installed: expect(page.locator(…)).toMatchAriaSnapshot() pins a screen\'s structure.');
  return { text: lines.join('\n') + '\n', notes };
}
