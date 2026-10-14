// The fix loop runs the repository's own checks (design 0.1-c §4.3): only approved lines, pre/post lines switched off
// per package manager (verified here on the managers this machine has), shell: false, an allow-listed environment,
// no corepack download, a timeout, output scrubbed for secrets, and a baseline so a check blocks only when it newly
// fails or its count rises. Synthetic projects in temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as X from '../src/fix/run.mjs';
import { checkProfile } from '../src/checks.mjs';

const tmp = p => realpathSync(mkdtempSync(join(tmpdir(), p)));
function project(scripts, extra = {}) {
  const root = tmp('nunchi-checks-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'checks-fixture', private: true, scripts, ...extra }));
  writeFileSync(join(root, 'mark.js'), "require('fs').writeFileSync(process.argv[2], 'ran')\n");
  writeFileSync(join(root, 'lint.js'), "console.log('✖ 3 problems (3 errors, 0 warnings)'); console.log('token sk_live_' + 'abcdefghijklmnop0123456789'); process.exit(1)\n");
  writeFileSync(join(root, 'env.js'), "console.log('ENV ' + JSON.stringify(Object.keys(process.env).filter(k => !/^npm_|^INIT_CWD$|^NODE$|^COLOR$|^EDITOR$|^_$/.test(k)).sort())); console.log('NODE_ENV=' + process.env.NODE_ENV + ' CI=' + process.env.CI)\n");
  return root;
}
const PRE_POST = { prelint: 'node mark.js pre.txt', lint: 'node lint.js', postlint: 'node mark.js post.txt' };

test('npm: `npm run --ignore-scripts` runs the line only (pre/post lines do not run); the count is read; a secret in the output is scrubbed', async () => {
  const root = project(PRE_POST);
  const { results, pm } = await X.runChecks({ root, profile: checkProfile(root) });
  assert.equal(pm.name, 'npm');
  assert.deepEqual([results.lint.status, results.lint.exit, results.lint.count], ['fail', 1, 3]);
  assert.ok(!existsSync(join(root, 'pre.txt')) && !existsSync(join(root, 'post.txt')), 'prelint and postlint did not run');
  assert.doesNotMatch(results.lint.output, /sk_live_abcdef/);
  assert.match(results.lint.output, /\[secret-shaped/);
  assert.deepEqual([results.build.status, results.test.status, results.typecheck.status], ['missing', 'missing', 'missing']);
  assert.deepEqual(X.commandFor({ pm: { name: 'npm' }, script: 'lint', bin: '/usr/bin/npm', platform: 'linux' }).args, ['run', '--ignore-scripts', 'lint']);
});

test('the environment is an allow-list (PATH, HOME, LANG, TERM, CI=1, NODE_ENV=test; corepack never downloads or pins)', async () => {
  const root = project({ test: 'node env.js' });
  process.env.NUNCHI_TEST_SECRET_TOKEN = 'do-not-pass-me';
  try {
    const { results } = await X.runChecks({ root, profile: checkProfile(root) });
    const keys = JSON.parse(/ENV (\[.*\])/.exec(results.test.output)[1]);
    assert.ok(!keys.includes('NUNCHI_TEST_SECRET_TOKEN'), keys.join(' '));
    assert.ok(!keys.some(k => /^(GIT_|LD_|NODE_OPTIONS)/.test(k)), keys.join(' '));
    assert.match(results.test.output, /NODE_ENV=test CI=1/);
  } finally { delete process.env.NUNCHI_TEST_SECRET_TOKEN; }
  const env = X.childEnv({ PATH: '/bin', HOME: '/h', SECRET: 'x', LANG: 'C' }, 'linux');
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'COREPACK_ENABLE_AUTO_PIN', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'COREPACK_ENABLE_NETWORK', 'HOME', 'LANG', 'NODE_ENV', 'PATH']);
  assert.deepEqual([env.COREPACK_ENABLE_AUTO_PIN, env.COREPACK_ENABLE_NETWORK, env.NODE_ENV, env.CI], ['0', '0', 'test', '1']);
  // Windows needs a few more to start a process at all
  const win = X.childEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe', TEMP: 'C:\\T', SECRET: 'x' }, 'win32');
  for (const k of ['PATH', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'TEMP']) assert.ok(win[k], k);
  assert.ok(!('SECRET' in win));
});

test('shell: false; on Windows the .cmd shim starts through cmd.exe /d /s /c with a checked script name; a missing package manager is refused, never downloaded', () => {
  const c = X.commandFor({ pm: { name: 'npm' }, script: 'lint', bin: 'C:\\nodejs\\npm.cmd', platform: 'win32' });
  assert.match(c.cmd, /System32[\\/]cmd\.exe$/);
  assert.deepEqual(c.args, ['/d', '/s', '/c', '""C:\\nodejs\\npm.cmd" run --ignore-scripts lint"']);
  // a path with spaces: /s strips the outer quotes only, so the shim's path stays quoted (what cmd.exe then runs)
  const spaced = X.commandFor({ pm: { name: 'npm' }, script: 'lint', bin: 'C:\\Program Files\\nodejs\\npm.cmd', platform: 'win32' });
  const line = spaced.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  assert.equal(line.slice(1, -1), '"C:\\Program Files\\nodejs\\npm.cmd" run --ignore-scripts lint', 'after /s: the quoted path, then the arguments');
  assert.match(X.commandFor({ pm: { name: 'npm' }, script: 'lint', bin: 'C:\\%TEMP%\\npm.cmd', platform: 'win32' }).refused, /cmd\.exe would read as its own/);
  assert.equal(c.opts.windowsVerbatimArguments, true);
  assert.match(X.commandFor({ pm: { name: 'npm' }, script: 'lint & calc', bin: 'x', platform: 'win32' }).refused, /not a script name/);
  assert.match(X.commandFor({ pm: { name: 'pnpm' }, script: 'lint', bin: null }).refused, /^no pnpm on PATH: nunchi never downloads a package manager/);
  // the pre/post refusal comes first whether or not the manager is installed: installing bun would not lift it
  const prePost = { scripts: { prelint: 'x', lint: 'y' } };
  for (const pm of [{ name: 'bun', major: null }, { name: 'yarn', major: 1 }]) assert.match(X.commandFor({ pm, script: 'lint', bin: null, profile: prePost }).refused, /runs prelint and postlint whatever it is told/);
  assert.equal(X.findBinary('nunchi-no-such-manager', { env: { PATH: process.env.PATH } }), null);
  assert.deepEqual(X.packageManagerOf('/nowhere', { packageManager: 'pnpm@9.1.0+sha512.abc' }), { name: 'pnpm', major: 9, from: 'packageManager' });
});

test('pnpm (when installed): `--config.enable-pre-post-scripts=false run` runs the line only', async t => {
  if (!X.findBinary('pnpm')) return t.skip('pnpm is not installed here');
  const root = project(PRE_POST, { packageManager: undefined });
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const { results, pm } = await X.runChecks({ root, profile: checkProfile(root) });
  assert.equal(pm.name, 'pnpm');
  assert.deepEqual([results.lint.status, results.lint.count], ['fail', 3], results.lint.output);
  assert.ok(!existsSync(join(root, 'pre.txt')) && !existsSync(join(root, 'post.txt')));
});

test('yarn 1 and bun run pre/post lines whatever they are told: a check that has them is not run (said plainly); one without runs', async t => {
  for (const name of ['yarn', 'bun']) {
    const root = project(PRE_POST);
    writeFileSync(join(root, name === 'yarn' ? 'yarn.lock' : 'bun.lockb'), '');
    const profile = checkProfile(root);
    const r = await X.runChecks({ root, profile });
    assert.equal(r.results.lint.status, 'refused');
    assert.match(r.results.lint.why, name === 'yarn' ? /^yarn 1 runs prelint and postlint whatever it is told/ : /^bun runs prelint and postlint/);
    assert.ok(!existsSync(join(root, 'pre.txt')));
    if (!X.findBinary(name)) { t.diagnostic(`${name} not installed: only the refusal is checked`); continue; }
    const plain = project({ lint: 'node lint.js' });
    writeFileSync(join(plain, name === 'yarn' ? 'yarn.lock' : 'bun.lockb'), '');
    const ok = await X.runChecks({ root: plain, profile: checkProfile(plain) });
    assert.deepEqual([ok.results.lint.status, ok.results.lint.count], ['fail', 3], ok.results.lint.output);
  }
});

test('a check that runs past its timeout is killed (10 minutes; shorter here)', async () => {
  const root = project({ test: 'node -e "setTimeout(() => {}, 60000)"' });
  const t0 = Date.now();
  const { results } = await X.runChecks({ root, profile: checkProfile(root), timeout: 1500 });
  assert.equal(results.test.status, 'timeout');
  assert.ok(Date.now() - t0 < 15000);
  assert.equal(X.CHECK_TIMEOUT_MS, 10 * 60e3);
});

test('baseline: a check blocks only when it newly fails or its count rises; the lines say each plainly', () => {
  const f = n => ({ status: 'fail', count: n }), ok = { status: 'pass' };
  let r = X.compareChecks({ lint: f(40), build: ok }, { lint: f(40), build: ok });
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.lines, ['build passes.', 'no typecheck script — nunchi relies on re-capture.', 'lint was already failing before this fix (40 problems) — not blocking; still 40 after.', 'no test script — nunchi relies on re-capture.']);
  r = X.compareChecks({ lint: f(40) }, { lint: f(38) });
  assert.match(r.lines.join('\n'), /lint was already failing before this fix \(40 problems\) — not blocking; now 38 after\./);
  r = X.compareChecks({ lint: f(40) }, { lint: f(43) });
  assert.deepEqual(r.blocking, ['lint']);
  assert.match(r.lines.join('\n'), /lint was already failing before this fix \(40 problems\), and now has 43/);
  r = X.compareChecks({ test: ok }, { test: f(2) });
  assert.deepEqual(r.blocking, ['test']);
  assert.match(r.lines.join('\n'), /test newly fails \(2 problems\): fix it before committing\./);
  r = X.compareChecks({ build: ok }, { build: { status: 'timeout', count: null } });
  assert.deepEqual(r.blocking, ['build']);
  assert.match(r.lines.join('\n'), /build newly fails \(timed out after 10 minutes\)/);
});

test('counts: eslint, tsc, node:test, jest, vitest, a generic "N errors"', () => {
  assert.equal(X.countOf('✖ 40 problems (38 errors, 2 warnings)'), 40);
  assert.equal(X.countOf('Found 3 errors in 2 files.'), 3);
  assert.equal(X.countOf('# tests 10\n# pass 8\n# fail 2\n'), 2);
  assert.equal(X.countOf('Tests:       2 failed, 5 passed, 7 total'), 2);
  assert.equal(X.countOf(' Tests  4 failed | 6 passed (10)'), 4);
  assert.equal(X.countOf('build finished with 7 errors'), 7);
  assert.equal(X.countOf('all good'), null);
  assert.equal(X.cleanOutput('\x1b[31mred\x1b[0m'), 'red');
});

test('Windows: a .cmd shim in a folder whose path has spaces runs, with its arguments', { skip: process.platform !== 'win32' && 'cmd.exe is Windows only' }, async () => {
  const dir = join(tmp('nunchi-cmd-'), 'Program Files', 'node js');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'npm.cmd'), '@echo ran %*\r\n');
  const c = X.commandFor({ pm: { name: 'npm' }, script: 'lint', bin: join(dir, 'npm.cmd'), platform: 'win32' });
  const r = await X.runProcess({ ...c, cwd: dir, env: X.childEnv(process.env, 'win32') });
  assert.equal(r.exit, 0, r.output);
  assert.match(r.output, /ran run --ignore-scripts lint/);
});

// ---- M3 review: checks that cannot hang, crash quietly or hide a script -------------------------------------------------

test('the timeout bounds the run even when a grandchild keeps the output open; a quick exit is not held by it either', async () => {
  const hold = "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true }).unref()";
  const quick = project({ test: `node -e "${hold}"` });
  let t0 = Date.now();
  const a = await X.runChecks({ root: quick, profile: checkProfile(quick), timeout: 2000 });
  assert.equal(a.results.test.status, 'pass');
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
  const slow = project({ test: `node -e "${hold}; setTimeout(() => {}, 60000)"` });
  t0 = Date.now();
  const b = await X.runChecks({ root: slow, profile: checkProfile(slow), timeout: 2000 });
  assert.equal(b.results.test.status, 'timeout');
  assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
});

test('baseline: a suite that crashed (no count where there was one), failed another way, or disappeared blocks', () => {
  const f = (n, exit = 1) => ({ status: 'fail', count: n, exit });
  let r = X.compareChecks({ test: f(3) }, { test: f(null) });
  assert.deepEqual(r.blocking, ['test']);
  assert.match(r.lines.join('\n'), /test was already failing before this fix \(3 problems\), and now fails without saying how many \(it may have crashed\)/);
  r = X.compareChecks({ test: f(3) }, { test: f(3, 134) });
  assert.deepEqual(r.blocking, ['test']);
  assert.match(r.lines.join('\n'), /fails another way \(exit 134 instead of 1\)/);
  r = X.compareChecks({ test: f(3) }, { test: { status: 'timeout', count: 3, exit: null } });
  assert.deepEqual(r.blocking, ['test']);
  r = X.compareChecks({ test: { status: 'pass' } }, { test: { status: 'missing' } });
  assert.deepEqual(r.blocking, ['test']);
  assert.match(r.lines.join('\n'), /test was there when the fix started and is gone now/);
  assert.deepEqual(X.compareChecks({ test: f(3) }, { test: f(3) }).blocking, [], 'the same failure as before still does not block');
});

test('the profile covers every script (a helper a check calls); a check that runs another script through a manager is not run', async () => {
  const root = project({ test: 'node mark.js t.txt && npm run helper', helper: 'node mark.js h.txt' });
  const before = checkProfile(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'checks-fixture', private: true, scripts: { test: 'node mark.js t.txt && npm run helper', helper: 'node mark.js h2.txt' } }));
  assert.notEqual(checkProfile(root).hash, before.hash, 'changing helper asks again');
  assert.deepEqual(checkProfile(root).others, { helper: 'node mark.js h2.txt' });
  const r = await X.runChecks({ root, profile: checkProfile(root) });
  assert.equal(r.results.test.status, 'refused');
  assert.match(r.results.test.why, /^its line runs other scripts \(`npm run`\), whose pre\/post lines nunchi cannot switch off/);
  assert.ok(!existsSync(join(root, 't.txt')), 'nothing of it ran');
  for (const [line, hit] of [['pnpm lint', 'pnpm lint'], ['yarn helper', 'yarn helper'], ['bun run x', 'bun run'], ['eslint . && npm test', 'npm test'], ['npx tsc', null], ['pnpm exec tsc', null], ['yarn dlx x', null], ['bunx x', null], ['node npm.js', null],
    // task runners, and commands inside a runner's quoted arguments (M3 review, round 2)
    ['turbo run build', 'turbo run'], ['npx turbo run lint', 'turbo run'], ['lerna run test --stream', 'lerna run'], ['nx run app:build', 'nx run'], ['pnpm exec nx test app', 'nx test'],
    ['concurrently "pnpm:lint" "pnpm:types"', 'concurrently "pnpm:lint"'], ['concurrently "npm run a" "tsc"', 'concurrently "npm run"'], ['run-s lint test', 'run-s lint'], ['cross-env CI=1 npm test', 'npm test'], ['FOO=1 yarn helper', 'yarn helper'],
    // command words only: text, comments and arguments that name a manager run nothing
    ['echo "use npm run build"', null], ["echo 'pnpm test'", null], ['tsc # pnpm test', null], ['node x.js npm', null], ['eslint . --rule "no-npm: off"', null], ['vitest run', null], ['yarn', null], ['npm --version', null]]) assert.equal(X.nestedRun(line), hit, line);
});

test('yarn: its major version comes from the binary, not from the markers (when installed)', async t => {
  if (!X.findBinary('yarn')) return t.skip('yarn is not installed here');
  const root = project(PRE_POST);
  writeFileSync(join(root, 'yarn.lock'), '');
  writeFileSync(join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');           // a marker of yarn 2+, but yarn here is
  const r = await X.runChecks({ root, profile: checkProfile(root) });
  // asked the way the checks ask it (on Windows yarn is a .cmd shim, started through cmd.exe)
  const v = await X.majorOf(X.findBinary('yarn'), { root });
  assert.ok(Number.isInteger(v), 'yarn --version answered');
  assert.equal(r.pm.major, v);
  assert.equal(r.pm.from, 'yarn --version');
  if (Number(v) === 1) assert.equal(r.results.lint.status, 'refused', 'yarn 1 runs pre/post: refused');
});
