// Source inventory (spec §2.4, 0.1-b): the user-facing strings, UI states and destructive actions the app's
// source names, per file with file:line, plus a classification pass that needs no AI. It feeds the copy and
// safety lenses (L2 states, L5 copy consistency, L6 copy quality, L7 leftovers, L9 safety).
//
// - The source is parsed with @babel/parser (pinned; see spec §2.4) and only read: nothing here evaluates it.
//   Source text is data. A file that does not parse is listed under `skipped` with the reason; it never aborts.
// - Strings are collected from places a user sees (JSX text, user-facing props, toast/dialog calls, error
//   setters, labelled object fields, Next.js metadata); thrown messages are kept apart (`thrown`) because
//   whether they reach the screen is not knowable statically. className/style/import paths are never read.
// - `candidates` are hints for the AI lenses, not findings: they have no severity and are never written to
//   the ledger by this module.
// - Deterministic: files and entries sorted, no clock, no randomness; paths posix, relative to the app root.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, extname, basename, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { buildSourceMap } from './sourcemap.mjs';
import { secretFindings } from './rules.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const PARSER = `@babel/parser@${pkg.dependencies['@babel/parser']}`;

const posix = p => p.split(sep).join('/');
const CODE = /\.(m|c)?(t|j)sx?$/;
const TEST_FILE = /(^|\/)(__tests__|__mocks__|__fixtures__|e2e|cypress)\/|\.(test|spec|stories|story|cy)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const CONFIG_FILE = /(^|\/)[^/]+\.config\.[cm]?[jt]s$/;
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', '.vercel', 'coverage', '.nunchi', 'public']);
const MAX_BYTES = 512 * 1024;                     // larger files are generated data, not hand-written screens
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------- parsing

function parserPlugins(file) {
  const ext = extname(file);
  if (/^\.[cm]?ts$/.test(ext)) return ['typescript', 'decorators-legacy'];
  if (/^\.[cm]?tsx$/.test(ext)) return ['typescript', 'jsx', 'decorators-legacy'];
  return ['jsx', 'decorators-legacy'];
}

export function parseSource(src, file) {
  return parse(src, {
    sourceType: 'module', plugins: parserPlugins(file),
    allowImportExportEverywhere: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true, allowUndeclaredExports: true, errorRecovery: false,
  });
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range', 'comments', 'tokens', 'errors']);
function traverse(node, enter, ancestors = []) {
  enter(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') traverse(c, enter, ancestors); }
    else if (v && typeof v.type === 'string') traverse(v, enter, ancestors);
  }
  ancestors.pop();
}

const unwrap = n => {
  while (n && /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TypeCastExpression|ParenthesizedExpression)$/.test(n.type)) n = n.expression;
  return n;
};
const isFunction = n => /Function|ArrowFunctionExpression|ObjectMethod|ClassMethod|ClassPrivateMethod/.test(n.type);
const isJsx = n => n && (n.type === 'JSXElement' || n.type === 'JSXFragment');

function calleeName(c) {
  c = unwrap(c);
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'ThisExpression') return 'this';
  if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') {
    const prop = !c.computed ? c.property.name : c.property.type === 'StringLiteral' ? c.property.value : null;
    if (!prop) return null;
    const obj = calleeName(c.object);
    return obj ? `${obj}.${prop}` : prop;
  }
  return null;
}

function tagOf(el) {
  if (el.type === 'JSXFragment') return '';
  const n = el.openingElement.name;
  if (n.type === 'JSXIdentifier') return n.name;
  if (n.type === 'JSXNamespacedName') return `${n.namespace.name}:${n.name.name}`;
  const member = m => (m.type === 'JSXIdentifier' ? m.name : `${member(m.object)}.${m.property.name}`);
  return member(n);
}
const attrsOf = el => (el.type === 'JSXElement' ? el.openingElement.attributes.filter(a => a.type === 'JSXAttribute') : []);
const attrName = a => (a.name.type === 'JSXNamespacedName' ? `${a.name.namespace.name}:${a.name.name.name}` : a.name.name);
const getAttr = (el, name) => attrsOf(el).find(a => attrName(a) === name) || null;

// ---------------------------------------------------------------------------------------------- strings

const hasLetter = text => /\p{L}/u.test(text.replace(/\$?\{…\}/g, ''));
const collapse = s => s.replace(/\s+/g, ' ').trim();

function templateText(t) {
  let out = '';
  t.quasis.forEach((q, i) => { out += q.value.cooked ?? q.value.raw; if (i < t.expressions.length) out += '${…}'; });
  return out;
}

// A `+` chain with at least one string literal: 'Hello ' + name → "Hello ${…}".
function concatText(n) {
  const parts = [];
  const flat = x => {
    x = unwrap(x);
    if (x.type === 'BinaryExpression' && x.operator === '+') { flat(x.left); flat(x.right); }
    else parts.push(x);
  };
  flat(n);
  if (!parts.some(p => p.type === 'StringLiteral' || p.type === 'TemplateLiteral')) return null;
  return parts.map(p => (p.type === 'StringLiteral' ? p.value : p.type === 'TemplateLiteral' ? templateText(p) : '${…}')).join('');
}

const I18N_CALL = /^(t|\$t|i18n\.t|i18next\.t|translate|gettext|__|_)$/;

// The texts an expression can evaluate to, as far as literals show: 'a', `b ${x}`, c ? 'd' : 'e', f && 'g'.
function leaves(expr, out = []) {
  const n = unwrap(expr);
  if (!n) return out;
  if (n.type === 'StringLiteral') out.push({ node: n, text: n.value });
  else if (n.type === 'TemplateLiteral') out.push({ node: n, text: templateText(n) });
  else if (n.type === 'BinaryExpression' && n.operator === '+') { const t = concatText(n); if (t !== null) out.push({ node: n, text: t }); }
  else if (n.type === 'ConditionalExpression') { leaves(n.consequent, out); leaves(n.alternate, out); }
  else if (n.type === 'LogicalExpression') { if (n.operator !== '&&') leaves(n.left, out); leaves(n.right, out); }
  else if ((n.type === 'CallExpression' || n.type === 'OptionalCallExpression') && I18N_CALL.test(calleeName(n.callee) || '')) {
    // t('Delete') with the source text as its key is copy; t('tasks.delete') is a key, not copy
    const a = unwrap(n.arguments[0]);
    const text = a?.type === 'StringLiteral' ? a.value : a?.type === 'TemplateLiteral' ? templateText(a) : null;
    if (text !== null && !/^[^\s]*([._:]|[a-z][A-Z])[^\s]*$/.test(text)) out.push({ node: a, text });
  }
  return out;
}

// Babel's own rule for JSX text whitespace (cleanJSXElementLiteralChild).
function cleanJsxText(str) {
  const lines = str.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((l, i) => { if (/[^ \t]/.test(l)) last = i; });
  let out = '';
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, ' ');
    if (i !== 0) t = t.replace(/^ +/, '');
    if (i !== lines.length - 1) t = t.replace(/ +$/, '');
    if (t) { if (i !== last) t += ' '; out += t; }
  });
  return out;
}

// Line/column of the first visible character of a JSXText node.
function textStart(node) {
  const lead = node.value.match(/^\s*/)[0];
  const nl = lead.split('\n');
  return nl.length === 1
    ? { line: node.loc.start.line, column: node.loc.start.column + lead.length + 1 }
    : { line: node.loc.start.line + nl.length - 1, column: nl[nl.length - 1].length + 1 };
}

const INLINE = /^(a|b|strong|em|i|u|s|span|code|small|mark|abbr|kbd|sub|sup|q|cite|Link|NavLink)$/;
const LINK_TAG = /^(a|Link|NavLink|RouterLink|NextLink)$/;
const BUTTON_TAG = /(^button$|Button$|^(MenuItem|DropdownMenuItem|ContextMenuItem|MenubarItem|CommandItem|Tab|IconButton)$)/;
const USER_PROPS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'aria-description', 'aria-placeholder',
  'aria-roledescription', 'aria-valuetext', 'description', 'helperText', 'hint', 'tooltip', 'message', 'emptyText',
  'emptyMessage', 'confirmText', 'confirmLabel', 'cancelText', 'cancelLabel', 'okText', 'heading', 'subtitle', 'caption',
  'errorMessage', 'loadingText', 'successMessage', 'buttonText', 'ctaText']);
const FIELD_KEYS = new Set(['label', 'title', 'description', 'placeholder', 'message', 'heading', 'subtitle', 'caption',
  'tooltip', 'helperText', 'errorMessage', 'emptyMessage', 'emptyText', 'confirmText', 'confirmLabel', 'cancelText',
  'cancelLabel', 'buttonText', 'cta', 'ctaText', 'required']);
const TOAST_KEYS = new Set(['title', 'description', 'message', 'content', 'text', 'loading', 'success', 'error', 'label']);
const NO_TEXT_TAGS = new Set(['style', 'script', 'noscript']);

function interactiveRole(el) {
  if (el.type !== 'JSXElement') return null;
  const tag = tagOf(el);
  const has = n => !!getAttr(el, n);
  if (LINK_TAG.test(tag)) return 'link';
  if (BUTTON_TAG.test(tag)) return 'button';
  if (tag === 'input') {
    const t = getAttr(el, 'type')?.value;
    if (t?.type === 'StringLiteral' && /^(submit|button|reset)$/.test(t.value)) return 'button';
    return null;
  }
  if (has('href') || has('to')) return 'link';
  if (has('onClick') || has('role') && /^(button|menuitem|tab)$/.test(getAttr(el, 'role').value?.value || '')) return 'button';
  return null;
}
function plainRole(tag) {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'label' || tag === 'legend') return 'label';
  if (tag === 'option') return 'option';
  if (tag === 'title') return 'title';
  return 'text';
}
// The role of the element a string belongs to: the nearest button or link around it (inside the same
// function), otherwise what its own tag says.
function ownerOf(el, ancestors) {
  const chain = [el];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (isFunction(a) || a.type === 'Program') break;
    if (a.type === 'JSXElement') chain.push(a);
  }
  for (const c of chain) { const r = interactiveRole(c); if (r) return { role: r, element: tagOf(c) }; }
  const tag = tagOf(el);
  return { role: plainRole(tag), element: tag || 'fragment' };
}

// All text inside an element, deep: the accessible-name-like label of a button or link.
function flatText(el) {
  let out = '';
  for (const c of el.children || []) {
    if (c.type === 'JSXText') out += cleanJsxText(c.value);
    else if (c.type === 'JSXExpressionContainer') {
      const e = unwrap(c.expression);
      const ls = e ? leaves(e) : [];
      if (ls.length) out += ls.map(l => l.text).join(' / ');
    } else if (isJsx(c)) out += ' ' + flatText(c) + ' ';
  }
  return collapse(out);
}

// The accessible-name-like label of a button or link: aria-label, else its text, else its title.
function labelOf(el) {
  const attr = k => { const v = getAttr(el, k)?.value; return v?.type === 'StringLiteral' ? collapse(v.value) : null; };
  return [attr('aria-label'), flatText(el), attr('title')].find(t => t && hasLetter(t)) || null;
}

function onlyText(el) {
  return el.type === 'JSXElement' && (el.children || []).every(c => c.type === 'JSXText' || (c.type === 'JSXExpressionContainer' && ['StringLiteral', 'TemplateLiteral'].includes(unwrap(c.expression)?.type)));
}

// ---------------------------------------------------------------------------------------------- states

const LOADING_NAME = /^(loading|isLoading|pending|isPending|fetching|isFetching|isValidating|isRefetching|initializing|isInitializing|busy|isBusy|submitting|isSubmitting|saving|isSaving)$|Loading$/;
const ERROR_NAME = /^(error|err|errors|isError|hasError|failed|failure|isFailed|hasFailed)$|Error$|Failed$/;
const EMPTY_NAME = /^(isEmpty|empty|noResults|hasNoResults|noItems)$|Empty$/;
const STATE_STRINGS = { loading: 'loading', pending: 'loading', fetching: 'loading', error: 'error', failed: 'error', failure: 'error', empty: 'empty' };

// What a render condition says about the screen's state, from the names and comparisons in it.
function stateOfTest(test) {
  const hits = { empty: false, error: false, loading: false };
  const visit = (n, neg) => {
    n = unwrap(n);
    if (!n) return;
    switch (n.type) {
      case 'UnaryExpression':
        if (n.operator === '!') {
          const a = unwrap(n.argument);
          // !items.length → the list is empty
          if (!neg && a?.type?.endsWith('MemberExpression') && /^(length|size)$/.test(a.property?.name)) { hits.empty = true; return; }
          visit(n.argument, !neg);
        }
        return;
      case 'LogicalExpression': visit(n.left, neg); visit(n.right, neg); return;
      case 'BinaryExpression': {
        const negOp = n.operator === '!==' || n.operator === '!=';
        const sides = [unwrap(n.left), unwrap(n.right)];
        const zero = sides.some(s => s?.type === 'NumericLiteral' && (s.value === 0 || (s.value === 1 && n.operator === '<')));
        const count = sides.some(s => (s?.type?.endsWith('MemberExpression') && /^(length|size|count|total)$/.test(s.property?.name)) || (s?.type === 'Identifier' && /^(count|total|length|size)$|Count$/.test(s.name)));
        if (zero && count && /^(===|==|<|<=)$/.test(n.operator) && !neg) hits.empty = true;
        for (const s of sides) {
          if (s?.type === 'StringLiteral' && STATE_STRINGS[s.value] && negOp === neg) hits[STATE_STRINGS[s.value]] = true;
        }
        if (!negOp) for (const s of sides) visit(s, neg);
        return;
      }
      case 'Identifier':
        if (neg) return;
        if (EMPTY_NAME.test(n.name)) hits.empty = true;
        else if (ERROR_NAME.test(n.name)) hits.error = true;
        else if (LOADING_NAME.test(n.name)) hits.loading = true;
        return;
      case 'MemberExpression': case 'OptionalMemberExpression':
        if (!n.computed && n.property.type === 'Identifier') visit(n.property, neg);
        return;
      case 'CallExpression': case 'OptionalCallExpression':
        if (!neg && /^(isEmpty|isError|isLoading)$/.test(calleeName(n.callee)?.split('.').pop() || '')) visit({ type: 'Identifier', name: calleeName(n.callee).split('.').pop() }, false);
        return;
      default:
    }
  };
  visit(test, false);
  return hits.empty ? 'empty' : hits.error ? 'error' : hits.loading ? 'loading' : null;
}

const CONTENT_STATE = [
  { state: 'error', text: /\b(error|went wrong|failed|couldn'?t|could not|unable to|try again)\b/i, element: /Error|Alert/ },
  { state: 'empty', text: /\bno \w+( \w+)? (yet|found)\b|\bnothing (here|to show|yet)\b|\bno results\b|\bempty\b/i, element: /Empty/ },
  { state: 'loading', text: /\b(loading|fetching|please wait)\b|^\w+(ing)?…$|^\w+ing\.\.\.$/i, element: /Spinner|Skeleton|Loader|Loading|Shimmer/ },
];

const renders = n => {
  n = unwrap(n);
  if (!n) return false;
  if (isJsx(n) || n.type === 'StringLiteral' || n.type === 'TemplateLiteral') return true;
  if (n.type === 'ConditionalExpression') return renders(n.consequent) || renders(n.alternate);
  if (n.type === 'LogicalExpression') return renders(n.right);
  return false;
};
// Does an expression child render elements (a separator inside a sentence) rather than a value?
function hasJsx(n) {
  n = unwrap(n);
  if (!n) return false;
  if (isJsx(n)) return true;
  if (n.type === 'ConditionalExpression') return hasJsx(n.consequent) || hasJsx(n.alternate);
  if (n.type === 'LogicalExpression') return hasJsx(n.left) || hasJsx(n.right);
  if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
    let found = false;
    for (const a of n.arguments) if (isFunction(a)) traverse(a, x => { if (isJsx(x)) found = true; });
    return found;
  }
  return false;
}
const rendersNothing = n => { n = unwrap(n); return !n || n.type === 'NullLiteral' || (n.type === 'Identifier' && n.name === 'undefined') || (n.type === 'BooleanLiteral' && !n.value); };

// ---------------------------------------------------------------------------------------------- actions

const DESTRUCTIVE = new Set(['delete', 'remove', 'clear', 'reset', 'discard', 'destroy', 'erase', 'purge', 'wipe', 'trash', 'revoke', 'deactivate', 'unsubscribe']);
const words = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// "Clear filters", "Reset password" and "Remove search" lose no data.
const HARMLESS_OBJECT = new Set(['filter', 'filters', 'search', 'query', 'selection', 'sort', 'password', 'zoom', 'view']);
const isDestructive = s => { if (!s) return false; const ws = words(s); return ws.some(w => DESTRUCTIVE.has(w)) && !ws.some(w => HARMLESS_OBJECT.has(w)); };
const HANDLER_ATTR = /^on[A-Z]\w*$|^(action|formAction)$/;
const DIALOG_CALL = /^(window\.|globalThis\.)?(alert|confirm|prompt)$/;
const TOAST_CALL = /^(toast|sonner|notify|showToast|showNotification|enqueueSnackbar|addToast|pushToast|toaster|Swal|swal)(\.(success|error|info|warning|warn|loading|message|promise|custom|show|open|fire|default|danger|create|add))?$|^(message|notification)\.(success|error|info|warning|warn|loading|open)$/;
const STATE_SETTER = /^set[A-Z]\w*(Error|Errors|Message|Msg|Notice|Status|Toast|Alert|Warning|Info|Success|Feedback|Hint|Notification)$|^setError$/;
const FETCH_CALL = /^(fetch|axios(\.\w+)?|useQuery|useQueries|useSWR|useSWRInfinite|useInfiniteQuery|useSuspenseQuery|useLiveQuery)$|^supabase(\.\w+)*\.from$/;
const RAW_MESSAGE = n => { n = unwrap(n); return !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') && !n.computed && n.property.name === 'message'; };

// ---------------------------------------------------------------------------------------------- one file

const NEXT_STATE_FILES = { loading: 'loading', error: 'error', 'global-error': 'error', 'not-found': 'not-found' };

export function inventoryFile(src, file) {
  const ast = parseSource(src, file);
  const strings = [];
  const emitted = new Set();
  const slice = n => collapse(src.slice(n.start, n.end));
  const short = (s, max = 120) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const add = (node, text, entry, at = null, key = node.start) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    text = collapse(text);
    if (!text || !hasLetter(text)) return;
    const pos = at || { line: node.loc.start.line, column: node.loc.start.column + 1 };
    strings.push({ ...pos, text, ...entry, _start: node.start, _end: node.end });
  };

  const renderConds = [];                         // every conditional render: classified into states later
  const exprChildren = [];                        // {expr} rendered as JSX children (raw values)
  const stateVars = new Map();                    // useState value → its setter
  const setterArgs = new Map();                   // setter → ['literal' | 'empty' | 'value'] per call
  const customTags = [];                          // capitalised components, to describe what a branch shows
  const elements = [];                            // elements with handlers (actions)
  const landmarks = [];
  const defs = new Map();                         // function name → [function nodes]
  const bindings = new Set();                     // every declared identifier name (to tell a local confirm() from window.confirm)
  const imported = new Set();
  const dialogs = [];
  const raw = [];                                 // raw `*.message` reaching toasts, dialogs, setters, JSX
  const notFound = [];
  let fetchAt = null;
  const client = ast.program.directives?.some(d => d.value.value === 'use client') || false;
  let hooks = false;
  const def = (name, fn) => { if (!name) return; if (!defs.has(name)) defs.set(name, []); defs.get(name).push(fn); };

  traverse(ast.program, (n, anc) => {
    switch (n.type) {
      case 'JSXElement': case 'JSXFragment': {
        const tag = tagOf(n);
        const owner = n.type === 'JSXElement' ? ownerOf(n, anc) : { role: 'text', element: 'fragment' };
        if (n.type === 'JSXElement') {
          if (/^[A-Z]/.test(tag)) customTags.push({ start: n.start, tag });
          if (/^(header|nav|footer)$/.test(tag)) landmarks.push(n);
          for (const a of attrsOf(n)) {
            const name = attrName(a);
            const isValue = name === 'value' && tag === 'input' && interactiveRole(n) === 'button';
            if (!USER_PROPS.has(name) && !isValue) continue;
            const vals = a.value?.type === 'StringLiteral' ? [{ node: a.value, text: a.value.value }] : a.value?.type === 'JSXExpressionContainer' ? leaves(a.value.expression) : [];
            for (const v of vals) add(v.node, v.text, { kind: 'prop', prop: name, element: tag, role: owner.role });
          }
          if (attrsOf(n).some(a => HANDLER_ATTR.test(attrName(a)))) elements.push({ el: n, anc: [...anc] });
          if (tag === 'Suspense') { const f = getAttr(n, 'fallback'); if (f?.value) renderConds.push({ how: 'suspense', state: 'loading', test: null, branch: f.value.type === 'JSXExpressionContainer' ? f.value.expression : f.value, at: n }); }
          if (/ErrorBoundary$/.test(tag)) for (const k of ['fallback', 'FallbackComponent', 'fallbackRender']) { const f = getAttr(n, k); if (f?.value) renderConds.push({ how: 'error-boundary', state: 'error', test: null, branch: f.value.type === 'JSXExpressionContainer' ? f.value.expression : f.value, at: n }); }
        }
        if (NO_TEXT_TAGS.has(tag)) break;
        // Compose the element's own sentence: text, inline literals and {…} for values, with short inline
        // elements (<a>, <strong>, <Link>) read through so "Read the <a>guide</a> first" stays one string.
        let parts = [];
        const flush = () => {
          const first = parts.find(p => p.at);
          const text = collapse(parts.map(p => p.text).join(''));
          if (first && parts.some(p => p.letters)) add(first.node, text, { kind: 'text', element: owner.element, role: owner.role }, first.at, `jsx:${first.node.start}`);
          parts = [];
        };
        const ownText = n.children.some(c => c.type === 'JSXText' && hasLetter(c.value));
        for (const c of n.children) {
          if (c.type === 'JSXText') {
            const t = cleanJsxText(c.value);
            if (t) parts.push({ text: t, node: c, at: /\S/.test(t) ? textStart(c) : null, letters: hasLetter(t) });
          } else if (c.type === 'JSXExpressionContainer') {
            const e = unwrap(c.expression);
            if (!e || e.type === 'JSXEmptyExpression') continue;
            if (e.type === 'StringLiteral' || e.type === 'TemplateLiteral') {
              const t = e.type === 'StringLiteral' ? e.value : templateText(e);
              parts.push({ text: t, node: e, at: /\S/.test(t) ? { line: e.loc.start.line, column: e.loc.start.column + 1 } : null, letters: hasLetter(t) });
              continue;
            }
            for (const l of leaves(e)) add(l.node, l.text, { kind: 'text', element: owner.element, role: owner.role });
            if (e.type === 'Identifier' || e.type.endsWith('MemberExpression') || e.type.endsWith('CallExpression')) exprChildren.push({ start: e.start, text: slice(e), name: e.type === 'Identifier' ? e.name : null, raw: RAW_MESSAGE(e) || (e.type === 'Identifier' && ERROR_NAME.test(e.name)) });
            if (RAW_MESSAGE(e)) raw.push({ line: e.loc.start.line, via: 'jsx', expression: slice(e) });
            if (hasJsx(e)) flush();
            else parts.push({ text: '{…}', node: e, at: null, letters: false });
          } else if (c.type === 'JSXElement' && INLINE.test(tagOf(c)) && onlyText(c) && ownText) {
            const t = flatText(c);
            parts.push({ text: t, node: c, at: null, letters: hasLetter(t) });
          } else if (c.type === 'JSXElement' && tagOf(c) === 'br') parts.push({ text: ' ', node: c, at: null, letters: false });
          else flush();
        }
        flush();
        break;
      }
      case 'CallExpression': case 'OptionalCallExpression': case 'NewExpression': {
        const name = calleeName(n.callee);
        if (!name) break;
        if (FETCH_CALL.test(name) && !fetchAt) fetchAt = n.loc.start.line;
        if (/^use[A-Z]/.test(name)) hooks = true;
        if (n.type === 'NewExpression') break;
        if (name === 'notFound') notFound.push(n);
        if (/^set[A-Z]/.test(name) && n.arguments[0]) {
          const a0 = unwrap(n.arguments[0]);
          const kind = rendersNothing(a0) || (a0.type === 'StringLiteral' && !a0.value) ? 'empty' : leaves(a0).length && !RAW_MESSAGE(a0) ? 'literal' : 'value';
          if (!setterArgs.has(name)) setterArgs.set(name, []);
          setterArgs.get(name).push(kind);
        }
        if (DIALOG_CALL.test(name)) {
          const call = name.split('.').pop();
          const local = !name.includes('.') && bindings.has(call);
          if (local) break;
          const ls = n.arguments[0] ? leaves(n.arguments[0]) : [];
          for (const l of ls) add(l.node, l.text, { kind: 'dialog', call });
          dialogs.push({ line: n.loc.start.line, call, text: ls.length ? redactText(collapse(ls[0].text)) : null });
          if (n.arguments[0] && RAW_MESSAGE(n.arguments[0])) raw.push({ line: n.loc.start.line, via: call, expression: slice(n.arguments[0]) });
        } else if (TOAST_CALL.test(name)) {
          n.arguments.forEach((arg, i) => {
            const a = unwrap(arg);
            if (a?.type === 'ObjectExpression') {
              const props = o => o.properties.forEach(p => {
                if (p.type !== 'ObjectProperty') return;
                if (unwrap(p.value)?.type === 'ObjectExpression') props(unwrap(p.value));     // { action: { label: 'Undo' } }
                else if (TOAST_KEYS.has(p.key.name ?? p.key.value)) for (const l of leaves(p.value)) add(l.node, l.text, { kind: 'toast', call: name });
              });
              props(a);
            } else if (i === 0) for (const l of leaves(a)) add(l.node, l.text, { kind: 'toast', call: name });   // later plain args are types/options
            if (RAW_MESSAGE(a)) raw.push({ line: n.loc.start.line, via: name, expression: slice(a) });
          });
        } else if (STATE_SETTER.test(name.split('.').pop())) {
          const obj = n.arguments.map(unwrap).find(a => a?.type === 'ObjectExpression' && a.properties.some(p => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === 'message'));
          const src0 = obj ? obj.properties.find(p => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === 'message').value : n.arguments[0];
          if (src0) for (const l of leaves(src0)) add(l.node, l.text, { kind: 'state-message', call: name });
          if (src0 && RAW_MESSAGE(src0)) raw.push({ line: n.loc.start.line, via: name, expression: slice(src0) });
        }
        break;
      }
      case 'ThrowStatement': {
        const a = unwrap(n.argument);
        const msg = a && (a.type === 'NewExpression' || a.type === 'CallExpression') && /Error$/.test(calleeName(a.callee) || '') ? a.arguments[0] : a;
        if (msg) for (const l of leaves(msg)) add(l.node, l.text, { kind: 'thrown' });
        break;
      }
      case 'ObjectProperty': {
        const key = n.computed ? null : n.key.name ?? n.key.value;
        if (!FIELD_KEYS.has(key)) break;
        let kind = 'field';
        for (let i = anc.length - 1; i >= 0; i--) {
          const a = anc[i];
          if ((a.type === 'VariableDeclarator' && /^(metadata|viewport)$/.test(a.id?.name)) || (a.type === 'FunctionDeclaration' && a.id?.name === 'generateMetadata')) { kind = 'metadata'; break; }
        }
        for (const l of leaves(n.value)) add(l.node, l.text, { kind, field: key });
        break;
      }
      case 'IfStatement': {
        const c = n.consequent.type === 'BlockStatement' ? n.consequent.body.find(s => s.type === 'ReturnStatement') : n.consequent.type === 'ReturnStatement' ? n.consequent : null;
        if (c) renderConds.push({ how: 'if-return', test: n.test, branch: c.argument, at: n });
        break;
      }
      case 'LogicalExpression':
        if (n.operator === '&&' && renders(n.right)) renderConds.push({ how: 'and', test: n.left, branch: n.right, at: n });
        break;
      case 'ConditionalExpression':
        if (renders(n.consequent) || renders(n.alternate)) renderConds.push({ how: 'ternary', test: n.test, branch: n.consequent, alt: n.alternate, at: n });
        break;
      case 'FunctionDeclaration': def(n.id?.name, n); break;
      case 'VariableDeclarator': {
        const collect = p => {
          if (!p) return;
          if (p.type === 'Identifier') bindings.add(p.name);
          else if (p.type === 'ObjectPattern') p.properties.forEach(q => collect(q.type === 'RestElement' ? q.argument : q.value));
          else if (p.type === 'ArrayPattern') p.elements.forEach(collect);
          else if (p.type === 'AssignmentPattern') collect(p.left);
        };
        collect(n.id);
        let init = unwrap(n.init);
        if (init && (init.type === 'CallExpression') && /^(useCallback|useMemo|React\.useCallback)$/.test(calleeName(init.callee) || '')) init = unwrap(init.arguments[0]);
        if (n.id.type === 'Identifier' && init && isFunction(init)) def(n.id.name, init);
        if (n.id.type === 'ArrayPattern' && n.id.elements[0]?.type === 'Identifier' && n.id.elements[1]?.type === 'Identifier' && init?.type === 'CallExpression' && /^(React\.)?useState$/.test(calleeName(init.callee) || '')) stateVars.set(n.id.elements[0].name, n.id.elements[1].name);
        break;
      }
      case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': bindings.add(n.local.name); imported.add(n.local.name); break;
      case 'ObjectMethod': case 'ClassMethod': if (!n.computed && n.key.type === 'Identifier') def(n.key.name, n); break;
      default:
    }
  });

  // Next.js files that are a state by themselves (loading.tsx, error.tsx, not-found.tsx).
  const stem = basename(file).replace(/\.[^.]+$/, '');
  const fileState = NEXT_STATE_FILES[stem] || null;

  const inRange = (start, node) => start >= node.start && start < node.end;
  const states = [];
  const describe = (node) => {
    const ss = strings.filter(s => inRange(s._start, node));
    const els = [...new Set(customTags.filter(t => inRange(t.start, node)).map(t => t.tag))].sort();
    return { ss, els };
  };
  if (fileState) {
    const { ss, els } = describe(ast.program);
    states.push({ line: 1, state: fileState, how: 'file', by: 'file', condition: null, strings: ss.map(s => s.text), elements: els });
  }
  for (const nf of notFound) states.push({ line: nf.loc.start.line, state: 'not-found', how: 'notFound()', by: 'call', condition: null, strings: [], elements: [] });
  for (const r of renderConds) {
    let state = r.state || (r.test ? stateOfTest(r.test) : null);
    let by = r.state ? 'element' : 'condition';
    let branch = unwrap(r.branch);
    // `!loading ? <List/> : <Spinner/>`: the state is on the other side
    const t = unwrap(r.test);
    if (!state && r.alt && t?.type === 'UnaryExpression' && t.operator === '!') {
      state = stateOfTest(t.argument);
      if (state) branch = unwrap(r.alt);
    }
    // No telling name in the condition: judge by what the branch shows ("Loading…", <Spinner/>, "No tasks yet").
    if (!state && r.test) {
      for (const side of [r.branch, r.alt].filter(Boolean).map(unwrap)) {
        if (rendersNothing(side)) continue;
        const { ss, els } = describe(side);
        const c = CONTENT_STATE.find(c => ss.some(s => c.text.test(s.text)) || els.some(e => c.element.test(e)));
        if (c) { state = c.state; by = 'content'; branch = side; break; }
      }
    }
    if (!state) continue;
    const { ss, els } = branch ? describe(branch) : { ss: [], els: [] };
    const entry = { line: r.at.loc.start.line, state, how: r.how, by, condition: r.test ? short(slice(r.test)) : null, strings: ss.map(s => s.text), elements: els };
    if (rendersNothing(branch)) entry.renders = 'nothing';
    if (state === 'error' && branch) {
      // A state variable only ever set to written messages is copy, not a raw value.
      const written = x => { const k = x.name && setterArgs.get(stateVars.get(x.name)); return !!k && k.includes('literal') && !k.includes('value'); };
      const ex = [...new Set(exprChildren.filter(x => x.raw && inRange(x.start, branch) && !written(x)).map(x => x.text))].sort();
      if (ex.length) entry.rawValues = ex;
    }
    states.push(entry);
  }

  // Destructive actions, and whether a confirm or undo is near them. A handler is followed into the local
  // functions it calls (three levels); a function imported from another file is not read, so a destructive
  // call into one leaves the answer `unknown` rather than guessing.
  const analyse = (fns) => {
    const found = { confirm: null, undo: false, calls: new Set(), direct: new Set(), external: new Set() };
    const seen = new Set();
    const visit = (fn, depth) => {
      if (!fn || seen.has(fn) || depth > 3) return;
      seen.add(fn);
      const local = [];
      traverse(fn.body || fn, x => {
        if (x.type === 'Identifier' && /undo/i.test(x.name)) found.undo = true;
        if ((x.type === 'StringLiteral' && /\bundo\b/i.test(x.value)) || (x.type === 'TemplateElement' && /\bundo\b/i.test(x.value.raw))) found.undo = true;
        if (x.type !== 'CallExpression' && x.type !== 'OptionalCallExpression') return;
        const name = calleeName(x.callee) || '';
        const base = name.split('.').pop();
        if (!found.confirm) {
          if (DIALOG_CALL.test(name) && base === 'confirm' && !(name === 'confirm' && bindings.has('confirm'))) {
            const ls = x.arguments[0] ? leaves(x.arguments[0]) : [];
            found.confirm = { kind: 'native', line: x.loc.start.line, text: ls.length ? redactText(collapse(ls[0].text)) : null };
          } else if ((/^set\w*(Confirm|Dialog|Modal|Sheet|Prompt)\w*$/.test(base) && !(x.arguments[0]?.type === 'BooleanLiteral' && !x.arguments[0].value)) || /^(open|show)\w*(Confirm|Dialog|Modal)\w*$/.test(base) || base === 'showModal') {
            found.confirm = { kind: 'dialog', line: x.loc.start.line, text: null };
          } else if (/confirm/i.test(base) && !defs.has(name)) found.confirm = { kind: 'custom', line: x.loc.start.line, text: null };
        }
        if (name && !name.includes('.')) {
          if (defs.has(name)) { found.calls.add(name); if (depth === 0) found.direct.add(name); local.push(name); }
          else if (imported.has(name) && isDestructive(name)) { found.external.add(name); if (depth === 0) found.direct.add(name); }
        }
      });
      for (const c of local) for (const f of defs.get(c)) visit(f, depth + 1);
    };
    for (const f of fns) visit(f, 0);
    return found;
  };
  const actions = [];
  const usedHandlers = new Set();
  const guard = (r, resolved, handler) => {
    if (r.confirm) return r.confirm;
    if (r.undo) return null;
    if (!resolved) return { kind: 'unknown', line: null, text: null, reason: `${handler || 'the handler'} is not defined in this file` };
    if (r.external.size) return { kind: 'unknown', line: null, text: null, reason: `calls ${[...r.external].sort().join(', ')}, defined in another file` };
    return null;
  };
  for (const { el, anc } of elements) {
    const tag = tagOf(el);
    const label = labelOf(el);
    for (const a of attrsOf(el).filter(a => HANDLER_ATTR.test(attrName(a)))) {
      const v = a.value?.type === 'JSXExpressionContainer' ? unwrap(a.value.expression) : null;
      if (!v) continue;
      let handler = null; let fns = [];
      if (v.type === 'Identifier') { handler = v.name; fns = defs.get(v.name) || []; }
      else if (isFunction(v)) { handler = 'inline'; fns = [v]; }
      else if (v.type === 'CallExpression') { handler = calleeName(v.callee); fns = defs.get(handler) || []; }
      else handler = calleeName(v);
      const r = analyse(fns);
      if (handler && defs.has(handler)) usedHandlers.add(handler);
      for (const c of r.calls) usedHandlers.add(c);
      const names = [handler, ...r.direct];          // what the handler itself calls, not helpers three levels down
      // a bare `reset` handler is a retry (Next.js error.tsx); "resetForm" or a "Reset" label still count
      if (!isDestructive(label) && !names.some(n => n !== 'reset' && isDestructive(n)) && !isDestructive(attrName(a).replace(/^on/, ''))) continue;
      let confirm = guard(r, fns.length > 0, handler);
      const wrapper = anc.slice().reverse().find(x => x.type === 'JSXElement' && /AlertDialog|Confirm|Popconfirm/.test(tagOf(x)));
      if ((!confirm || confirm.kind === 'unknown') && wrapper) confirm = { kind: 'dialog', line: wrapper.loc.start.line, text: null };
      actions.push({ line: el.loc.start.line, label: label === null ? null : redactText(label), element: tag, event: attrName(a), handler, confirm, undo: r.undo });
    }
  }
  // Destructive UI handlers (handleDelete, onRemove…) defined here but not wired to an element in this file.
  for (const [name, list] of [...defs].sort((a, b) => cmp(a[0], b[0]))) {
    if (usedHandlers.has(name) || !/^(handle|on)[A-Z]/.test(name)) continue;
    if (!DESTRUCTIVE.has(words(name.replace(/^(handle|on)/, ''))[0])) continue;
    const r = analyse(list);
    actions.push({ line: list[0].loc.start.line, label: null, element: null, event: null, handler: name, confirm: guard(r, true, name), undo: r.undo });
  }

  const lms = landmarks.map(l => {
    const labels = [];
    traverse(l, x => {
      if (x.type !== 'JSXElement' || interactiveRole(x) !== 'link') return;   // navigation copies, not dialog buttons
      const t = labelOf(x);
      if (t) labels.push(redactText(t));
    });
    return { line: l.loc.start.line, tag: tagOf(l), labels: [...new Set(labels)].sort(cmp) };
  }).filter(l => l.labels.length >= 2);

  const order = (a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0) || cmp(a.kind ?? a.state ?? '', b.kind ?? b.state ?? '') || cmp(a.text ?? a.label ?? a.how ?? '', b.text ?? b.label ?? b.how ?? '');
  return {
    client,
    loadsData: fetchAt ? { line: fetchAt, client: client || hooks } : null,
    strings: strings.map(({ _start, _end, ...s }) => redact(s)).sort(order),
    states: states.map(s => ({ ...s, strings: s.strings.map(redactText) })).sort(order),
    actions: actions.sort(order),
    dialogs: dialogs.sort(order),
    raw: raw.sort(order),
    landmarks: lms.sort(order),
  };
}

// Secret-shaped strings in source text are reported by kind only (CLAUDE.md: no secrets in output).
function secretKind(text) {
  const hit = secretFindings([{ path: '', body: text }])[0];
  if (hit) return hit.evidence.kind;
  if (/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)) return 'jwt';
  return null;
}
const redactText = (text) => { const k = secretKind(text); return k ? `[secret-shaped string: ${k}]` : text; };
const redact = (s) => { const k = secretKind(s.text); return k ? { ...s, text: `[secret-shaped string: ${k}]`, secret: k } : s; };

// ---------------------------------------------------------------------------------------------- candidates

// Concepts whose different words on buttons and links are worth a look by L5 (spec §3: "different verbs for
// the same action"). The first phrase of a concept is only its name; matching is on the label's start.
const VERB_CONCEPTS = {
  delete: ['delete', 'remove', 'trash', 'move to trash', 'discard', 'erase', 'destroy'],
  'sign-in': ['sign in', 'signin', 'log in', 'login', 'log on', 'logon'],
  'sign-out': ['sign out', 'signout', 'log out', 'logout', 'log off'],
  'sign-up': ['sign up', 'signup', 'register', 'create account', 'create an account', 'join'],
  save: ['save', 'submit', 'apply'],
  cancel: ['cancel', 'dismiss', 'never mind', 'nevermind'],
  edit: ['edit', 'modify'],
  create: ['add', 'create', 'new'],
  continue: ['continue', 'next', 'proceed'],
};
// Nouns for the same concept anywhere in a short label ("same concept, different names").
const TERM_CONCEPTS = {
  settings: ['settings', 'preferences'],
  cart: ['cart', 'basket', 'bag'],
  favorites: ['favorites', 'favourites', 'bookmarks'],
};
const squash = s => s.toLowerCase().replace(/[\s\-_]+/g, '');
const labelForm = t => t.replace(/[\s.…!?:→←»«›‹]+$/u, '').replace(/\s+/g, ' ').trim();
const LABEL_ROLES = new Set(['button', 'link']);
const SHORT_ROLES = new Set(['button', 'link', 'heading', 'label', 'option', 'title']);
const SHORT_PROPS = new Set(['aria-label', 'title', 'placeholder', 'label', 'value']);
const isShort = t => t.length <= 48 && t.split(' ').length <= 6 && !t.includes('{…}') && !t.includes('${…}') && hasLetter(t);
const GENERIC_ERROR = /^(oops[.!]*\s*)?(something went wrong|something's gone wrong|an? (unexpected |unknown )?error (has )?occurred|(unknown |unexpected )?error|failed|request failed|an error happened)[.!]*$/i;
const VAGUE_CONFIRM = /^(are you sure( you want to (continue|proceed|do this))?|confirm|really|continue|proceed)\s*\??[.!]?$/i;
const CAP = 10;

function verbOf(label) {
  const l = label.toLowerCase();
  for (const [concept, phrases] of Object.entries(VERB_CONCEPTS)) {
    for (const p of [...phrases].sort((a, b) => b.length - a.length)) {
      if (l === p || l.startsWith(p + ' ')) return { concept, variant: squash(p), written: label.slice(0, p.length) };
    }
  }
  return null;
}

const occ = o => ({ file: o.file, line: o.line, text: o.text, ...(o.role ? { role: o.role } : {}) });
const byPlace = (a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.text ?? '', b.text ?? '');
function capped(list) {
  const sorted = [...list].sort(byPlace);
  return { count: sorted.length, occurrences: sorted.slice(0, CAP).map(occ) };
}

export function classify(files) {
  const all = files.flatMap(f => f.strings.map(s => ({ ...s, file: f.file })));
  const labels = all.filter(s => !s.secret && (LABEL_ROLES.has(s.role) && (s.kind === 'text' || (s.kind === 'prop' && SHORT_PROPS.has(s.prop))))).map(s => ({ ...s, text: labelForm(s.text) })).filter(s => isShort(s.text));
  const shortTexts = all.filter(s => !s.secret && ((s.kind === 'text' && SHORT_ROLES.has(s.role)) || (s.kind === 'prop' && SHORT_PROPS.has(s.prop)))).map(s => ({ ...s, text: labelForm(s.text) })).filter(s => isShort(s.text));
  const out = [];

  // L5: different verbs for the same action on buttons and links.
  const verbs = new Map();
  for (const s of labels) {
    const v = verbOf(s.text);
    if (!v) continue;
    if (!verbs.has(v.concept)) verbs.set(v.concept, new Map());
    const m = verbs.get(v.concept);
    if (!m.has(v.variant)) m.set(v.variant, []);
    m.get(v.variant).push({ ...s, written: v.written });
  }
  for (const [concept, m] of [...verbs].sort((a, b) => cmp(a[0], b[0]))) {
    if (m.size < 2) continue;
    const variants = [...m].sort((a, b) => cmp(a[0], b[0])).map(([, list]) => ({ forms: [...new Set(list.map(x => x.written))].sort(cmp), ...capped(list) }));
    out.push({ candidate: true, lens: 'L5', kind: 'verb-variants', concept, variants });
  }

  // L5: the same label written with different casing or spelling ("Sign In" / "Sign in", "Log in" / "Login").
  const forms = new Map();
  for (const s of shortTexts) {
    const k = squash(s.text);
    if (!forms.has(k)) forms.set(k, []);
    forms.get(k).push(s);
  }
  for (const [key, list] of [...forms].sort((a, b) => cmp(a[0], b[0]))) {
    const distinct = [...new Set(list.map(s => s.text))].sort(cmp);
    if (distinct.length < 2) continue;
    const onlyCase = new Set(distinct.map(d => d.toLowerCase())).size === 1;
    out.push({ candidate: true, lens: 'L5', kind: onlyCase ? 'casing-variants' : 'spelling-variants', concept: key,
      variants: distinct.map(d => ({ forms: [d], ...capped(list.filter(s => s.text === d)) })) });
  }

  // L5: the same concept named differently.
  for (const [concept, names] of Object.entries(TERM_CONCEPTS)) {
    const m = new Map();
    for (const s of shortTexts) {
      const ws = words(s.text);
      const hit = names.find(n => ws.includes(n));
      if (!hit) continue;
      if (!m.has(hit)) m.set(hit, []);
      m.get(hit).push(s);
    }
    if (m.size < 2) continue;
    out.push({ candidate: true, lens: 'L5', kind: 'term-variants', concept,
      variants: [...m].sort((a, b) => cmp(a[0], b[0])).map(([name, list]) => ({ forms: [name], ...capped(list) })) });
  }

  // L6: error copy that names neither the cause nor the next step; confirms that do not say what is affected;
  // raw `*.message` values reaching the screen.
  const stateTexts = files.flatMap(f => f.states.filter(s => s.state === 'error').flatMap(s => s.strings.map(t => ({ file: f.file, line: s.line, text: t }))));
  const messageTexts = all.filter(s => s.kind === 'toast' || s.kind === 'state-message' || (s.kind === 'dialog' && s.call === 'alert'));
  const vague = [...stateTexts, ...messageTexts].filter(s => GENERIC_ERROR.test(s.text.trim()));
  const vagueSeen = new Set();
  for (const s of vague.sort(byPlace)) {
    const k = `${s.file}:${s.line}:${s.text}`;
    if (vagueSeen.has(k)) continue;
    vagueSeen.add(k);
    out.push({ candidate: true, lens: 'L6', kind: 'vague-error', file: s.file, line: s.line, text: s.text });
  }
  for (const f of files) {
    for (const d of f.dialogs) if (d.call === 'confirm' && (d.text === null || VAGUE_CONFIRM.test(d.text.trim()))) out.push({ candidate: true, lens: 'L6', kind: 'vague-confirm', file: f.file, line: d.line, text: d.text });
    for (const r of f.raw) out.push({ candidate: true, lens: 'L6', kind: 'raw-message', file: f.file, line: r.line, via: r.via, expression: r.expression });
    for (const s of f.states) for (const e of s.rawValues || []) if (!f.raw.some(r => r.expression === e)) out.push({ candidate: true, lens: 'L6', kind: 'raw-message', file: f.file, line: s.line, via: 'error-state', expression: e });
  }

  // L9: destructive actions with no confirm and no undo in reach.
  for (const f of files) for (const a of f.actions) {
    if (a.confirm || a.undo) continue;
    out.push({ candidate: true, lens: 'L9', kind: 'unguarded-destructive', file: f.file, line: a.line, label: a.label, handler: a.handler });
  }

  // L2: client code that loads data but expresses no loading / error branch.
  for (const f of files) {
    if (!f.loadsData?.client) continue;
    if (!f.states.some(s => s.state === 'loading')) out.push({ candidate: true, lens: 'L2', kind: 'no-loading-state', file: f.file, line: f.loadsData.line });
    if (!f.states.some(s => s.state === 'error')) out.push({ candidate: true, lens: 'L2', kind: 'no-error-state', file: f.file, line: f.loadsData.line });
  }

  // L7: drifted copies of a header/nav/footer: two of the same landmark in different files sharing most links.
  const canon = t => { const v = verbOf(labelForm(t)); return v && squash(labelForm(t)) === v.variant ? `@${v.concept}` : squash(t); };
  const lms = files.flatMap(f => f.landmarks.map(l => ({ ...l, file: f.file, keys: new Set(l.labels.map(canon)) })));
  for (let i = 0; i < lms.length; i++) for (let j = i + 1; j < lms.length; j++) {
    const a = lms[i]; const b = lms[j];
    if (a.tag !== b.tag || a.file === b.file) continue;
    const common = [...a.keys].filter(k => b.keys.has(k)).length;
    const same = common === a.keys.size && common === b.keys.size && a.labels.join('\u0000') === b.labels.join('\u0000');
    if (same || common / Math.min(a.keys.size, b.keys.size) < 0.6) continue;
    const onlyA = a.labels.filter(l => !b.keys.has(canon(l)));
    const onlyB = b.labels.filter(l => !a.keys.has(canon(l)));
    const renamed = a.labels.filter(l => b.keys.has(canon(l)) && !b.labels.includes(l));
    out.push({ candidate: true, lens: 'L7', kind: 'drifted-copy', landmark: a.tag,
      copies: [{ file: a.file, line: a.line, labels: a.labels, only: onlyA }, { file: b.file, line: b.line, labels: b.labels, only: onlyB }],
      ...(renamed.length ? { worded: renamed.map(l => ({ here: l, there: b.labels.find(x => canon(x) === canon(l)) })) } : {}) });
  }

  const place = c => c.file ?? c.copies?.[0]?.file ?? c.variants?.[0]?.occurrences?.[0]?.file ?? '';
  const pline = c => c.line ?? c.copies?.[0]?.line ?? c.variants?.[0]?.occurrences?.[0]?.line ?? 0;
  return out.sort((a, b) => cmp(a.lens, b.lens) || cmp(a.kind, b.kind) || cmp(a.concept ?? '', b.concept ?? '') || cmp(place(a), place(b)) || pline(a) - pline(b));
}

// ---------------------------------------------------------------------------------------------- the app

function walkCode(dir, root, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => cmp(a.name, b.name));
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkCode(p, root, out);
    else out.push(posix(relative(root, p)));
  }
  return out;
}

// routes: from discover(). With routes, the inventory covers the files they render (source map, §2.5),
// each tagged with its routes; without, every code file under the root.
export function buildInventory(root, routes = []) {
  root = resolve(root);
  let candidatesFiles; let byFile = {};
  if (routes.length) {
    byFile = buildSourceMap(root, routes).files;
    candidatesFiles = Object.keys(byFile);
  } else candidatesFiles = walkCode(root, root);
  const files = [];
  const skipped = [];
  for (const file of [...candidatesFiles].sort(cmp)) {
    if (TEST_FILE.test(file) || CONFIG_FILE.test(file)) continue;
    // MD/MDX pages are not parsed in 0.1; listed so they are not silently missing (in tree mode only .mdx:
    // a README is not a screen)
    if (routes.length ? /\.(mdx?|markdown)$/.test(file) : /\.mdx$/.test(file)) { skipped.push({ file, reason: 'unsupported-type' }); continue; }
    if (!CODE.test(file)) continue;
    let src;
    try {
      if (statSync(join(root, file)).size > MAX_BYTES) { skipped.push({ file, reason: 'too-large' }); continue; }
      src = readFileSync(join(root, file), 'utf8');
    } catch (e) { skipped.push({ file, reason: 'unreadable', message: e.code || 'read error' }); continue; }
    let r;
    try { r = inventoryFile(src, file); }
    catch (e) {
      if (e instanceof SyntaxError || e.reasonCode || e.code === 'BABEL_PARSER_SYNTAX_ERROR') skipped.push({ file, reason: 'parse-error', message: String(e.message).split('\n')[0], ...(e.loc ? { line: e.loc.line } : {}) });
      else if (e instanceof RangeError) skipped.push({ file, reason: 'too-deep', message: 'nesting too deep to walk' });
      else skipped.push({ file, reason: 'error', message: String(e.message).split('\n')[0] });
      continue;
    }
    if (!r.strings.length && !r.states.length && !r.actions.length && !r.dialogs.length && !r.loadsData) continue;
    files.push({ file, routes: byFile[file] || [], ...r });
  }
  const candidates = classify(files);
  const count = k => files.reduce((n, f) => n + f[k].length, 0);
  return {
    schema: 1,
    parser: PARSER,
    scope: routes.length ? 'routes' : 'tree',
    note: 'candidates are inputs for the AI lenses (L2, L5, L6, L7, L9), not findings',
    summary: { files: files.length, strings: count('strings'), states: count('states'), actions: count('actions'), dialogs: count('dialogs'), candidates: candidates.length, skipped: skipped.length },
    files,
    candidates,
    skipped,
  };
}
