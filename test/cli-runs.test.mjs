// The CLI writes each capture into its own run folder: complete or absent, numbered, with the source
// state it was taken from. Needs Chromium (skipped otherwise).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch } from '../src/capture.mjs';
import { discover } from '../src/discover.mjs';
import { buildInventory } from '../src/inventory.mjs';
import { stableJson, sha } from '../src/stable.mjs';

const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
let server, base, browserOk = true;
before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = join(SITE, path === '/' ? 'index.html' : path);
    if (!file.startsWith(SITE) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // CI sets NUNCHI_REQUIRE_BROWSER so a missing browser fails the run instead of skipping the capture tests
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => server && server.close());

// async: a synchronous child would block this process, and with it the test server the capture is reading
const cli = async (cwd, ...a) => JSON.parse((await promisify(execFile)('node', [CLI, ...a, '--json'], { cwd, encoding: 'utf8' })).stdout);

test('capture: numbered run folders, latest pointer, run.json with scope and source state', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-cli-')));          // macOS: /var is a symlink to /private/var
  const args = ['capture', '--url', base, '--routes', '/', '--viewports', 'm', '--states', 'normal', '--network', 'live'];
  const one = await cli(cwd, ...args);
  const two = await cli(cwd, ...args);
  assert.equal(one.run, '0001'); assert.equal(two.run, '0002');
  assert.equal(two.out, join(cwd, '.nunchi', 'runs', '0002'));
  assert.equal(readFileSync(join(cwd, '.nunchi', 'runs', 'latest'), 'utf8'), '0002\n');
  assert.deepEqual(readdirSync(join(cwd, '.nunchi', 'runs')).sort(), ['0001', '0002', 'latest']);
  const meta = JSON.parse(readFileSync(join(two.out, 'run.json'), 'utf8'));
  assert.equal(meta.id, '0002'); assert.equal(meta.parent, '0001');
  assert.equal(meta.commit, null, 'not a git repository');
  assert.deepEqual(meta.scope, { changedSince: null, persons: ['guest'], routes: ['/'], states: ['normal'], viewports: ['m'] });
  assert.equal(meta.health.status, 'ok');
  assert.ok(readFileSync(join(cwd, '.nunchi', '.gitignore'), 'utf8').includes('runs/'));
  assert.deepEqual(await cli(cwd, 'runs'), { complete: ['0001', '0002'], partial: [], latest: '0002' });
});

test('ledger CLI: findings by kind, decide on a group, the decision is a committed file and changes the status', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-led-')));
  await cli(cwd, 'capture', '--url', base, '--routes', '/broken.html', '--viewports', 'm', '--states', 'normal', '--network', 'live');
  const first = await cli(cwd, 'findings');
  assert.ok(first.kinds.length >= 5, JSON.stringify(first.kinds.map(k => k.rule)));
  const g = first.groups.find(x => x.rule === 'dead-href');
  const made = await cli(cwd, 'decide', g.group.slice(0, 8), 'fix');
  assert.equal(made[0].decision, 'fix');
  assert.deepEqual(readdirSync(join(cwd, '.nunchi', 'decisions')), [`group-${g.group}`]);
  const after = await cli(cwd, 'findings', '--status', 'to-fix');
  assert.deepEqual(after.groups.map(x => x.group), [g.group]);
  assert.ok(!readFileSync(join(cwd, '.nunchi', '.gitignore'), 'utf8').includes('decisions'), 'decisions are committed');
});

test('capture: inventory.json with discovered routes (same bytes twice), none with --routes; a failure only warns', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  // an invented Next.js app whose one route '/' is served by the fixture site
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-inv-cli-')));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
  mkdirSync(join(app, 'app'));
  writeFileSync(join(app, 'app', 'page.tsx'), 'export default function Home() {\n  const clearAll = () => store.clear();\n  return <main><h1>Pebble Tasks</h1><button onClick={clearAll}>Delete all</button></main>;\n}\n');
  const args = ['capture', '--url', base, '--root', app, '--viewports', 'm', '--states', 'normal', '--network', 'live'];
  const one = await cli(app, ...args);
  const two = await cli(app, ...args);
  const inv = readFileSync(join(one.out, 'inventory.json'));
  assert.ok(inv.equals(readFileSync(join(two.out, 'inventory.json'))), 'deterministic');
  assert.equal(inv.toString(), stableJson(buildInventory(app, discover(app).routes)), 'what nunchi inventory --json gives');
  const parsed = JSON.parse(inv);
  assert.deepEqual(parsed.files.map(f => [f.file, f.routes]), [['app/page.tsx', ['/']]]);
  assert.ok(parsed.candidates.some(c => c.lens === 'L9' && c.kind === 'unguarded-destructive' && c.file === 'app/page.tsx'));
  // the hunt plan of that run hands the route's slice to the source lenses
  const plan = JSON.parse((await promisify(execFile)('node', [CLI, 'hunt', '--plan', '--run', one.run, '--lens', 'L9', '--json'], { cwd: app, encoding: 'utf8' })).stdout);
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0].files[0], `hunt/source/${sha('/', 12)}.json`, 'no reference scene here: the slice comes first, the scene last');
  assert.ok(existsSync(join(one.out, plan.units[0].files[0])));
  // explicit --routes: no source, so no inventory (and no source map)
  const three = await cli(app, 'capture', '--url', base, '--routes', '/', '--viewports', 'm', '--states', 'normal', '--network', 'live');
  assert.ok(!existsSync(join(three.out, 'inventory.json')) && !existsSync(join(three.out, 'source-map.json')));
  // an inventory that cannot be written never fails the capture: one warning line, the evidence is complete
  const out = join(app, 'o');
  mkdirSync(join(out, 'inventory.json'), { recursive: true });
  writeFileSync(join(out, 'inventory.json', 'keep'), 'x');
  const r = await promisify(execFile)('node', [CLI, ...args, '--out', out, '--json'], { cwd: app, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).health.status, 'ok');
  assert.ok(existsSync(join(out, 'manifest.json')) && existsSync(join(out, 'source-map.json')));
  assert.equal(r.stderr.split('\n').filter(l => l.startsWith('warning: no inventory.json')).length, 1, r.stderr);
});

test('capture: run.json says wholeApp only when every route of the app was captured (not with --routes, not with a route skipped)', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  // an invented Next.js app: '/' and a dynamic route that needs a sample
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-whole-')));
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
  mkdirSync(join(app, 'app', 'posts', '[id]'), { recursive: true });
  writeFileSync(join(app, 'app', 'page.tsx'), 'export default function Home() { return <main><h1>Home</h1></main>; }\n');
  writeFileSync(join(app, 'app', 'posts', '[id]', 'page.tsx'), 'export default function Post() { return <main><h1>Post</h1></main>; }\n');
  writeFileSync(join(app, 'samples.json'), JSON.stringify({ '/posts/[id]': '/index.html' }));
  const args = ['capture', '--url', base, '--root', app, '--viewports', 'm', '--states', 'normal', '--network', 'live'];
  const whole = r => JSON.parse(readFileSync(join(r.out, 'run.json'), 'utf8')).wholeApp;
  assert.equal(whole(await cli(app, ...args)), false, 'a dynamic route without a sample was skipped');
  assert.equal(whole(await cli(app, ...args, '--samples', 'samples.json')), true, 'every route captured');
  assert.equal(whole(await cli(app, ...args, '--samples', 'samples.json', '--routes', '/')), false, '--routes');
});

test('capture: a React Router path discover cannot resolve is listed and never makes a run partial; a skipped sample does', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  // an invented app whose bundle holds a secret until it is fixed; the secret-shaped value is made here, never committed
  let leak = true;
  const key = 'sk_' + 'live_' + 'NunchiFixture' + '0'.repeat(16);
  const app = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(leak ? `window.k = "${key}";\n` : 'window.k = null;\n'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><head><title>Page</title></head><body><main><h1>Page</h1><a href="/">Home</a></main><script src="/app.js"></script></body></html>');
  });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${app.address().port}`;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-rr-')));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-router-dom': '6.0.0', react: '18.0.0' } }));
    mkdirSync(join(root, 'src'));
    // `settings` is relative (nested): discover cannot resolve it, so every run skips it
    writeFileSync(join(root, 'src', 'routes.jsx'), "import { Route } from 'react-router-dom';\nexport const routes = (\n  <>\n    <Route path=\"/\" />\n    <Route path=\"/posts/:id\" />\n    <Route path=\"settings\" />\n  </>\n);\n");
    writeFileSync(join(root, 'samples.json'), JSON.stringify({ '/posts/:id': '/posts/1' }));
    const capture = async (...extra) => JSON.parse(readFileSync(join((await cli(root, 'capture', '--url', url, '--root', root, '--viewports', 'm', '--states', 'normal', '--network', 'live', ...extra)).out, 'run.json'), 'utf8'));
    const secret = async () => (await cli(root, 'findings', '--all')).groups.find(g => g.rule === 'secret-in-client-bundle')?.status;
    const one = await capture('--samples', 'samples.json');
    assert.deepEqual([one.wholeApp, one.unresolved], [true, ['settings']], 'the unresolved path is listed, and the run still judged the whole app');
    assert.equal(await secret(), 'open');
    leak = false;
    const two = await capture();                                     // no samples: /posts/:id skipped for this run only
    assert.deepEqual([two.wholeApp, two.unresolved], [false, ['settings']]);
    assert.equal(await secret(), 'open', 'a run that skipped a route the secret was seen with does not fix it');
    const three = await capture('--samples', 'samples.json');
    assert.equal(three.wholeApp, true);
    assert.equal(await secret(), 'fixed', 'looked at everywhere it was seen again, the unresolved path notwithstanding');
  } finally { app.close(); }
});

test('capture: a ledger that cannot be brought up to date warns and never fails the capture', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-fold-fail-')));
  mkdirSync(join(cwd, '.nunchi', 'state'), { recursive: true });
  writeFileSync(join(cwd, '.nunchi', 'state', 'ledger.json'), '{"runs": [');
  const r = await promisify(execFile)('node', [CLI, 'capture', '--url', base, '--routes', '/', '--viewports', 'm', '--states', 'normal', '--network', 'live', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).run, '0001');
  assert.ok(existsSync(join(cwd, '.nunchi', 'runs', '0001', 'manifest.json')), 'the run is complete');
  assert.match(r.stderr, /warning: run 0001 is complete but not in the ledger yet/);
});
