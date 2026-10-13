// The CLI writes each capture into its own run folder: complete or absent, numbered, with the source
// state it was taken from. Needs Chromium (skipped otherwise).
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch } from '../src/capture.mjs';

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
