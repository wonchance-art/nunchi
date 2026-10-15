// Source ↔ scene map (spec §2.5): which files each route renders, and which routes each file
// reaches. Used to pick scenes to re-capture after a change, to mark coverage stale and to find
// neighbour scenes after a fix. Static and deterministic; over-approximates on purpose (an import
// inside a comment still counts), because a missed edge would hide a stale screen.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const posix = p => p.split(sep).join('/');
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const CODE = /\.(m|c)?(t|j)sx?$/;
const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /@import\s+(?:url\()?['"]([^'"\n]+)['"]/g,
];

export function importsOf(source) {
  const out = new Set();
  for (const re of IMPORT_RES) for (const m of source.matchAll(re)) out.add(m[1]);
  return [...out].sort();
}

// tsconfig/jsconfig allow comments and trailing commas.
function readLooseJson(path) {
  try {
    const text = readFileSync(path, 'utf8')
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch { return null; }
}

// Path aliases from tsconfig/jsconfig (including Vite's tsconfig.app.json), plus the near-universal
// `@/` → `src/` (or root) convention when nothing declares it.
export function loadAliases(root) {
  const aliases = [];
  let baseUrl = null;
  for (const f of ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json']) {
    const cfg = readLooseJson(join(root, f));
    const co = cfg?.compilerOptions;
    if (!co) continue;
    const base = resolve(root, co.baseUrl || '.');
    if (co.baseUrl && !baseUrl) baseUrl = base;
    for (const [pattern, targets] of Object.entries(co.paths || {})) {
      aliases.push({ prefix: pattern.replace(/\*$/, ''), wildcard: pattern.endsWith('*'), targets: targets.map(t => resolve(base, t.replace(/\*$/, ''))) });
    }
  }
  if (!aliases.some(a => a.prefix === '@/')) aliases.push({ prefix: '@/', wildcard: true, targets: [existsSync(join(root, 'src')) ? join(root, 'src') : root] });
  aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  return { aliases, baseUrl };
}

function tryFile(p) {
  const candidates = [p, ...EXTS.map(e => p + e), ...EXTS.map(e => join(p, 'index' + e))];
  for (const c of candidates) { try { if (statSync(c).isFile()) return c; } catch {} }
  return null;
}

export function resolveImport(spec, fromFile, root, { aliases, baseUrl }) {
  if (spec.startsWith('.')) return tryFile(resolve(dirname(fromFile), spec));
  if (spec.startsWith('/')) return tryFile(join(root, spec));
  for (const a of aliases) {
    if (a.wildcard ? spec.startsWith(a.prefix) : spec === a.prefix) {
      for (const t of a.targets) { const f = tryFile(a.wildcard ? join(t, spec.slice(a.prefix.length)) : t); if (f) return f; }
    }
  }
  if (baseUrl) return tryFile(join(baseUrl, spec));
  return null;                                   // a package: not part of the app's source
}

// Files that render around a page without importing it: Next.js layouts and friends, the pages
// router's _app/_document, TanStack's root and parent routes, and middleware (it decides redirects).
function frameFiles(root, route, allRoutes) {
  const out = [];
  const file = join(root, route.file);
  const mw = ['middleware', 'src/middleware'].map(m => tryFile(join(root, m))).filter(Boolean);
  if (route.router === 'next-app') {
    let dir = dirname(file);
    const appDir = ['app', 'src/app'].map(d => join(root, d)).find(d => file.startsWith(d + sep));
    while (appDir && (dir === appDir || dir.startsWith(appDir + sep))) {
      for (const n of ['layout', 'template', 'loading', 'error', 'not-found']) { const f = tryFile(join(dir, n)); if (f) out.push(f); }
      if (dir === appDir) { const g = tryFile(join(dir, 'global-error')); if (g) out.push(g); break; }
      dir = dirname(dir);
    }
    out.push(...mw);
  } else if (route.router === 'next-pages') {
    for (const d of ['pages', 'src/pages']) for (const n of ['_app', '_document']) { const f = tryFile(join(root, d, n)); if (f) out.push(f); }
    out.push(...mw);
  } else if (route.router === 'tanstack-start' || route.router === 'tanstack-router') {
    const routesDir = ['src/routes', 'app/routes'].map(d => join(root, d)).find(d => file.startsWith(d + sep));
    if (routesDir) {
      const root_ = tryFile(join(routesDir, '__root')); if (root_) out.push(root_);
      const segs = f => posix(relative(routesDir, f)).replace(/\.(lazy\.)?[^.]+$/, '').split(/[/.]/).filter(s => s && s !== 'route' && s !== 'index');
      const mine = segs(file);
      for (const other of allRoutes) {
        if (other.file === route.file || /(^|[/.])index\.[^.]+$/.test(other.file)) continue;   // index routes are leaves, never parents
        const o = segs(join(root, other.file));
        if (o.length < mine.length && o.every((s, i) => s === mine[i])) out.push(join(root, other.file));
      }
      for (const f of readdirSync(routesDir)) {                               // pathless layouts: _auth.tsx
        const s = f.replace(/\.[^.]+$/, '');
        if (s.startsWith('_') && s !== '__root' && mine[0] === s) out.push(join(routesDir, f));
      }
    }
  }
  return out;
}

// Local names a file imports, by module: `import A from`, `import { B, C as D } from`, `import * as E from`,
// `const F = lazy(() => import(...))`. Used to follow a React Router route to the components it renders.
export function importBindings(source) {
  const out = new Map();
  for (const m of source.matchAll(/\bimport\s+(?!type\b)([^'"`;]*?)\s+from\s+['"]([^'"\n]+)['"]/g)) {
    const clause = m[1];
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause); if (def && !clause.startsWith('{') && !clause.startsWith('*')) out.set(def[1], m[2]);
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause); if (ns) out.set(ns[1], m[2]);
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const part of named[1].split(',')) { const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim(); if (n) out.set(n, m[2]); }
  }
  for (const m of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.set(m[1], m[2]);
  return out;
}

// A React Router route renders the components its route config names (discover reads them), not every
// page its config file imports. Null when one of them cannot be followed: the caller then falls back to
// the config file and everything it imports, which over-approximates but never misses an edge.
function reactRouterStarts(root, route, cfg) {
  if (route.router !== 'react-router' || !(route.components?.length || route.lazy?.length)) return null;
  const file = join(root, route.file);
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch { return null; }
  const bindings = importBindings(src);
  const out = [];
  for (const name of route.components || []) {
    const spec = bindings.get(name.split('.')[0]);
    const f = spec && resolveImport(spec, file, root, cfg);
    if (!f) return null;
    out.push(f);
  }
  for (const spec of route.lazy || []) {
    const f = resolveImport(spec, file, root, cfg);
    if (!f) return null;
    out.push(f);
  }
  return out;
}

// The files that frame a route without being its own page (layouts, templates, loading/error/not-found, middleware,
// `_app`/`_document`, TanStack root and parent routes), relative to the root: never a fix's root cause (design §4.6).
export function frameFilesOf(root, route, routes) {
  root = resolve(root);
  try { return [...new Set(frameFiles(root, route, routes).map(f => posix(relative(root, f))))].sort(); } catch { return []; }
}

export function buildSourceMap(root, routes) {
  root = resolve(root);
  const cfg = loadAliases(root);
  const deps = new Map();                                                     // file → direct local imports
  const depsOf = file => {
    if (deps.has(file)) return deps.get(file);
    deps.set(file, []);
    let src = '';
    try { src = readFileSync(file, 'utf8'); } catch { return []; }
    if (!CODE.test(file) && !/\.css$/.test(file)) return [];
    const list = importsOf(src).map(s => resolveImport(s, file, root, cfg)).filter(f => f && f.startsWith(root + sep) && !f.includes(`${sep}node_modules${sep}`));
    deps.set(file, [...new Set(list)].sort());
    return deps.get(file);
  };
  const byRoute = {};
  for (const r of routes) {
    const rendered = reactRouterStarts(root, r, cfg);
    const start = rendered || [join(root, r.file), ...frameFiles(root, r, routes)];
    // the route config itself is part of every route it declares, but its imports are other routes' pages
    const seen = new Set(rendered ? [join(root, r.file)] : []);
    const stack = [...start];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...depsOf(f));
    }
    byRoute[r.path] = [...seen].map(f => posix(relative(root, f))).sort();
  }
  const byFile = {};
  for (const [route, files] of Object.entries(byRoute)) for (const f of files) (byFile[f] ||= []).push(route);
  for (const f of Object.keys(byFile)) byFile[f] = [...new Set(byFile[f])].sort();
  const sortedFiles = Object.fromEntries(Object.keys(byFile).sort().map(k => [k, byFile[k]]));
  return { routes: byRoute, files: sortedFiles };
}

// What each route's code was at capture (written into a run as source-hashes.json): a hash of the contents of the
// files the route renders, and of the app's config files at the root, which reach every route. A re-check can then
// tell a route's code did not change between two captures (recheck.mjs). Contents only, never times: the same source
// gives the same bytes.
const CONFIG_FILE = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|(next|vite|tailwind|postcss)\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/;
export function sourceHashes(root, map) {
  root = resolve(root);
  const h = data => createHash('sha256').update(data).digest('hex').slice(0, 16);
  const files = new Map();
  const hashOf = f => { if (!files.has(f)) { let v = null; try { v = h(readFileSync(join(root, f))); } catch {} files.set(f, v); } return files.get(f); };
  let config = [];
  try { config = readdirSync(root).filter(n => CONFIG_FILE.test(n)).sort(); } catch {}
  const routes = {};
  for (const route of Object.keys(map.routes || {}).sort()) {
    const list = [...new Set([...(map.routes[route] || []), ...config])].sort();
    routes[route] = h(JSON.stringify(list.map(f => [f, hashOf(f)])));
  }
  return { schema: 1, note: 'per route: a hash of the contents of the files it renders and of the app config files, at capture', routes };
}

// Routes whose rendered files intersect the changed files. A change to a file the map does not
// know (package.json, config, global CSS imported by tooling) affects every route: safe default.
export function affectedRoutes(map, changedFiles) {
  const all = Object.keys(map.routes).sort();
  const known = changedFiles.filter(f => map.files[f]);
  const unknownCode = changedFiles.filter(f => !map.files[f] && /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|next\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/.test(f));
  if (unknownCode.length) return { routes: all, reason: `config changed: ${unknownCode.join(', ')}` };
  const routes = [...new Set(known.flatMap(f => map.files[f]))].sort();
  return { routes, reason: null };
}
