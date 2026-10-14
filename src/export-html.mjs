// `nunchi export --html <dir>` (spec §7, design 0.1-c §3 and §5): one completed run plus the ledger as a static,
// offline review page — index.html and img/. The read-only precursor of the live board (`nunchi open`).
//
// - Deterministic: the same run, ledger and decisions give the same bytes. No clock, no random ids: every id
//   in the page is a hash of data, images are named by the hash of their bytes, every list is sorted.
// - Everything the app or the ledger wrote (page text, selectors, claims, decision notes, URLs) is data. It is
//   HTML-escaped and secret-scrubbed before it reaches the page; app URLs are never live links.
// - Only the run's manifest, findings, AI findings, verdict summary, coverage and screenshots are read. HAR
//   recordings, network.json, console.json, text.txt and aria.yml are never opened, so no cookie, header,
//   token or network body can reach the page. Secret findings show location and kind, never the value.
// - The page's CSP allows no external load at all: images from the page's own folder (or inlined), inline
//   style, and the one inline script by its hash. The page works without that script (views are :target
//   sections, filters are radio buttons); the script only marks the current view and adds Copy buttons.
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, lstatSync, readdirSync, unlinkSync, renameSync, realpathSync, rmdirSync, constants as FS } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readState, foldRun, foldAi, foldOf, readDecisions, readApproved, view, groups as groupRows, titleOf, annotate, runForFold, migrateState, noteDecisions, byRun, originOf, FINGERPRINT_VERSION } from './ledger.mjs';
import { stateRoot, stateFiles } from './state.mjs';
import { foldFinding } from './ai-fold.mjs';
import { readManifest, jpegSize, sceneIndex, sceneDir } from './hunt.mjs';
import { scrubSecrets } from './rules.mjs';
import { redactUrl, redactText } from './network.mjs';
import { sha } from './stable.mjs';

const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
const SEV_LABEL = { blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low' };
const ACTIVE = new Set(['open', 'regressed', 'to-fix', 'held']);
// Board words (design §3.4): one table, so a Korean toggle is cheap later.
const STATUS_LABEL = { open: 'Open', regressed: 'Came back', 'to-fix': 'To fix', held: 'Later', kept: 'Kept', dismissed: 'Not a problem', fixed: 'Fixed' };
const FILTERS = [['open', 'Open'], ['to-fix', 'To fix'], ['held', 'Later'], ['kept', 'Kept'], ['dismissed', 'Not a problem'], ['fixed', 'Fixed'], ['all', 'All']];
const WHO = { guest: 'Visitor', 'signed-in': 'Signed in' };
const WIDTH = { d: 'Desktop', m: 'Phone' };
const STATES = ['normal', 'empty', 'error', 'slow', 'offline'];
const STATE_LABEL = { normal: 'Normal', empty: 'Empty', error: 'Error', slow: 'Slow', offline: 'Offline' };
const PERSONS = ['guest', 'signed-in'];
const VPS = ['d', 'm'];
const CONTEXT_PX = 200;                                    // design §3.4: the box plus about 200 px of context

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
const readJsonOr = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// Redaction of one string: credential URL parts and query values, then secret shapes (design §5).
const clean = s => scrubSecrets(redactText(String(s ?? '')));
// The one way data reaches the markup: redacted first, then clipped (so a cut never leaves part of a secret), then
// escaped. Every string that did not come from this file goes through here.
const t = (s, n = 0) => escapeHtml(n ? clip(clean(s), n) : clean(s));
// Objects and arrays are redacted leaf by leaf before they are serialised (a JSON `\n` would hide a word boundary).
const deepClean = v => (Array.isArray(v) ? v.map(deepClean)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [clean(k), deepClean(v[k])]))
  : typeof v === 'string' ? clean(v) : v);
// Run files are data too: values that become ids, class names or numbers in the markup are checked here, at the
// edge, so a tampered findings.json or manifest.json can never add markup through them.
const HEX12 = /^[0-9a-f]{12}$/;
const idOf = v => (typeof v === 'string' && HEX12.test(v) ? v : sha(String(v ?? ''), 12));
const sevOf = v => (Object.hasOwn(SEV, v) ? v : 'low');
const stOf = v => (Object.hasOwn(STATUS_LABEL, v) ? v : 'open');
const vpCls = v => (VPS.includes(v) ? v : 'x');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = v => (typeof v === 'string' ? v : null);
const box4 = b => (Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(n => typeof n === 'number' && Number.isFinite(n)) ? b.slice(0, 4) : null);
const normFinding = f => ({
  ...f, lens: String(f.lens ?? ''), rule: String(f.rule ?? ''), severity: sevOf(f.severity), fp: idOf(f.fp), group: idOf(f.group),
  scene: str(f.scene), route: str(f.route), viewport: str(f.viewport), selector: str(f.selector), box: box4(f.box), inside: str(f.inside),
  evidence: f.evidence && typeof f.evidence === 'object' && !Array.isArray(f.evidence) ? f.evidence : {},
});
const normRow = r => ({
  ...r, lens: String(r.lens ?? ''), rule: String(r.rule ?? ''), severity: sevOf(r.severity), fp: idOf(r.fp), group: idOf(r.group), status: stOf(r.status),
  route: str(r.route), places: num(r.places) || 1, examples: Array.isArray(r.examples) ? r.examples.filter(x => typeof x === 'string') : [],
});
const normScene = s => ({
  ...s, id: s.id, route: str(s.route) ?? '', person: String(s.person ?? ''), state: String(s.state ?? ''), viewport: String(s.viewport ?? ''),
  status: String(s.status ?? ''), reason: str(s.reason), finalPath: str(s.finalPath), finalOrigin: str(s.finalOrigin),
});
const RUN_ID = /^\d{4,}$/;
const later = (id, than) => typeof id === 'string' && RUN_ID.test(id) && byRun(id, than) > 0;

// The ledger as it stood right after `runId`: the runs up to it folded again from their folders exactly as the
// ledger folds them (runForFold, foldRun, then the fingerprint migration). When one of those folders is gone (gc)
// or cannot be read, the current ledger is rewound instead: what came later is undone where the state still
// says so (fixed, came back or looked at later). `asOfNow` says which.
function stateAt(state, runId, runsDir) {
  const ids = state.runs.filter(id => !later(id, runId));
  try {
    let acc = { schema: 1, fingerprintVersion: 1, runs: [], items: {} };
    for (const id of ids) {
      if (!RUN_ID.test(id)) throw new Error('not a run id');
      acc = foldRun(acc, runForFold(join(runsDir, id)));
    }
    return { state: migrateState(acc), asOfNow: false };
  } catch {
    const items = {};
    for (const [fp, it] of Object.entries(state.items)) {
      if (later(it.firstSeen, runId)) continue;
      items[fp] = { ...it, goneAt: later(it.goneAt, runId) ? null : it.goneAt, regressedAt: later(it.regressedAt, runId) ? null : it.regressedAt,
        lastSeen: later(it.lastSeen, runId) ? runId : it.lastSeen, ...(it.lookedAt ? { lookedAt: later(it.lookedAt, runId) ? runId : it.lookedAt } : {}) };
    }
    const blind = Object.fromEntries(Object.entries(state.blind || {}).filter(([id]) => !later(id, runId)));
    return { state: { ...state, runs: ids, items, blind }, asOfNow: true };
  }
}
// `now` for the ledger's view, taken from the data (never the clock, so two exports are the same bytes): the
// latest decision date or first-seen time. Decisions this machine has not noted yet count as arriving then.
function dataNow(state, decisions) {
  const times = [...Object.values(state.decisionsSeen || {}).map(Number), ...decisions.map(d => Date.parse(d?.at))].filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}
const pct = n => `${Math.round(n * 10000) / 100}%`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const human = rule => { const r = String(rule).replace(/^L\d+\./, '').replace(/-/g, ' '); return r.charAt(0).toUpperCase() + r.slice(1); };

// ---- model ---------------------------------------------------------------------------------------------

// Reads one run and the ledger through the ledger's own functions; nothing here re-parses what they parse.
export function buildModel({ runDir, nunchiDir, ledger = null }) {
  const manifest = readManifest(runDir);
  const meta = readJsonOr(join(runDir, 'run.json'), {});
  const runId = meta.id ?? null;
  const ruleFindings = readJsonOr(join(runDir, 'findings.json'), { findings: [] }).findings || [];
  const aiDoc = readJsonOr(join(runDir, 'ai-findings.json'), null);
  // rejected and insufficient claims never become items (design §2.2); they stay in ai-findings.json for trust
  const aiFindings = aiDoc ? (Array.isArray(aiDoc) ? aiDoc : aiDoc.findings || []).filter(f => f && f.source === 'ai' && (f.status === 'confirmed' || f.status === 'claimed')) : null;
  const verify = readJsonOr(join(runDir, 'verify.json'), null);
  const coverage = readJsonOr(join(runDir, 'coverage.json'), null);
  const flow = readJsonOr(join(runDir, 'flow.json'), null);

  // the ledger through its own functions: the CLI brings it up to date first (syncLedger) and passes it in; else it
  // is read from the state store this project uses (state.mjs: the repository's shared folder, or .nunchi/state)
  const root = ledger?.st?.root ?? (ledger ? null : stateRoot(dirname(nunchiDir)));
  const files = ledger ? null : stateFiles(root.dir);
  const stream = root?.stream ?? 'main';
  const state = ledger?.state ?? readState(files.ledger);
  const decisions = ledger?.decisions ?? readDecisions(join(nunchiDir, 'decisions'));
  const approved = ledger?.approved ?? readApproved(files.approved);
  const now = dataNow(state, decisions);
  const seen = noteDecisions(state, decisions, now);                // in memory only
  const fresh = list => annotate(list.filter(f => f && typeof f === 'object').map(({ fp, group, ...f }) => f)).map(normFinding);
  const inLedger = runId !== null && state.runs.includes(runId);
  const latest = state.runs.length ? state.runs[state.runs.length - 1] : null;
  const empty = { schema: 1, fingerprintVersion: 1, runs: [], items: {} };
  // A run the local ledger has not folded (a --out folder, a fresh clone) is folded here, in memory only, with
  // fingerprints of the current version. An older run is shown as the ledger stood after it.
  let ruleState = seen, asOfNow = false, rules;
  if (!inLedger) {
    rules = fresh(Array.isArray(ruleFindings) ? ruleFindings : []);
    ruleState = noteDecisions(foldRun({ ...empty, fingerprintVersion: FINGERPRINT_VERSION }, { id: runId ?? 'this run', scope: meta.scope || {}, wholeApp: meta.wholeApp === true,
      health: manifest.health || { problems: [] }, scenes: Array.isArray(manifest.scenes) ? manifest.scenes : [], findings: rules, origin: originOf(manifest.baseUrl) }), decisions, now);
  } else {
    if (runId !== latest) { ({ state: ruleState, asOfNow } = stateAt(state, runId, join(nunchiDir, 'runs'))); ruleState = { ...ruleState, decisionsSeen: seen.decisionsSeen }; }
    // a run captured under an older fingerprint version: its findings are named as the ledger names them now
    const alias = ruleState.aliases || {};
    const list = (Array.isArray(ruleFindings) ? ruleFindings : []).filter(f => f && typeof f === 'object');
    rules = (list.every(f => f.fp && f.group) ? list : annotate(list.map(({ fp, group, ...f }) => f)))
      .map(f => normFinding({ ...f, fp: alias.fp?.[f.fp] || f.fp, group: alias.group?.[f.group] || f.group }));
  }
  // AI findings (design §2.2): from the ledger when `verify --record` folded this run's (the latest run's) AI findings
  // into it; otherwise folded here, in memory only, as the ledger would, so their decisions still apply by
  // fingerprint and group.
  const ai = aiFindings ? fresh(aiFindings) : [];
  const aiInLedger = inLedger && runId === latest && !!foldOf(ruleState, runId, 'ai', stream);
  const aiState = aiInLedger ? null : noteDecisions(foldAi({ ...empty, fingerprintVersion: FINGERPRINT_VERSION }, { run: runId ?? 'this run', findings: ai.map(f => foldFinding(f)), now }), decisions, now);
  const present = new Set([...rules, ...ai].map(f => f.fp));
  const rows = [...view(ruleState, decisions, approved, { now }).filter(r => aiInLedger || r.source !== 'ai'), ...(aiState ? view(aiState, decisions, approved, { now }) : [])].map(normRow)
    .filter(r => present.has(r.fp) || (inLedger && r.goneAt === runId));
  // a run that could not tell what was fixed (the app unreachable, the recording stale, every screen the same page)
  const blind = inLedger && ruleState.blind ? str(ruleState.blind[runId]) : null;

  // scenes, in the wall's order (flow.json R7), canary copies left out
  const routeOrder = flow?.order || [];
  // a scene id is a folder name: one that is not a single plain path segment is left out, never opened
  const scenes = (Array.isArray(manifest.scenes) ? manifest.scenes : []).filter(s => s && s.canary === undefined && sceneDir(runDir, s.id)).map(normScene);
  const firstSeenRoute = new Map(); scenes.forEach((s, i) => { if (!firstSeenRoute.has(s.route)) firstSeenRoute.set(s.route, i); });
  const routeRank = r => { const i = routeOrder.indexOf(r); return i < 0 ? routeOrder.length + firstSeenRoute.get(r) : i; };
  scenes.sort((a, b) => routeRank(a.route) - routeRank(b.route) || rank(PERSONS, a.person) - rank(PERSONS, b.person)
    || rank(VPS, a.viewport) - rank(VPS, b.viewport) || rank(STATES, a.state) - rank(STATES, b.state) || cmp(a.id, b.id));
  const vpById = Object.fromEntries((manifest.viewports || []).map(v => [v.id, v]));
  const images = new Map();
  const sceneById = new Map();
  scenes.forEach((s, i) => {
    s.order = i;
    s.hid = 's-' + sha(s.id, 10);
    const dir = sceneDir(runDir, s.id);
    const m = readJsonOr(join(dir, 'measure.json'), {});
    s.h1 = typeof m.h1 === 'string' ? m.h1 : Array.isArray(m.h1) && typeof m.h1[0] === 'string' ? m.h1[0] : null;
    s.img = null;
    const fullPath = join(dir, 'full.jpg'), topPath = join(dir, 'top.jpg');
    const file = existsSync(fullPath) ? fullPath : existsSync(topPath) ? topPath : null;
    if (file && s.status === 'captured') {
      const buf = readFileSync(file);
      const size = jpegSize(buf);
      if (size && size.width && size.height) {
        const key = sha(buf, 16);
        if (!images.has(key)) images.set(key, { key, file, bytes: buf.length });
        // screenshot pixels per CSS pixel: the first-view image is exactly the viewport
        const top = file === topPath ? size : existsSync(topPath) ? jpegSize(readFileSync(topPath)) : null;
        const vp = vpById[s.viewport];
        const dpr = vp && top && top.width ? top.width / vp.width : 1;
        s.img = { key, w: size.width, h: size.height, dpr, vh: vp ? Math.round(vp.height * dpr) : size.height };
      }
    }
    sceneById.set(s.id, s);
  });

  // finding instances of this run, with the box from the scene's evidence when the finding has none
  const indexes = new Map();
  const boxOf = f => {
    if (!f.scene || !sceneById.has(f.scene)) return { box: null, inside: f.inside || null };
    if (Array.isArray(f.box)) return { box: f.box, inside: f.inside || null };
    if (!f.selector) return { box: null, inside: f.inside || null };
    if (!indexes.has(f.scene)) indexes.set(f.scene, sceneIndex(runDir, f.scene).idx);
    const hit = indexes.get(f.scene).get(f.selector);
    return { box: box4(hit?.box), inside: f.inside || str(hit?.inside) };
  };
  const instances = [...rules.map(f => ({ ...f, source: 'rule' })), ...ai.map(f => ({ ...f, source: 'ai', aiStatus: f.status }))]
    .map(f => ({ ...f, ...boxOf(f) }));
  const rowByFp = new Map(rows.map(r => [r.fp, r]));
  for (const f of instances) f.row = rowByFp.get(f.fp) || null;
  const sceneRank = id => (sceneById.has(id) ? sceneById.get(id).order : Number.MAX_SAFE_INTEGER);
  instances.sort((a, b) => sceneRank(a.scene) - sceneRank(b.scene) || SEV[a.severity] - SEV[b.severity] || cmp(a.rule, b.rule) || cmp(String(a.selector), String(b.selector)) || cmp(a.fp, b.fp));

  const groups = groupRows(rows).map(g => {
    const own = instances.filter(f => f.group === g.group);
    const ais = own.filter(f => f.source === 'ai');
    const isAi = ais.length > 0 || g.example.inputs?.source === 'ai' || rows.some(r => r.group === g.group && ai.some(f => f.fp === r.fp));
    const verified = ais.some(f => f.aiStatus === 'confirmed');
    const suspect = ais.some(f => f.verification?.suspect);
    const keys = new Set(Object.keys(g.statuses));
    if (keys.has('regressed')) keys.add('open');
    return {
      ...g, hid: 'f-' + g.group, instances: own, source: isAi ? 'ai' : 'rule',
      ai: isAi ? { verified, suspect, verifier: ais.find(f => f.verification)?.verification?.verifier || null } : null,
      title: isAi ? human(g.rule) : g.title,
      headline: isAi ? String(own[0]?.evidence?.claim || human(g.rule)) : g.title,
      filterKeys: [...keys].sort(),
      active: [...keys].some(k => ACTIVE.has(k)),
      rows: rows.filter(r => r.group === g.group),
    };
  });
  // kinds: one section per rule, worst first; AI items not double-checked go last, collapsed (design §3.4)
  const kindMap = new Map();
  for (const g of groups) {
    const k = `${g.ai && !g.ai.verified ? 1 : 0}|${g.rule}`;
    if (!kindMap.has(k)) kindMap.set(k, { key: k, rule: g.rule, lens: g.lens, title: g.title, severity: g.severity, unchecked: !!(g.ai && !g.ai.verified), groups: [] });
    const kind = kindMap.get(k);
    kind.groups.push(g);
    if (SEV[g.severity] < SEV[kind.severity]) kind.severity = g.severity;
  }
  const kinds = [...kindMap.values()].sort((a, b) => Number(a.unchecked) - Number(b.unchecked) || SEV[a.severity] - SEV[b.severity] || b.groups.length - a.groups.length || cmp(a.rule, b.rule));
  const ordered = kinds.flatMap(k => k.groups);

  return { runId, latest, asOfNow, blind, meta, manifest, inLedger, scenes, sceneById, images, instances, groups: ordered, kinds, rows, ai: aiFindings !== null, verify, coverage };
}

// ---- rendering helpers ----------------------------------------------------------------------------------

const sevChip = s => `<span class="sev sev-${sevOf(s)}"><span class="dot" aria-hidden="true"></span>${SEV_LABEL[sevOf(s)]}</span>`;
const statusChip = st => (STATUS_LABEL[st] ? `<span class="st st-${st}">${STATUS_LABEL[st]}</span>` : '<span class="st st-mixed">Mixed</span>');
const statusChips = g => (g.status === 'mixed' ? Object.keys(g.statuses).sort((a, b) => rank(Object.keys(STATUS_LABEL), a) - rank(Object.keys(STATUS_LABEL), b)).map(statusChip).join(' ') : statusChip(g.status));
// An open item no run has looked at again for a while (ledger NOT_LOOKED_RUNS): the oldest such run of the group.
const notLooked = g => g.rows.map(r => str(r.notLookedAt)).filter(Boolean).sort(byRun)[0] || null;
const sourceTag = g => (!g.ai ? '<span class="tag">Rule</span>'
  : g.ai.verified ? `<span class="tag tag-ai">AI · double-checked${g.ai.suspect ? ' (suspect)' : ''}</span>` : '<span class="tag tag-warn">AI · not double-checked</span>');
// plain text (for aria-label, which t() escapes once) and markup
const sceneLabelText = s => `${WHO[s.person] || s.person} · ${WIDTH[s.viewport] || s.viewport} · ${STATE_LABEL[s.state] || s.state}`;
const sceneLabel = s => t(sceneLabelText(s));
const whereOf = g => {
  if (!g.routes.length) return g.rule === 'secret-in-client-bundle' ? 'Browser bundle' : 'Whole app';
  const shown = g.routes.slice(0, 2).map(r => `<span class="mono">${t(r)}</span>`).join(', ');
  const more = g.routes.length > 2 ? ` +${g.routes.length - 2} more` : '';
  const n = new Set(g.instances.map(f => f.scene).filter(Boolean)).size;
  return `${shown}${more}${n ? ` · ${plural(n, 'screen')}` : ''}`;
};

// A screenshot region as a background image (one CSS rule per image, so inlined images are never repeated),
// with boxes positioned in percentages of the region. `boxes` are in CSS pixels of the page.
function shot(s, { boxes = [], crop = false, label, cls = '' }) {
  const img = s.img;
  const px = boxes.map(b => ({ ...b, x: b.box[0] * img.dpr, y: b.box[1] * img.dpr, w: b.box[2] * img.dpr, h: b.box[3] * img.dpr }));
  let cy = 0, ch = img.h;
  if (crop && px.length) {
    const ctx = CONTEXT_PX * img.dpr;
    let top = Math.max(0, Math.min(...px.map(b => b.y)) - ctx), bottom = Math.min(img.h, Math.max(...px.map(b => b.y + b.h)) + ctx);
    const want = Math.min(img.h, img.vh);
    if (bottom - top < want) { bottom = Math.min(img.h, top + want); top = Math.max(0, bottom - want); }
    cy = Math.round(top); ch = Math.max(1, Math.round(bottom - top));
  }
  const posY = ch >= img.h ? 0 : cy / (img.h - ch);
  const marks = px.map(b => {
    const style = `left:${pct(b.x / img.w)};top:${pct((b.y - cy) / ch)};width:${pct(b.w / img.w)};height:${pct(b.h / ch)}`;
    return `<span class="box" style="${style}">${b.n ? `<span class="num">${b.n}</span>` : ''}</span>`;
  }).join('');
  return `<div class="shot i-${img.key}${cls ? ' ' + cls : ''}" role="img" aria-label="${t(label)}" style="aspect-ratio:${img.w} / ${ch};background-position:0 ${pct(posY)}">${marks}</div>`;
}

// Where a box can be drawn: an element box, not in a scroll area the image cannot show, inside the image.
function drawable(f, s) {
  if (!s || !s.img) return { ok: false, why: 'no screenshot' };
  if (!Array.isArray(f.box)) return { ok: false, why: 'no element box' };
  if (f.inside) return { ok: false, why: 'inside a scroll area, not in the image' };
  const [x, y, w, h] = f.box.map(v => v * s.img.dpr);
  if (!(w > 0 && h > 0)) return { ok: false, why: 'hidden element' };
  if (x >= s.img.w || y >= s.img.h || x + w <= 0 || y + h > s.img.h + 1) return { ok: false, why: 'outside the screenshot' };
  return { ok: true };
}

function evidenceList(f) {
  const ev = f.evidence || {};
  const secret = f.rule === 'secret-in-client-bundle';
  const out = [];
  for (const k of Object.keys(ev).sort()) {
    if (k === 'masked' || (secret && k !== 'kind' && k !== 'url')) continue;      // location and kind only
    const v = ev[k];
    if (v === null || v === undefined) continue;
    const isUrl = ['url', 'href', 'src', 'finalPath', 'path'].includes(k) && typeof v === 'string';
    const text = isUrl ? redactUrl(v) : typeof v === 'string' ? v : JSON.stringify(deepClean(v));
    out.push(`<dt>${t(k, 80)}</dt><dd class="${typeof v === 'string' && !isUrl ? '' : 'mono'}">${t(text, 400)}</dd>`);
  }
  return out.join('');
}

// One line that tells two groups of the same kind apart: the quoted value, the control's name, else the element.
const GIST_KEYS = ['text', 'name', 'message', 'href', 'src', 'value', 'placeholder', 'kind', 'summary', 'what'];
const gistOf = f => {
  if (!f) return '';
  const ev = f.evidence || {};
  for (const k of GIST_KEYS) if (typeof ev[k] === 'string' && ev[k].trim()) return ['href', 'src'].includes(k) ? redactUrl(ev[k]) : ev[k];
  return f.selector || '';
};

const codeOf = f => {
  const ev = f.evidence || {};
  if (typeof ev.file === 'string' && Number.isInteger(ev.line)) return `${ev.file}:${ev.line}`;
  if (typeof ev.file === 'string') return ev.file;
  return null;
};

// ---- views ----------------------------------------------------------------------------------------------

function progressView(m) {
  const active = m.groups.filter(g => g.active);
  const bySev = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const g of active) bySev[g.severity]++;
  const count = k => m.groups.filter(g => g.filterKeys.includes(k)).length;
  const problems = Array.isArray(m.manifest.health?.problems) ? m.manifest.health.problems : [];
  const checked = m.scenes.filter(s => s.status === 'captured' && !(s.reason && /^redirected/.test(s.reason))).length;
  const notSeen = m.scenes.filter(s => s.status !== 'captured');
  const bh = bySev.blocker + bySev.high;
  const severe = active.filter(g => SEV[g.severity] <= SEV.high);
  const decide = severe.filter(g => g.filterKeys.includes('open')).length, toFix = severe.filter(g => g.filterKeys.includes('to-fix')).length, later = severe.filter(g => g.filterKeys.includes('held')).length;
  let verdict, why = '';
  if (problems.some(p => p.status === 'app-unreachable' || p.status === 'login-expired')) verdict = 'Too early to say · this run had a problem';
  else if (bh) {
    verdict = `Not yet · ${[bySev.blocker && plural(bySev.blocker, 'blocker', 'blockers'), bySev.high && `${bySev.high} high`].filter(Boolean).join(', ')}`;
    why = [decide && `${decide} to decide`, toFix && `${toFix} to fix`, later && `${later} later`].filter(Boolean).join(' · ');
  } else if (!m.ai) verdict = 'Probably · rules only — the AI review hasn’t run';
  else if (notSeen.length) verdict = `Yes, for what was checked · ${plural(notSeen.length, 'screen')} not checked`;
  else verdict = 'Yes, for what was checked';
  const tiles = ['blocker', 'high', 'medium', 'low'].map(s => `<a class="tile${bySev[s] && SEV[s] <= SEV.high ? ` tile-${s}` : ''}" href="#findings"><span class="tile-k">${sevChip(s)}</span><span class="tile-n">${bySev[s]}</span></a>`).join('');
  const BLIND = { 'app-unreachable': 'most screens did not load', 'recording-stale': 'most screens asked for data the recording does not have', 'one-page': 'most screens showed one and the same page' };
  const WHY = { 'login-expired': 'the saved login no longer worked: signed-in screens showed the sign-in page and were not judged', 'app-unreachable': 'most screens did not load at all', 'recording-stale': 'most screens asked for data the recording does not have' };
  const since = m.inLedger ? (() => {
    const id = m.runId;
    const gs = pred => new Set(m.rows.filter(pred).map(r => r.group)).size;
    const fixed = gs(r => r.goneAt === id), fresh = gs(r => r.firstSeen === id && !r.goneAt), back = gs(r => r.regressedAt === id && !r.goneAt);
    const title = m.meta.parent ? `Since run ${t(m.meta.parent)}` : 'First run';
    return `<section class="panel-box" aria-labelledby="h-since"><h2 id="h-since">${title}</h2>
<ul class="facts"><li><b class="good">${fixed}</b> fixed</li><li><b>${fresh}</b> new</li>${back ? `<li><b class="warn">${back}</b> came back after a fix</li>` : ''}</ul>${m.runId !== m.latest ? `<p class="muted small">Run ${t(m.runId)} is not the latest (${t(m.latest)}): statuses are ${m.asOfNow ? 'as of now, with what was fixed or came back after it undone (its older runs are gone)' : 'as they stood after this run'}; decisions are as of now.</p>` : ''}</section>`;
  })() : '<section class="panel-box" aria-labelledby="h-since"><h2 id="h-since">Ledger</h2><p class="muted">This run is not in the local ledger, so there is nothing to compare with. Statuses come from your decisions only.</p></section>';
  const aiLine = !m.ai ? 'not run (rules and computed checks only)'
    : (() => {
      const n = m.instances.filter(f => f.source === 'ai').length, conf = m.instances.filter(f => f.source === 'ai' && f.aiStatus === 'confirmed').length;
      const cov = m.coverage?.summary;
      return `${plural(n, 'finding')}, ${conf} double-checked${cov ? ` · ${num(cov.seen)}/${num(cov.cells)} cells seen` : ''}${m.verify?.suspect ? ' · <span class="warn">verification suspect</span>' : ''}`;
    })();
  const pctChecked = m.scenes.length ? Math.round((checked / m.scenes.length) * 100) : 0;
  return `<section id="progress" class="view" tabindex="-1" aria-labelledby="h-progress">
<div class="stack">
<section class="panel-box hero" aria-labelledby="h-progress">
<div class="hero-top"><div><p class="eyebrow">Ready to ship?</p><h1 id="h-progress">${verdict}</h1>${why ? `<p class="muted">${why}</p>` : ''}</div>
<a class="btn btn-primary" href="#findings">Review findings</a></div>
<div class="tiles">${tiles}</div>
<p class="muted small">Open findings by severity: groups still open, to fix, or held for later. A group is one defect, however many screens show it.</p>
</section>
<div class="two">
${since}
<section class="panel-box" aria-labelledby="h-health"><h2 id="h-health">This run</h2>
<div class="meter-row"><span>Screens checked</span><a href="#screens">${checked} of ${m.scenes.length}</a></div>
<div class="meter" aria-hidden="true"><span style="width:${pctChecked}%"></span></div>
<ul class="facts">
<li>AI review: ${aiLine}</li>
${m.blind ? `<li class="warn">This run could not tell what was fixed: ${BLIND[m.blind] || t(m.blind)}. Nothing was marked fixed by it.</li>` : ''}
${notSeen.length ? `<li>${plural(notSeen.length, 'screen')} not seen: ${t([...new Set(notSeen.map(s => s.reason || s.status))].sort().join(', '))}</li>` : ''}
${problems.map(p => `<li class="warn">Run problem: ${t(p.status)} (${num(p.scenes)}/${num(p.of)} screens) — ${WHY[p.status] || ''}</li>`).join('')}
</ul></section>
</div>
<section class="panel-box" aria-labelledby="h-status"><h2 id="h-status">Decisions</h2>
<ul class="statuses">${FILTERS.filter(([k]) => k !== 'all').map(([k, label]) => `<li><span class="st st-${k}">${label}</span> <b>${count(k)}</b></li>`).join('')}</ul>
<p class="muted small">Decisions are made with <code>nunchi decide</code> in your terminal, or by telling your AI. This page is a read-only copy.</p>
</section>
</div></section>`;
}

function findingsView(m) {
  const count = k => (k === 'all' ? m.groups.length : m.groups.filter(g => g.filterKeys.includes(k)).length);
  const radios = FILTERS.map(([k, label]) => `<input type="radio" name="fs" id="fs-${k}" value="${k}"${k === 'open' ? ' checked' : ''}><label for="fs-${k}">${label} <span class="cnt">${count(k)}</span></label>`).join('');
  const row = g => `<li class="row" data-st="${g.filterKeys.join(' ')}"><a href="#${g.hid}">
<span class="row-main">${g.ai ? `<span class="row-what">${t(g.headline, 160)}</span><span class="row-where">${whereOf(g)}</span>` : `<span class="row-what">${whereOf(g)}</span>${g.instances.length ? `<span class="row-where">${t(gistOf(g.instances[0]), 120)}</span>` : ''}`}</span>
<span class="row-tags">${notLooked(g) ? `<span class="tag tag-warn">Not looked at since run ${t(notLooked(g))}</span> ` : ''}${sourceTag(g)} ${statusChips(g)}</span></a></li>`;
  const kind = k => `<details class="kind" data-st="${[...new Set(k.groups.flatMap(g => g.filterKeys))].sort().join(' ')}"${k.severity === 'low' ? '' : ' open'}>
<summary><span class="kind-title">${sevChip(k.severity)} <span>${t(k.title)}</span></span><span class="muted small">${plural(k.groups.length, 'group')}</span></summary>
<ul class="rows">${k.groups.map(row).join('')}</ul></details>`;
  const checked = m.kinds.filter(k => !k.unchecked), unchecked = m.kinds.filter(k => k.unchecked);
  const empties = FILTERS.filter(([k]) => count(k) === 0).map(([k]) => `<p class="empty" data-for="${k}">Nothing here.</p>`).join('');
  return `<section id="findings" class="view" tabindex="-1" aria-labelledby="h-findings">
<div class="stack">
<div class="head-row"><h1 id="h-findings">Findings</h1><p class="muted">${plural(m.groups.length, 'group')} in this run, by kind, worst first</p></div>
<fieldset class="seg seg-wrap"><legend class="sr">Status</legend>${radios}</fieldset>
<div class="list-box">${checked.map(kind).join('')}${empties}</div>
${unchecked.length ? `<details class="list-box unchecked"><summary class="unchecked-sum">Not double-checked by the AI <span class="muted">(${unchecked.reduce((n, k) => n + k.groups.length, 0)})</span></summary>
<p class="muted small pad">Claims the AI made that no second reviewer has looked at. Ask your AI to double-check them (<code>nunchi verify --plan</code>).</p>
${unchecked.map(kind).join('')}</details>` : ''}
${m.groups.length ? '' : '<p class="clean-note">Clean · nothing found in this run.</p>'}
</div></section>`;
}

function decideBlock(g) {
  const cmd = (d, extra = '') => `nunchi decide ${g.group} ${d}${extra}`;
  const items = [
    ['fix', 'Fix', 'Let the AI fix it', cmd('fix')],
    ['keep', 'Keep', 'Real, but leave it', cmd('keep', ' --reason intended')],
    ['fp', 'Not a problem', 'nunchi got it wrong', cmd('false-positive', ' --reason not-a-problem')],
    ['later', 'Later', 'Still counts for shipping', cmd('hold')],
  ];
  return `<section class="decide" aria-labelledby="d-${g.group}"><h2 id="d-${g.group}">Decide</h2>
<p class="muted small">Read-only copy: run one of these in your terminal, or tell your AI what you chose.</p>
<ul class="cmds">${items.map(([k, label, sub, c]) => `<li><span class="cmd-label"><b>${label}</b><span class="muted small">${sub}</span></span><code id="c-${g.group}-${k}" class="cmd">${t(c)}</code><button type="button" class="copy" data-copy="c-${g.group}-${k}">Copy</button></li>`).join('')}</ul></section>`;
}

function detailView(m, g, prev, next) {
  const inst = g.instances;
  const pick = vp => {
    const c = inst.filter(f => f.viewport === vp && m.sceneById.get(f.scene)?.img);
    const score = f => (drawable(f, m.sceneById.get(f.scene)).ok ? 0 : 2) + (m.sceneById.get(f.scene).state === 'normal' ? 0 : 1);
    return c.sort((a, b) => score(a) - score(b) || m.sceneById.get(a.scene).order - m.sceneById.get(b.scene).order)[0] || null;
  };
  const figs = VPS.map(vp => pick(vp)).filter(Boolean);
  const figure = (f, vp) => {
    const s = m.sceneById.get(f.scene);
    const same = inst.filter(x => x.scene === f.scene);
    const boxes = same.filter(x => drawable(x, s).ok).map(x => ({ box: x.box }));
    const not = same.map(x => drawable(x, s)).find(d => !d.ok);
    return `<div class="fig fig-${vp}"><p class="muted small">${t(s.route)} · ${sceneLabel(s)} <a href="#${s.hid}">Screen</a></p>
${shot(s, { boxes, crop: true, label: `Screenshot of ${s.route}, ${sceneLabelText(s)}${boxes.length ? ', with the element outlined' : ''}` })}
${!boxes.length && not ? `<p class="muted small">Not outlined: ${not.why}.</p>` : ''}
${s.img && boxes.length ? `<details class="whole"><summary>Whole screen</summary>${shot(s, { boxes, label: `Whole screenshot of ${s.route}, ${sceneLabelText(s)}` })}</details>` : ''}</div>`;
  };
  const toggle = figs.length > 1 ? `<fieldset class="seg"><legend class="sr">Width</legend>${figs.map((f, i) => `<input type="radio" class="vt-${f.viewport}" name="v-${g.group}" id="v-${g.group}-${f.viewport}"${i === 0 ? ' checked' : ''}><label for="v-${g.group}-${f.viewport}">${WIDTH[f.viewport]}</label>`).join('')}</fieldset>` : '';
  const first = inst[0] || null;
  const code = inst.map(codeOf).find(Boolean);
  const seen = [...new Set(inst.map(f => f.scene).filter(Boolean))].map(id => m.sceneById.get(id)).filter(Boolean);
  const row = g.rows[0];
  const fixedOnly = !inst.length;
  const verification = inst.find(f => f.verification)?.verification;
  const decision = g.rows.map(r => r.decision).find(Boolean);
  const notes = [...new Set(g.rows.map(r => r.note).filter(Boolean))];
  const examples = fixedOnly ? [...new Set(g.rows.flatMap(r => r.examples || []))].sort() : [];
  return `<article id="${g.hid}" class="view detail" data-view="findings" tabindex="-1" aria-labelledby="h-${g.group}">
<nav class="detail-nav" aria-label="Finding navigation"><a href="#findings">← All findings</a><span class="pn">${prev ? `<a href="#${prev.hid}" rel="prev">Previous</a>` : ''}${next ? `<a href="#${next.hid}" rel="next">Next</a>` : ''}</span></nav>
<div class="panel-box detail-box">
<header class="detail-head"><p class="chips">${sevChip(g.severity)} <span class="muted">${t(g.title)}</span> ${sourceTag(g)} ${statusChips(g)}</p>
<h1 id="h-${g.group}">${t(g.headline, 160)}</h1></header>
${fixedOnly ? `<p>Gone on re-capture in run ${t(m.runId)} (last seen in run ${t(row.lastSeen)}).</p>${examples.length ? `<p class="muted small">Where it was: ${examples.map(id => (m.sceneById.has(id) ? `<a href="#${m.sceneById.get(id).hid}">${t(id)}</a>` : `<span class="mono">${t(id)}</span>`)).join(', ')}</p>` : ''}` : ''}
${figs.length ? `${toggle}${figs.map(f => figure(f, f.viewport)).join('')}` : !fixedOnly ? '<p class="muted">No screenshot: this finding belongs to the whole app, not one screen.</p>' : ''}
<dl class="facts-dl">
${code ? `<dt>Code</dt><dd class="mono">${t(code)}</dd>` : ''}
${first?.rule === 'secret-in-client-bundle' ? `<dt>Where</dt><dd class="mono">${t(redactUrl(first.evidence?.url || ''))}</dd><dt>Kind</dt><dd>${t(first.evidence?.kind || '')}</dd>` : ''}
${seen.length ? `<dt>Seen on</dt><dd>${seen.slice(0, 12).map(s => `<a href="#${s.hid}">${t(s.route)} · ${sceneLabel(s)}</a>`).join('<br>')}${seen.length > 12 ? `<br><span class="muted">+${seen.length - 12} more</span>` : ''}</dd>` : ''}
${decision ? `<dt>Decision</dt><dd>${t(decision.decision)}${decision.reason ? ` (${t(decision.reason)})` : ''} · ${t(decision.by)} · ${t(decision.at)}${decision.verified ? '' : ' · <span class="warn">came through git, not approved on this machine</span>'}</dd>` : ''}
${notes.map(n => `<dt>Note</dt><dd class="warn">${t(n)}</dd>`).join('')}
${notLooked(g) ? `<dt>Looked at</dt><dd class="warn">Not looked at since run ${t(notLooked(g))}: no run since has captured every screen it was on, so it cannot be marked fixed.</dd>` : ''}
${verification ? `<dt>Reviewer</dt><dd>${t(verification.verdict)} · ${t(verification.verifier || '')}${verification.suspect ? ' · <span class="warn">suspect</span>' : ''}${verification.reason ? ` — ${t(verification.reason, 240)}` : ''}</dd>` : ''}
</dl>
<details class="evidence"><summary>Evidence details</summary>
<dl class="facts-dl">
<dt>Rule</dt><dd class="mono">${t(g.lens)} · ${t(g.rule)}</dd>
<dt>Group</dt><dd class="mono">${t(g.group)}</dd>
<dt>Fingerprints</dt><dd class="mono">${g.fps.map(x => t(x)).join(' ')}</dd>
${first?.selector ? `<dt>Element</dt><dd class="mono">${t(first.selector, 300)}</dd>` : ''}
${Array.isArray(first?.box) ? `<dt>Box</dt><dd class="mono">${first.box.slice(0, 2).map(Number).join(',')} · ${Number(first.box[2])}×${Number(first.box[3])}</dd>` : ''}
${first?.inside ? `<dt>Inside</dt><dd class="mono">${t(first.inside, 200)}</dd>` : ''}
${first ? evidenceList(first) : ''}
<dt>History</dt><dd>first seen in run ${t(row.firstSeen)} · last seen in run ${t(row.lastSeen)}${row.regressedAt ? ` · came back in run ${t(row.regressedAt)}` : ''}</dd>
</dl></details>
</div>
${fixedOnly ? '' : decideBlock(g)}
</article>`;
}

function screensView(m) {
  const onScene = new Map();
  for (const f of m.instances) if (f.scene) (onScene.get(f.scene) || onScene.set(f.scene, []).get(f.scene)).push(f);
  const groupOf = new Map(m.groups.map(g => [g.group, g]));
  const statusOf = f => f.row?.status || 'open';
  const card = s => {
    const fs = onScene.get(s.id) || [];
    const act = fs.filter(f => ACTIVE.has(statusOf(f)));
    const by = {}; for (const f of act) by[f.severity] = (by[f.severity] || 0) + 1;
    const sevs = Object.keys(by).sort((a, b) => SEV[a] - SEV[b]);
    let badge, kind, note;
    const redirected = s.reason && /^redirected/.test(s.reason);
    if (s.reason === 'redirected-off-origin') { badge = 'Left the app'; kind = 'dark'; note = `Sent to ${s.finalOrigin || 'another site'}`; }
    else if (s.status !== 'captured') { badge = 'Not seen'; kind = 'dark'; note = s.reason || s.status; }
    else if (redirected && fs.some(f => f.rule === 'signed-in-bounced')) { badge = 'Sent to sign-in'; kind = 'dark'; note = 'Signed in, but shown the sign-in page'; }
    else if (redirected) { badge = 'Redirected'; kind = 'low'; note = `Shows ${redactUrl(s.finalPath || '')}`; }
    else if (!fs.length) { badge = 'Clean'; kind = 'clean'; note = 'Nothing found'; }
    else if (!act.length) { badge = 'Nothing open'; kind = 'clean'; note = `${plural(fs.length, 'finding')}, all decided`; }
    else { badge = sevs.slice(0, 2).map(k => `${by[k]} ${k}`).join(' · '); kind = sevs[0]; note = act.length === 1 ? groupOf.get(act[0].group)?.headline || '' : plural(act.length, 'open finding'); }
    const thumb = s.img ? `<div class="thumb thumb-${vpCls(s.viewport)} i-${s.img.key}" aria-hidden="true"></div>` : '<div class="thumb thumb-none" aria-hidden="true">No screenshot</div>';
    return `<li class="card" data-sid="${s.hid}" data-vp="${t(s.viewport)}" data-who="${t(s.person)}" data-state="${t(s.state)}"><a href="#${s.hid}">
<span class="thumb-wrap">${thumb}<span class="badge badge-${kind}">${t(badge)}</span></span>
<span class="card-body"><span class="card-name">${t(s.h1 || s.route, 60)}</span><span class="mono muted small">${t(s.route)}</span><span class="small muted">${sceneLabel(s)}</span><span class="small ${kind === 'dark' ? 'warn' : 'muted'}">${t(note, 80)}</span></span></a></li>`;
  };
  const panel = s => {
    const fs = (onScene.get(s.id) || []).slice().sort((a, b) => SEV[a.severity] - SEV[b.severity] || cmp(groupOf.get(a.group)?.headline || '', groupOf.get(b.group)?.headline || '') || cmp(a.fp, b.fp));
    let n = 0;
    const items = fs.map(f => ({ f, d: drawable(f, s), n: drawable(f, s).ok ? ++n : null }));
    const boxes = items.filter(x => x.n).map(x => ({ box: x.f.box, n: x.n }));
    const sibs = m.scenes.filter(o => o.route === s.route && o.id !== s.id);
    const g = f => groupOf.get(f.group);
    return `<section id="${s.hid}" class="screen-panel" data-view="screens" tabindex="-1" aria-labelledby="h-${s.hid}">
<div class="sp-head"><div><h2 id="h-${s.hid}">${t(s.h1 || s.route, 80)}</h2><p class="muted small"><span class="mono">${t(s.route)}</span> · ${sceneLabel(s)}</p></div><a href="#screens">Close</a></div>
${s.img ? shot(s, { boxes, label: `Screenshot of ${s.route}, ${sceneLabelText(s)}${boxes.length ? `, ${plural(boxes.length, 'finding')} outlined and numbered` : ''}`, cls: `shot-${vpCls(s.viewport)}` }) : s.reason === 'redirected-off-origin' ? `<p class="pad muted">This screen sent the browser to another site (<span class="mono">${t(s.finalOrigin || 'unknown')}</span>); nunchi does not capture other sites.</p>` : `<p class="pad muted">Not seen: ${t(s.reason || s.status)}.</p>`}
${s.reason && /^redirected/.test(s.reason) ? `<p class="pad small muted">Redirected to <span class="mono">${t(redactUrl(s.finalPath || ''))}</span>.</p>` : ''}
${items.length ? `<ol class="sp-list">${items.map(({ f, d, n }) => `<li><a href="#${g(f)?.hid || ''}"><span class="numb${n ? '' : ' numb-none'}">${n || '–'}</span><span class="sp-text"><span class="sp-what">${t(g(f)?.headline || titleOf(f.rule), 120)}</span><span class="small">${SEV_LABEL[f.severity]} · ${f.source === 'ai' ? 'AI' : 'Rule'} · ${STATUS_LABEL[statusOf(f)] || 'Open'}${n ? '' : ` · not outlined: ${d.why}`}</span></span></a></li>`).join('')}</ol>` : s.img ? '<p class="pad muted">Nothing found on this screen.</p>' : ''}
${sibs.length ? `<details class="sp-sibs small"><summary>Same page, ${plural(sibs.length, 'other screen')}</summary><p>${sibs.map(o => `<a href="#${o.hid}">${sceneLabel(o)}</a>`).join(' ')}</p></details>` : ''}
</section>`;
  };
  const values = (key, list, labels) => list.filter(v => m.scenes.some(s => s[key] === v));
  const vps = values('viewport', VPS), whos = values('person', PERSONS), states = values('state', STATES);
  const seg = (name, legend, list, labels, def) => `<fieldset class="seg"><legend class="seg-legend">${legend}</legend>${[...list, 'all'].map(v => `<input type="radio" name="${name}" id="${name}-${v}" value="${v}"${v === def ? ' checked' : ''}><label for="${name}-${v}">${v === 'all' ? 'All' : labels[v]}</label>`).join('')}</fieldset>`;
  const captured = m.scenes.filter(s => s.status === 'captured' && !(s.reason && /^redirected/.test(s.reason)));
  const withF = captured.filter(s => (onScene.get(s.id) || []).some(f => ACTIVE.has(statusOf(f)))).length;
  const clean = captured.filter(s => !(onScene.get(s.id) || []).length).length;
  const bounced = m.scenes.filter(s => (onScene.get(s.id) || []).some(f => f.rule === 'signed-in-bounced')).length;
  const unseen = m.scenes.filter(s => s.status !== 'captured').length;
  const routes = new Set(m.scenes.map(s => s.route)).size;
  return `<section id="screens" class="view" tabindex="-1" aria-labelledby="h-screens">
<div class="stack">
<div class="head-row"><div><h1 id="h-screens">Screens</h1><p class="muted">${plural(routes, 'page')}, ${plural(m.scenes.length, 'screen')} · every one nunchi captured, as it saw it</p></div>
<div class="filters">${vps.length > 1 ? seg('sw', 'Width', vps, WIDTH, vps.includes('d') ? 'd' : vps[0]) : ''}${whos.length > 1 ? seg('sp', 'Who', whos, WHO, 'all') : ''}${states.length > 1 ? seg('ss', 'State', states, STATE_LABEL, 'normal') : ''}</div></div>
<p class="facts-inline"><span><b>${withF}</b> with open findings</span><span><b>${clean}</b> clean</span>${bounced ? `<span class="warn"><b>${bounced}</b> sent to sign-in</span>` : ''}${unseen ? `<span><b>${unseen}</b> not seen</span>` : ''}</p>
<div class="wall-wrap">
<ul class="wall">${m.scenes.map(card).join('')}</ul>
<aside class="panels" aria-label="Selected screen"><p class="panels-empty muted">Select a screen to see it large, with its findings outlined and numbered.</p>${m.scenes.map(panel).join('')}</aside>
</div></div></section>`;
}

// ---- page -----------------------------------------------------------------------------------------------

const SCRIPT = `(function(){var d=document;d.documentElement.className+=" js";
function cur(){var h=decodeURIComponent(location.hash.slice(1)),el=h&&d.getElementById(h),v=el?(el.getAttribute("data-view")||h):"progress";
d.querySelectorAll("[data-nav]").forEach(function(a){if(a.getAttribute("data-nav")===v)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
if(el&&el.focus)el.focus({preventScroll:true})}
addEventListener("hashchange",cur);cur();
d.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("button[data-copy]");if(!b)return;var c=d.getElementById(b.getAttribute("data-copy"));
if(!c||!navigator.clipboard)return;navigator.clipboard.writeText(c.textContent).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)},function(){})})})();`;

function css(m, imageUrl) {
  const filterCss = [];
  for (const [k] of FILTERS) {
    if (k === 'all') continue;
    filterCss.push(`#findings:has(#fs-${k}:checked) .row:not([data-st~="${k}"]),#findings:has(#fs-${k}:checked) .kind:not([data-st~="${k}"]),#findings:has(#fs-${k}:checked) .unchecked:not(:has(.kind[data-st~="${k}"])){display:none}#findings:has(#fs-${k}:checked) .empty[data-for="${k}"]{display:block}`);
  }
  filterCss.push('#findings:has(#fs-all:checked) .empty[data-for="all"]{display:block}');
  for (const [name, attr, list] of [['sw', 'vp', VPS], ['sp', 'who', PERSONS], ['ss', 'state', STATES]]) for (const v of list) filterCss.push(`#screens:has(#${name}-${v}:checked) .card:not([data-${attr}="${v}"]){display:none}`);
  // the selected screen's card is outlined in the wall
  if (m.scenes.length) filterCss.push(m.scenes.map(s => `body:has(#${s.hid}:target) .card[data-sid="${s.hid}"] a`).join(',') + '{box-shadow:0 0 0 3px var(--accent)}');
  const imgs = [...m.images.keys()].sort().map(k => `.i-${k}{background-image:url(${imageUrl(k)})}`).join('\n');
  return `:root{--ground:#F3F4F6;--panel:#FFFFFF;--line:#E5E7EB;--line-soft:#EEF0F2;--ink:#1B1D21;--ink-2:#4A4E57;--muted:#5F636B;--soft:#F8F9FA;--accent:#3346C2;--accent-ink:#23318F;--accent-soft:#EEF0FB;--seg:#E9EBEF;
--high:#E2650F;--high-soft:#FFF4EB;--high-ink:#8A3B00;--medium:#C9A227;--medium-soft:#FBF3D6;--medium-ink:#6B5300;--low:#A6A9B0;--low-soft:#F1F2F4;--low-ink:#4A4E57;--blocker:#C8102E;--blocker-soft:#FDECEE;--blocker-ink:#9B0C23;--good:#1E6B3A;--good-soft:#E8F5EC;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--ground:#141518;--panel:#1C1E22;--line:#30333A;--line-soft:#2A2C31;--ink:#ECEDEF;--ink-2:#C4C7CD;--muted:#9CA0A8;--soft:#22252A;--accent:#8C9BFF;--accent-ink:#C9D0FF;--accent-soft:#272C4A;--seg:#2A2C31;
--high-soft:#3A2414;--high-ink:#FFB37A;--medium-soft:#352D12;--medium-ink:#E8CC6A;--low-soft:#2A2C31;--low-ink:#C4C7CD;--blocker-soft:#3D1419;--blocker-ink:#FF8A99;--good:#6FCF8E;--good-soft:#16301F;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 var(--sans)}
a{color:var(--accent)}a:hover{color:var(--accent-ink)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
code,.mono{font-family:var(--mono);font-size:.9em;overflow-wrap:anywhere}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600}h2{margin:0;font-size:15px;font-weight:600}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;z-index:10;background:var(--panel);padding:10px 14px}
.muted{color:var(--muted)}.small{font-size:13px}.warn{color:var(--high-ink)}.good{color:var(--good)}.pad{padding:0 18px}
.shell{display:flex;min-height:100vh}
.side{flex:0 0 232px;background:var(--panel);border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:20px}
.brand{font-family:var(--mono);font-weight:500;font-size:17px;padding:0 10px}
.runbox{margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font-size:13px}
.runbox b{font-weight:600}
.nav{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nav a{display:flex;justify-content:space-between;align-items:center;min-height:44px;padding:0 10px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:14px}
.nav a:hover{background:var(--soft)}.nav .cnt{color:var(--muted)}
.nav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.side-foot{margin-top:auto;padding:0 10px;font-size:12px;color:var(--muted)}
main{flex:1 1 auto;min-width:0;padding:28px 32px 48px}
.stack{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.view{display:none}.view:target{display:block}
body:not(:has(.view:target)):not(:has(.screen-panel:target)) #progress{display:block}
body:has(.screen-panel:target) #screens{display:block}
body:not(:has(.view:target)):not(:has(.screen-panel:target)) .nav a[data-nav="progress"],body:has(#findings:target) .nav a[data-nav="findings"],body:has(.detail:target) .nav a[data-nav="findings"],body:has(#screens:target) .nav a[data-nav="screens"],body:has(.screen-panel:target) .nav a[data-nav="screens"]{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.panel-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.hero h1{font-size:28px}.eyebrow{margin:0 0 4px;font-size:14px;color:var(--muted)}
.hero-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}.hero-top p{margin:4px 0 0}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:8px;font-weight:600;text-decoration:none}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{color:#fff;filter:brightness(.92)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px;min-height:44px;border-radius:10px;background:var(--soft);color:var(--ink);text-decoration:none}
.tile-high{background:var(--high-soft);box-shadow:inset 0 0 0 1px #F6CBA8}.tile-blocker{background:var(--blocker-soft);box-shadow:inset 0 0 0 1px #F2B8C1}
.tile-n{font-size:28px;font-weight:500}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.facts{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:14px}
.meter-row{display:flex;justify-content:space-between;font-size:14px}
.meter{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.meter span{display:block;height:6px;background:var(--good)}
.statuses{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:10px 18px;font-size:14px}
.sev{display:inline-flex;align-items:center;gap:6px;padding:1px 10px 1px 8px;border-radius:999px;font-size:13px;font-weight:600;white-space:nowrap}
.sev .dot{width:8px;height:8px;border-radius:50%;flex:none}
.sev-blocker{background:var(--blocker-soft);color:var(--blocker-ink)}.sev-blocker .dot{background:var(--blocker)}
.sev-high{background:var(--high-soft);color:var(--high-ink)}.sev-high .dot{background:var(--high)}
.sev-medium{background:var(--medium-soft);color:var(--medium-ink)}.sev-medium .dot{background:var(--medium)}
.sev-low{background:var(--low-soft);color:var(--low-ink)}.sev-low .dot{background:var(--low)}
.tag,.st{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--low-soft);color:var(--low-ink)}
.tag-ai{background:var(--accent-soft);color:var(--accent-ink)}.tag-warn{background:var(--high-soft);color:var(--high-ink)}
.st-open{background:var(--panel);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}.st-regressed{background:var(--high-soft);color:var(--high-ink)}
.st-to-fix{background:var(--accent-soft);color:var(--accent-ink)}.st-fixed{background:var(--good-soft);color:var(--good)}
.head-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}.head-row p{margin:2px 0 0}
fieldset.seg{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:4px;border:0;border-radius:10px;background:var(--seg);align-self:flex-start;min-width:0}
.seg input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.seg label{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:7px;font-size:14px;color:var(--ink-2);cursor:pointer}
.seg input:checked+label{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.12)}
.seg input:focus-visible+label{outline:3px solid var(--accent);outline-offset:1px}
.seg .cnt{color:var(--muted);font-weight:400}
.seg-legend{float:left;align-self:center;padding:0 8px 0 6px;font-size:13px;color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:8px}
.list-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.kind+.kind,.list-box>.empty{border-top:1px solid var(--line-soft)}
.kind>summary,.unchecked-sum{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px;padding:8px 20px;background:var(--soft);cursor:pointer;list-style:none}
.kind>summary::-webkit-details-marker,.unchecked-sum::-webkit-details-marker{display:none}
.kind>summary::before,.unchecked-sum::before{content:"▸";color:var(--muted);margin-right:-4px}.kind[open]>summary::before,.unchecked[open]>.unchecked-sum::before{content:"▾"}
.kind-title{flex:1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:600;font-size:14px}
.rows{margin:0;padding:0;list-style:none}
.row a{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 14px;padding:12px 20px;border-top:1px solid var(--line-soft);color:var(--ink);text-decoration:none;min-height:44px}
.row a:hover{background:var(--accent-soft)}
.row-main{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:2px}.row-what{font-weight:500;overflow-wrap:anywhere}.row-where{font-size:13px;color:var(--muted)}
.row-tags{display:flex;flex-wrap:wrap;gap:6px}
.empty{display:none;margin:0;padding:16px 20px;color:var(--muted)}
.unchecked .kind{border-top:1px solid var(--line-soft)}.unchecked>p{margin:10px 0}
.clean-note{margin:0;padding:18px 20px;background:var(--good-soft);color:var(--good);border-radius:12px;font-weight:600}
.detail-nav{max-width:1000px;margin:0 auto 12px;display:flex;justify-content:space-between;gap:12px;font-size:14px}
.detail-nav a{display:inline-flex;align-items:center;min-height:44px}.pn{display:flex;gap:16px}
.detail-box{max-width:1000px;margin:0 auto}
.detail-head h1{font-size:22px;line-height:1.3;overflow-wrap:anywhere}.chips{margin:0 0 6px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}
.fig p{margin:0 0 6px}
.detail:has(.vt-m:checked) .fig-d,.detail:has(.vt-d:checked) .fig-m{display:none}
.shot{position:relative;width:100%;background-repeat:no-repeat;background-size:100% auto;background-color:var(--soft);border-radius:8px;box-shadow:0 0 0 1px var(--line)}
.fig-m .shot,.shot-m{max-width:390px;margin:0 auto}
.box{position:absolute;border:2px dashed #1B1D21;box-shadow:0 0 0 2px #FFFFFF;border-radius:3px;min-width:6px;min-height:6px}
.num{position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;background:#1B1D21;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff}
.whole{margin-top:8px}.whole summary,.evidence summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-2)}
.facts-dl{margin:0;display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 16px;font-size:14px}
.facts-dl dt{color:var(--muted)}.facts-dl dd{margin:0;overflow-wrap:anywhere}
.evidence{border-top:1px solid var(--line-soft);padding-top:4px}
.decide{max-width:1000px;margin:16px auto 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 24px;display:flex;flex-direction:column;gap:8px}
.decide p{margin:0}.cmds{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.cmds li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.cmd-label{flex:0 0 180px;display:flex;flex-direction:column}
.cmd{flex:1 1 260px;padding:8px 10px;background:var(--soft);border:1px solid var(--line);border-radius:6px;user-select:all}
.copy{display:none;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.js .copy{display:inline-block}
.facts-inline{margin:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:var(--ink-2)}
.wall-wrap{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.wall{flex:999 1 520px;min-width:0;margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}
.card a{display:block;height:100%;background:var(--panel);border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line);color:var(--ink);text-decoration:none}
.card a:hover{box-shadow:0 0 0 2px var(--accent)}
.thumb-wrap{position:relative;display:block}
.thumb{display:block;width:100%;aspect-ratio:16/10;background-size:cover;background-position:top center;background-color:var(--soft);border-bottom:1px solid var(--line-soft)}
.thumb-m{aspect-ratio:4/5}.thumb-none{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}
.badge{position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.16)}
.badge-blocker{background:#FDECEE;color:#9B0C23}.badge-high{background:#FFF4EB;color:#8A3B00}.badge-medium{background:#FBF3D6;color:#6B5300}.badge-low{background:#F1F2F4;color:#4A4E57}.badge-clean{background:#E8F5EC;color:#1E6B3A}.badge-dark{background:#1B1D21;color:#fff}
.card-body{display:flex;flex-direction:column;gap:1px;padding:10px 12px 12px}.card-name{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.panels{flex:1 1 340px;max-width:460px;position:sticky;top:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panels-empty{margin:0;padding:18px}.panels:has(.screen-panel:target) .panels-empty{display:none}
.screen-panel{display:none}.screen-panel:target{display:block}
.sp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:14px 18px;border-bottom:1px solid var(--line-soft)}
.sp-head p{margin:2px 0 0}.sp-head a{display:inline-flex;align-items:center;min-height:44px;font-size:14px}
.screen-panel .shot{border-radius:0;box-shadow:none}
.sp-list{margin:0;padding:6px 0;list-style:none}
.sp-list a{display:flex;gap:10px;padding:10px 18px;min-height:44px;color:var(--ink);text-decoration:none}.sp-list a:hover{background:var(--accent-soft)}
.numb{flex:none;width:22px;height:22px;border-radius:50%;background:#1B1D21;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}
.numb-none{background:var(--low-soft);color:var(--muted)}
.sp-text{display:flex;flex-direction:column;min-width:0}.sp-what{font-size:14px;font-weight:500;overflow-wrap:anywhere}.sp-text .small{color:var(--muted)}
.sp-sibs{padding:0 18px;border-top:1px solid var(--line-soft);background:var(--soft)}.sp-sibs summary{min-height:44px;display:flex;align-items:center;cursor:pointer}
.sp-sibs p{margin:0 0 10px;display:flex;flex-wrap:wrap;gap:4px 14px}.sp-sibs a{display:inline-flex;align-items:center;min-height:32px}
.view:focus,.screen-panel:focus{outline:none}
@media (max-width:760px){.shell{flex-direction:column}.side{flex:none;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px;gap:10px}
.side-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.brand{padding:0}.runbox{padding:4px 8px}
.nav{flex-direction:row;flex-wrap:wrap}.nav a{flex:1 1 auto;justify-content:center;gap:6px}.side-foot{display:none}
main{padding:16px 16px 40px}.panel-box{padding:18px 16px}.hero h1{font-size:22px}.facts-dl{grid-template-columns:1fr;gap:2px}.facts-dl dd{margin-bottom:8px}
.panels{max-width:none;position:static}.cmd-label{flex-basis:100%}.cmd{flex:1 1 0;min-width:0}.seg-legend{float:none;width:100%;padding:2px 6px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
${filterCss.join('\n')}
${imgs}
`;
}

export function renderHtml(m, { imageUrl }) {
  const scriptHash = createHash('sha256').update(SCRIPT).digest('base64');
  const csp = `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'`;
  const commit = m.meta.commit ? `${String(m.meta.commit).slice(0, 7)}${m.meta.dirty ? ' + edits' : ''}` : 'no git commit';
  const runLabel = m.runId ? `Run ${m.runId}` : 'Run (not numbered)';
  const active = m.groups.filter(g => g.active).length;
  const details = m.groups.map((g, i) => detailView(m, g, m.groups[i - 1], m.groups[i + 1])).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
${GENERATOR}
<title>nunchi · ${t(runLabel)}</title>
<style>
${css(m, imageUrl)}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<nav class="side" aria-label="nunchi">
<div class="side-top"><span class="brand">nunchi</span>
<p class="runbox"><b>${t(runLabel)}</b><br><span class="muted">${t(commit)}</span></p></div>
<ul class="nav">
<li><a href="#progress" data-nav="progress">Progress</a></li>
<li><a href="#findings" data-nav="findings">Findings <span class="cnt">${active}</span></a></li>
<li><a href="#screens" data-nav="screens">Screens <span class="cnt">${m.scenes.length}</span></a></li>
</ul>
<p class="side-foot">Read-only export of one run. Decide with <code>nunchi decide</code>; the live board is <code>nunchi open</code>.</p>
</nav>
<main id="main">
${progressView(m)}
${findingsView(m)}
${details}
${screensView(m)}
</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// ---- writing ---------------------------------------------------------------------------------------------

export const GENERATOR = '<meta name="generator" content="nunchi export --html">';
export const MARKER = '.nunchi-export';                 // img/.nunchi-export: the files the last export wrote there
const IMG_NAME = /^[0-9a-f]{16}\.jpg$/;
const refuse = msg => { throw Object.assign(new Error(msg), { code: 'EXPORT_TARGET' }); };
const lstatOr = p => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

// A path with every existing part resolved through symlinks (the rest kept as written), so a check on it cannot be
// bypassed by a link; compared without case where the file system usually ignores it.
function realish(p) {
  let cur = resolve(p); const rest = [];
  while (!lstatOr(cur)) { const up = dirname(cur); if (up === cur) break; rest.unshift(basename(cur)); cur = up; }
  let real = cur; try { real = realpathSync(cur); } catch {}
  return join(real, ...rest);
}
export function within(parent, child) {
  const fold = process.platform === 'win32' || process.platform === 'darwin' ? x => x.toLowerCase() : x => x;
  const r = relative(fold(realish(parent)), fold(realish(child)));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

// Writes <outDir>/index.html and <outDir>/img/<hash>.jpg (copied, byte for byte). With `inline`, the images are
// data URIs inside index.html and no image is written. Nothing else in outDir is touched, and nothing is replaced
// that an earlier export did not write: an index.html without the generator marker, a symlink, or an img/ folder
// with files of the user's own is refused before anything changes.
export function exportHtml({ runDir, nunchiDir, outDir, inline = false, ledger = null }) {
  if (within(join(nunchiDir, 'runs'), outDir)) refuse('write the page outside .nunchi/runs (runs are evidence and are never edited)');
  if (within(runDir, outDir)) refuse('write the page outside the run folder');
  const m = buildModel({ runDir, nunchiDir, ledger });
  const imageUrl = inline
    ? key => `"data:image/jpeg;base64,${readFileSync(m.images.get(key).file).toString('base64')}"`
    : key => `"img/${key}.jpg"`;
  const html = renderHtml(m, { imageUrl });

  // check everything first
  const out = lstatOr(outDir);
  if (out && !out.isDirectory() && !(out.isSymbolicLink() && lstatOr(realish(outDir))?.isDirectory())) refuse(`${outDir} is not a folder`);
  const index = join(outDir, 'index.html'), img = join(outDir, 'img'), marker = join(img, MARKER);
  const ix = lstatOr(index);
  if (ix && !ix.isFile()) refuse(`${index} is a ${ix.isSymbolicLink() ? 'symlink' : 'folder'}; not replacing it`);
  if (ix && !readFileSync(index, 'utf8').includes(GENERATOR)) refuse(`${index} was not written by nunchi export; not replacing it (pick an empty folder)`);
  const im = lstatOr(img);
  if (im && (im.isSymbolicLink() || !im.isDirectory())) refuse(`${img} is not a plain folder; not writing into it`);
  let ours = [];
  if (im) {
    const mk = lstatOr(marker);
    if (mk && !mk.isFile()) refuse(`${marker} is not a file`);
    if (mk) ours = readFileSync(marker, 'utf8').split('\n').filter(n => IMG_NAME.test(n));
    else if (readdirSync(img).length) refuse(`${img} holds files nunchi export did not write; not touching it (pick an empty folder)`);
  }
  const keys = inline ? [] : [...m.images.keys()].sort();
  const mine = new Set(ours);
  for (const key of keys) if (!mine.has(`${key}.jpg`) && lstatOr(join(img, `${key}.jpg`))) refuse(`${join(img, `${key}.jpg`)} exists and was not written by nunchi export`);

  // then write: remove only what the last export listed (a link is removed as a link, never followed)
  mkdirSync(outDir, { recursive: true });
  for (const n of ours) { const f = join(img, n); const st = lstatOr(f); if (st && (st.isFile() || st.isSymbolicLink())) unlinkSync(f); }
  if (im && lstatOr(marker)) unlinkSync(marker);
  let bytes = Buffer.byteLength(html);
  if (keys.length || (!inline && m.images.size === 0)) {
    if (!lstatOr(img)) mkdirSync(img);
    for (const key of keys) { copyFileSync(m.images.get(key).file, join(img, `${key}.jpg`), FS.COPYFILE_EXCL); bytes += m.images.get(key).bytes; }
    writeFileSync(marker, keys.map(k => `${k}.jpg\n`).join(''), { flag: 'wx' });
  } else if (lstatOr(img) && !readdirSync(img).length) rmdirSync(img);
  // a new file renamed over index.html: a symlink put there in the meantime is replaced, never written through
  const tmp = join(outDir, `.index.html.${process.pid}.tmp`);
  writeFileSync(tmp, html, { flag: 'wx' });
  renameSync(tmp, index);
  return {
    out: index, run: m.runId, inline, bytes, images: keys.length,
    scenes: m.scenes.length, groups: m.groups.length, open: m.groups.filter(g => g.active).length, inLedger: m.inLedger,
  };
}
