// Safety fixes of M1a (design 0.1-c §0, D7 and D9–D12, plus the atomic recording save of D6). Each test
// failed on main 3e29b26. The capture tests need Chromium (skipped without one, unless NUNCHI_REQUIRE_BROWSER).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { capture, launch } from '../src/capture.mjs';
import * as runs from '../src/runs.mjs';
import * as network from '../src/network.mjs';
import { writeStable } from '../src/stable.mjs';

// namespace imports: on main the new functions are missing, and each test fails on its own
const { startRun, finishRun, workTree } = runs;
const { Recording } = network;
const baseUrlProblem = (...a) => network.baseUrlProblem(...a);
const readConfig = (...a) => runs.readConfig(...a);
const FIX = fileURLToPath(new URL('./fixtures/safety', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), `nunchi-${p}-`)));
const files = dir => readdirSync(dir, { recursive: true }).sort();
const mode = p => statSync(p).mode & 0o777;

let server, base, browserOk = true;
const hits = [];
before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/api/')) {
      hits.push(`${req.method} ${path}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(path === '/api/list' ? { items: ['Water the fern', 'Return the library book'] } : { ok: true }));
    }
    const file = join(FIX, path);
    if (!file.startsWith(FIX) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => server && server.close());

// ---- D7: no input values in evidence -----------------------------------------------------------------

test('D7: form fields are recorded by presence, type and label; what they hold never reaches the evidence', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('fields');
  await capture({ baseUrl: base, scenes: [{ route: '/fields.html', path: '/fields.html' }], viewports: ['d'], out });
  const scene = join(out, 'fields.html.guest.normal.d');
  const fields = JSON.parse(readFileSync(join(scene, 'controls.json'), 'utf8')).filter(c => ['input', 'textarea', 'select'].includes(c.tag));
  assert.deepEqual(fields.map(c => [c.tag, c.type, c.name, c.label, c.text, c.hasText]), [
    ['input', 'text', '', 'Sync key', '', false],
    ['input', 'text', 'Display name', '', '', false],
    ['textarea', 'textarea', '', 'Notes', '', false],
    ['input', 'password', 'Password', '', '', false],
    ['input', 'search', 'Find a task', '', '', false],
    ['input', 'email', 'Contact email', '', '', false],
    ['input', 'number', 'Reminder minutes', '', '', false],
    ['select', 'select-one', '', 'Plan', '', false],
    ['input', 'submit', 'Save', '', '', false],
  ], 'a submit button\'s value is its label, written by the app');
  const values = ['VAL-attr-Kq81', 'VAL-script-Zt42', 'VAL-area-Lm07', 'VAL-pass-Rx55', 'VAL-search-Pp19', 'VAL-mail-Wd63', '48213579'];
  const leaks = files(out).filter(f => !f.endsWith('.jpg') && statSync(join(out, f)).isFile())
    .flatMap(f => values.filter(v => readFileSync(join(out, f), 'utf8').includes(v)).map(v => `${f}: ${v}`));
  assert.deepEqual(leaks, []);
  const aria = readFileSync(join(scene, 'aria.yml'), 'utf8');
  for (const node of ['textbox "Sync key"', 'textbox "Display name"', 'textbox "Notes"', 'textbox "Password"', 'searchbox "Find a task"', 'textbox "Contact email"', 'spinbutton "Reminder minutes"']) {
    assert.ok(aria.split('\n').some(l => l.trim() === `- ${node}` || l.trim() === `- ${node}:`), `${node} stays addressable in aria.yml:\n${aria}`);
  }
  assert.match(aria, /\/placeholder: you@pebble\.test/, 'a placeholder is the app\'s text and stays');
});

// ---- D9: git runs no program the repository configures -------------------------------------------------

test('D9: workTree runs none of the programs a repository can configure (external diff, textconv, filters, fsmonitor, hooks)', () => {
  const marks = tmp('git-marks');
  const mark = join(marks, 'mark.cjs').replace(/\\/g, '/');
  // records that it ran; as a filter it passes the content through
  writeFileSync(mark, "require('fs').appendFileSync(require('path').join(__dirname, 'ran.txt'), process.argv[2] + '\\n'); if (process.argv[2] === 'clean') process.stdin.pipe(process.stdout);\n");
  const cmd = tag => `node "${mark}" ${tag}`;
  const hooks = join(marks, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-index-change'), `#!/bin/sh\n${cmd('hook')}\n`, { mode: 0o755 });
  const configs = {
    external: [['diff.external', cmd('external')]],
    textconv: [['diff.evil.textconv', cmd('textconv')]],
    'diff driver': [['diff.evil.command', cmd('driver')]],
    filter: [['filter.evil.clean', cmd('clean')], ['filter.evil.required', 'true']],
    fsmonitor: [['core.fsmonitor', cmd('fsmonitor')]],
    hook: [['core.hooksPath', hooks.replace(/\\/g, '/')]],
  };
  for (const [what, config] of Object.entries(configs)) {
    const root = tmp('git');
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(root, '.gitattributes'), '*.txt diff=evil filter=evil\n');
    writeFileSync(join(root, 'page.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'one');
    const clean = workTree(root);
    for (const [k, v] of config) git('config', k, v);
    writeFileSync(join(root, 'page.txt'), 'two\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const edited = workTree(root);
    const ran = existsSync(join(marks, 'ran.txt')) ? readFileSync(join(marks, 'ran.txt'), 'utf8').trim() : '';
    assert.equal(ran, '', `${what}: git ran a program from the repository's config`);
    assert.equal(edited.repo, true, what);
    assert.equal(edited.dirty, true, `${what}: the edit is still seen`);
    assert.notEqual(edited.tree, clean.tree, what);
  }
});

// ---- D10: base-URL guard ---------------------------------------------------------------------------------

test('D10: only a server the user runs is captured: loopback, private, *.local, or a host they listed', () => {
  for (const ok of ['http://localhost:3000', 'http://127.0.0.1:5173/app', 'http://[::1]:3000', 'http://0.0.0.0:3000', 'http://app.localhost:3000',
    'http://10.1.2.3', 'http://172.16.0.9:8080', 'http://172.31.255.1', 'http://192.168.0.12:3000', 'http://169.254.1.1', 'http://[fd12:3456::1]:3000',
    'http://[fe80::1]', 'http://[::ffff:127.0.0.1]', 'http://pebble.local:3000', 'http://2130706433/']) assert.equal(baseUrlProblem(ok), null, ok);
  for (const no of ['https://pebbletasks.com', 'https://pebble-git-main.vercel.app', 'http://172.32.0.1', 'http://11.0.0.1', 'http://8.8.8.8',
    'http://localhost.evil.example', 'http://127.0.0.1.nip.io', 'http://10.0.0.1.example.com', 'http://[2001:db8::1]', 'http://local']) assert.match(baseUrlProblem(no), /not a local or private address/, no);
  assert.match(baseUrlProblem('file:///etc/passwd'), /http/);
  assert.match(baseUrlProblem('not a url'), /not a URL/);
  assert.equal(baseUrlProblem('https://pebble-git-main.vercel.app/x', ['pebble-git-main.vercel.app']), null, 'listed by the user');
  assert.equal(baseUrlProblem('https://PEBBLE-git-main.vercel.app.', ['https://pebble-git-main.vercel.app:443']), null, 'case, a trailing dot, a scheme or port in the list');
  assert.match(baseUrlProblem('https://pebbletasks.com', ['staging.pebbletasks.com']), /not a local/, 'exact hosts only');
});

test('D10: capture refuses a production-looking URL before a browser starts, and the CLI leaves no run behind', async () => {
  await assert.rejects(capture({ baseUrl: 'https://pebbletasks.com', scenes: [{ route: '/', path: '/' }], out: tmp('prod'), browserPath: join(tmpdir(), 'no-such-browser') }), e => e.code === 'URL_NOT_ALLOWED');
  const cwd = tmp('prod-cli');
  const run = args => promisify(execFile)('node', [CLI, 'capture', ...args, '--routes', '/', '--viewports', 'm', '--states', 'normal', '--network', 'live', '--browser-path', join(tmpdir(), 'no-such-browser')], { cwd, encoding: 'utf8' }).then(() => ({ code: 0, stderr: '' }), e => ({ code: e.code, stderr: e.stderr }));
  const refused = await run(['--url', 'https://pebbletasks.com']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /refusing https:\/\/pebbletasks\.com/);
  assert.match(refused.stderr, /\.nunchi\/config\.json/);
  assert.ok(!existsSync(join(cwd, '.nunchi', 'runs')) || readdirSync(join(cwd, '.nunchi', 'runs')).length === 0, 'no run folder for a refused capture');
  mkdirSync(join(cwd, '.nunchi'), { recursive: true });
  writeFileSync(join(cwd, '.nunchi', 'config.json'), JSON.stringify({ allowHosts: ['pebbletasks.com'] }));
  const allowed = await run(['--url', 'https://pebbletasks.com']);
  assert.doesNotMatch(allowed.stderr, /refusing/, 'listed by the user: the guard lets it through (and the missing browser stops it)');
  assert.match(allowed.stderr, /could not start Chromium/);
  writeFileSync(join(cwd, '.nunchi', 'config.json'), '{"allowHosts": "pebbletasks.com"}');
  const bad = await run(['--url', 'http://localhost:3000']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /config\.json.*allowHosts/);
  assert.throws(() => readConfig(join(cwd, '.nunchi')), e => e.code === 'BAD_CONFIG');
});

// ---- D11: strict replay ------------------------------------------------------------------------------------

test('D11: in replay, a request the recording does not have is never sent: not a read, not a write', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('strict-har');
  await capture({ baseUrl: base, scenes: [{ route: '/list.html', path: '/list.html' }], viewports: ['m'], out: tmp('strict-rec'), network: 'record', recordingDir: har });
  assert.deepEqual(hits.splice(0), ['GET /api/list'], 'recording asks the server once');
  const out = tmp('strict-replay');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/list.html', path: '/list.html?writes' }], viewports: ['m'], out, network: 'replay', recordingDir: har });
  assert.deepEqual(hits.splice(0), [], 'nothing reached the server: the recorded read was replayed, the rest was stopped');
  const id = 'list.html.guest.normal.m';
  const net = JSON.parse(readFileSync(join(out, id, 'network.json'), 'utf8'));
  assert.deepEqual(net.replayMisses.map(k => k.replace(/ #\w+$/, '')), ['DELETE app:/api/remove', 'GET app:/api/unrecorded', 'POST app:/api/beacon', 'POST app:/api/save']);
  assert.equal(r.manifest.scenes[0].replayMisses, 4);
  const text = readFileSync(join(out, id, 'text.txt'), 'utf8');
  assert.match(text, /Water the fern/, 'the recorded read is replayed');
  assert.match(text, /more: failed/, 'the unrecorded read failed in the page instead of going live');
});

// ---- D12: owner-only files, whatever the umask -------------------------------------------------------------

test('D12: run folders, evidence and recordings are owner-only (0700 / 0600), whatever the umask', { skip: !POSIX && 'POSIX file modes' }, async t => {
  const old = process.umask(0);
  try {
    const dir = tmp('modes');
    writeStable(join(dir, 'a', 'b', 'x.json'), { x: 1 });
    assert.deepEqual([mode(join(dir, 'a')), mode(join(dir, 'a', 'b')), mode(join(dir, 'a', 'b', 'x.json'))], [0o700, 0o700, 0o600]);
    writeFileSync(join(dir, 'old.json'), '{}', { mode: 0o644 });
    writeStable(join(dir, 'old.json'), { y: 1 });
    assert.equal(mode(join(dir, 'old.json')), 0o600, 'a file written before is tightened when rewritten');
    const runsDir = join(dir, 'runs');
    const r = startRun(runsDir);
    assert.deepEqual([mode(runsDir), mode(r.path)], [0o700, 0o700]);
    finishRun(runsDir, r.id);
    assert.deepEqual([mode(join(runsDir, r.id)), mode(join(runsDir, 'latest'))], [0o700, 0o600]);
    const rec = new Recording({ 'GET app:/api/x': [{ status: 200, contentType: 'application/json', body: '{}' }] });
    rec.save(join(dir, 'har', 'guest.json'));
    assert.deepEqual([mode(join(dir, 'har')), mode(join(dir, 'har', 'guest.json'))], [0o700, 0o600]);
    // a .nunchi folder an older version wrote with the default umask
    const nunchi = join(dir, '.nunchi');
    mkdirSync(join(nunchi, 'evidence'), { recursive: true, mode: 0o755 });
    writeFileSync(join(nunchi, 'auth.json'), '{}', { mode: 0o644 });
    runs.ensurePrivate(nunchi);
    assert.deepEqual(['auth.json', 'evidence', 'har', 'runs', 'state'].map(p => mode(join(nunchi, p))), [0o600, 0o700, 0o700, 0o700, 0o700],
      'the ledger state folder exists, private, before its first write');
    if (!browserOk) return t.diagnostic('no Chromium: the capture part is skipped');
    const out = tmp('modes-cap');
    await capture({ baseUrl: base, scenes: [{ route: '/list.html', path: '/list.html' }], viewports: ['m'], out, network: 'record', recordingDir: join(out, 'har') });
    const loose = files(out).filter(f => mode(join(out, f)) !== (statSync(join(out, f)).isDirectory() ? 0o700 : 0o600));
    assert.deepEqual(loose, [], 'every evidence file and folder, screenshots and the recording included');
  } finally { process.umask(old); }
});

// ---- D6 (recordings): replaced, never rewritten in place ---------------------------------------------------

test('a recording is replaced in one step: a reader never sees half of it, and a torn file is a clear error', () => {
  const dir = tmp('har-atomic');
  const path = join(dir, 'guest.json');
  new Recording({ 'GET app:/a': [{ status: 200, contentType: 'application/json', body: '{"n":1}' }] }).save(path);
  const before = readFileSync(path, 'utf8');
  linkSync(path, join(dir, 'reader.json'));                 // what a capture that opened the old file still reads
  new Recording({ 'GET app:/a': [{ status: 200, contentType: 'application/json', body: '{"n":2}' }] }).save(path);
  assert.equal(readFileSync(join(dir, 'reader.json'), 'utf8'), before, 'the old file was not rewritten under the reader');
  assert.equal(JSON.parse(Recording.load(path).entries['GET app:/a'][0].body).n, 2);
  assert.deepEqual(readdirSync(dir).sort(), ['guest.json', 'reader.json'], 'no temporary file left');
  writeFileSync(path, before.slice(0, 40));
  assert.throws(() => Recording.load(path), e => e.code === 'BAD_RECORDING' && /--network record/.test(e.message));
});
