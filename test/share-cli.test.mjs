// `nunchi share` from the CLI (spec §7.6): a real capture (Chromium, the fixture site) sends its run once it is folded
// when the person set sharing up to send after every full check, and says nothing when it is not set up; `share` sends
// on demand and `share --status` lists where it went; `export --html --no-page-text` writes the page without page
// text. A temp folder stands in for Google Drive. Needs Chromium: skipped without one unless NUNCHI_REQUIRE_BROWSER.
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launch } from '../src/capture.mjs';
import { tmp } from './fixtures/tmp.mjs';
import { driveHome, setUp } from './fixtures/share-project.mjs';

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
  try { const b = await launch(); await b.close(); } catch (e) { if (process.env.NUNCHI_REQUIRE_BROWSER) throw e; browserOk = false; }
});
after(() => server && server.close());
const cli = async (cwd, ...a) => { try { const r = await promisify(execFile)(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' }); return { code: 0, ...r }; } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; } };
const capture = cwd => cli(cwd, 'capture', '--url', base, '--routes', '/', '--viewports', 'm', '--states', 'normal', '--network', 'live');

test('share after a full check: a capture sends its run when set up "after", and says nothing when sharing is not set up', { timeout: 180000 }, async t => {
  if (!browserOk) return t.skip('no Chromium found (set NUNCHI_BROWSER)');
  const cwd = tmp('nunchi-share-cli-');
  const plain = await capture(cwd);
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout + plain.stderr, /Shared run|Not shared|[Ss]haring|ready to share/, 'not set up: not a word about sharing');
  const p = { root: cwd, nunchi: join(cwd, '.nunchi') };
  const d = driveHome(p);
  setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/site' }, { app: 'site' });
  const r = await capture(cwd);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\nShared run 0002 \(full check\) → Google Drive · My Drive\/nunchi\/site\/0002\n {2}1 screen \(visitor\) · \d+ findings? · \d+ KB · \d+ files\n/);
  assert.deepEqual(readdirSync(join(d.root, 'nunchi', 'site')), ['0002']);
  const s = JSON.parse(readFileSync(join(d.root, 'nunchi', 'site', '0002', 'share.json'), 'utf8'));
  assert.deepEqual([s.run, s.kind, s.included.persons], ['0002', 'full', ['guest']]);
  // on demand, and the status lists where it went
  const now = await cli(cwd, 'share');
  assert.equal(now.code, 0, now.stderr);
  assert.match(now.stdout, /^Shared run 0002 \(full check\)/);
  const st = await cli(cwd, 'share', '--status');
  assert.match(st.stdout, /^Sharing on · site → Google Drive · My Drive\/nunchi\/site · visitor screens · after every full check\n {2}Sent run 0002 · 2026-|\n {2}Sent run 0002 · \d{4}-/);
  assert.ok(!st.stdout.includes('GoogleDrive-test@example.invalid'), 'the account in the Drive path is never printed');
  // set up "manual": a capture sends nothing
  setUp(p, { kind: 'drive', root: d.root, folder: 'nunchi/site' }, { app: 'site', when: 'manual' });
  const m = await capture(cwd);
  assert.doesNotMatch(m.stdout, /Shared run/);
  assert.deepEqual(readdirSync(join(d.root, 'nunchi', 'site')), ['0002']);
  // export --html --no-page-text
  const out = tmp('nunchi-share-cli-out-');
  const e = await cli(cwd, 'export', '--html', out, '--no-page-text');
  assert.equal(e.code, 0, e.stderr);
  assert.match(e.stdout, /Text from your screens is left out/);
  assert.ok(existsSync(join(out, 'index.html')));
});
