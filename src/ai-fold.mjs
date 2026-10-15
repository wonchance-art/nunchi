// AI findings into the ledger (design 0.1-c §2.2): what a run gives the ledger's (run, "ai") fold, read from the run
// folder. `hunt --record` and `verify --record` fold it, and so does the ledger's catch-up for a run whose hunt or
// verdicts were recorded but not folded (a crash in between) or changed since (a re-verify).
// - Only runs with an id and of kind `sweep` fold (a quick run or a fix probe never does, §2.1; an --out folder has
//   no id and is refused).
// - Verdicts come from the answer key, never from the project. ai-findings.json and verify.json are files in the
//   project, and anything can write them: a status the verify key (outside the project, state.mjs) does not back
//   with a recorded verdict on a packet whose claim still matches is a claim, and `suspect` is recomputed from the
//   key's recorded rounds (verify.mjs verdictsFromKey).
// - A hunt that claimed nothing still folds (its coverage), so a hunt's silence counts towards staleness.
// - Canary copies are left out.
// - Grounding is checked again against the run, so a hand-written ai-findings.json cannot skip `hunt --record`:
//   the scene is one of the run's captured screens, the route and viewport are that scene's, the selector is in
//   its evidence (or an aria.yml node), and a file:line is a file under the app root with that line (hunt.mjs
//   checkSource, as `hunt --record` checks it), which for file-only grounding is not a blank line. Anything else is
//   listed in `rejected`.
// - The identity (fingerprint) is computed from the run again; the grounded line's hash and the element's canonical
//   selector are taken from the hunt when they still fit (they were made from what the hunter read).
// Pure reads; the ledger does the writing.
import { readFileSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, present, peekKey, keyPath } from './state.mjs';
import { sceneIndex, sceneDir, checkSource } from './hunt.mjs';
import { fingerprintOf, looked, normalizeSelector } from './ledger.mjs';
import { aiIdentity, ariaRoleName } from './ai-identity.mjs';
import { SEVERITIES } from './lenses.mjs';
import { recheckInput, recordRecheck } from './recheck.mjs';
import { verdictsFromKey } from './verify.mjs';
import { agentList } from './agents.mjs';

const RUN_ID = /^\d{4,}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const STATUSES = new Set(['confirmed', 'claimed', 'rejected', 'insufficient']);
const str = v => (typeof v === 'string' && v ? v : null);
const clip = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : null);

// run.json → { id, kind } when the run may fold into the ledger, else { why }.
export function runIdentity(runDir) {
  const f = join(runDir, 'run.json');
  if (!present(f)) return { why: 'it has no run.json (not a complete capture run)' };
  const meta = readJsonFile(f, `fix or remove the run folder ${runDir}`);
  const id = meta?.id;
  if (typeof id !== 'string' || !RUN_ID.test(id)) return { why: 'it has no run id (a folder written with capture --out)' };
  if (id !== basename(runDir)) return { why: `its run.json names run ${id}, not ${basename(runDir)}` };
  const kind = meta.kind === undefined ? 'sweep' : meta.kind;
  if (kind !== 'sweep') return { id, kind, why: `it is a ${kind} run: only a sweep folds its AI findings` };
  return { id, kind };
}

// The bytes the fold reads, hashed: the fold's key (design §2.1). A re-hunt or a re-verify changes it, so the fold is
// replaced.
function bytes(file) {
  const st = lstatSync(file);
  if (!st.isFile()) throw Object.assign(new Error(`${file} is not a regular file: fix or remove it`), { code: 'CORRUPT', file });
  return readFileSync(file);
}
const AI_FILES = ['ai-findings.json', 'coverage.json', 'source-hashes.json'];
// → the key, or null when this run has nothing to fold (not hunted, no id, not a sweep).
export function aiFoldKey(runDir) {
  if (!present(join(runDir, 'ai-findings.json')) && !present(join(runDir, 'coverage.json'))) return null;
  if (runIdentity(runDir).why) return null;
  const h = createHash('sha256').update('ai\0');
  for (const n of AI_FILES) { const p = join(runDir, n); if (present(p)) h.update(`${n}\0`).update(bytes(p)).update('\0'); }
  const k = keyPath(runDir, 'verify-key.json');
  if (present(k)) h.update('verify-key.json\0').update(bytes(k)).update('\0');
  return h.digest('hex').slice(0, 16);
}

// The hash of each route's source files at capture (capture writes source-hashes.json beside source-map.json): a
// re-check can tell a route's code is unchanged only by it (recheck.mjs). → { route: hash } ({} for a run without).
export function routeHashes(runDir) {
  try {
    const doc = JSON.parse(readFileSync(join(runDir, 'source-hashes.json'), 'utf8'));
    const out = {};
    for (const [r, h] of Object.entries(doc?.routes || {})) if (typeof h === 'string' && HEX16.test(h)) out[r] = h;
    return out;
  } catch { return {}; }
}

// One AI finding as ledger.mjs foldAi takes it: its fingerprint, its cell and screen, its verdict and severities.
// `scene`: its manifest entry (or null: the cell comes from the scene id). `suspect`: the run's verification was.
// `src`: the hash of the scene's route's source files at capture, or null.
export function foldFinding(f, scene = null, { suspect = false, src = null } = {}) {
  const { fp, group, inputs } = fingerprintOf(f);
  const v = f.verification && typeof f.verification === 'object' ? f.verification : null;
  const parts = String(f.scene ?? '').split('.').slice(-3);
  const cell = scene ? `${scene.person}.${scene.state}.${scene.viewport}` : parts.length === 3 && parts.every(Boolean) ? parts.join('.') : null;
  const file = f.evidence && typeof f.evidence === 'object' ? str(f.evidence.file) : null;
  const judged = f.status !== 'claimed';
  return {
    fp, group, inputs, lens: f.lens, rule: f.rule, route: scene ? scene.route : f.route ?? null, scene: scene ? scene.id : str(f.scene), cell,
    selector: str(f.selector), box: Array.isArray(f.box) && f.box.length === 4 && f.box.every(Number.isFinite) ? f.box : null,
    evidence: { claim: clip(f.evidence?.claim, 500), ...(file ? { file, line: f.evidence.line } : {}) },
    identity: f.identity && typeof f.identity === 'object' ? f.identity : null, status: f.status,
    claimedSeverity: SEVERITIES.includes(v?.claimedSeverity) ? v.claimedSeverity : f.severity,
    verdictSeverity: judged && SEVERITIES.includes(v?.severity) ? v.severity : null,
    by: judged ? str(v?.verifier) : null, vendor: judged ? str(v?.vendor) : null,
    suspect: judged && (!!v?.suspect || suspect),
    // a run with too few decoys to check the checker: its verdict is no double-check (verify.mjs)
    ...(judged && !v?.suspect && !suspect && v?.tooFewDecoys === true ? { tooFewDecoys: true } : {}),
    sceneHash: scene ? { top: str(scene.top), full: str(scene.full), textHash: str(scene.textHash), src: str(src) } : null,
    // who claimed it, as declared (M6: hunt answers per agent); a name that is not one is left out
    ...(agentList(f.agents).length ? { agents: agentList(f.agents) } : {}),
  };
}

// The inventory of the run (component lookup of the identity).
function runInventory(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, 'inventory.json'), 'utf8')); } catch { return null; }
}

// The selector the hunt canonicalised the element to, when it still fits this finding: the cited selector itself,
// or, for an aria node, the selector of one of the scene's controls with that accessible name. Then the fold keeps
// it, so the fingerprint does not move with how the fold canonicalises (design §2.3).
function storedElement(stored, sel, rows) {
  const e = typeof stored?.element === 'string' && stored.element ? stored.element : null;
  if (!e || typeof sel !== 'string') return null;
  if (e === normalizeSelector(sel)) return e;
  const aria = ariaRoleName(sel);
  if (!aria) return null;
  const named = rows.filter(c => c && typeof c.selector === 'string' && typeof c.name === 'string' && c.name.trim() === aria.name.trim());
  return named.some(c => normalizeSelector(c.selector) === e) ? e : null;
}

// → { run, findings, seen, rejected } for ledger.mjs foldAi, or null when the run may not fold.
export function aiFoldInput(runDir, { root }) {
  const who = runIdentity(runDir);
  if (who.why) return null;
  const fix = `fix or remove the run folder ${runDir}`;
  const manifest = readJsonFile(join(runDir, 'manifest.json'), fix);
  const doc = present(join(runDir, 'ai-findings.json')) ? readJsonFile(join(runDir, 'ai-findings.json'), fix) : null;
  const coverage = present(join(runDir, 'coverage.json')) ? readJsonFile(join(runDir, 'coverage.json'), fix) : null;
  const scenes = new Map((Array.isArray(manifest?.scenes) ? manifest.scenes : []).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  const raw = Array.isArray(doc) ? doc : Array.isArray(doc?.findings) ? doc.findings : [];
  // statuses, severities and `suspect` from the verify key's recorded verdicts only (design §2.2)
  const list = verdictsFromKey(raw, peekKey(runDir, 'verify-key.json'));
  const inventory = runInventory(runDir);
  const src = routeHashes(runDir);
  const indexes = new Map(), controls = new Map(), cache = new Map(), sources = new Map();
  const findings = [], rejected = [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object' || f.source !== 'ai') return;
    const reject = reason => rejected.push({ finding: i, scene: str(f.scene), rule: str(f.rule), reason });
    if (raw[i].status !== undefined && !STATUSES.has(raw[i].status)) return reject('bad-status');
    const s = scenes.get(f.scene);
    if (!s || !sceneDir(runDir, f.scene)) return reject('scene-not-in-run');
    if (s.canary !== undefined) return;                                        // canary copies never enter the ledger
    if (!looked(s)) return reject('scene-not-captured');
    if (f.route !== s.route || f.viewport !== s.viewport) return reject('scene-mismatch');
    if (typeof f.lens !== 'string' || !/^L\d+$/.test(f.lens) || typeof f.rule !== 'string' || !f.rule.startsWith(f.lens + '.')) return reject('bad-rule');
    if (!SEVERITIES.includes(f.severity)) return reject('bad-severity');
    const sel = f.selector;
    const file = f.evidence && typeof f.evidence === 'object' ? f.evidence.file : undefined;
    const hasSel = sel !== null && sel !== undefined, hasFile = file !== null && file !== undefined;
    if (!hasSel && !hasFile) return reject('ungrounded');
    if (hasSel) {
      if (typeof sel !== 'string' || !sel.trim()) return reject('selector-not-in-evidence');
      if (!indexes.has(f.scene)) indexes.set(f.scene, sceneIndex(runDir, f.scene));
      const { idx, ariaNodes } = indexes.get(f.scene);
      if (sel.startsWith('aria=') ? !ariaNodes.has(sel.slice(5).trim()) : !idx.has(sel)) return reject('selector-not-in-evidence');
    }
    if (hasFile) {
      const line = f.evidence.line;
      if (typeof file !== 'string' || !Number.isInteger(line) || line < 1) return reject('source-not-found');
      // the check `hunt --record` makes: a file of the app under its root, the line inside it
      const c = checkSource(root, `${file}:${line}`, sources);
      if (c.error || c.file !== file.replace(/\\/g, '/')) return reject('source-not-found');
    }
    if (!controls.has(f.scene)) { let rows = []; try { rows = JSON.parse(readFileSync(join(sceneDir(runDir, f.scene), 'controls.json'), 'utf8')); } catch {} controls.set(f.scene, Array.isArray(rows) ? rows : []); }
    const rows = controls.get(f.scene);
    const fresh = aiIdentity({ finding: f, controls: rows, inventory, root, cache });
    // what the hunt took (the source the hunter read, its canonical element) stays when it still fits; the rest comes
    // from the run
    const stored = f.identity && typeof f.identity === 'object' ? f.identity : {};
    const anchor = typeof stored.anchor === 'string' && HEX16.test(stored.anchor) ? stored.anchor : fresh.anchor;
    // grounded in a line only: that line must name something (a blank line, or one no longer there, cannot tell
    // two defects of the file apart)
    if (!hasSel && !anchor) return reject('source-line-blank');
    const element = storedElement(stored, sel, rows) ?? fresh.element;
    const identity = { ...fresh, element, anchor, fileHash: typeof stored.fileHash === 'string' && HEX16.test(stored.fileHash) ? stored.fileHash : fresh.fileHash };
    findings.push(foldFinding({ ...f, identity }, s, { src: src[s.route] ?? null }));
  });
  // the cells the hunt saw (a canary copy is not a cell of the app)
  const seen = [];
  for (const c of Array.isArray(coverage?.cells) ? coverage.cells : []) {
    if (!c || c.status !== 'seen' || typeof c.lens !== 'string') continue;
    const s = scenes.get(c.scene);
    if (!s || s.canary !== undefined || !looked(s)) continue;
    seen.push(`${c.lens}|${s.route}|${s.person}.${s.state}.${s.viewport}`);
  }
  return { run: who.id, findings, seen: [...new Set(seen)].sort(), rejected };
}

export const aiLoader = ({ root }) => ({ key: aiFoldKey, input: dir => aiFoldInput(dir, { root }) });

// The re-check's verdicts → the (run, "recheck") fold. They come from the re-check key (outside the project), where
// `recheck --record` stores them beside the plan: the results and `suspect` are recomputed from the key and those
// verdicts. recheck.json in the run is a copy for people to read; it is never folded.
const recheckKeyOf = (runDir, id) => {
  const key = peekKey(runDir, 'recheck-key.json');
  return key && key.run === id && key.recorded && Array.isArray(key.recorded.verdicts) && key.packets && typeof key.packets === 'object' ? key : null;
};
export function recheckFoldKey(runDir) {
  const who = runIdentity(runDir);
  if (who.why || !recheckKeyOf(runDir, who.id)) return null;
  return createHash('sha256').update('recheck\0').update(bytes(keyPath(runDir, 'recheck-key.json'))).digest('hex').slice(0, 16);
}
export function recheckFoldInput(runDir) {
  const who = runIdentity(runDir);
  if (who.why) return null;
  const key = recheckKeyOf(runDir, who.id);
  if (!key) return null;
  const r = recordRecheck({ key, packets: null, verdicts: key.recorded.verdicts });
  if (r.problems.length) return null;
  return { run: who.id, ...recheckInput(r.recheck) };
}
export const recheckLoader = { key: recheckFoldKey, input: recheckFoldInput };
