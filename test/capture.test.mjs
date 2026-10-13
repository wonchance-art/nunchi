// End-to-end capture against a tiny synthetic site with seeded defects.
// Needs a Chromium: set NUNCHI_BROWSER to its executable, or install one with
// `npx playwright@1.63.0 install chromium`. Skipped (not failed) when none is found.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname } from 'node:path';
import { capture, launch } from '../src/capture.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
let server, base, site, browserOk = true;

before(async () => {
  site = mkdtempSync(join(tmpdir(), 'nunchi-site-'));
  cpSync(new URL('./fixtures/site', import.meta.url).pathname, site, { recursive: true });
  // Built at test time so no secret-shaped string is ever committed.
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const serviceRole = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase' })}.${'x'.repeat(24)}`;
  writeFileSync(join(site, 'app.js'), `window.__cfg = { stripe: "${'sk_' + 'live_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'}", db: "${serviceRole}" };\n`);
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(site, path === '/' ? 'index.html' : path);
    if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { const b = await launch(); await b.close(); } catch { browserOk = false; }
});
after(() => server && server.close());

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();

test('captures seeded defects, keeps the clean page clean, writes the evidence pack', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = mkdtempSync(join(tmpdir(), 'nunchi-out-'));
  const r = await capture({ baseUrl: base, scenes: [{ route: '/', path: '/' }, { route: '/broken.html', path: '/broken.html' }], out });
  const at = (scene, rule) => r.findings.filter(f => f.scene === scene && f.rule === rule);

  assert.equal(r.findings.filter(f => f.scene?.startsWith('~.')).length, 0, JSON.stringify(r.findings.filter(f => f.scene?.startsWith('~.')), null, 1));

  const m = 'broken.html.guest.normal.m', d = 'broken.html.guest.normal.d';
  assert.equal(at(m, 'horizontal-overflow').length, 1, 'overflow on phone');
  assert.equal(at(d, 'horizontal-overflow').length, 0, 'no overflow on desktop');
  for (const rule of ['raw-error-text', 'broken-image', 'page-error', 'failed-request', 'native-dialog', 'dead-href', 'clipped-text', 'target-size-min', 'target-size-recommended', 'axe-color-contrast', 'axe-button-name']) {
    assert.ok(at(m, rule).length >= 1, `expected ${rule} on ${m}`);
  }
  assert.deepEqual(at(m, 'missing-value').map(f => f.evidence.kind), ['NaN']);
  assert.deepEqual(at(m, 'placeholder-text').map(f => f.evidence.kind), ['Lorem ipsum']);
  const secrets = r.findings.filter(f => f.rule === 'secret-in-client-bundle').map(f => f.evidence.kind);
  assert.deepEqual(secrets, ['stripe-live-secret-key', 'supabase-service-role-jwt']);
  assert.ok(!readFileSync(join(out, 'findings.json'), 'utf8').includes('Zz9Yy8'), 'secret value must not be written');

  const scene = files(join(out, m));
  assert.deepEqual(scene, ['aria.yml', 'console.json', 'controls.json', 'full.jpg', 'links.json', 'measure.json', 'network.json', 'styles.json', 'text.txt', 'top.jpg', 'volatile.json']);
  assert.equal(r.manifest.scenes.length, 4);
  for (const img of ['top.jpg', 'full.jpg']) {
    const bytes = readFileSync(join(out, m, img));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], `${img} must be a JPEG`);
    assert.ok(bytes.length > 2000, `${img} too small to be a real capture`);
  }
  assert.deepEqual(at(m, 'failed-request').map(f => f.evidence.url).sort(), ['/api/session?token=REDACTED&page=2', '/api/tasks-missing'], 'a broken image is reported once, as broken-image');
  const leaked = files(out).filter(f => !f.endsWith('.jpg') && readFileSync(join(out, f), 'utf8').includes('tok-SEKRIT'));
  assert.deepEqual(leaked, [], 'credential values in query strings never reach the evidence');
});

test('deterministic: two runs of the same site give byte-identical evidence', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const scenes = [{ route: '/', path: '/' }, { route: '/broken.html', path: '/broken.html' }];
  const a = mkdtempSync(join(tmpdir(), 'nunchi-a-')), b = mkdtempSync(join(tmpdir(), 'nunchi-b-'));
  await capture({ baseUrl: base, scenes, out: a });
  await capture({ baseUrl: base, scenes, out: b });
  const stable = f => f !== 'timing.json' && f !== 'run.json' && !f.endsWith('volatile.json');
  const fa = files(a).filter(stable);
  assert.deepEqual(fa, files(b).filter(stable));
  const diff = fa.filter(f => !readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
  const detail = diff.filter(f => f.endsWith('.json')).map(f => {
    const x = readFileSync(join(a, f), 'utf8').split('\n'), y = readFileSync(join(b, f), 'utf8').split('\n');
    const i = x.findIndex((l, k) => l !== y[k]);
    return `${f}:${i + 1}\n  run 1: ${x.slice(Math.max(0, i - 3), i + 2).join('\n         ')}\n  run 2: ${y.slice(Math.max(0, i - 3), i + 2).join('\n         ')}`;
  }).join('\n');
  assert.deepEqual(diff, [], `files that differ between runs: ${diff.join(', ')}\n${detail}`);
  assert.ok(fa.length > 20, `expected a full evidence pack, got ${fa.length} files (${relative(a, a)})`);
});

test('signed-in scenes without a saved login fail loudly instead of capturing as guest', async () => {
  await assert.rejects(
    capture({ baseUrl: 'http://127.0.0.1:9', scenes: [{ route: '/', path: '/', person: 'signed-in' }], out: mkdtempSync(join(tmpdir(), 'nunchi-x-')), storageState: '/nope/auth.json' }),
    e => e.code === 'NO_AUTH',
  );
});
