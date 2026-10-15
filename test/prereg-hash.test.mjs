import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parseSets, computeHashes, deriveSeeds, renderBlock, readRegistered, compare, fillDoc, listing, isRepoTop, toLf,
  docBody, docHash, amendments, appendAmendment, main, BEGIN, END,
} from '../scripts/prereg-hash.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/prereg-hash.mjs', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const CHAIN = 'a'.repeat(64);
const RANDOMNESS = 'b'.repeat(64);
const noBareLf = text => !/(^|[^\r])\n/.test(text);

// a small repository: an engine folder, a scorer file and the pre-registration doc (in no set)
function repo(t, doc = DOC) {
  const dir = mkdtempSync(join(tmpdir(), 'nunchi-prereg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'eng', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'eng', 'sub', 'b.mjs'), 'export const b = 2;\n');
  writeFileSync(join(dir, 'score.mjs'), 'export const s = 3;\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n*.log\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), doc);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const DOC = [
  '# prereg x', '',
  'Pass iff k ≥ 48.', '',
  '```prereg-sets',
  'gate    x',
  'engine  eng',
  'scorer  score.mjs',
  'key     @k1',
  'seeds   order bootstrap',
  `beacon  drand ${CHAIN} 1000`,
  '```', '',
  BEGIN, '*Not registered.*', END, '',
  '## 9. Amendment policy', '', 'The common policy holds.', '',
].join('\n');
const NOKEY = DOC.replace('key     @k1\n', '');
const run = (dir, ...a) => spawnSync(process.execPath, [SCRIPT, '--repo', dir, ...a], { cwd: dir, encoding: 'utf8' });

test('parseSets reads the block and refuses what is not a plain path or name, repeated lines and taken names', () => {
  const s = parseSets(DOC);
  assert.equal(s.gate, 'x');
  assert.deepEqual(s.sets, [{ name: 'engine', entries: ['eng'] }, { name: 'scorer', entries: ['score.mjs'] }, { name: 'key', entries: ['@k1'] }]);
  assert.deepEqual(s.seeds, ['order', 'bootstrap']);
  assert.deepEqual(s.beacon, { chain: CHAIN, round: 1000 });
  assert.deepEqual(parseSets(DOC.replace(' 1000\n', ' ROUND\n')).beacon, { chain: CHAIN, round: null });
  for (const bad of ['../x', '/etc/passwd', 'src/', './src', '-rf', 'a\\b']) assert.throws(() => parseSets(DOC.replace('eng\n', `${bad}\n`)), /plain repository path/);
  assert.throws(() => parseSets('no block'), /prereg-sets/);
  assert.throws(() => parseSets(DOC.replace('gate    x\n', '')), /no gate/);
  assert.throws(() => parseSets(DOC.replace('gate    x\n', 'gate    x\ngate    y\n')), /gate twice/);
  assert.throws(() => parseSets(DOC.replace('seeds   order bootstrap\n', 'seeds   order\nseeds   bootstrap\n')), /two seeds lines/);
  assert.throws(() => parseSets(DOC.replace(`beacon  drand ${CHAIN} 1000\n`, `beacon  drand ${CHAIN} 1000\nbeacon  drand ${CHAIN} 2000\n`)), /two beacon lines/);
  assert.throws(() => parseSets(DOC.replace(`beacon  drand ${CHAIN} 1000\n`, '')), /need a beacon line/);
  assert.throws(() => parseSets(DOC.replace(' 1000\n', ' soon\n')), /beacon: drand/);
  assert.throws(() => parseSets(DOC.replace('scorer  score.mjs', 'doc     score.mjs')), /not a set name/);
});

test('a set hash is the sha256 of its sha256sum listing, read from git; keys are their bytes; seeds need the beacon', t => {
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
  // the same listing a person gets with git ls-files and sha256sum, on every platform: `-b` makes Linux, macOS and Git
  // Bash on Windows (whose default is binary, printed as `*`) all print the `*` marker, and sed makes it two spaces
  if (spawnSync('sha256sum', ['--version']).status === 0) {
    const manual = execFileSync('sh', ['-c', "git ls-files -z -- eng | xargs -0 sha256sum -b | sed 's/ \\*/  /' | sha256sum"], { cwd: dir, encoding: 'utf8' }).split(' ')[0];
    assert.equal(manual, r.rows[0].hash);
  }
  // seeds: whole numbers from the hashes and the beacon, the same every time, different per name and per beacon
  const seeds = deriveSeeds('x', r.rows, ['order', 'bootstrap'], RANDOMNESS);
  assert.ok(seeds.every(s => Number.isInteger(s.value) && s.value >= 0 && s.value < 2 ** 32));
  assert.notEqual(seeds[0].value, seeds[1].value);
  assert.deepEqual(deriveSeeds('x', r.rows, ['order', 'bootstrap'], RANDOMNESS), seeds);
  assert.notDeepEqual(deriveSeeds('x', r.rows, ['order', 'bootstrap'], 'c'.repeat(64)), seeds);
  assert.throws(() => deriveSeeds('x', r.rows, ['order'], 'not hex'), /randomness as hex/);
});

test('the doc row: the registered rules, without the hash block and without a final ## Amendments section', () => {
  const filled = fillDoc(DOC, 'a table');
  assert.equal(docHash(filled), docHash(DOC), 'filling the block does not change the rules');
  assert.notEqual(docHash(DOC.replace('k ≥ 48', 'k ≥ 47')), docHash(DOC), 'a changed rule changes the doc row');
  const amended = appendAmendment(DOC, '| 2026-10-16 09:00 KST | scoring | a typo |');
  assert.equal(docHash(amended), docHash(DOC), 'an amendment row does not');
  assert.deepEqual(amendments(amended), ['| 2026-10-16 09:00 KST | scoring | a typo |']);
  assert.equal(amendments(appendAmendment(amended, '| 2026-10-17 09:00 KST | x | y |')).length, 2);
  assert.equal(amendments(DOC).length, 0);
  assert.match(docBody(DOC), /## 9\. Amendment policy/, 'the numbered policy section is a rule, not the log');
  assert.throws(() => docHash(`${amended}\n## Later section\n`), /last section/);
});

test('a folder key is its own git repository, hashed like a set with its paths under @name/', t => {
  const dir = repo(t);
  const app = mkdtempSync(join(tmpdir(), 'nunchi-prereg-app-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, 'src'));
  writeFileSync(join(app, 'src', 'page.jsx'), 'export default () => null;\n');
  writeFileSync(join(app, 'bench.json'), '{}\n');
  writeFileSync(join(app, '.gitignore'), 'node_modules\n');
  const spec = parseSets(DOC);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: app } }), /not the top of a git repository/);
  git(app, 'init', '-q', '-b', 'main'); git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'app');
  const r = computeHashes({ repo: dir, spec, keys: { k1: app } });
  const list = `${sha('node_modules\n')}  @k1/.gitignore\n${sha('{}\n')}  @k1/bench.json\n${sha('export default () => null;\n')}  @k1/src/page.jsx\n`;
  assert.deepEqual(r.keys, [{ name: 'k1', files: 3, hash: sha(list) }]);
  assert.equal(r.rows.find(x => x.set === 'key').hash, sha(list));
  assert.equal(readRegistered(fillDoc(DOC, renderBlock(r, { spec: parseSets(DOC) }))).keys[0].files, 3);
  // the app's installed dependencies are ignored and rebuilt from its lockfile: allowed
  mkdirSync(join(app, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'dep', 'index.js'), '0\n');
  assert.deepEqual(computeHashes({ repo: dir, spec, keys: { k1: app } }).keys, r.keys);
  // another spelling of the same folder (on Windows the temp folder itself is a short 8.3 name such as RUNNER~1; a
  // junction, which Windows makes without privileges and Linux takes as a link, stands in for it here) is still its top
  const other = `${app}-other-spelling`;
  symlinkSync(app, other, 'junction');
  t.after(() => rmSync(other, { force: true }));
  assert.equal(isRepoTop(other), true);
  assert.deepEqual(computeHashes({ repo: dir, spec, keys: { k1: other } }).keys, r.keys);
  writeFileSync(join(app, 'src', 'page.jsx'), 'changed\n');
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: app } }), /differs from HEAD/);
  assert.equal(isRepoTop(join(dir, 'eng')), false);
  assert.equal(isRepoTop(join(dir, '.git')), false);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { k1: join(dir, 'eng') } }), /not the top of a git repository/);
});

test('refuses a dirty, untracked or ignored file under a hashed path, a missing path, and missing or unknown keys', t => {
  const dir = repo(t);
  const spec = parseSets(NOKEY);
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'changed\n');
  assert.throws(() => computeHashes({ repo: dir, spec }), /differs from HEAD.*eng\/a\.mjs/);
  git(dir, 'checkout', '--', 'eng/a.mjs');
  writeFileSync(join(dir, 'eng', 'new.mjs'), 'x\n');
  assert.throws(() => computeHashes({ repo: dir, spec }), /eng\/new\.mjs/);
  rmSync(join(dir, 'eng', 'new.mjs'));
  writeFileSync(join(dir, 'eng', 'debug.log'), 'ignored, but it would sit beside the engine\n');
  assert.throws(() => computeHashes({ repo: dir, spec }), /!! eng\/debug\.log/);
  rmSync(join(dir, 'eng', 'debug.log'));
  // another doc, in no set and not the pre-registration, changes nothing
  writeFileSync(join(dir, 'docs', 'notes.md'), 'an unrelated note\n');
  assert.equal(computeHashes({ repo: dir, spec }).rows.length, 2);
  // the pre-registration itself is a row (H2): its rules change the doc row
  const doc = readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8');
  assert.notEqual(computeHashes({ repo: dir, spec, doc }).rows[0].hash, computeHashes({ repo: dir, spec, doc: doc.replace('48', '47') }).rows[0].hash);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(NOKEY.replace('score.mjs', 'bench/precision-gate.mjs')) }), /bench\/precision-gate\.mjs is not in the repository/);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(DOC) }), /--key k1=<path>/);
  assert.throws(() => computeHashes({ repo: dir, spec, keys: { other: join(dir, 'score.mjs') } }), /names no key @other/);
  assert.throws(() => computeHashes({ repo: dir, spec: parseSets(DOC), keys: { k1: join(dir, 'nothing-here.json') } }), /cannot read/);
});

test('fill, read back, check: the block round-trips; a changed engine file is a mismatch', t => {
  const dir = repo(t);
  const spec = parseSets(NOKEY);
  const r = computeHashes({ repo: dir, spec, doc: NOKEY });
  const doc = fillDoc(NOKEY, renderBlock(r, { docPath: 'docs/prereg-x.md', spec }));
  assert.ok(doc.startsWith('# prereg x'));
  assert.ok(!doc.includes('*Not registered.*'));
  assert.match(doc, /Seeds \(order, bootstrap\): \*\*pending\*\*/);
  assert.equal(fillDoc(doc, renderBlock(r, { docPath: 'docs/prereg-x.md', spec })), doc);
  const reg = readRegistered(doc);
  assert.deepEqual(reg.rows.map(x => x.set), ['doc', 'engine', 'scorer']);
  assert.deepEqual(compare(reg, r), []);
  assert.equal(readRegistered(NOKEY), null);
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'export const a = 2;\n');
  git(dir, 'commit', '-q', '-am', 'tune the engine');
  const diffs = compare(reg, computeHashes({ repo: dir, spec, doc }));
  assert.ok(diffs.some(d => d.startsWith('set engine: registered')));
  assert.ok(!diffs.some(d => d.startsWith('set scorer') || d.startsWith('set doc')));
  assert.throws(() => fillDoc('no markers', 'x'), /exactly one/);
});

test('every pre-registration in docs/ parses, names its own gate, shares one engine set, has one hash block and an Amendments log', () => {
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
    assert.equal(toLf(text).split(BEGIN).length, 2, `${n}: one hash block`);
    assert.equal(toLf(text).split(END).length, 2, `${n}: one hash block`);
    assert.doesNotThrow(() => docHash(text), `${n}: ## Amendments is the last section`);
    assert.match(toLf(text), /^## Amendments$/m, `${n}: an Amendments log`);
    if (spec.seeds.length) assert.ok(spec.beacon, `${n}: its seeds wait for a beacon round`);
  }
  assert.equal(engines.size, 1, 'every gate hashes the same engine');
});

test('the command line: --check exits 2 unregistered, 0 after --fill (with the amendment count), 1 after a change to the engine or to the rules', t => {
  const dir = repo(t, NOKEY);
  assert.equal(run(dir, '--check', 'docs/prereg-x.md').status, 2);
  const filled = run(dir, '--fill', 'docs/prereg-x.md');
  assert.equal(filled.status, 0, filled.stderr);
  const text = readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8');
  assert.match(text, /\| doc \| 1 \| `[0-9a-f]{64}` \|/);
  assert.match(text, /\| engine \| 2 \| `[0-9a-f]{64}` \|/);
  const ok = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /seeds pending \(drand round 1000\)\); 0 amendments/);
  git(dir, 'commit', '-q', '-am', 'register');
  // a rule changed after registration: --check fails on the doc row
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), text.replace('k ≥ 48', 'k ≥ 47'));
  const ruled = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(ruled.status, 1);
  assert.match(ruled.stderr, /set doc: registered [0-9a-f]{64}, now [0-9a-f]{64} \(the doc changed outside ## Amendments\)/);
  // writing in ## Amendments is allowed and counted
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), appendAmendment(text, '| 2026-10-16 09:00 KST | note | a clarification asked by a labeller |'));
  const counted = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(counted.status, 0, counted.stderr);
  assert.match(counted.stdout, /1 amendment$/m);
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), text);
  writeFileSync(join(dir, 'score.mjs'), 'export const s = 4;\n');
  git(dir, 'commit', '-q', '-am', 'change the scorer after registering');
  const bad = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /set scorer: registered [0-9a-f]{64}, now [0-9a-f]{64}/);
  // a new registration needs --again and a reason, and is logged
  assert.equal(run(dir, '--fill', 'docs/prereg-x.md').status, 1);
  assert.equal(run(dir, '--fill', 'docs/prereg-x.md', '--again').status, 1, '--again alone is not enough');
  const again = run(dir, '--fill', 'docs/prereg-x.md', '--again', '--reason', 'the scorer | had a bug');
  assert.equal(again.status, 0, again.stderr);
  const log = amendments(readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8'));
  assert.equal(log.length, 1);
  assert.match(log[0], /^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST \| re-registered at commit [0-9a-f]{12} \| the scorer \/ had a bug \|$/);
  assert.match(run(dir, '--check', 'docs/prereg-x.md').stdout, /1 amendment$/m);
});

test('seeds: only after the registration is pushed, from the named beacon round; a new registration needs a later round', t => {
  const dir = repo(t, NOKEY.replace(' 1000\n', ' ROUND\n'));
  const fillUnset = run(dir, '--fill', 'docs/prereg-x.md');
  assert.equal(fillUnset.status, 2);
  assert.match(fillUnset.stderr, /set the beacon round first/);
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), NOKEY);
  assert.equal(run(dir, '--fill', 'docs/prereg-x.md').status, 0);
  assert.match(run(dir, '--seeds', 'docs/prereg-x.md', '--beacon', RANDOMNESS).stderr, /commit and push the registration first/);
  git(dir, 'commit', '-q', '-am', 'register');
  assert.match(run(dir, '--seeds', 'docs/prereg-x.md', '--beacon', RANDOMNESS).stderr, /HEAD is on no remote branch/);
  const remote = mkdtempSync(join(tmpdir(), 'nunchi-prereg-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'fetch', '-q', 'origin');
  assert.match(run(dir, '--seeds', 'docs/prereg-x.md').stderr, /give drand round 1000's randomness/);
  const seeded = run(dir, '--seeds', 'docs/prereg-x.md', '--beacon', RANDOMNESS);
  assert.equal(seeded.status, 0, seeded.stderr);
  const text = readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8');
  const reg = readRegistered(text);
  assert.deepEqual(reg.beacon, { chain: CHAIN, round: 1000, randomness: RANDOMNESS });
  assert.deepEqual(reg.seeds, deriveSeeds('x', reg.rows, ['order', 'bootstrap'], RANDOMNESS));
  const ok = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 seeds\); 0 amendments/);
  // a seed typed over by hand is caught
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), text.replace(`| order | ${reg.seeds[0].value} |`, '| order | 7 |'));
  assert.match(run(dir, '--check', 'docs/prereg-x.md').stderr, /seed order: registered 7/);
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), text);
  assert.equal(run(dir, '--seeds', 'docs/prereg-x.md', '--beacon', 'c'.repeat(64)).status, 1, 'seeds are drawn once');
  // re-registering after the seeds were drawn needs a later beacon round (no grinding on a known randomness)
  writeFileSync(join(dir, 'eng', 'a.mjs'), 'export const a = 9;\n');
  git(dir, 'commit', '-q', '-am', 'engine fix');
  const sameRound = run(dir, '--fill', 'docs/prereg-x.md', '--again', '--reason', 'engine fix');
  assert.equal(sameRound.status, 1);
  assert.match(sameRound.stderr, /needs a later round/);
  writeFileSync(join(dir, 'docs', 'prereg-x.md'), text.replace(`${CHAIN} 1000`, `${CHAIN} 1200`));
  assert.equal(run(dir, '--fill', 'docs/prereg-x.md', '--again', '--reason', 'engine fix').status, 0);
  assert.match(readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8'), /\*\*pending\*\*/);
});

test('a doc with CRLF line endings (a Windows checkout) parses, fills and checks like LF, and keeps its CRLF', t => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  assert.deepEqual(parseSets(crlf), parseSets(DOC));
  assert.equal(docHash(crlf), docHash(DOC));
  const dir = repo(t);
  const spec = parseSets(NOKEY);
  const r = computeHashes({ repo: dir, spec, doc: NOKEY });
  const crlfNoKey = NOKEY.replace(/\n/g, '\r\n');
  const filled = fillDoc(crlfNoKey, renderBlock(r, { docPath: 'docs/prereg-x.md', spec }));
  assert.ok(noBareLf(filled), 'no bare LF in a CRLF doc');
  assert.equal(filled, fillDoc(NOKEY, renderBlock(r, { docPath: 'docs/prereg-x.md', spec })).replace(/\n/g, '\r\n'));
  assert.deepEqual(readRegistered(filled), readRegistered(toLf(filled)));
  assert.deepEqual(compare(readRegistered(filled), computeHashes({ repo: dir, spec, doc: filled })), []);
  assert.equal(fillDoc(filled, renderBlock(r, { docPath: 'docs/prereg-x.md', spec })), filled);
  assert.ok(noBareLf(appendAmendment(filled, '| 2026-10-16 09:00 KST | x | y |')), 'an amendment keeps CRLF');
  assert.equal(/\r/.test(fillDoc(DOC, 'x')), false, 'an LF doc stays LF');
});

test('a checkout with core.autocrlf=true (CRLF in the working tree) hashes the same as an LF checkout, and --check holds', t => {
  const dir = repo(t, NOKEY);
  const spec = parseSets(NOKEY);
  const lf = computeHashes({ repo: dir, spec, doc: NOKEY });
  git(dir, 'config', 'core.autocrlf', 'true');
  for (const f of ['eng/a.mjs', 'eng/sub/b.mjs', 'score.mjs', 'docs/prereg-x.md']) rmSync(join(dir, f));
  git(dir, 'checkout', '--', '.');
  assert.equal(readFileSync(join(dir, 'eng', 'a.mjs'), 'utf8'), 'export const a = 1;\r\n', 'the working tree has CRLF now');
  const crlfDoc = readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8');
  assert.deepEqual(computeHashes({ repo: dir, spec, doc: crlfDoc }).rows, lf.rows);
  const filled = run(dir, '--fill', 'docs/prereg-x.md');
  assert.equal(filled.status, 0, filled.stderr);
  assert.ok(noBareLf(readFileSync(join(dir, 'docs', 'prereg-x.md'), 'utf8')), 'the filled doc keeps CRLF');
  const ok = run(dir, '--check', 'docs/prereg-x.md');
  assert.equal(ok.status, 0, ok.stderr);
});

test('run through a link or junction (H1), the command still runs: a missing doc exits nonzero, never 0', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nunchi-prereg-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const linked = join(dir, 'scripts');
  symlinkSync(dirname(SCRIPT), linked, 'junction');
  const viaLink = spawnSync(process.execPath, [join(linked, 'prereg-hash.mjs'), '--check', join(dir, 'no-such-doc.md')], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(viaLink.status, 0);
  assert.match(viaLink.stderr, /no-such-doc\.md/);
  const stats = spawnSync(process.execPath, [join(linked, 'prereg-stats.mjs'), 'min', '56', '0.75', '--sides', '1'], { cwd: dir, encoding: 'utf8' });
  assert.equal(stats.status, 0, stats.stderr);
  assert.match(stats.stdout, /^48\/56/);
  // and imported as a module, nothing runs
  const logs = [];
  assert.throws(() => main(['--check', join(dir, 'no-such-doc.md')], { log: m => logs.push(m) }), /ENOENT/);
  assert.deepEqual(logs, []);
});
