// Rule lenses: pure functions from one scene's evidence to findings.
// A rule finding is backed by a measurement, so it skips the verifier (spec §4).
// Every finding names a selector or a URL; nothing here reads the network or the clock.

const RAW_ERROR = /\b(TypeError|ReferenceError|SyntaxError|RangeError|Unhandled Runtime Error|Application error: a client-side exception|An error occurred in the Server Components render|Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|is not defined|Internal Server Error|ECONNREFUSED|ERR_[A-Z_]{4,}|at [\w.$<>]+ \([^)]*:\d+:\d+\))/;
const MISSING_VALUE = [
  { re: /\bundefined\b/, kind: 'undefined' },
  { re: /\bNaN\b/, kind: 'NaN' },
  { re: /\[object Object\]/, kind: '[object Object]' },
  { re: /\{\{\s*[\w.]+\s*\}\}/, kind: 'unreplaced {{…}}' },
  { re: /\$\{[\w.]+\}/, kind: 'unreplaced ${…}' },
  { re: /(^|\s)%[sd](\s|$)/, kind: 'unreplaced %s' },
];
const PLACEHOLDER = [
  { re: /\blorem ipsum\b/i, kind: 'Lorem ipsum' },
  { re: /\b(John|Jane) Doe\b/, kind: 'John/Jane Doe' },
  { re: /\b[\w.+-]+@example\.(com|org)\b|\bexample\.com\b/i, kind: 'example.com' },
  { re: /\b(TODO|FIXME|TBD)\b/, kind: 'TODO/FIXME' },
];
const COMING_SOON = /\bcoming soon\b/gi;

const finding = (scene, rule) => ({
  lens: rule.lens, rule: rule.id, severity: rule.severity,
  scene: scene.id, route: scene.route, viewport: scene.viewport,
  selector: rule.selector ?? null, box: rule.box ?? null,
  evidence: rule.evidence,
});

const snippet = (text, re) => {
  const m = text.match(re);
  if (!m) return null;
  const i = Math.max(0, m.index - 30);
  return text.slice(i, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim();
};

export function ruleFindings(ev) {
  const s = { id: ev.scene, route: ev.route, viewport: ev.viewport };
  const m = ev.measure;
  const out = [];
  const add = r => out.push(finding(s, r));

  // L1 broken
  if (ev.status && ev.status >= 400) add({ lens: 'L1', id: 'http-status', severity: 'high', evidence: { status: ev.status } });
  if (m.scrollWidth > m.viewport.width + 1) add({ lens: 'L1', id: 'horizontal-overflow', severity: 'high', selector: 'html', evidence: { scrollWidth: m.scrollWidth, viewportWidth: m.viewport.width } });
  for (const c of m.clipped) add({ lens: 'L1', id: 'clipped-text', severity: 'medium', selector: c.selector, box: c.box, evidence: { text: c.text, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth } });
  for (const i of m.images) add({ lens: 'L1', id: 'broken-image', severity: 'medium', selector: i.selector, box: i.box, evidence: { src: i.src } });
  const failedFonts = m.fonts.filter(f => f.status === 'error');
  if (failedFonts.length) add({ lens: 'L1', id: 'font-not-loaded', severity: 'medium', evidence: { fonts: failedFonts.map(f => `${f.family} ${f.weight} ${f.style}`).sort() } });
  if (m.clsBand && m.clsBand !== 'good') add({ lens: 'L1', id: 'layout-shift', severity: m.clsBand === 'poor' ? 'high' : 'medium', evidence: { band: m.clsBand, threshold: 0.1 } });
  for (const e of ev.pageErrors) add({ lens: 'L1', id: 'page-error', severity: 'high', evidence: { message: e } });
  const brokenSrcs = new Set(m.images.map(i => { try { return new URL(i.src, 'http://x').pathname; } catch { return i.src; } }));
  for (const r of ev.requests.filter(r => r.sameOrigin && r.status >= 400 && !r.document && !brokenSrcs.has(r.path.split('?')[0]))) add({ lens: 'L1', id: 'failed-request', severity: 'medium', evidence: { url: r.path, status: r.status, method: r.method } });

  // L6 copy quality (measurable part)
  const raw = snippet(m.text, RAW_ERROR);
  if (raw) add({ lens: 'L6', id: 'raw-error-text', severity: 'high', selector: 'body', evidence: { text: raw } });
  // Lines already reported as raw errors are not reported again as missing values.
  const valueText = m.text.split('\n').filter(l => !RAW_ERROR.test(l)).join('\n');
  for (const v of MISSING_VALUE) {
    const t = snippet(valueText, v.re);
    if (t) add({ lens: 'L6', id: 'missing-value', severity: 'high', selector: 'body', evidence: { kind: v.kind, text: t } });
  }

  // L7 vibe-coding leftovers (measurable part)
  for (const p of PLACEHOLDER) {
    const t = snippet(m.text, p.re);
    if (t) add({ lens: 'L7', id: 'placeholder-text', severity: 'medium', selector: 'body', evidence: { kind: p.kind, text: t } });
  }
  const soon = (m.text.match(COMING_SOON) || []).length;
  if (soon >= 3) add({ lens: 'L7', id: 'coming-soon-sprawl', severity: 'low', selector: 'body', evidence: { count: soon } });
  for (const c of m.controls.filter(c => c.href === '#' || /^javascript:/i.test(c.href || ''))) {
    add({ lens: 'L7', id: 'dead-href', severity: 'low', selector: c.selector, box: c.box, evidence: { href: c.href, name: c.name } });
  }

  // L8 accessibility
  for (const v of ev.axe) for (const n of v.nodes) {
    add({ lens: 'L8', id: `axe-${v.id}`, severity: v.id === 'color-contrast' ? 'medium' : 'high', selector: n.selector, evidence: { impact: v.impact, summary: n.summary } });
  }
  // WCAG 2.5.8: every target counts except links inline in a sentence. Form fields are left to axe.
  for (const c of m.controls.filter(c => !c.inline && !['input', 'select', 'textarea'].includes(c.tag))) {
    const [, , w, h] = c.box;
    if (w < 24 || h < 24) add({ lens: 'L8', id: 'target-size-min', severity: 'medium', selector: c.selector, box: c.box, evidence: { width: w, height: h, minimum: 24, name: c.name } });
    else if (w < 44 || h < 44) add({ lens: 'L8', id: 'target-size-recommended', severity: 'low', selector: c.selector, box: c.box, evidence: { width: w, height: h, recommended: 44, name: c.name } });
  }

  // L9 safety (measurable part)
  for (const d of ev.nativeDialogs) add({ lens: 'L9', id: 'native-dialog', severity: 'medium', evidence: { type: d.type, message: d.message } });

  return out;
}

// Secrets are a property of a bundle, not of a scene: one finding per (url, kind).
const SECRET_PATTERNS = [
  { kind: 'stripe-live-secret-key', re: /\bsk_live_[0-9A-Za-z]{16,}/g },
  { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];

function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload.role : null;
  } catch { return null; }
}

export const mask = value => value.slice(0, 4) + '…';

export function secretFindings(scripts) {
  const out = [];
  for (const { path, body } of scripts) {
    const hits = new Map();
    for (const p of SECRET_PATTERNS) for (const m of body.matchAll(p.re)) if (!hits.has(p.kind)) hits.set(p.kind, m[0]);
    for (const m of body.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g)) {
      if (jwtRole(m[0]) === 'service_role' && !hits.has('supabase-service-role-jwt')) hits.set('supabase-service-role-jwt', m[0]);
    }
    for (const [kind, value] of [...hits].sort()) {
      out.push({ lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: path, kind, masked: mask(value) } });
    }
  }
  return out;
}
