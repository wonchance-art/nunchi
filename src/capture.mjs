// Deterministic capture: one browser, one fresh context per scene × viewport.
// Writes the evidence pack (spec §2.4) and returns rule findings. Wall-clock timings go to
// timing.json only, so every other file is byte-identical across runs of the same build.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { initScript, collect, FREEZE_CSS } from './collect.mjs';
import { ruleFindings, secretFindings } from './rules.mjs';
import { writeStable, sha } from './stable.mjs';
import { FONT_HOSTS, BACKEND_SUFFIXES, isBackendHost, isDataRequest, requestKey, forceResponse, Recording } from './network.mjs';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const AXE_RULES = ['color-contrast', 'button-name', 'link-name', 'image-alt', 'label', 'duplicate-id-aria', 'select-name', 'input-button-name'];

export const VIEWPORTS = { m: { width: 390, height: 844 }, d: { width: 1280, height: 800 } };
const DEFAULT_CLOCK = Date.UTC(2026, 0, 15, 9, 0, 0);
export const STATES = ['normal', 'empty', 'error', 'slow', 'offline'];
const TEXTUAL = /json|text|javascript|xml|x-www-form-urlencoded|graphql/i;

export function sceneId(route, person, state, vp) {
  const slug = route === '/' ? 'root' : route.replace(/^\//, '').replace(/[^\w\-[\]$.]+/g, '_');
  return `${slug}.${person}.${state}.${vp}`;
}

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
      '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability',
      '--disable-sync', '--no-pings', '--no-first-run', '--disable-default-apps', '--safebrowsing-disable-auto-update',
      '--disable-features=OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
    ] });
  } catch (e) {
    const err = new Error(`nunchi could not start Chromium (${String(e.message).split('\n')[0]}). ` +
      'Install it once with `npx playwright@1.63.0 install chromium`, or pass --browser-path <chrome executable>.');
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
  const data = []; const drift = [];
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
    if (!isDataRequest({ resourceType: req.resourceType(), headers: req.headers() })) return route.continue();
    const key = requestKey(req.method(), req.url(), req.postData(), origin);
    data.push(key);
    if (scene.state === 'slow') await held;
    if (scene.state === 'error') {
      const f = forceResponse('error');
      return route.fulfill({ status: f.status, contentType: f.contentType, body: f.body }).catch(() => {});
    }
    let res = opts.mode === 'replay' ? opts.loader.take(key) : null;
    if (!res) {
      if (opts.mode === 'replay') drift.push(key);
      let fetched;
      try { fetched = await route.fetch(); } catch { return route.abort('failed').catch(() => {}); }
      const contentType = fetched.headers()['content-type'] || '';
      if (!TEXTUAL.test(contentType)) return route.fulfill({ response: fetched }).catch(() => {});
      res = { status: fetched.status(), contentType, body: (await fetched.body()).toString('utf8') };
      if (opts.mode === 'record') opts.loader.add(key, res);
    }
    const out = (scene.state === 'empty' && forceResponse('empty', res)) || res;
    return route.fulfill({ status: out.status, contentType: out.contentType, body: out.body }).catch(() => {});
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', e => pageErrors.push(String(e.message || e).split('\n')[0].slice(0, 200)));
  page.on('dialog', d => { nativeDialogs.push({ type: d.type(), message: d.message().slice(0, 200) }); d.dismiss().catch(() => {}); });
  page.on('response', async res => {
    const u = new URL(res.url());
    if (u.origin !== origin) return;
    const req = res.request();
    requests.push({ path: u.pathname + u.search, method: req.method(), status: res.status(), sameOrigin: true, document: req.resourceType() === 'document', write: !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) });
    if (req.resourceType() === 'script') { try { scripts.push({ path: u.pathname, body: await res.text() }); } catch {} }
  });

  let status = null; const errors = [];
  const slow = scene.state === 'slow';
  try {
    const res = await page.goto(base.replace(/\/$/, '') + scene.path, { waitUntil: slow ? 'domcontentloaded' : 'load', timeout: opts.timeout });
    status = res ? res.status() : null;
  } catch (e) { errors.push('navigation: ' + String(e.message).split('\n')[0]); }
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
      await document.fonts.ready;
    }).catch(() => {});
    if (scene.state !== 'offline') await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  }

  const measure = await page.evaluate(collect).catch(e => { errors.push('collect: ' + e.message); return null; });
  // CLS depends on timing; the evidence keeps the web.dev band, the raw value goes to volatile.json.
  if (measure) { measure.cls = cls; measure.clsBand = cls <= 0.1 ? 'good' : cls <= 0.25 ? 'needs-improvement' : 'poor'; }
  await page.addScriptTag({ content: AXE_SOURCE }).catch(() => {});
  const axe = await page.evaluate(async rules => {
    try {
      const r = await globalThis.axe.run(document, { runOnly: rules, resultTypes: ['violations'] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 20).map(n => ({ selector: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 2).join(' ').trim().slice(0, 200) })) }));
    } catch (e) { return [{ id: 'axe-error', impact: null, nodes: [{ selector: 'html', summary: String(e).slice(0, 120) }] }]; }
  }, AXE_RULES).catch(() => []);
  let aria = '';
  try { aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }); } catch (e) { errors.push('aria: ' + String(e.message).split('\n')[0]); }

  const dir = join(opts.out, scene.id);
  const top = await page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled', caret: 'hide' }).catch(e => { errors.push('top: ' + e.message); return null; });
  const full = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true, animations: 'disabled', caret: 'hide' }).catch(e => { errors.push('full: ' + e.message); return null; });
  release();
  await ctx.close();

  const finalPath = measure ? measure.url : null;
  const ev = {
    scene: scene.id, route: scene.route, path: scene.path, viewport: scene.vp, person: scene.person, state: scene.state,
    status, finalPath, redirected: finalPath !== null && finalPath.split('?')[0] !== scene.path.split('?')[0],
    errors, pageErrors, nativeDialogs,
    requests: requests.sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1)),
    blocked: [...blocked].sort(), axe: axe.sort((a, b) => (a.id < b.id ? -1 : 1)),
    measure,
  };
  if (top) writeStable(join(dir, 'top.jpg'), top);
  if (full) writeStable(join(dir, 'full.jpg'), full);
  writeStable(join(dir, 'aria.yml'), aria + '\n');
  if (measure) {
    writeStable(join(dir, 'text.txt'), measure.text + '\n');
    writeStable(join(dir, 'styles.json'), measure.styles);
    writeStable(join(dir, 'controls.json'), measure.controls);
    writeStable(join(dir, 'links.json'), measure.links);
  }
  const dataKeys = [...new Set(data)].sort();
  writeStable(join(dir, 'network.json'), { requests: ev.requests, blocked: ev.blocked, data: dataKeys, replayMisses: [...new Set(drift)].sort() });
  writeStable(join(dir, 'console.json'), { pageErrors, nativeDialogs, errors });
  const findings = measure ? ruleFindings(ev) : [];
  writeStable(join(dir, 'measure.json'), {
    status, finalPath, redirected: ev.redirected, axe: ev.axe,
    ...(measure ? { scrollWidth: measure.scrollWidth, scrollHeight: measure.scrollHeight, viewport: measure.viewport, clsBand: measure.clsBand, fonts: measure.fonts, clipped: measure.clipped, images: measure.images, h1: measure.h1, title: measure.title } : {}),
  });
  writeStable(join(dir, 'volatile.json'), { cls });
  return {
    entry: {
      id: scene.id, route: scene.route, path: scene.path, person: scene.person, state: scene.state, viewport: scene.vp,
      status: measure ? (ev.redirected && opts.strictPath ? 'capture-failed' : 'captured') : 'capture-failed',
      reason: !measure ? 'no-dom' : ev.redirected ? `redirected to ${finalPath}` : null,
      finalPath, httpStatus: status,
      top: top ? sha(top) : null, full: full ? sha(full) : null,
      findings: findings.length, dataRequests: dataKeys.length, replayMisses: new Set(drift).size,
      textHash: measure ? sha(measure.mainText) : null,
    },
    findings, scripts,
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

// scenes: [{ route, path, person }] → expanded per viewport and per forced state here.
// network: 'auto' (replay if a recording exists, else record) | 'record' | 'replay' | 'live'.
export async function capture({ baseUrl, scenes, out, viewports = ['m', 'd'], states = ['normal'], network = 'live', recordingDir, allowHosts = [], browserPath, clock = DEFAULT_CLOCK, locale = 'en-US', timezone = 'UTC', timeout = 30000, storageState, strictPath = false }) {
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
  const browser = await launch({ browserPath, baseUrl, allowHosts });
  const t0 = Date.now();
  const entries = []; const findings = []; const scriptMap = new Map(); const timing = [];
  const run = async (s, vp, state) => {
    const person = s.person || 'guest';
    const scene = { ...s, vp, person, state, id: sceneId(s.path, person, state, vp) };
    // forced states read the recording when there is one, so they rewrite the same data
    const mode = state === 'normal' ? modes[person] : (Object.keys(recordings[person].entries).length ? 'replay' : 'live');
    const t = Date.now();
    const r = await captureOne(browser, baseUrl, scene, { out, clock, locale, timezone, timeout, storageState: person === 'signed-in' ? storageState : undefined, strictPath, allowHosts, mode, loader: recordings[person].loader() });
    timing.push({ scene: scene.id, ms: Date.now() - t });
    entries.push(r.entry); findings.push(...r.findings);
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
  const scripts = [...scriptMap].sort().map(([path, body]) => ({ path, body }));
  findings.push(...secretFindings(scripts));
  const order = { blocker: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.scene).localeCompare(String(b.scene)) || a.rule.localeCompare(b.rule) || String(a.selector).localeCompare(String(b.selector)));
  const manifest = { schema: 1, baseUrl, viewports: viewports.map(v => ({ id: v, ...VIEWPORTS[v] })), clock: new Date(clock).toISOString(), network: modes, states, scenes: entries };
  writeStable(join(out, 'manifest.json'), manifest);
  writeStable(join(out, 'findings.json'), { schema: 1, findings });
  writeStable(join(out, 'timing.json'), { totalMs: Date.now() - t0, scenes: timing });
  return { manifest, findings, totalMs: Date.now() - t0 };
}
