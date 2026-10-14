// Deterministic capture: one browser, one fresh context per scene × viewport.
// Writes the evidence pack (spec §2.4) and returns rule findings. Wall-clock timings go to
// timing.json only, so every other file is byte-identical across runs of the same build.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { initScript, collect, FREEZE_CSS } from './collect.mjs';
import { ruleFindings, secretFindings, scrubSecrets } from './rules.mjs';
import { buildFlow } from './flow.mjs';
import { buildSystem, parityFindings } from './system.mjs';
import { annotate } from './ledger.mjs';
import { writeStable, sha } from './stable.mjs';
import { canaryMutate, canarySeed, plantCanaries } from './canary.mjs';
import { loadLenses, BUILTIN_DIR } from './lenses.mjs';
import { FONT_HOSTS, BACKEND_SUFFIXES, isBackendHost, isDataRequest, requestKey, forceResponse, Recording, redactUrl, redactText, baseUrlRefusal } from './network.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RULES = ['color-contrast', 'button-name', 'link-name', 'image-alt', 'label', 'duplicate-id-aria', 'select-name', 'input-button-name'];

export const VIEWPORTS = { m: { width: 390, height: 844 }, d: { width: 1280, height: 800 } };
const DEFAULT_CLOCK = Date.UTC(2026, 0, 15, 9, 0, 0);
export const STATES = ['normal', 'empty', 'error', 'slow', 'offline'];
const TEXTUAL = /json|text|javascript|xml|x-www-form-urlencoded|graphql/i;

// Scene folder name. Built from the route template (not the sample path), so a new sample value keeps
// the same scene. The encoding is one-to-one and safe on every file system: '/' → '~', capitals → '^'
// + lower case (case-insensitive disks), '~ ^ %' and anything outside a small safe set → %XX, Windows
// device names escaped. person, state and viewport never contain '.', so the name splits from the right.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
export function sceneSlug(route) {
  let s = '';
  for (const ch of route) {
    if (ch === '/') s += '~';
    else if (/[a-z0-9_\-.[\]$()@+]/.test(ch)) s += ch;
    else if (/[A-Z]/.test(ch)) s += '^' + ch.toLowerCase();
    else s += [...new TextEncoder().encode(ch)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  if (s.startsWith('~') && s.length > 1) s = s.slice(1);
  if (RESERVED.test(s)) s = '%' + s.charCodeAt(0).toString(16).toUpperCase() + s.slice(1);
  if (s.endsWith('.')) s = s.slice(0, -1) + '%2E';
  return s;
}
export function sceneId(route, person, state, vp) {
  return `${sceneSlug(route)}.${person}.${state}.${vp}`;
}

// D7: an aria snapshot writes what a field holds: `- textbox "API key": <value>`, a `- text:` child beside a
// placeholder, a select's options with the chosen one `[selected]`. A field keeps its node, name, state and
// placeholder (so a claim can still point at it); its value and every other child go. Lines of what an editor
// holds (contenteditable, role=textbox: `editorLines` from collect) go too.
const FIELD_NODE = /^(\s*)- (textbox|searchbox|spinbutton|combobox|slider|listbox)((?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)(:.*)?$/;
const INLINE_TEXT = /^\s*- [a-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*: (.+)$/;
export function ariaWithoutValues(yaml, editorLines = []) {
  const editor = new Set(editorLines);
  const unquote = s => { if (!/^".*"$/.test(s)) return s; try { return JSON.parse(s); } catch { return s; } };
  const editorText = line => {
    const m = INLINE_TEXT.exec(line);
    if (!m) return false;
    const t = String(unquote(m[1].trim())).replace(/\s+/g, ' ').trim();
    return editor.has(t) || (t.length >= 8 && editorLines.some(l => l.includes(t)));
  };
  const out = [];
  let field = -1, header = -1;                          // the field whose children follow: indentation, line
  for (const line of String(yaml).split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (field >= 0 && indent > field) {
      if (indent === field + 2 && /^\s*- \/placeholder:/.test(line)) { out.push(line); if (!out[header].endsWith(':')) out[header] += ':'; }
      continue;
    }
    field = -1;
    const m = FIELD_NODE.exec(line);
    if (m) {
      if (m[4] === ':') { field = indent; header = out.length; }
      out.push(`${m[1]}- ${m[2]}${m[3]}`);
      continue;
    }
    if (!editorText(line)) out.push(line);
  }
  return out.join('\n');
}

// Every string capture writes goes through the secret check: a secret-shaped one becomes [secret-shaped: kind].
const scrubDeep = v => (typeof v === 'string' ? scrubSecrets(v) : Array.isArray(v) ? v.map(scrubDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) : v);

// Strict replay (D11): what the recording cannot answer is never sent. A write that is not a data request
// (a beacon, a form post, a server action) is stopped the same way; an EventSource stream is stopped and a
// WebSocket closed (listed as `streams`, apart from the misses: a stream is never recorded).
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Forced states and canary copies of a person replay whenever that person does not capture live, even from an
// empty recording.
export const derivedMode = personMode => (personMode === 'live' ? 'live' : 'replay');

// Network policy for the whole browser, not just the page: the app under test and local hosts go
// direct, font hosts go direct or through the user's proxy, and everything else (including the
// browser's own update/telemetry traffic) is sent to a closed port. Expressed as a PAC script so it
// holds with or without a proxy.
export function pacScript({ appHost, proxyServer, allowHosts = [] }) {
  const viaProxy = proxyServer ? `PROXY ${new URL(proxyServer).host}` : 'DIRECT';
  const exact = [...FONT_HOSTS, ...BACKEND_SUFFIXES.filter(s => !s.startsWith('.')), ...allowHosts];
  const suffixes = BACKEND_SUFFIXES.filter(s => s.startsWith('.'));
  return `function FindProxyForURL(url, host) {
  if (host === ${JSON.stringify(appHost)} || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "DIRECT";
  var exact = ${JSON.stringify(exact)};
  for (var i = 0; i < exact.length; i++) if (host === exact[i]) return ${JSON.stringify(viaProxy)};
  var suffixes = ${JSON.stringify(suffixes)};
  for (var j = 0; j < suffixes.length; j++) if (host.length > suffixes[j].length && host.slice(-suffixes[j].length) === suffixes[j]) return ${JSON.stringify(viaProxy)};
  return "PROXY 127.0.0.1:9";
}`;
}

export async function launch({ browserPath, baseUrl, allowHosts = [] } = {}) {
  const executablePath = browserPath || process.env.NUNCHI_BROWSER || undefined;
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const appHost = baseUrl ? new URL(baseUrl).hostname : 'localhost';
  const pac = 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(pacScript({ appHost, proxyServer, allowHosts })).toString('base64');
  try {
    return await chromium.launch({ executablePath, args: [
      `--proxy-pac-url=${pac}`,
      '--font-render-hinting=none', '--disable-gpu', '--hide-scrollbars',
      // deterministic raster: same page, same pixels (tiling order and partial raster otherwise
      // leave 1–3 level differences on anti-aliased edges between runs)
      // (not --deterministic-mode: in chrome-headless-shell, Playwright's default, it turns on begin-frame
      // control, nothing is ever drawn and the first screenshot waits forever)
      '--run-all-compositor-stages-before-draw', '--disable-partial-raster',
      '--disable-skia-runtime-opts', '--disable-threaded-animation', '--disable-threaded-scrolling',
      '--disable-checker-imaging', '--disable-lcd-text', '--force-color-profile=srgb',
      '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--disable-sync', '--no-pings', '--no-first-run', '--disable-default-apps', '--safebrowsing-disable-auto-update',
      '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
    ] });
  } catch (e) {
    const err = new Error(`nunchi could not start Chromium (${String(e.message).split('\n')[0]}). ` +
      'Install it once with `nunchi setup`, or pass --browser-path <chrome executable> (or set NUNCHI_BROWSER).');
    err.code = 'NO_BROWSER';
    throw err;
  }
}

async function captureOne(browser, base, scene, opts) {
  const vp = VIEWPORTS[scene.vp];
  const ctx = await browser.newContext({
    viewport: vp, deviceScaleFactor: 1, locale: opts.locale, timezoneId: opts.timezone,
    reducedMotion: 'reduce', serviceWorkers: 'block', colorScheme: 'light',
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
  });
  await ctx.addInitScript(initScript, { frozen: opts.clock, seed: 42 });
  const origin = new URL(base).origin;
  const blocked = new Set();
  const requests = [];
  const scripts = [];
  // Data requests (fetch/XHR to the app or its backend) are recorded, replayed or rewritten for
  // the forced state; everything else from the app passes through; third parties are blocked.
  let release; const held = new Promise(r => { release = r; });
  const data = []; const drift = []; const streams = [];
  const replay = opts.mode === 'replay';
  await ctx.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    const own = u.origin === origin;
    if (!own && !isBackendHost(u.hostname, opts.allowHosts)) {
      if (FONT_HOSTS.includes(u.hostname)) return route.continue();
      blocked.add(u.hostname);
      return route.abort('blockedbyclient');
    }
    if (replay && req.resourceType() === 'eventsource') { streams.push(requestKey('SSE', req.url(), null, origin)); return route.abort('failed').catch(() => {}); }
    if (!isDataRequest({ resourceType: req.resourceType(), headers: req.headers() })) {
      if (replay && !READS.has(req.method())) { drift.push(requestKey(req.method(), req.url(), req.postData(), origin)); return route.abort('failed').catch(() => {}); }
      return route.continue();
    }
    const key = requestKey(req.method(), req.url(), req.postData(), origin);
    data.push(key);
    if (scene.state === 'error') {
      const f = forceResponse('error');
      return route.fulfill({ status: f.status, contentType: f.contentType, body: f.body }).catch(() => {});
    }
    // a miss, read or write, is counted when it is asked for (capture drift; `recording-stale` when most miss)
    // and fails in the page; it never goes live
    let res = replay ? opts.loader.take(key) : null;
    if (!res && replay) drift.push(key);
    if (scene.state === 'slow') await held;
    if (!res && replay) return route.abort('failed').catch(() => {});
    if (!res) {
      // live or recording: a response that outlives the page (a held slow request) is dropped, not a crash
      try {
        const fetched = await route.fetch();
        const contentType = fetched.headers()['content-type'] || '';
        if (!TEXTUAL.test(contentType)) return route.fulfill({ response: fetched }).catch(() => {});
        res = { status: fetched.status(), contentType, body: (await fetched.body()).toString('utf8') };
      } catch { return route.abort('failed').catch(() => {}); }
      if (opts.mode === 'record') opts.loader.add(key, res);
    }
    const out = (scene.state === 'empty' && forceResponse('empty', res)) || res;
    return route.fulfill({ status: out.status, contentType: out.contentType, body: out.body }).catch(() => {});
  });
  // WebSockets bypass request routing: in replay each one is closed before it reaches a server.
  if (replay) await ctx.routeWebSocket(/.*/, ws => { streams.push(requestKey('WS', ws.url().replace(/^ws/, 'http'), null, origin)); ws.close().catch(() => {}); });
  const page = await ctx.newPage();
  // Leaving the page: in replay the browser goes offline and the page unloads while routing still holds, so a
  // write sent on the way out (a keepalive fetch on pagehide, a beacon) cannot reach a server.
  const leave = async () => {
    if (replay) { await ctx.setOffline(true).catch(() => {}); await page.goto('about:blank', { timeout: 5000 }).catch(() => {}); }
    await ctx.close();
  };
  const pageErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', e => pageErrors.push(scrubSecrets(redactText(String(e.message || e).split('\n')[0].slice(0, 200)))));
  page.on('dialog', d => { nativeDialogs.push({ type: d.type(), message: scrubSecrets(redactText(d.message().slice(0, 200))) }); d.dismiss().catch(() => {}); });
  page.on('response', async res => {
    const u = new URL(res.url());
    if (u.origin !== origin) return;
    const req = res.request();
    // Router prefetches (Next.js RSC, <link rel=prefetch>) depend on scrolling and idle time,
    // not on the screen: kept out of the evidence so it stays comparable.
    const h = req.headers();
    if (u.searchParams.has('_rsc') || h.rsc === '1' || h['next-router-prefetch'] || /prefetch/i.test(h['sec-purpose'] || h.purpose || '')) return;
    requests.push({ path: redactUrl(u.pathname + u.search), method: req.method(), status: res.status(), sameOrigin: true, type: req.resourceType(), document: req.resourceType() === 'document', write: !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) });
    if (req.resourceType() === 'script') { try { scripts.push({ path: u.pathname, body: await res.text() }); } catch {} }
  });

  let status = null; const errors = [];
  const slow = scene.state === 'slow';
  try {
    const res = await page.goto(base.replace(/\/$/, '') + scene.path, { waitUntil: slow ? 'domcontentloaded' : 'load', timeout: opts.timeout });
    status = res ? res.status() : null;
  } catch (e) { errors.push('navigation: ' + redactText(String(e.message).split('\n')[0])); }
  if (slow) await page.waitForTimeout(1500);                    // data held: what does the user see?
  else await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // Layout shift is read before nunchi scrolls or injects styles, so only the app's own shifts count.
  const cls = await page.evaluate(() => Math.round((globalThis.__nunchiCls?.value || 0) * 1000) / 1000).catch(() => 0);
  if (scene.state === 'offline') { await ctx.setOffline(true); await page.waitForTimeout(800); }
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  if (!slow) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      const h = document.documentElement.scrollHeight;
      for (let y = 0; y < h; y += innerHeight) { scrollTo(0, y); await new Promise(r => requestAnimationFrame(() => r())); }
      scrollTo(0, 0);
      // Inner scroll areas (app shells) get the same pass, so their lazy content loads too.
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1 || el.clientHeight < innerHeight * 0.3) continue;
        for (let y = 0; y < el.scrollHeight; y += el.clientHeight) { el.scrollTop = y; await new Promise(r => requestAnimationFrame(() => r())); }
        el.scrollTop = 0;
      }
      await document.fonts.ready;
    }).catch(() => {});
    if (scene.state !== 'offline') await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  }

  // ── canary hook (spec §4 H2) ── only for canary scenes: plant a known defect after load and before
  // anything is measured, so every evidence file shows it. No suitable element → the copy is dropped.
  // A redirect that left the base origin (redirect hops are not routed, so the base-URL guard cannot stop them)
  // shows another server's page: nothing of it is collected, the scene is capture-failed and says where it went.
  let offOrigin = null;
  try { const u = new URL(page.url()); if (/^https?:$/.test(u.protocol) && u.origin !== origin) offOrigin = u; } catch {}
  const canary = opts.canaryKinds && !offOrigin ? await page.evaluate(canaryMutate, { kinds: opts.canaryKinds }).catch(() => null) : undefined;
  if (opts.canaryKinds && !canary) { release(); await leave(); return { canary: null }; }
  // ── end canary hook ──
  let measure = offOrigin ? null : await page.evaluate(collect).catch(e => { errors.push('collect: ' + e.message); return null; });
  // Chromium's own error page (connection refused, empty error response) is not the app's screen.
  const browserErrorPage = !!measure?.browserErrorPage;
  if (browserErrorPage) measure = null;
  if (measure) delete measure.browserErrorPage;
  const editorLines = measure ? measure.editorLines : [];
  if (measure) { delete measure.editorLines; measure = scrubDeep(measure); }
  // URLs read from the page can carry credentials (magic links, signed image URLs): redacted before use.
  if (measure) {
    measure.url = redactUrl(measure.url);
    for (const c of measure.controls) c.href = redactUrl(c.href);
    for (const i of measure.images) i.src = redactUrl(i.src);
  }
  // CLS depends on timing; the evidence keeps the web.dev band, the raw value goes to volatile.json.
  if (measure) { measure.cls = cls; measure.clsBand = cls <= 0.1 ? 'good' : cls <= 0.25 ? 'needs-improvement' : 'poor'; }
  if (!offOrigin) await page.addScriptTag({ content: AXE_SOURCE }).catch(() => {});
  const axe = offOrigin ? [] : scrubDeep(await page.evaluate(async rules => {
    try {
      const r = await globalThis.axe.run(document, { runOnly: rules, resultTypes: ['violations'] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 20).map(n => ({ selector: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 2).join(' ').trim().slice(0, 200) })) }));
    } catch (e) { return [{ id: 'axe-error', impact: null, nodes: [{ selector: 'html', summary: String(e).slice(0, 120) }] }]; }
  }, AXE_RULES).catch(() => []));
  let aria = '';
  if (!offOrigin) try { aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }); } catch (e) { errors.push('aria: ' + String(e.message).split('\n')[0]); }

  const dir = join(opts.out, scene.id);
  const shot = o => (offOrigin ? null : page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled', caret: 'hide', ...o }).catch(e => { errors.push(`${o.fullPage ? 'full' : 'top'}: ${e.message}`); return null; }));
  const top = await shot({});
  const full = await shot({ fullPage: true });
  // Freeze what was seen at capture time; held (slow) requests released afterwards, and anything the page
  // sends as it closes, are not evidence.
  const seen = scrubDeep(requests.slice());
  const seenErrors = pageErrors.slice(); const seenDialogs = nativeDialogs.slice();
  const seenData = [...new Set(data)].sort(), seenDrift = [...new Set(drift)].sort(), seenStreams = [...new Set(streams)].sort().map(scrubSecrets);
  release();
  await leave();

  const finalPath = measure ? measure.url : offOrigin ? scrubSecrets(redactUrl(offOrigin.pathname + offOrigin.search)) : null;
  const ev = {
    scene: scene.id, route: scene.route, path: redactUrl(scene.path), viewport: scene.vp, person: scene.person, state: scene.state,
    status, finalPath, redirected: finalPath !== null && finalPath.split(/[?#]/)[0] !== scene.path.split(/[?#]/)[0],
    errors, pageErrors: seenErrors, nativeDialogs: seenDialogs,
    requests: seen.sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1)),
    blocked: [...blocked].sort(), axe: axe.sort((a, b) => (a.id < b.id ? -1 : 1)),
    measure,
  };
  if (top) writeStable(join(dir, 'top.jpg'), top);
  if (full) writeStable(join(dir, 'full.jpg'), full);
  writeStable(join(dir, 'aria.yml'), scrubSecrets(redactText(ariaWithoutValues(aria, editorLines))) + '\n');
  if (measure) {
    writeStable(join(dir, 'text.txt'), redactText(measure.text) + '\n');
    writeStable(join(dir, 'styles.json'), measure.styles);
    writeStable(join(dir, 'controls.json'), measure.controls);
    writeStable(join(dir, 'links.json'), measure.links);
  }
  const dataKeys = seenData;
  writeStable(join(dir, 'network.json'), scrubDeep({ requests: ev.requests, blocked: ev.blocked, data: dataKeys, replayMisses: seenDrift, ...(seenStreams.length ? { streams: seenStreams } : {}) }));
  writeStable(join(dir, 'console.json'), scrubDeep({ pageErrors: seenErrors, nativeDialogs: seenDialogs, errors }));
  // A redirected scene shows another route's page: that page is judged in its own scene. What a
  // redirect itself says is judged here: a signed-in person bounced to a sign-in page lost the session.
  const bounced = ev.redirected && scene.person === 'signed-in' && /(^|\/)(log-?in|sign-?in|auth)(\/|$)/i.test(finalPath || '');
  const raw = !measure ? [] : ev.redirected
    ? (bounced ? [{ lens: 'L3', rule: 'signed-in-bounced', severity: 'high', scene: scene.id, route: scene.route, viewport: scene.vp, selector: null, box: null, evidence: { finalPath } }] : [])
    : ruleFindings(ev);
  // A finding on an element outside its scroll area's visible part says so; the box is not in the image.
  const insideOf = new Map();
  if (measure) for (const x of [...measure.controls, ...measure.images, ...measure.clipped, ...measure.fields]) if (x.inside) insideOf.set(x.selector, x.inside);
  const findings = raw.map(f => (insideOf.has(f.selector) ? { ...f, inside: insideOf.get(f.selector) } : f));
  // A redirect loop never shows a page, so it is judged from the navigation error itself.
  const loop = errors.some(e => /ERR_TOO_MANY_REDIRECTS/.test(e));
  if (loop) findings.push({ lens: 'L3', rule: 'redirect-loop', severity: 'high', scene: scene.id, route: scene.route, viewport: scene.vp, selector: null, box: null, evidence: { path: redactUrl(scene.path), note: 'the browser gave up after too many redirects' } });
  writeStable(join(dir, 'measure.json'), {
    status, finalPath, redirected: ev.redirected, axe: ev.axe,
    ...(measure ? { scrollWidth: measure.scrollWidth, scrollHeight: measure.scrollHeight, viewport: measure.viewport, clsBand: measure.clsBand, fonts: measure.fonts, clipped: measure.clipped, images: measure.images, h1: measure.h1, title: measure.title, scrollers: measure.scrollers, hiddenControls: measure.hiddenControls } : {}),
  });
  writeStable(join(dir, 'volatile.json'), { cls });
  return {
    entry: {
      id: scene.id, route: scene.route, path: redactUrl(scene.path), person: scene.person, state: scene.state, viewport: scene.vp,
      status: measure ? (ev.redirected && opts.strictPath ? 'capture-failed' : 'captured') : 'capture-failed',
      reason: !measure ? (offOrigin ? 'redirected-off-origin' : loop ? 'redirect-loop' : browserErrorPage ? 'browser-error-page' : 'no-dom') : ev.redirected ? `redirected to ${finalPath}` : null,
      finalPath, ...(offOrigin ? { finalOrigin: offOrigin.origin } : {}), httpStatus: status,
      top: top ? sha(top) : null, full: full ? sha(full) : null,
      findings: findings.length, dataRequests: dataKeys.length, replayMisses: seenDrift.length,
      textHash: measure ? sha(measure.mainText) : null,
    },
    findings, scripts, links: measure ? measure.links : [], ...(canary ? { canary } : {}),
    styles: measure ? measure.styles : [], controls: measure ? { visible: measure.controls, hidden: measure.hiddenControls } : null,
  };
}

// Compare a route's forced states with each other (same person, same viewport).
export function stateFindings(entries) {
  const out = [];
  const groups = new Map();
  for (const e of entries) {
    const k = `${e.route}|${e.person}|${e.viewport}`;
    if (!groups.has(k)) groups.set(k, {});
    groups.get(k)[e.state] = e;
  }
  for (const g of groups.values()) {
    const { normal, empty, error, offline } = g;
    const f = (lens, rule, severity, e, evidence) => out.push({ lens, rule, severity, scene: e.id, route: e.route, viewport: e.viewport, selector: 'main', box: null, evidence });
    if (empty && error && empty.textHash && empty.textHash === error.textHash && (!normal || normal.textHash !== error.textHash)) {
      f('L2', 'error-looks-empty', 'medium', error, { comparedWith: empty.id, note: 'the error state shows exactly the same text as the empty state' });
    }
    if (normal && offline && offline.textHash && offline.textHash === normal.textHash) {
      f('L2', 'no-offline-notice', 'low', offline, { comparedWith: normal.id, note: 'going offline changed nothing on screen' });
    }
  }
  return out;
}

// Whole-run failures look like many identical findings; they are reported once instead (spec §2.4).
// - login-expired: most signed-in screens bounced to a sign-in page. Those scenes become not-seen and
//   their bounce findings are dropped; one bounced screen among working ones is still a finding.
// - app-unreachable: most scenes have no DOM (server down, wrong URL).
// - recording-stale: most replayed screens asked for requests the recording does not have.
// Judged from the evidence only (no clock), so two runs of the same app agree.
export function runHealth(entries, findings) {
  const problems = [];
  const signedIn = entries.filter(e => e.person === 'signed-in' && e.state === 'normal');
  const bouncedIds = new Set(findings.filter(f => f.rule === 'signed-in-bounced').map(f => f.scene));
  const bounced = signedIn.filter(e => bouncedIds.has(e.id));
  if (bounced.length >= 2 && bounced.length * 2 >= signedIn.length) problems.push({ status: 'login-expired', scenes: bounced.length, of: signedIn.length });
  const noDom = entries.filter(e => e.reason === 'no-dom' || e.reason === 'browser-error-page');
  if (noDom.length >= 2 && noDom.length * 2 >= entries.length) problems.push({ status: 'app-unreachable', scenes: noDom.length, of: entries.length });
  const data = entries.filter(e => e.dataRequests > 0);
  const missed = data.filter(e => e.replayMisses > 0);
  if (missed.length >= 2 && missed.length * 2 >= data.length) problems.push({ status: 'recording-stale', scenes: missed.length, of: data.length });
  return { status: problems.length ? problems[0].status : 'ok', problems };
}

// scenes: [{ route, path, person }] → expanded per viewport and per forced state here.
// network: 'auto' (replay if a recording exists, else record) | 'record' | 'replay' | 'live'.
// canaries: how many canary scenes to plant (spec §4 H2); 0 = none (the default for the API; the CLI plants 3).
// lenses: the loaded lens packs, so a canary is planted only where its lens hunts (default: the built-in packs).
// allowBaseHosts: hosts the user listed in .nunchi/config.json; any other base URL must be local or private (D10).
export async function capture({ baseUrl, scenes, out, viewports = ['m', 'd'], states = ['normal'], network = 'live', recordingDir, allowHosts = [], allowBaseHosts = [], browserPath, clock = DEFAULT_CLOCK, locale = 'en-US', timezone = 'UTC', timeout = 30000, storageState, strictPath = false, runMeta = {}, flow: flowOpts = {}, canaries = 0, lenses = null }) {
  const refusal = baseUrlRefusal(baseUrl, allowBaseHosts);
  if (refusal) throw Object.assign(new Error(refusal), { code: 'URL_NOT_ALLOWED' });
  if (scenes.some(s => s.person === 'signed-in') && !(storageState && existsSync(storageState))) {
    throw Object.assign(new Error(`signed-in scenes need a saved login state, but ${storageState || '(none)'} does not exist`), { code: 'NO_AUTH' });
  }
  const unknown = states.filter(s => !STATES.includes(s));
  if (unknown.length) throw Object.assign(new Error(`unknown state(s): ${unknown.join(', ')} (known: ${STATES.join(', ')})`), { code: 'BAD_ARGS' });
  const persons = [...new Set(scenes.map(s => s.person || 'guest'))].sort();
  const recordings = {}; const modes = {};
  for (const person of persons) {
    const path = recordingDir ? join(recordingDir, `${person}.json`) : null;
    const existing = path ? Recording.load(path) : null;
    modes[person] = network === 'auto' ? (existing ? 'replay' : path ? 'record' : 'live') : network;
    if (modes[person] === 'replay' && !existing) throw Object.assign(new Error(`no recording for "${person}" at ${path}; run once with --network record`), { code: 'NO_RECORDING' });
    if (modes[person] !== 'live' && !path) throw Object.assign(new Error('record/replay needs a recording folder'), { code: 'BAD_ARGS' });
    recordings[person] = existing || new Recording();
  }
  const ids = new Map();
  for (const s of scenes) {
    const id = sceneId(s.route || s.path, s.person || 'guest', 'normal', 'm');
    if (ids.has(id)) throw Object.assign(new Error(`two scenes map to the same name: ${ids.get(id)} and ${s.path} (one sample per route and person)`), { code: 'BAD_ARGS' });
    ids.set(id, s.path);
  }
  const browser = await launch({ browserPath, baseUrl, allowHosts });
  const t0 = Date.now();
  const entries = []; const findings = []; const scriptMap = new Map(); const timing = []; const sceneLinks = new Map(); const rowsByScene = new Map(); const controlsByScene = new Map();
  const run = async (s, vp, state) => {
    const person = s.person || 'guest';
    const scene = { ...s, vp, person, state, id: sceneId(s.route || s.path, person, state, vp) };
    // forced states replay the recording (they rewrite the same data) unless the person is captured live
    const mode = state === 'normal' ? modes[person] : derivedMode(modes[person]);
    const t = Date.now();
    const r = await captureOne(browser, baseUrl, scene, { out, clock, locale, timezone, timeout, storageState: person === 'signed-in' ? storageState : undefined, strictPath, allowHosts, mode, loader: recordings[person].loader() });
    timing.push({ scene: scene.id, ms: Date.now() - t });
    entries.push(r.entry); findings.push(...r.findings); sceneLinks.set(r.entry.id, r.links); rowsByScene.set(r.entry.id, r.styles); if (r.controls) controlsByScene.set(r.entry.id, r.controls);
    for (const sc of r.scripts) if (!scriptMap.has(sc.path)) scriptMap.set(sc.path, sc.body);
    return r.entry;
  };
  try {
    for (const s of scenes) for (const vp of viewports) {
      const normal = await run(s, vp, 'normal');
      // Forced states only where the page actually reads data; otherwise they would be copies of normal.
      if (normal.dataRequests > 0) for (const state of states.filter(x => x !== 'normal')) await run(s, vp, state);
    }
  } finally { await browser.close(); }
  for (const person of persons) if (modes[person] === 'record') recordings[person].save(join(recordingDir, `${person}.json`));
  findings.push(...stateFindings(entries));
  const health = runHealth(entries, findings);
  if (health.status === 'login-expired' || health.problems.some(p => p.status === 'login-expired')) {
    // Every signed-in scene of an expired login is unseen, bounced or not: what it showed is a sign-in page.
    const lost = new Set(entries.filter(e => e.person === 'signed-in').map(e => e.id));
    for (const e of entries) if (lost.has(e.id)) { e.status = 'not-seen'; e.reason = 'login-expired'; e.findings = 0; }
    for (let i = findings.length - 1; i >= 0; i--) if (lost.has(findings[i].scene)) findings.splice(i, 1);
  }
  // L3: the link graph. Routes come from discover when the CLI has them (complete); otherwise only the
  // captured routes are known and links elsewhere are not judged.
  const flowRoutes = flowOpts.routes || [...new Set(scenes.map(s => s.route || s.path))].sort();
  const { flow, findings: flowFindings } = buildFlow({ entries, sceneLinks, routes: flowRoutes, complete: !!flowOpts.routes, wholeApp: flowOpts.wholeApp ?? !!flowOpts.routes, code: flowOpts.code || [] });
  // an app that did not load shows no links: the flow cannot be judged, nothing is "unreachable"
  if (!health.problems.some(p => p.status === 'app-unreachable')) findings.push(...flowFindings);
  // L4 and L10: the app's measured design system and phone/desktop parity.
  const { system, findings: systemFindings } = buildSystem({ entries, rowsByScene });
  findings.push(...systemFindings, ...parityFindings({ entries, controlsByScene }));
  const scripts = [...scriptMap].sort().map(([path, body]) => ({ path, body }));
  findings.push(...secretFindings(scripts));
  const order = { blocker: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.scene).localeCompare(String(b.scene)) || a.rule.localeCompare(b.rule) || String(a.selector).localeCompare(String(b.selector)));
  // ── canaries (spec §4 H2) ── copies of a few captured scenes with a planted defect, captured after every
  // finding above is computed: they appear in the manifest (tagged `canary`, `of`) and in canaries.json,
  // never in findings.json, flow, the design system or run health.
  let canaryEntries = []; let canaryFile = null;
  if (canaries > 0) {
    const seed = canarySeed({ routes: [...new Set(scenes.map(s => s.route || s.path))], persons, viewports, states });
    const cb = await launch({ browserPath, baseUrl, allowHosts });
    try {
      const r = await plantCanaries({ entries, count: canaries, seed, lenses: lenses || loadLenses({ root: BUILTIN_DIR }).lenses, tryScene: async (base, kinds, id) => {
        const s = scenes.find(x => (x.route || x.path) === base.route && (x.person || 'guest') === base.person);
        const scene = { ...s, vp: base.viewport, person: base.person, state: base.state, id };
        const mode = derivedMode(modes[base.person]);
        const c = await captureOne(cb, baseUrl, scene, { out, clock, locale, timezone, timeout, storageState: base.person === 'signed-in' ? storageState : undefined, strictPath, allowHosts, mode, loader: recordings[base.person].loader(), canaryKinds: kinds });
        if (!c.canary) { rmSync(join(out, id), { recursive: true, force: true }); return null; }
        c.canary.before = scrubSecrets(redactText(c.canary.before)); c.canary.after = scrubSecrets(redactText(c.canary.after));
        return c;
      } });
      canaryEntries = r.entries;
      canaryFile = { schema: 1, note: 'answer key for the AI hunt: never give this file to a hunter', seed, requested: canaries, planted: r.canaries };
    } finally { await cb.close(); }
  }
  // ── end canaries ──
  const manifest = { schema: 1, health, baseUrl, viewports: viewports.map(v => ({ id: v, ...VIEWPORTS[v] })), clock: new Date(clock).toISOString(), states, scenes: canaryEntries.length ? [...entries, ...canaryEntries] : entries };
  // How this run got its data (record vs replay) is run metadata, not evidence: kept beside timing.
  const runInfo = { ...runMeta, network: modes, health };
  writeStable(join(out, 'manifest.json'), manifest);
  // fingerprint (one defect wherever it shows) and group (the same defect across routes): spec §5
  const ledgerFindings = annotate(findings);
  findings.splice(0, findings.length, ...ledgerFindings);
  writeStable(join(out, 'findings.json'), { schema: 1, findings });
  writeStable(join(out, 'flow.json'), flow);
  writeStable(join(out, 'design-system.json'), system);
  writeStable(join(out, 'timing.json'), { totalMs: Date.now() - t0, scenes: timing });
  writeStable(join(out, 'run.json'), runInfo);
  if (canaryFile) writeStable(join(out, 'canaries.json'), canaryFile);
  return { manifest, findings, flow, system, run: runInfo, totalMs: Date.now() - t0, ...(canaryFile ? { canaries: canaryFile } : {}) };
}
