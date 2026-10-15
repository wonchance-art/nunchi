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
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { join, relative, resolve, sep, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSource, traverse, unwrap, calleeName, tagOf, attrName, TEST_FILE, CONFIG_FILE, IGNORE_DIRS } from './inventory.mjs';
import { parseColor, oklabOf, deltaE, MERGE_DE, ALPHA_TOLERANCE } from './tokens.mjs';
import { KINDS, MAX_SOURCE_BYTES, MAX_COLORS, CALLS, hrefValue, whatOf, TOKEN_COLOR, paramsProblem, normParams, validateGuards, widening, union, keyOf, baselineOf, defaultParams, safePath } from './guard-kinds.mjs';
export * from './guard-kinds.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = p => p.split(sep).join('/');
const fail = (code, message) => Object.assign(new Error(message), { code });

// ---- reading the source -----------------------------------------------------------------------------------------------

const CODE = /\.(m|c)?(t|j)sx?$/;
const CSS = /\.css$/i;
// Tests, fixtures and stories never count (inventory's TEST_FILE, plus test and fixture folders).
// (a route folder called `test` inside app/ or pages/ is a page: only the project's own top-level test folders are left out)
const NOT_APP = /^(tests?|fixtures?|stories|storybook-static|playwright|e2e)\/|(^|\/)__snapshots__\//;
export const SKIPPED_DIRS = [...IGNORE_DIRS].sort();

// A file's path as guards.json keeps it: relative to the project, with forward slashes on every platform, or null when
// it lies outside the project (`..`, another drive) or its name holds what a baseline path may not (a backslash, which
// POSIX allows in a name; a control or bidi character). `path`: node:path, or path.win32 / path.posix in a test, so
// Windows' `D:\` and `D:/` are checked on Linux too.
export function projectPath(project, file, path = nodePath) {
  const r = path.relative(project, file);
  if (!r || climbs(r, path)) return null;
  const p = r.split(path.sep).join('/');
  return safePath(p) ? p : null;
}
// Is `root` the project folder or inside it?
const climbs = (r, path) => r === '..' || r.startsWith(`..${path.sep}`) || r.startsWith('../') || path.isAbsolute(r);
export const insideProject = (project, root, path = nodePath) => !climbs(path.relative(project, root), path);

// The files a scan reads under `root`, as paths relative to `project` (posix), sorted. Folders nunchi skips, dot
// folders and symbolic links are never entered or read; files over 1 MB are listed in `large`, files whose name a
// baseline cannot keep in `odd` (never read).
export function sourceFiles(project, root, { css = false } = {}) {
  const files = [], large = [], odd = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name) || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      if (!(CODE.test(e.name) || (css && CSS.test(e.name)))) continue;
      const rel = projectPath(project, p);
      if (rel === null) { odd.push(JSON.stringify(posix(relative(project, p))).slice(1, -1).slice(0, 200)); continue; }
      if (TEST_FILE.test(rel) || NOT_APP.test(rel) || CONFIG_FILE.test(rel) || /\.config\.[cm]?[jt]sx?$/.test(rel)) continue;
      let size = 0;
      try { size = lstatSync(p).size; } catch { continue; }
      if (size > MAX_SOURCE_BYTES) { large.push(rel); continue; }
      files.push(rel);
    }
  };
  walk(root);
  return { files, large, odd };
}

// A hit's anchor: what it is, never where it is or how it is formatted. Code is hashed as its syntax tree (node types,
// names, values, operators), so reflowed lines, quote style, parentheses, trailing commas and comments (Prettier's
// churn) keep the anchor; a changed name or text makes a new one. A colour is anchored on where it is set (the
// property, the attribute, the class token) and the colour itself, read as a colour (`#F00` and `#f00` alike).
const anchorOf = (kind, text) => createHash('sha256').update(`${kind}\0${text}`).digest('hex').slice(0, 16);
const NOT_SYNTAX = new Set(['type', 'loc', 'start', 'end', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors', 'tokens']);
function canon(node, out = []) {
  if (node === null || node === undefined) out.push('_');
  else if (Array.isArray(node)) { out.push('['); for (const x of node) canon(x, out); out.push(']'); }
  else if (typeof node !== 'object') out.push(JSON.stringify(node));
  else {
    out.push(`(${node.type ?? ''}`);
    for (const k of Object.keys(node).sort()) {
      if (NOT_SYNTAX.has(k)) continue;
      out.push(k);
      // JSX text is rendered with its whitespace collapsed: a reflowed line is the same text
      if (node.type === 'JSXText' && k === 'value') out.push(JSON.stringify(node.value.replace(/\s+/g, ' ').trim()));
      else canon(node[k], out);
    }
    out.push(')');
  }
  return out;
}
const syntaxOf = node => canon(node).join(' ');
// A colour as a colour (OKLab and alpha, rounded): the spelling of a literal does not move its anchor.
const colourKey = text => { const c = literalColour(text); return c ? `${oklabOf(c).map(v => Math.round(v * 1e4)).join(',')}/${Math.round(c.alpha * 1e3)}` : String(text).toLowerCase(); };

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
// A member's property name (`a.b`, `a['b']`, `a?.b`), or null.
const isMember = e => e?.type === 'MemberExpression' || e?.type === 'OptionalMemberExpression';
const propName = m => (!m.computed && m.property.type === 'Identifier' ? m.property.name : m.computed && m.property.type === 'StringLiteral' ? m.property.value : null);
// The names along a member chain, root first (`e.response?.data` → e, response, data); a call or `this` ends it.
function chainNames(e) {
  const out = [];
  for (let x = unwrap(e); x;) {
    if (x.type === 'Identifier') { out.unshift(x.name); break; }
    if (!isMember(x)) break;
    const p = propName(x);
    if (p !== null) out.unshift(p);
    x = unwrap(x.object);
  }
  return out;
}
// A raw message comes from an error: the chain names `e`, `err`, `error`, `ex`, `exception`, `cause` or a name ending
// in Error (`loadError`). A chain through `errors`, `formState` or `fieldState` is a form library's validation message
// (react-hook-form, Formik), written for people; `toast.message` or `m.message` is not an error's.
const ERRORISH = n => /^(e|err|error|ex|exception|cause)$/i.test(n) || /Error$/.test(n);
const FORM_CHAIN = new Set(['errors', 'formState', 'fieldState']);
function errorMessage(m) {
  if (!isMember(m) || propName(m) !== 'message') return false;
  const names = chainNames(m.object);
  return !names.some(n => FORM_CHAIN.has(n)) && names.some(ERRORISH);
}
// Where an error's message is rendered as it is: `e.message`, `err?.message`, `a && e.message`, `e.message ?? 'x'`,
// `ok ? 'x' : e.message`, and through the plain wrappers that keep it whole: `String(e.message)`,
// `e.message.toString()`, `` `Failed: ${e.message}` ``, `'Error: ' + e.message`. Not a call that makes something else
// of it (`t(e.message)`, `e.message.length`).
function messageEnds(e, out = []) {
  e = unwrap(e);
  if (!e) return out;
  if (errorMessage(e)) out.push(e);
  else if (e.type === 'LogicalExpression') { if (e.operator !== '&&') messageEnds(e.left, out); messageEnds(e.right, out); }
  else if (e.type === 'ConditionalExpression') { messageEnds(e.consequent, out); messageEnds(e.alternate, out); }
  else if (e.type === 'TemplateLiteral') e.expressions.forEach(x => messageEnds(x, out));
  else if (e.type === 'BinaryExpression' && e.operator === '+') { messageEnds(e.left, out); messageEnds(e.right, out); }
  else if ((e.type === 'CallExpression' || e.type === 'OptionalCallExpression') && e.arguments.length <= 1) {
    const c = unwrap(e.callee);
    if (c?.type === 'Identifier' && c.name === 'String' && e.arguments.length === 1) messageEnds(e.arguments[0], out);
    else if (isMember(c) && !e.arguments.length && ['toString', 'trim'].includes(propName(c)) && errorMessage(unwrap(c.object))) out.push(unwrap(c.object));
  }
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
// An element of the page itself (`<svg>`, `<font>`), not a component (`<Badge>`, `<ui.Box>`)
const domTag = el => el?.type === 'JSXOpeningElement' && el.name.type === 'JSXIdentifier' && /^[a-z]/.test(el.name.name);
const GLOBALS = ['window', 'globalThis', 'self'];

// One file's hits for the given guards. `src`: its text; `file`: its path (for the parser's plugins).
export function scanCode(src, file, guards) {
  const want = new Map(guards.map(g => [g.kind, g.params]));
  const ast = parseSource(src, file);
  const names = want.has('native-dialog') ? declaredNames(ast) : new Set();
  const hits = [];
  // `key`: the anchor's text when it is not the node's syntax (a colour's place and value)
  const hit = (kind, node, what, key = null) => hits.push({ kind, line: node.loc.start.line, column: node.loc.start.column + 1, what, anchor: anchorOf(kind, key ?? syntaxOf(node)) });
  const colour = want.get('colour-literal');
  const allowed = colour ? allowedColours(colour) : null;
  const colourHits = (node, text, named, at) => {
    coloursIn(text, { named }).forEach((c, i) => { if (!colourAllowed(c.text, allowed)) hit('colour-literal', node, whatOf(c.text), `${at}\0${colourKey(c.text)}\0${i}`); });
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
            // the value as written (a string, a template's parts, either branch): never a theme lookup's argument
            // (`theme('colors.red')`, `palette['red']`, `getToken('red')`)
            for (const s of literalTexts(p.value)) colourHits(p, s.text, COLORISH.test(key), `style\0${key}`);
          }
        } else if (CLASS_ATTR.has(name)) {
          for (const s of stringsUnder(v)) for (const c of arbitraryColours(s.text)) if (!colourAllowed(c.text, allowed)) hit('colour-literal', s.node, whatOf(c.text), `class\0${c.token}\0${c.nth}`);
        } else if (COLOR_ATTR.has(name) && (name !== 'color' || domTag(parent))) {
          // `color` on a component is its theme's prop (`<Box color="red.500">`, `<Button color="primary">`)
          for (const t of texts) colourHits(t.node, t.text, true, `attr\0${name}`);
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
  const push = (at, text, key) => {
    const line = lineOf(lines, at);
    hits.push({ kind: 'colour-literal', line, column: at - lines[line - 1] + 1, what: whatOf(text), anchor: anchorOf('colour-literal', key) });
  };
  for (const d of cssDeclarations(src)) {
    if (d.prop.startsWith('--')) continue;
    // Tailwind's `@apply bg-[#f00]`: the class list's arbitrary values, as in a className
    if (d.prop === '@apply') { for (const c of arbitraryColours(d.value)) if (!colourAllowed(c.text, allowed)) push(d.valueStart + c.index, c.text, `class\0${c.token}\0${c.nth}`); continue; }
    coloursIn(d.value, { named: COLORISH.test(d.prop) }).forEach((c, i) => {
      if (!colourAllowed(c.text, allowed)) push(d.valueStart + c.index, c.text, `css\0${d.prop}\0${colourKey(c.text)}\0${i}`);
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
  // the blocks open around a place: a CSS module's `:export { brand: #f00 }` (and `:import`) hands values to JS, it
  // sets no style
  const blocks = [];
  const flush = end => {
    if (depth < 1 || blocks.some(b => b.notStyle)) return;
    const seg = s.slice(start, end);
    const apply = /^(\s*)@apply\b/.exec(seg);
    if (apply) { const value = seg.slice(apply[0].length); const lead = value.length - value.trimStart().length; out.push({ prop: '@apply', value: value.trim(), valueStart: start + apply[0].length + lead }); return; }
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
    if (c === '{') { blocks.push({ notStyle: /^:(export|import)\b/.test(s.slice(start, i).trim()) }); depth++; start = i + 1; }
    else if (c === '}') { flush(i); blocks.pop(); depth = Math.max(0, depth - 1); start = i + 1; }
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
      // a named colour is a whole word of the value: `red.500` and `colors.red` are a theme's keys
      if (named && Object.hasOwn(NAMED, word.toLowerCase()) && !(i > 0 && /[^\s,(/]/.test(s[i - 1])) && !(after < s.length && /[^\s,)/!]/.test(s[after]))) out.push({ text: word, index: i });
      i = after;
      continue;
    }
    i++;
  }
  return out;
}
const matchParen = (s, open) => { let d = 0; for (let j = open; j < s.length; j++) { if (s[j] === '"' || s[j] === "'") { j = endOfString(s, j); continue; } if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) return j; } return s.length - 1; };
// Tailwind arbitrary values in a class list: `bg-[#1f2937]`, `text-[rgb(0_0_0)]` (`_` is a space there). Each with
// its class token (lowercased: the anchor, so another class added or moved beside it changes nothing) and its place
// among the token's colours.
// The value can sit anywhere in the brackets (`shadow-[0_0_0_1px_#f00]`), behind a type hint (`bg-[color:#f00]`) or
// in an arbitrary property (`[color:#f00]`); a variant's brackets (`data-[state=open]:`, `[&>*]:`) are not a value.
// A named colour counts where the utility or the property takes a colour (`text-[red]`, `[background:red]`).
const COLOUR_UTILITY = /^!?-?(bg|text|border(-[a-z]+)?|ring(-offset)?|shadow|inset-shadow|drop-shadow|fill|stroke|outline|decoration|accent|caret|from|via|to|divide|placeholder)-$/;
function arbitraryColours(text) {
  const out = [];
  for (const m of String(text).matchAll(/\S+/g)) {
    const token = m[0];
    // the utility: what follows the last variant colon outside brackets
    let depth = 0, from = 0;
    for (let i = 0; i < token.length; i++) { const c = token[i]; if (c === '[' || c === '(') depth++; else if ((c === ']' || c === ')') && depth) depth--; else if (c === ':' && !depth) from = i + 1; }
    const open = token.indexOf('[', from);
    if (open < 0) continue;
    let close = -1;
    depth = 0;
    for (let i = open; i < token.length; i++) { if (token[i] === '[') depth++; else if (token[i] === ']' && --depth === 0) { close = i; break; } }
    if (close < 0) continue;
    const prefix = token.slice(from, open);
    let inner = token.slice(open + 1, close), at = open + 1, named = COLOUR_UTILITY.test(prefix);
    const hint = /^([a-z-]+):/.exec(inner);
    if (hint && (!prefix || /^(color|colour)$/.test(hint[1]))) {
      if (!prefix) named = COLORISH.test(hint[1]);
      inner = inner.slice(hint[0].length); at += hint[0].length;
    } else if (!prefix) continue;                                   // `[&>*]` alone: a variant, not a value
    let nth = 0;
    for (const c of coloursIn(inner.replace(/(?<!\\)_/g, ' '), { named })) out.push({ text: c.text, token: token.toLowerCase(), nth: nth++, index: m.index + at + c.index });
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
  // compared on their real paths (a symlinked temp folder such as macOS's /var → /private/var; Windows' D:/ and D:\)
  const real = p => { try { return realpathSync.native(resolve(p)); } catch { return resolve(p); } };
  project = real(project); root = real(root);
  if (!insideProject(project, root)) throw fail('BAD_ARGS', `--root ${root} is outside the project folder ${project}`);
  const css = guards.some(g => g.kind === 'colour-literal');
  const { files, large, odd } = guards.length ? sourceFiles(project, root, { css }) : { files: [], large: [], odd: [] };
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
  return { hits, files: files.length, large, unparsed, odd };
}

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
    { selector: "JSXExpressionContainer:not(JSXAttribute[name.name=/^(className|class|style|key|ref|id)$/] > *) > MemberExpression[property.name='message']", message: 'Raw error text on screen: say what happened and what to do instead of showing e.message.' },
    { selector: "JSXExpressionContainer:not(JSXAttribute[name.name=/^(className|class|style|key|ref|id)$/] > *) > ChainExpression > MemberExpression[property.name='message']", message: 'Raw error text on screen: say what happened and what to do instead of showing e.message.' },
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
