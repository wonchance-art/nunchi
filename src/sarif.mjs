// SARIF 2.1.0 for GitHub code scanning (design 0.1-c §5, spec §7.4): one run, `message.text` only (no Markdown),
// every result with a physical location (GitHub shows no result without one), repo-relative URIs under `%SRCROOT%`
// (never an absolute path of this machine), `partialFingerprints` of nunchi's own, levels by severity, and
// `security-severity` on L9 rules only. Deterministic: results and rules sorted, no clock, no run time.
//
// GitHub's limits (docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support and its limits
// table, data/reusables/code-scanning/sarif-limits.md in github/docs; read 2026-10-15 KST): a gzip-compressed file of at
// most 10 MB; per file at most 20 runs; per run at most 25,000 results (only the top 5,000, by severity, are kept),
// 25,000 rules and 100 tool extensions; per result at most 1,000 locations (100 kept; only the first is used) and
// 10,000 thread flow locations (1,000 kept); per rule at most 20 tags (10 kept). Over a hard limit the file is
// rejected. nunchi writes one run, one location per result and at most 10 tags per rule, keeps the 5,000 results GitHub
// would keep (worst first, the same order every time), and keeps the uncompressed file under 10 MB (so the compressed
// one is too). When it cuts, the run's properties and the command's output say so.
import { stableJson, sortKeys } from './stable.mjs';
import { SEV } from './board/shared.mjs';
import { scrubSecrets } from './rules.mjs';
import { redactText } from './network.mjs';
// every string of the log passes the secret scanner (credential URL parts, then secret shapes), whoever built it
const scrub = s => scrubSecrets(redactText(String(s ?? '')));

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';
export const GITHUB_LIMITS = { runs: 20, results: 25000, resultsKept: 5000, rules: 25000, extensions: 100, locations: 1000, tags: 20, tagsKept: 10, gzipBytes: 10 * 1024 * 1024 };
export const LIMITS_SOURCE = 'https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support';
// blocker and high → error; medium → warning; low → note (design §5)
export const LEVEL = { blocker: 'error', high: 'error', medium: 'warning', low: 'note' };
// GitHub reads security-severity as: over 9.0 critical, 7.0–8.9 high, 4.0–6.9 medium, 0.1–3.9 low
export const SECURITY_SEVERITY = { blocker: '9.5', high: '8.0', medium: '5.5', low: '2.0' };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sevRank = s => (Object.hasOwn(SEV, s) ? SEV[s] : 3);

// A repo-relative path as a URI reference: each segment percent-encoded outside RFC 3986's path characters, so a
// space, a `[id]` folder or a `%` stays one path (GitHub decodes it), and no scheme or authority can be smuggled in
// (`:` is encoded too: `c:x.tsx` or `https:x` as a first segment would read as a scheme).
export function uriOf(path) {
  return String(path).toWellFormed().split('/').map(seg => [...seg].map(ch => (/^[A-Za-z0-9\-._~!$&'()*+,;=@]$/.test(ch) ? ch
    : [...new TextEncoder().encode(ch)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))).join('')).join('/');
}
// Control and format characters (line breaks, bidi marks and isolates, zero-width characters, the soft hyphen, the
// Arabic letter mark …) and the line and paragraph separators: flattened to a space wherever data becomes text.
export const FLAT = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;
// Clipped to `n` code points (never half a surrogate pair), with an ellipsis.
export const clip = (t, n) => { if (t.length <= n) return t; const cps = [...t]; return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : t; };
// SARIF's message text is plain text; GitHub shows its first sentence when space is short. Control and format
// characters and line breaks are flattened, a lone surrogate becomes U+FFFD, and it is kept to a sane length.
export const plainText = (s, n = 1000) => clip(scrub(s).toWellFormed().replace(FLAT, ' ').replace(/\s+/g, ' ').trim(), n);

// Every key and string of a piece of the log through the scanner. The log is built of such pieces (the run around the
// results and rules, each result, each rule) and of fixed keys only, so the whole log is scrubbed, whoever built it.
// `done`: texts plainText scrubbed already (before it clipped them), not scanned twice (the scanner is idempotent); the
// keys and short words every result repeats are scanned once per log.
const deepScrub = (v, done = new Map()) => {
  if (Array.isArray(v)) return v.map(x => deepScrub(x, done));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [deepScrub(k, done), deepScrub(x, done)]));
  if (typeof v !== 'string') return v;
  let t = done.get(v);
  if (t === undefined) { t = scrub(v); done.set(v, t); if (t !== v) done.set(t, t); }
  return t;
};

// Sizes as stableJson writes them (JSON.stringify(…, null, 2) and a final line break), so the cut is found over sizes
// worked out once per result and rule, and the log is built once. An element of an array whose elements are
// `depth` levels deep: its line break and indent, its own text with every line indented as deep, and its comma.
const json = v => JSON.stringify(sortKeys(v), null, 2);
const elementBytes = (text, depth) => 1 + depth * 2 + Buffer.byteLength(text) + (text.split('\n').length - 1) * depth * 2 + 1;
// that array in place of `[]`: `[`, the elements (one comma less), a line break, its parent's indent and `]`
const arrayGrowth = (sum, depth) => (sum ? sum - 1 + 1 + (depth - 1) * 2 + 1 - 1 : 0);
const RESULTS_DEPTH = 4, RULES_DEPTH = 6;                        // log › runs[] › run › results[]; run › tool › driver › rules[]

// `rules`: Map id → { title, severity (the worst of its results), lens, tags, security }. `results`: [{ ruleId,
// severity, message, path (repo-relative), line, column?, logical: [{ name, kind }], fingerprints: { name: value },
// suppression?: { status, justification } }] (a result the person dismissed or kept, or one that is fixed: GitHub
// shows it as closed). → { log, text, kept, of, truncated: null | { kept, of, why } }
export function sarifLog({ version, rules, results, maxBytes = GITHUB_LIMITS.gzipBytes, keep = GITHUB_LIMITS.resultsKept }) {
  const ordered = [...results].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || cmp(a.ruleId, b.ruleId) || cmp(a.path, b.path)
    || a.line - b.line || (a.column || 0) - (b.column || 0) || cmp(stableJson(a.fingerprints), stableJson(b.fingerprints)) || cmp(a.message, b.message));
  const of = ordered.length;
  const cap = Math.min(of, keep);
  const done = new Map();
  const text = (t, n) => { const x = plainText(t, n); done.set(x, x); return x; };
  const out = ordered.slice(0, cap).map(r => deepScrub({
    ruleId: r.ruleId,
    level: LEVEL[r.severity] || 'note',
    message: { text: text(r.message) },
    locations: [{
      physicalLocation: { artifactLocation: { uri: uriOf(scrub(r.path)), uriBaseId: '%SRCROOT%' }, region: { startLine: Math.max(1, r.line | 0), ...(r.column ? { startColumn: Math.max(1, r.column | 0) } : {}) } },
      ...(r.logical?.length ? { logicalLocations: r.logical.map(l => ({ name: text(l.name, 500), kind: l.kind })) } : {}),
    }],
    partialFingerprints: Object.fromEntries(Object.entries(r.fingerprints).sort(([a], [b]) => cmp(a, b))),
    ...(r.suppression ? { suppressions: [{ kind: 'external', status: r.suppression.status || 'accepted', ...(r.suppression.justification ? { justification: text(r.suppression.justification, 500) } : {}) }] } : {}),
  }, done));
  // a rule's entry: its level and security-severity are its worst result's, which (worst first) is its first one
  const ruleOf = (id, sev) => {
    const rule = rules.get(id) || { title: id };
    const tags = [...new Set(rule.tags || [])].sort().slice(0, GITHUB_LIMITS.tagsKept);
    return deepScrub({
      id, name: id, shortDescription: { text: plainText(rule.title || id, 200) },
      defaultConfiguration: { level: LEVEL[sev] || 'note' },
      properties: { ...(tags.length ? { tags } : {}), ...(rule.security ? { 'security-severity': SECURITY_SEVERITY[sev] || SECURITY_SEVERITY.low } : {}) },
    }, done);
  };
  const firstOf = new Map();
  ordered.slice(0, cap).forEach((r, i) => { if (!firstOf.has(r.ruleId)) firstOf.set(r.ruleId, { i, entry: ruleOf(r.ruleId, r.severity) }); });
  // why it was cut: GitHub's cap, the size, or both
  const truncatedAt = n => {
    if (n >= of) return null;
    const why = [...(of > keep ? [`GitHub keeps ${keep.toLocaleString('en-US')} results per run`] : []), ...(n < cap ? [`the file would be over ${+(maxBytes / 1024 / 1024).toFixed(2)} MB`] : [])];
    return { kept: n, of, why: why.join('; and ') };
  };
  // the run around the results and rules, scrubbed as a piece; the results and rules (scrubbed already) go in after
  const logOf = (res, driverRules, truncated) => {
    const log = deepScrub({
      $schema: SARIF_SCHEMA, version: SARIF_VERSION,
      runs: [{
        tool: { driver: { name: 'nunchi', version, informationUri: 'https://github.com/wonchance-art/nunchi', rules: [] } },
        columnKind: 'utf16CodeUnits',
        originalUriBaseIds: { '%SRCROOT%': { description: { text: 'The root of the repository (paths are relative to it).' } } },
        results: [],
        ...(truncated ? { properties: { truncated: { kept: truncated.kept, of: truncated.of, why: truncated.why, limits: LIMITS_SOURCE } } } : {}),
      }],
    }, done);
    log.runs[0].tool.driver.rules = driverRules;
    log.runs[0].results = res;
    return log;
  };
  // bytes with the first n results: the run around them (no results, no rules) and what each result and rule adds
  const resultSums = [0], ruleSums = [0];
  for (let i = 0; i < cap; i++) {
    resultSums.push(resultSums[i] + elementBytes(json(out[i]), RESULTS_DEPTH));
    const first = firstOf.get(ordered[i].ruleId);
    ruleSums.push(ruleSums[i] + (first.i === i ? elementBytes(json(first.entry), RULES_DEPTH) : 0));
  }
  const bytesAt = n => Buffer.byteLength(stableJson(logOf([], [], truncatedAt(n)))) + arrayGrowth(resultSums[n], RESULTS_DEPTH) + arrayGrowth(ruleSums[n], RULES_DEPTH);
  // the most results that fit, found by halving over those sizes: the same answer for the same input
  let n = cap;
  if (bytesAt(n) > maxBytes) {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (bytesAt(mid) <= maxBytes) lo = mid; else hi = mid - 1; }
    n = lo;
  }
  const truncated = truncatedAt(n);
  const used = [...firstOf.entries()].filter(([, f]) => f.i < n).sort(([a], [b]) => cmp(a, b)).map(([, f]) => f.entry);
  const log = logOf(out.slice(0, n), used, truncated);
  return { log, text: stableJson(log), kept: n, of, truncated, bytesAt };
}
// What the CLI says when it cut (design §5: "stating it").
export const truncationLine = t => (t ? `SARIF truncated: ${t.kept.toLocaleString('en-US')} of ${t.of.toLocaleString('en-US')} results kept, worst first (${t.why}; ${LIMITS_SOURCE})` : null);
