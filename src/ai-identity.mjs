// The identity of an AI finding (design 0.1-c §2.3), computed with the run (and the app's source) at hand, so that
// the ledger's AI fingerprint survives what changes from hunt to hunt: the claim's words, the hunt unit, the
// reference screen, the line number, the severity.
// - element: the selector, normalised (ledger.mjs normalizeSelector). An `aria=role "name"` selector becomes the
//   controls.json selector when exactly one control of the scene has that accessible name, so a hunter citing the
//   aria node and one citing the control give one item.
// - file and anchor: the grounded file, and a hash of the trimmed source line (not its number: a line that moved
//   keeps its anchor). fileHash: a hash of the whole file, so a re-check can tell the code changed (§2.4).
// - component: what the AI group is made of (§2.3): the grounded file, else the one inventory file whose strings
//   render the element's accessible name, plus that name. null when neither is known (the group is then the
//   fingerprint, so a dismissal never covers every similar element).
// Source text is data: it is read and hashed, never evaluated.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { sha } from './stable.mjs';
import { normalizeSelector } from './ledger.mjs';

const str = v => (typeof v === 'string' && v.trim() ? v : null);
// An accessible name as a group key: data in it (counts, ids) does not split a component.
export const nameKey = n => (str(n) ? n.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 100) : null);

// `aria=button "Delete garden"`, `aria=heading "Tasks" [level=1]`, `aria=group "Week 3": Mon …` → role and name;
// a node without a quoted name (`aria=paragraph: Oops!`) has none.
export function ariaRoleName(selector) {
  if (typeof selector !== 'string' || !selector.startsWith('aria=')) return null;
  const m = /^([a-z]+) "((?:[^"\\]|\\.)*)"/.exec(selector.slice(5).trim());
  return m ? { role: m[1], name: m[2].replace(/\\(.)/g, '$1') } : null;
}

// A file under the app root that is the app's own source: relative, inside the root (links too), not nunchi's
// folder, dependencies or git. → its real path, or null.
export function sourcePath(root, file) {
  if (typeof file !== 'string' || !file || isAbsolute(file) || /^[a-zA-Z]:/.test(file)) return null;
  const abs = resolve(root, file.replace(/\\/g, '/'));
  const r = relative(root, abs);
  if (!r || r.startsWith('..') || isAbsolute(r)) return null;
  const parts = r.split(sep);
  if (parts.includes('.nunchi') || parts.includes('node_modules') || parts.includes('.git')) return null;
  try {
    const real = realpathSync(abs), rr = relative(realpathSync(root), real);
    if (!rr || rr.startsWith('..') || isAbsolute(rr) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}
const MAX_SOURCE = 4 * 1024 * 1024;
export function readSource(root, file, cache = new Map()) {
  const key = `${root}\0${file}`;
  if (!cache.has(key)) {
    const p = sourcePath(root, file);
    let text = null;
    try { if (p && statSync(p).size <= MAX_SOURCE) text = readFileSync(p, 'utf8'); } catch {}
    cache.set(key, text);
  }
  return cache.get(key);
}

// The inventory file that renders `name` on `route`: the one file of the route whose strings hold it exactly.
function renderedBy(inventory, route, name) {
  if (!inventory || !Array.isArray(inventory.files) || !str(name)) return null;
  const want = name.replace(/\s+/g, ' ').trim();
  const hits = inventory.files.filter(f => f && typeof f.file === 'string' && Array.isArray(f.routes) && f.routes.includes(route)
    && Array.isArray(f.strings) && f.strings.some(s => s && typeof s.text === 'string' && s.text.replace(/\s+/g, ' ').trim() === want));
  return hits.length === 1 ? hits[0].file : null;
}

// finding: an AI finding (selector, evidence.file, evidence.line, route); controls: the scene's controls.json rows;
// inventory: the run's inventory.json or null; root: the app source root (for the anchor and fileHash).
export function aiIdentity({ finding, controls = [], inventory = null, root = null, cache }) {
  const rows = Array.isArray(controls) ? controls.filter(c => c && typeof c === 'object') : [];
  const sel = str(finding.selector);
  let element = normalizeSelector(sel), name = null;
  const aria = ariaRoleName(sel);
  if (aria) {
    name = str(aria.name);
    const hits = name ? rows.filter(c => typeof c.selector === 'string' && typeof c.name === 'string' && c.name.trim() === name.trim()) : [];
    if (hits.length === 1) element = normalizeSelector(hits[0].selector);
  } else if (sel) {
    const row = rows.find(c => c.selector === sel);
    if (row && str(row.name)) name = row.name.trim();
  }
  const file = str(finding.evidence?.file);
  const line = finding.evidence?.line;
  let anchor = null, fileHash = null;
  if (file && root) {
    const text = readSource(root, file, cache);
    if (text !== null) {
      fileHash = sha(text, 16);
      const lines = text.split('\n');
      if (Number.isInteger(line) && line >= 1 && line <= lines.length) anchor = sha(lines[line - 1].trim(), 16);
    }
  }
  const owner = file || renderedBy(inventory, finding.route, name);
  return { element, file, anchor, component: owner ? { file: owner, name: nameKey(name) } : null, fileHash };
}
