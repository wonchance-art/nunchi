// AI findings into the ledger (design 0.1-c §2.2): what a run gives the ledger's (run, "ai") fold, read from the run
// folder. `verify --record` folds it, and so does the ledger's catch-up for a run whose verdicts were recorded but
// not folded (a crash in between) or changed since (a re-verify).
// - Only runs with an id and of kind `sweep` fold (a quick run or a fix probe never does, §2.1; an --out folder has
//   no id and is refused).
// - Canary copies are left out.
// - Grounding is checked again against the run, so a hand-written ai-findings.json cannot skip `hunt --record`:
//   the scene is one of the run's captured screens, the route and viewport are that scene's, the selector is in
//   its evidence (or an aria.yml node), and a file:line is a file the run's source map or inventory knows (or, for a
//   run without them, a file under the app root with that line). Anything else is listed in `rejected`.
// - The identity (fingerprint) is computed from the run again; only the grounded line's hash is taken from the hunt
//   (it was hashed from the source the hunter read).
// Pure reads; the ledger does the writing.
import { readFileSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonFile, present } from './state.mjs';
import { sceneIndex, sceneDir } from './hunt.mjs';
import { fingerprintOf, looked } from './ledger.mjs';
import { aiIdentity, sourcePath, readSource } from './ai-identity.mjs';
import { SEVERITIES } from './lenses.mjs';
import { recheckInput } from './recheck.mjs';

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

// The bytes the fold reads, hashed: the fold's key (design §2.1). A re-verify changes it, so the fold is replaced.
function bytes(file) {
  const st = lstatSync(file);
  if (!st.isFile()) throw Object.assign(new Error(`${file} is not a regular file: fix or remove it`), { code: 'CORRUPT', file });
  return readFileSync(file);
}
const AI_FILES = ['ai-findings.json', 'verify.json', 'coverage.json'];
// → the key, or null when this run has nothing to fold (no verdicts recorded, no id, not a sweep).
export function aiFoldKey(runDir) {
  if (!present(join(runDir, 'verify.json')) || !present(join(runDir, 'ai-findings.json'))) return null;
  if (runIdentity(runDir).why) return null;
  const h = createHash('sha256').update('ai\0');
  for (const n of AI_FILES) { const p = join(runDir, n); if (present(p)) h.update(`${n}\0`).update(bytes(p)).update('\0'); }
  return h.digest('hex').slice(0, 16);
}

// One AI finding as ledger.mjs foldAi takes it: its fingerprint, its cell and screen, its verdict and severities.
// `scene`: its manifest entry (or null: the cell comes from the scene id). `suspect`: the run's verification was.
export function foldFinding(f, scene = null, { suspect = false } = {}) {
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
    sceneHash: scene ? { top: str(scene.top), full: str(scene.full), textHash: str(scene.textHash) } : null,
  };
}

// The files of the app the run knows: its source map and inventory.
function runFiles(runDir) {
  const out = new Set();
  const read = n => { try { return JSON.parse(readFileSync(join(runDir, n), 'utf8')); } catch { return null; } };
  const map = read('source-map.json');
  if (map && map.files && typeof map.files === 'object') for (const f of Object.keys(map.files)) out.add(f);
  if (map && map.routes && typeof map.routes === 'object') for (const list of Object.values(map.routes)) if (Array.isArray(list)) for (const f of list) if (typeof f === 'string') out.add(f);
  const inv = read('inventory.json');
  if (inv && Array.isArray(inv.files)) for (const f of inv.files) if (f && typeof f.file === 'string') out.add(f.file);
  return { files: out, inventory: inv };
}

// → { run, findings, seen, rejected } for ledger.mjs foldAi, or null when the run may not fold.
export function aiFoldInput(runDir, { root }) {
  const who = runIdentity(runDir);
  if (who.why) return null;
  const fix = `fix or remove the run folder ${runDir}`;
  const manifest = readJsonFile(join(runDir, 'manifest.json'), fix);
  const doc = readJsonFile(join(runDir, 'ai-findings.json'), fix);
  const verify = present(join(runDir, 'verify.json')) ? readJsonFile(join(runDir, 'verify.json'), fix) : null;
  const coverage = present(join(runDir, 'coverage.json')) ? readJsonFile(join(runDir, 'coverage.json'), fix) : null;
  const scenes = new Map((Array.isArray(manifest?.scenes) ? manifest.scenes : []).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.findings) ? doc.findings : [];
  const { files: known, inventory } = runFiles(runDir);
  const indexes = new Map(), controls = new Map(), cache = new Map(), lines = new Map();
  const findings = [], rejected = [];
  list.forEach((f, i) => {
    if (!f || typeof f !== 'object' || f.source !== 'ai') return;
    const reject = reason => rejected.push({ finding: i, scene: str(f.scene), rule: str(f.rule), reason });
    if (!STATUSES.has(f.status)) return reject('bad-status');
    const s = scenes.get(f.scene);
    if (!s || !sceneDir(runDir, f.scene)) return reject('scene-not-in-run');
    if (s.canary !== undefined) return;                                        // canary copies never enter the ledger
    if (!looked(s)) return reject('scene-not-captured');
    if (f.route !== s.route || f.viewport !== s.viewport) return reject('scene-mismatch');
    if (typeof f.lens !== 'string' || !/^L\d+$/.test(f.lens) || typeof f.rule !== 'string' || !f.rule.startsWith(f.lens + '.')) return reject('bad-rule');
    if (!SEVERITIES.includes(f.severity)) return reject('bad-severity');
    const sel = f.selector;
    const file = f.evidence && typeof f.evidence === 'object' ? f.evidence.file : undefined;
    if ((sel === null || sel === undefined) && (file === null || file === undefined)) return reject('ungrounded');
    if (sel !== null && sel !== undefined) {
      if (typeof sel !== 'string' || !sel.trim()) return reject('selector-not-in-evidence');
      if (!indexes.has(f.scene)) indexes.set(f.scene, sceneIndex(runDir, f.scene));
      const { idx, ariaNodes } = indexes.get(f.scene);
      if (sel.startsWith('aria=') ? !ariaNodes.has(sel.slice(5).trim()) : !idx.has(sel)) return reject('selector-not-in-evidence');
    }
    if (file !== null && file !== undefined) {
      const line = f.evidence.line;
      if (typeof file !== 'string' || !Number.isInteger(line) || line < 1) return reject('source-not-found');
      if (!sourcePathShape(file)) return reject('source-not-found');
      if (!known.has(file)) {
        // a run without a source map (--routes): the file must be under the app root, the line inside it
        if (!sourcePath(root, file)) return reject('source-not-found');
        if (!lines.has(file)) { const t = readSource(root, file, cache); lines.set(file, t === null ? 0 : t.split('\n').length); }
        if (line > lines.get(file)) return reject('source-not-found');
      }
    }
    if (!controls.has(f.scene)) { let rows = []; try { rows = JSON.parse(readFileSync(join(sceneDir(runDir, f.scene), 'controls.json'), 'utf8')); } catch {} controls.set(f.scene, Array.isArray(rows) ? rows : []); }
    const fresh = aiIdentity({ finding: f, controls: controls.get(f.scene), inventory, root, cache });
    // the grounded line's hash the hunt took (the source the hunter read) stays; the rest comes from the run
    const stored = f.identity && typeof f.identity === 'object' ? f.identity : {};
    const identity = { ...fresh, anchor: typeof stored.anchor === 'string' && HEX16.test(stored.anchor) ? stored.anchor : fresh.anchor,
      fileHash: typeof stored.fileHash === 'string' && HEX16.test(stored.fileHash) ? stored.fileHash : fresh.fileHash };
    findings.push(foldFinding({ ...f, identity }, s, { suspect: !!verify?.suspect }));
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
const sourcePathShape = f => !/^[a-zA-Z]:/.test(f) && !f.startsWith('/') && !f.split(/[\\/]/).some(p => p === '..' || p === '.nunchi' || p === 'node_modules' || p === '.git');

export const aiLoader = ({ root }) => ({ key: aiFoldKey, input: dir => aiFoldInput(dir, { root }) });

// The re-check's verdicts (recheck.json, written by recheck --record) → the (run, "recheck") fold.
export function recheckFoldKey(runDir) {
  const p = join(runDir, 'recheck.json');
  if (!present(p) || runIdentity(runDir).why) return null;
  return createHash('sha256').update('recheck\0').update(bytes(p)).digest('hex').slice(0, 16);
}
export function recheckFoldInput(runDir) {
  const who = runIdentity(runDir);
  if (who.why) return null;
  const doc = readJsonFile(join(runDir, 'recheck.json'), `fix or remove the run folder ${runDir}`);
  if (doc?.run !== who.id) return null;                                       // verdicts of another run: never folded here
  return { run: who.id, ...recheckInput(doc) };
}
export const recheckLoader = { key: recheckFoldKey, input: recheckFoldInput };
