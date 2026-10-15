// The board server's security checks (design 0.1-c §3.2), each with a test that fails without it. Raw HTTP against a
// board started in this process on a synthetic project; no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, statSync, cpSync, openSync, closeSync, readlinkSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { startBoard, CSP, SECURITY_HEADERS, MAX_BODY, MAX_SESSION_BODY, MAX_CONNECTIONS, LIMITS, MAX_STREAMS, openerCommand, openerEnv, sameSecret, CODE_TTL_MS } from '../src/board/server.mjs';
import { openBoard, stopBoards, serverEnv, real, serverCwd } from '../src/board/launch.mjs';
import { smallProject, jpeg, writeRun } from './fixtures/board-project.mjs';
import { tmp } from './fixtures/tmp.mjs';

const POSIX = process.platform !== 'win32';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/board/server.mjs', import.meta.url));

// One raw request: every header as given (Host included, or none at all).
function raw(port, { method = 'GET', path = '/', headers = {}, body = null, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((res, rej) => {
    const h = Object.fromEntries(Object.entries({ ...(host !== null ? { host } : {}), ...headers }).filter(([, v]) => v !== undefined));
    if (body !== null && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length') && !h['transfer-encoding']) h['content-length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, setHost: false }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => { const b = Buffer.concat(chunks); let json = null; try { json = JSON.parse(b.toString('utf8')); } catch {} res({ status: r.statusCode, headers: r.headers, body: b, json }); });
    });
    req.on('error', rej);
    if (body !== null) req.write(body);
    req.end();
  });
}
async function board(opts = {}) {
  const p = opts.project || smallProject();
  const b = await startBoard({ projectDir: p.root, ...opts.board });
  const origin = b.origin;
  const code = () => b.newLink().split('#t=')[1];
  const session = async () => (await raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: code() }) })).json.token;
  // a trade that fails closes the board first (a board left listening keeps this file's process alive to the runner's limit)
  return { p, b, origin, code, session, token: await session().catch(async e => { await b.close(); throw e; }) };
}
const auth = (token, extra = {}) => ({ 'x-nunchi-token': token, ...extra });

test('§3.2 bind: the board listens on 127.0.0.1 only, never on ::1 or another interface', async () => {
  const { b } = await board();
  try {
    assert.equal(b.server.address().address, '127.0.0.1');
    const tryConnect = host => new Promise(res => { const s = connect({ host, port: b.port }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    assert.equal(await tryConnect('::1'), false, '::1 is not served');
    const other = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    if (other) assert.equal(await tryConnect(other.address), false, `${other.address} is not served`);
  } finally { await b.close(); }
});

test('§3.2 Host: only 127.0.0.1:<port> is answered (DNS rebinding), never localhost, another name or no Host', async () => {
  const { b } = await board();
  try {
    assert.equal((await raw(b.port)).status, 200);
    for (const host of [`localhost:${b.port}`, `evil.example:${b.port}`, '127.0.0.1', `127.0.0.1:${b.port + 1}`, `[::1]:${b.port}`, `127.0.0.1.nip.io:${b.port}`, null]) {
      const r = await raw(b.port, { host });
      assert.equal(r.status, 421, `Host ${host}`);
      assert.equal(r.headers['content-security-policy'], CSP, 'the security headers are on refusals too');
    }
  } finally { await b.close(); }
});

test('§3.2 token: every route but the page shell needs X-Nunchi-Token; a wrong key, a cookie or a query key does not count', async () => {
  const { b, token, p } = await board();
  try {
    const gid = p.findings[1].group;
    const scene = p.scenes[0].id;
    const routes = ['/api/summary', '/api/groups', `/api/groups/${gid}`, '/api/screens', `/api/screens/0001/${encodeURIComponent(scene)}`, '/api/coverage', '/api/generation', '/api/live', `/evidence/0001/${encodeURIComponent(scene)}/full.jpg`];
    for (const path of routes) {
      assert.equal((await raw(b.port, { path })).status, 401, `${path} without a key`);
      assert.equal((await raw(b.port, { path, headers: auth('0'.repeat(64)) })).status, 401, `${path} with a wrong key`);
      assert.equal((await raw(b.port, { path, headers: { cookie: `nunchi=${token}; token=${token}` } })).status, 401, `${path} with the key as a cookie`);
      assert.equal((await raw(b.port, { path: `${path}${path.includes('?') ? '&' : '?'}token=${token}` })).status, 401, `${path} with the key in the query`);
    }
    const post = await raw(b.port, { method: 'POST', path: '/api/decide', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ targets: [gid], decision: 'fix', reason: null }) });
    assert.equal(post.status, 401);
    for (const path of routes.filter(r => r !== '/api/live')) assert.equal((await raw(b.port, { path, headers: auth(token) })).status, 200, `${path} with the key`);
    // compared in constant time over hashes, whatever the lengths
    assert.equal(sameSecret('a'.repeat(64), 'a'.repeat(64)), true);
    assert.equal(sameSecret('a'.repeat(64), 'a'.repeat(63)), false);
  } finally { await b.close(); }
});

test('§3.2 the page shell answers without a key and holds no data of the project', async () => {
  const { b, p, token } = await board();
  try {
    const project = JSON.stringify(p.findings) + p.scenes.map(s => s.id).join('');
    for (const path of ['/', '/assets/board.js', '/assets/shared.mjs', '/assets/coverage.js', '/assets/screens.js', '/assets/board.css']) {
      const r = await raw(b.port, { path });
      assert.equal(r.status, 200, path);
      const text = r.body.toString('utf8');
      for (const g of p.findings.map(f => f.group)) assert.ok(!text.includes(g), `${path} names no group`);
      assert.ok(!text.includes('TypeError'), `${path} quotes no app text`);
      assert.ok(!text.includes(token), `${path} holds no key`);
      assert.ok(project.length > 0);
    }
    assert.equal((await raw(b.port, { path: '/index.html' })).status, 401, 'no other name for the shell: anything else needs a key');
    assert.equal((await raw(b.port, { path: '/?x=1' })).status, 401, 'the shell has no query form');
  } finally { await b.close(); }
});

test('§3.2 launch link: a one-time code in the fragment, spent on first use, expired after 2 minutes; the key is 32 bytes', async () => {
  let clock = 1_000_000;
  const { b, origin } = await board({ board: { now: () => clock } });
  try {
    const link = b.newLink();
    assert.match(link, new RegExp(`^${origin.replace(/\./g, '\\.')}/#t=[0-9a-f]{64}$`), 'the code is in the fragment, never in the path or query (it is not sent in a request line)');
    const code = link.split('#t=')[1];
    const xchg = c => raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: c }) });
    const one = await xchg(code);
    assert.equal(one.status, 200);
    assert.match(one.json.token, /^[0-9a-f]{64}$/);
    assert.notEqual(one.json.token, code, 'the key is not the code');
    assert.equal((await xchg(code)).status, 401, 'the second use is refused');
    const late = b.newLink().split('#t=')[1];
    clock += CODE_TTL_MS + 1000;
    assert.equal((await xchg(late)).status, 401, 'an expired code is refused');
    assert.equal((await xchg('f'.repeat(64))).status, 401);
    assert.equal(CODE_TTL_MS, 120e3);
  } finally { await b.close(); }
});

test('§3.2 Sec-Fetch-Site: cross-site and same-site requests are refused; same-origin, none and absent are served', async () => {
  const { b, token } = await board();
  try {
    for (const [site, want] of [['cross-site', 403], ['same-site', 403], ['same-origin', 200], ['none', 200]]) {
      assert.equal((await raw(b.port, { path: '/api/summary', headers: auth(token, { 'sec-fetch-site': site }) })).status, want, site);
      assert.equal((await raw(b.port, { path: '/', headers: { 'sec-fetch-site': site } })).status, want, `${site} on the shell`);
    }
    assert.equal((await raw(b.port, { path: '/api/summary', headers: auth(token) })).status, 200, 'absent');
  } finally { await b.close(); }
});

test('§3.2 request target: req.url must start with /, and is at most 2048 characters', async () => {
  const { b, token } = await board();
  try {
    assert.equal((await raw(b.port, { path: `http://127.0.0.1:${b.port}/api/summary`, headers: auth(token) })).status, 400, 'absolute form');
    assert.equal((await raw(b.port, { path: `http://evil.example/api/summary`, headers: auth(token) })).status, 400);
    assert.equal((await raw(b.port, { path: `/api/groups?q=${'x'.repeat(2100)}`, headers: auth(token) })).status, 414);
    assert.equal((await raw(b.port, { path: '//evil.example/api/summary', headers: auth(token) })).status, 404, 'a path that looks like another host is only a path');
  } finally { await b.close(); }
});

test('§3.2 the link trade reads at most 1 KB: a longer body is refused before the code is looked at (by length or streamed)', async () => {
  const { b, origin, code } = await board();
  try {
    assert.equal(MAX_SESSION_BODY, 1024);
    const c = code();
    const big = JSON.stringify({ code: c, pad: 'x'.repeat(MAX_SESSION_BODY) });
    const trade = (body, headers = {}) => raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin, ...headers }, body });
    const byLength = await trade(big);
    assert.equal(byLength.status, 413, 'by Content-Length');
    assert.match(byLength.json.error, /larger than 1 KB/);
    const streamed = await trade(big, { 'transfer-encoding': 'chunked', 'content-length': undefined }).catch(() => ({ status: 'closed' }));
    assert.ok(streamed.status === 413 || streamed.status === 'closed', `streamed past the cap: ${streamed.status}`);
    // nothing was read as a trade: the code is still good
    const ok = await trade(JSON.stringify({ code: c }));
    assert.equal(ok.status, 200);
    assert.match(ok.json.token, /^[0-9a-f]{64}$/);
  } finally { await b.close(); }
});

test('§3.2 connections: at most 64 at once; one more is closed by the server, and freed slots serve again', async () => {
  const { b } = await board();
  const socks = [];
  try {
    assert.equal(b.server.maxConnections, MAX_CONNECTIONS);
    assert.equal(MAX_CONNECTIONS, 64);
    const open = () => new Promise((res, rej) => { const s = connect({ host: '127.0.0.1', port: b.port }); s.once('connect', () => res(s)); s.once('error', rej); });
    while (socks.length < MAX_CONNECTIONS) socks.push(await open());
    // the server counts a connection once it accepted it
    for (let i = 0; i < 100; i++) { const n = await new Promise(r => b.server.getConnections((e, k) => r(k))); if (n >= MAX_CONNECTIONS) break; await new Promise(r => setTimeout(r, 10)); }
    const extra = await open();
    const closed = await new Promise(res => { const t = setTimeout(() => res(false), 3000); extra.once('close', () => { clearTimeout(t); res(true); }); extra.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + b.port + '\r\n\r\n'); extra.on('data', () => {}); });
    assert.equal(closed, true, 'the 65th connection is closed without an answer');
    // (an idle keep-alive connection of the session trade may hold a slot too: free them all)
    while (socks.length) socks.pop().destroy();
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await raw(b.port)).status, 200, 'freed slots are served again');
  } finally { for (const s of socks) s.destroy(); await b.close(); }
});

test('§3.2 writes: POST only, application/json, Origin equal to the board, a body of at most 64 KB; no CORS (OPTIONS 405)', async () => {
  const { b, token, origin, p } = await board();
  try {
    const gid = p.findings.find(f => f.rule === 'dead-href').group;
    const body = JSON.stringify({ targets: [gid], decision: 'hold', reason: null });
    const post = (headers, b2 = body) => raw(b.port, { method: 'POST', path: '/api/decide', headers: auth(token, headers), body: b2 });
    assert.equal((await post({ 'content-type': 'text/plain', origin })).status, 415);
    assert.equal((await post({ 'content-type': 'application/x-www-form-urlencoded', origin })).status, 415);
    assert.equal((await post({ 'content-type': 'application/json' })).status, 403, 'no Origin');
    assert.equal((await post({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ 'content-type': 'application/json', origin: `http://localhost:${b.port}` })).status, 403);
    assert.equal((await post({ 'content-type': 'application/json', origin: 'null' })).status, 403);
    const big = JSON.stringify({ targets: [gid], decision: 'hold', reason: null, pad: 'x'.repeat(MAX_BODY) });
    assert.equal((await post({ 'content-type': 'application/json', origin }, big)).status, 413, 'by Content-Length');
    assert.equal((await post({ 'content-type': 'application/json', origin, 'transfer-encoding': 'chunked', 'content-length': undefined }, big).catch(() => ({ status: 413 }))).status, 413, 'streamed past the cap');
    assert.equal((await raw(b.port, { method: 'GET', path: '/api/summary', headers: auth(token), body: 'x' })).status, 413, 'a GET has no body');
    for (const path of ['/api/summary', '/', '/api/generation']) {
      assert.equal((await raw(b.port, { method: 'GET', path, headers: auth(token, { 'transfer-encoding': 'chunked' }), body: 'x' })).status, 413, `a GET streams no body either (${path})`);
    }
    for (const method of ['OPTIONS', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const r = await raw(b.port, { method, path: '/api/decide', headers: auth(token, { origin: 'http://evil.example', 'access-control-request-method': 'POST' }) });
      assert.equal(r.status, 405, method);
    }
    const ok = await post({ 'content-type': 'application/json; charset=utf-8', origin });
    assert.equal(ok.status, 200, 'a well-formed write is recorded');
    // no CORS header on any response, even when asked
    for (const r of [ok, await raw(b.port, { path: '/api/summary', headers: auth(token, { origin: 'http://evil.example' }) }), await raw(b.port, { method: 'OPTIONS', path: '/' })]) {
      assert.ok(!Object.keys(r.headers).some(h => h.startsWith('access-control-')), JSON.stringify(r.headers));
    }
  } finally { await b.close(); }
});

test('§3.2 response headers: CSP, X-Frame-Options, nosniff, Referrer-Policy, CORP, COOP and no-store on every response', async () => {
  const { b, token, p } = await board();
  try {
    const scene = encodeURIComponent(p.scenes[0].id);
    const all = [await raw(b.port), await raw(b.port, { path: '/assets/board.js' }), await raw(b.port, { path: '/api/summary', headers: auth(token) }),
      await raw(b.port, { path: '/api/summary' }), await raw(b.port, { path: '/nope', headers: auth(token) }), await raw(b.port, { host: 'localhost' }),
      await raw(b.port, { path: `/evidence/0001/${scene}/full.jpg`, headers: auth(token) }), await raw(b.port, { method: 'OPTIONS' })];
    for (const r of all) {
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.ok(!r.headers['set-cookie'], 'no cookie, ever');
    }
    assert.deepEqual(Object.keys(SECURITY_HEADERS).sort(), ['Cache-Control', 'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Permissions-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options']);
  } finally { await b.close(); }
});

test('§3.2 files: known routes and allow-listed evidence only — no listing, no traversal, no links, no other run or scene, no SVG', async () => {
  const p = smallProject();
  const run = p.run;
  const sc = p.scenes[0].id;
  // a canary copy, an incomplete run, a scene folder that is a link, a screenshot that is a link, one that is not a JPEG
  const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'));
  manifest.scenes.push({ ...manifest.scenes[0], id: 'canary-1', canary: 'clip' }, { ...manifest.scenes[0], id: 'linked.guest.normal.d' }, { ...manifest.scenes[0], id: 'notjpeg.guest.normal.d' }, { ...manifest.scenes[0], id: 'jpeglink.guest.normal.d' });
  writeFileSync(join(run, 'manifest.json'), JSON.stringify(manifest));
  mkdirSync(join(run, 'canary-1')); writeFileSync(join(run, 'canary-1', 'full.jpg'), jpeg(10, 10));
  mkdirSync(join(p.nunchi, 'runs', '0002.partial', sc), { recursive: true }); writeFileSync(join(p.nunchi, 'runs', '0002.partial', sc, 'full.jpg'), jpeg(10, 10));
  const outside = join(p.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'full.jpg'), jpeg(10, 10)); writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  mkdirSync(join(run, 'notjpeg.guest.normal.d')); writeFileSync(join(run, 'notjpeg.guest.normal.d', 'full.jpg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  if (POSIX) {
    symlinkSync(outside, join(run, 'linked.guest.normal.d'));
    mkdirSync(join(run, 'jpeglink.guest.normal.d')); symlinkSync(join(outside, 'full.jpg'), join(run, 'jpeglink.guest.normal.d', 'full.jpg'));
    // a run folder that is a link to a copy of a real run
    cpSync(run, join(p.root, 'copy-of-run'), { recursive: true });
    symlinkSync(join(p.root, 'copy-of-run'), join(p.nunchi, 'runs', '0009'));
  }
  const { b, token } = await board({ project: p });
  try {
    const get = path => raw(b.port, { path, headers: auth(token) });
    const ok = await get(`/evidence/0001/${encodeURIComponent(sc)}/full.jpg`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal((await get(`/evidence/0001/${encodeURIComponent(sc)}/top.jpg`)).status, 200);
    const refused = {
      '/assets/': 404, '/assets': 404, '/api/': 404, '/evidence/': 404, '/evidence/0001/': 404, [`/evidence/0001/${encodeURIComponent(sc)}/`]: 400,
      [`/evidence/0001/${encodeURIComponent(sc)}/network.json`]: 404, [`/evidence/0001/${encodeURIComponent(sc)}/text.txt`]: 404,
      [`/evidence/0001/${encodeURIComponent(sc)}/controls.json`]: 404, [`/evidence/0001/${encodeURIComponent(sc)}/full.svg`]: 404,
      '/evidence/0001/missing.guest.normal.d/full.jpg': 404, '/evidence/0001/canary-1/full.jpg': 404, [`/evidence/0002/${encodeURIComponent(sc)}/full.jpg`]: 404,
      [`/evidence/0002.partial/${encodeURIComponent(sc)}/full.jpg`]: 404, [`/evidence/0001/..%2F..%2Foutside/full.jpg`]: 400, '/evidence/0001/%2e%2e/full.jpg': 404,
      [`/evidence/0001/${encodeURIComponent(sc)}/..%2Ffindings.json`]: 400, '/evidence/0001/%00/full.jpg': 400, '/evidence/%E0%A4%A/x/full.jpg': 400,
      '/evidence/0001/notjpeg.guest.normal.d/full.jpg': 415, '/assets/../src/cli.mjs': 404, '/src/cli.mjs': 404, '/package.json': 404,
      ...(POSIX ? { '/evidence/0001/linked.guest.normal.d/full.jpg': 404, '/evidence/0001/jpeglink.guest.normal.d/full.jpg': 404, [`/evidence/0009/${encodeURIComponent(sc)}/full.jpg`]: 404 } : {}),
    };
    for (const [path, status] of Object.entries(refused)) {
      const r = await get(path);
      assert.equal(r.status, status, `${path}: ${r.body.toString('utf8').slice(0, 120)}`);
      assert.ok(!r.body.toString('latin1').includes('SECRET-OUTSIDE'), path);
      assert.notEqual(r.headers['content-type'], 'image/svg+xml');
    }
  } finally { await b.close(); }
});

test('§3.2 rate limits: wrong keys lock out requests without a key (never the person\'s key); requests and writes are capped', async () => {
  const { b, token, origin } = await board();
  try {
    let last;
    for (let i = 0; i < LIMITS.fail[0] + 1; i++) last = await raw(b.port, { path: '/api/summary', headers: auth('1'.repeat(64)) });
    assert.equal(last.status, 401);
    assert.equal((await raw(b.port, { path: '/api/summary', headers: auth('1'.repeat(64)) })).status, 429, 'locked out after too many wrong keys');
    assert.equal((await raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: '2'.repeat(64) }) })).status, 429, 'link guessing too');
    assert.equal((await raw(b.port, { path: '/api/summary', headers: auth(token) })).status, 200, 'the person is not locked out');
    let writes = 0, refused = 0;
    for (let i = 0; i < LIMITS.write[0] + 5; i++) {
      const r = await raw(b.port, { method: 'POST', path: '/api/decide', headers: auth(token, { 'content-type': 'application/json', origin }), body: '{}' });
      if (r.status === 429) refused++; else writes++;
    }
    assert.equal(writes, LIMITS.write[0], 'trading a link for a key has a limit of its own');
    assert.equal(refused, 5);
  } finally { await b.close(); }
  const second = await board();
  try {
    let n429 = 0;
    for (let i = 0; i < LIMITS.req[0] + 10; i++) if ((await raw(second.b.port, { path: '/api/generation', headers: auth(second.token) })).status === 429) n429++;
    assert.ok(n429 >= 10, `requests over ${LIMITS.req[0]} per 10 s are refused (${n429})`);
  } finally { await second.b.close(); }
});

test('§3.2 rate limits: requests without a key have a budget of their own, never lock the person out of the page shell, and never stop a fresh link', async () => {
  const { b, origin, code } = await board();
  const trade = c => raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: c }) });
  try {
    // wrong keys until locked out: the page shell is still served and a fresh link still opens the board
    for (let i = 0; i < LIMITS.fail[0] + 1; i++) await raw(b.port, { path: '/api/summary', headers: auth('1'.repeat(64)) });
    assert.equal((await raw(b.port, { path: '/api/summary', headers: auth('1'.repeat(64)) })).status, 429, 'locked out');
    for (const path of ['/', '/assets/board.js', '/assets/shared.mjs', '/assets/board.css']) assert.equal((await raw(b.port, { path })).status, 200, `${path} is served during a lockout`);
    assert.equal((await trade(code())).status, 200, 'a fresh link opens the board during a lockout');
    // failed trades are limited; a good one never is
    const failed = [];
    for (let i = 0; i < LIMITS.session[0] + 5; i++) failed.push((await trade('3'.repeat(64))).status);
    assert.ok(failed.every(s => s === 429), 'link guessing waits out the lockout');
    assert.equal((await trade(code())).status, 200, 'a fresh link still works');
  } finally { await b.close(); }
  // a flood without a key: refused on its own budget; the person's requests go through
  const s = await board();
  try {
    let n429 = 0;
    for (let i = 0; i < LIMITS.req[0] + 50; i++) if ((await raw(s.b.port, { path: '/api/generation' })).status === 429) n429++;
    assert.ok(n429 >= LIMITS.req[0] + 50 - LIMITS.anon[0], `requests without a key are capped at ${LIMITS.anon[0]} per 10 s (${n429} refused)`);
    assert.equal((await raw(s.b.port, { path: '/api/generation', headers: auth(s.token) })).status, 200, 'the person\'s budget is untouched');
  } finally { await s.b.close(); }
});

test('§3.2 rate limits: what a browser fetches by itself (the favicon, on every move within the page) never locks a fresh link out', async () => {
  const { b, origin, code } = await board();
  try {
    for (let i = 0; i < LIMITS.fail[0] + 20; i++) assert.equal((await raw(b.port, { path: '/favicon.ico', headers: { 'sec-fetch-dest': 'image' } })).status, 204);
    for (let i = 0; i < LIMITS.fail[0] + 20; i++) assert.equal((await raw(b.port, { path: '/api/summary' })).status, 401, 'no key: refused, but not counted as a guess');
    const r = await raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: code() }) });
    assert.equal(r.status, 200, 'a fresh link still opens the board');
  } finally { await b.close(); }
});

test('§3.2 untrusted strings: app text, decision notes and secrets reach the page redacted, as data; the page never parses markup', async () => {
  const SECRET = 'sk_' + 'live_' + 'FixtureOnly0000000000000009';
  const p = smallProject();
  // a finding whose text carries a secret and a credential URL
  writeRun(p.root, '0002', { parent: '0001', scenes: p.scenes, findings: [...p.findings.map(({ fp, group, ...f }) => f),
    { lens: 'L6', rule: 'raw-error-text', severity: 'high', scene: p.scenes[2].id, route: '/garden', viewport: 'd', selector: 'main p.oops', box: null, evidence: { text: `failed: ${SECRET} at https://user:pw@api.example.invalid/x?token=abc123` } }] });
  const { b, token } = await board({ project: p });
  try {
    const all = [];
    for (const path of ['/api/summary', '/api/groups?status=all', '/api/screens', '/api/coverage', `/api/screens/0002/${encodeURIComponent(p.scenes[2].id)}`]) all.push((await raw(b.port, { path, headers: auth(token) })).body.toString('utf8'));
    const groups = JSON.parse(all[1]).groups;
    for (const id of Object.keys(groups)) all.push((await raw(b.port, { path: `/api/groups/${id}`, headers: auth(token) })).body.toString('utf8'));
    const text = all.join('\n');
    assert.ok(!text.includes(SECRET), 'no secret value');
    assert.match(text, /\[secret-shaped: /);
    assert.ok(!text.includes('user:pw@'), 'no URL credentials');
    assert.ok(!text.includes('token=abc123'), 'no credential query values');
    // the secret finding: location and kind only
    const secret = Object.values(groups).find(g => g.rule === 'secret-in-client-bundle');
    const d = JSON.parse((await raw(b.port, { path: `/api/groups/${secret.id}`, headers: auth(token) })).body.toString('utf8'));
    assert.deepEqual(d.secret, { where: '/assets/app-4f1c2a9b.js', kind: 'stripe-live-secret-key' });
  } finally { await b.close(); }
  // the page's script builds the DOM from text only: no innerHTML, no markup strings, no eval
  const js = ['assets/board.js', 'assets/coverage.js', 'assets/screens.js', 'shared.mjs'].map(f => readFileSync(fileURLToPath(new URL(`../src/board/${f}`, import.meta.url)), 'utf8')).join('\n');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment', "setAttribute('style'", 'setAttribute("style"']) assert.ok(!js.includes(bad), bad);
});

test('§3.2 offline: the page shell and its assets load nothing from anywhere else (system fonts, no external URL)', async () => {
  const { b } = await board();
  try {
    for (const path of ['/', '/assets/board.js', '/assets/shared.mjs', '/assets/coverage.js', '/assets/screens.js', '/assets/board.css']) {
      const text = (await raw(b.port, { path })).body.toString('utf8');
      assert.ok(!/https?:\/\//.test(text), `${path} names no URL`);
      assert.ok(!/@import|@font-face|(?<![A-Za-z])url\(\s*["']?(?!blob:|data:)[a-z]/.test(text.replace(/url\("\$\{u\}"\)/g, '')), `${path} loads no stylesheet, font or image`);
      assert.ok(!/<script[^>]*>[^<]/.test(text), `${path} has no inline script`);
      assert.ok(!/<style|\sstyle=/.test(path === '/' ? text : ''), 'no inline style in the shell');
    }
  } finally { await b.close(); }
});

test('§3.2 live stream: needs the key, sends the version, and is capped', async () => {
  const { b, token } = await board();
  try {
    const open = () => new Promise((res, rej) => {
      const req = request({ host: '127.0.0.1', port: b.port, path: '/api/live', headers: { host: `127.0.0.1:${b.port}`, 'x-nunchi-token': token } }, r => {
        if (r.statusCode !== 200) { r.resume(); return res({ status: r.statusCode, req }); }
        r.setEncoding('utf8');
        r.once('data', d => res({ status: 200, first: d, req, r }));
      });
      req.on('error', rej);
      req.end();
    });
    const streams = [];
    for (let i = 0; i < MAX_STREAMS; i++) streams.push(await open());
    assert.match(streams[0].first, /event: generation\ndata: \{"version":"/);
    assert.equal((await open()).status, 429);
    for (const s of streams) s.req.destroy();
  } finally { await b.close(); }
});

test('§3.2 the board stops after the idle time, and says so to an open stream; the stream and polling do not keep it up, the person does', async () => {
  const p = smallProject();
  let exited = null;
  const b = await startBoard({ projectDir: p.root, idleMs: 1200, onExit: why => { exited = why; } });
  const code = b.newLink().split('#t=')[1];
  const token = (await raw(b.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin: b.origin }, body: JSON.stringify({ code }) })).json.token;
  // a stream held open the whole time, and the polling fallback every 200 ms: neither is the person doing something
  let said = '';
  const req = request({ host: '127.0.0.1', port: b.port, path: '/api/live', headers: { host: `127.0.0.1:${b.port}`, 'x-nunchi-token': token } }, r => { r.setEncoding('utf8'); r.on('data', d => { said += d; }); r.on('error', () => {}); });
  req.on('error', () => {});
  req.end();
  const t0 = Date.now();
  for (let i = 0; i < 80 && !exited; i++) { await raw(b.port, { path: '/api/generation', headers: auth(token) }).catch(() => {}); await new Promise(r => setTimeout(r, 200)); }
  assert.equal(exited, 'idle', 'stopped although the stream was open and the page polled');
  assert.ok(Date.now() - t0 < 6000);
  assert.match(said, /event: bye\ndata: \{"why":"idle"\}/, 'the open stream is told');
  await assert.rejects(raw(b.port), /ECONNREFUSED|ECONNRESET|socket hang up/);
  // the person's requests do keep it up
  let gone = null;
  const c = await startBoard({ projectDir: p.root, idleMs: 1200, onExit: why => { gone = why; } });
  const ct = (await raw(c.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin: c.origin }, body: JSON.stringify({ code: c.newLink().split('#t=')[1] }) })).json.token;
  for (let i = 0; i < 15; i++) { await raw(c.port, { path: '/api/summary', headers: auth(ct) }); await new Promise(r => setTimeout(r, 200)); }
  assert.equal(gone, null, 'still up after 3 s of the person\'s requests');
  await c.close();
});

test('§3.1 nunchi open: detached, returns at once; the key and the link never reach a non-terminal stdout or a file; reuse and --stop', { timeout: 60000 }, async () => {
  const p = smallProject();
  const run = (...a) => new Promise(res => execFile('node', [CLI, 'open', ...a], { cwd: p.root, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
  const t0 = Date.now();
  const one = await run('--no-browser');
  try {
    assert.equal(one.code, 0, one.stderr);
    assert.ok(Date.now() - t0 < 20000, 'returns while the board keeps running');
    const port = Number(/board open on 127\.0\.0\.1:(\d+)/.exec(one.stdout)?.[1]);
    assert.ok(port > 0, one.stdout);
    assert.ok(!/[0-9a-f]{64}/.test(one.stdout + one.stderr), 'no key and no link in the output');
    assert.ok(!/#t=/.test(one.stdout));
    assert.equal((await raw(port)).status, 200, 'the board is up');
    // its record: port and socket, never a key; nothing anywhere in the state holds a 64-hex secret
    const boards = join(p.nunchi, 'state', 'boards');
    const recs = readdirSync(boards).filter(n => n.endsWith('.json'));
    assert.equal(recs.length, 1);
    const rec = JSON.parse(readFileSync(join(boards, recs[0]), 'utf8'));
    assert.deepEqual(Object.keys(rec).sort(), ['mode', 'note', 'pid', 'port', 'project', 'schema', 'socket']);
    for (const f of readdirSync(join(p.nunchi, 'state'), { recursive: true }).map(String)) {
      const fp = join(p.nunchi, 'state', f);
      if (statSync(fp).isFile() && !f.endsWith('.sock') && !/approved\.json$/.test(f)) assert.ok(!/(^|[^0-9a-f])[0-9a-f]{64}([^0-9a-f]|$)/.test(readFileSync(fp, 'utf8')), `${f} holds no key`);
    }
    if (process.platform === 'linux') {
      const cmdline = readFileSync(`/proc/${rec.pid}/cmdline`, 'utf8'), env = readFileSync(`/proc/${rec.pid}/environ`, 'utf8');
      assert.ok(!/[0-9a-f]{64}/.test(cmdline) && !/[0-9a-f]{64}/.test(env), 'the key is in no argument and no environment variable');
      if (POSIX) assert.equal(statSync(rec.socket).mode & 0o777, 0o600, 'the control socket is owner-only');
    }
    const two = await run('--no-browser');
    assert.match(two.stdout, new RegExp(`board open on 127\\.0\\.0\\.1:${port} \\(already running\\)`));
  } finally {
    const stop = await run('--stop');
    assert.match(stop.stdout, /stopped the board/);
  }
  assert.equal(readdirSync(join(p.nunchi, 'state', 'boards')).filter(n => n.endsWith('.json')).length, 0, 'its record is gone');
});

test('§3.1 the link never reaches stdout: the server started directly, with any flag, prints its port only; nunchi open gets the link over a pipe of its own (fd 3)', { timeout: 60000 }, async () => {
  const p = smallProject();
  const start = (stdio) => {
    const child = spawn(process.execPath, [SERVER, '--project', p.root, '--link-to-parent', '--idle-ms', '20000'], { stdio });
    const line = new Promise((res, rej) => {
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => { buf += d; if (buf.includes('\n')) res(buf); });
      child.on('exit', () => rej(new Error(`exited: ${buf}`)));
    });
    return { child, line };
  };
  const stop = c => new Promise(r => { c.on('exit', r); c.kill('SIGTERM'); });
  // no fd 3: the port, nothing else
  const a = start(['ignore', 'pipe', 'ignore']);
  const out = await a.line;
  await stop(a.child);
  assert.match(out, /^\{"port":\d+\}\n$/, 'the port only');
  assert.ok(!/#t=|[0-9a-f]{64}/.test(out), 'no link and no key on stdout');
  // fd 3 a file: not a pipe, so no link is written to it
  const file = join(p.root, 'fd3.txt');
  const fd = openSync(file, 'w');
  const b = start(['ignore', 'pipe', 'ignore', fd]);
  assert.match(await b.line, /^\{"port":\d+\}\n$/);
  await stop(b.child);
  closeSync(fd);
  assert.equal(readFileSync(file, 'utf8'), '', 'nothing written to a file on fd 3');
  // nunchi open's own launcher: the link comes over its pipe and is a working one-time link
  const stateDir = join(p.nunchi, 'state');
  const r = await openBoard({ projectDir: p.root, stateDir, browser: false, linkToTerminal: true, idleMs: 20000 });
  try {
    assert.match(r.link, new RegExp(`^http://127\\.0\\.0\\.1:${r.port}/#t=[0-9a-f]{64}$`));
    const s = await raw(r.port, { method: 'POST', path: '/api/session', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${r.port}` }, body: JSON.stringify({ code: r.link.split('#t=')[1] }) });
    assert.equal(s.status, 200);
    const again = await openBoard({ projectDir: p.root, stateDir, browser: false, linkToTerminal: true });
    assert.deepEqual([again.reused, again.link], [true, undefined], 'a running board never hands a link to a second caller');
  } finally { await stopBoards(stateDir, p.root); }
});

test('§3.1 nunchi open twice at once starts one board (a launch lock); a running board keeps its port and says --port is ignored', { timeout: 60000 }, async () => {
  const p = smallProject();
  const stateDir = join(p.nunchi, 'state');
  try {
    const [a, b] = await Promise.all([openBoard({ projectDir: p.root, stateDir, browser: false, idleMs: 20000 }), openBoard({ projectDir: p.root, stateDir, browser: false, idleMs: 20000 })]);
    assert.equal(a.port, b.port, 'the same board');
    assert.deepEqual([a.reused, b.reused].sort(), [false, true]);
    assert.equal(readdirSync(join(stateDir, 'boards')).filter(n => n.endsWith('.json')).length, 1, 'one board record');
    const c = await openBoard({ projectDir: p.root, stateDir, browser: false, port: a.port === 47999 ? 47998 : 47999 });
    assert.equal(c.port, a.port);
    assert.equal(c.portIgnored, a.port === 47999 ? 47998 : 47999, 'said, not silently dropped');
    const cli = await new Promise(res => execFile('node', [CLI, 'open', '--no-browser', '--port', String(c.portIgnored)], { cwd: p.root, encoding: 'utf8', timeout: 30000 }, (err, stdout) => res(stdout)));
    assert.match(cli, new RegExp(`--port ${c.portIgnored} is ignored: the running board keeps port ${a.port}`));
    assert.ok(!readdirSync(join(stateDir, 'boards')).some(n => n.startsWith('launch.lock.d')), 'the lock is given back');
  } finally { await stopBoards(stateDir, p.root); }
});

test('§3.1 nunchi open compares projects by the file system\'s own real path (macOS case, Windows long names)', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const p = smallProject();
  const link = join(tmp('nunchi-link-'), `${p.root.split(/[\\/]/).pop()}-link`);
  symlinkSync(p.root, link);
  assert.equal(real(link), realpathSync.native(p.root));
  assert.equal(real(join(p.root, 'not-there')), join(p.root, 'not-there'), 'a path that does not exist is itself');
  // the native call (a JS realpath keeps the case it was given, so on macOS one project typed two ways was two)
  assert.match(readFileSync(fileURLToPath(new URL('../src/board/launch.mjs', import.meta.url)), 'utf8'), /export const real = p => \{ try \{ return realpathSync\.native\(p\);/);
});

test('§3.1 the browser opener: only a board link with a launch code, by an absolute path from a fixed list (never PATH, $BROWSER or ComSpec)', () => {
  const url = `http://127.0.0.1:4321/#t=${'a'.repeat(64)}`;
  const only = (...ok) => ({ exists: p => ok.includes(p), env: { ComSpec: 'C:\\evil\\cmd.exe', SystemRoot: 'C:\\Windows', BROWSER: '/tmp/evil', PATH: '/tmp/evil' } });
  assert.deepEqual(openerCommand(url, 'linux', only('/usr/bin/xdg-open')), { cmd: '/usr/bin/xdg-open', args: [url] });
  assert.deepEqual(openerCommand(url, 'linux', only('/usr/local/bin/xdg-open')), { cmd: '/usr/local/bin/xdg-open', args: [url] });
  assert.equal(openerCommand(url, 'linux', only('/tmp/evil/xdg-open')), null, 'not on the list: no opener');
  assert.deepEqual(openerCommand(url, 'darwin', only('/usr/bin/open')), { cmd: '/usr/bin/open', args: [url] });
  const win = openerCommand(url, 'win32', only('C:\\Windows\\System32\\cmd.exe'));
  assert.equal(win.cmd, 'C:\\Windows\\System32\\cmd.exe', 'never ComSpec');
  assert.equal(win.args.at(-1), `start "" "${url}"`);
  for (const bad of ['http://evil.example/#t=' + 'a'.repeat(64), `http://127.0.0.1:4321/#t=${'a'.repeat(64)}&x`, 'file:///etc/passwd', `http://127.0.0.1:4321/x`]) assert.throws(() => openerCommand(bad, 'linux'));
});

test('§3.1 the opener and the detached server get an allow-listed environment: no BROWSER, PATH of the caller, LD_*, DYLD_* or NODE_*', { timeout: 60000 }, async () => {
  const hostile = { PATH: '/tmp/evil:/usr/bin', BROWSER: '/tmp/evil/browser', LD_PRELOAD: '/tmp/evil.so', LD_LIBRARY_PATH: '/tmp/evil', DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    NODE_OPTIONS: '--require /tmp/evil.js', NODE_PATH: '/tmp/evil', HOME: '/tmp/evil-home', DISPLAY: ':7', WAYLAND_DISPLAY: 'wayland-1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', XDG_RUNTIME_DIR: '/run/user/1', GIT_DIR: '/tmp/evil' };
  const lx = openerEnv('linux', hostile);
  assert.deepEqual(Object.keys(lx).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'PATH', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']);
  assert.ok(!lx.PATH.includes('/tmp/evil') && lx.HOME !== '/tmp/evil-home', 'a fixed PATH; HOME from the account, not the variable');
  const mac = openerEnv('darwin', hostile);
  assert.ok(!('BROWSER' in mac) && !('DYLD_INSERT_LIBRARIES' in mac) && mac.PATH === '/usr/bin:/bin:/usr/sbin:/sbin');
  const w = openerEnv('win32', { ...hostile, SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a', ComSpec: 'C:\\evil.exe' });
  assert.deepEqual(Object.keys(w).sort(), ['PATH', 'SystemRoot', 'USERPROFILE', 'windir']);
  const s = serverEnv({ ...hostile, LANG: 'C.UTF-8', XDG_STATE_HOME: '/x/state' });
  for (const k of ['BROWSER', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_PATH', 'GIT_DIR']) assert.ok(!(k in s), k);
  for (const k of ['PATH', 'HOME', 'LANG', 'XDG_STATE_HOME']) assert.ok(k in s, `${k} is kept (git and the answer keys need it)`);
  // on every OS: the server's working folder is outside the project and its state (in .git or .nunchi)
  {
    const q = smallProject();
    const rel = relative(realpathSync(q.root), realpathSync(serverCwd()));
    assert.ok(rel.startsWith('..') || isAbsolute(rel), `the server runs outside the project (${rel})`);
    assert.equal(realpathSync(serverCwd()), realpathSync(tmpdir()));
  }
  // the detached process itself, through nunchi open's launcher
  if (process.platform !== 'linux') return;
  const p = smallProject();
  const stateDir = join(p.nunchi, 'state');
  const saved = { BROWSER: process.env.BROWSER, NODE_PATH: process.env.NODE_PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH };
  Object.assign(process.env, { BROWSER: '/tmp/evil/browser', NODE_PATH: '/tmp/evil', LD_LIBRARY_PATH: '/tmp/evil-lib' });
  let r;
  try { r = await openBoard({ projectDir: p.root, stateDir, browser: false, idleMs: 20000 }); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  try {
    const rec = JSON.parse(readFileSync(join(stateDir, 'boards', readdirSync(join(stateDir, 'boards')).find(n => n.endsWith('.json'))), 'utf8'));
    const env = readFileSync(`/proc/${rec.pid}/environ`, 'utf8').split('\0').map(x => x.split('=')[0]);
    for (const k of ['BROWSER', 'NODE_PATH', 'LD_LIBRARY_PATH']) assert.ok(!env.includes(k), `the server has no ${k}`);
    assert.ok(env.includes('PATH'));
    // its working folder is the temp folder, not the project or its state (on Windows a process inside a folder keeps
    // it from being removed or renamed)
    assert.equal(realpathSync(readlinkSync(`/proc/${rec.pid}/cwd`)), realpathSync(serverCwd()));
  } finally { await stopBoards(stateDir, p.root); }
});
