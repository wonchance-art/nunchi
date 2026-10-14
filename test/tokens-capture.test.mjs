// Stage 0 (Tidy), end to end: the capture records page and container backgrounds, borders and SVG paint in
// paint.json, and the token proposal merges near-duplicate greys on one page and nothing on a tidy one.
// Needs Chromium (skipped otherwise, failed under NUNCHI_REQUIRE_BROWSER).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, launch } from '../src/capture.mjs';
import { buildTokens, readRunScenes } from '../src/tokens.mjs';
import { stableJson } from '../src/stable.mjs';

const SITE = fileURLToPath(new URL('./fixtures/tokens', import.meta.url));
let server, base, browserOk = true;
before(async () => {
  server = createServer((req, res) => {
    const file = join(SITE, new URL(req.url, 'http://x').pathname);
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
