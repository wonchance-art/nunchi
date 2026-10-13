// Rule lenses: pure functions from one scene's evidence to findings.
// A rule finding is backed by a measurement, so it skips the verifier (spec §4).
// Every finding names a selector or a URL; nothing here reads the network or the clock.

// Error class names count only as `TypeError: …` (a guide that mentions "a TypeError when …" is prose).
const RAW_ERROR = /\b((?:TypeError|ReferenceError|SyntaxError|RangeError):|Unhandled Runtime Error|Application error: a client-side exception|An error occurred in the Server Components render|Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|is not defined|Internal Server Error|ECONNREFUSED|ERR_[A-Z_]{4,}|at [\w.$<>]+ \([^)]*:\d+:\d+\))/;
const MISSING_VALUE = [
  { re: /\bundefined\b/, kind: 'undefined' },
  { re: /\bNaN\b/, kind: 'NaN' },
  { re: /\[object Object\]/, kind: '[object Object]' },
  { re: /\{\{\s*[\w.]+\s*\}\}/, kind: 'unreplaced {{…}}' },
  { re: /\$\{[\w.]+\}/, kind: 'unreplaced ${…}' },
  { re: /(^|\s)%[sd](\s|$)/, kind: 'unreplaced %s' },
];
const PLACEHOLDER = [
  // placeholder prose, not the words themselves ("Lorem Ipsum Generator" is a real tool's name)
  { re: /\blorem ipsum\s+(dolor|sit|amet)\b/i, kind: 'Lorem ipsum' },
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
  // next/font's metric-matched fallback faces point at local() system fonts (Arial) and fail on machines
  // without them; they are not the app's font.
  const failedFonts = m.fonts.filter(f => f.status === 'error' && !/_Fallback(_[0-9a-f]+)?$/.test(f.family));
  if (failedFonts.length) add({ lens: 'L1', id: 'font-not-loaded', severity: 'medium', evidence: { fonts: failedFonts.map(f => `${f.family} ${f.weight} ${f.style}`).sort() } });
  if (m.clsBand && m.clsBand !== 'good') add({ lens: 'L1', id: 'layout-shift', severity: m.clsBand === 'poor' ? 'high' : 'medium', evidence: { band: m.clsBand, threshold: 0.1 } });
  for (const e of ev.pageErrors) add({ lens: 'L1', id: 'page-error', severity: 'high', evidence: { message: e } });
  const brokenSrcs = new Set(m.images.map(i => { try { return new URL(i.src, 'http://x').pathname; } catch { return i.src; } }));
  // In the forced error and offline states the failures are nunchi's own doing, not findings.
  const forcedFailures = ev.state === 'error' || ev.state === 'offline';
  // Only requests this screen depends on: data, scripts and styles. Images are judged when visible
  // (broken-image); an image 404 from a prefetch of another route is that route's problem.
  const CRITICAL = new Set(['fetch', 'xhr', 'script', 'stylesheet']);
  for (const r of ev.requests.filter(r => !forcedFailures && r.sameOrigin && r.status >= 400 && !r.document && (!r.type || CRITICAL.has(r.type)) && !brokenSrcs.has(r.path.split('?')[0]))) add({ lens: 'L1', id: 'failed-request', severity: 'medium', evidence: { url: r.path, status: r.status, method: r.method } });

  // L2 states (measurable part): a forced state that leaves the main area blank
  if (ev.state && ev.state !== 'normal' && !(m.mainText || '').trim()) add({ lens: 'L2', id: 'blank-state', severity: 'high', selector: 'main', evidence: { state: ev.state } });

  // L6 copy quality (measurable part)
  // Quoted spans and code samples are text about errors, not errors on screen.
  const code = new Set(m.codeLines || []);
  const prose = m.text.split('\n').filter(l => !code.has(l.trim())).join('\n')
    // a quote in prose opens after a space and closes before a space or punctuation; JSON keys and
    // values ({"message":"…"}) do not, and raw JSON on screen is itself a finding
    .replace(/(^|[\s(\[])(["'`“‘])[^"'`”’\n]{1,160}?["'`”’](?=[\s.,;!?)\]]|$)/gm, '$1 ');
  const raw = snippet(prose, RAW_ERROR);
  if (raw) add({ lens: 'L6', id: 'raw-error-text', severity: 'high', selector: 'body', evidence: { text: raw } });
  // Lines already reported as raw errors are not reported again as missing values.
  const valueText = prose.split('\n').filter(l => !RAW_ERROR.test(l)).join('\n');
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
  // An undersized target still passes when a 24px circle centred on it touches no other target and no
  // other undersized target's circle (the spacing exception); on the phone it is then touch guidance.
  const targets = m.controls.filter(c => !c.inline);
  const small = c => c.box[2] < 24 || c.box[3] < 24;
  const centre = ([x, y, w, h]) => [x + w / 2, y + h / 2];
  const toRect = ([px, py], [x, y, w, h]) => Math.hypot(Math.max(x - px, 0, px - (x + w)), Math.max(y - py, 0, py - (y + h)));
  const spaced = c => {
    const p = centre(c.box);
    return targets.every(o => o === c || (toRect(p, o.box) >= 12 && (!small(o) || Math.hypot(p[0] - centre(o.box)[0], p[1] - centre(o.box)[1]) >= 24)));
  };
  const phone = ev.viewport === 'm';
  for (const c of targets.filter(c => !['input', 'select', 'textarea'].includes(c.tag))) {
    const [, , w, h] = c.box;
    // 44px is touch guidance for icon controls (no text, or a glyph like ×), so it is judged on the
    // phone only; text links and buttons are held to the WCAG minimum, or every nav link would be flagged.
    const iconLike = !c.hasText || (c.text ?? c.name).trim().length <= 2;
    if (small(c)) {
      if (!spaced(c)) add({ lens: 'L8', id: 'target-size-min', severity: 'medium', selector: c.selector, box: c.box, evidence: { width: w, height: h, minimum: 24, name: c.name } });
      else if (phone && iconLike) add({ lens: 'L8', id: 'target-size-recommended', severity: 'low', selector: c.selector, box: c.box, evidence: { width: w, height: h, recommended: 44, name: c.name, note: 'passes WCAG 2.5.8 by spacing; small for a finger' } });
    } else if (phone && iconLike && (w < 44 || h < 44)) add({ lens: 'L8', id: 'target-size-recommended', severity: 'low', selector: c.selector, box: c.box, evidence: { width: w, height: h, recommended: 44, name: c.name } });
  }

  for (const f of (m.fields || []).filter(f => !f.labelled && f.placeholder)) {
    add({ lens: 'L8', id: 'placeholder-as-label', severity: 'medium', selector: f.selector, box: f.box, evidence: { placeholder: f.placeholder } });
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
