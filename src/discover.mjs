// Route discovery: reads the app's source tree (no build, no network) and returns
// every page route it can find, the dynamic segments that need sample values,
// and the files it skipped with a reason. Deterministic: same tree, same output.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep, extname, basename } from 'node:path';

const PAGE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mdx', '.md']);
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', '.vercel', 'coverage']);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const firstDir = (root, candidates) => candidates.map(c => join(root, c)).find(p => existsSync(p) && statSync(p).isDirectory());
const posix = p => p.split(sep).join('/');

export function detectFramework(root) {
  const pkg = readJson(join(root, 'package.json')) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return 'next';
  if (deps['@tanstack/react-start'] || deps['@tanstack/start'] || deps['@tanstack/solid-start']) return 'tanstack-start';
  if (deps['@tanstack/react-router'] && firstDir(root, ['src/routes', 'app/routes'])) return 'tanstack-router';
  if (deps['@react-router/dev'] || deps['react-router'] || deps['react-router-dom']) return 'react-router';
  return 'unknown';
}

// Next.js segment -> { text, param } ; returns null for segments that do not appear in the URL
function nextSegment(seg) {
  if (/^\(.*\)$/.test(seg)) return null;                     // (group)
  let m;
  if ((m = seg.match(/^\[\[\.\.\.(.+)\]\]$/))) return { text: `[[...${m[1]}]]`, param: { name: m[1], kind: 'optional-catch-all' } };
  if ((m = seg.match(/^\[\.\.\.(.+)\]$/))) return { text: `[...${m[1]}]`, param: { name: m[1], kind: 'catch-all' } };
  if ((m = seg.match(/^\[(.+)\]$/))) return { text: `[${m[1]}]`, param: { name: m[1], kind: 'single' } };
  return { text: seg };
}

function buildPath(segments, segFn) {
  const parts = []; const params = [];
  for (const s of segments) {
    const r = segFn(s);
    if (!r) continue;
    if (r.text !== '') parts.push(r.text);
    if (r.param) params.push(r.param);
  }
  return { path: '/' + parts.join('/'), params };
}

function discoverNextApp(root, appDir, routes, excluded) {
  for (const file of walk(appDir)) {
    const rel = posix(relative(appDir, file));
    const segs = rel.split('/');
    const name = segs.pop();
    const ext = extname(name);
    const stem = basename(name, ext);
    if (stem === 'route' && CODE_EXT.has(ext)) { excluded.push({ file: posix(relative(root, file)), reason: 'api-route-handler' }); continue; }
    if (stem !== 'page' || !PAGE_EXT.has(ext)) continue;
    if (segs.some(s => s.startsWith('_'))) { excluded.push({ file: posix(relative(root, file)), reason: 'private-folder' }); continue; }
    if (segs.some(s => /^\(\.{1,3}\)/.test(s))) { excluded.push({ file: posix(relative(root, file)), reason: 'intercepting-route' }); continue; }
    if (segs.some(s => s.startsWith('@'))) { excluded.push({ file: posix(relative(root, file)), reason: 'parallel-route-slot' }); continue; }
    const { path, params } = buildPath(segs, nextSegment);
    routes.push({ path, file: posix(relative(root, file)), params, router: 'next-app' });
  }
}

function discoverNextPages(root, pagesDir, routes, excluded) {
  for (const file of walk(pagesDir)) {
    const rel = posix(relative(pagesDir, file));
    const ext = extname(rel);
    if (!PAGE_EXT.has(ext)) continue;
    const segs = rel.slice(0, -ext.length).split('/');
    if (segs[0] === 'api') { excluded.push({ file: posix(relative(root, file)), reason: 'api-route' }); continue; }
    const last = segs[segs.length - 1];
    if (segs.length === 1 && ['_app', '_document', '_error', '404', '500'].includes(last)) {
      excluded.push({ file: posix(relative(root, file)), reason: last.startsWith('_') ? 'framework-file' : 'error-page' });
      continue;
    }
    if (last === 'index') segs.pop();
    const { path, params } = buildPath(segs, nextSegment);
    routes.push({ path, file: posix(relative(root, file)), params, router: 'next-pages' });
  }
}

// TanStack file-based routing: dots nest, `$id` is a param, lone `$` is a splat,
// `_name` is pathless, `name_` escapes nesting, `(group)` and `-name` are ignored.
function tanstackSegment(seg) {
  if (seg === '' || seg === 'index' || seg === 'route') return { text: '' };
  if (/^\(.*\)$/.test(seg)) return null;
  if (seg.startsWith('_')) return null;
  const s = seg.endsWith('_') ? seg.slice(0, -1) : seg;
  if (s === '$') return { text: '$', param: { name: '_splat', kind: 'catch-all' } };
  if (s.startsWith('$')) return { text: s, param: { name: s.slice(1), kind: 'single' } };
  if (/^\{-\$.+\}$/.test(s)) return { text: s, param: { name: s.slice(3, -1), kind: 'optional' } };
  return { text: s };
}

function discoverTanstack(root, routesDir, routes, excluded, router) {
  for (const file of walk(routesDir)) {
    const rel = posix(relative(routesDir, file));
    const ext = extname(rel);
    if (!CODE_EXT.has(ext)) continue;
    let stem = rel.slice(0, -ext.length);
    if (rel.split('/').some(p => p.startsWith('-'))) continue;            // ignored by the router
    if (/\.(test|spec)$/.test(stem)) continue;
    if (stem.endsWith('.lazy')) stem = stem.slice(0, -5);
    const last = stem.split('/').pop();
    if (last === '__root') { excluded.push({ file: posix(relative(root, file)), reason: 'root-layout' }); continue; }
    const segs = stem.split('/').flatMap(p => p.split('.'));
    if (segs[0] === 'api') { excluded.push({ file: posix(relative(root, file)), reason: 'api-route' }); continue; }
    // a pathless layout file (e.g. `_auth.tsx`) renders no page of its own
    if (segs.length && segs[segs.length - 1].startsWith('_') && segs[segs.length - 1] !== '_') {
      excluded.push({ file: posix(relative(root, file)), reason: 'pathless-layout' });
      continue;
    }
    const { path, params } = buildPath(segs, tanstackSegment);
    routes.push({ path: path.replace(/\/+$/, '') || '/', file: posix(relative(root, file)), params, router });
  }
}

// What a React Router route renders, read statically: the components named by its own `element` /
// `Component` / `lazy` and by those of the layout routes around it, innermost first. The source map
// starts from these instead of from the config file, which imports every page. Brackets are counted
// raw (no string parsing): a brace inside a string in a route config is rare, and an apostrophe in JSX
// text, which string parsing would trip on, is not.
const JSX_NAMES = text => [...text.matchAll(/<\s*([A-Z][\w.]*)/g)].map(m => m[1]);
const LAZY_SPECS = text => [...text.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g)].map(m => m[1]);

function bracketPairs(src) {
  const open = { '{': '}', '[': ']', '(': ')' };
  const stack = []; const pairs = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (open[c]) stack.push([c, i]);
    else if (c === '}' || c === ']' || c === ')') {
      while (stack.length && open[stack[stack.length - 1][0]] !== c) stack.pop();
      const top = stack.pop();
      if (top) pairs.push({ kind: top[0], start: top[1], end: i });
    }
  }
  return pairs;
}

// The text of an object at its own depth: nested objects, arrays and calls blanked out.
function ownText(src, obj, pairs) {
  const chars = src.slice(obj.start + 1, obj.end).split('');
  for (const p of pairs) {
    if (p.kind !== '(' && p.start > obj.start && p.end < obj.end) for (let k = p.start - obj.start; k < p.end - obj.start - 1; k++) chars[k] = ' ';
  }
  return chars.join('');
}

function objectRenders(text) {
  const out = { components: [], lazy: [] };
  const el = /\belement\s*:\s*([\s\S]*?)(?=,\s*[A-Za-z_$][\w$]*\s*:|$)/.exec(text);
  if (el) out.components.push(...JSX_NAMES(el[1]));
  const comp = /\bComponent\s*:\s*([A-Z][\w.]*)/.exec(text);
  if (comp) out.components.push(comp[1]);
  const lazy = /\blazy\s*:\s*([\s\S]*?)(?=,\s*[A-Za-z_$][\w$]*\s*:|$)/.exec(text);
  if (lazy) out.lazy.push(...LAZY_SPECS(lazy[1]));
  return out;
}

function tagRenders(src, tagStart, pairs) {
  const out = { components: [], lazy: [] };
  // the tag ends at the first `>` outside braces
  let end = tagStart; let depth = 0;
  for (; end < src.length; end++) {
    const c = src[end];
    if (c === '{') depth++; else if (c === '}') depth--; else if (c === '>' && depth === 0) break;
  }
  const tag = src.slice(tagStart, end + 1);
  const attr = name => {
    const at = new RegExp(`\\b${name}\\s*=\\s*\\{`).exec(tag);
    if (!at) return null;
    const open = tagStart + at.index + at[0].length - 1;
    const pair = pairs.find(p => p.start === open);
    return pair ? src.slice(open + 1, pair.end) : null;
  };
  const el = attr('element'); if (el) out.components.push(...JSX_NAMES(el));
  const comp = attr('Component'); if (comp && /^\s*[A-Z][\w.]*\s*$/.test(comp)) out.components.push(comp.trim());
  const lazy = attr('lazy'); if (lazy) out.lazy.push(...LAZY_SPECS(lazy));
  return { ...out, selfClosing: /\/\s*>$/.test(tag), end };
}

function routeRenders(src, index, pairs) {
  const out = { components: [], lazy: [] };
  const add = r => { out.components.push(...r.components); out.lazy.push(...r.lazy); };
  if (src.startsWith('<Route', index)) {
    add(tagRenders(src, index, pairs));
    // open <Route> tags before this one are its layouts, innermost first
    const stack = [];
    for (const m of src.slice(0, index).matchAll(/<Route\b|<\/Route\s*>/g)) {
      if (m[0].startsWith('</')) { stack.pop(); continue; }
      const t = tagRenders(src, m.index, pairs);
      if (!t.selfClosing) stack.push(t);
    }
    for (const t of stack.reverse()) add(t);
  } else {
    const objects = pairs.filter(p => p.kind === '{' && p.start < index && p.end > index).sort((a, b) => b.start - a.start);
    for (const o of objects) add(objectRenders(ownText(src, o, pairs)));
  }
  return { components: [...new Set(out.components)], lazy: [...new Set(out.lazy)] };
}

// React Router: static scan for `path: "..."` in route objects and `<Route path="...">`.
// Relative (nested) paths cannot be resolved without evaluating the tree, so they are
// reported as `needsResolution` for the agent to resolve from the source.
function discoverReactRouter(root, routes, excluded) {
  const srcDir = firstDir(root, ['src', 'app']) || root;
  const re = /(?:<Route\b[^>]*?\bpath\s*=\s*|\bpath\s*:\s*)(["'`])([^"'`]*)\1/g;
  const seen = new Set();
  for (const file of walk(srcDir)) {
    if (!CODE_EXT.has(extname(file))) continue;
    const src = readFileSync(file, 'utf8');
    if (!/react-router|createBrowserRouter|<Route\b|RouteObject/.test(src)) continue;
    const pairs = bracketPairs(src);
    let m;
    while ((m = re.exec(src))) {
      const raw = m[2];
      const relFile = posix(relative(root, file));
      if (raw === '*') { excluded.push({ file: relFile, path: raw, reason: 'not-found-catch-all' }); continue; }
      const key = raw + '\u0000' + relFile;
      if (seen.has(key)) continue;
      seen.add(key);
      const params = [...raw.matchAll(/:([A-Za-z0-9_]+)(\?)?/g)].map(p => ({ name: p[1], kind: p[2] ? 'optional' : 'single' }));
      if (raw.endsWith('/*') || raw === '*') params.push({ name: '*', kind: 'catch-all' });
      const absolute = raw.startsWith('/');
      const renders = routeRenders(src, m.index, pairs);
      routes.push({
        path: raw, file: relFile, params, router: 'react-router',
        ...(renders.components.length ? { components: renders.components } : {}),
        ...(renders.lazy.length ? { lazy: renders.lazy } : {}),
        ...(absolute ? {} : { needsResolution: 'relative-path' }),
      });
    }
  }
}

export function discover(root) {
  const framework = detectFramework(root);
  const routes = []; const excluded = [];
  if (framework === 'next') {
    const appDir = firstDir(root, ['app', 'src/app']);
    const pagesDir = firstDir(root, ['pages', 'src/pages']);
    if (appDir) discoverNextApp(root, appDir, routes, excluded);
    if (pagesDir) discoverNextPages(root, pagesDir, routes, excluded);
  } else if (framework === 'tanstack-start' || framework === 'tanstack-router') {
    const routesDir = firstDir(root, ['src/routes', 'app/routes']);
    if (routesDir) discoverTanstack(root, routesDir, routes, excluded, framework);
  } else if (framework === 'react-router') {
    discoverReactRouter(root, routes, excluded);
  }
  routes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.file < b.file ? -1 : 1));
  excluded.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const fallback = routes.length === 0 ? 'crawl' : null;
  return { framework, routes, excluded, fallback };
}
