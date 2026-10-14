// Safety fixes of M1a (design 0.1-c §0, D7 and D9–D12, plus the atomic recording save of D6). Each test
// failed on main 3e29b26. The capture tests need Chromium (skipped without one, unless NUNCHI_REQUIRE_BROWSER).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { capture, launch } from '../src/capture.mjs';
import * as runs from '../src/runs.mjs';
import * as network from '../src/network.mjs';
import { writeStable } from '../src/stable.mjs';
import { writeHuntMirror } from '../src/hunt.mjs';

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

// Secret-shaped values are made here, at test time, so none is ever committed.
const STRIPE = 'sk_' + 'live_' + 'Wq3Er5Ty7Ui9Op1As3Df5Gh';
const AWS = 'AKIA' + 'QZ7XK2MB4NC6VD8W';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const SESSION_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user-7', role: 'authenticated' })}.${'q'.repeat(30)}`;
const SECRET_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pebble Tasks — keys</title></head><body><main>
<h1>API keys</h1><input placeholder="${STRIPE}"><p>Your access key: ${AWS}</p><pre>session ${SESSION_JWT}</pre></main></body></html>`;

let server, base, other, otherServer, browserOk = true;
const hits = [], pages = [];
before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith('/api/')) {
      hits.push(`${req.method} ${path}`);
      if (path === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('data: hello\n\n'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(path === '/api/list' ? { items: ['Water the fern', 'Return the library book'] } : { ok: true }));
    }
    if (path === '/landing.html') pages.push(path);               // proof that a frame unloaded during the scene
    if (path === '/away') { res.writeHead(302, { location: `${other}/landed` }); return res.end(); }
    if (path === '/secret.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(SECRET_PAGE); }
    const file = join(FIX, path);
    if (!file.startsWith(FIX) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(readFileSync(file));
  });
  server.on('upgrade', (req, socket) => { hits.push(`WS ${new URL(req.url, 'http://x').pathname}`); socket.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // another local server: a redirect there leaves the app under test
  otherServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<main><h1>OTHER ORIGIN</h1></main>'); });
  await new Promise(r => otherServer.listen(0, '127.0.0.1', r));
  other = `http://localhost:${otherServer.address().port}`;
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => { server && server.close(); otherServer && otherServer.close(); });
const evidenceText = out => files(out).filter(f => !f.endsWith('.jpg') && statSync(join(out, f)).isFile()).map(f => [f, readFileSync(join(out, f), 'utf8')]);

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
  const values = ['VAL-attr-Kq81', 'VAL-script-Zt42', 'VAL-area-Lm07', 'VAL-pass-Rx55', 'VAL-search-Pp19', 'VAL-mail-Wd63', '48213579',
    'VAL-edit-Hy27', 'VAL-role-Qa58', 'VAL-para-Mn31'];
  const leaks = evidenceText(out).flatMap(([f, text]) => values.filter(v => text.includes(v)).map(v => `${f}: ${v}`));
  assert.deepEqual(leaks, [], 'neither field values nor what an editor holds (contenteditable, role=textbox)');
  const aria = readFileSync(join(scene, 'aria.yml'), 'utf8');
  for (const node of ['textbox "Sync key"', 'textbox "Display name"', 'textbox "Notes"', 'textbox "Password"', 'searchbox "Find a task"', 'textbox "Contact email"', 'spinbutton "Reminder minutes"', 'combobox "Plan"']) {
    assert.ok(aria.split('\n').some(l => l.trim() === `- ${node}` || l.trim() === `- ${node}:`), `${node} stays addressable in aria.yml:\n${aria}`);
  }
  assert.match(aria, /\/placeholder: you@pebble\.test/, 'a placeholder is the app\'s text and stays');
  assert.doesNotMatch(aria, /\[selected\]|option "Team"/, 'which option a select holds is its value');
});

// ---- secret-shaped strings in what the page shows ----------------------------------------------------------

test('a secret-shaped string on the page (placeholder, text, a token) is written as [secret-shaped: kind], never as itself', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('secret-page');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/secret.html', path: '/secret.html' }], viewports: ['d'], out });
  const leaks = evidenceText(out).flatMap(([f, text]) => [STRIPE, AWS, SESSION_JWT.split('.')[1], STRIPE.slice(8, 20)].filter(v => text.includes(v)).map(v => `${f}: ${v.slice(0, 12)}…`));
  assert.deepEqual(leaks, []);
  const scene = join(out, 'secret.html.guest.normal.d');
  assert.match(readFileSync(join(scene, 'aria.yml'), 'utf8'), /\[secret-shaped: stripe-live-secret-key\]/);
  assert.match(readFileSync(join(scene, 'text.txt'), 'utf8'), /Your access key: \[secret-shaped: aws-access-key-id\]/);
  assert.match(readFileSync(join(scene, 'text.txt'), 'utf8'), /session \[secret-shaped: jwt\]/);
  assert.deepEqual(r.findings.filter(f => f.rule === 'placeholder-as-label').map(f => f.evidence.placeholder), ['[secret-shaped: stripe-live-secret-key]'], 'the ledger gets the kind, not the key');
});

// ---- D9: git runs no program the repository configures -------------------------------------------------

test('D9: workTree and --changed-since run none of the programs a repository can configure (external diff, textconv, filters, fsmonitor, hooks)', async () => {
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
    // a filter name `-c` cannot express (the key itself holds '=')
    'filter named a=b': [['filter.a=b.clean', cmd('clean')], ['filter.a=b.required', 'true']],
    fsmonitor: [['core.fsmonitor', cmd('fsmonitor')]],
    hook: [['core.hooksPath', hooks.replace(/\\/g, '/')]],
  };
  for (const [what, config] of Object.entries(configs)) {
    const root = tmp('git');
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(root, '.gitattributes'), what === 'filter named a=b' ? '*.txt filter=a=b\n' : '*.txt diff=evil filter=evil\n');
    writeFileSync(join(root, 'page.txt'), 'one\n');
    git('add', '.'); git('commit', '-qm', 'one');
    const clean = workTree(root);
    for (const [k, v] of config) git('config', k, v);
    writeFileSync(join(root, 'page.txt'), 'two\n');
    writeFileSync(join(root, 'new.txt'), 'new\n');
    const edited = workTree(root);
    // --changed-since reads git the same way
    const plan = await promisify(execFile)('node', [CLI, 'capture', '--root', root, '--routes', '/', '--changed-since', 'HEAD', '--plan'], { cwd: root, encoding: 'utf8' });
    assert.match(plan.stdout, /changed since HEAD: 2 file\(s\)/, what);
    const ran = existsSync(join(marks, 'ran.txt')) ? readFileSync(join(marks, 'ran.txt'), 'utf8').trim() : '';
    assert.equal(ran, '', `${what}: git ran a program from the repository's config`);
    assert.equal(edited.repo, true, what);
    assert.equal(edited.dirty, true, `${what}: the edit is still seen`);
    assert.notEqual(edited.tree, clean.tree, what);
  }
});

test('D9: through nunchi\'s git, the repository\'s fsmonitor, hooks, external diff and pager read as switched off', () => {
  const root = tmp('git-config');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  for (const [k, v] of [['core.fsmonitor', 'mark fsmonitor'], ['core.hooksPath', 'my-hooks'], ['diff.external', 'mark ext'], ['core.pager', 'mark pager']]) git('config', k, v);
  const run = runs.gitRunner(root);
  const get = k => run(['config', '--get', k], { encoding: 'utf8' }).trim();
  assert.deepEqual(['core.fsmonitor', 'core.hooksPath', 'diff.external', 'core.pager'].map(get), ['false', runs.noHooksPath(), '', 'cat']);
  assert.equal(runs.noHooksPath('linux'), '/dev/null');
  // the Windows value, checked on any machine: an empty folder of nunchi's own, written with forward slashes
  const win = runs.noHooksPath('win32');
  assert.notEqual(win, '/dev/null');
  assert.ok(!win.includes('\\'), win);
  assert.deepEqual(readdirSync(win), []);
  assert.equal(runs.noHooksPath('win32'), win, 'one folder per process');
});

test('D9: the system config is read (signing, line endings are the person\'s), and cannot switch the programs back on', () => {
  const root = tmp('git-system');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q');
  const sys = join(tmp('git-system-file'), 'gitconfig');
  writeFileSync(sys, '[commit]\n\tgpgsign = true\n[core]\n\tautocrlf = input\n\thooksPath = evil-hooks\n\tfsmonitor = evil\n[filter "sys"]\n\tclean = evil\n');
  const saved = process.env.GIT_CONFIG_SYSTEM;
  try {
    process.env.GIT_CONFIG_SYSTEM = sys;
    const run = runs.gitRunner(root);
    const get = k => run(['config', '--get', k], { encoding: 'utf8' }).trim();
    assert.deepEqual([get('commit.gpgsign'), get('core.autocrlf')], ['true', 'input'], 'the system file\'s settings stand');
    assert.deepEqual([get('core.hooksPath'), get('core.fsmonitor'), get('filter.sys.clean')], [runs.noHooksPath(), 'false', ''], 'the overrides outrank it');
  } finally { if (saved === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = saved; }
});

test('D9: the caller\'s GIT_* variables do not steer nunchi\'s git (GIT_DIR, GIT_CONFIG_PARAMETERS)', () => {
  const mk = name => {
    const root = tmp(name);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
    writeFileSync(join(root, 'a.txt'), name); git('add', '.'); git('commit', '-qm', name);
    return root;
  };
  const app = mk('git-app'), elsewhere = mk('git-elsewhere');
  const mine = workTree(app);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS };
  try {
    process.env.GIT_DIR = join(elsewhere, '.git');
    process.env.GIT_CONFIG_PARAMETERS = "'core.hookspath'='elsewhere'";
    assert.deepEqual(workTree(app), mine, 'the app\'s own repository, whatever the environment says');
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('D9: --changed-since cannot smuggle a git option in as the ref', async () => {
  const root = tmp('git-ref');
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'a');
  const target = join(tmp('git-ref-out'), 'written.txt');
  const r = await promisify(execFile)('node', [CLI, 'capture', '--root', root, '--routes', '/', '--changed-since', `--output=${target}`, '--plan'], { cwd: root, encoding: 'utf8' }).then(() => ({ code: 0 }), e => ({ code: e.code, stderr: e.stderr }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not read git changes/);
  assert.ok(!existsSync(target), 'git wrote a file named by the "ref"');
});

test('D9: a git too old to switch the repository\'s programs off is not run at all (fail closed)', { skip: !POSIX && 'a fake git script needs a POSIX shell' }, () => {
  const bin = tmp('old-git');
  const log = join(bin, 'calls.txt');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.30.2"; exit 0; fi\necho "$@" >> "${log}"\necho 0123456789012345678901234567890123456789\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${saved}`;
    assert.deepEqual(workTree(tmp('old-git-root')), { commit: null, dirty: null, tree: null, repo: false });
    assert.throws(() => runs.gitRunner(bin), e => e.code === 'GIT_UNSAFE' && /older than 2\.31/.test(e.message));
  } finally { process.env.PATH = saved; }
  assert.ok(!existsSync(log), `git was run: ${existsSync(log) ? readFileSync(log, 'utf8') : ''}`);
});

// ---- D10: base-URL guard ---------------------------------------------------------------------------------

test('D10: only a server the user runs is captured: loopback, private, *.local, or a host they listed', () => {
  for (const ok of ['http://localhost:3000', 'http://127.0.0.1:5173/app', 'http://[::1]:3000', 'http://0.0.0.0:3000', 'http://app.localhost:3000',
    'http://10.1.2.3', 'http://172.16.0.9:8080', 'http://172.31.255.1', 'http://192.168.0.12:3000', 'http://[fd12:3456::1]:3000',
    'http://[::ffff:127.0.0.1]', 'http://pebble.local:3000', 'http://2130706433/']) assert.equal(baseUrlProblem(ok), null, ok);
  for (const no of ['https://pebbletasks.com', 'https://pebble-git-main.vercel.app', 'http://172.32.0.1', 'http://11.0.0.1', 'http://8.8.8.8',
    'http://localhost.evil.example', 'http://127.0.0.1.nip.io', 'http://10.0.0.1.example.com', 'http://[2001:db8::1]', 'http://local',
    // link-local holds cloud metadata services (169.254.169.254, fd00:ec2::254): never by default
    'http://169.254.169.254/latest/meta-data/', 'http://169.254.1.1', 'http://[fe80::1]', 'http://[fd00:ec2::254]', 'http://[::ffff:169.254.169.254]']) assert.match(baseUrlProblem(no), /not a local or private address/, no);
  assert.equal(baseUrlProblem('http://169.254.10.20:8080', ['169.254.10.20']), null, 'a link-local host the user listed');
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

test('D10: a redirect that leaves the base origin is not captured: no evidence from the other server', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const out = tmp('off-origin');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/away', path: '/away' }, { route: '/list.html', path: '/list.html' }], viewports: ['m'], out });
  const away = r.manifest.scenes.find(e => e.route === '/away');
  assert.deepEqual([away.status, away.reason, away.finalOrigin, away.finalPath], ['capture-failed', 'redirected-off-origin', other, '/landed']);
  assert.deepEqual(evidenceText(out).filter(([, text]) => text.includes('OTHER ORIGIN')).map(([f]) => f), []);
  assert.ok(!existsSync(join(out, 'away.guest.normal.m', 'top.jpg')), 'no screenshot of the other server');
  assert.deepEqual(r.findings.filter(f => f.route === '/away'), []);
  assert.equal(r.manifest.scenes.find(e => e.route === '/list.html').status, 'captured');
});

// ---- D11: strict replay ------------------------------------------------------------------------------------

test('D11: in replay, a request the recording does not have is never sent: not a read, not a write', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('strict-har');
  hits.splice(0);                                               // what earlier tests sent is not this test's
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

test('D11: forced states replay too, even from an empty recording: nothing goes live', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('empty-har');
  writeFileSync(join(har, 'guest.json'), JSON.stringify({ schema: 1, entries: {} }));
  hits.splice(0);
  const r = await capture({ baseUrl: base, scenes: [{ route: '/list.html', path: '/list.html?writes' }], viewports: ['m'], out: tmp('empty-replay'), network: 'replay', recordingDir: har, states: ['normal', 'empty', 'slow'] });
  assert.deepEqual(hits.splice(0), []);
  assert.deepEqual(r.manifest.scenes.map(e => e.state), ['normal', 'empty', 'slow'], 'the forced states ran');
  assert.ok(r.manifest.scenes.every(e => e.replayMisses > 0));
});

test('D11: a slow scene captured live does not crash when its held requests outlive the page', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const r = await capture({ baseUrl: base, scenes: [{ route: '/list.html', path: '/list.html' }], viewports: ['m'], out: tmp('slow-live'), network: 'live', states: ['normal', 'slow'] });
  assert.deepEqual(r.manifest.scenes.map(e => [e.state, e.status]), [['normal', 'captured'], ['slow', 'captured']]);
});

test('D11: in replay, WebSockets are closed, EventSource is stopped, and a keepalive write on leaving is not sent', async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const har = tmp('stream-har');
  writeFileSync(join(har, 'guest.json'), JSON.stringify({ schema: 1, entries: {} }));
  hits.splice(0); pages.splice(0);
  const out = tmp('stream-replay');
  await capture({ baseUrl: base, scenes: [{ route: '/stream.html', path: '/stream.html' }], viewports: ['m'], out, network: 'replay', recordingDir: har });
  await new Promise(r => setTimeout(r, 500));                     // a write sent while a page went away would land by now
  // the widget frame did unload during the scene (its pagehide sent a beacon, keepalive fetches and a fetchLater),
  // and the scene itself ended: none of it, nor the socket or the stream, reached the server
  assert.ok(pages.includes('/landing.html'), 'the frame moved on, so its unload handlers ran');
  assert.deepEqual(hits.splice(0), [], 'no socket, stream or write reached the server');
  const net = JSON.parse(readFileSync(join(out, 'stream.html.guest.normal.m', 'network.json'), 'utf8'));
  assert.deepEqual(net.streams, ['SSE app:/api/events', 'WS app:/ws'], 'listed apart from replay misses: a stream is never recorded');
  // the same page captured live does reach the server (the test above is not passing by accident)
  await capture({ baseUrl: base, scenes: [{ route: '/stream.html', path: '/stream.html' }], viewports: ['m'], out: tmp('stream-live'), network: 'live' });
  await new Promise(r => setTimeout(r, 300));
  const live = hits.splice(0);
  assert.ok(live.includes('WS /ws') && live.includes('GET /api/events'), live.join(', '));
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

test('D12: a symlink among nunchi\'s private paths is refused, never followed (nothing outside the repository is changed)', { skip: !POSIX && 'POSIX file modes and symlinks' }, () => {
  const outside = tmp('outside');
  writeFileSync(join(outside, 'creds.json'), '{}', { mode: 0o644 });
  mkdirSync(join(outside, 'recordings'), { mode: 0o755 });
  for (const [name, target] of [['auth.json', join(outside, 'creds.json')], ['har', join(outside, 'recordings')]]) {
    const nunchi = join(tmp('links'), '.nunchi');
    mkdirSync(nunchi);
    symlinkSync(target, join(nunchi, name));
    assert.throws(() => runs.ensurePrivate(nunchi), e => e.code === 'UNSAFE_PATH' && e.message.includes(name), name);
  }
  assert.deepEqual([mode(join(outside, 'creds.json')), mode(join(outside, 'recordings'))], [0o644, 0o755], 'the link targets kept their modes');
  const dir = tmp('link-write');
  symlinkSync(join(outside, 'creds.json'), join(dir, 'measure.json'));
  assert.throws(() => writeStable(join(dir, 'measure.json'), { x: 1 }), e => e.code === 'UNSAFE_PATH');
  assert.equal(readFileSync(join(outside, 'creds.json'), 'utf8'), '{}', 'nothing written through the link');
});

test('D12: the hunt mirror and the ledger state folder are owner-only too', { skip: !POSIX && 'POSIX file modes' }, async () => {
  const old = process.umask(0);
  try {
    const runDir = tmp('mirror');
    writeStable(join(runDir, 'tasks.guest.normal.m', 'controls.json'), []);
    writeHuntMirror(runDir, { scenes: { s0123456789: 'tasks.guest.normal.m' } });
    assert.deepEqual([mode(join(runDir, 'hunt')), mode(join(runDir, 'hunt', 's0123456789'))], [0o700, 0o700]);
    // `nunchi approve` before any capture writes the first file of .nunchi/state/
    const cwd = tmp('approve');
    mkdirSync(join(cwd, '.nunchi', 'decisions', 'group-abc'), { recursive: true });
    writeFileSync(join(cwd, '.nunchi', 'decisions', 'group-abc', 'd1.json'), JSON.stringify({ schema: 1, id: 'd1', target: { group: 'abc' }, decision: 'fix', reason: null, by: 'someone', at: '2026-10-14T10:00:00.000+09:00' }));
    await promisify(execFile)('node', [CLI, 'approve', '--all'], { cwd, encoding: 'utf8' });
    assert.ok(existsSync(join(cwd, '.nunchi', 'state', 'approved.json')));
    assert.equal(mode(join(cwd, '.nunchi', 'state')), 0o700);
    // `nunchi gc` on runs an older version left unfolded: its catch-up fold writes the first ledger file
    const gcDir = tmp('gc');
    const run = join(gcDir, '.nunchi', 'runs', '0001');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'run.json'), '{}');
    writeFileSync(join(run, 'manifest.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', scenes: [] }));
    writeFileSync(join(run, 'findings.json'), JSON.stringify({ findings: [] }));
    await promisify(execFile)('node', [CLI, 'gc'], { cwd: gcDir, encoding: 'utf8' });
    assert.ok(existsSync(join(gcDir, '.nunchi', 'state', 'ledger.json')), 'the run was folded');
    assert.deepEqual(['runs', 'state'].map(p => mode(join(gcDir, '.nunchi', p))), [0o700, 0o700]);
  } finally { process.umask(old); }
});

test('D12: the CLI capture makes .nunchi/har, runs and state private before it writes (umask 0)', { skip: !POSIX && 'POSIX file modes' }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const old = process.umask(0);
  try {
    const cwd = tmp('cli-modes');
    await promisify(execFile)('node', [CLI, 'capture', '--url', base, '--routes', '/list.html', '--viewports', 'm', '--states', 'normal', '--json'], { cwd, encoding: 'utf8' });
    assert.ok(existsSync(join(cwd, '.nunchi', 'state', 'ledger.json')), 'the run was folded');
    assert.deepEqual(['har', 'runs', 'state'].map(p => mode(join(cwd, '.nunchi', p))), [0o700, 0o700, 0o700]);
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
