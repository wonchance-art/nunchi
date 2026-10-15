// `nunchi export --format md|json|sarif` (design 0.1-c §5, spec §7.4): the ledger's findings as a file to share — a
// Markdown list, JSON, or SARIF for code scanning. `--html` (spec §7.1) stays the static review page.
//
// - Redaction: every string that reaches an export goes through the secret scanner at export time (credential URL
//   parts and query values, then `scrubSecrets`: a hit becomes `[secret-shaped: <kind>]`), selectors through
//   `redactSelector`, keys of objects too. A secret finding gives location and kind only.
// - Page text is left out unless `--include-page-text`: evidence text and AI claim quotes always; control names, URLs,
//   the quoted names in a selector and an `aria=` node's text when the finding was seen on a signed-in screen. An
//   evidence field nunchi does not know is page text.
// - Locations: paths relative to the repository root (`%SRCROOT%` in SARIF), route templates instead of URLs (no
//   sample path, no origin, no screen id). Every SARIF result points at a file: the finding's own file:line, else the
//   page file of its route (line 1), else the app's package.json (line 1, a whole-app finding); one with none of
//   these is left out and counted.
// - Escaping: Markdown special characters are escaped with a backslash and line breaks flattened, so no data can open
//   a link, an image, a heading or raw HTML; SARIF uses `message.text` only.
// - Deterministic: no clock; groups, items and keys sorted; the same ledger gives the same bytes.
import { join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { titleOf, latestRunOf } from './ledger.mjs';
import { discover } from './discover.mjs';
import { gitRunner } from './runs.mjs';
import { scrubSecrets } from './rules.mjs';
import { redactText, redactUrl } from './network.mjs';
import { redactSelector } from './selector-secrets.mjs';
import { stableJson } from './stable.mjs';
import { SEV, SEV_LABEL, STATUS_LABEL, MORE_STATUS, human, decidedText } from './board/shared.mjs';
import { sarifLog, plainText, FLAT } from './sarif.mjs';

export const STATUSES = ['open', 'regressed', 'to-fix', 'held', 'kept', 'dismissed', 'fixed', 'stale'];
// what still counts for shipping: open, came back, to fix, later
export const DEFAULT_STATUSES = ['open', 'regressed', 'to-fix', 'held'];
// the board's words are taken too (design §3.4)
export const STATUS_ALIASES = { later: 'held', 'not-a-problem': 'dismissed', 'came-back': 'regressed' };
const FORMATS = ['md', 'json', 'sarif'];
export const exportFormats = FORMATS;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = p => p.split(sep).join('/');
const sevOf = s => (Object.hasOwn(SEV, s) ? s : 'low');
// one string, redacted: credential URL parts and query values, then secret shapes
export const clean = s => scrubSecrets(redactText(String(s ?? '')));
const deepClean = v => (Array.isArray(v) ? v.map(deepClean)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [clean(k), deepClean(v[k])]))
  : typeof v === 'string' ? clean(v) : v);

// Evidence fields by what they hold. Numbers and enums the engine measured are data; URLs are redacted as URLs, and
// from signed-in screens are page text (a link to `/people/ana-fern/diary` says whose screen it was); control names are
// page text from signed-in screens; anything else is page text.
const DATA_KEYS = new Set(['status', 'scrollWidth', 'viewportWidth', 'clientWidth', 'width', 'height', 'minimum', 'recommended', 'band', 'threshold', 'method',
  'state', 'impact', 'type', 'count', 'kind', 'fonts', 'note']);
const URL_KEYS = new Set(['url', 'href', 'src']);
const NAME_KEYS = new Set(['name', 'label', 'placeholder']);
// a plain relative path: no root, drive or scheme (`https:`, `file:`), no backslash, control character or `..`
const SAFE_FILE = p => typeof p === 'string' && p && p.length <= 1024 && !p.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.includes('\\') && !/[\u0000-\u001f\u007f]/.test(p)
  && !p.split('/').some(s => s === '..');
// quoted names in a selector (`aria=button "Delete Ana's fern"`, `:has-text('…')`)
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

function evidenceOut(row, { pageText, signedIn }) {
  const ev = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
  const out = {};
  let left = 0;
  for (const k of Object.keys(ev).sort()) {
    const v = ev[k];
    if (v === null || v === undefined || k === 'file' || k === 'line' || k === 'masked') continue;
    if (row.rule === 'secret-in-client-bundle' && k !== 'kind' && k !== 'url') continue;      // location and kind only
    if (URL_KEYS.has(k) && typeof v === 'string') {
      // a secret finding's url is where the bundle is: its location, never page text
      if (signedIn && !pageText && row.rule !== 'secret-in-client-bundle') { left++; continue; }
      out[k] = clean(redactUrl(v)); continue;
    }
    if (DATA_KEYS.has(k)) { out[clean(k)] = deepClean(v); continue; }
    if (NAME_KEYS.has(k) && (pageText || !signedIn)) { out[clean(k)] = deepClean(v); continue; }
    if (pageText) { out[clean(k)] = deepClean(v); continue; }
    left++;
  }
  return { evidence: out, left };
}
// An AI finding's `aria=` selector is a node of the screen's accessibility tree, in the screen's own words:
// `aria=button "Delete garden"`, `aria=heading "Tasks" [level=1]`, `aria=group "Week 3": Ana dentist Tuesday`,
// `aria=text: Welcome back, Ana`. From a signed-in screen without page text it keeps its role, a masked name and its
// states (`[level=1]`), and drops the text after `: `.
const ARIA = /^aria=\s*([a-z]+)((?:\s+"(?:[^"\\]|\\.)*")?)((?:\s+\[[^\]"']*\])*)/;
// → { element, left }: `left` 1 when page text was taken out of it
const elementOut = (selector, { pageText, signedIn }) => {
  if (typeof selector !== 'string' || !selector) return { element: null, left: 0 };
  const s = clean(redactSelector(selector));
  if (pageText || !signedIn) return { element: s, left: 0 };
  let kept;
  if (s.startsWith('aria=')) { const m = ARIA.exec(s); kept = m ? `aria=${m[1]}${m[2] ? ' "…"' : ''}${m[3]}` : 'aria=…'; }
  else kept = s.replace(QUOTED, q => `${q[0]}…${q[0]}`);
  return { element: kept, left: kept === s ? 0 : 1 };
};

// Where an app path sits in the repository: `git rev-parse --show-prefix` of the app's root (hardened git), else the
// app root relative to the project folder (no git: paths are the project's).
function repoPrefix(root, project) {
  try { return { prefix: gitRunner(root)(['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim(), base: 'repository' }; }
  catch {
    const r = posix(relative(project, root));
    return { prefix: r && !r.startsWith('..') ? `${r}/` : '', base: 'project' };
  }
}

// The export's model: the ledger's rows that have one of `statuses`, grouped as the ledger groups them.
// `led`: project.mjs loadLedger; `view`: its ledgerView.
export function findingsModel({ led, view, root, project, statuses = DEFAULT_STATUSES, pageText = false, routes = null }) {
  root = resolve(root); project = resolve(project);
  const want = new Set(statuses);
  const { prefix, base } = repoPrefix(root, project);
  const pageOf = new Map();
  try { for (const r of routes ?? discover(root).routes) if (!pageOf.has(r.path) && SAFE_FILE(r.file)) pageOf.set(r.path, `${prefix}${r.file}`); } catch {}
  const pkg = existsSync(join(root, 'package.json')) ? `${prefix}package.json` : null;
  const latest = latestRunOf(led.state, led.st.root.stream);
  const rows = view.rows.filter(r => want.has(r.status));
  const byGroup = new Map();
  let left = 0;
  for (const r of rows) {
    const signedIn = (r.persons || []).includes('signed-in');
    const ev = evidenceOut(r, { pageText, signedIn });
    const el = elementOut(r.selector, { pageText, signedIn });
    left += ev.left + el.left;
    const file = SAFE_FILE(r.evidence?.file) ? { path: `${prefix}${r.evidence.file}`, line: Number.isInteger(r.evidence?.line) && r.evidence.line > 0 ? r.evidence.line : 1, from: 'finding' } : null;
    const route = typeof r.route === 'string' ? clean(r.route) : null;
    const page = r.route && pageOf.has(r.route) ? { path: clean(pageOf.get(r.route)), line: 1, from: 'route' } : null;
    const item = {
      fp: String(r.fp), status: r.status, severity: sevOf(r.severity), route,
      persons: [...(r.persons || [])].map(String).sort(), viewports: [...(r.viewports || [])].map(String).sort(), states: [...(r.states || [])].map(String).sort(),
      places: Number(r.places) || 1, element: el.element,
      location: file ? { ...file, path: clean(file.path) } : page || (pkg ? { path: clean(pkg), line: 1, from: 'app' } : null),
      evidence: ev.evidence,
      decision: r.decision ? { decision: r.decision.decision, reason: r.decision.reason ?? null, human: r.decision.human ?? null, channel: r.decision.channel ?? null, ...(r.decision.note ? { note: clean(r.decision.note) } : {}) } : null,
      firstSeen: r.firstSeen ?? null, lastSeen: r.lastSeen ?? null, ...(r.goneAt ? { fixedIn: r.goneAt } : {}),
    };
    if (!byGroup.has(r.group)) {
      const ai = r.source === 'ai';
      byGroup.set(r.group, { group: String(r.group), lens: clean(r.lens), rule: clean(r.rule), source: ai ? 'ai' : 'rule', title: clean(ai ? `AI · ${human(r.rule)}` : titleOf(r.rule)),
        severity: item.severity, ...(ai ? { checked: true } : {}), statuses: {}, items: [] });
    }
    const g = byGroup.get(r.group);
    if (SEV[item.severity] < SEV[g.severity]) g.severity = item.severity;
    if (r.source === 'ai' && !r.checked) g.checked = false;
    g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
    g.items.push(item);
  }
  const groups = [...byGroup.values()].map(g => ({ ...g, items: g.items.sort((a, b) => cmp(a.route ?? '', b.route ?? '') || cmp(a.fp, b.fp)) }))
    .sort((a, b) => SEV[a.severity] - SEV[b.severity] || cmp(a.title, b.title) || cmp(a.group, b.group));
  const bySeverity = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const g of groups) bySeverity[g.severity]++;
  return {
    schema: 1, tool: 'nunchi', run: latest ?? null, statuses: [...want].sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b)), pageText, paths: base,
    counts: { groups: groups.length, items: rows.length, bySeverity, pageTextLeftOut: pageText ? 0 : left },
    groups,
  };
}

// Every key and string of the model once more, whoever put it there (an evidence key, the app's package.json path)
export const exportJson = model => stableJson(deepClean(model));

// ---- Markdown -------------------------------------------------------------------------------------------------------

// Data as Markdown text: redacted, line breaks and control characters flattened, every character Markdown or GFM
// gives a meaning (emphasis, code, links, images, headings, lists, tables, HTML, entities, autolinks) escaped.
export const mdText = s => clean(s).toWellFormed().replace(FLAT, ' ').replace(/\s+/g, ' ').trim()
  .replace(/[\\`*_{}[\]()#+\-.!|<>~&:@=$%^"']/g, '\\$&');
const STATUS_WORDS = { ...STATUS_LABEL, ...MORE_STATUS };
const WHO = { guest: 'Visitor', 'signed-in': 'Signed in' };
const VP = { d: 'Desktop', m: 'Phone' };
export function exportMarkdown(model) {
  const lines = ['# nunchi findings', ''];
  const n = model.counts;
  lines.push(`${model.run ? `Run ${mdText(model.run)} · ` : ''}${n.groups} group${n.groups === 1 ? '' : 's'}, ${n.items} place${n.items === 1 ? '' : 's'} · ${model.statuses.map(s => mdText(STATUS_WORDS[s] || s)).join(', ')}`);
  lines.push('');
  if (!model.pageText) lines.push(`Page text is left out (evidence text, AI claims, control names from signed-in screens)${n.pageTextLeftOut ? `: ${n.pageTextLeftOut} field${n.pageTextLeftOut === 1 ? '' : 's'}` : ''}. nunchi export --include-page-text adds it.`, '');
  lines.push(model.paths === 'repository' ? 'Paths are relative to the repository root; routes are route templates.' : 'Paths are relative to the project folder (no git); routes are route templates.', '');
  if (!model.groups.length) lines.push('Nothing to report for these statuses.', '');
  for (const g of model.groups) {
    const status = Object.keys(g.statuses).sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b)).map(s => mdText(STATUS_WORDS[s] || s)).join(', ');
    lines.push(`## ${SEV_LABEL[g.severity]} · ${mdText(g.title)}`, '');
    lines.push(`- Group ${mdText(g.group)} · ${mdText(g.lens)} · ${g.source === 'ai' ? (g.checked ? 'AI, double\\-checked' : 'AI, not double\\-checked') : 'rule'} \\(${mdText(g.rule)}\\) · ${status}`);
    for (const it of g.items) {
      const where = it.route === null ? 'Whole app' : mdText(it.route);
      const cells = [...it.persons.map(p => WHO[p] || p), ...it.viewports.map(v => VP[v] || v), ...it.states].map(mdText).join(', ');
      const loc = it.location ? `${mdText(it.location.path)}${it.location.from === 'finding' ? `\\:${it.location.line}` : it.location.from === 'route' ? ' \\(the route\'s page\\)' : ' \\(the app\\)'}` : null;
      const ev = Object.entries(it.evidence).map(([k, v]) => `${mdText(k)}\\: ${mdText(typeof v === 'string' ? v : JSON.stringify(v))}`).join('; ');
      const dec = it.decision ? `${mdText(decidedText(it.decision.decision, it.decision.reason))}${it.decision.human === false ? ' \\(not confirmed by a person\\)' : ''}${it.decision.note ? `, note\\: ${mdText(it.decision.note)}` : ''}` : null;
      lines.push(`- ${where}${it.element ? ` · element ${mdText(it.element)}` : ''}${loc ? ` · ${loc}` : ''}${cells ? ` · ${cells}` : ''}${it.places > 1 ? ` · ${it.places} screens` : ''}${ev ? ` · ${ev}` : ''}${dec ? ` · decided\\: ${dec}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

// ---- SARIF ----------------------------------------------------------------------------------------------------------

// A place that is fixed, or that a decision dismissed or kept, is a suppressed result (kind `external`: the decision
// lives in nunchi's ledger, not in the source), so code scanning shows it closed instead of opening an alert. A
// decision no person made or confirmed is `underReview`, as it does not clear "Ready to ship" either.
const decided = (it, d) => ({ status: it.decision?.human === false ? 'underReview' : 'accepted',
  justification: `${decidedText(it.decision?.decision ?? d, it.decision?.reason ?? null)}${it.decision?.human === false ? ', not confirmed by a person' : ''} (nunchi decide).` });
const SUPPRESSED = {
  fixed: it => ({ status: 'accepted', justification: `Fixed${it.fixedIn ? `: gone on re-capture in run ${it.fixedIn}` : ''} (nunchi).` }),
  dismissed: it => decided(it, 'false-positive'),
  kept: it => decided(it, 'keep'),
};
// One result per place (a ledger row): its group and fingerprint as partialFingerprints, the route and element as
// logical locations, a suppression when it is fixed, dismissed or kept. → { results, rules, unlocated }
export function findingResults(model) {
  const rules = new Map(), results = [];
  let unlocated = 0;
  for (const g of model.groups) {
    const security = g.lens === 'L9';
    rules.set(g.rule, { title: g.title, tags: [g.lens, g.source === 'ai' ? 'ai' : 'rule', ...(security ? ['security'] : [])], security });
    for (const it of g.items) {
      if (!it.location) { unlocated++; continue; }
      const where = it.route === null ? 'the whole app' : it.route;
      const ev = Object.entries(it.evidence).filter(([k]) => k !== 'url' || g.rule === 'secret-in-client-bundle').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
      results.push({
        ruleId: g.rule, severity: it.severity,
        message: `${g.title} on ${where}${it.element ? ` (element ${it.element})` : ''}. ${STATUS_WORDS[it.status] || it.status} · ${g.source === 'ai' ? 'AI' : 'rule'} · group ${g.group}${it.location.from === 'route' ? ' · located at the page file of its route' : it.location.from === 'app' ? ' · located at the app' : ''}${ev ? ` · ${ev}` : ''}`,
        path: it.location.path, line: it.location.line,
        logical: [...(it.route !== null ? [{ name: it.route, kind: 'resource' }] : []), ...(it.element ? [{ name: it.element, kind: 'element' }] : [])],
        fingerprints: { 'nunchi/fp/v1': it.fp, 'nunchi/group/v1': g.group },
        ...(SUPPRESSED[it.status] ? { suppression: SUPPRESSED[it.status](it) } : {}),
      });
    }
  }
  return { results, rules, unlocated };
}
export function exportSarif(model, { version }) {
  const { results, rules, unlocated } = findingResults(model);
  return { ...sarifLog({ version, rules, results }), unlocated };
}
export const plain = plainText;
