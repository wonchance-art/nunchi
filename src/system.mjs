// L4 (measured design system) and L10 (phone/desktop parity), computed from the evidence, no AI.
//
// L4: the app's own design system is whatever its screens actually use. design-system.json lists, per
// viewport, the colours, type sizes, weights, radii and shadows in use, the button shapes and the heading
// scale, each with the screens that use it (a screen = route × person: a guest's sign-in prompt and the
// signed-in page are different screens). A value used by one screen only, where at least three screens
// share another value for the same thing, is a one-off:
//   one-off-button-shape   a button (or button-styled link) whose height, radius and weight no other route uses
//   one-off-heading-size   an h1/h2/h3 size no other route uses
//   one-off-heading-color  an h1/h2/h3 colour no other route uses
// L10: a named control visible on desktop that the phone neither shows nor keeps in a menu:
//   missing-on-phone
const HEADINGS = ['h1', 'h2', 'h3'];
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
// Filled or outlined buttons, and links styled as them. Icon-only plain buttons (no fill, square corners)
// are a different component; controls under 24px are L8's target-size finding, not a shape.
// Taller than 56px is a clickable card or list row, not a button.
const buttonLike = r => r.height >= 24 && r.height <= 56 && (r.role === 'button' || r.role === 'link') && (!TRANSPARENT.test(r.background) || r.radius !== '0px');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// rowsByScene: Map(scene id → styles.json rows). Scenes: captured, normal state, not redirected.
export function buildSystem({ entries, rowsByScene }) {
  // Framework error pages (a 500 or 404 the app did not design) are their own finding, not the app's style.
  const scenes = entries.filter(e => e.status === 'captured' && e.state === 'normal' && !e.redirected && !(e.httpStatus >= 400)).sort((a, b) => cmp(a.id, b.id));
  const screen = e => (e.person === 'guest' ? e.route : `${e.route} (${e.person})`);
  // property → [{ value, screens, uses, examples }], most-used first. `unit` decides what counts as one user.
  const inventory = (list, unit) => {
    const inv = {};
    const add = (prop, value, e, row) => {
      if (value == null || value === '') return;
      const p = (inv[prop] ||= new Map());
      if (!p.has(value)) p.set(value, { units: new Set(), uses: 0, examples: [] });
      const v = p.get(value);
      v.units.add(unit(e)); v.uses++;
      if (v.examples.length < 3 && !v.examples.some(x => x.screen === unit(e))) v.examples.push({ screen: unit(e), route: e.route, scene: e.id, selector: row.selector });
    };
    for (const e of list) for (const row of rowsByScene.get(e.id) || []) {
      add('color', row.color, e, row);
      if (!TRANSPARENT.test(row.background || '')) add('background', row.background, e, row);
      add('fontSize', row.fontSize, e, row);
      add('fontWeight', row.fontWeight, e, row);
      add('fontFamily', row.fontFamily, e, row);
      if (row.radius && row.radius !== '0px') add('radius', row.radius, e, row);
      if (row.shadow) add('shadow', row.shadow, e, row);
      if (buttonLike(row)) add('buttonShape', `height ${row.height}px · radius ${row.radius} · weight ${row.fontWeight}`, e, row);
      if (HEADINGS.includes(row.role)) { add(`${row.role}.fontSize`, row.fontSize, e, row); add(`${row.role}.color`, row.color, e, row); }
    }
    const out = {};
    for (const prop of Object.keys(inv).sort()) {
      out[prop] = [...inv[prop]].map(([value, v]) => ({ value, screens: [...v.units].sort(), uses: v.uses, examples: v.examples }))
        .sort((a, b) => b.screens.length - a.screens.length || b.uses - a.uses || cmp(a.value, b.value));
    }
    return out;
  };
  const system = { schema: 1, viewports: {} };
  const findings = [];
  for (const vp of [...new Set(scenes.map(e => e.viewport))].sort()) {
    const mine = scenes.filter(e => e.viewport === vp);
    const out = inventory(mine, screen);
    system.viewports[vp] = {
      size: { colors: (out.color || []).length, backgrounds: (out.background || []).length, fontSizes: (out.fontSize || []).length, radii: (out.radius || []).length, shadows: (out.shadow || []).length, buttonShapes: (out.buttonShape || []).length },
      ...out,
    };
    // One-offs are judged per person over routes: a public page seen by both persons is still one route,
    // and a guest's sign-in prompt does not hide the signed-in page's own style.
    for (const person of [...new Set(mine.map(e => e.person))].sort()) {
      const byRoute = inventory(mine.filter(e => e.person === person), e => e.route);
      const oneOff = (prop, rule, label) => {
        const list = byRoute[prop] || [];
        const usual = list[0];
        if (!usual || usual.screens.length < 3) return;
        if (new Set(list.flatMap(x => x.screens)).size < 4) return;
        for (const v of list.slice(1)) {
          if (v.screens.length !== 1) continue;
          const ex = v.examples[0];
          // the same route also uses the usual heading value? then this is a variant (a second h2), not a one-off
          if (prop !== 'buttonShape' && usual.screens.includes(ex.route)) continue;
          // a button that differs only in height is a size variant (sm / lg): a one-off needs a corner
          // radius or a weight that no other route's buttons use
          if (prop === 'buttonShape') {
            const parts = x => /radius (\S+) · weight (\S+)/.exec(x.value).slice(1);
            const [radius, weight] = parts(v);
            const others = list.filter(x => x !== v && x.screens.some(r => r !== ex.route)).map(parts);
            if (others.some(o => o[0] === radius) && others.some(o => o[1] === weight)) continue;
          }
          findings.push({ lens: 'L4', rule, severity: 'low', scene: ex.scene, route: ex.route, viewport: vp, selector: ex.selector, box: null,
            evidence: { what: label, value: v.value, usual: usual.value, usualScreens: usual.screens.length, note: `only this screen uses this ${label}; ${usual.screens.length} screens use ${usual.value}` } });
        }
      };
      oneOff('buttonShape', 'one-off-button-shape', 'button shape');
      for (const h of HEADINGS) { oneOff(`${h}.fontSize`, 'one-off-heading-size', `${h} size`); oneOff(`${h}.color`, 'one-off-heading-color', `${h} colour`); }
    }
  }
  return { system, findings };
}

// controlsByScene: Map(scene id → { visible: controls.json, hidden: measure.hiddenControls }).
export function parityFindings({ entries, controlsByScene }) {
  const findings = [];
  const normal = entries.filter(e => e.status === 'captured' && e.state === 'normal' && !e.redirected);
  const pairs = new Map();
  for (const e of normal) {
    const k = `${e.route}|${e.person}`;
    if (!pairs.has(k)) pairs.set(k, {});
    pairs.get(k)[e.viewport] = e;
  }
  for (const [, { m, d }] of [...pairs].sort((a, b) => cmp(a[0], b[0]))) {
    if (!m || !d) continue;
    const dc = controlsByScene.get(d.id), mc = controlsByScene.get(m.id);
    if (!dc || !mc) continue;
    // Hidden elements report their text without the spaces layout puts between children, so names are
    // compared with whitespace removed.
    const key = n => n.toLowerCase().replace(/\s+/g, '');
    const onPhone = new Map();
    const phoneHasMenu = mc.visible.some(c => c.menuToggle);
    for (const c of mc.visible) if (c.name) onPhone.set(key(c.name), 'visible');
    for (const c of mc.hidden) if (!onPhone.has(key(c.name))) onPhone.set(key(c.name), c.menu ? 'menu' : 'hidden');
    const done = new Set();
    for (const c of dc.visible) {
      const n = key(c.name || '');
      if (!n || done.has(n)) continue;
      done.add(n);
      const state = onPhone.get(n);
      if (state === 'visible' || state === 'menu') continue;
      // desktop navigation the phone keeps behind a menu button that renders it only when opened
      if (c.inNav && phoneHasMenu) continue;
      findings.push({ lens: 'L10', rule: 'missing-on-phone', severity: 'medium', scene: m.id, route: m.route, viewport: 'm', selector: c.selector, box: null,
        evidence: { name: c.name, desktopScene: d.id, onPhone: state || 'absent', note: state === 'hidden' ? 'on the phone this control is in the page but hidden, and not in a menu' : 'the phone version of this screen has no control with this name' } });
    }
  }
  return findings;
}
