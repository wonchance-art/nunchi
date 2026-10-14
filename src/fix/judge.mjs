// Judging one fix attempt (design 0.1-c §4.5): what the probes P0 (before) and P1 (after) say, by precedence.
// Pure functions: the loop (loop.mjs) gathers the runs, the re-captures of flaky rules, the drift measurements and the
// re-check verdicts, and this decides. An outcome comes only from here, never from the agent.
//
// | 1 | inconclusive → needs you (c) | a scene failed or redirected, a health problem, replay misses, no proof of the served code |
// | 2 | caused-regression            | a new defect by element identity in a cell of P0's scope (flaky rules re-checked)         |
// | 3 | not-fixed                    | the defect is matched in any cell (an AI item: a re-check said still there)              |
// | 4 | visual drift → needs you (a) | outside the finding's boxes, neighbouring geometry or PNG pixels changed                 |
// | 5 | fixed                        | none of the above; an AI item needs a non-suspect re-check from a fresh context          |
//
// "Same defect, not same fingerprint": a wrapper <div> changes selector paths, so a defect is matched by
// (rule, cell, element identity), where the identity is the normalised selector, or the same tag and accessible name
// with boxes overlapping (IoU) ≥ 0.5 (or the same fingerprint).
import { normalizeSelector, looked } from '../ledger.mjs';

export const FLAKY = new Set(['layout-shift', 'font-not-loaded', 'page-error']);
export const IOU_MIN = 0.5;
// Visual drift (design §4.5 row 4): the share of first-view pixels outside the finding's boxes that may differ before
// a fix counts as changing other parts of the screen. The gate (§9.4) calibrates it; until then it is this.
export const DRIFT_PIXELS = 0.01;
export const MOVE_PX = 2;
export const MAX_ATTEMPTS = 2;

const cellOf = s => `${s.person}.${s.state}.${s.viewport}`;
const str = v => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : null);
// the tag of a selector's last compound (`main > a.more` → a)
const tagOfSelector = sel => { const m = /(?:^|[\s>+~])([a-z][a-z0-9-]*)(?=[^\s>+~]*$)/i.exec(String(sel || '').trim()); return m ? m[1].toLowerCase() : null; };
export function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h, union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

// A finding's identity in its scene. `controls`: the scene's controls.json rows (for the tag, name and box of the
// element the selector names).
export function identityOf(f, scene, controls = []) {
  const row = typeof f.selector === 'string' ? (controls || []).find(c => c && c.selector === f.selector) : null;
  const ev = f.evidence && typeof f.evidence === 'object' ? f.evidence : {};
  return {
    fp: f.fp ?? null, rule: f.rule, route: scene?.route ?? f.route ?? null, cell: scene ? cellOf(scene) : null,
    norm: normalizeSelector(f.selector), tag: (row && typeof row.tag === 'string' ? row.tag.toLowerCase() : null) || tagOfSelector(f.selector),
    name: str(row?.name) || str(ev.name) || str(ev.text) || null, box: Array.isArray(f.box) ? f.box : Array.isArray(row?.box) ? row.box : null,
  };
}
export function sameDefect(a, b) {
  if (a.rule !== b.rule || a.route !== b.route || a.cell !== b.cell) return false;
  if (a.fp && a.fp === b.fp) return true;
  // positions are normalised away, so two named siblings (`footer > a` Privacy and Terms) share a selector: their
  // names tell them apart (found by the fix-gate harness on Pebble, 2026-10-15 KST)
  if (a.norm && a.norm === b.norm && !(a.name && b.name && a.name !== b.name)) return true;
  return !!a.tag && a.tag === b.tag && !!a.name && a.name === b.name && iou(a.box, b.box) >= IOU_MIN;
}
// A defect another group had before the fix, seen again after it (M3 review, round 2): the same rule and cell, and the
// same element by one of — its normalised selector (renamed, moved by padding); its accessible name (the same tag, or
// a tag unknown); or a wrapper the fix inserted (the old selector's steps are a subsequence of the new one's, ending on
// the same step). Never by tag and overlap alone: a button.delete where a button.close was is another element.
const steps = norm => String(norm || '').split(/\s*[>+~]\s*|\s+/).filter(Boolean);
export function wrapped(oldNorm, newNorm) {
  const a = steps(oldNorm), b = steps(newNorm);
  if (!a.length || b.length <= a.length || a[a.length - 1] !== b[b.length - 1]) return false;
  let i = 0;
  for (const s of b) if (s === a[i]) i++;
  return i === a.length;
}
export function sameOldDefect(o, x) {
  if (sameDefect(o, x)) return true;
  if (o.rule !== x.rule || o.route !== x.route || o.cell !== x.cell) return false;
  if (o.norm && o.norm === x.norm) return true;
  if (o.name && x.name && o.name === x.name && (!o.tag || !x.tag || o.tag === x.tag)) return true;
  return wrapped(o.norm, x.norm);
}
// Whether a flaky rule's finding came back on its scene's second look (`again(sceneId)`: findings, null when the second
// look did not see the screen, undefined when it was not captured again): true, false, or null (nothing can be said).
export const cameBack = again => f => { const a = again(f.scene); return a === undefined ? true : a === null ? null : a.some(x => x.rule === f.rule && (x.fp === f.fp || (!!f.selector && x.selector === f.selector))); };

// One probe as the judge reads it: its scenes (by route|cell) and its findings with identities. `controlsOf(scene)`:
// that scene's controls.json rows.
export function probeView({ manifest, findings }, controlsOf = () => []) {
  const scenes = (Array.isArray(manifest?.scenes) ? manifest.scenes : []).filter(s => s && typeof s.id === 'string' && s.canary === undefined);
  const byId = new Map(scenes.map(s => [s.id, s]));
  const looks = new Map();
  for (const s of scenes) if (looked(s)) looks.set(`${s.route}|${cellOf(s)}`, s);
  const all = (Array.isArray(findings) ? findings : []).filter(f => f && f.source !== 'ai' && f.scene && byId.has(f.scene) && looked(byId.get(f.scene)))
    .map(f => ({ f, id: identityOf(f, byId.get(f.scene), controlsOf(f.scene)) }));
  const misses = scenes.reduce((n, s) => n + (Number(s.replayMisses) || 0), 0);
  const problems = (Array.isArray(manifest?.health?.problems) ? manifest.health.problems : []).map(p => String(p.status));
  return { scenes, looks, all, misses, problems, controlsOf };
}

// What makes a probe unusable as a baseline (P0): a screen it did not capture (failed, redirected, an error page), a
// health problem, replay misses. → reasons (empty when it is usable).
export function probeProblems(v) {
  const out = [];
  for (const p of v.problems) if (['app-unreachable', 'login-expired', 'recording-stale'].includes(p)) out.push({ why: p, text: { 'app-unreachable': 'the screens did not load', 'login-expired': 'the saved login no longer works', 'recording-stale': 'the recording no longer answers these screens' }[p] });
  if (v.misses) out.push({ why: 'replay-miss', text: `${v.misses} request(s) were not in the recording (never sent live)` });
  const lost = v.scenes.filter(s => !looked(s));
  if (lost.length) out.push({ why: 'scene-failed', text: `${lost.length} screen(s) did not load or were redirected`, cells: lost.map(s => s.id).sort() });
  return out;
}

// The rule part of the verdict, and what is left for the AI re-check.
// - group: { rule: [{ fp, rule, route, cells }], ai: [{ fp, route, cells }] } (the group's ledger rows, not fixed);
// - p0, p1: probeView() of the two probes; scope0: the route|cell keys P0 looked at;
// - known: fingerprints the ledger already holds (open), for routes P1 added (no baseline there);
// - again(sceneId): P1 scenes captured once more (flaky rules, design §4.5): their findings, null when the second look
//   did not see the screen, undefined when not captured again. flakyConfirmed(f) (derived from it unless given): a
//   flaky rule's finding came back (true/false), or null (inconclusive: nothing can be said);
// - proof: the served code was shown to be the commit's (design §4.4); drift: { share, moved, scenes } or null.
// → { outcome, reason, … } with outcome one of inconclusive | regression | not-fixed | unbaselined | drift | fixed |
//   recheck (rule items gone, AI items wait for the re-check).
export function judgeRules({ group, p0, p1, known = new Set(), again = () => undefined, flakyConfirmed = cameBack(again), proof = true, drift = null }) {
  // 1. inconclusive
  const bad = [];
  if (!proof) bad.push({ why: 'no-proof', text: 'nothing showed the app at --url serves this commit' });
  for (const p of p1.problems) if (['app-unreachable', 'login-expired', 'recording-stale'].includes(p)) bad.push({ why: p, text: { 'app-unreachable': 'the screens did not load', 'login-expired': 'the saved login no longer works', 'recording-stale': 'the recording no longer answers these screens' }[p] });
  if (p1.misses) bad.push({ why: 'replay-miss', text: `${p1.misses} request(s) were not in the recording (never sent live)` });
  const lost = [...p0.looks.keys()].filter(k => !p1.looks.has(k)).sort();
  const groupCells = [...group.rule, ...group.ai].flatMap(it => (it.cells || []).map(c => `${it.route}|${c}`));
  const lostGroup = [...new Set(groupCells)].filter(k => !p1.looks.has(k)).sort();
  // a screen of P1 itself that did not load (a route only P1 has, the fix may have broken it): nothing is judged there
  const lostP1 = p1.scenes.filter(s => !looked(s)).map(s => `${s.route}|${cellOf(s)}`);
  const lostAll = [...new Set([...lost, ...lostGroup, ...lostP1])].sort();
  if (lostAll.length) bad.push({ why: 'scene-failed', text: `${lostAll.length} screen(s) did not load or were redirected`, cells: lostAll, routes: [...new Set(lostAll.map(k => k.split('|')[0]))].sort(), before: lostAll.filter(k => p0.looks.has(k)) });
  if (bad.length) return { outcome: 'inconclusive', needsYou: 'c', reasons: bad };
  // 2. caused-regression: a new defect in a cell P0 looked at (flaky rules count only when they came back)
  const mine = new Set(group.rule.map(i => i.fp));
  const before = k => p0.all.filter(x => `${x.id.route}|${x.id.cell}` === k);
  const isGroups = x => mine.has(x.f.fp) || group.rule.some(it => p0.all.some(o => o.f.fp === it.fp && sameDefect(o.id, x.id)));
  const regressions = [], unbaselined = [], unsure = [];
  const fresh = new Map();                                   // route|cell → P1 findings with no match before the fix
  for (const x of p1.all) {
    if (isGroups(x)) continue;
    const k = `${x.id.route}|${x.id.cell}`;
    if (p0.looks.has(k)) {
      if (before(k).some(o => sameOldDefect(o.id, x.id))) continue;
      if (FLAKY.has(x.f.rule)) { const back = flakyConfirmed(x.f); if (back === null) { unsure.push(x.f.scene); continue; } if (!back) continue; }
      if (!fresh.has(k)) fresh.set(k, []);
      fresh.get(k).push(x);
    } else if (!known.has(x.f.fp)) unbaselined.push(x.f);
  }
  // the last resort: an old defect whose element is still on the screen after the fix (by its selector or its name)
  // but whose finding no element test matched; per cell and rule, as many new findings as such old ones are the old
  // ones moved. An old element that is gone from the screen pairs with nothing: what appeared is new.
  const stillThere = (o, k) => {
    const s = p1.looks.get(k);
    const rows = s && typeof p1.controlsOf === 'function' ? p1.controlsOf(s.id) || [] : [];
    return rows.some(c => c && ((o.id.norm && normalizeSelector(c.selector) === o.id.norm) || (o.id.name && typeof c.name === 'string' && c.name.replace(/\s+/g, ' ').trim() === o.id.name)));
  };
  for (const [k, xs] of fresh) {
    const gone = before(k).filter(o => !isGroups(o) && !p1.all.some(x => sameOldDefect(o.id, x.id)) && stillThere(o, k));
    const left = new Map();
    for (const o of gone) left.set(o.f.rule, (left.get(o.f.rule) || 0) + 1);
    for (const x of xs) { const n = left.get(x.f.rule) || 0; if (n > 0) left.set(x.f.rule, n - 1); else regressions.push(x.f); }
  }
  if (unsure.length) return { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'recapture-failed', text: `${new Set(unsure).size} screen(s) captured again for a flaky rule did not load`, cells: [...new Set(unsure)].sort() }] };
  if (regressions.length) return { outcome: 'regression', regressions: regressions.map(brief) };
  // 3. not-fixed: the defect matched in any cell P1 looked at, not only the cells the ledger lists (a sweep of one
  // viewport, a fix that moves the defect to another cell): its fingerprint anywhere, or the same element where P0 had it.
  // A flaky rule's defect that P1 shows gone is captured once more before it counts as gone (design §4.5).
  const still = [], unsureOwn = [];
  for (const it of group.rule) {
    const was = p0.all.filter(o => o.f.fp === it.fp);
    const hit = p1.all.find(x => x.f.rule === it.rule && (x.f.fp === it.fp || was.some(o => sameDefect(o.id, x.id))));
    if (hit) { still.push({ fp: it.fp, ...brief(hit.f) }); continue; }
    if (!FLAKY.has(it.rule)) continue;
    for (const o of was) {
      const s = p1.looks.get(`${o.id.route}|${o.id.cell}`);
      const back = s ? cameBack(again)({ ...o.f, scene: s.id }) : true;
      if (back === null) unsureOwn.push(s.id);
      else if (back && again(s.id) !== undefined) { still.push({ fp: it.fp, ...brief({ ...o.f, scene: s.id }) }); break; }
    }
  }
  if (still.length) return { outcome: 'not-fixed', still };
  if (unsureOwn.length) return { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'recapture-failed', text: `${new Set(unsureOwn).size} screen(s) captured again for a flaky rule did not load`, cells: [...new Set(unsureOwn)].sort() }] };
  // 4. what only a person can judge: a new finding on a route P1 added (no baseline), or visual drift
  const driftHit = drift && (drift.share > DRIFT_PIXELS || drift.moved > 0);
  if (group.ai.length) return { outcome: 'recheck', pending: { unbaselined: unbaselined.map(brief), drift: driftHit ? drift : null } };
  if (unbaselined.length) return { outcome: 'unbaselined', needsYou: 'a', unbaselined: unbaselined.map(brief), defectGone: true };
  if (driftHit) return { outcome: 'drift', needsYou: 'a', drift, defectGone: true };
  return { outcome: 'fixed' };
}
const brief = f => ({ rule: f.rule, scene: f.scene ?? null, route: f.route ?? null, selector: f.selector ?? null, fp: f.fp ?? null });

// The AI part (design §4.5 row 5, §2.4): the re-check of the group's AI items on P1, from a fresh context. `recheck`:
// recheck.mjs recordRecheck's result ({ suspect, suspectReason, results: [{ fp, cells: { cell: { verdict } } }] });
// `pending`: what judgeRules left (unbaselined findings, drift). Too few controls makes a batch suspect, and a suspect
// batch is no proof of "gone" (as too few decoys is no double-check).
export function judgeAi({ group, recheck, pending = {} }) {
  const byFp = new Map((recheck?.results || []).map(r => [r.fp, r.cells || {}]));
  const still = [], unsure = [];
  for (const it of group.ai) {
    const cells = byFp.get(it.fp) || {};
    for (const c of it.cells || []) {
      const v = cells[c]?.verdict;
      if (v === 'still-there' || v === 'unchanged') still.push({ fp: it.fp, cell: c, verdict: v });
      else if (v !== 'gone') unsure.push({ fp: it.fp, cell: c, verdict: v || 'not-asked' });
    }
  }
  if (still.length) return { outcome: 'not-fixed', still };
  if (recheck?.suspect) return { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'recheck-suspect', text: `the re-check was suspect (${recheck.suspectReason || 'controls'}): it cannot show the defect is gone` }] };
  if (unsure.length) return { outcome: 'inconclusive', needsYou: 'c', reasons: [{ why: 'recheck-unsure', text: `the re-check could not tell for ${unsure.length} screen(s)`, cells: unsure }] };
  if (pending.unbaselined?.length) return { outcome: 'unbaselined', needsYou: 'a', unbaselined: pending.unbaselined, defectGone: true };
  if (pending.drift) return { outcome: 'drift', needsYou: 'a', drift: pending.drift, defectGone: true };
  return { outcome: 'fixed' };
}

// Visual drift on one screen (design §4.5 row 4): controls outside the finding's boxes that moved, appeared or went,
// and the share of PNG pixels outside those boxes that differ. `boxes`: the group's boxes on that screen (CSS px),
// before and after; `pixels`: png.mjs pixelDiff's result, or null without PNGs.
export function screenDrift({ before = [], after = [], boxes = [], pixels = null, pad = 8 }) {
  const grown = boxes.filter(Array.isArray).map(([x, y, w, h]) => [x - pad, y - pad, w + 2 * pad, h + 2 * pad]);
  const near = b => Array.isArray(b) && grown.some(g => iou(b, g) > 0 || (b[0] < g[0] + g[2] && b[0] + b[2] > g[0] && b[1] < g[1] + g[3] && b[1] + b[3] > g[1]));
  const map = list => new Map((list || []).filter(c => c && typeof c.selector === 'string' && Array.isArray(c.box)).map(c => [c.selector, c.box]));
  const a = map(before), b = map(after);
  let moved = 0;
  for (const [sel, box] of a) {
    if (near(box)) continue;
    const nb = b.get(sel);
    if (!nb) { moved++; continue; }
    if (near(nb)) continue;
    if (box.some((v, i) => Math.abs(v - nb[i]) > MOVE_PX)) moved++;
  }
  for (const [sel, box] of b) if (!a.has(sel) && !near(box)) moved++;
  return { moved, share: pixels ? pixels.share : 0 };
}

// What a closed attempt means for the next one (design §4.9): reverted with attempts left → to fix again; after
// MAX_ATTEMPTS → needs you (b).
export const afterRevert = attemptsUsed => (attemptsUsed >= MAX_ATTEMPTS ? 'needs-you-b' : 'to-fix');
