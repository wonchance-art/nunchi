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
import { stableJson } from './stable.mjs';
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
// space, a `[id]` folder or a `%` stays one path (GitHub decodes it), and no scheme or authority can be smuggled in.
export function uriOf(path) {
  return String(path).split('/').map(seg => [...seg].map(ch => (/^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/.test(ch) ? ch
    : [...new TextEncoder().encode(ch)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''))).join('')).join('/');
}
// SARIF's message text is plain text; GitHub shows its first sentence when space is short. Control characters, bidi
// marks and line breaks are flattened, and it is kept to a sane length.
export const plainText = (s, n = 1000) => { const t = scrub(s).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// `rules`: Map id → { title, severity (the worst of its results), lens, tags, security }. `results`: [{ ruleId,
// severity, message, path (repo-relative), line, column?, logical: [{ name, kind }], fingerprints: { name: value } }].
// → { log, kept, of, truncated: null | { kept, of, why } }
export function sarifLog({ version, rules, results, maxBytes = GITHUB_LIMITS.gzipBytes, keep = GITHUB_LIMITS.resultsKept }) {
  const ordered = [...results].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || cmp(a.ruleId, b.ruleId) || cmp(a.path, b.path)
    || a.line - b.line || (a.column || 0) - (b.column || 0) || cmp(stableJson(a.fingerprints), stableJson(b.fingerprints)) || cmp(a.message, b.message));
  const of = ordered.length;
  const build = n => {
    const kept = ordered.slice(0, n);
    const used = [...new Set(kept.map(r => r.ruleId))].sort();
    const worst = new Map();
    for (const r of kept) if (!worst.has(r.ruleId) || sevRank(r.severity) < sevRank(worst.get(r.ruleId))) worst.set(r.ruleId, r.severity);
    const driverRules = used.map(id => {
      const rule = rules.get(id) || { title: id };
      const sev = worst.get(id) || rule.severity || 'low';
      const tags = [...new Set(rule.tags || [])].sort().slice(0, GITHUB_LIMITS.tagsKept);
      return {
        id: scrub(id), name: scrub(id), shortDescription: { text: plainText(rule.title || id, 200) },
        defaultConfiguration: { level: LEVEL[sev] || 'note' },
        properties: { ...(tags.length ? { tags } : {}), ...(rule.security ? { 'security-severity': SECURITY_SEVERITY[sev] || SECURITY_SEVERITY.low } : {}) },
      };
    });
    const out = kept.map(r => ({
      ruleId: scrub(r.ruleId),
      level: LEVEL[r.severity] || 'note',
      message: { text: plainText(r.message) },
      locations: [{
        physicalLocation: { artifactLocation: { uri: uriOf(scrub(r.path)), uriBaseId: '%SRCROOT%' }, region: { startLine: Math.max(1, r.line | 0), ...(r.column ? { startColumn: Math.max(1, r.column | 0) } : {}) } },
        ...(r.logical?.length ? { logicalLocations: r.logical.map(l => ({ name: plainText(l.name, 500), kind: l.kind })) } : {}),
      }],
      partialFingerprints: Object.fromEntries(Object.entries(r.fingerprints).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => [k, scrub(v)])),
    }));
    const truncated = n < of ? { kept: n, of, why: n < Math.min(of, keep) ? `the file would be over ${maxBytes / 1024 / 1024} MB` : `GitHub keeps ${keep.toLocaleString('en-US')} results per run` } : null;
    return {
      log: {
        $schema: SARIF_SCHEMA, version: SARIF_VERSION,
        runs: [{
          tool: { driver: { name: 'nunchi', version, informationUri: 'https://github.com/wonchance-art/nunchi', rules: driverRules } },
          columnKind: 'utf16CodeUnits',
          originalUriBaseIds: { '%SRCROOT%': { description: { text: 'The root of the repository (paths are relative to it).' } } },
          results: out,
          ...(truncated ? { properties: { truncated: { kept: truncated.kept, of: truncated.of, why: truncated.why, limits: LIMITS_SOURCE } } } : {}),
        }],
      },
      truncated,
    };
  };
  let n = Math.min(of, keep);
  let r = build(n);
  if (Buffer.byteLength(stableJson(r.log)) > maxBytes) {
    // the most results that fit, found by halving: the same answer for the same input
    let lo = 0, hi = n;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (Buffer.byteLength(stableJson(build(mid).log)) <= maxBytes) lo = mid; else hi = mid - 1; }
    n = lo; r = build(n);
  }
  return { log: r.log, text: stableJson(r.log), kept: n, of, truncated: r.truncated };
}
// What the CLI says when it cut (design §5: "stating it").
export const truncationLine = t => (t ? `SARIF truncated: ${t.kept.toLocaleString('en-US')} of ${t.of.toLocaleString('en-US')} results kept, worst first (${t.why}; ${LIMITS_SOURCE})` : null);
