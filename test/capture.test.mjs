// End-to-end capture against a tiny synthetic site with seeded defects.
// Needs a Chromium: set NUNCHI_BROWSER to its executable, or install one with
// `node src/cli.mjs setup`. Skipped (not failed) when none is found.
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { capture, launch, isSignInPath } from '../src/capture.mjs';
import { login } from '../src/login.mjs';
import { tmp } from './fixtures/tmp.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
let server, base, site, browserOk = true;

before(async () => {
  site = tmp('nunchi-site-');
  cpSync(fileURLToPath(new URL('./fixtures/site', import.meta.url)), site, { recursive: true });
  // Built at test time so no secret-shaped string is ever committed.
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const serviceRole = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'supabase' })}.${'x'.repeat(24)}`;
  writeFileSync(join(site, 'app.js'), `window.__cfg = { stripe: "${'sk_' + 'live_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2'}", db: "${serviceRole}" };\n`);
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // a moved page: the server sends the visitor on to another route
    if (path === '/moved.html') { res.writeHead(302, { location: '/shell.html' }); return res.end(); }
    const file = join(site, path === '/' ? 'index.html' : path);
    if (!file.startsWith(site) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // CI sets NUNCHI_REQUIRE_BROWSER so a missing browser fails the run instead of skipping the capture tests
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => server && server.close());

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();

test('captures seeded defects, keeps the clean page clean, writes the evidence pack', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('nunchi-out-');
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
  assert.ok(!at(m, 'clipped-text').some(f => f.evidence.text === 'Toggle Sidebar'), 'screen-reader-only text is not clipped text');
  assert.deepEqual(at(m, 'placeholder-text').map(f => f.evidence.kind), ['Lorem ipsum']);
  const secrets = r.findings.filter(f => f.rule === 'secret-in-client-bundle').map(f => f.evidence.kind);
  assert.deepEqual(secrets, ['stripe-live-secret-key', 'supabase-service-role-jwt']);
  assert.ok(!readFileSync(join(out, 'findings.json'), 'utf8').includes('Zz9Yy8'), 'secret value must not be written');

  const scene = files(join(out, m));
  assert.deepEqual(scene, ['aria.yml', 'console.json', 'controls.json', 'full.jpg', 'links.json', 'measure.json', 'network.json', 'paint.json', 'styles.json', 'text.txt', 'top.jpg', 'volatile.json']);
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

test('app shell: a finding below the inner scroll area\'s fold says it is not in the image', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('nunchi-shell-');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/shell.html', path: '/shell.html' }], viewports: ['m'], out });
  const img = r.findings.filter(f => f.rule === 'broken-image');
  assert.equal(img.length, 1);
  assert.equal(img[0].inside, 'main', JSON.stringify(img[0]));
  const m = JSON.parse(readFileSync(join(out, 'shell.html.guest.normal.m', 'measure.json'), 'utf8'));
  assert.equal(m.scrollers.length, 1);
  assert.equal(m.scrollers[0].selector, 'main');
  assert.ok(m.scrollers[0].scrollHeight > m.scrollers[0].clientHeight * 2);
  assert.ok(!r.findings.some(f => f.rule !== 'broken-image' && f.inside), 'elements in view are not marked');
});

test('a redirected scene is flagged in the manifest and kept out of the link graph and the design system', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('nunchi-redirect-');
  // /moved.html sends the visitor to /shell.html, which no captured screen links to
  const r = await capture({ baseUrl: base, scenes: [{ route: '/', path: '/' }, { route: '/moved.html', path: '/moved.html' }], viewports: ['m'], out,
    flow: { routes: ['/', '/broken.html', '/moved.html', '/shell.html'] } });
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const moved = manifest.scenes.find(e => e.id === 'moved.html.guest.normal.m');
  assert.equal(moved.reason, 'redirected to /shell.html');
  assert.equal(moved.redirected, true, 'the manifest entry says the scene was redirected');
  assert.equal(manifest.scenes.find(e => e.id === '~.guest.normal.m').redirected, false);
  // L3: the page the redirect showed is not /moved.html's page, and the redirect itself reaches /shell.html
  assert.deepEqual(r.flow.edges.filter(e => e.from === '/moved.html'), [], 'no links are read from a redirected scene');
  assert.equal(r.flow.nodes.find(n => n.route === '/shell.html').reachedBy, 'redirect');
  assert.deepEqual(r.findings.filter(f => f.rule === 'unreachable-route').map(f => f.route), ['/moved.html']);
  // L4: the design system measures each route's own page only
  const screens = Object.values(r.system.viewports.m).filter(Array.isArray).flatMap(list => list.flatMap(v => v.screens));
  assert.ok(screens.length > 0 && !screens.includes('/moved.html'), 'a redirected scene is not one of the design system\'s screens');
});

test('deterministic: two runs of the same site give byte-identical evidence', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const scenes = [{ route: '/', path: '/' }, { route: '/broken.html', path: '/broken.html' }];
  const a = tmp('nunchi-a-'), b = tmp('nunchi-b-');
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
    capture({ baseUrl: 'http://127.0.0.1:9', scenes: [{ route: '/', path: '/', person: 'signed-in' }], out: tmp('nunchi-x-'), storageState: '/nope/auth.json' }),
    e => e.code === 'NO_AUTH',
  );
});

test('a browser path that names no file is refused before Playwright is asked: it would leave its profile and artifacts folders behind', async () => {
  const missing = join(tmp('nunchi-no-browser-'), 'no-such-browser');
  // the folder Playwright makes its own in (os.tmpdir() is read at each call)
  const own = tmp('nunchi-launch-tmp-'), saved = ['TMPDIR', 'TEMP', 'TMP'].map(k => [k, process.env[k]]);
  for (const [k] of saved) process.env[k] = own;
  try {
    await assert.rejects(launch({ browserPath: missing }), e => e.code === 'NO_BROWSER' && e.message.includes(`(no browser at ${missing})`));
    await assert.rejects(login({ url: 'http://127.0.0.1:9/', out: join(own, 'auth.json'), browserPath: missing, waitForEnter: false }), e => e.code === 'NO_BROWSER' && e.message.includes(`(no browser at ${missing})`));
  } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.deepEqual(readdirSync(own), [], 'nothing left in the temporary folder');
});

test('a sign-in page is recognised by its path, whatever the query or fragment', () => {
  for (const p of ['/login', '/sign-in?next=%2Faccount%2Fbilling', '/auth/callback#state=x', '/app/signin?r=1', '/log-in/']) assert.ok(isSignInPath(p), p);
  for (const p of ['/signing-tips', '/designs?from=login', '/blog/how-to-sign-in-faster', '/authors', '/billing#login', null]) assert.ok(!isSignInPath(p), String(p));
});
