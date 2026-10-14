// Functions that run inside the page. They must be self-contained (no closures over module
// scope) because Playwright serializes them. Output is plain JSON, ordered by document order.

// Installed before any app script: frozen clock, seeded random, layout-shift recorder.
export function initScript({ frozen, seed }) {
  const F = frozen;
  const D = Date;
  class FrozenDate extends D {
    constructor(...a) { super(...(a.length ? a : [F])); }
    static now() { return F; }
  }
  globalThis.Date = FrozenDate;
  let s = seed;
  Math.random = () => (s = (s * 16807) % 2147483647) / 2147483647;
  globalThis.__nunchiCls = { value: 0, windowValue: 0, first: 0, last: 0 };
  try {
    new PerformanceObserver(list => {
      const c = globalThis.__nunchiCls;
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        if (c.windowValue && (e.startTime - c.last > 1000 || e.startTime - c.first > 5000)) { c.windowValue = 0; }
        if (!c.windowValue) c.first = e.startTime;
        c.windowValue += e.value; c.last = e.startTime;
        c.value = Math.max(c.value, c.windowValue);
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
}

export const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

// Everything the rule lenses and the AI lenses read from the live DOM.
export function collect() {
  const MAX = 400;
  const vis = el => {
    if (!el.getClientRects().length) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.x + scrollX), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; };
  const sel = el => {
    const parts = [];
    let e = el;
    for (let depth = 0; e && e.nodeType === 1 && depth < 5; depth++) {
      let p = e.localName;
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift(`${p}#${e.id}`); break; }
      const tid = e.getAttribute('data-testid');
      if (tid) { parts.unshift(`${p}[data-testid="${tid}"]`); break; }
      const parent = e.parentElement;
      if (parent) {
        const same = [...parent.children].filter(c => c.localName === e.localName);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(p);
      if (p === 'main' || p === 'body') break;
      e = parent;
    }
    return parts.join(' > ');
  };
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('alt') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const doc = document.documentElement;
  // App-shell layouts scroll inside an element (\`main { overflow: auto }\`), not the window: the
  // full-page screenshot then shows only the first view of it. Elements outside an ancestor's visible
  // area are marked \`inside: <that ancestor>\` so a box is never drawn where the image does not show it.
  const CLIP = /(auto|scroll|overlay|hidden|clip)/;
  const inside = el => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (!CLIP.test(cs.overflowX + ' ' + cs.overflowY)) continue;
      const ar = a.getBoundingClientRect();
      if (r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right) return sel(a);
    }
    return null;
  };
  const where = el => { const i = inside(el); return i ? { inside: i } : {}; };
  const scrollers = [];
  for (const el of document.querySelectorAll('body *')) {
    if (scrollers.length >= 10) break;
    const cs = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
    if (!(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) || !vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 0.2 * innerWidth * innerHeight) continue;   // dropdowns, code blocks: not the page
    scrollers.push({ selector: sel(el), box: box(el), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }

  // Navigation regions and the buttons that open them: on phones a sidebar is often not in the page
  // at all until its toggle is pressed (shadcn's Sidebar renders a sheet on open).
  const NAV = 'nav,aside,header,[role="navigation"],[role="banner"],[data-sidebar],[data-slot="sidebar"]';
  const isToggle = el => el.matches('button,[role="button"]') && (el.hasAttribute('aria-expanded') || el.hasAttribute('aria-haspopup') || el.getAttribute('data-sidebar') === 'trigger' || /\b(menu|sidebar|navigation|nav)\b/i.test(name(el)));
  // A sidebar built from plain divs: a fixed or sticky column at least 60% of the screen tall and at
  // most 40% of it wide.
  const inRail = el => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const pos = getComputedStyle(a).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = a.getBoundingClientRect();
      return r.height >= 0.6 * innerHeight && r.width <= 0.4 * innerWidth;
    }
    return false;
  };
  const controls = [];
  for (const el of document.querySelectorAll('a[href],button,[role="button"],[role="link"],input,select,textarea,summary')) {
    if (controls.length >= MAX || !vis(el)) continue;
    const text = (el.innerText || '').trim();
    controls.push({
      selector: sel(el), tag: el.localName, role: el.getAttribute('role') || null,
      name: name(el), hasText: text.length > 0, text: text.slice(0, 40), box: box(el),
      href: el.localName === 'a' ? el.getAttribute('href') : null,
      inline: el.localName === 'a' && getComputedStyle(el).display === 'inline',
      ...(el.closest(NAV) || inRail(el) ? { inNav: true } : {}),
      ...(isToggle(el) ? { menuToggle: true } : {}),
      ...where(el),
    });
  }

  // Controls present in the DOM but not visible (L10 parity): inside a menu, a dialog or a region a visible
  // toggle controls, or simply hidden. A desktop control that is hidden on the phone and not in a menu
  // is one the phone user cannot reach.
  const toggled = new Set();
  for (const t of document.querySelectorAll('[aria-controls]')) if (vis(t)) for (const id of (t.getAttribute('aria-controls') || '').split(/\s+/)) if (id) toggled.add(id);
  const inMenu = el => {
    if (el.closest('nav,dialog,details,[role="menu"],[role="dialog"],[role="navigation"],[popover]')) return true;
    for (let a = el; a; a = a.parentElement) if (a.id && toggled.has(a.id)) return true;
    return false;
  };
  const hiddenControls = [];
  for (const el of document.querySelectorAll('a[href],button,[role="button"],[role="link"]')) {
    if (hiddenControls.length >= MAX || vis(el)) continue;
    const n = name(el);
    if (!n) continue;
    hiddenControls.push({ selector: sel(el), tag: el.localName, name: n, menu: inMenu(el) });
  }

  const styles = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (styles.length >= MAX) break;
    if (!vis(el)) continue;
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const interactive = el.matches('a[href],button,[role="button"],input,select,textarea');
    if (!ownText && !interactive) continue;
    const cs = getComputedStyle(el);
    const row = {
      role: interactive ? (el.localName === 'a' ? 'link' : el.localName === 'button' || el.getAttribute('role') === 'button' ? 'button' : 'input') : /^h[1-6]$/.test(el.localName) ? el.localName : 'text',
      color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight, fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      radius: cs.borderTopLeftRadius, shadow: cs.boxShadow === 'none' ? null : cs.boxShadow,
      padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      height: interactive ? Math.round(el.getBoundingClientRect().height) : null,
    };
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    styles.push({ ...row, selector: sel(el) });
  }

  // Paint: the colours the page paints that the text rows above miss (they keep only elements with their
  // own text or controls). Kept apart from `styles` so the L4 inventory and its fingerprints do not move.
  //   surfaces  non-transparent background-color of a visible element at least 256 px² in area and 2 px on
  //             its short side (smaller fills are dots and hairlines, not surfaces), plus the page: <html>
  //             and <body>, or the browser's white canvas when both are transparent (light scheme only).
  //             kind: page | canvas | control (link, button, field) | band (≥ 90% of the viewport wide) | box
  //   borders   visible border sides (width > 0, style not none/hidden, colour not transparent), one row per
  //             colour with the sides it is on (t r b l), and outlines (sides: outline)
  //   on        (surfaces and borders) the background the colour is seen against: for a surface the nearest
  //             ancestor's, for a border the element's own or else its ancestor's; the canvas at the top.
  //             A colour and what it is on must stay two tokens, or the card or the line disappears.
  //   svg       fill and stroke of visible inline SVG shapes (none and url(#gradient) paints left out)
  // Deduplicated like `styles`: the first element in document order with a given row keeps its selector.
  const clear = c => !c || c === 'transparent' || /,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const paint = { surfaces: [], borders: [], svg: [] };
  const paintSeen = new Set();
  const addPaint = (part, el, row) => {
    const list = paint[part];
    const key = JSON.stringify([part, row]);
    if (list.length >= MAX || paintSeen.has(key)) return;
    paintSeen.add(key);
    list.push({ ...row, selector: sel(el) });
  };
  const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use']);
  const roots = [doc, document.body].filter(e => !clear(getComputedStyle(e).backgroundColor));
  for (const e of roots) addPaint('surfaces', e, { background: getComputedStyle(e).backgroundColor, radius: '0px', kind: 'page' });
  const lightCanvas = !/^dark$/.test(getComputedStyle(doc).colorScheme.trim());
  if (!roots.length && lightCanvas) addPaint('surfaces', doc, { background: 'rgb(255, 255, 255)', radius: '0px', kind: 'canvas' });
  const canvas = roots.length ? getComputedStyle(roots[0]).backgroundColor : lightCanvas ? 'rgb(255, 255, 255)' : null;
  const behind = el => {
    for (let a = el.parentElement; a; a = a.parentElement) { const b = getComputedStyle(a).backgroundColor; if (!clear(b)) return b; }
    return canvas;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (paint.surfaces.length >= MAX && paint.borders.length >= MAX && paint.svg.length >= MAX) break;
    const shape = el instanceof SVGElement && el.localName !== 'svg';
    if (shape) {
      if (!SVG_SHAPES.has(el.localName) || el.closest('defs,symbol,clipPath,mask,marker,pattern')) continue;
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) continue;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const cs = getComputedStyle(el);
      const usable = v => v && v !== 'none' && !/^url\(/.test(v) && !clear(v);
      const fill = usable(cs.fill) && cs.fillOpacity !== '0' ? cs.fill : null;
      const stroke = usable(cs.stroke) && cs.strokeOpacity !== '0' && parseFloat(cs.strokeWidth) > 0 ? cs.stroke : null;
      if (fill || stroke) addPaint('svg', el, { fill, stroke });
      continue;
    }
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (!clear(cs.backgroundColor)) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 256 && Math.min(r.width, r.height) >= 2) {
        const kind = el.matches('a[href],button,[role="button"],input,select,textarea,summary') ? 'control' : r.width >= 0.9 * innerWidth ? 'band' : 'box';
        addPaint('surfaces', el, { background: cs.backgroundColor, radius: cs.borderTopLeftRadius, kind, on: behind(el) });
      }
    }
    const sides = new Map();
    for (const [s, S] of [['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']]) {
      const c = cs[`border${S}Color`];
      if (!(parseFloat(cs[`border${S}Width`]) > 0) || /^(none|hidden)$/.test(cs[`border${S}Style`]) || clear(c)) continue;
      if (!sides.has(c)) sides.set(c, { sides: '', width: cs[`border${S}Width`] });
      sides.get(c).sides += s;
    }
    const on = sides.size || cs.outlineStyle !== 'none' ? (clear(cs.backgroundColor) ? behind(el) : cs.backgroundColor) : null;
    for (const [color, v] of sides) addPaint('borders', el, { color, sides: v.sides, width: v.width, on });
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && !clear(cs.outlineColor)) addPaint('borders', el, { color: cs.outlineColor, sides: 'outline', width: cs.outlineWidth, on: behind(el) });
  }

  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (clipped.length >= 50) break;
    if (!vis(el)) continue;
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
    // visually hidden text for screen readers (sr-only: 1px box, clipped) is meant to be invisible
    if (el.clientWidth <= 1 || el.clientHeight <= 1 || /rect\(0/.test(cs.clip) || /inset\(50%/.test(cs.clipPath)) continue;
    if (el.scrollWidth > el.clientWidth + 1) clipped.push({ selector: sel(el), box: box(el), text: el.innerText.trim().slice(0, 80), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, ...where(el) });
  }

  // Form fields whose only description is a placeholder: it disappears as soon as the user types.
  const fields = [];
  for (const el of document.querySelectorAll('input,textarea,select')) {
    if (fields.length >= 100 || !vis(el)) continue;
    if (/^(hidden|submit|button|reset|checkbox|radio|image|range|color|file)$/i.test(el.type || '')) continue;
    const labelled = (el.labels && el.labels.length > 0) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
    fields.push({ selector: sel(el), box: box(el), labelled: !!labelled, placeholder: (el.getAttribute('placeholder') || '').slice(0, 80), ...where(el) });
  }

  const images = [];
  for (const img of document.images) {
    if (!vis(img)) continue;
    if (img.complete && img.naturalWidth === 0) images.push({ selector: sel(img), box: box(img), src: img.getAttribute('src'), ...where(img) });
  }

  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    let url;
    try { url = new URL(href, location.href); } catch { continue; }
    if (url.origin !== location.origin) continue;
    const lm = a.closest('nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"]');
    const landmark = !lm ? null : lm.getAttribute('role') === 'navigation' ? 'nav' : lm.getAttribute('role') === 'banner' ? 'header' : lm.getAttribute('role') === 'contentinfo' ? 'footer' : lm.localName;
    links.push({ path: url.pathname, selector: sel(a), visible: vis(a), landmark });
  }

  const fonts = [...document.fonts].map(f => ({ family: f.family.replace(/["']/g, ''), weight: f.weight, style: f.style, status: f.status }));
  const main = document.querySelector('main') || document.body;
  return {
    url: location.pathname + location.search,
    browserErrorPage: location.protocol === 'chrome-error:',
    title: document.title,
    h1: (document.querySelector('h1')?.innerText || '').trim().slice(0, 120),
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    text: (document.body.innerText || '').replace(/ /g, ' '),
    mainText: (main.innerText || '').replace(/ /g, ' '),
    // code samples and keyboard text: documentation quoting an error is not the app showing one
    codeLines: [...new Set([...document.querySelectorAll('pre,code,kbd,samp')].flatMap(e => (e.innerText || '').split('\n').map(l => l.trim()).filter(Boolean)))].slice(0, 2000),
    controls, hiddenControls, styles, paint, clipped, images, links, fonts, fields, scrollers,
  };
}
