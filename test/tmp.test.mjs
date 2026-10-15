// Temporary folders (test/fixtures/tmp.mjs). Measured 2026-10-15 KST: the suite left its folders behind, on success
// and failure; a machine that had run many suites held 16,286 nunchi-* folders in /tmp, /dev/shm ran out of inodes and
// every suite then failed with ENOSPC. Now every test file makes its folders through tmp(), and the file's process
// removes them when it ends. Here: the contract (no test file makes one any other way, with a fixture that trips the
// check and one that does not); what a file's process leaves (nothing: the fixtures' projects, a failed test, a
// stopping signal; NUNCHI_KEEP_TMP=1 keeps them); a folder that cannot be removed; and what CI's leftover check
// (scripts/tmp-leftovers.mjs, run around `npm test`) counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmp, removeTmp, exitLine } from './fixtures/tmp.mjs';
import { leftovers } from '../scripts/tmp-leftovers.mjs';

const TEST = fileURLToPath(new URL('.', import.meta.url));
const HELPER = join(TEST, 'fixtures', 'tmp.mjs');
const LEFTOVERS = fileURLToPath(new URL('../scripts/tmp-leftovers.mjs', import.meta.url));
const url = rel => JSON.stringify(pathToFileURL(join(TEST, 'fixtures', rel)).href);
const POSIX = process.platform !== 'win32';

// ---- the contract -----------------------------------------------------------------------------------------------------

// A temporary folder made other than through tmp(): mkdtemp or mkdtempSync called, imported or taken from a module
// (fs.promises too), or a path built on the system's temporary folder (tmpdir() or $TMPDIR, $TEMP, $TMP joined,
// resolved, in a template or added to). Comments are not read. → [{ line, text }]
const MK = 'mkdtemp', TD = 'tmpdir', ENV = 'process.env';   // assembled, so this file passes its own check
const OWN = [
  new RegExp(`\\b${MK}(Sync)?\\s*\\(`),
  new RegExp(`\\.\\s*${MK}(Sync)?\\b`),
  new RegExp(`\\{[^}]*\\b${MK}(Sync)?\\b[^}]*\\}\\s*(from\\b|=)`),
  new RegExp(`\\b(join|resolve)\\s*\\(\\s*(os\\.)?${TD}\\s*\\(\\s*\\)`),
  new RegExp(`\\$\\{\\s*(os\\.)?${TD}\\s*\\(\\s*\\)\\s*\\}`),
  new RegExp(`\\b${TD}\\s*\\(\\s*\\)\\s*\\+`),
  /\b(join|resolve)\s*\(\s*process\.env\.(TMPDIR|TEMP|TMP)\b/,
];
function ownTmp(src) {
  const code = src.replace(/^\s*\/\*[\s\S]*?\*\//gm, m => m.replace(/[^\n]/g, ' '));
  const out = [];
  code.split('\n').forEach((l, i) => { if (OWN.some(re => re.test(l.replace(/(^|\s)\/\/.*$/, '$1')))) out.push({ line: i + 1, text: l.trim() }); });
  return out;
}

test('temporary folders: every test file and fixture makes them through tmp() (test/fixtures/tmp.mjs), never with mkdtemp or a path on tmpdir() of its own', () => {
  const files = readdirSync(TEST, { recursive: true }).map(String).filter(f => /\.[cm]?js$/.test(f) && join(TEST, f) !== HELPER).sort();
  assert.ok(files.length > 80, `the test files are read (${files.length})`);
  const hits = files.flatMap(f => ownTmp(readFileSync(join(TEST, f), 'utf8')).map(h => `test/${f.split(sep).join('/')}:${h.line}: ${h.text}`));
  assert.deepEqual(hits, [], `make temporary folders with tmp() from test/fixtures/tmp.mjs (removed when the file's process ends):\n${hits.join('\n')}`);
  assert.ok(ownTmp(readFileSync(HELPER, 'utf8')).length > 0, 'the helper is the one exception, and the check sees it');
});

test('the check: mkdtemp or a path built on tmpdir() trips it; tmp(), a path in a tmp() folder, a comment and tmpdir() compared do not', () => {
  const trips = [
    `const dir = ${MK}Sync(join(${TD}(), 'nunchi-x-'));`,
    `import { readFileSync, ${MK}Sync } from 'node:fs';`,
    `const dir = await fs.promises.${MK}(path.join(os.${TD}(), 'nunchi-x-'));`,
    `const browserPath = join(${TD}(), 'no-such-browser');`,
    'const file = `${' + TD + '()}/nunchi-key.json`;',
    `const file = ${TD}() + '/nunchi-key.json';`,
    `const xdg = resolve(${ENV}.TMPDIR, 'xdg');`,
    `const { ${MK}Sync, mkdirSync } = await import('node:fs');`,
    `import { ${MK}Sync as fresh } from 'node:fs';`,
  ];
  for (const s of trips) assert.equal(ownTmp(s).length, 1, s);
  const passes = [
    `const dir = tmp('nunchi-x-');`,
    `const link = join(tmp('nunchi-link-'), 'project-link');`,
    `const root = tmpDir(\`nunchi-\${p}-\`);`,
    `// not ${MK}Sync(join(${TD}(), 'x')): tmp() removes its folders at exit`,
    `const dir = tmp('nunchi-x-');   // instead of ${MK}Sync`,
    `/* ${MK}Sync(join(${TD}(), 'x')) */`,
    `assert.equal(realpathSync(serverCwd()), realpathSync(${TD}()));`,
    `const url = 'http://127.0.0.1:9/' + ${TD}.name;`,
    `test('no test file calls ${MK}Sync or joins onto ${TD}() of its own', () => {});`,
  ];
  for (const s of passes) assert.deepEqual(ownTmp(s), [], s);
});

// ---- tmp() -------------------------------------------------------------------------------------------------------------

test('tmp(): a new empty folder in the system temporary folder, by its real path; a prefix starts with nunchi- and is one name', () => {
  const a = tmp('nunchi-tmp-'), b = tmp();
  assert.notEqual(a, b);
  assert.equal(a, realpathSync(a));
  assert.equal(dirname(a), realpathSync(tmpdir()));
  assert.match(basename(a), /^nunchi-tmp-[\w]{6}$/);
  assert.match(basename(b), /^nunchi-[\w]{6}$/);
  assert.deepEqual(readdirSync(a), []);
  for (const bad of ['x-', 'tmp-nunchi-', 'nunchi-a/b', 'nunchi-a\\b', '../nunchi-', '', null, 7]) assert.throws(() => tmp(bad), /a prefix starts with nunchi-/, String(bad));
});

// A test file of its own, run as `node --test` runs one (in a process of its own) with a temporary folder of its own,
// and what that process left in it. `env`: more variables; `body`: the file's code after its imports.
function runFile(body, env = {}) {
  const dir = tmp('nunchi-tmp-file-'), own = tmp('nunchi-tmp-own-');
  const file = join(dir, 'child.test.mjs');
  writeFileSync(file, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from ${url('tmp.mjs')};
import { smallProject } from ${url('board-project.mjs')};
import { leafy } from ${url('coverage-project.mjs')};
import { fixProject } from ${url('fix-project.mjs')};
import { huntProject } from ${url('hunt-run.mjs')};
import { quickApp } from ${url('quick-app.mjs')};
${body}
`);
  const base = { ...process.env };
  delete base.NUNCHI_KEEP_TMP;
  return { file, own, env: { ...base, TMPDIR: own, TEMP: own, TMP: own, ...env } };
}
const MAKES = `test('makes folders: its own and the fixtures\\' projects', async () => {
  writeFileSync(join(tmp('nunchi-child-'), 'a.txt'), 'a');
  smallProject({ git: true }); leafy(); await fixProject(); huntProject(); quickApp();
});
test('fails when asked', () => { if (process.env.CHILD_FAILS) throw new Error('a failure (a test)'); });`;
const lineOf = stderr => stderr.split('\n').filter(l => l.startsWith('nunchi tests:'));

test('a test file\'s process removes its folders when it ends (its own and the fixtures\' projects: board, Leafy, fix, hunt, quick app), its tests passed or one failed', () => {
  const pass = runFile(MAKES);
  const ok = spawnSync(process.execPath, [pass.file], { env: pass.env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(readdirSync(pass.own), [], 'nothing left');
  assert.deepEqual(lineOf(ok.stderr), [], 'and nothing said');
  const fail = runFile(MAKES, { CHILD_FAILS: '1' });
  const bad = spawnSync(process.execPath, [fail.file], { env: fail.env, encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /a failure \(a test\)/);
  assert.deepEqual(readdirSync(fail.own), [], 'nothing left after a failure either');
  assert.deepEqual(lineOf(bad.stderr), ['nunchi tests: removed this file\'s 6 temporary folders; NUNCHI_KEEP_TMP=1 keeps them'], 'a failed file says how to keep them');
});

test('NUNCHI_KEEP_TMP=1 keeps them, and says where they are', () => {
  const keep = runFile(MAKES, { NUNCHI_KEEP_TMP: '1' });
  const r = spawnSync(process.execPath, [keep.file], { env: keep.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const kept = readdirSync(keep.own).sort();
  assert.equal(kept.length, 6, kept.join(', '));
  assert.ok(kept.every(n => n.startsWith('nunchi-')), kept.join(', '));
  const [line] = lineOf(r.stderr);
  assert.match(line, /^nunchi tests: kept 6 temporary folders \(NUNCHI_KEEP_TMP=1\): /);
  for (const n of kept) assert.ok(line.includes(join(keep.own, n)), `${n} is named`);
});

test('stopped by a signal (the runner stops a file past --test-timeout with SIGTERM; Ctrl-C), a file\'s process removes them and still ends by that signal', { skip: !POSIX && 'Windows ends a process without telling it' }, async () => {
  for (const [sig, mine] of [['SIGTERM', false], ['SIGINT', false], ['SIGTERM', true]]) {
    // `mine`: the file listens to the signal itself, and ends as it says
    const f = runFile(`smallProject(); tmp('nunchi-child-');
${mine ? `process.on('${sig}', () => process.exit(3));` : ''}
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);`);
    const c = spawn(process.execPath, [f.file], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    await new Promise((res, rej) => { c.stdout.on('data', d => { if (String(d).includes('ready')) res(); }); c.once('exit', () => rej(new Error(`ended before it was ready: ${err}`))); });
    const end = new Promise(res => c.once('exit', (code, signal) => res({ code, signal })));
    c.kill(sig);
    assert.deepEqual(await end, mine ? { code: 3, signal: null } : { code: null, signal: sig }, `${sig}${mine ? ' (its own listener)' : ''}: ${err}`);
    assert.deepEqual(readdirSync(f.own), [], `${sig}: nothing left`);
  }
});

test('a folder that cannot be removed never fails or holds up the run: retried until the budget is spent, then counted on one stderr line', () => {
  let t = 0;
  const tries = [];
  const rm = (dir, o) => {
    tries.push([basename(dir), o.recursive, o.force, o.maxRetries]);
    t += 6000;                                            // each refusal takes its retries' time
    if (basename(dir).startsWith('busy')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  };
  const r = removeTmp(['/t/a', '/t/busy1', '/t/c', '/t/busy2'], { rm, now: () => t, budgetMs: 10000 });
  assert.deepEqual(r, { removed: 2, left: ['/t/busy1', '/t/busy2'] });
  assert.deepEqual(tries, [['a', true, true, 5], ['busy1', true, true, 5], ['c', true, true, 0], ['busy2', true, true, 0]], 'no retries once the budget is spent');
  assert.equal(exitLine({ code: 0, ...r }), 'nunchi tests: 2 temporary folders could not be removed, e.g. /t/busy1');
  assert.equal(exitLine({ code: 1, removed: 1, left: ['/t/busy1'] }), 'nunchi tests: 1 temporary folder could not be removed, e.g. /t/busy1');
  assert.equal(exitLine({ code: 0, removed: 3, left: [] }), null, 'a file that passed and left nothing says nothing');
  assert.equal(exitLine({ code: 1, removed: 1, left: [] }), 'nunchi tests: removed this file\'s 1 temporary folder; NUNCHI_KEEP_TMP=1 keeps them');
  assert.equal(exitLine({ code: 1, removed: 0, left: [] }), null);
  assert.equal(exitLine({ keep: true, kept: ['/t/a', '/t/b'] }), 'nunchi tests: kept 2 temporary folders (NUNCHI_KEEP_TMP=1): /t/a /t/b');
  assert.equal(exitLine({ keep: true, kept: [] }), null);
});

// ---- CI's leftover check -----------------------------------------------------------------------------------------------

test('the leftover check: anything left trips it (a socket in the board\'s socket folder too); npm\'s compile cache, Chromium\'s shared memory and that folder empty do not', () => {
  const d = tmp('nunchi-left-');
  mkdirSync(join(d, 'node-compile-cache'));
  writeFileSync(join(d, '.org.chromium.Chromium.DWilWC'), '');
  mkdirSync(join(d, 'nunchi-501'));
  assert.deepEqual(leftovers(d), []);
  writeFileSync(join(d, 'nunchi-501', '0123456789abcdef.sock'), '');
  mkdirSync(join(d, 'nunchi-board-AbC123'));
  writeFileSync(join(d, 'outside'), '');
  mkdirSync(join(d, 'playwright_chromiumdev_profile-XyZ789'));
  assert.deepEqual(leftovers(d), ['nunchi-501', 'nunchi-board-AbC123', 'outside', 'playwright_chromiumdev_profile-XyZ789']);
});

test('the leftover check around a command: a folder left in its temporary folder fails it and is named; a command that leaves nothing passes', () => {
  const dir = tmp('nunchi-left-cmd-');
  const leaves = join(dir, 'leaves.mjs'), clean = join(dir, 'clean.mjs');
  writeFileSync(leaves, `import { mkdirSync } from 'node:fs';\nimport { ${TD} } from 'node:os';\nmkdirSync(\`\${${TD}()}/nunchi-left-behind\`);\n`);
  writeFileSync(clean, `import { tmp } from ${url('tmp.mjs')};\ntmp('nunchi-gone-');\n`);
  const run = file => spawnSync(process.execPath, [LEFTOVERS, process.execPath, file], { encoding: 'utf8' });
  const a = run(leaves);
  assert.equal(a.status, 1, a.stdout + a.stderr);
  assert.match(a.stderr, /left 1 entry in its temporary folder:\n {2}nunchi-left-behind\n/);
  const b = run(clean);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /left nothing in its temporary folder/);
});
