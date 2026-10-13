// The engine side of the AI lenses (spec §4). The judgement itself happens in the plugin skill; the engine
//   - cuts a run into deterministic work units (1–3 scenes × 1 lens + one reference scene),
//   - estimates their token cost and applies the budget (cut units are listed, never dropped), and
//   - validates the hunter's answers: every checklist item answered, every defect grounded in the
//     scene's evidence (a selector it contains) or in the app's source (a file:line that exists).
// Answers and evidence are data: they are parsed and compared as strings, never evaluated.
import { readFileSync, existsSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { stableJson, sha, writeStable } from './stable.mjs';
import { lensHash, lensNumber, SEVERITIES } from './lenses.mjs';

// Token estimate (documented in spec §4):
//   text files   ceil(bytes / 4)  — chars/4 for ASCII; UTF-8 text with other scripts is over-estimated, never under
//   JPEG images  width × height / 750 after scaling to ≤1568 px on the long edge and ≤1.15 megapixels
//                (how Claude's vision input is sized); 1,600 when the size cannot be read
//   per unit     the lens text sent with it (definition, checklist, examples, rubric: bytes / 4)
//                + ANSWER_TOKENS per checklist item for the answer
export const ANSWER_TOKENS = 80;
export const IMAGE_TOKENS_MAX = 1600;
const STATE_ORDER = ['normal', 'error', 'empty', 'slow', 'offline'];
const PERSON_ORDER = ['guest', 'signed-in'];
const MAX_SCENES = 3;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };

export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

export function imageTokens(buf) {
  const size = jpegSize(buf);
  if (!size || !size.width || !size.height) return IMAGE_TOKENS_MAX;
  const { width: w, height: h } = size;
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1.15e6 / (w * h)));
  return Math.min(IMAGE_TOKENS_MAX, Math.ceil((Math.round(w * s) * Math.round(h * s)) / 750));
}

export function fileTokens(path) {
  if (path.endsWith('.jpg')) return imageTokens(readFileSync(path));
  return Math.ceil(statSync(path).size / 4);
}

const lensText = lens => stableJson({ definition: lens.definition, checklist: lens.checklist, examples: lens.examples, severityRubric: lens.severityRubric });
const matches = (filter, scene) => !filter
  || ((!filter.states || filter.states.includes(scene.state))
  && (!filter.viewports || filter.viewports.includes(scene.viewport))
  && (!filter.persons || filter.persons.includes(scene.person)));
const sceneRef = s => ({ scene: s.id, route: s.route, person: s.person, state: s.state, viewport: s.viewport });

export function readManifest(runDir) {
  const f = join(runDir, 'manifest.json');
  if (!existsSync(f)) throw Object.assign(new Error(`${runDir} has no manifest.json (not a capture run)`), { code: 'BAD_RUN' });
  return JSON.parse(readFileSync(f, 'utf8'));
}

// Scenes that can be hunted: captured, and showing their own route (a redirected scene shows another
// route's page, which is judged in that route's own scene, as the rule lenses do).
function huntable(entry) {
  if (entry.status !== 'captured') return { ok: false, reason: entry.reason || entry.status };
  if (entry.reason && /^redirected/.test(entry.reason)) return { ok: false, reason: 'redirected' };
  return { ok: true };
}

// The reference scene: another route of the same app, same person and viewport, preferably in the same
// state (how the app handles the same situation elsewhere), else normal. Chosen by a hash of the group,
// so references spread over the app and the same group always gets the same one.
function pickReference(group, scenes) {
  const first = group[0];
  const pool = scenes.filter(s => s.route !== first.route && s.person === first.person && s.viewport === first.viewport);
  const key = group.map(s => s.id).join('|');
  for (const state of [first.state, 'normal']) {
    const c = pool.filter(s => s.state === state);
    if (c.length) return c.map(s => ({ s, h: sha(`${key}|${s.id}`) })).sort((a, b) => cmp(a.h, b.h) || cmp(a.s.id, b.s.id))[0].s;
  }
  return null;
}

// Source slices (spec §4): a lens with `source: true` gets, in each unit, the part of the run's inventory.json
// (§2.4) whose files render the unit's route: strings, UI states, destructive actions and native dialogs with
// file:line, plus the no-AI candidates on those files (hints, never findings). One file per route,
// hunt/source/<first 12 hex of sha256(route)>.json, written on first use. No inventory.json, or a route no
// inventory file renders → no slice. The inventory is data: it is parsed and copied, never evaluated.
const SLICE_KEYS = ['strings', 'states', 'actions', 'dialogs'];
function sourceSlices(runDir) {
  let inv;
  const made = new Map();
  return route => {
    if (made.has(route)) return made.get(route);
    if (inv === undefined) { try { inv = JSON.parse(readFileSync(join(runDir, 'inventory.json'), 'utf8')); } catch { inv = null; } }
    const list = k => (Array.isArray(inv?.[k]) ? inv[k] : []).filter(isObj);
    const files = list('files').filter(f => typeof f.file === 'string' && Array.isArray(f.routes) && f.routes.includes(route)).sort((a, b) => cmp(a.file, b.file));
    let rel = null;
    if (files.length) {
      const names = new Set(files.map(f => f.file));
      const placesOf = c => [c.file, ...(Array.isArray(c.copies) ? c.copies : []).map(x => x?.file), ...(Array.isArray(c.variants) ? c.variants : []).flatMap(v => (Array.isArray(v?.occurrences) ? v.occurrences : []).map(o => o?.file))];
      rel = `hunt/source/${sha(route, 12)}.json`;
      writeStable(join(runDir, rel), {
        schema: 1, route, note: 'source strings and states with file:line; candidates are hints for the AI lenses, never findings by themselves',
        files: files.map(f => ({ file: f.file, ...Object.fromEntries(SLICE_KEYS.map(k => [k, Array.isArray(f[k]) ? f[k] : []])) })),
        candidates: list('candidates').filter(c => placesOf(c).some(f => names.has(f))),
      });
    }
    made.set(route, rel);
    return rel;
  };
}

export function planHunt({ runDir, lenses, lensIds = null, budget = null, runId = null }) {
  const manifest = readManifest(runDir);
  const wanted = lensIds ? lenses.filter(l => lensIds.includes(l.id)) : lenses;
  if (lensIds) {
    const unknown = lensIds.filter(id => !lenses.some(l => l.id === id));
    if (unknown.length) throw Object.assign(new Error(`unknown lens(es): ${unknown.join(', ')} (loaded: ${lenses.map(l => l.id).join(', ')})`), { code: 'BAD_ARGS' });
  }
  const ai = wanted.filter(l => l.method === 'ai');
  const entries = manifest.scenes.slice().sort((a, b) => cmp(a.id, b.id));
  const scenes = entries.filter(e => huntable(e).ok);
  const units = []; const notSeen = [];
  const sliceOf = sourceSlices(runDir);
  for (const lens of ai) {
    const hash = lensHash(lens);
    const promptTokens = Math.ceil(Buffer.byteLength(lensText(lens)) / 4);
    for (const e of entries) {
      const h = huntable(e);
      if (!h.ok && matches(lens.scenes, e)) notSeen.push({ lens: lens.id, scene: e.id, reason: h.reason });
    }
    const groups = new Map();
    for (const s of scenes.filter(s => matches(lens.scenes, s))) {
      const k = `${s.route}\0${s.person}\0${s.state}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const all of groups.values()) {
      all.sort((a, b) => cmp(a.viewport, b.viewport));
      for (let i = 0; i < all.length; i += MAX_SCENES) {
        const group = all.slice(i, i + MAX_SCENES);
        const checklist = lens.checklist.filter(item => group.some(s => matches(item.scenes, s))).map(item => {
          const applies = group.filter(s => matches(item.scenes, s)).map(s => s.id);
          return { id: item.id, question: item.question, ...(applies.length < group.length ? { scenes: applies } : {}) };
        });
        if (!checklist.length) continue;
        const reference = pickReference(group, scenes);
        // The scene under review goes last (spec §4): reference files first, then the reviewed scenes.
        const files = []; const missing = [];
        const add = (s, names) => { for (const n of names) { const p = `${s.id}/${n}`; (existsSync(join(runDir, s.id, n)) ? files : missing).push(p); } };
        if (reference) add(reference, [...new Set(lens.evidence.map(n => (n === 'full.jpg' ? 'top.jpg' : n)))]);
        const slice = lens.source ? sliceOf(group[0].route) : null;   // the route's source, before the scenes under review
        if (slice) files.push(slice);
        for (const s of group) add(s, lens.evidence);
        const tokens = files.reduce((n, p) => n + fileTokens(join(runDir, p)), 0) + promptTokens + ANSWER_TOKENS * checklist.length * group.length;
        const id = sha(stableJson({ lens: lens.id, hash, scenes: group.map(s => s.id), reference: reference?.id ?? null, items: checklist.map(c => c.id) }), 12);
        units.push({
          id, lens: lens.id, scenes: group.map(sceneRef), reference: reference ? sceneRef(reference) : null,
          checklist, files, ...(missing.length ? { missing } : {}), tokens,
        });
      }
    }
  }
  // Order the budget is spent in: normal screens first, then error, empty, slow, offline; by route, guest
  // before signed-in, then lens. A small budget covers every lens on the main screens before going deeper.
  const key = u => [rank(STATE_ORDER, u.scenes[0].state), u.scenes[0].route, rank(PERSON_ORDER, u.scenes[0].person), lensNumber(u.lens), u.scenes[0].scene];
  units.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) { const c = typeof x[i] === 'number' ? x[i] - y[i] : cmp(x[i], y[i]); if (c) return c; } return 0; });
  let spent = 0; let cut = false;
  for (const u of units) {
    if (!cut && budget != null && spent + u.tokens > budget) cut = true;
    if (cut) { u.status = 'not-seen'; u.reason = 'budget'; } else { u.status = 'planned'; spent += u.tokens; }
  }
  const total = units.reduce((n, u) => n + u.tokens, 0);
  notSeen.sort((a, b) => lensNumber(a.lens) - lensNumber(b.lens) || cmp(a.scene, b.scene));
  const plan = {
    schema: 1,
    run: runId,
    health: manifest.health?.status ?? null,
    budget: budget ?? null,
    estimate: {
      method: `text: bytes/4; JPEG: width*height/750 after scaling to <=1568px long edge and <=1.15MP (max ${IMAGE_TOKENS_MAX}); per unit: lens text bytes/4 + ${ANSWER_TOKENS} per checklist item per scene`,
      total, planned: spent, cut: total - spent,
      units: { total: units.length, planned: units.filter(u => u.status === 'planned').length, cut: units.filter(u => u.status !== 'planned').length },
    },
    lenses: ai.map(l => ({ ...l, hash: lensHash(l) })),
    skippedLenses: wanted.filter(l => l.method !== 'ai').map(l => ({ lens: l.id, reason: `method ${l.method}: judged by the engine, not hunted` })),
    units,
    notSeen,
  };
  plan.id = sha(stableJson(plan), 12);
  return plan;
}

// ---------- recording answers ----------

const ANSWERS = ['defect', 'none', 'cannot-judge'];
const UNIT_KEYS = ['unit', 'items'];
const ITEM_KEYS = ['answer', 'reason', 'defects'];
const DEFECT_KEYS = ['scene', 'selector', 'source', 'claim', 'severity'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (v, n = 200) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : undefined);

// Where a scene's selectors live. Exact string match: the hunter copies a selector from the evidence.
function sceneIndex(runDir, sceneId) {
  const read = (n, fallback) => { try { return JSON.parse(readFileSync(join(runDir, sceneId, n), 'utf8')); } catch { return fallback; } };
  const idx = new Map();
  // First file wins, except that an entry with a box (controls, measure) replaces one without (styles, links).
  const put = (file, rows) => {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.selector !== 'string') continue;
      const box = Array.isArray(r.box) ? r.box : null;
      const had = idx.get(r.selector);
      if (!had || (!had.box && box)) idx.set(r.selector, { file, box, inside: typeof r.inside === 'string' ? r.inside : null });
    }
  };
  put('controls.json', read('controls.json', []));
  put('styles.json', read('styles.json', []));
  put('links.json', read('links.json', []));
  const m = read('measure.json', {});
  for (const k of ['clipped', 'images', 'scrollers', 'hiddenControls']) put('measure.json', m[k]);
  // aria.yml nodes are addressed as `aria=<the node line without "- ">`, e.g. aria=button "Delete garden"
  let aria = '';
  try { aria = readFileSync(join(runDir, sceneId, 'aria.yml'), 'utf8'); } catch {}
  const ariaNodes = new Set();
  for (const line of aria.split('\n')) {
    const m2 = /^\s*-\s+(.*?):?\s*$/.exec(line);
    if (m2 && m2[1]) ariaNodes.add(m2[1]);
  }
  return { idx, ariaNodes };
}

// A file:line under the app root. Not nunchi's own folder, not dependencies; symlinks must stay inside.
function checkSource(root, source, cache) {
  const m = /^(.+):(\d+)$/.exec(source);
  if (!m) return { error: 'source must look like path/to/file.tsx:42' };
  const rel = m[1].replace(/\\/g, '/'); const line = Number(m[2]);
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return { error: 'source path must be relative to the app root' };
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (!r || r.startsWith('..') || isAbsolute(r)) return { error: 'source path is outside the app root' };
  const parts = r.split(sep);
  if (parts.includes('.nunchi') || parts.includes('node_modules') || parts.includes('.git')) return { error: 'source must be the app\'s own source (not .nunchi, node_modules or .git)' };
  if (!cache.has(abs)) {
    let lines = null;
    try {
      const real = realpathSync(abs); const rr = relative(realpathSync(root), real);
      if (statSync(real).isFile() && rr && !rr.startsWith('..') && !isAbsolute(rr)) lines = readFileSync(real, 'utf8').split('\n').length;
    } catch {}
    cache.set(abs, lines);
  }
  const lines = cache.get(abs);
  if (lines == null) return { error: 'source file not found under the app root' };
  if (line < 1 || line > lines) return { error: `line ${line} is outside the file (1–${lines})` };
  return { file: r.split(sep).join('/'), line };
}

// answers: one object {schema?, plan?, units: [{unit, items: {<item id>: {answer, reason?, defects?}}}]} or a
// list of them (several answer files). Returns {findings, rejected, coverage}.
export function recordHunt({ runDir, plan, answers, root }) {
  const docs = Array.isArray(answers) ? answers : [answers];
  const rejected = [];
  const reject = (r) => rejected.push(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
  const given = [];
  for (const [d, doc] of docs.entries()) {
    if (!isObj(doc) || !Array.isArray(doc.units)) { reject({ reason: 'bad-shape', detail: `answers file ${d + 1}: expected {"units": [...]}` }); continue; }
    if (doc.plan !== undefined && doc.plan !== plan.id) throw Object.assign(new Error(`these answers are for plan ${doc.plan}, but the run's hunt-plan.json is plan ${plan.id}. Run hunt --plan again and answer its units.`), { code: 'STALE_ANSWERS' });
    for (const u of doc.units) given.push(u);
  }
  const unitsById = new Map(plan.units.map(u => [u.id, u]));
  const counts = new Map();
  for (const u of given) if (isObj(u) && typeof u.unit === 'string') counts.set(u.unit, (counts.get(u.unit) || 0) + 1);
  const answered = new Map();
  for (const u of given) {
    if (!isObj(u) || typeof u.unit !== 'string' || !isObj(u.items)) { reject({ reason: 'bad-shape', detail: 'a unit answer is {"unit": "<id>", "items": {...}}' }); continue; }
    const extra = Object.keys(u).filter(k => !UNIT_KEYS.includes(k));
    if (extra.length) { reject({ unit: u.unit, reason: 'bad-shape', detail: `unknown key(s) ${extra.sort().join(', ')}` }); continue; }
    if (!unitsById.has(u.unit)) { reject({ unit: u.unit, reason: 'unknown-unit' }); continue; }
    if (counts.get(u.unit) > 1) { reject({ unit: u.unit, reason: 'duplicate-unit', detail: 'answered more than once; none of its answers were used' }); continue; }
    answered.set(u.unit, u);
  }

  const findings = [];
  const indexes = new Map();
  const srcCache = new Map();
  const cells = [];
  const ok = new Map();
  for (const unit of plan.units) {
    const a = answered.get(unit.id);
    const tally = { defect: 0, none: 0, 'cannot-judge': 0 };
    const missing = [];
    if (a) {
      const itemIds = new Set(unit.checklist.map(c => c.id));
      for (const k of Object.keys(a.items).sort(cmp)) if (!itemIds.has(k)) reject({ unit: unit.id, item: k, reason: 'unknown-item' });
      for (const item of unit.checklist) {
        const ans = a.items[item.id];
        if (ans === undefined) { missing.push(item.id); continue; }
        const bad = detail => { reject({ unit: unit.id, item: item.id, reason: 'bad-answer', detail }); missing.push(item.id); };
        if (!isObj(ans)) { bad('an item answer is {"answer": "defect" | "none" | "cannot-judge", ...}'); continue; }
        const extra = Object.keys(ans).filter(k => !ITEM_KEYS.includes(k));
        if (extra.length) { bad(`unknown key(s) ${extra.sort().join(', ')}`); continue; }
        if (!ANSWERS.includes(ans.answer)) { bad(`answer must be one of ${ANSWERS.join(', ')}`); continue; }
        if (ans.reason !== undefined && typeof ans.reason !== 'string') { bad('reason must be text'); continue; }
        if (ans.answer !== 'defect') {
          if (ans.defects !== undefined && (!Array.isArray(ans.defects) || ans.defects.length)) { bad(`"${ans.answer}" cannot carry defects`); continue; }
          tally[ans.answer]++; continue;
        }
        if (!Array.isArray(ans.defects) || !ans.defects.length) { bad('a defect answer lists at least one defect'); continue; }
        const applies = item.scenes || unit.scenes.map(s => s.scene);
        const kept = new Map();
        for (const d of ans.defects) {
          const r = { unit: unit.id, item: item.id, scene: isObj(d) && typeof d.scene === 'string' ? d.scene : undefined, claim: isObj(d) ? clip(d.claim) : undefined };
          if (!isObj(d)) { reject({ ...r, reason: 'bad-shape', detail: 'a defect is {"scene", "selector" and/or "source", "claim", "severity"}' }); continue; }
          const extraD = Object.keys(d).filter(k => !DEFECT_KEYS.includes(k));
          if (extraD.length) { reject({ ...r, reason: 'bad-shape', detail: `unknown key(s) ${extraD.sort().join(', ')}` }); continue; }
          const scene = unit.scenes.find(s => s.scene === d.scene);
          if (!scene) { reject({ ...r, reason: 'scene-not-under-review', detail: `the unit reviews ${unit.scenes.map(s => s.scene).join(', ')}` }); continue; }
          if (!applies.includes(scene.scene)) { reject({ ...r, reason: 'item-not-for-scene' }); continue; }
          if (typeof d.claim !== 'string' || !d.claim.trim() || d.claim.length > 500) { reject({ ...r, reason: 'bad-claim', detail: 'a short claim (1–500 characters) is required' }); continue; }
          if (!SEVERITIES.includes(d.severity)) { reject({ ...r, reason: 'bad-severity', detail: `one of ${SEVERITIES.join(', ')}` }); continue; }
          const hasSel = d.selector !== undefined && d.selector !== null; const hasSrc = d.source !== undefined && d.source !== null;
          if (!hasSel && !hasSrc) { reject({ ...r, reason: 'ungrounded', detail: 'no selector and no file:line: image-only claims are not findings' }); continue; }
          let where = null; let box = null; let inside = null; let selector = null;
          if (hasSel) {
            if (typeof d.selector !== 'string' || !d.selector.trim()) { reject({ ...r, reason: 'selector-not-in-evidence', detail: 'selector must be text' }); continue; }
            if (!indexes.has(scene.scene)) indexes.set(scene.scene, sceneIndex(runDir, scene.scene));
            const { idx, ariaNodes } = indexes.get(scene.scene);
            selector = d.selector.trim();
            if (selector.startsWith('aria=')) {
              if (!ariaNodes.has(selector.slice(5).trim())) { reject({ ...r, reason: 'selector-not-in-evidence', detail: `${clip(selector, 120)} is not a node of ${scene.scene}/aria.yml` }); continue; }
              where = 'aria.yml';
            } else {
              const hit = idx.get(selector);
              if (!hit) { reject({ ...r, reason: 'selector-not-in-evidence', detail: `${clip(selector, 120)} is not in ${scene.scene}'s controls.json, styles.json, links.json or measure.json` }); continue; }
              where = hit.file; box = hit.box; inside = hit.inside;
            }
          }
          let src = null;
          if (hasSrc) {
            src = typeof d.source === 'string' ? checkSource(root, d.source.trim(), srcCache) : { error: 'source must be text' };
            if (src.error) { reject({ ...r, reason: 'source-not-found', detail: src.error }); continue; }
          }
          const f = {
            lens: unit.lens, rule: item.id, severity: d.severity, scene: scene.scene, route: scene.route, viewport: scene.viewport,
            selector, box, ...(inside ? { inside } : {}),
            evidence: { claim: d.claim.trim(), unit: unit.id, groundedIn: [where, src ? 'source' : null].filter(Boolean), ...(src ? { file: src.file, line: src.line } : {}) },
            source: 'ai', status: 'claimed',
          };
          const dk = stableJson([f.rule, f.scene, f.selector, src ? `${src.file}:${src.line}` : null]);
          const prev = kept.get(dk);
          if (prev) {
            const [keep, drop] = cmp(stableJson(prev), stableJson(f)) <= 0 ? [prev, f] : [f, prev];
            kept.set(dk, keep);
            reject({ unit: unit.id, item: item.id, scene: drop.scene, claim: clip(drop.evidence.claim), reason: 'duplicate-defect' });
          } else kept.set(dk, f);
        }
        if (!kept.size) { missing.push(item.id); continue; }
        findings.push(...kept.values());
        tally.defect++;
      }
    }
    const seen = !!a && !missing.length;
    ok.set(unit.id, seen);
    const reason = seen ? null : !a ? (unit.status === 'not-seen' ? unit.reason : 'not-answered') : 'incomplete';
    for (const s of unit.scenes) {
      cells.push({
        lens: unit.lens, scene: s.scene, route: s.route, person: s.person, state: s.state, viewport: s.viewport, unit: unit.id,
        status: seen ? 'seen' : 'not-seen', ...(reason ? { reason } : {}), ...(missing.length ? { missing: missing.slice().sort(cmp) } : {}),
        ...(a ? { answers: tally } : {}),
      });
    }
  }
  for (const n of plan.notSeen) cells.push({ lens: n.lens, scene: n.scene, status: 'not-seen', reason: n.reason });
  cells.sort((a, b) => lensNumber(a.lens) - lensNumber(b.lens) || cmp(a.scene, b.scene));
  const order = { blocker: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || cmp(a.scene, b.scene) || cmp(a.rule, b.rule) || cmp(String(a.selector), String(b.selector)) || cmp(stableJson(a), stableJson(b)));
  rejected.sort((a, b) => cmp(stableJson([a.unit ?? '', a.item ?? '', a.scene ?? '', a.reason, a.detail ?? '', a.claim ?? '']), stableJson([b.unit ?? '', b.item ?? '', b.scene ?? '', b.reason, b.detail ?? '', b.claim ?? ''])));
  const byReason = {};
  for (const c of cells) if (c.status !== 'seen') byReason[c.reason] = (byReason[c.reason] || 0) + 1;
  const coverage = {
    schema: 1, plan: plan.id, run: plan.run,
    summary: { cells: cells.length, seen: cells.filter(c => c.status === 'seen').length, notSeen: byReason, units: { total: plan.units.length, seen: [...ok.values()].filter(Boolean).length } },
    cells,
  };
  return { findings, rejected, coverage };
}

export function writeRecord(runDir, { findings, rejected, coverage }) {
  writeStable(join(runDir, 'ai-findings.json'), { schema: 1, plan: coverage.plan, findings, rejected });
  writeStable(join(runDir, 'coverage.json'), coverage);
}

// --record takes one answers file or a folder of them (read in name order).
export function readAnswers(path) {
  const parse = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw Object.assign(new Error(`${f}: not JSON (${e.message})`), { code: 'BAD_ANSWERS' }); } };
  if (statSync(path).isDirectory()) return readdirSync(path).filter(n => n.endsWith('.json')).sort(cmp).map(n => parse(join(path, n)));
  return [parse(path)];
}

export function formatPlan(plan, planPath) {
  const L = [];
  const e = plan.estimate;
  L.push(`hunt plan ${plan.id}${plan.run ? ` for run ${plan.run}` : ''}: ${e.units.total} work units over ${plan.lenses.length} lens(es), estimated ${e.total} tokens`);
  if (plan.health && plan.health !== 'ok') L.push(`RUN PROBLEM ${plan.health}: affected scenes are listed as not seen`);
  if (plan.budget != null) L.push(`budget ${plan.budget} tokens: ${e.units.planned} unit(s) planned (${e.planned} tokens), ${e.units.cut} not seen: budget (${e.cut} tokens)`);
  for (const lens of plan.lenses) {
    const us = plan.units.filter(u => u.lens === lens.id);
    const cut = us.filter(u => u.status !== 'planned').length;
    L.push(`  ${lens.id.padEnd(4)} ${lens.name.padEnd(44)} ${String(us.length).padStart(4)} units ${String(us.reduce((n, u) => n + u.tokens, 0)).padStart(9)} tokens${cut ? `  (${cut} cut by budget)` : ''}`);
  }
  for (const s of plan.skippedLenses) L.push(`  ${s.lens.padEnd(4)} not hunted (${s.reason})`);
  const ns = {};
  for (const n of plan.notSeen) ns[n.reason] = (ns[n.reason] || 0) + 1;
  for (const [r, n] of Object.entries(ns).sort()) L.push(`  not seen: ${r} — ${n} scene × lens cell(s)`);
  L.push(`estimate: ${e.method}`);
  if (planPath) L.push(`plan written to ${planPath}`);
  return L.join('\n');
}

export function formatRecord({ findings, rejected, coverage }, runDir) {
  const L = [];
  const s = coverage.summary;
  const by = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) by[f.severity]++;
  L.push(`recorded plan ${coverage.plan}: ${s.units.seen}/${s.units.total} work units seen, ${s.seen}/${s.cells} scene × lens cells`);
  L.push(`AI findings (claimed, not verified): blocker ${by.blocker} · high ${by.high} · medium ${by.medium} · low ${by.low}`);
  for (const [r, n] of Object.entries(s.notSeen).sort()) L.push(`  not seen: ${r} — ${n} cell(s)`);
  if (rejected.length) {
    const rs = {};
    for (const r of rejected) rs[r.reason] = (rs[r.reason] || 0) + 1;
    L.push(`rejected: ${rejected.length} (${Object.entries(rs).sort().map(([k, v]) => `${k} ${v}`).join(' · ')}) — see "rejected" in ai-findings.json`);
  }
  if (runDir) L.push(`written: ${join(runDir, 'ai-findings.json')}, ${join(runDir, 'coverage.json')}`);
  return L.join('\n');
}
