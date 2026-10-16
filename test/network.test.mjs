import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isDataRequest, isBackendHost, emptyJson, redactJson, forceResponse, requestKey, Recording, redactUrl, redactText, loginElsewhere } from '../src/network.mjs';
import { pacScript } from '../src/capture.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp } from './fixtures/tmp.mjs';

test('normalizeUrl: sorted params, cache-busters dropped, epoch values masked', () => {
  assert.equal(normalizeUrl('http://localhost:3000/api/tasks?_=1760000000000&b=2&a=1'), 'http://localhost:3000/api/tasks?a=1&b=2');
  assert.equal(normalizeUrl('https://x.supabase.co/rest/v1/tasks?select=*&since=1760000000'), 'https://x.supabase.co/rest/v1/tasks?select=*&since=%3Cepoch%3E');
  assert.equal(normalizeUrl('http://localhost/api/tasks?id=42'), 'http://localhost/api/tasks?id=42');
  assert.equal(requestKey('GET', 'http://a/x?t=1&q=1'), requestKey('GET', 'http://a/x?q=1&t=9'));
  assert.notEqual(requestKey('POST', 'http://a/rpc', '{"a":1}'), requestKey('POST', 'http://a/rpc', '{"a":2}'));
  assert.equal(requestKey('GET', 'http://localhost:3000/api/x?b=1', null, 'http://localhost:3000'), 'GET app:/api/x?b=1');
  assert.equal(requestKey('GET', 'https://p.supabase.co/rest/v1/t', null, 'http://localhost:3000'), 'GET https://p.supabase.co/rest/v1/t');
});

test('isDataRequest: fetch/XHR yes; documents, scripts and RSC payloads no', () => {
  assert.equal(isDataRequest({ resourceType: 'fetch', headers: {} }), true);
  assert.equal(isDataRequest({ resourceType: 'xhr', headers: {} }), true);
  assert.equal(isDataRequest({ resourceType: 'document', headers: {} }), false);
  assert.equal(isDataRequest({ resourceType: 'script', headers: {} }), false);
  assert.equal(isDataRequest({ resourceType: 'fetch', headers: { RSC: '1' } }), false);
  assert.equal(isDataRequest({ resourceType: 'fetch', headers: { accept: 'text/x-component' } }), false);
});

test('isBackendHost: known BaaS hosts and explicit extras; analytics are not backends', () => {
  assert.equal(isBackendHost('abcd.supabase.co'), true);
  assert.equal(isBackendHost('firestore.googleapis.com'), true);
  assert.equal(isBackendHost('api.myapp.dev', ['api.myapp.dev']), true);
  assert.equal(isBackendHost('www.google-analytics.com'), false);
  assert.equal(isBackendHost('supabase.co.evil.com'), false);
});

test('emptyJson: lists emptied, counts zeroed, envelopes kept', () => {
  assert.deepEqual(emptyJson([{ a: 1 }]), []);
  assert.deepEqual(emptyJson({ data: [1, 2], count: 2, page: 1, meta: { items: [1], total: 1 } }), { data: [], count: 0, page: 1, meta: { items: [], total: 0 } });
  assert.deepEqual(emptyJson({ user: { name: 'Mina' } }), { user: { name: 'Mina' } });
});

test('redactJson: token fields replaced at any depth', () => {
  assert.deepEqual(redactJson({ access_token: 'eyJ…', user: { id: 1, refresh_token: 'r' }, list: [{ api_key: 'k' }] }),
    { access_token: '[redacted]', user: { id: 1, refresh_token: '[redacted]' }, list: [{ api_key: '[redacted]' }] });
  // review of PR #33: token, jwt, authorization, session and any *_token; an object under such a key is walked, and a
  // key that only contains the word is kept
  assert.deepEqual(redactJson({ token: 't', jwt: 'j', Authorization: 'Bearer x', session: 's', csrf_token: 'c', upload_Token: 'u', session_info: { session: 'z', expires: 3 }, tokens: 2, tokenizer: 'wordpiece', session2: 'kept' }),
    { token: '[redacted]', jwt: '[redacted]', Authorization: '[redacted]', session: '[redacted]', csrf_token: '[redacted]', upload_Token: '[redacted]', session_info: { session: '[redacted]', expires: 3 }, tokens: 2, tokenizer: 'wordpiece', session2: 'kept' });
  assert.deepEqual(redactJson({ session: { user: 'mina', access_token: 'a' } }), { session: { user: 'mina', access_token: '[redacted]' } });
});

test('forceResponse: error is a 500 with a server message; empty rewrites JSON only', () => {
  const e = forceResponse('error');
  assert.equal(e.status, 500);
  assert.match(e.body, /Internal Server Error/);
  assert.deepEqual(JSON.parse(forceResponse('empty', { status: 200, contentType: 'application/json', body: '{"items":[1],"total":1}' }).body), { items: [], total: 0 });
  assert.equal(forceResponse('empty', { status: 200, contentType: 'text/html', body: '<p>x</p>' }), null);
});

test('Recording: ordinal per page load, first load wins, tokens redacted, replay restarts each load', () => {
  const rec = new Recording();
  const load1 = rec.loader();
  load1.add('GET /a', { status: 200, contentType: 'application/json', body: '{"n":1,"access_token":"secret"}' });
  load1.add('GET /a', { status: 200, contentType: 'application/json', body: '{"n":2}' });
  rec.loader().add('GET /a', { status: 200, contentType: 'application/json', body: '{"n":99}' }); // a later load does not overwrite
  assert.deepEqual(rec.entries['GET /a'].map(e => JSON.parse(e.body).n), [1, 2]);
  assert.equal(JSON.parse(rec.entries['GET /a'][0].body).access_token, '[redacted]');
  const replay = rec.loader();
  assert.equal(JSON.parse(replay.take('GET /a').body).n, 1);
  assert.equal(JSON.parse(replay.take('GET /a').body).n, 2);
  assert.equal(JSON.parse(replay.take('GET /a').body).n, 2, 'beyond the recorded count, the last response repeats');
  assert.equal(JSON.parse(rec.loader().take('GET /a').body).n, 1, 'a new page load starts again at the first response');
  assert.equal(replay.take('GET /missing'), null);
});

const route = (script, url) => new Function(`${script}; return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(new URL(url).hostname)});`)();
test('PAC: backends and --allow-host are reachable; look-alike hosts are not', () => {
  const pac = pacScript({ appHost: 'localhost', proxyServer: null, allowHosts: ['api.myapp.dev'] });
  assert.equal(route(pac, 'https://abcd.supabase.co/rest/v1/tasks'), 'DIRECT');
  assert.equal(route(pac, 'https://firestore.googleapis.com/v1/x'), 'DIRECT');
  assert.equal(route(pac, 'https://api.myapp.dev/tasks'), 'DIRECT');
  assert.equal(route(pac, 'https://supabase.co.evil.com/'), 'PROXY 127.0.0.1:9');
  assert.equal(route(pac, 'https://www.googletagmanager.com/gtm.js'), 'PROXY 127.0.0.1:9');
});

test('login warns on production-looking hosts, not on local or preview ones', async () => {
  const { loginWarnings } = await import('../src/login.mjs');
  assert.equal(loginWarnings('https://pebbletasks.com/login').length, 1);
  for (const u of ['http://localhost:3000/login', 'http://127.0.0.1:5173', 'https://pebble-git-main.vercel.app', 'https://staging.pebbletasks.com']) assert.deepEqual(loginWarnings(u), [], u);
});

test('redactUrl: credential values in query and fragment are replaced, the rest is untouched', () => {
  assert.equal(redactUrl('/auth/confirm?token=abc&next=/app'), '/auth/confirm?token=REDACTED&next=%2Fapp');
  assert.equal(redactUrl('/cb#access_token=eyJ&token_type=bearer'), '/cb#access_token=REDACTED&token_type=bearer');
  assert.equal(redactUrl('https://cdn.x/a.png?X-Amz-Signature=s1&w=200'), 'https://cdn.x/a.png?X-Amz-Signature=REDACTED&w=200');
  assert.equal(redactUrl('../rel?code=9'), '../rel?code=REDACTED');
  for (const keep of ['/plain', '/a?q=1&z=a%20b', '#top', '/p?page=2#section']) assert.equal(redactUrl(keep), keep);
  assert.equal(redactUrl(null), null);
});

test('redactText: URLs quoted in messages lose their credentials', () => {
  assert.equal(redactText('GET /api/x?apikey=K1&q=2 failed'), 'GET /api/x?apikey=REDACTED&q=2 failed');
  assert.equal(redactText('no urls here: a=b'), 'no urls here: a=b');
});

test('request keys: credentials hashed, so distinct tokens stay distinct requests without being stored', () => {
  const a = requestKey('GET', 'http://a/x?token=one'), b = requestKey('GET', 'http://a/x?token=two');
  assert.notEqual(a, b);
  assert.ok(!a.includes('one') && !b.includes('two'), a + ' ' + b);
  assert.equal(a, requestKey('GET', 'http://a/x?token=one'));
});

test('loginElsewhere: a saved login names the hosts it is for when none is the capture host (localhost and 127.0.0.1 are two); host names only', () => {
  const cookie = (domain, value = 'invented-session-value') => ({ name: 'app_session', value, domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' });
  // signed in at 127.0.0.1, captured at localhost: the cookie is never sent
  assert.deepEqual(loginElsewhere({ cookies: [cookie('127.0.0.1')], origins: [] }, 'http://localhost:3000'), ['127.0.0.1']);
  assert.deepEqual(loginElsewhere({ cookies: [cookie('localhost')], origins: [] }, 'http://127.0.0.1:3000/'), ['localhost']);
  // the same host (any port), a parent domain of it (a cookie set for .example.test), or local storage of that host: it applies
  assert.equal(loginElsewhere({ cookies: [cookie('127.0.0.1')], origins: [] }, 'http://127.0.0.1:4100'), null);
  assert.equal(loginElsewhere({ cookies: [cookie('.preview.example.test')], origins: [] }, 'https://app.preview.example.test'), null);
  assert.equal(loginElsewhere({ cookies: [], origins: [{ origin: 'http://localhost:5173', localStorage: [{ name: 'sb-token', value: 'x' }] }] }, 'http://localhost:5173'), null);
  assert.deepEqual(loginElsewhere({ cookies: [cookie('auth.example.test')], origins: [{ origin: 'http://localhost:5173', localStorage: [] }] }, 'http://127.0.0.1:5173'), ['auth.example.test', 'localhost']);
  // a login with nothing in it, or not a storage state at all: nothing to say
  for (const st of [{ cookies: [], origins: [] }, {}, null, 'text']) assert.equal(loginElsewhere(st, 'http://localhost:3000'), null);
  const out = JSON.stringify(loginElsewhere({ cookies: [cookie('127.0.0.1', 'sekrit-cookie-value')], origins: [] }, 'http://localhost:3000'));
  assert.ok(!out.includes('sekrit'), 'never a cookie value');
});

test('capture says, before it starts, that the saved login is for another host than --url (no browser: --plan)', () => {
  const dir = tmp('nunchi-login-host-');
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cookies: [{ name: 'app_session', value: 'invented-session-value', domain: '127.0.0.1', path: '/' }], origins: [] }));
  const cli = url => spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'capture', '--plan', '--routes', '/', '--url', url, '--auth', 'auth.json'], { cwd: dir, encoding: 'utf8' });
  const other = cli('http://localhost:3999');
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stderr, /^warning: the saved login is for 127\.0\.0\.1, not localhost \(a login works only at the address it was saved at\): capture at that address, or run `nunchi login --url http:\/\/localhost:3999` to sign in here$/m);
  assert.ok(!other.stderr.includes('invented-session-value'), 'never the cookie');
  const same = cli('http://127.0.0.1:3999');
  assert.equal(same.status, 0, same.stderr);
  assert.doesNotMatch(same.stderr, /saved login is for/);
});
