// Probes (design 0.1-c §4.4): proof that the served code is this folder's (a probe file fetched back, or the app started
// by nunchi with an approved script on a free port), and the recording snapshot the probes replay. Tiny invented servers
// on 127.0.0.1; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { proveByFile, serveApp, snapshotRecordings, snapshotIntact, freePort, STATIC_DIRS, probeScenes } from '../src/fix/probe.mjs';
import { checkProfile } from '../src/checks.mjs';
import { findBinary } from '../src/fix/run.mjs';
import { tmp } from './fixtures/fix-project.mjs';

const listen = handler => new Promise(res => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` })); });

test('proof by probe file: a server that serves this folder\'s public/ as it is now passes; one serving a build made before does not; no static folder says so', async () => {
  const root = tmp('nunchi-proof-');
  mkdirSync(join(root, 'public'));
  const live = await listen((req, res) => { const f = join(root, 'public', req.url.slice(1)); if (existsSync(f)) { res.end(readFileSync(f)); } else { res.statusCode = 404; res.end('no'); } });
  const frozen = new Set(readdirSync(join(root, 'public')));                 // what a production build has
  const built = await listen((req, res) => { const n = req.url.slice(1); if (frozen.has(n)) res.end(readFileSync(join(root, 'public', n))); else { res.statusCode = 404; res.end('no'); } });
  try {
    const ok = await proveByFile({ root, url: `${live.url}/` });
    assert.deepEqual(ok, { ok: true, how: 'probe-file' });
    assert.deepEqual(readdirSync(join(root, 'public')), [], 'the probe file is removed');
    const no = await proveByFile({ root, url: built.url, timeoutMs: 1500 });
    assert.equal(no.ok, false);
    assert.match(no.why, /did not serve a file written into public\/ of this folder: it is not running from here, or it serves a build made before/);
    const bare = tmp('nunchi-proof-bare-');
    assert.deepEqual(await proveByFile({ root: bare, url: live.url }), { ok: false, why: 'the app has no public/ or static/ folder to place a probe file in (use --serve dev or --serve start)' });
    assert.deepEqual(STATIC_DIRS, ['public', 'static']);
  } finally { live.s.close(); built.s.close(); }
});

test('--serve: nunchi starts the app from this folder with the approved script on a free port (PORT set), and stops it; a script that dies or is missing is said', async t => {
  if (!findBinary('npm')) return t.skip('npm is not installed here');
  const root = tmp('nunchi-serve-');
  writeFileSync(join(root, 'server.js'), "require('http').createServer((q, s) => s.end('shelf on ' + process.env.PORT)).listen(Number(process.env.PORT), '127.0.0.1');\n");
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'serve-fixture', private: true, scripts: { start: 'node server.js', dev: 'node -e "process.exit(3)"', prestart: 'node -e "require(\'fs\').writeFileSync(\'pre.txt\', \'x\')"' } }));
  const profile = checkProfile(root);
  const s = await serveApp({ root, profile, script: 'start', url: 'http://127.0.0.1:3000/app' });
  assert.equal(s.ok, true, s.why);
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/app$/);
    const port = new URL(s.url).port;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), `shelf on ${port}`);
    assert.ok(!existsSync(join(root, 'pre.txt')), 'prestart did not run');
  } finally { s.stop(); }
  const dead = await serveApp({ root, profile, script: 'dev', url: null, timeoutMs: 20000 });
  assert.equal(dead.ok, false);
  assert.match(dead.why, /^npm run dev stopped \(3\) before the app answered/);
  assert.match((await serveApp({ root, profile: checkProfile(tmp('nunchi-serve-none-')) ?? { serve: {} }, script: 'start' })).why, /no "start" script/);
  assert.ok(Number.isInteger(await freePort()));
});

test('the recording snapshot: copied once per attempt with its sha; a snapshot changed since is caught', () => {
  const root = tmp('nunchi-snap-');
  mkdirSync(join(root, 'har'));
  writeFileSync(join(root, 'har', 'guest.json'), '{"entries":[]}');
  assert.deepEqual(snapshotRecordings(join(root, 'har'), join(root, 'snap'), ['guest', 'signed-in']), { missing: ['signed-in'] });
  const r = snapshotRecordings(join(root, 'har'), join(root, 'snap'), ['guest']);
  assert.match(r.shas.guest, /^[0-9a-f]{64}$/);
  assert.equal(snapshotIntact(join(root, 'snap'), r.shas), true);
  writeFileSync(join(root, 'har', 'guest.json'), '{"entries":[1]}');
  assert.equal(snapshotIntact(join(root, 'snap'), r.shas), true, 'a new recording in .nunchi/har does not touch the attempt\'s');
  writeFileSync(join(root, 'snap', 'guest.json'), '{"entries":[2]}');
  assert.equal(snapshotIntact(join(root, 'snap'), r.shas), false);
});

test('probe scenes: each route of the scope as the persons the sweep saw it as, with the sweep\'s sample path', () => {
  const scope = { routes: ['/app/tasks/[id]', '/pricing'], persons: ['guest', 'signed-in'], personsOf: { '/app/tasks/[id]': ['signed-in'], '/pricing': ['guest', 'signed-in'] } };
  assert.deepEqual(probeScenes(scope, { '/app/tasks/[id]': '/app/tasks/2' }), [
    { route: '/app/tasks/[id]', path: '/app/tasks/2', person: 'signed-in' },
    { route: '/pricing', path: '/pricing', person: 'guest' }, { route: '/pricing', path: '/pricing', person: 'signed-in' }]);
  // no record of how the sweep saw a route (an older record): every person; a person without a login is never added
  assert.deepEqual(probeScenes({ routes: ['/'], persons: ['guest'] }).map(s => s.person), ['guest']);
  assert.deepEqual(probeScenes({ routes: ['/'], persons: ['guest'], personsOf: { '/': ['guest', 'signed-in'] } }).map(s => s.person), ['guest']);
});
