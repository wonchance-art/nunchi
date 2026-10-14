// Design supporter, Stage 0 ("Tidy"): the look the app already has, consolidated into a token proposal.
// Computed from a run's evidence (styles.json and paint.json per scene), no AI, deterministic.
//
// Colours. Every colour a screen paints (text, page and container backgrounds, control fills, borders and
// outlines, SVG fills and strokes) is a member; its weight is the number of distinct style rows that use it
// (the evidence keeps one row per distinct look), counted once per screen (route × person) however many
// viewports and states showed it. Members are
// clustered in OKLab by leader clustering: in order of weight (then screens, then value), each colour joins
// the nearest existing cluster whose leader is within ΔE_OK ≤ MERGE_DE and whose alpha is within
// ALPHA_TOLERANCE, else it leads a new cluster. A colour never joins a cluster holding a colour it is seen
// against (paint.json `on`: a card and the page under it, a border and its background): merging those would
// make the card or the line disappear, however close they are. A cluster's proposed value is its leader, the most-used
// member, so adopting the token changes no pixel of that colour and moves the others by at most ΔE_OK 0.03
// (about one just-noticeable difference). Nothing is random; ties fall back to string order.
// Radii and font sizes are clustered the same way in one dimension (tolerances below).
// Roles (background, surface, border, text, muted text, accent, accent foreground, danger, success,
// warning) are inferred from where each cluster is used, each with a confidence, and the text/background
// pairs are checked for WCAG 2.x contrast. The engine never edits the app: the CSS is a proposal file.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const MERGE_DE = 0.03;          // OKLab distance under which two colours are one token
export const ALPHA_TOLERANCE = 0.1;    // translucent and opaque colours never merge
export const NEUTRAL_CHROMA = 0.05;    // OKLCh chroma under which a colour is a grey (Tailwind's slate is ~0.04)
export const RADIUS_TOL = { px: 2, ratio: 0.2 };     // radii within max(2px, 20% of the larger) are one token
export const FONT_TOL = { px: 0.5, ratio: 0.07 };    // font sizes within max(0.5px, 7% of the larger)
export const PILL_PX = 500;            // radii this large are "fully rounded" whatever the number

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round = (x, n = 4) => { const f = 10 ** n; const r = Math.round(x * f) / f; return Object.is(r, -0) ? 0 : r; };

// ───────────── colour parsing and conversion ─────────────
const mul = (m, v) => m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const toLinear = c => { const a = Math.abs(c); return Math.sign(c) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
const fromLinear = c => { const a = Math.abs(c); return Math.sign(c) * (a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055); };
const XYZ65_TO_SRGB = [[3.2409699419045226, -1.537383177570094, -0.4986107602930034], [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559], [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]];
const P3_TO_XYZ65 = [[0.4865709486482162, 0.26566769316909306, 0.1982172852343625], [0.2289745640697488, 0.6917385218365064, 0.079286914093745], [0, 0.04511338185890264, 1.043944368900976]];
const D50_TO_D65 = [[0.955473421488075, -0.02309845494876471, 0.06325924320057072], [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323], [0.012314014864481998, -0.020507649298898964, 1.330365926242124]];
const D50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
function labToLinear([L, a, b]) {
  const k = 24389 / 27, e = 216 / 24389;
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const xyz = [fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k, L > k * e ? fy ** 3 : L / k, fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k].map((v, i) => v * D50[i]);
  return mul(XYZ65_TO_SRGB, mul(D50_TO_D65, xyz));
}
const polar = (L, C, h) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

// Computed-style colour strings → { lin: linear-light sRGB (may be out of gamut), alpha }, or null when the
// syntax is one nunchi does not read (reported under `unparsed`, never guessed).
export function parseColor(input) {
  const s = String(input || '').trim().toLowerCase();
  if (s === 'transparent') return { lin: [0, 0, 0], alpha: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? [...m[1]].map(c => c + c).join('') : m[1];
    const n = [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
    return { lin: n.slice(0, 3).map(toLinear), alpha: n[3] };
  }
  m = /^([a-z-]+)\((.*)\)$/.exec(s);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  let space = null;
  if (fn === 'color') { const sp = /^([a-z0-9-]+)\s+(.*)$/.exec(body); if (!sp) return null; space = sp[1]; body = sp[2]; }
  let alphaPart = null;
  if (body.includes('/')) { [body, alphaPart] = body.split('/').map(x => x.trim()); }
  let parts = body.includes(',') ? body.split(',').map(x => x.trim()) : body.split(/\s+/);
  if ((fn === 'rgba' || fn === 'rgb') && parts.length === 4 && alphaPart === null) { alphaPart = parts[3]; parts = parts.slice(0, 3); }
  if (parts.length !== 3) return null;
  const num = (x, pct = 1) => { if (x === 'none') return 0; const v = parseFloat(x); if (!Number.isFinite(v)) return NaN; return x.endsWith('%') ? (v / 100) * pct : v; };
  const alpha = alphaPart === null ? 1 : num(alphaPart, 1);
  let lin;
  if (fn === 'rgb' || fn === 'rgba') lin = parts.map(x => toLinear(num(x, 255) / 255));
  else if (fn === 'oklab') lin = oklabToLinear([num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)]);
  else if (fn === 'oklch') lin = oklabToLinear(polar(num(parts[0], 1), num(parts[1], 0.4), num(parts[2])));
  else if (fn === 'lab') lin = labToLinear([num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)]);
  else if (fn === 'lch') lin = labToLinear(polar(num(parts[0], 100), num(parts[1], 150), num(parts[2])));
  else if (fn === 'color') {
    const v = parts.map(x => num(x, 1));
    if (space === 'srgb') lin = v.map(toLinear);
    else if (space === 'srgb-linear') lin = v;
    else if (space === 'display-p3') lin = mul(XYZ65_TO_SRGB, mul(P3_TO_XYZ65, v.map(toLinear)));
    else if (space === 'xyz' || space === 'xyz-d65') lin = mul(XYZ65_TO_SRGB, v);
    else if (space === 'xyz-d50') lin = mul(XYZ65_TO_SRGB, mul(D50_TO_D65, v));
    else return null;
  } else return null;
  if (![...lin, alpha].every(Number.isFinite)) return null;
  return { lin, alpha: Math.min(1, Math.max(0, alpha)) };
}

export const oklabOf = c => linearToOklab(c.lin);
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const oklchOf = lab => [lab[0], Math.hypot(lab[1], lab[2]), ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360];

// Hue families for counting and role hints, by OKLCh hue angle (degrees).
const FAMILIES = [[45, 'red'], [80, 'orange'], [120, 'yellow'], [175, 'green'], [230, 'cyan'], [285, 'blue'], [320, 'purple'], [345, 'pink'], [360, 'red']];
export function familyOf(lab) {
  const [, C, h] = oklchOf(lab);
  if (C < NEUTRAL_CHROMA) return 'grey';
  return FAMILIES.find(([max]) => h < max)[1];
}

// WCAG 2.x relative luminance and contrast ratio. A translucent foreground is composited over the
// background, and a translucent background over white (the page canvas), in gamma-encoded sRGB as browsers do.
const encoded = c => c.lin.map(v => Math.min(1, Math.max(0, fromLinear(v))));
const over = (top, alpha, under) => top.map((v, i) => alpha * v + (1 - alpha) * under[i]);
const luminance = rgb => { const [r, g, b] = rgb.map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrastRatio(fgColor, bgColor) {
  const bg = over(encoded(bgColor), bgColor.alpha, [1, 1, 1]);
  const fg = over(encoded(fgColor), fgColor.alpha, bg);
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ───────────── leader clustering ─────────────
// members: [{ value, uses, screens: Set, ... }]. distance(member, leader) → number, Infinity when too far;
// allowed(member, cluster) → false when the member must not join that cluster.
function leaderCluster(members, distance, tie, allowed = () => true) {
  const order = [...members].sort((a, b) => b.uses - a.uses || b.screens.size - a.screens.size || tie(a, b));
  const clusters = [];
  for (const m of order) {
    let best = null, bestD = Infinity;
    for (const c of clusters) { const d = distance(m, c.leader); if (d < bestD && allowed(m, c)) { best = c; bestD = d; } }
    if (best) best.members.push({ ...m, distance: bestD });
    else clusters.push({ leader: m, members: [{ ...m, distance: 0 }] });
  }
  return clusters;
}

// ───────────── usage collection ─────────────
// One use = (screen, selector, context, value), so the same element seen at two widths or in five forced
// states counts once.
function usage() {
  const map = new Map();
  const seen = new Set();
  return {
    map,
    add(value, context, scene, selector, screen, extra) {
      if (value == null || value === '') return false;
      const k = JSON.stringify([screen, selector, context, value, extra ?? null]);
      if (seen.has(k)) return false;
      seen.add(k);
      if (!map.has(value)) map.set(value, { value, uses: 0, screens: new Set(), contexts: {}, examples: [] });
      const v = map.get(value);
      v.uses++; v.screens.add(screen);
      v.contexts[context] = (v.contexts[context] || 0) + 1;
      if (v.examples.length < 3 && !v.examples.some(x => x.screen === screen)) v.examples.push({ screen, scene, selector, context });
      return true;
    },
  };
}

const TRANSPARENT = c => { const p = parseColor(c); return !p || p.alpha === 0; };
const TEXT_ROLES = /^(text|h[1-6])$/;

// scenes: [{ id, screen, styles: styles.json rows, paint: paint.json or null }], in any order.
export function buildTokens({ scenes }) {
  const list = [...scenes].sort((a, b) => cmp(a.id, b.id));
  const colors = usage(), radii = usage(), sizes = usage();
  const fills = new Map();   // fill value → Map(text colour value → Set of "screen|selector")
  const apart = new Set();   // "a|b": a colour seen against the other (a card on the page, a line on a card)
  const keepApart = (a, b) => { if (a && b && a !== b) { apart.add(`${a}|${b}`); apart.add(`${b}|${a}`); } };
  let withPaint = 0;
  for (const s of list) {
    const P = s.paint;
    if (P) withPaint++;
    for (const r of s.styles || []) {
      const ownFill = !TRANSPARENT(r.background);
      const ctx = ownFill ? 'on-fill' : TEXT_ROLES.test(r.role) ? 'text' : r.role === 'link' ? 'link' : 'control-text';
      colors.add(r.color, ctx, s.id, r.selector, s.screen);
      if (ownFill) {
        if (!fills.has(r.background)) fills.set(r.background, new Map());
        const f = fills.get(r.background);
        if (!f.has(r.color)) f.set(r.color, new Set());
        f.get(r.color).add(`${s.screen}|${r.selector}`);
        // runs captured before paint.json existed: the text rows' own backgrounds are all there is
        if (!P) colors.add(r.background, r.role === 'button' || r.role === 'link' || r.role === 'input' ? 'fill' : 'surface', s.id, r.selector, s.screen);
      }
      if (r.radius && r.radius !== '0px') radii.add(r.radius, TEXT_ROLES.test(r.role) ? 'text' : 'control', s.id, r.selector, s.screen);
      if (r.fontSize) sizes.add(r.fontSize, r.role, s.id, r.selector, s.screen);
    }
    if (!P) continue;
    for (const x of P.surfaces || []) {
      colors.add(x.background, x.kind === 'page' || x.kind === 'canvas' ? 'page' : x.kind === 'control' ? 'fill' : x.kind === 'band' ? 'band' : 'surface', s.id, x.selector, s.screen);
      keepApart(x.background, x.on);
      if (x.radius && x.radius !== '0px') radii.add(x.radius, x.kind === 'control' ? 'control' : 'surface', s.id, x.selector, s.screen);
    }
    for (const x of P.borders || []) { colors.add(x.color, x.sides === 'outline' ? 'outline' : 'border', s.id, x.selector, s.screen, x.sides); keepApart(x.color, x.on); }
    for (const x of P.svg || []) { colors.add(x.fill, 'svg-fill', s.id, x.selector, s.screen); colors.add(x.stroke, 'svg-stroke', s.id, x.selector, s.screen); }
  }

  // ── colours ──
  const unparsed = [];
  const members = [];
  for (const v of [...colors.map.values()].sort((a, b) => cmp(a.value, b.value))) {
    const c = parseColor(v.value);
    if (!c) { unparsed.push({ value: v.value, uses: v.uses }); continue; }
    if (c.alpha === 0) continue;
    members.push({ ...v, color: c, lab: oklabOf(c) });
  }
  const labOf = new Map(members.map(m => [m.value, m.lab]));
  const near = (m, l) => Math.abs(m.color.alpha - l.color.alpha) <= ALPHA_TOLERANCE && deltaE(m.lab, l.lab) <= MERGE_DE;
  const blocked = [];
  const colorClusters = leaderCluster(members, (m, l) => (near(m, l) ? deltaE(m.lab, l.lab) : Infinity), (a, b) => cmp(a.value, b.value),
    (m, c) => { const x = c.members.find(y => apart.has(`${m.value}|${y.value}`)); if (x) blocked.push([m.value, c.leader.value, x.value]); return !x; });
  const clusterOf = new Map();
  const palette = colorClusters.map(c => {
    const leader = c.leader;
    const screens = new Set(c.members.flatMap(m => [...m.screens]));
    const contexts = {};
    for (const m of c.members) for (const [k, n] of Object.entries(m.contexts)) contexts[k] = (contexts[k] || 0) + n;
    const cluster = {
      value: leader.value, family: familyOf(leader.lab), alpha: round(leader.color.alpha, 3),
      oklch: oklchOf(leader.lab).map((x, i) => round(x, i === 2 ? 1 : 4)),
      uses: c.members.reduce((n, m) => n + m.uses, 0), screens: screens.size, contexts: sortObj(contexts),
      spread: round(Math.max(...c.members.map(m => m.distance))),
      members: c.members.map(m => ({ value: m.value, uses: m.uses, screens: m.screens.size, deltaE: round(m.distance), contexts: sortObj(m.contexts), examples: m.examples.map(({ scene, selector, context }) => ({ scene, selector, context })) }))
        .sort((a, b) => b.uses - a.uses || b.screens - a.screens || cmp(a.value, b.value)),
      _color: leader.color, _lab: leader.lab, _screensByCtx: {},
    };
    // screens per context, for coverage: a role seen on most screens is a surer guess than one seen once
    for (const m of c.members) {
      clusterOf.set(m.value, cluster);
      for (const ctx of Object.keys(m.contexts)) { cluster._screensByCtx[ctx] ||= new Set(); for (const sc of m.screens) cluster._screensByCtx[ctx].add(sc); }
    }
    return cluster;
  });
  // token names: per family, lightest first (then alpha, then value)
  const byFamily = new Map();
  for (const cl of palette) { if (!byFamily.has(cl.family)) byFamily.set(cl.family, []); byFamily.get(cl.family).push(cl); }
  for (const [fam, cls] of byFamily) {
    cls.sort((a, b) => b._lab[0] - a._lab[0] || b.alpha - a.alpha || cmp(a.value, b.value));
    cls.forEach((cl, i) => { cl.token = `--${fam}-${i + 1}`; });
  }
  palette.sort((a, b) => cmp(a.family, b.family) || b._lab[0] - a._lab[0] || b.alpha - a.alpha || cmp(a.value, b.value));
  // near-duplicates left as two tokens because one is seen against the other
  const keptApart = [];
  const kSeen = new Set();
  for (const [m, leader, against] of blocked) {
    const a = clusterOf.get(m), b = clusterOf.get(leader);
    if (!a || !b || a === b) continue;
    const k = [a.token, b.token].sort().join('|');
    if (kSeen.has(k)) continue;
    kSeen.add(k);
    keptApart.push({ colors: [a.token, b.token].sort(), values: [m, leader].sort(), deltaE: round(deltaE(labOf.get(m), labOf.get(leader))), seenAgainst: against });
  }
  keptApart.sort((a, b) => cmp(a.colors.join('|'), b.colors.join('|')));

  // ── roles ──
  const allScreens = new Set(list.map(s => s.screen));
  const ctxUses = (cl, ctxs) => ctxs.reduce((n, k) => n + (cl.contexts[k] || 0), 0);
  const ctxScreens = (cl, ctxs) => new Set(ctxs.flatMap(k => [...(cl._screensByCtx[k] || [])])).size;
  const pick = (ctxs, filter = () => true) => {
    const cands = palette.filter(cl => ctxUses(cl, ctxs) > 0 && filter(cl));
    if (!cands.length) return null;
    cands.sort((a, b) => ctxUses(b, ctxs) - ctxUses(a, ctxs) || ctxScreens(b, ctxs) - ctxScreens(a, ctxs) || cmp(a.token, b.token));
    const best = cands[0];
    const total = palette.reduce((n, cl) => n + ctxUses(cl, ctxs), 0);
    const share = ctxUses(best, ctxs) / total;
    const coverage = Math.min(1, ctxScreens(best, ctxs) / Math.max(1, Math.min(3, allScreens.size)));
    return { cluster: best, share, coverage, uses: ctxUses(best, ctxs), screens: ctxScreens(best, ctxs) };
  };
  const roles = [];
  const level = c => (c >= 0.6 ? 'high' : c >= 0.3 ? 'medium' : 'low');
  const addRole = (role, p, why, cap = 1) => {
    if (!p) return null;
    const confidence = round(Math.min(cap, p.share * p.coverage), 2);
    roles.push({ role, token: `--color-${role}`, ref: p.cluster.token, value: p.cluster.value, confidence, level: level(confidence), evidence: `${why}: ${p.uses} use(s) on ${p.screens} screen(s), ${Math.round(p.share * 100)}% of them` });
    return p.cluster;
  };
  const bg = addRole('background', pick(['page']) || pick(['band']), 'page background (html, body or the canvas)');
  const surface = addRole('surface', pick(['surface', 'band'], cl => cl !== bg), 'container backgrounds');
  addRole('border', pick(['border']), 'borders');
  const text = addRole('text', pick(['text']), 'text colour');
  const bgColor = (bg || { _color: { lin: [1, 1, 1], alpha: 1 } })._color;
  if (text) {
    const textC = contrastRatio(text._color, bgColor);
    // grey, on the same side of the background as the text (both darker or both lighter), with less contrast
    // than the text but still readable as text (≥ 1.5:1)
    const bgL = bg ? bg._lab[0] : 1;
    const side = cl => Math.sign(cl._lab[0] - bgL);
    addRole('text-muted', pick(['text', 'control-text'], cl => {
      if (cl === text || cl.family !== 'grey' || side(cl) !== side(text)) return false;
      const c = contrastRatio(cl._color, bgColor);
      return c < textC && c >= 1.5;
    }), 'secondary text (grey, less contrast than the text colour)');
  }
  const accent = addRole('accent', pick(['fill'], cl => cl !== bg && cl !== surface) || pick(['link'], cl => cl.family !== 'grey'), 'control fills (filled buttons, links styled as buttons)');
  if (accent) {
    // the text colour most often set on the accent fill
    const on = new Map();   // text cluster → Set of "screen|selector" on an accent fill
    for (const [fill, byText] of fills) {
      if (clusterOf.get(fill) !== accent) continue;
      for (const [tc, set] of byText) {
        const cl = clusterOf.get(tc);
        if (!cl) continue;
        if (!on.has(cl)) on.set(cl, new Set());
        for (const x of set) on.get(cl).add(x);
      }
    }
    const cands = [...on].sort((a, b) => b[1].size - a[1].size || cmp(a[0].token, b[0].token));
    if (cands.length) {
      const [cl, set] = cands[0];
      const total = cands.reduce((n, [, s]) => n + s.size, 0);
      const screens = new Set([...set].map(x => x.split('|')[0])).size;
      addRole('accent-foreground', { cluster: cl, share: set.size / total, coverage: Math.min(1, screens / Math.max(1, Math.min(3, allScreens.size))), uses: set.size, screens }, 'text on the accent fill');
    }
  }
  // Status colours are guessed from hue alone, so they never claim more than medium confidence.
  const ALL = ['text', 'link', 'control-text', 'on-fill', 'fill', 'surface', 'band', 'border', 'outline', 'svg-fill', 'svg-stroke'];
  for (const [role, fams] of [['danger', ['red']], ['success', ['green']], ['warning', ['orange', 'yellow']]]) {
    addRole(role, pick(ALL, cl => fams.includes(cl.family) && cl !== accent), `the most-used ${fams.join(' or ')} colour (hue only)`, 0.5);
  }
  const roleOf = r => roles.find(x => x.role === r);
  const contrast = [];
  for (const [fg, bgr] of [['text', 'background'], ['text', 'surface'], ['text-muted', 'background'], ['text-muted', 'surface'], ['accent-foreground', 'accent'], ['accent', 'background'], ['danger', 'background']]) {
    const a = roleOf(fg), b = roleOf(bgr);
    if (!a || !b || a.ref === b.ref) continue;
    const ratio = round(contrastRatio(palette.find(c => c.token === a.ref)._color, palette.find(c => c.token === b.ref)._color), 2);
    contrast.push({ fg, bg: bgr, ratio, aa: ratio >= 4.5, aaLarge: ratio >= 3 });
  }

  // ── radii and font sizes ──
  const px = v => { const m = /^(-?[\d.]+)px/.exec(v); return m ? parseFloat(m[1]) : null; };
  const rank = c => (!c.special ? 0 : c.special === 'full' ? 1 : 2);   // numbers, then fully rounded, then percentages
  const oneD = (u, tol, special) => {
    const mem = [...u.map.values()].map(v => ({ ...v, n: px(v.value), special: special(v.value) })).filter(v => v.n !== null || v.special);
    const close = (a, b) => (a.special || b.special ? (a.special && a.special === b.special ? 0 : Infinity) : (Math.abs(a.n - b.n) <= Math.max(tol.px, tol.ratio * Math.max(a.n, b.n)) ? Math.abs(a.n - b.n) : Infinity));
    return leaderCluster(mem, close, (a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || cmp(a.value, b.value)).map(c => ({
      value: c.leader.value, n: c.leader.n, special: c.leader.special, uses: c.members.reduce((n, m) => n + m.uses, 0), screens: new Set(c.members.flatMap(m => [...m.screens])).size,
      members: c.members.map(m => ({ value: m.value, uses: m.uses, screens: m.screens.size, contexts: sortObj(m.contexts), examples: m.examples.map(({ scene, selector, context }) => ({ scene, selector, context })) }))
        .sort((a, b) => b.uses - a.uses || b.screens - a.screens || cmp(a.value, b.value)),
    })).sort((a, b) => rank(a) - rank(b) || (a.n ?? 0) - (b.n ?? 0) || cmp(a.value, b.value));
  };
  const radiusClusters = oneD(radii, RADIUS_TOL, v => (/%/.test(v) ? 'percent:' + v : (px(v) ?? 0) >= PILL_PX ? 'full' : null));
  let ri = 0;
  for (const r of radiusClusters) r.token = r.special === 'full' ? '--radius-full' : r.special ? `--radius-${r.value.replace(/[^0-9a-z]+/gi, '')}pct` : `--radius-${++ri}`;
  const sizeClusters = oneD(sizes, FONT_TOL, () => null);
  sizeClusters.forEach((c, i) => { c.token = `--font-size-${i + 1}`; });
  // body size: the most-used size of plain text; a tie goes to the size nearer the browser default (16px)
  const textUses = c => c.members.reduce((n, m) => n + (m.contexts.text || 0), 0);
  const bodySize = [...sizeClusters].sort((a, b) => textUses(b) - textUses(a) || Math.abs(a.n - 16) - Math.abs(b.n - 16) || a.n - b.n)[0];
  if (bodySize && bodySize.members.some(m => m.contexts.text)) bodySize.role = 'body';
  const strip = ({ n, special, ...rest }) => rest;

  // ── summary ──
  const fam = [...byFamily].map(([f, cls]) => ({ family: f, before: cls.reduce((n, c) => n + c.members.length, 0), after: cls.length }))
    .sort((a, b) => b.before - a.before || cmp(a.family, b.family));
  const colorsBefore = palette.reduce((n, c) => n + c.members.length, 0);
  const plural = { grey: 'greys', red: 'reds', orange: 'oranges', yellow: 'yellows', green: 'greens', cyan: 'cyans', blue: 'blues', purple: 'purples', pink: 'pinks' };
  const radiiBefore = radiusClusters.reduce((n, c) => n + c.members.length, 0);
  const sizesBefore = sizeClusters.reduce((n, c) => n + c.members.length, 0);
  const line = [...fam.map(f => `${f.before} ${plural[f.family]} → ${f.after}`), `${radiiBefore} radii → ${radiusClusters.length}`, `${sizesBefore} font sizes → ${sizeClusters.length}`].join(' · ');
  const report = {
    schema: 1,
    method: {
      colorSpace: 'OKLab', mergeDeltaE: MERGE_DE, alphaTolerance: ALPHA_TOLERANCE, neutralChroma: NEUTRAL_CHROMA,
      keptApart: 'a colour never merges with one it is seen against (a surface and what it sits on, a border and its background)',
      clustering: 'leader: by weight (uses, then screens, then value), each value joins the nearest leader within tolerance, else leads a new cluster; the leader is the proposed value',
      radius: `same token when |a − b| ≤ max(${RADIUS_TOL.px}px, ${RADIUS_TOL.ratio * 100}% of the larger); ≥ ${PILL_PX}px is fully rounded; percentages stand alone`,
      fontSize: `same token when |a − b| ≤ max(${FONT_TOL.px}px, ${FONT_TOL.ratio * 100}% of the larger)`,
      uses: 'distinct style rows per screen (route × person): identical elements on one screen count once, and a screen seen at two widths or in several states counts once',
      contrast: 'WCAG 2.x relative luminance; AA 4.5:1, large text 3:1',
    },
    scenes: list.length, screens: allScreens.size, measured: withPaint === list.length ? 'paint' : withPaint ? 'mixed' : 'styles-only',
    summary: { line, colors: { before: colorsBefore, after: palette.length }, families: fam, radii: { before: radiiBefore, after: radiusClusters.length }, fontSizes: { before: sizesBefore, after: sizeClusters.length } },
    colors: palette.map(({ _color, _lab, _screensByCtx, ...rest }) => rest),
    roles, contrast, keptApart,
    radii: radiusClusters.map(strip), fontSizes: sizeClusters.map(strip),
    unparsed,
  };
  report.css = tokensCss(report);
  return report;
}

function sortObj(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }

// The proposal as CSS custom properties. nunchi never writes it into the app (design §4.1).
export function tokensCss(report) {
  const lines = ['/* nunchi tokens: a proposal measured from your screens. nunchi does not apply it. */', ':root {', '  /* palette: one value per cluster, the most-used member */'];
  for (const c of report.colors) lines.push(`  ${c.token}: ${c.value};${c.members.length > 1 ? ` /* merges ${c.members.length - 1} near-duplicate(s), ΔE ≤ ${c.spread} */` : ''}`);
  if (report.roles.length) lines.push('  /* roles */');
  for (const r of report.roles) lines.push(`  ${r.token}: var(${r.ref}); /* confidence ${r.level} */`);
  if (report.radii.length) lines.push('  /* radii */');
  for (const r of report.radii) lines.push(`  ${r.token}: ${r.value};`);
  if (report.fontSizes.length) lines.push('  /* font sizes */');
  for (const f of report.fontSizes) lines.push(`  ${f.token}: ${f.value};`);
  const body = report.fontSizes.find(f => f.role === 'body');
  if (body) lines.push(`  --font-size-body: var(${body.token});`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

// Reads a run folder: captured scenes only (framework error pages, redirected scenes and canary copies left out).
export function readRunScenes(runDir) {
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const out = [];
  for (const e of manifest.scenes || []) {
    if (e.status !== 'captured' || e.redirected || e.httpStatus >= 400 || e.canary !== undefined) continue;
    const at = f => join(runDir, e.id, f);
    if (!existsSync(at('styles.json'))) continue;
    const styles = JSON.parse(readFileSync(at('styles.json'), 'utf8'));
    const paint = existsSync(at('paint.json')) ? JSON.parse(readFileSync(at('paint.json'), 'utf8')) : null;
    out.push({ id: e.id, screen: e.person === 'guest' ? e.route : `${e.route} (${e.person})`, styles, paint });
  }
  return out;
}

// One-screen summary for the CLI.
export function formatTokens(report, files) {
  const out = [`${report.scenes} scenes · ${report.screens} screens${report.measured === 'paint' ? '' : ` · measured from ${report.measured} (re-capture for backgrounds, borders and SVG)`}`];
  out.push(report.summary.line);
  for (const r of report.roles) out.push(`  ${r.token.padEnd(26)} ${r.ref.padEnd(12)} ${r.value.padEnd(24)} ${r.level} (${r.confidence})`);
  for (const c of report.contrast) out.push(`  contrast ${c.fg} on ${c.bg}: ${c.ratio.toFixed(2)}:1 ${c.aa ? 'AA' : c.aaLarge ? 'AA large text only' : 'FAILS AA'}`);
  if (report.unparsed.length) out.push(`  ${report.unparsed.length} colour value(s) in a syntax nunchi does not read: ${report.unparsed.map(u => u.value).slice(0, 3).join(', ')}`);
  if (files) out.push(`wrote ${files.join(', ')} (a proposal: nothing in your code was changed)`);
  return out.join('\n');
}
