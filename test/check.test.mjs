// `nunchi check` (design 0.1-c §5, spec §7.3): what CI runs. Guards only when there is no ledger ("ledger: absent"),
// a new hit fails and a baselined one does not, a malformed guards file or --fail-on without a ledger is exit 2 (never
// 0), a guard removed or weakened since --base fails, open findings at or above --fail-on fail when a ledger exists,
// and --sarif writes a file valid against the vendored schema. Nothing else is written. Synthetic projects only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, writeRun, scene } from './fixtures/board-project.mjs';
import { sarifProblems } from './fixtures/sarif/validate.mjs';
import * as G from '../src/guards.mjs';
import { guardsAt, fetchHint } from '../src/check.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-check-xdg-');
const gitIn = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
const put = (root, rel, text) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const check = (cwd, ...args) => spawnSync(process.execPath, [CLI, 'check', ...args], { cwd, encoding: 'utf8' });

// a git repository with an app and (optionally) a guards file baselined on what is there
function repo({ guards = null } = {}) {
  const root = tmp('nunchi-check-');
  gitIn(root, 'init', '-q');
  put(root, 'package.json', '{"name":"fern-shelf","private":true}\n');
  put(root, 'app/remove.tsx', "export function Remove() {\n  return <button onClick={() => window.confirm('Remove this fern?')}>Remove</button>;\n}\n");
  put(root, 'app/nav.tsx', 'export const Nav = () => <a href="/ferns">Ferns</a>;\n');
  if (guards) {
    let doc = G.emptyGuards();
    for (const g of guards) doc = G.addGuard(doc, { project: root, kind: g.kind, params: g.params ?? G.defaultParams(g.kind) }).doc;
    G.writeGuards(join(root, '.nunchi', 'guards.json'), doc);
  }
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'base');
  return root;
}

test('no guards and no ledger: clean, says ledger: absent, writes nothing', () => {
  const root = repo();
  const r = check(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /guards: none/);
  assert.match(r.stdout, /^ledger: absent \(guards only\)$/m);
  assert.match(r.stdout, /^exit 0: clean$/m);
  assert.ok(!existsSync(join(root, '.nunchi')), 'no .nunchi folder made');
  assert.ok(!existsSync(join(root, '.git', 'nunchi')), 'no state made');
});

test('a hit in the baseline passes; a new hit fails with file:line:column; the output is the same every time', () => {
  const root = repo({ guards: [{ kind: 'native-dialog' }, { kind: 'dead-href' }] });
  const ok = check(root);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /new guard hits: 0/);
  assert.match(ok.stdout, /baselined: 1 /);
  put(root, 'app/nav.tsx', 'export const Nav = () => <nav><a href="#">Ferns</a>{alert(1)}</nav>;\n');
  const bad = check(root);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /new guard hits: 2/);
  assert.match(bad.stdout, /^  app\/nav\.tsx:1:\d+  `href="#"`$/m);
  assert.match(bad.stdout, /^  app\/nav\.tsx:1:\d+  `alert`$/m);
  assert.match(bad.stdout, /^exit 1: 2 guard hits$/m);
  assert.equal(check(root).stdout, bad.stdout);
  const j = JSON.parse(check(root, '--json').stdout);
  assert.equal(j.code, 1);
  assert.deepEqual(j.hits.new.map(h => h.kind).sort(), ['dead-href', 'native-dialog']);
  assert.deepEqual(j.ledger, { present: false });
  // fixed: the baselined one gone too → clean, and the baseline can be tightened
  put(root, 'app/nav.tsx', 'export const Nav = () => <a href="/ferns">Ferns</a>;\n');
  put(root, 'app/remove.tsx', 'export const Remove = () => <button>Remove</button>;\n');
  const clean = check(root);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /gone from the baseline: 1 \(nunchi guard --baseline/);
});

test('a malformed guards file, an unknown --base, bad usage: exit 2, never 0', () => {
  const root = repo({ guards: [{ kind: 'native-dialog' }] });
  for (const [text, why] of [['{"schema":1,"guards":[{"kind":"native-dialog","params":{"regex":"x"}}],"baseline":[]}', /params of native-dialog/], ['{nope', /not valid JSON/],
    ['{"schema":1,"guards":[],"baseline":[],"selector":"*"}', /only "schema", "guards" and "baseline"/]]) {
    writeFileSync(join(root, '.nunchi', 'guards.json'), text);
    const r = check(root);
    assert.equal(r.status, 2, text);
    assert.match(r.stderr, why);
  }
  gitIn(root, 'checkout', '--', '.nunchi/guards.json');
  for (const args of [['--fail-on', 'critical'], ['--fail-on'], ['--sarif'], ['--base', 'no-such-ref'], ['--base', '--fail-on'], ['extra'], ['--base', '-x']]) {
    const r = check(root, ...args);
    assert.equal(r.status, 2, args.join(' '));
  }
});

test('--fail-on without a ledger exits 2; with one, open findings at or above it fail', () => {
  const root = repo();
  const none = check(root, '--fail-on', 'high');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /needs nunchi's ledger, and there is none here/);
  // a ledger on this machine: one high and one low finding, as capture leaves them
  const sc = scene('/', 'guest', 'normal', 'd');
  writeRun(root, '0001', { scenes: [sc], findings: [
    { lens: 'L6', rule: 'raw-error-text', severity: 'high', scene: sc.id, route: '/', viewport: 'd', selector: 'main p', box: null, evidence: { text: 'TypeError: x' } },
    { lens: 'L8', rule: 'target-size-min', severity: 'low', scene: sc.id, route: '/', viewport: 'd', selector: 'nav a', box: null, evidence: { width: 12 } },
  ] });
  const f = spawnSync(process.execPath, [CLI, 'findings'], { cwd: root, encoding: 'utf8' });
  assert.equal(f.status, 0, f.stderr);
  const high = check(root, '--fail-on', 'high');
  assert.equal(high.status, 1, high.stdout + high.stderr);
  assert.match(high.stdout, /^ledger: run 0001 · 1 group at or above high still stands in the way \(1 high: nunchi findings\)$/m);
  assert.equal(check(root, '--fail-on', 'blocker').status, 0);
  const low = JSON.parse(check(root, '--fail-on', 'low', '--json').stdout);
  assert.equal(low.code, 1);
  assert.deepEqual(low.ledger.standing.map(g => g.severity), ['high', 'low']);
  assert.match(check(root).stdout, /^ledger: present, not judged \(--fail-on not given\)$/m);
  // a group decided Later still stands in the way ("Still counts for shipping")
  const g = low.ledger.standing.find(x => x.severity === 'low').group;
  const d = spawnSync(process.execPath, [CLI, 'decide', g, 'later', '--from-chat'], { cwd: root, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.equal(check(root, '--fail-on', 'low').status, 1, 'Later still counts for shipping');
});

test('--base: a guard removed, narrowed or with a grown baseline since the ref fails; an unchanged one passes', () => {
  const root = repo({ guards: [{ kind: 'native-dialog' }, { kind: 'dead-href' }] });
  const base = gitIn(root, 'rev-parse', 'HEAD').trim();
  assert.equal(check(root, '--base', base).status, 0);
  assert.match(check(root, '--base', 'HEAD').stdout, /since HEAD: no guard removed or weakened/);
  const path = join(root, '.nunchi', 'guards.json');
  const doc = G.readGuards(path);
  // removed
  G.writeGuards(path, G.removeGuard(doc, { kind: 'dead-href' }).doc);
  let r = check(root, '--base', base);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /since [0-9a-f]+: guard removed: `href="#"` \/ `javascript:` links/);
  // narrowed
  G.writeGuards(path, { ...doc, guards: doc.guards.map(g => (g.kind === 'native-dialog' ? { kind: g.kind, params: { calls: ['alert'] } } : g)) });
  r = check(root, '--base', base);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /guard weakened: .*\(`window\.confirm` \/ `window\.prompt`\)/);
  // the baseline grew: a new confirm accepted silently into it
  put(root, 'app/more.tsx', "export const More = () => { confirm('Again?'); return null; };\n");
  G.writeGuards(path, G.rebaseline(doc, { project: root }));
  assert.equal(check(root).status, 0, 'without --base the grown baseline passes');
  r = check(root, '--base', base, '--json');
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.weakened.map(w => [w.why, w.file]), [['baseline', 'app/more.tsx']]);
  // a base without guards.json: nothing to compare
  gitIn(root, 'checkout', '-q', '--orphan', 'empty');
  gitIn(root, 'read-tree', '--empty');
  gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal(check(root, '--base', 'empty').status, 0);
});

test('--base passes the legitimate changes: a widening from the card, git mv then --baseline, a reformat then --baseline', () => {
  const root = repo({ guards: [{ kind: 'native-dialog', params: { calls: ['confirm'] } }] });
  put(root, 'app/later.tsx', "export const Later = () => { alert('Saved'); return null; };\n");
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'an alert');
  const base = gitIn(root, 'rev-parse', 'HEAD').trim();
  const path = join(root, '.nunchi', 'guards.json');
  // the card's widening: alert taken on, the alert there now baselined with it
  G.writeGuards(path, G.addGuard(G.readGuards(path), { project: root, kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } }).doc);
  let r = check(root, '--base', base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no guard removed or weakened/);
  // a file moved, and the baseline set again
  gitIn(root, 'mv', 'app/remove.tsx', 'app/fern-remove.tsx');
  G.writeGuards(path, G.rebaseline(G.readGuards(path), { project: root }));
  r = check(root, '--base', base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // reformatted (lines reflowed, quotes changed), and the baseline set again
  put(root, 'app/fern-remove.tsx', 'export function Remove() {\n  return (\n    <button onClick={() => window.confirm("Remove this fern?")}>\n      Remove\n    </button>\n  );\n}\n');
  G.writeGuards(path, G.rebaseline(G.readGuards(path), { project: root }));
  r = check(root, '--base', base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // and a new confirm taken into the baseline still fails
  put(root, 'app/again.tsx', "export const Again = () => { window.confirm('Again?'); return null; };\n");
  G.writeGuards(path, G.rebaseline(G.readGuards(path), { project: root }));
  r = check(root, '--base', base);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ {2}since [0-9a-f]+: baseline grew: app\/again\.tsx \(`window\.confirm`, \+1\)$/m);
});

test('--sarif: new hits and weakened guards as results, valid against the vendored schema, repo-relative paths', () => {
  const root = repo({ guards: [{ kind: 'native-dialog' }, { kind: 'dead-href' }] });
  const base = gitIn(root, 'rev-parse', 'HEAD').trim();
  put(root, 'app/nav.tsx', 'export const Nav = () => <a href="#">Ferns</a>;\n');
  const path = join(root, '.nunchi', 'guards.json');
  G.writeGuards(path, G.removeGuard(G.readGuards(path), { kind: 'native-dialog' }).doc);
  const out = join(tmp('nunchi-check-out-'), 'check.sarif');
  const r = check(root, '--base', base, '--sarif', out);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^SARIF → .*check\.sarif \(2 results\)$/m);
  const log = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(sarifProblems(log), []);
  const res = log.runs[0].results;
  assert.deepEqual(res.map(x => [x.ruleId, x.locations[0].physicalLocation.artifactLocation.uri, x.locations[0].physicalLocation.region.startLine]).sort(),
    [['nunchi.guard/dead-href', 'app/nav.tsx', 1], ['nunchi.guard/native-dialog', '.nunchi/guards.json', 1]]);
  assert.ok(res.every(x => x.level === 'error' && x.partialFingerprints['nunchi/fp/v1']));
  // the app in a subfolder of the repository: the subfolder is in the path
  const outer = tmp('nunchi-check-outer-');
  gitIn(outer, 'init', '-q');
  put(outer, 'web/app/a.tsx', "alert('x');\n");
  G.writeGuards(join(outer, 'web', '.nunchi', 'guards.json'), { schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert'] } }], baseline: [] });
  const out2 = join(tmp('nunchi-check-out-'), 'sub.sarif');
  assert.equal(check(join(outer, 'web'), '--sarif', out2).status, 1);
  assert.equal(JSON.parse(readFileSync(out2, 'utf8')).runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'web/app/a.tsx');
});

test('--base reads the blob by git\'s own path (forward slashes, the prefix git gives), never a checkout or a local path', () => {
  const calls = [];
  const doc = { schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['confirm'] } }], baseline: [] };
  const C = 'a'.repeat(40), B = 'b'.repeat(40);
  const fake = (args, opts = {}) => {
    calls.push(args.join(' '));
    assert.equal(opts.env?.GIT_NO_LAZY_FETCH, '1', 'never a lazy fetch');
    if (args[0] === 'rev-parse' && args.includes('--show-prefix')) return 'web/\n';
    if (args[0] === 'rev-parse') return `${C}\n`;
    if (args[0] === 'ls-tree') return `100644 blob ${B}\tweb/.nunchi/guards.json\0`;
    if (args[0] === 'cat-file' && args[1] === 'blob') return JSON.stringify(doc);
    if (args[0] === 'remote') return 'origin\nupstream\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  // the project's own path in Windows' spelling does not reach git: only the prefix git printed does
  assert.deepEqual(guardsAt('D:\\a\\repo\\web', 'origin/main', { git: fake }), G.validateGuards(doc));
  assert.deepEqual(calls, ['rev-parse --verify --quiet --end-of-options origin/main^{commit}', 'rev-parse --show-prefix', `ls-tree -z --full-tree ${C} -- web/.nunchi/guards.json`, `cat-file blob ${B}`]);
  const none = (args, o) => (args[0] === 'ls-tree' ? '' : fake(args, o));
  assert.equal(guardsAt('/repo', 'main', { git: none }), null, 'no guards file in the ref\'s tree');
  // a partial clone: the tree lists the file, the blob is not here. An error (exit 2), never "no guards file then"
  const blobless = (args, o) => { if (args[0] === 'cat-file') throw new Error('fatal: missing blob object'); return fake(args, o); };
  assert.throws(() => guardsAt('/repo', 'main', { git: blobless }), e => e.code === 'BAD_STATE' && /not in this clone/.test(e.message));
  const treeless = (args, o) => { if (args[0] === 'ls-tree') throw new Error('fatal: not a tree object'); return fake(args, o); };
  assert.throws(() => guardsAt('/repo', 'main', { git: treeless }), e => e.code === 'BAD_STATE');
  const link = (args, o) => (args[0] === 'ls-tree' ? `120000 blob ${B}\tweb/.nunchi/guards.json\0` : fake(args, o));
  assert.throws(() => guardsAt('/repo', 'main', { git: link }), e => e.code === 'BAD_STATE' && /not a plain file/.test(e.message));
  for (const bad of ['-x', '', 'a b', 'x\ny']) assert.throws(() => guardsAt('/repo', bad, { git: fake }), e => e.code === 'BAD_ARGS', JSON.stringify(bad));
  // an unknown ref: the fetch hint names the remote's branch, not the remote-tracking name
  const unknown = (args, o) => { if (args[0] === 'rev-parse') throw new Error('not a commit'); return fake(args, o); };
  assert.throws(() => guardsAt('/repo', 'origin/main', { git: unknown }), e => e.code === 'BAD_STATE' && /git fetch --depth=1 origin main\)$/.test(e.message));
  assert.throws(() => guardsAt('/repo', 'upstream/release/2', { git: unknown }), e => /git fetch --depth=1 upstream release\/2\)$/.test(e.message));
  assert.equal(fetchHint('main'), 'git fetch --depth=1 origin main');
  assert.equal(fetchHint('refs/remotes/origin/main'), 'git fetch --depth=1 origin main');
  assert.equal(fetchHint('refs/heads/main'), 'git fetch --depth=1 origin main');
});

test('check reads only: the project tree is the same after it', () => {
  const root = repo({ guards: [{ kind: 'native-dialog' }] });
  const before = gitIn(root, 'status', '--porcelain', '--ignored');
  check(root, '--json');
  check(root, '--base', 'HEAD');
  assert.equal(gitIn(root, 'status', '--porcelain', '--ignored'), before);
  assert.deepEqual(readdirSync(join(root, '.nunchi')), ['guards.json']);
});
