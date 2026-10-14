// Stage 0 (Tidy), end to end: the capture records page and container backgrounds, borders and SVG paint in
// paint.json, and the token proposal merges near-duplicate greys on one page and nothing on a tidy one.
// Needs Chromium (skipped otherwise, failed under NUNCHI_REQUIRE_BROWSER).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, launch } from '../src/capture.mjs';
import { collect } from '../src/collect.mjs';
import { buildTokens, readRunScenes } from '../src/tokens.mjs';
import { stableJson } from '../src/stable.mjs';

const SITE = fileURLToPath(new URL('./fixtures/tokens', import.meta.url));
// Built at test time so no secret-shaped string is ever committed.
const KEY = 'sk_' + 'live_' + 'Kettle0000000000' + 'Zz9';
const DYNAMIC = {
  '/secret.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kettle Notes</title></head><body><main><h1>Kettle Notes</h1><div id="sess_${KEY}" style="width:120px;height:40px;background:rgb(229, 231, 235)"></div></main></body></html>`,
};
let server, base, browserOk = true;
before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (DYNAMIC[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(DYNAMIC[path]); }
    const file = join(SITE, path);
    if (!file.startsWith(SITE) || !existsSync(file) || !file.endsWith('.html')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => server && server.close());

const run = async page => {
  const out = mkdtempSync(join(tmpdir(), 'nunchi-tokens-'));
  await capture({ baseUrl: base, scenes: [{ route: `/${page}`, path: `/${page}` }], viewports: ['m', 'd'], out });
  return out;
};

test('paint.json: container backgrounds, borders and SVG paint, with what each is seen against; hidden, tiny and gradient paint left out', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = await run('greys.html');
  const paint = JSON.parse(readFileSync(join(out, 'greys.html.guest.normal.d', 'paint.json'), 'utf8'));
  assert.equal(paint.schema, 1);
  if (process.platform !== 'win32') assert.equal(statSync(join(out, 'greys.html.guest.normal.d', 'paint.json')).mode & 0o777, 0o600, 'evidence is owner-only (D12)');
  assert.deepEqual(paint.surfaces.map(s => [s.kind, s.background, s.on ?? null, s.radius]), [
    ['page', 'rgb(255, 255, 255)', null, '0px'],
    ['box', 'rgb(249, 250, 251)', 'rgb(255, 255, 255)', '8px'],
    ['box', 'rgb(250, 250, 250)', 'rgb(255, 255, 255)', '7px'],
    ['box', 'rgb(248, 249, 250)', 'rgb(255, 255, 255)', '9px'],
    ['control', 'rgb(37, 99, 235)', 'rgb(255, 255, 255)', '6px'],
    ['control', 'rgb(36, 99, 235)', 'rgb(255, 255, 255)', '6px'],
  ], 'the 8px dot and the display:none block are not surfaces');
  assert.deepEqual(paint.borders.map(b => [b.color, b.sides, b.on]), [
    ['rgb(229, 231, 235)', 'trbl', 'rgb(249, 250, 251)'],
    ['rgb(228, 228, 231)', 'trbl', 'rgb(250, 250, 250)'],
    ['rgb(229, 229, 229)', 'trbl', 'rgb(248, 249, 250)'],
  ], 'a border with style none is not painted');
  assert.deepEqual(paint.svg, [{ fill: 'rgb(107, 114, 128)', selector: 'main > svg > path', stroke: 'rgb(115, 115, 115)' }], 'gradient fills and shapes inside <defs> are left out');
  // styles.json keeps its own rows: none of the containers without their own text joined it
  const styles = JSON.parse(readFileSync(join(out, 'greys.html.guest.normal.d', 'styles.json'), 'utf8'));
  assert.ok(Array.isArray(styles) && !styles.some(r => r.selector === 'main > div:nth-of-type(1)'));
  // two captures of the same page give the same bytes
  const again = await run('greys.html');
  assert.equal(readFileSync(join(again, 'greys.html.guest.normal.d', 'paint.json'), 'utf8'), readFileSync(join(out, 'greys.html.guest.normal.d', 'paint.json'), 'utf8'));
});

test('tokens from a capture: near-duplicate greys cluster; an already tidy page yields no merges', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const greys = buildTokens({ scenes: readRunScenes(await run('greys.html')) });
  const merged = greys.colors.filter(c => c.members.length > 1);
  assert.ok(merged.length >= 4, greys.summary.line);
  const tokenOf = v => greys.colors.find(c => c.members.some(m => m.value === v)).token;
  assert.equal(tokenOf('rgb(249, 250, 251)'), tokenOf('rgb(250, 250, 250)'), 'card fills');
  assert.equal(tokenOf('rgb(229, 231, 235)'), tokenOf('rgb(228, 228, 231)'), 'borders');
  assert.equal(tokenOf('rgb(17, 24, 39)'), tokenOf('rgb(24, 24, 27)'), 'text');
  assert.notEqual(tokenOf('rgb(249, 250, 251)'), tokenOf('rgb(255, 255, 255)'), 'cards stay distinct from the page they sit on');
  assert.ok(greys.summary.colors.after < greys.summary.colors.before);
  assert.deepEqual(greys.roles.map(r => r.role), ['background', 'surface', 'border', 'text', 'text-muted', 'accent', 'accent-foreground']);

  const tidy = buildTokens({ scenes: readRunScenes(await run('tidy.html')) });
  assert.ok(tidy.colors.every(c => c.members.length === 1), tidy.summary.line);
  assert.equal(tidy.summary.colors.before, tidy.summary.colors.after);
  assert.equal(tidy.radii.length, 1);
  assert.deepEqual(tidy.keptApart, []);
  assert.equal(stableJson(tidy), stableJson(buildTokens({ scenes: readRunScenes(await run('tidy.html')) })), 'deterministic end to end');
});

const paintOf = (out, page, vp = 'd') => JSON.parse(readFileSync(join(out, `${page}.guest.normal.${vp}`, 'paint.json'), 'utf8'));

test('paint.json: black, red and yellow are colours, not transparency (a blue channel of 0 is not an alpha of 0)', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = await run('black.html');
  const paint = paintOf(out, 'black.html');
  assert.deepEqual(paint.surfaces.map(s => [s.kind, s.background, s.on ?? null]), [
    ['page', 'rgb(0, 0, 0)', null],
    ['box', 'rgb(255, 0, 0)', 'rgb(0, 0, 0)'],
    ['box', 'rgb(255, 255, 0)', 'rgb(0, 0, 0)'],
    ['field', 'rgb(255, 255, 255)', 'rgb(0, 0, 0)'],
  ], 'a black page is recorded, not a white canvas; the input is a field, not a control');
  assert.deepEqual(paint.borders.map(b => [b.color, b.sides, b.on]), [
    ['rgb(0, 0, 0)', 'trbl', 'rgb(255, 0, 0)'],
    ['rgb(255, 0, 0)', 'outline', 'rgb(0, 0, 0)'],
    ['rgb(255, 0, 0)', 'trbl', 'rgb(255, 255, 255)'],
  ]);
  assert.deepEqual(paint.svg.map(x => [x.fill, x.stroke]), [['rgb(0, 0, 0)', 'rgb(255, 0, 0)']], 'the default black SVG fill');
  const r = buildTokens({ scenes: readRunScenes(out) });
  assert.equal(r.roles.find(x => x.role === 'background').value, 'rgb(0, 0, 0)');
  const c = r.contrast.find(x => x.fg === 'text' && x.bg === 'background');
  assert.ok(c.ratio > 16 && c.aa, JSON.stringify(c));
});

test('paint.json: a dark colour scheme with transparent html and body has no white canvas', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const paint = paintOf(await run('dark.html'), 'dark.html');
  assert.deepEqual(paint.surfaces.map(s => [s.kind, s.background, s.on ?? null]), [['band', 'rgb(40, 44, 52)', null]]);
});

test('paint.json: a secret-shaped id in a container selector is redacted', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = await run('secret.html');
  const text = readFileSync(join(out, 'secret.html.guest.normal.d', 'paint.json'), 'utf8');
  assert.ok(!text.includes(KEY) && !text.includes('Kettle0000'), text);
  assert.ok(JSON.parse(text).surfaces.some(s => s.selector === 'div#sess_[secret-shaped: stripe-live-secret-key]'), text);
});

test('paint walk stays linear: the background behind each element is looked up once per ancestor', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const depth = 150, leaves = 600;
    const html = '<div>'.repeat(depth) + '<p>Kettle</p>' + '<i style="display:block;width:20px;height:20px;background:rgb(229, 231, 235)"></i>'.repeat(leaves) + '</div>'.repeat(depth);
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    await page.evaluate(() => {
      const g = window.getComputedStyle;
      window.__calls = 0;
      window.getComputedStyle = function (...a) { window.__calls++; return g.apply(this, a); };
    });
    const m = await page.evaluate(collect);
    const calls = await page.evaluate(() => window.__calls);
    const elements = depth + leaves + 1;
    assert.equal(m.paint.surfaces.filter(s => s.kind === 'box').length, 1, 'identical leaves are one row');
    assert.ok(calls < 20 * elements, `${calls} getComputedStyle calls for ${elements} elements`);
  } finally { await browser.close(); }
});
