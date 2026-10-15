import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseSets, computeHashes, renderBlock, readRegistered, compare, fillDoc, listing, BEGIN, END } from '../scripts/prereg-hash.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/prereg-hash.mjs', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

// a small repository: an engine folder, a scorer file, a doc outside both sets
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nunchi-prereg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'eng', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'eng', 'sub', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(dir, 'score.mjs'), 'export const s = 3;\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), DOC);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const DOC = [
  '# prereg x', '',
  '```prereg-sets',
  'gate    x',
  'engine  eng',
  'scorer  score.mjs',
  'key     @k1',
  'seeds   order bootstrap',
  '```', '',
  BEGIN, '*Not registered.*', END, '',
].join('\n');

test('parseSets reads the block and refuses what is not a plain path or name', () => {
  const s = parseSets(DOC);
  assert.equal(s.gate, 'x');
  assert.deepEqual(s.sets, [{ name: 'engine', entries: ['eng'] }, { name: 'scorer', entries: ['score.mjs'] }, { name: 'key', entries: ['@k1'] }]);
  assert.deepEqual(s.seeds, ['order', 'bootstrap']);
  for (const bad of ['../x', '/etc/passwd', 'src/', './src', '-rf', 'a\\b']) assert.throws(() => parseSets(DOC.replace('eng\n', `${bad}\n`)), /plain repository path/);
  assert.throws(() => parseSets('no block'), /prereg-sets/);
  assert.throws(() => parseSets(DOC.replace('gate    x\n', '')), /no gate/);
});

test('a set hash is the sha256 of its sha256sum listing, read from git; keys are their bytes', t => {
  const dir = repo(t);
  const keyFile = join(dir, '..', `${dir.split(/[\\/]/).pop()}-key.json`);
  writeFileSync(keyFile, '{"defects": []}\n');
  t.after(() => rmSync(keyFile, { force: true }));
  const r = computeHashes({ repo: dir, spec: parseSets(DOC), keys: { k1: keyFile } });
  const eng = `${sha('export const a = 1;\n')}  eng/a.mjs\n${sha('export const b = 2;\n')}  eng/sub/b.mjs\n`;
  assert.deepEqual(r.rows.map(x => [x.set, x.files]), [['engine', 2], ['scorer', 1], ['key', 1]]);
  assert.equal(r.rows[0].hash, sha(eng));
  assert.equal(r.rows[1].hash, sha(`${sha('export const s = 3;\n')}  score.mjs\n`));
  assert.equal(r.keys[0].hash, sha('{"defects": []}\n'));
  assert.equal(r.rows[2].hash, sha(`${sha('{"defects": []}\n')}  @k1\n`));
  assert.equal(listing([{ path: 'b', sha: '2' }, { path: 'a', sha: '1' }]), '1  a\n2  b\n');
  // the same listing a person gets with git ls-files and sha256sum
  if (spawnSync('sha256sum', ['--version']).status === 0) {
    const manual = execFileSync('sh', ['-c', 'git ls-files -z -- eng | xargs -0 sha256sum | sha256sum'], { cwd: dir, encoding: 'utf8' }).split(' ')[0];
    assert.equal(manual, r.rows[0].hash);
  }
  // seeds: whole numbers from the hashes, the same every time, different per name
  assert.ok(r.seeds.every(s => Number.isInteger(s.value) && s.value >= 0 && s.value < 2 ** 32));
  assert.notEqual(r.seeds[0].value, r.seeds[1].value);
  assert.deepEqual(computeHashes({ repo: dir, spec: parseSets(DOC), keys: { k1: keyFile } }).seeds, r.seeds);
});

test('a folder key is its own git repository, hashed like a set with its paths under @name/', t => {
  const dir = repo(t);
  const app = mkdtempSync(join(tmpdir(), 'nunchi-prereg-app-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, 'src'));
  writeFileSync(join(app, 'src', 'page.jsx'), 'export default () => null;\n');
  writeFileSync(join(app, 'bench.json'), '{}\n');
  const spec = parseSets(DOC);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: app } }), /not the top of a git repository/);
  git(app, 'init', '-q', '-b', 'main'); git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'app');
  const r = computeHashes({ repo: dir, spec, keys: { k1: app } });
  const list = `${sha('{}\n')}  @k1/bench.json\n${sha('export default () => null;\n')}  @k1/src/page.jsx\n`;
  assert.deepEqual(r.keys, [{ name: 'k1', files: 2, hash: sha(list) }]);
  assert.equal(r.rows.find(x => x.set === 'key').hash, sha(list));
  assert.equal(readRegistered(fillDoc(DOC, renderBlock(r))).keys[0].files, 2);
  writeFileSync(join(app, 'src', 'page.jsx'), 'changed\n');
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: app } }), /differs from HEAD/);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: join(dir, 'eng') } }), /not the top of a git repository/);
});

test('refuses a dirty or untracked file under a hashed path, a missing path, and missing or unknown keys', t => {
  const dir = repo(t);
  const spec = parseSets(DOC.replace('key     @k1\n', ''));
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'changed\n');
  assert.throws(() => computeHashes({ repo: dir, spec }), /differs from HEAD.*eng\/a\.mjs/);
  git(dir, 'checkout', '--', 'eng/a.mjs');
  writeFileSync(join(dir, 'eng', 'new.mjs'), 'x\n');
  assert.throws(() => computeHashes({ repo: dir, spec }), /eng\/new\.mjs/);
  rmSync(join(dir, 'eng', 'new.mjs'));
  writeFileSync(join(dir, 'docs', 'notes.md'), 'a doc outside every set changes nothing\n');
  assert.equal(computeHashes({ repo: dir, spec }).rows.length, 2);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(DOC.replace('score.mjs', 'bench/precision-gate.mjs').replace('key     @k1\n', '')) }), /bench\/precision-gate\.mjs is not in the repository/);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(DOC) }), /--key k1=<path>/);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { other: join(dir, 'score.mjs') } }), /names no key @other/);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(DOC), keys: { k1: join(dir, 'nothing-here.json') } }), /cannot read/);
});

test('fill, read back, check: the block round-trips; a changed engine file is a mismatch', t => {
  const dir = repo(t);
  const spec = parseSets(DOC.replace('key     @k1\n', ''));
  const r = computeHashes({ repo: dir, spec });
  const doc = fillDoc(DOC, renderBlock(r, 'docs/prereg-x.md'));
  assert.ok(doc.startsWith('# prereg x'));
  assert.ok(!doc.includes('*Not registered.*'));
  assert.equal(fillDoc(doc, renderBlock(r, 'docs/prereg-x.md')), doc);         // filling again changes nothing
  const reg = readRegistered(doc);
  assert.deepEqual(compare(reg, r), []);
  assert.equal(readRegistered(DOC), null);
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'export const a = 2;\n');
  git(dir, 'commit', '-q', '-am', 'tune the engine');
  const diffs = compare(reg, computeHashes({ repo: dir, spec }));
  assert.ok(diffs.some(d => d.startsWith('set engine: registered')));
  assert.ok(diffs.some(d => d.startsWith('seed order: registered')));           // the seeds move with the hashes
  assert.ok(!diffs.some(d => d.startsWith('set scorer')));
  assert.throws(() => fillDoc('no markers', 'x'), /exactly one/);
});

test('every pre-registration in docs/ parses, names its own gate, shares one engine set and has one hash block', () => {
  const docs = new URL('../docs/', import.meta.url);
  const files = readdirSync(docs).filter(n => /^prereg-.+\.md$/.test(n) && n !== 'prereg-README.md' && n !== 'prereg-time.md').sort();
  for (const n of ['prereg-codex.md', 'prereg-decision-time.md', 'prereg-field.md', 'prereg-fix.md', 'prereg-heldout.md', 'prereg-precision.md']) assert.ok(files.includes(n), `${n} is there`);
  const engines = new Set();
  for (const n of files) {
    const text = readFileSync(new URL(n, docs), 'utf8');
    const spec = parseSets(text);
    assert.equal(`prereg-${spec.gate}.md`, n);
    engines.add(spec.sets.find(s => s.name === 'engine').entries.join(' '));
    assert.ok(spec.sets.find(s => s.name === 'scorer').entries.includes('scripts/prereg-stats.mjs'), `${n}: the scorer set holds the stats helper`);
    assert.equal(text.split(BEGIN).length, 2, `${n}: one hash block`);
    assert.equal(text.split(END).length, 2, `${n}: one hash block`);
  }
  assert.equal(engines.size, 1, 'every gate hashes the same engine');
});

test('the command line: --check exits 2 unregistered, 0 after --fill, 1 after a change; --fill refuses to re-register', t => {
  const dir = repo(t);
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), DOC.replace('key     @k1\n', ''));
  git(dir, 'commit', '-q', '-am', 'no key');
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--repo', dir, ...a], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('--check', 'docs/prereg-x.md').status, 2);
  const filled = run('--fill', 'docs/prereg-x.md');
  assert.equal(filled.status, 0, filled.stderr);
  assert.match(readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8'), /\| engine \| 2 \| `[0-9a-f]{64}` \|/);
  const ok = run('--check', 'docs/prereg-x.md');
  assert.equal(ok.status, 0, ok.stderr);
  git(dir, 'commit', '-q', '-am', 'register');
  writeFileSync(join(dir, 'score.mjs'), 'export const s = 4;\n');
  git(dir, 'commit', '-q', '-am', 'change the scorer after registering');
  const bad = run('--check', 'docs/prereg-x.md');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /set scorer: registered [0-9a-f]{64}, now [0-9a-f]{64}/);
  assert.equal(run('--fill', 'docs/prereg-x.md').status, 1);
  assert.equal(run('--fill', 'docs/prereg-x.md', '--again').status, 0);
});
