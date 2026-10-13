// Record/replay and forced states against a tiny data-driven page. The API answers with a
// counter that changes on every request, so only replay can make two runs identical.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, launch } from '../src/capture.mjs';

const SPA = new URL('./fixtures/spa', import.meta.url).pathname;
const SITE = new URL('./fixtures/site', import.meta.url).pathname;
let server, base, browserOk = true, counter = 0;

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/tasks') {
      counter++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: [{ title: 'Water the fern' }, { title: 'Return the library book' }], total: 2, sync: counter, access_token: 'tok-must-not-be-recorded' }));
    }
    if (path.startsWith('/private/')) { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (path === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (path === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<main><h1>Sign in</h1></main>'); }
    const file = path === '/' ? join(SITE, 'index.html') : existsSync(join(SPA, path)) ? join(SPA, path) : join(SITE, path);
    if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { const b = await launch(); await b.close(); } catch { browserOk = false; }
});
after(() => server && server.close());

const files = dir => readdirSync(dir, { recursive: true }).filter(f => statSync(join(dir, f)).isFile()).sort();
const text = (out, id) => readFileSync(join(out, id, 'text.txt'), 'utf8');
const tmp = p => mkdtempSync(join(tmpdir(), `nunchi-${p}-`));

test('record once, replay twice: identical evidence even though the server changes every request', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('har');
  const scenes = [{ route: '/tasks.html', path: '/tasks.html' }];
  await capture({ baseUrl: base, scenes, viewports: ['m'], out: tmp('rec'), network: 'record', recordingDir: har });
  const recording = readFileSync(join(har, 'guest.json'), 'utf8');
  assert.ok(!recording.includes('tok-must-not-be-recorded'), 'tokens are redacted in the recording');
  const recorded = JSON.parse(JSON.parse(recording).entries['GET app:/api/tasks'][0].body).sync;

  const a = tmp('a'), b = tmp('b');
  const ra = await capture({ baseUrl: base, scenes, viewports: ['m'], out: a, network: 'auto', recordingDir: har });
  await capture({ baseUrl: base, scenes, viewports: ['m'], out: b, network: 'replay', recordingDir: har });
  assert.equal(ra.run.network.guest, 'replay', 'auto replays when a recording exists');
  const id = 'tasks.html.guest.normal.m';
  assert.match(text(a, id), new RegExp(`Synced #${recorded}\\b`));
  const stable = f => f !== 'timing.json' && f !== 'run.json' && !f.endsWith('volatile.json');
  const diff = files(a).filter(stable).filter(f => !readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
  assert.deepEqual(diff, []);
  assert.equal(counter, recorded, 'two replays never asked the live server');

  const live1 = tmp('l1'), live2 = tmp('l2');
  await capture({ baseUrl: base, scenes, viewports: ['m'], out: live1 });
  await capture({ baseUrl: base, scenes, viewports: ['m'], out: live2 });
  assert.notEqual(text(live1, id), text(live2, id), 'without replay the same page differs between runs');
  assert.equal(counter, recorded + 2, 'live runs did ask the server');
});

test('forced states: empty, error, slow, offline are captured and judged', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('har2'), out = tmp('states');
  const scenes = [{ route: '/tasks.html', path: '/tasks.html' }, { route: '/quiet.html', path: '/quiet.html' }, { route: '/', path: '/' }];
  const r = await capture({ baseUrl: base, scenes, viewports: ['m'], out, network: 'auto', recordingDir: har, states: ['normal', 'empty', 'error', 'slow', 'offline'] });
  const ids = r.manifest.scenes.map(s => s.id);
  assert.ok(!ids.some(id => id.startsWith('~.') && !id.includes('.normal.')), 'a page without data requests gets no forced states');

  assert.match(text(out, 'tasks.html.guest.empty.m'), /No tasks yet/);
  assert.match(text(out, 'tasks.html.guest.error.m'), /Internal Server Error/);
  assert.match(text(out, 'tasks.html.guest.slow.m'), /Loading…/);
  assert.match(text(out, 'tasks.html.guest.normal.m'), /Water the fern/);

  const has = (scene, rule) => r.findings.some(f => f.scene === scene && f.rule === rule);
  assert.ok(has('tasks.html.guest.error.m', 'raw-error-text'), 'raw server message shown to the user');
  assert.ok(has('quiet.html.guest.error.m', 'error-looks-empty'), 'an error that looks like an empty list');
  assert.ok(!has('tasks.html.guest.error.m', 'error-looks-empty'), 'tasks shows a distinct error');
  assert.ok(has('tasks.html.guest.offline.m', 'no-offline-notice'), 'going offline changed nothing');
  assert.ok(!r.findings.some(f => f.rule === 'failed-request' && /\.(error|offline)\./.test(f.scene)), 'forced failures are not findings');
});

test('replay misses are recorded as drift, not hidden', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('har3');
  await capture({ baseUrl: base, scenes: [{ route: '/', path: '/' }], viewports: ['m'], out: tmp('r3'), network: 'record', recordingDir: har });
  const out = tmp('m3');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/tasks.html', path: '/tasks.html' }], viewports: ['m'], out, network: 'replay', recordingDir: har });
  assert.equal(r.manifest.scenes[0].replayMisses, 1);
  const net = JSON.parse(readFileSync(join(out, 'tasks.html.guest.normal.m', 'network.json'), 'utf8'));
  assert.deepEqual(net.replayMisses, ['GET app:/api/tasks']);
});

test('replay without a recording fails loudly', async () => {
  await assert.rejects(capture({ baseUrl: base, scenes: [{ route: '/', path: '/' }], out: tmp('x'), network: 'replay', recordingDir: tmp('none') }), e => e.code === 'NO_RECORDING');
});

test('signed-in scenes use the saved login; guest scenes never see it', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const dir = tmp('auth'), auth = join(dir, 'auth.json'), out = tmp('me');
  writeFileSync(auth, JSON.stringify({ cookies: [{ name: 'pebble_session', value: 'Mina%20(test)', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
  await capture({ baseUrl: base, scenes: [{ route: '/me.html', path: '/me.html', person: 'guest' }, { route: '/me.html', path: '/me.html', person: 'signed-in' }], viewports: ['m'], out, storageState: auth });
  assert.match(text(out, 'me.html.signed-in.normal.m'), /Signed in as Mina \(test\)/);
  assert.match(text(out, 'me.html.guest.normal.m'), /Please sign in\./);
});

test('a recording survives a new port: same-origin requests are keyed as app:', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('har4');
  await capture({ baseUrl: base, scenes: [{ route: '/tasks.html', path: '/tasks.html' }], viewports: ['m'], out: tmp('r4'), network: 'record', recordingDir: har });
  const other = base.replace('127.0.0.1', 'localhost');
  const r = await capture({ baseUrl: other, scenes: [{ route: '/tasks.html', path: '/tasks.html' }], viewports: ['m'], out: tmp('m4'), network: 'replay', recordingDir: har });
  assert.equal(r.manifest.scenes[0].replayMisses, 0);
});

test('an expired login is one run problem, not a finding per screen', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const dir = tmp('exp'), auth = join(dir, 'auth.json');
  writeFileSync(auth, JSON.stringify({ cookies: [], origins: [] }));
  const scenes = ['/private/a', '/private/b', '/private/c'].map(p => ({ route: p, path: p, person: 'signed-in' })).concat([{ route: '/', path: '/', person: 'guest' }]);
  const r = await capture({ baseUrl: base, scenes, viewports: ['m'], out: tmp('exp-out'), storageState: auth });
  assert.equal(r.manifest.health.status, 'login-expired', JSON.stringify(r.manifest.scenes.map(e => [e.id, e.status, e.reason, e.finalPath])) + JSON.stringify(r.findings.map(f => f.rule)));
  assert.deepEqual(r.manifest.health.problems, [{ status: 'login-expired', scenes: 3, of: 3 }]);
  const signed = r.manifest.scenes.filter(e => e.person === 'signed-in');
  assert.ok(signed.every(e => e.status === 'not-seen' && e.reason === 'login-expired'));
  assert.deepEqual(r.findings.filter(f => signed.some(e => e.id === f.scene)), []);
  assert.equal(r.run.health.status, 'login-expired');
});

test('a server that is not there is one run problem, and Chromium\'s error page is never a screen', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const r = await capture({ baseUrl: 'http://127.0.0.1:9', scenes: [{ route: '/', path: '/' }, { route: '/a', path: '/a' }], viewports: ['m'], out: tmp('down'), timeout: 5000 });
  assert.equal(r.manifest.health.status, 'app-unreachable');
  assert.ok(r.manifest.scenes.every(e => e.status === 'capture-failed' && e.reason === 'browser-error-page'), JSON.stringify(r.manifest.scenes));
  assert.deepEqual(r.findings, []);
});

test('a redirect loop is a finding on its scene, not a missing screen', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/loop', path: '/loop' }, { route: '/', path: '/' }], viewports: ['m'], out: tmp('loop') });
  assert.deepEqual(r.findings.filter(f => f.rule === 'redirect-loop').map(f => f.scene), ['loop.guest.normal.m']);
  assert.equal(r.manifest.scenes.find(e => e.route === '/loop').reason, 'redirect-loop');
  assert.ok(!r.findings.some(f => f.rule === 'redirect-loop' && f.route === '/'));
  assert.equal(r.manifest.health.status, 'ok');
});
