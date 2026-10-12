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
      routes.push({ path: raw, file: relFile, params, router: 'react-router', ...(absolute ? {} : { needsResolution: 'relative-path' }) });
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
