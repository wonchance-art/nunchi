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

  const controls = [];
  for (const el of document.querySelectorAll('a[href],button,[role="button"],[role="link"],input,select,textarea,summary')) {
    if (controls.length >= MAX || !vis(el)) continue;
    const text = (el.innerText || '').trim();
    controls.push({
      selector: sel(el), tag: el.localName, role: el.getAttribute('role') || null,
      name: name(el), hasText: text.length > 0, text: text.slice(0, 40), box: box(el),
      href: el.localName === 'a' ? el.getAttribute('href') : null,
      inline: el.localName === 'a' && getComputedStyle(el).display === 'inline',
      ...where(el),
    });
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

  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (clipped.length >= 50) break;
    if (!vis(el)) continue;
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!ownText) continue;
    const cs = getComputedStyle(el);
    if (!/hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
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
    links.push({ path: url.pathname, selector: sel(a), visible: vis(a) });
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
    controls, styles, clipped, images, links, fonts, fields, scrollers,
  };
}
