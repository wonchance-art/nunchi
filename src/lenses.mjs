// Lens packs (spec §3): a lens is plain data — a definition, a checklist, examples, a severity rubric —
// never code. Packs load in a fixed order and later ones override earlier ones:
//   1. built-in    lenses/*.json next to the engine
//   2. external    files listed in .nunchi/lenses.lock.json, each pinned by sha256 (refused on mismatch)
//   3. project     .nunchi/lenses/*.json — the project has the last word over packs it adopted
// A pack with the same id replaces the earlier lens; a pack with `extends: <its own id>` merges into it.
// Nothing here evaluates, imports or fetches anything: files are read and parsed as JSON only.
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stableJson, sha } from './stable.mjs';

export const BUILTIN_DIR = fileURLToPath(new URL('../lenses/', import.meta.url));
export const METHODS = ['ai', 'rule', 'computed'];
export const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
// Scene axes as the capture writes them (spec §2.1). Kept here so this module needs no browser package.
export const SCENE_AXES = {
  states: ['normal', 'empty', 'error', 'slow', 'offline'],
  viewports: ['m', 'd'],
  persons: ['guest', 'signed-in'],
};
// Per-scene evidence files a lens may ask the hunter to read (spec §2.4).
export const EVIDENCE_FILES = ['aria.yml', 'console.json', 'controls.json', 'full.jpg', 'links.json', 'measure.json', 'network.json', 'styles.json', 'text.txt', 'top.jpg'];

const LENS_ID = /^L([1-9]|10)$/;
const ITEM_ID = /^(L(?:[1-9]|10))\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LENS_KEYS = ['schema', 'id', 'name', 'definition', 'checklist', 'examples', 'severityRubric', 'method', 'scenes', 'evidence', 'source', 'reference', 'extends'];
const ITEM_KEYS = ['id', 'question', 'scenes', 'off'];
const BUNDLE_KEYS = ['schema', 'name', 'lenses'];
const EXECUTABLE = /^(on[A-Z_]|script|exec|run|command|cmd|eval|code|func|fn$|handler|hook|require|import|module|plugin|shell|spawn|url$|href$|src$)/i;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LIMITS = { name: 80, definition: 2000, question: 400, example: 400, rubric: 300, items: 20, examples: 10 };

export const lensNumber = id => Number(String(id).slice(1));
const byLensId = (a, b) => lensNumber(a.id) - lensNumber(b.id);
// Code-point order, not locale order: the same on every machine.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function lensError(problems, where) {
  const e = new Error(`lens pack ${where} is not valid:\n  - ${problems.join('\n  - ')}`);
  e.code = 'BAD_LENS';
  e.problems = problems;
  return e;
}

// Plain data only: strings, finite numbers, booleans, null, arrays and plain objects. JSON.parse cannot
// produce anything else, but packs may also be passed in memory, so this is checked, not assumed.
function plainDataProblems(value, path, out, depth = 0) {
  if (depth > 8) { out.push(`${path}: nested too deeply`); return; }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) out.push(`${path}: not a finite number`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => plainDataProblems(v, `${path}[${i}]`, out, depth + 1)); return; }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) { out.push(`${path}: not a plain object`); return; }
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(k)) { out.push(`${path}.${k}: forbidden key`); continue; }
      plainDataProblems(value[k], `${path}.${k}`, out, depth + 1);
    }
    return;
  }
  out.push(`${path}: ${typeof value} is not data (lens packs cannot contain code)`);
}

function unknownKeys(obj, allowed, path, out) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    out.push(EXECUTABLE.test(k) ? `${path}.${k}: unknown key that looks executable (lens packs are data only)` : `${path}.${k}: unknown key`);
  }
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function scenesProblems(v, path, out) {
  if (!isObj(v)) { out.push(`${path}: must be an object like {"states": ["normal"]}`); return; }
  unknownKeys(v, Object.keys(SCENE_AXES), path, out);
  for (const [axis, known] of Object.entries(SCENE_AXES)) {
    if (v[axis] === undefined) continue;
    if (!Array.isArray(v[axis]) || !v[axis].length || v[axis].some(x => !known.includes(x)) || new Set(v[axis]).size !== v[axis].length) {
      out.push(`${path}.${axis}: must be a non-empty list of distinct values from ${known.join(', ')}`);
    }
  }
}

// partial = an `extends` overlay: only id and extends are required.
export function lensProblems(lens, where = 'lens', { partial = !!(lens && lens.extends !== undefined) } = {}) {
  const out = [];
  plainDataProblems(lens, where, out);
  if (out.length) return out;
  if (!isObj(lens)) return [`${where}: a lens must be a JSON object`];
  unknownKeys(lens, LENS_KEYS, where, out);
  const has = k => lens[k] !== undefined;
  if (has('schema') && lens.schema !== 1) out.push(`${where}.schema: must be 1`);
  if (!LENS_ID.test(lens.id ?? '')) out.push(`${where}.id: must be L1 … L10`);
  if (has('extends') && lens.extends !== lens.id) out.push(`${where}.extends: must name the lens's own id (${lens.id}) — a pack refines an earlier lens of the same id`);
  for (const k of ['name', 'definition', 'checklist', 'examples', 'severityRubric', 'method', 'scenes', 'evidence']) {
    if (!partial && !has(k)) out.push(`${where}.${k}: required`);
  }
  if (has('name') && !str(lens.name, LIMITS.name)) out.push(`${where}.name: non-empty text up to ${LIMITS.name} characters`);
  if (has('definition') && !str(lens.definition, LIMITS.definition)) out.push(`${where}.definition: non-empty text up to ${LIMITS.definition} characters`);
  if (has('method') && !METHODS.includes(lens.method)) out.push(`${where}.method: one of ${METHODS.join(', ')}`);
  if (has('scenes')) scenesProblems(lens.scenes, `${where}.scenes`, out);
  if (has('evidence')) {
    if (!Array.isArray(lens.evidence) || lens.evidence.some(f => !EVIDENCE_FILES.includes(f)) || new Set(lens.evidence).size !== lens.evidence.length) {
      out.push(`${where}.evidence: a list of distinct evidence files from ${EVIDENCE_FILES.join(', ')}`);
    } else if (!partial && lens.method === 'ai' && !lens.evidence.length) out.push(`${where}.evidence: an AI lens needs at least one evidence file`);
  }
  // optional: true gives each work unit the source inventory slice of its route (hunt/source/<hash>.json)
  if (has('source') && typeof lens.source !== 'boolean') out.push(`${where}.source: true or false`);
  // optional: "nearest" picks each unit's reference from the route sharing the most leading path segments
  // (a detail page gets its list page); default "spread" spreads references over the app by hash
  if (has('reference') && !['nearest', 'spread'].includes(lens.reference)) out.push(`${where}.reference: "nearest" or "spread"`);
  if (has('checklist')) {
    if (!Array.isArray(lens.checklist) || (!partial && !lens.checklist.length) || lens.checklist.length > LIMITS.items) {
      out.push(`${where}.checklist: a list of 1–${LIMITS.items} items`);
    } else {
      const seen = new Set();
      lens.checklist.forEach((item, i) => {
        const p = `${where}.checklist[${i}]`;
        if (!isObj(item)) { out.push(`${p}: must be an object {id, question}`); return; }
        unknownKeys(item, ITEM_KEYS, p, out);
        const m = ITEM_ID.exec(item.id ?? '');
        if (!m) out.push(`${p}.id: must look like ${lens.id || 'L6'}.kebab-case-name`);
        else if (m[1] !== lens.id) out.push(`${p}.id: must start with the lens id ${lens.id}.`);
        if (seen.has(item.id)) out.push(`${p}.id: duplicate ${item.id}`);
        seen.add(item.id);
        if (item.off !== undefined) {
          if (item.off !== true) out.push(`${p}.off: only true is allowed`);
          else if (!partial) out.push(`${p}.off: only in a pack that extends a lens`);
          if (item.question !== undefined || item.scenes !== undefined) out.push(`${p}: an item turned off has only id and off`);
          return;
        }
        if (!str(item.question, LIMITS.question)) out.push(`${p}.question: non-empty text up to ${LIMITS.question} characters`);
        if (item.scenes !== undefined) scenesProblems(item.scenes, `${p}.scenes`, out);
      });
    }
  }
  if (has('examples')) {
    if (!isObj(lens.examples)) out.push(`${where}.examples: an object {good: [...], bad: [...]}`);
    else {
      unknownKeys(lens.examples, ['good', 'bad'], `${where}.examples`, out);
      for (const k of ['good', 'bad']) {
        const v = lens.examples[k];
        if (v === undefined && partial) continue;
        if (!Array.isArray(v) || v.length > LIMITS.examples || v.some(x => !str(x, LIMITS.example))) out.push(`${where}.examples.${k}: a list of up to ${LIMITS.examples} texts (each up to ${LIMITS.example} characters)`);
      }
    }
  }
  if (has('severityRubric')) {
    if (!isObj(lens.severityRubric) || (!partial && !Object.keys(lens.severityRubric).length)) out.push(`${where}.severityRubric: an object with at least one of ${SEVERITIES.join(', ')}`);
    else {
      unknownKeys(lens.severityRubric, SEVERITIES, `${where}.severityRubric`, out);
      for (const [k, v] of Object.entries(lens.severityRubric)) if (SEVERITIES.includes(k) && !str(v, LIMITS.rubric)) out.push(`${where}.severityRubric.${k}: non-empty text up to ${LIMITS.rubric} characters`);
    }
  }
  return out;
}

export function validateLens(lens, where) {
  const problems = lensProblems(lens, where);
  if (problems.length) throw lensError(problems, where);
  return lens;
}

const uniq = list => [...new Set(list)];

// An `extends` overlay merged into the earlier lens of the same id. Scalars are replaced, `scenes` and
// `severityRubric` merge key by key, examples are appended, checklist items are replaced by id
// (new ones appended in the overlay's order, `off: true` removes one). `evidence` is replaced.
export function mergeLens(base, overlay) {
  const out = structuredClone(base);
  for (const k of ['name', 'definition', 'method', 'source', 'reference']) if (overlay[k] !== undefined) out[k] = overlay[k];
  if (overlay.evidence !== undefined) out.evidence = [...overlay.evidence];
  if (overlay.scenes !== undefined) out.scenes = { ...out.scenes, ...structuredClone(overlay.scenes) };
  if (overlay.severityRubric !== undefined) out.severityRubric = { ...out.severityRubric, ...overlay.severityRubric };
  if (overlay.examples !== undefined) {
    for (const k of ['good', 'bad']) out.examples[k] = uniq([...(out.examples[k] || []), ...(overlay.examples[k] || [])]);
  }
  if (overlay.checklist !== undefined) {
    const list = out.checklist.slice();
    for (const item of overlay.checklist) {
      const i = list.findIndex(x => x.id === item.id);
      if (item.off) { if (i >= 0) list.splice(i, 1); continue; }
      if (i >= 0) list[i] = structuredClone(item); else list.push(structuredClone(item));
    }
    out.checklist = list;
  }
  delete out.extends;
  return out;
}

// A pack file holds one lens, or a bundle {"schema": 1, "name": "...", "lenses": [ ... ]}.
function lensesInFile(text, where) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw lensError([`not JSON (${e.message})`], where); }
  const problems = [];
  plainDataProblems(data, where, problems);
  if (problems.length) throw lensError(problems, where);
  if (isObj(data) && data.lenses !== undefined && data.id === undefined) {
    unknownKeys(data, BUNDLE_KEYS, where, problems);
    if (data.schema !== undefined && data.schema !== 1) problems.push(`${where}.schema: must be 1`);
    if (data.name !== undefined && !str(data.name, LIMITS.name)) problems.push(`${where}.name: non-empty text up to ${LIMITS.name} characters`);
    if (!Array.isArray(data.lenses) || !data.lenses.length) problems.push(`${where}.lenses: a non-empty list of lenses`);
    if (problems.length) throw lensError(problems, where);
    const ids = data.lenses.map(l => (isObj(l) ? l.id : null));
    const dup = ids.filter((id, i) => id && ids.indexOf(id) !== i);
    if (dup.length) throw lensError([`${where}: lens ${dup[0]} appears twice in one pack`], where);
    return data.lenses.map((l, i) => validateLens(l, `${where}.lenses[${i}]`));
  }
  return [validateLens(data, where)];
}

const posix = p => p.split(sep).join('/');
function jsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json')).sort(cmp).map(n => join(dir, n)).filter(f => statSync(f).isFile());
}
const insideDir = (dir, f) => { const r = relative(dir, f); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };

// Reads .nunchi/lenses.lock.json: {"schema": 1, "packs": [{"path": "vendor/x-lenses.json", "sha256": "<64 hex>"}]}.
// Paths are relative to the project root and must stay inside it. Packs are already on disk: the
// engine never downloads anything.
function lockedPacks(root) {
  const lockPath = join(root, '.nunchi', 'lenses.lock.json');
  if (!existsSync(lockPath)) return [];
  const where = '.nunchi/lenses.lock.json';
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch (e) { throw lensError([`not JSON (${e.message})`], where); }
  const problems = [];
  plainDataProblems(lock, where, problems);
  if (!problems.length) {
    if (!isObj(lock)) problems.push(`${where}: must be an object {"schema": 1, "packs": [...]}`);
    else {
      unknownKeys(lock, ['schema', 'packs'], where, problems);
      if (lock.schema !== undefined && lock.schema !== 1) problems.push(`${where}.schema: must be 1`);
      if (!Array.isArray(lock.packs)) problems.push(`${where}.packs: a list of {path, sha256}`);
      else lock.packs.forEach((p, i) => {
        const w = `${where}.packs[${i}]`;
        if (!isObj(p)) { problems.push(`${w}: must be {path, sha256}`); return; }
        unknownKeys(p, ['path', 'sha256'], w, problems);
        if (typeof p.path !== 'string' || !p.path || isAbsolute(p.path) || !insideDir(root, resolve(root, p.path))) problems.push(`${w}.path: a relative path inside the project`);
        if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(p.sha256)) problems.push(`${w}.sha256: 64 hex characters`);
      });
    }
  }
  if (problems.length) throw lensError(problems, where);
  return lock.packs.map(p => ({ path: posix(p.path), sha256: p.sha256.toLowerCase() }));
}

// Returns {lenses (sorted L1 … L10), sources [{kind, path, sha256}]}. Throws BAD_LENS or LENS_HASH_MISMATCH.
export function loadLenses({ root = process.cwd(), builtinDir = BUILTIN_DIR } = {}) {
  const files = [];
  for (const f of jsonFiles(builtinDir)) files.push({ kind: 'built-in', abs: f, path: `lenses/${relative(builtinDir, f).split(sep).join('/')}` });
  for (const p of lockedPacks(root)) {
    const abs = resolve(root, p.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw lensError([`${p.path}: listed in .nunchi/lenses.lock.json but not found`], p.path);
    // a symlink must not lead outside the project either
    if (!insideDir(realpathSync(root), realpathSync(abs))) throw lensError([`${p.path}: resolves outside the project`], p.path);
    files.push({ kind: 'external', abs, path: p.path, want: p.sha256 });
  }
  for (const f of jsonFiles(join(root, '.nunchi', 'lenses'))) files.push({ kind: 'project', abs: f, path: posix(relative(root, f)) });
  const byId = new Map();
  const sources = [];
  for (const f of files) {
    const bytes = readFileSync(f.abs);
    const have = createHash('sha256').update(bytes).digest('hex');
    if (f.want && have !== f.want) {
      const e = new Error(`lens pack ${f.path}: sha256 is ${have}, but .nunchi/lenses.lock.json pins ${f.want}. Refusing to load it: re-check the pack and update the lock only if you trust the new content.`);
      e.code = 'LENS_HASH_MISMATCH';
      throw e;
    }
    sources.push({ kind: f.kind, path: f.path, sha256: have });
    for (const lens of lensesInFile(bytes.toString('utf8'), f.path)) {
      if (lens.extends !== undefined) {
        const base = byId.get(lens.id);
        if (!base) throw lensError([`${f.path}: extends ${lens.id}, but no earlier pack defines it`], f.path);
        const merged = mergeLens(base, lens);
        validateLens(merged, `${f.path} (${lens.id} after extends)`);
        byId.set(lens.id, merged);
      } else byId.set(lens.id, structuredClone(lens));
    }
  }
  const lenses = [...byId.values()].map(l => { const c = { ...l }; delete c.schema; return c; }).sort(byLensId);
  return { lenses, sources };
}

// Content hash of a lens: two plans made with different lens text never share unit ids silently.
export const lensHash = lens => sha(stableJson(lens), 16);
