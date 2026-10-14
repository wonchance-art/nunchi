// What a fix may touch (design 0.1-c §4.6) and where its root cause lives. Pure functions over paths, patches and the
// run's evidence; the loop asks git for the diff.
//
// `fix --verify` takes `git diff --name-only base HEAD` and gives *needs you* when:
// - a path is nunchi's or the project's control surface: `.nunchi/**`, `package.json`, a lockfile, `.npmrc`,
//   `.yarnrc*`, `.env*`, `.github/**`, `.husky/**`, `.git*`, `*.config.*`;
// - the diff adds a dependency (an import of a package the project does not depend on), a script (`<script`), or an
//   outbound URL literal (a host that is not local);
// - it touches a file outside the claim's root-cause files and the files the group's routes render (the source map).
//
// Root-cause files: the grounded `evidence.file` of an AI item; else the inventory files whose strings match the
// finding's text or element; else the route's own page file. Never a layout or frame file (layout, template, loading,
// error, not-found, `_app`, `_document`, a TanStack root, middleware): every route shares those, and two groups would
// all "share" `app/layout.tsx`.
import { builtinModules } from 'node:module';
import { isLocalHost } from '../network.mjs';

export const CONTROL_PATHS = [
  [/(^|\/)\.nunchi(\/|$)/, "nunchi's own files"],
  [/(^|\/)package\.json$/, 'package.json'],
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock)$/, 'a lockfile'],
  [/(^|\/)\.npmrc$/, '.npmrc'],
  [/(^|\/)\.yarnrc[^/]*$/, 'yarn settings'],
  [/(^|\/)\.env[^/]*$/, 'an environment file'],
  [/(^|\/)\.github\//, 'CI (.github)'],
  [/(^|\/)\.husky\//, 'git hooks (.husky)'],
  [/(^|\/)\.git[^/]*$/, 'git settings'],
  [/(^|\/)[^/]*\.config\.[^/]+$/, 'a config file'],
];
export const FRAME_FILE = /(^|\/)(layout|template|loading|error|not-found|global-error|_app|_document|__root|middleware)\.[cm]?[jt]sx?$/;
// namespaces and well-known identifiers written as URLs, never fetched
const NOT_OUTBOUND = new Set(['www.w3.org', 'w3.org', 'schema.org', 'json-schema.org', 'example.com', 'example.org', 'example.net']);
const URL_RE = /\b(?:https?|wss?):\/\/([^\s'"`)<>\\/:?#]+)/gi;
const IMPORT_RE = [/\bimport\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g, /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g, /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g, /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g];
const BUILTIN = new Set(builtinModules);
// `@scope/name/sub` → `@scope/name`, `name/sub` → `name`; null for a relative path or an alias (`@/`, `~/`, `#x`)
export function packageOf(spec) {
  const s = String(spec);
  if (/^(\.|\/|[a-zA-Z]:[\\/]|@\/|~\/?|#|node:)/.test(s)) return null;
  const parts = s.split('/');
  const name = s.startsWith('@') ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : null) : parts[0];
  if (!name || BUILTIN.has(name)) return null;
  return name;
}

// → { ok, flagged: [{ file?, why }], outside: [files] }.
// `files`: the diff's paths (repository-relative); `patch`: `git diff --unified=0`; `allowed`: root-cause files and
// the source-map files of the group's routes (app-relative, as `prefix` + path in the repository); `deps`: the names
// the project's package.json depends on; `aliases`: path aliases (tsconfig paths) that are not packages.
export function diffPolicy({ files = [], patch = '', allowed = [], deps = new Set(), aliases = [], prefix = '' }) {
  const flagged = [];
  const ok = new Set(allowed.map(f => `${prefix}${f}`));
  for (const f of files) {
    const hit = CONTROL_PATHS.find(([re]) => re.test(f));
    if (hit) flagged.push({ file: f, why: hit[1] });
  }
  const outside = files.filter(f => !ok.has(f) && !CONTROL_PATHS.some(([re]) => re.test(f)));
  for (const f of outside) flagged.push({ file: f, why: 'outside the root-cause files and the files these screens render' });
  // added lines only
  let file = null;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, '').trim(); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    for (const m of text.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      if (!isLocalHost(host) && !NOT_OUTBOUND.has(host)) flagged.push({ file, why: `adds an outbound URL (${host})` });
    }
    if (/<script\b/i.test(text)) flagged.push({ file, why: 'adds a script tag' });
    for (const re of IMPORT_RE) for (const m of text.matchAll(re)) {
      const pkg = packageOf(m[1]);
      if (pkg && !deps.has(pkg) && !aliases.some(a => m[1] === a || m[1].startsWith(a.endsWith('/') ? a : `${a}/`))) flagged.push({ file, why: `adds a dependency (${pkg})` });
    }
  }
  const seen = new Set();
  const uniq = flagged.filter(x => { const k = `${x.file}|${x.why}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: !uniq.length, flagged: uniq, outside };
}

// The project's dependency names (package.json dependencies of every kind).
export function depsOf(pkg) {
  const out = new Set();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const n of Object.keys(pkg?.[k] || {})) out.add(n);
  return out;
}

const norm = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().toLowerCase() : '');
const TEXT_KEYS = ['text', 'name', 'label', 'placeholder', 'message', 'value'];
// The finding's words to look for in the inventory: its evidence text, its element's accessible name.
export function findingTexts(row, controlsName = null) {
  const ev = row?.evidence && typeof row.evidence === 'object' ? row.evidence : {};
  return [...new Set([...TEXT_KEYS.map(k => ev[k]), controlsName].map(norm).filter(t => t.length >= 3))];
}

// → { files: [...], from: 'evidence' | 'inventory' | 'page' | 'none' }
// rows: the group's ledger rows; inventory: the run's inventory.json; routes: discover's routes ({ path, file });
// frames: the frame files of the group's routes (source map), never root causes; names: element names per row (fp →
// accessible name from controls.json).
export function rootCauseFiles({ rows, inventory = null, routes = [], frames = new Set(), names = new Map() }) {
  const isFrame = f => frames.has(f) || FRAME_FILE.test(f);
  const grounded = [...new Set(rows.filter(r => r.source === 'ai').map(r => r.identity?.file || r.evidence?.file).filter(f => typeof f === 'string' && f))].filter(f => !isFrame(f)).sort();
  if (grounded.length) return { files: grounded, from: 'evidence' };
  const groupRoutes = new Set(rows.map(r => r.route).filter(Boolean));
  const texts = [...new Set(rows.flatMap(r => findingTexts(r, names.get(r.fp) || null)))];
  if (texts.length && Array.isArray(inventory?.files)) {
    const hits = inventory.files.filter(f => f && typeof f.file === 'string' && !isFrame(f.file) && (!groupRoutes.size || (Array.isArray(f.routes) && f.routes.some(r => groupRoutes.has(r))))
      && (f.strings || []).some(s => { const t = norm(s?.text); return t.length >= 3 && texts.some(x => x === t || (t.length >= 4 && x.includes(t)) || (x.length >= 4 && t.includes(x))); }));
    if (hits.length) return { files: [...new Set(hits.map(h => h.file))].sort(), from: 'inventory' };
  }
  const pages = routes.filter(r => groupRoutes.has(r.path) && typeof r.file === 'string' && !isFrame(r.file)).map(r => r.file);
  if (pages.length) return { files: [...new Set(pages)].sort(), from: 'page' };
  return { files: [], from: 'none' };
}
