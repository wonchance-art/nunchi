// The board's view model (design 0.1-c §3.3): the ledger as `nunchi findings` reads it (every group, through
// project.mjs and ledger.mjs view), the Progress summary (summary.mjs, shared with `findings --json`), and evidence
// pointers into the run folders (the scenes, screenshots and element boxes the static export uses too).
//
// Everything the board's own code did not write (app text, selectors, claims, decision `by` and `note`, lens text,
// URLs) is data: it is redacted here (credential URL parts, secret shapes), clipped, and handed to the page as plain
// strings, which the page renders with textContent only. Ids that become element ids or URLs are checked (12 hex,
// run ids, scene ids of the run's manifest). Secrets show location and kind, never the value.
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, openSync, readSync, closeSync, lstatSync, readdirSync } from 'node:fs';
import { loadLedger, ledgerView } from '../project.mjs';
import { summary } from '../summary.mjs';
import { readManifest, jpegSize, sceneIndex, sceneDir } from '../hunt.mjs';
import { annotate, latestRunOf, byRun, currentTargets, writtenAs, approvalKey, HUMAN_CHANNELS, titleOf } from '../ledger.mjs';
import { listRuns, gitRunner } from '../runs.mjs';
import { readGeneration } from '../state.mjs';
import { scrubSecrets } from '../rules.mjs';
import { redactText, redactUrl } from '../network.mjs';
import { SEV, STATUS_LABEL, PERSONS, VPS, STATES, human, plural, drawable, sceneLabelText } from './shared.mjs';
import { claimLive, claimMinutes } from '../fix/claims.mjs';
import { fixNeedsOf } from '../summary.mjs';
import { latestRecords, allRecords, isOpen } from '../fix/records.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const readJsonOr = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
// One way data leaves the server: redacted (credential URL parts, then secret shapes), then clipped, so a cut never
// leaves part of a secret. The page escapes nothing because it never parses markup: it sets textContent.
const clean = s => scrubSecrets(redactText(String(s ?? '')));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const safe = (s, n = 400) => clip(clean(s), n);
const safeOrNull = (s, n) => (s === null || s === undefined ? null : safe(s, n));
const deepClean = v => (Array.isArray(v) ? v.map(deepClean)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [clean(k), deepClean(v[k])]))
  : typeof v === 'string' ? clean(v) : v);
const HEX12 = /^[0-9a-f]{12}$/;
export const RUN_ID = /^\d{4,}$/;
const box4 = b => (Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(n => typeof n === 'number' && Number.isFinite(n)) ? b.slice(0, 4) : null);
const sevOf = v => (Object.hasOwn(SEV, v) ? v : 'low');
const str = v => (typeof v === 'string' ? v : null);
const ACTIVE = new Set(['open', 'regressed', 'to-fix', 'held', 'stale']);

// ---- run evidence -------------------------------------------------------------------------------------------------

// The first bytes of a screenshot are enough for its size (the frame header comes first).
function jpegHeader(file) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return jpegSize(buf.subarray(0, n));
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// One run folder as the board shows it: its scenes (in the wall's order, canary copies left out), each with the size
// of its screenshot, and its rule findings by fingerprint (named as the ledger names them now: `aliases`), each with
// its element box (the finding's own, else the scene's evidence index). A run that cannot be read gives nothing.
export function runEvidence(runsDir, runId, aliases = {}) {
  const empty = { runId, scenes: [], sceneById: new Map(), byFp: new Map(), manifest: null, meta: {} };
  if (!RUN_ID.test(String(runId))) return empty;
  const runDir = join(runsDir, runId);
  let manifest;
  try { manifest = readManifest(runDir); } catch { return empty; }
  const meta = readJsonOr(join(runDir, 'run.json'), {});
  const flow = readJsonOr(join(runDir, 'flow.json'), null);
  const vpById = Object.fromEntries((manifest.viewports || []).map(v => [v.id, v]));
  const scenes = (Array.isArray(manifest.scenes) ? manifest.scenes : []).filter(s => s && typeof s.id === 'string' && s.canary === undefined && sceneDir(runDir, s.id));
  const order = Array.isArray(flow?.order) ? flow.order : [];
  const firstAt = new Map(); scenes.forEach((s, i) => { if (!firstAt.has(s.route)) firstAt.set(s.route, i); });
  const routeRank = r => { const i = order.indexOf(r); return i < 0 ? order.length + (firstAt.get(r) ?? 0) : i; };
  scenes.sort((a, b) => routeRank(a.route) - routeRank(b.route) || rank(PERSONS, a.person) - rank(PERSONS, b.person)
    || rank(VPS, a.viewport) - rank(VPS, b.viewport) || rank(STATES, a.state) - rank(STATES, b.state) || cmp(a.id, b.id));
  const out = scenes.map((s, i) => {
    const dir = sceneDir(runDir, s.id);
    const m = readJsonOr(join(dir, 'measure.json'), {});
    const h1 = typeof m.h1 === 'string' ? m.h1 : Array.isArray(m.h1) && typeof m.h1[0] === 'string' ? m.h1[0] : null;
    let img = null;
    if (s.status === 'captured') {
      const full = jpegHeader(join(dir, 'full.jpg')), top = jpegHeader(join(dir, 'top.jpg'));
      const size = full || top;
      const vp = vpById[s.viewport];
      if (size?.width && size?.height) {
        const dpr = vp && top?.width ? top.width / vp.width : 1;
        img = { file: full ? 'full.jpg' : 'top.jpg', thumb: top ? 'top.jpg' : 'full.jpg', w: size.width, h: size.height, dpr, vh: vp ? Math.round(vp.height * dpr) : size.height };
      }
    }
    const redirected = /^redirected/.test(String(s.reason || ''));
    return { key: `${runId}/${s.id}`, run: runId, id: s.id, order: i, route: String(s.route ?? ''), person: String(s.person ?? ''), state: String(s.state ?? ''), viewport: String(s.viewport ?? ''),
      status: String(s.status ?? ''), reason: str(s.reason), redirected, finalPath: str(s.finalPath), finalOrigin: str(s.finalOrigin), h1, img };
  });
  const sceneById = new Map(out.map(s => [s.id, s]));
  const raw = readJsonOr(join(runDir, 'findings.json'), { findings: [] })?.findings;
  const list = (Array.isArray(raw) ? raw : []).filter(f => f && typeof f === 'object' && f.source !== 'ai');
  const named = (list.every(f => f.fp && f.group) ? list : annotate(list.map(({ fp, group, ...f }) => f)))
    .map(f => ({ ...f, fp: aliases.fp?.[f.fp] || f.fp, group: aliases.group?.[f.group] || f.group }));
  const indexes = new Map();
  const byFp = new Map();
  for (const f of named) {
    if (typeof f.fp !== 'string') continue;
    let box = box4(f.box), inside = str(f.inside);
    if (!box && f.scene && sceneById.has(f.scene) && typeof f.selector === 'string') {
      if (!indexes.has(f.scene)) indexes.set(f.scene, sceneIndex(runDir, f.scene).idx);
      const hit = indexes.get(f.scene).get(f.selector);
      box = box4(hit?.box); inside = inside || str(hit?.inside);
    }
    const inst = { fp: f.fp, run: runId, scene: str(f.scene), route: str(f.route), viewport: str(f.viewport), selector: str(f.selector), box, inside, rule: String(f.rule ?? ''), severity: sevOf(f.severity),
      evidence: f.evidence && typeof f.evidence === 'object' && !Array.isArray(f.evidence) ? f.evidence : {} };
    if (!byFp.has(f.fp)) byFp.set(f.fp, []);
    byFp.get(f.fp).push(inst);
  }
  return { runId, scenes: out, sceneById, byFp, manifest, meta };
}

// ---- presentation of one group --------------------------------------------------------------------------------

const GIST_KEYS = ['text', 'name', 'message', 'href', 'src', 'value', 'placeholder', 'kind', 'summary', 'what'];
function gistOf(f) {
  if (!f) return '';
  const ev = f.evidence || {};
  for (const k of GIST_KEYS) if (typeof ev[k] === 'string' && ev[k].trim()) return ['href', 'src'].includes(k) ? redactUrl(ev[k]) : ev[k];
  return f.selector || '';
}
function codeOf(f) {
  const ev = f?.evidence || {};
  if (typeof ev.file === 'string' && Number.isInteger(ev.line)) return { file: ev.file, line: ev.line };
  if (typeof ev.file === 'string') return { file: ev.file, line: null };
  return null;
}
// Characters a path shown or copied must not hold: C0 and C1 controls, DEL, bidi marks, overrides and isolates, line
// and paragraph separators, BOM (a pasted path could run another command than the one shown).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/;
const CONTROLS = new RegExp(CONTROL.source, 'g');
// A file path as shown: controls as U+FFFD, redacted, clipped.
export const shownPath = (file, n = 300) => safe(String(file).replace(CONTROLS, '\ufffd'), n);
// The code location the page shows and copies: `file` clipped for showing, `copy` the whole path (redacted, never
// clipped; none when it holds a control character or is over 4096 characters), the editor link.
function codeOut(projectDir, code) {
  if (!code) return null;
  const bad = CONTROL.test(code.file);
  const full = clean(code.file);
  return { file: shownPath(code.file), line: code.line, copy: bad || full.length > 4096 ? null : full, link: bad ? null : editorLink(projectDir, code) };
}
// What the page may link to for a file of the app: an editor link to a file inside the project, never anything else.
function editorLink(projectDir, code) {
  if (!code || typeof code.file !== 'string' || CONTROL.test(code.file) || isAbsolute(code.file)) return null;
  const abs = resolve(projectDir, code.file);
  const r = relative(projectDir, abs);
  if (!r || r.startsWith('..') || isAbsolute(r)) return null;
  const path = abs.split(/[\\/]/).map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  return `vscode://file/${path.replace(/^\/+/, '')}${code.line ? `:${code.line}` : ''}`;
}
const CHANNEL_WORDS = { board: 'Decided in the board', 'cli-tty': 'Decided in your terminal', 'cli-agent': 'Recorded by your AI', unknown: 'Recorded before nunchi tracked who decided', git: 'Came through git, not approved on this machine' };
const decisionOut = d => (!d ? null : {
  id: safe(d.id, 60), decision: d.decision, reason: d.reason ?? null, by: safeOrNull(d.by, 80), at: safeOrNull(d.at, 40),
  channel: d.channel ?? null, channelText: CHANNEL_WORDS[d.channel] || null, human: d.human ?? null, note: safeOrNull(d.note, 500), batch: safeOrNull(d.batch, 40),
});

// ---- the model ------------------------------------------------------------------------------------------------

// `labelMode`: the model of label mode (design §9.2) is built from the same ledger, but only labels.mjs reads it.
export function buildBoardModel({ nunchiDir, projectDir, warn = () => {} }) {
  const led = loadLedger(nunchiDir, { root: projectDir, warn });
  const { st, state } = led;
  const generation = readGeneration(st.files.generation);
  const { rows, groups } = ledgerView(led);
  let git = null; try { git = gitRunner(projectDir); } catch {}
  // the fix loop's latest attempt of each group (design §3.4 "Fix states on the board"); a record that cannot be read
  // shows nothing (the CLI says why)
  let records = new Map();
  try { records = latestRecords(st.root.dir); } catch { records = new Map(); }
  const fixNeeds = fixNeedsOf(records, rows);
  const sum = summary({ state, rows, groups, stream: st.root.stream, runsDir: st.runsDir, git, fixNeeds });
  const latest = latestRunOf(state, st.root.stream);
  const aliases = state.aliases || {};
  const runs = new Map();
  const evidenceOf = runId => { if (!runs.has(runId)) runs.set(runId, runEvidence(st.runsDir, runId, aliases)); return runs.get(runId); };
  const latestEv = latest ? evidenceOf(latest) : null;
  const complete = new Set(listRuns(st.runsDir).complete);

  // instances of a row: an AI item's own record of where it was seen (per cell: the scene, element and box); a rule
  // item's findings in the run that last saw it
  const instancesOf = r => {
    if (r.source === 'ai') {
      return Object.entries(r.seen || {}).sort(([a], [b]) => cmp(a, b)).map(([cell, s]) => {
        const run = RUN_ID.test(String(s?.run)) && complete.has(s.run) ? s.run : null;
        const scene = run && typeof s.scene === 'string' ? evidenceOf(run).sceneById.get(s.scene) || null : null;
        return { fp: r.fp, run, scene: scene ? scene.id : null, route: r.route, viewport: cell.split('.')[2] || null, selector: str(s?.selector) ?? str(r.selector), box: box4(s?.box) ?? box4(r.box), inside: null, rule: r.rule, severity: r.severity, evidence: r.evidence || {} };
      });
    }
    const run = RUN_ID.test(String(r.lastSeen)) && complete.has(r.lastSeen) ? r.lastSeen : null;
    const found = run ? evidenceOf(run).byFp.get(r.fp) || [] : [];
    if (found.length) return found;
    return [{ fp: r.fp, run: null, scene: null, route: r.route, viewport: null, selector: str(r.selector), box: null, inside: null, rule: r.rule, severity: r.severity, evidence: r.evidence || {} }];
  };
  const claimsDir = join(st.root.dir, 'claims');
  const claims = readClaims(claimsDir);
  const previous = sum.previousFullCheck;
  const after = id => typeof id === 'string' && (!previous || byRun(id, previous) > 0);

  const out = groups.map(g => {
    const mine = rows.filter(r => r.group === g.group);
    const inst = mine.flatMap(instancesOf);
    const ai = g.source === 'ai';
    const first = inst.find(f => f.scene) || inst[0] || null;
    const keys = new Set(Object.keys(g.statuses));
    if (keys.has('regressed') || keys.has('stale')) keys.add('open');
    const decision = mine.map(r => r.decision).find(Boolean) || null;
    const screens = new Set(inst.map(f => f.scene && `${f.run}/${f.scene}`).filter(Boolean)).size;
    const files = [...new Set(inst.map(f => codeOf(f)?.file).filter(Boolean).concat(ai && mine[0]?.identity?.component?.file ? [mine[0].identity.component.file] : []))].sort();
    const rec = records.get(g.group);
    // still on the branch: a kept or landed fix whose commit HEAD still has (a Keep or Later after (a) leaves it there)
    let reachable = false;
    const recCommit = rec?.commit || rec?.outcome?.commit;
    if (recCommit && git && /^[0-9a-f]{40,64}$/.test(String(recCommit))) { try { git(['merge-base', '--is-ancestor', String(recCommit), 'HEAD']); reachable = true; } catch {} }
    const fix = fixOut(rec, { waiting: fixNeeds.has(g.group) && mine.some(r => r.status === 'to-fix' && !r.goneAt), reachable });
    const needsYou = fix?.needs ? { reason: `fix-${fix.needs}`, run: fix.after } : mine.find(r => r.needsYou && !r.goneAt)?.needsYou || null;
    const claim = claims.get(g.group) || null;
    const verification = ai ? mine.map(r => r.verification).find(Boolean) || null : null;
    return {
      id: g.group, lens: safe(g.lens, 12), rule: safe(g.rule, 120), source: ai ? 'ai' : 'rule', severity: sevOf(g.severity),
      status: g.status, statuses: g.statuses, filterKeys: [...keys].sort(), active: [...keys].some(k => ACTIVE.has(k)),
      kindTitle: safe(ai ? `AI · ${human(g.rule)}` : g.title, 120),
      headline: safe(ai ? (first?.evidence?.claim || human(g.rule)) : g.title, 160),
      gist: ai ? '' : safe(gistOf(first), 120),
      where: { routes: g.routes.slice(0, 2).map(r => safe(r, 120)), more: Math.max(0, g.routes.length - 2), whole: g.routes.length ? null : g.rule === 'secret-in-client-bundle' ? 'Browser bundle' : 'Whole app' },
      routes: g.routes.length, screens, places: g.places,
      checked: ai ? !!g.checked : true, suspect: ai ? !!verification?.suspect : false, tooFewDecoys: ai ? verification?.tooFewDecoys === true : false,
      decision: decisionOut(decision),
      notLookedAt: mine.map(r => str(r.notLookedAt)).filter(Boolean).sort(byRun)[0] || null,
      needsYou: needsYou ? { reason: safe(needsYou.reason, 40), run: safeOrNull(needsYou.run, 12) } : null,
      fixing: claim, fix, regressed: mine.some(r => r.regressedAt && !r.goneAt), isNew: mine.some(r => after(r.firstSeen) && !r.goneAt),
      files: files.map(f => safe(f, 300)), firstSeen: mine.map(r => r.firstSeen).filter(Boolean).sort(byRun)[0] || null,
      lastSeen: mine.map(r => r.lastSeen).filter(Boolean).sort(byRun).pop() || null,
      _rows: mine, _inst: inst,
    };
  });
  // the default order (design §3.4): severity → came back → new since the last full check → reach (screens) → rule
  // before AI → id
  out.sort((a, b) => SEV[a.severity] - SEV[b.severity] || Number(b.regressed) - Number(a.regressed) || Number(b.isNew) - Number(a.isNew)
    || b.screens - a.screens || b.routes - a.routes || Number(a.source === 'ai') - Number(b.source === 'ai') || cmp(a.id, b.id));
  out.forEach((g, i) => { g.order = i; });
  const byId = new Map(out.map(g => [g.id, g]));
  return { generation, led, rows, groups: out, byId, summary: sum, latest, latestEv, evidenceOf, projectDir, nunchiDir, claims, stateDir: st.root.dir };
}

// A fix record as the board shows it (design §3.4): which attempt, its phase, the *needs you* kind — (a) the fix also
// changed other parts of the screen, (b) the AI couldn't fix it in 2 tries, (c) it could not be re-checked, and the
// other kinds with their own cards: `diff` (files only the person can approve), `unbaselined` (a screen the fix reaches
// with nothing to compare against), `interrupted` (a commit nobody re-checked), `revert` (an undo that could not run:
// signing, uncommitted changes, another branch, git) — and the probes before and after. The board says each in its own
// words (shared.mjs FIX_WORDS), never the engine's chat line; only paths, routes, rule titles, a branch and commits
// come from the record, as data, checked for their shape.
const NEEDS = new Set(['a', 'b', 'c', 'diff', 'unbaselined', 'interrupted']);
const REVERT_KINDS = new Set(['revert-failed', 'signing', 'dirty', 'wrong-branch']);
const REVERT_REASONS = new Set(['signing', 'not-head', 'in-progress', 'half-done', 'dirty', 'occupied', 'wrong-branch', 'failed']);
export const needsKind = k => (NEEDS.has(k) ? k : REVERT_KINDS.has(k) ? 'revert' : 'other');
const short7 = v => (/^[0-9a-f]{7,64}$/.test(String(v || '')) ? String(v).slice(0, 7) : null);
const pathList = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x))].sort().slice(0, 200).map(x => safe(x, 300)) : []);
function fixOut(rec, { waiting = true, reachable = false } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  // needs you only while the group is still to fix with the Fix decision the attempt was made for (a Keep, a Later,
  // or a new "Try again with a note…" answers it)
  const k = rec.phase === 'needs-you' && waiting ? String(rec.outcome?.needsYou || '') : null;
  const kind = k === null ? null : needsKind(k);
  const run = v => (RUN_ID.test(String(v ?? '')) ? String(v) : null);
  const commit = short7(rec.commit || rec.outcome?.commit);
  const drift = Array.isArray(rec.verdict?.drift?.scenes) ? rec.verdict.drift.scenes.filter(x => x && typeof x.scene === 'string').sort((a, b) => (Number(b.share) || 0) - (Number(a.share) || 0) || (Number(b.moved) || 0) - (Number(a.moved) || 0)).map(x => x.scene) : [];
  const attempt = Number.isInteger(rec.try) ? rec.try : Number.isInteger(rec.attempt) ? rec.attempt : null;
  const o = rec.outcome || {};
  // the data each card needs
  const paths = kind === 'diff' ? pathList((Array.isArray(o.flagged) ? o.flagged : []).map(f => f?.file)) : kind === 'revert' ? pathList(o.files) : [];
  const unb = kind === 'unbaselined' && Array.isArray(rec.verdict?.unbaselined) ? rec.verdict.unbaselined.filter(x => x && typeof x === 'object') : [];
  const reason = kind !== 'revert' ? null : REVERT_REASONS.has(o.reason) ? o.reason : { signing: 'signing', dirty: 'dirty', 'wrong-branch': 'wrong-branch', 'revert-failed': 'half-done' }[k] || 'failed';
  return {
    attempt, record: Number.isInteger(rec.attempt) ? rec.attempt : null,
    phase: safe(rec.phase, 20), needs: kind, kind: k ? safe(k, 20) : null,
    share: Number.isFinite(o.share) ? o.share : null, moved: Number.isInteger(o.moved) ? o.moved : null, pixels: o.pixels !== false,
    defectGone: o.defectGone === true, commit, before: run(rec.p0?.run), after: run(rec.p1?.run), drift: drift.slice(0, 20),
    paths, reason, branch: reason === 'wrong-branch' && typeof (o.branch || rec.branch) === 'string' ? safe(o.branch || rec.branch, 200) : null,
    routes: [...new Set(unb.map(x => x.route).filter(x => typeof x === 'string'))].sort().slice(0, 50).map(x => safe(x, 200)),
    shows: [...new Set(unb.map(x => x.rule).filter(x => typeof x === 'string'))].sort().slice(0, 20).map(x => safe(titleOf(x), 120)),
    // the after of an attempt that was undone (b): its screens are that attempt's, not the code now
    afterLabel: o.revert || rec.revert ? `Attempt ${attempt ?? '?'} (undone)` : null,
    // a fix whose commit is still on the branch, not undone (fixed, or kept for the person, whatever was decided since):
    // undone by the AI's `fix --undo` (design §3.4)
    landed: !!commit && reachable && !o.revert && !rec.revert && (rec.phase === 'fixed' || rec.phase === 'needs-you'),
  };
}

// The group's fix attempts for Detail history, newest first (closed ones: an open one is the "is fixing" banner): which
// attempt (per Fix decision), the outcome as a key the board words, the commit and its revert (7 characters), and when
// it closed.
export function fixHistory(model, group) {
  let recs = [];
  try { recs = allRecords(model.stateDir, group); } catch { return []; }
  return recs.filter(r => r && !isOpen(r)).sort((a, b) => (b.attempt || 0) - (a.attempt || 0)).map(r => {
    const o = r.outcome || {};
    const why = r.revertWhy || o.verdict?.outcome || r.verdict?.outcome;
    const outcome = r.phase === 'fixed' ? 'fixed' : r.phase === 'undone' ? 'undone' : r.phase === 'cancelled' ? 'cancelled' : r.phase === 'aborted' ? 'aborted'
      : r.phase === 'needs-you' ? 'needs'
      : r.phase === 'reverted' ? (o.tryAgain || r.tryAgain ? 'try-again' : why === 'caused-regression' || why === 'regression' ? 'caused-regression' : 'not-fixed') : 'other';
    const at = Array.isArray(r.phases) && r.phases.length ? r.phases[r.phases.length - 1].at : null;
    return {
      attempt: Number.isInteger(r.try) ? r.try : Number.isInteger(r.attempt) ? r.attempt : null, record: Number.isInteger(r.attempt) ? r.attempt : null,
      outcome, needs: outcome === 'needs' ? needsKind(String(o.needsYou || '')) : null,
      commit: short7(r.commit || o.commit), revert: short7(o.revert || r.revert), at: typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null,
    };
  }).filter(x => x.outcome !== 'other');
}

// Live claims (design §7, written by the fix loop, src/fix/claims.mjs): `claims/<group>.json`. Expiry is the
// reader's: lastRenewal + 30 minutes, never a value the writer set. → Map group → { agent, minutes }.
export function readClaims(dir, now = Date.now()) {
  const out = new Map();
  let names = [];
  try { if (lstatSync(dir).isDirectory()) names = readdirSync(dir).sort(); } catch { names = []; }
  for (const n of names) {
    const m = /^([0-9a-f]{12})\.json$/.exec(n);
    if (!m) continue;
    const c = readJsonOr(join(dir, n), null);
    if (!claimLive(c, now)) continue;
    out.set(m[1], { agent: safe(c.declaredAgent || 'Your AI', 40), minutes: claimMinutes(c, now) });
  }
  return out;
}

// ---- what the API returns ---------------------------------------------------------------------------------------

const publicGroup = g => { const { _rows, _inst, ...rest } = g; return rest; };

// /api/groups: the list, filtered (status tab, lens, a plain substring), sectioned by kind (default), root-cause
// file, screen or lens; AI groups not double-checked in their own collapsed section last.
export const GROUP_BY = ['kind', 'file', 'screen', 'lens'];
export function groupList(model, { status = 'open', lens = null, q = null, group = 'kind' } = {}) {
  const by = GROUP_BY.includes(group) ? group : 'kind';
  const needle = typeof q === 'string' && q.trim() ? q.trim().toLowerCase().slice(0, 200) : null;
  const counts = { all: model.groups.length };
  for (const g of model.groups) for (const k of g.filterKeys) counts[k] = (counts[k] || 0) + 1;
  const shown = model.groups.filter(g => (status === 'all' || g.filterKeys.includes(status)) && (!lens || g.lens === lens)
    && (!needle || [g.headline, g.gist, g.kindTitle, g.rule, ...g.where.routes, ...g.files].some(s => String(s).toLowerCase().includes(needle))));
  const sections = new Map(), unchecked = new Map();
  for (const g of shown) {
    const into = g.source === 'ai' && !g.checked ? unchecked : sections;
    const [key, title] = by === 'kind' ? [g.rule, g.kindTitle] : by === 'file' ? [g.files[0] || '', g.files[0] || 'No file known (found on a screen)']
      : by === 'screen' ? [g.where.routes[0] || '', g.where.routes[0] || g.where.whole] : [g.lens, g.lens];
    if (!into.has(key)) into.set(key, { key: safe(key, 300), title: safe(title, 160), severity: g.severity, ids: [] });
    const s = into.get(key);
    s.ids.push(g.id);
    if (SEV[g.severity] < SEV[s.severity]) s.severity = g.severity;
  }
  // sections follow the default order of the groups in them (their first group's place), so J walks the list in it
  const rankOf = new Map(model.groups.map(g => [g.id, g.order]));
  const order = list => [...list.values()].sort((a, b) => Math.min(...a.ids.map(id => rankOf.get(id))) - Math.min(...b.ids.map(id => rankOf.get(id))) || cmp(a.key, b.key));
  // every group is in `groups` (not only those shown): the page keeps its list still while the person works and
  // updates the rows it shows in place, whatever filter they match now (design §3.4)
  const lensName = id => model.lenses?.[id]?.name ? `${id} · ${model.lenses[id].name}` : id;
  for (const s of [...sections.values(), ...unchecked.values()]) if (by === 'lens') s.title = safe(lensName(s.key), 160);
  return {
    generation: model.generation, status, lens, q: needle, groupBy: by, counts, total: shown.length,
    sections: order(sections), unchecked: order(unchecked), groups: Object.fromEntries(model.groups.map(g => [g.id, publicGroup(g)])),
  };
}

export const sceneOut = s => (!s ? null : {
  key: s.key, run: s.run, id: safe(s.id, 200), route: safe(s.route, 200), person: s.person, state: s.state, viewport: s.viewport, h1: safeOrNull(s.h1, 120),
  label: safe(sceneLabelText(s), 80), status: safe(s.status, 40), reason: safeOrNull(s.reason, 120), redirected: s.redirected,
  finalPath: s.finalPath ? safe(redactUrl(s.finalPath), 200) : null, finalOrigin: safeOrNull(s.finalOrigin, 200),
  img: s.img ? { w: s.img.w, h: s.img.h, dpr: s.img.dpr, vh: s.img.vh, url: evidenceUrl(s.run, s.id, s.img.file), thumb: evidenceUrl(s.run, s.id, s.img.thumb) } : null,
});
export const evidenceUrl = (run, scene, file) => `/evidence/${run}/${encodeURIComponent(scene)}/${file}`;

function evidenceList(f) {
  const ev = f?.evidence || {};
  const secret = f?.rule === 'secret-in-client-bundle';
  const out = [];
  for (const k of Object.keys(ev).sort()) {
    if (k === 'masked' || (secret && k !== 'kind' && k !== 'url')) continue;      // location and kind only
    const v = ev[k];
    if (v === null || v === undefined) continue;
    const isUrl = ['url', 'href', 'src', 'finalPath', 'path'].includes(k) && typeof v === 'string';
    out.push({ k: safe(k, 80), v: safe(isUrl ? redactUrl(v) : typeof v === 'string' ? v : JSON.stringify(deepClean(v)), 400), mono: !(typeof v === 'string' && !isUrl) });
  }
  return out;
}

// /api/groups/:id: one group with its instances, scenes, evidence, history and code location.
export function groupDetail(model, id) {
  const g = model.byId.get(id);
  if (!g) return null;
  const scenes = {};
  const instances = g._inst.map(f => {
    const ev = f.run ? model.evidenceOf(f.run) : null;
    const s = ev && f.scene ? ev.sceneById.get(f.scene) : null;
    if (s) scenes[s.key] = sceneOut(s);
    const code = codeOf(f);
    return { fp: f.fp, scene: s ? s.key : null, viewport: s ? s.viewport : f.viewport, state: s ? s.state : null, route: safeOrNull(f.route, 200), selector: safeOrNull(f.selector, 300),
      box: f.box, inside: safeOrNull(f.inside, 200), drawable: drawable(f, s?.img), code: code ? { file: safe(code.file, 300), line: code.line } : null };
  });
  // decisions on the group or its fingerprints, newest first, with how each was made
  const led = model.led;
  const fps = new Set(g._rows.map(r => r.fp));
  const moved = currentTargets(led.decisions, led.state);
  const history = moved.filter(d => d.target.group === g.id || fps.has(d.target.fp)).map(d => {
    const key = approvalKey(writtenAs(d));
    const verified = led.approved.has(key);
    const channel = !verified ? 'git' : led.channels.get(key) || 'unknown';
    return decisionOut({ ...d, channel, human: verified && (HUMAN_CHANNELS.has(channel) || led.confirmed.has(key)) });
  }).sort((a, b) => cmp(b.at || '', a.at || '') || cmp(b.id, a.id));
  const first = g._inst.find(f => f.scene) || g._inst[0];
  const code = g._inst.map(codeOf).find(Boolean) || null;
  const verification = g._rows.map(r => r.verification).find(Boolean);
  const notes = [...new Set(g._rows.map(r => r.note).filter(Boolean))].map(n => safe(n, 300));
  const rowsOut = g._rows.map(r => ({ fp: r.fp, route: safeOrNull(r.route, 200), status: r.status, firstSeen: r.firstSeen ?? null, lastSeen: r.lastSeen ?? null, regressedAt: r.regressedAt ?? null, goneAt: r.goneAt ?? null }));
  return {
    ...publicGroup(g), instances, scenes, history, fixes: fixHistory(model, g.id), notes, rows: rowsOut, fps: [...fps].sort(), compare: compareOf(model, g),
    evidence: evidenceList(first), selector: safeOrNull(first?.selector, 300), box: first?.box || null,
    secret: g.rule === 'secret-in-client-bundle' ? { where: safe(redactUrl(String(first?.evidence?.url || '')), 300), kind: safe(first?.evidence?.kind || '', 80) } : null,
    code: codeOut(model.projectDir, code),
    verification: verification ? { status: safe(verification.status, 20), by: safeOrNull(verification.by, 80), vendor: safeOrNull(verification.vendor, 40), suspect: !!verification.suspect, tooFewDecoys: verification.tooFewDecoys === true, run: safeOrNull(verification.run, 12) } : null,
  };
}

// Before and after a fix (design §3.4), for both viewports: the probes P0 and P1 of the group's latest attempt, the same
// screen of each — the screen where the fix changed the most (drift is measured over every route of the scope), else
// the group's own route, its normal state first. → [{ viewport, route, before, after }] or [].
export function compareOf(model, g) {
  if (!g.fix?.before || !g.fix?.after) return [];
  const a = model.evidenceOf(g.fix.before), b = model.evidenceOf(g.fix.after);
  const routes = new Set(g._rows.map(r => r.route).filter(Boolean));
  const drift = g.fix.drift || [];
  const out = [];
  for (const vp of VPS) {
    const both = b.scenes.filter(s => s.viewport === vp && s.img && a.sceneById.get(s.id)?.img);
    const changed = drift.map(id => both.find(s => s.id === id)).filter(Boolean);
    const cands = changed.length ? changed : both.filter(s => routes.has(s.route)).sort((x, y) => rank(STATES, x.state) - rank(STATES, y.state) || cmp(x.id, y.id));
    if (cands.length) out.push({ viewport: vp, route: safe(cands[0].route, 200), before: sceneOut(a.sceneById.get(cands[0].id)), after: sceneOut(cands[0]) });
  }
  return out;
}

// /api/screens: the latest run's screens, each with what is open on it (rule findings of the run; AI findings last
// seen there), badge words as the static export has them.
export function screenWall(model) {
  const ev = model.latestEv;
  if (!ev) return { run: null, scenes: [] };
  const onScene = new Map();
  const add = (sceneId, f, g) => { if (!onScene.has(sceneId)) onScene.set(sceneId, []); onScene.get(sceneId).push({ f, g }); };
  for (const g of model.groups) for (const f of g._inst) if (f.run === ev.runId && f.scene) add(f.scene, f, g);
  const scenes = ev.scenes.map(s => {
    const list = (onScene.get(s.id) || []).slice().sort((a, b) => SEV[a.g.severity] - SEV[b.g.severity] || cmp(a.g.headline, b.g.headline) || cmp(a.f.fp, b.f.fp));
    const open = list.filter(x => x.g.active);
    const by = {}; for (const x of open) by[x.g.severity] = (by[x.g.severity] || 0) + 1;
    const sevs = Object.keys(by).sort((a, b) => SEV[a] - SEV[b]);
    let badge, kind, note;
    if (s.reason === 'redirected-off-origin') { badge = 'Left the app'; kind = 'dark'; note = `Sent to ${s.finalOrigin || 'another site'}`; }
    else if (s.status !== 'captured') { badge = 'Not seen'; kind = 'dark'; note = s.reason || s.status; }
    else if (s.redirected && list.some(x => x.g.rule === 'signed-in-bounced')) { badge = 'Sent to sign-in'; kind = 'dark'; note = 'Signed in, but shown the sign-in page'; }
    else if (s.redirected) { badge = 'Redirected'; kind = 'low'; note = `Shows ${redactUrl(s.finalPath || '')}`; }
    else if (!list.length) { badge = 'Clean'; kind = 'clean'; note = 'Nothing found'; }
    else if (!open.length) { badge = 'Nothing open'; kind = 'clean'; note = `${plural(list.length, 'finding')}, all decided`; }
    else { badge = sevs.slice(0, 2).map(k => `${by[k]} ${k}`).join(' · '); kind = sevs[0]; note = open.length === 1 ? open[0].g.headline : plural(open.length, 'open finding'); }
    let n = 0;
    const findings = list.map(({ f, g }) => {
      const d = drawable(f, s.img);
      return { group: g.id, severity: g.severity, source: g.source, status: g.status, statusText: STATUS_LABEL[g.status] || 'Mixed', headline: g.headline, box: f.box, n: d.ok ? ++n : null, why: d.ok ? null : d.why };
    });
    return { ...sceneOut(s), badge: safe(badge, 60), kind, note: safe(note, 120), findings };
  });
  return { run: ev.runId, scenes };
}
