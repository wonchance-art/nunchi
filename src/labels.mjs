// Label mode (design 0.1-c §9.2): blinded labelling for the precision gate, `nunchi open --label`.
//
// - The pool: the ledger's AI groups (double-checked or not, still there) and the claims the verifier rejected or
//   could not judge in the latest run's ai-findings.json (they never became items, §2.2). Decoys and known-true items
//   are added by the gate's harness (pre-registered, §9), which knows which they are; the board does not.
// - Blinded: a labeller sees the lens's definition, the checklist question, the claim and its evidence (screenshot
//   with the box, element, file:line). Hidden: where it came from (rule or AI, hunt or decoy), the verifier's verdict,
//   the severity, decisions and statuses. The order is shuffled per labeller (a hash of labeller and item), so the
//   position says nothing either.
// - Labels are per labeller: `.nunchi/labels/<labeller>/<id>.json` (committed, so a second labeller's arrive through
//   git), each written atomically through the board, the human channel (design §1); this machine records the content
//   of each label it wrote in the state store's `labels-approved.json`.
import { join } from 'node:path';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { sha, stableJson, writeAtomic } from './stable.mjs';
import { readJsonFile, updateDoc, readDoc, present } from './state.mjs';
import { annotate } from './ledger.mjs';
import { loadLenses } from './lenses.mjs';
import { safe, shownPath, runEvidence, evidenceUrl, RUN_ID } from './board/model.mjs';
import { drawable, LABELS } from './board/shared.mjs';

export const LABELLER = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const slugLabeller = name => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'me';
const LABEL_VALUES = new Set(Object.values(LABELS));
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00');
const readJsonOr = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const box4 = b => (Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(n => typeof n === 'number' && Number.isFinite(n)) ? b.slice(0, 4) : null);

// The pool, with what labelling needs and nothing that unblinds it. `model`: buildBoardModel's.
export function labelPool(model, labeller) {
  const items = new Map();
  const add = (id, it) => { if (!items.has(id)) items.set(id, { id, ...it }); };
  for (const g of model.groups) {
    if (g.source !== 'ai' || !g.active) continue;
    const r = g._rows[0];
    add(g.id, { lens: r.lens, rule: r.rule, claim: r.evidence?.claim || '', file: r.evidence?.file || null, line: r.evidence?.line ?? null,
      seen: g._inst.filter(f => f.run && f.scene).map(f => ({ run: f.run, scene: f.scene, selector: f.selector, box: f.box })) });
  }
  // claims the verifier rejected or could not judge (not items, so only the latest run's file has them)
  const latest = model.latest;
  if (latest && RUN_ID.test(latest)) {
    const doc = readJsonOr(join(model.led.st.runsDir, latest, 'ai-findings.json'), null);
    const list = (Array.isArray(doc) ? doc : doc?.findings || []).filter(f => f && f.source === 'ai' && (f.status === 'rejected' || f.status === 'insufficient'));
    for (const f of annotate(list.map(({ fp, group, ...x }) => x))) {
      add(f.group, { lens: f.lens, rule: f.rule, claim: f.evidence?.claim || '', file: f.evidence?.file || null, line: f.evidence?.line ?? null,
        seen: typeof f.scene === 'string' ? [{ run: latest, scene: f.scene, selector: typeof f.selector === 'string' ? f.selector : null, box: box4(f.box) }] : [] });
    }
  }
  const salt = id => sha(`${labeller}:${id}`, 16);
  return [...items.values()].sort((a, b) => (salt(a.id) < salt(b.id) ? -1 : salt(a.id) > salt(b.id) ? 1 : 0));
}

// One pool item as a labeller sees it: blinded (no source, verdict, severity, status or decision).
export function blindItem(model, item, { lenses = null, label = null } = {}) {
  const lens = lenses?.[item.lens] || null;
  const question = lens?.checklist?.find(c => c.id === item.rule)?.question || null;
  const scenes = {};
  const instances = item.seen.map(s => {
    const ev = model.evidenceOf(s.run);
    const sc = ev.sceneById.get(s.scene);
    if (sc) scenes[sc.key] = { key: sc.key, route: safe(sc.route, 200), viewport: sc.viewport, state: sc.state, person: sc.person,
      img: sc.img ? { w: sc.img.w, h: sc.img.h, dpr: sc.img.dpr, vh: sc.img.vh, url: evidenceUrl(sc.run, sc.id, sc.img.file) } : null };
    const f = { box: s.box, inside: null };
    return { scene: sc ? sc.key : null, selector: s.selector ? safe(s.selector, 300) : null, box: s.box, drawable: drawable(f, sc?.img) };
  });
  return {
    id: item.id, lens: { id: safe(item.lens, 12), name: lens ? safe(lens.name, 80) : null, definition: lens ? safe(lens.definition, 1200) : null },
    question: question ? safe(question, 400) : null, claim: safe(item.claim, 500),
    code: item.file ? { file: shownPath(item.file), line: Number.isInteger(item.line) ? item.line : null } : null,
    instances, scenes, label,
  };
}

export function lensTable(projectDir) {
  try { return Object.fromEntries(loadLenses({ root: projectDir }).lenses.map(l => [l.id, l])); } catch { return {}; }
}

export const labelsDir = (nunchiDir, labeller) => join(nunchiDir, 'labels', labeller);
// This labeller's labels: id → label. A file that is not a label is skipped here (the gate harness reads them strictly).
export function readLabels(nunchiDir, labeller) {
  const dir = labelsDir(nunchiDir, labeller);
  const out = new Map();
  if (!present(dir)) return out;
  if (lstatSync(dir).isSymbolicLink()) return out;
  for (const n of readdirSync(dir).sort()) {
    const m = /^([0-9a-f]{12})\.json$/.exec(n);
    if (!m) continue;
    try { const d = readJsonFile(join(dir, n), 'a label file', { max: 64 * 1024 }); if (d?.id === m[1] && LABEL_VALUES.has(d.label)) out.set(m[1], d.label); } catch {}
  }
  return out;
}

const isLabelsDoc = d => !!d && Array.isArray(d.labels) && d.labels.every(x => typeof x === 'string');
// Writes a label through the board (the human channel), then notes its content as made here.
export function writeLabel(nunchiDir, stateDir, { labeller, item, label, generation = null }) {
  if (!LABELLER.test(labeller)) throw Object.assign(new Error('a labeller name is lower-case letters, digits and -'), { code: 'BAD_ARGS' });
  if (!LABEL_VALUES.has(label)) throw Object.assign(new Error(`a label is one of ${[...LABEL_VALUES].join(', ')}`), { code: 'BAD_ARGS' });
  const rec = { schema: 1, id: item.id, lens: item.lens, rule: item.rule, label, labeller, channel: 'board', at: kst() };
  const text = stableJson(rec);
  writeAtomic(join(labelsDir(nunchiDir, labeller), `${item.id}.json`), text, { durable: true });
  updateDoc(join(stateDir, 'labels-approved.json'), doc => {
    const cur = doc || { schema: 1, labels: [] };
    const key = `${labeller}/${item.id}:${sha(text, 64)}`;
    if (cur.labels.includes(key)) return doc;
    return { schema: 1, note: 'labels written through the board on this machine (design §9.2), by labeller/id and content', labels: [...cur.labels, key].sort() };
  }, { read: { validate: isLabelsDoc, why: 'is not a nunchi label list', fix: 'delete it (labels are then shown as from git)' }, prev: false, generation });
  return rec;
}
export const readLabelApprovals = stateDir => new Set(readDoc(join(stateDir, 'labels-approved.json'), { validate: isLabelsDoc }).doc?.labels || []);
