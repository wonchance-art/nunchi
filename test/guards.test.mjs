// Built-in guards (design 0.1-c §5, spec §7.3): a fixture that triggers each guard and one of near misses that does
// not; the places a guard never reads; guards.json validated strictly; the baseline keyed by content; a guard removed
// or weakened since a ref. Synthetic fixtures only (test/fixtures/guards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../src/guards.mjs';

const FIX = fileURLToPath(new URL('./fixtures/guards/', import.meta.url));
const TOKENS = { colors: ['#1f2937', '#ffffff', 'rgb(37, 99, 235)'], deltaE: 0.03 };
const paramsOf = kind => (kind === 'colour-literal' ? TOKENS : G.defaultParams(kind));
const guardsOf = kinds => kinds.map(kind => ({ kind, params: paramsOf(kind) }));
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-guards-')));
const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const fixture = (kind, name) => readFileSync(join(FIX, kind, name), 'utf8');
// the lines a fixture marks with "HIT <kind>"
const marked = (text, kind) => text.split('\n').map((l, i) => (l.includes(`HIT ${kind}`) ? i + 1 : 0)).filter(Boolean);

const CASES = [
  ['native-dialog', 'hit.tsx', 'miss.tsx'],
  ['dead-href', 'hit.tsx', 'miss.tsx'],
  ['raw-message', 'hit.tsx', 'miss.tsx'],
  ['mustache-text', 'hit.tsx', 'miss.tsx'],
  ['colour-literal', 'hit.tsx', 'miss.tsx'],
  ['colour-literal', 'hit.css', 'miss.css'],
];

for (const [kind, hitFile, missFile] of CASES) {
  test(`${kind} (${hitFile}): every marked line is one hit, and nothing else is`, () => {
    const p = tmp();
    const text = fixture(kind, hitFile);
    put(p, `app/${hitFile}`, text);
    const r = G.scanGuards({ project: p, guards: guardsOf(G.KINDS) });
    const mine = r.hits.filter(h => h.kind === kind);
    assert.ok(marked(text, kind).length >= 3);
    assert.deepEqual(mine.map(h => h.line), marked(text, kind), JSON.stringify(mine));
    assert.ok(mine.every(h => h.file === `app/${hitFile}` && /^[0-9a-f]{16}$/.test(h.anchor) && h.column >= 1));
    assert.deepEqual(r.unparsed, []);
  });
  test(`${kind} (${missFile}): near misses give no hit`, () => {
    const p = tmp();
    put(p, `app/${missFile}`, fixture(kind, missFile));
    const r = G.scanGuards({ project: p, guards: guardsOf([kind]) });
    assert.deepEqual(r.hits, []);
    assert.deepEqual(r.unparsed, []);
    assert.equal(r.files, 1);
  });
}

test('a guard runs only for its own kind and parameters', () => {
  const p = tmp();
  put(p, 'app/a.tsx', fixture('native-dialog', 'hit.tsx'));
  put(p, 'app/b.tsx', fixture('dead-href', 'hit.tsx'));
  const only = G.scanGuards({ project: p, guards: [{ kind: 'native-dialog', params: { calls: ['alert'] } }, { kind: 'dead-href', params: { values: ['javascript:'] } }] });
  assert.deepEqual(only.hits.map(h => `${h.kind}:${h.what}`), ['native-dialog:alert', 'native-dialog:alert', 'dead-href:javascript:', 'dead-href:javascript:']);
  assert.deepEqual(G.scanGuards({ project: p, guards: [] }), { hits: [], files: 0, large: [], unparsed: [], odd: [] });
});

test('tests, fixtures, config files, node_modules, dot folders and symbolic links are never read; a route called test is', () => {
  const p = tmp();
  const hit = fixture('native-dialog', 'hit.tsx');
  for (const rel of ['node_modules/pkg/index.js', 'app/page.test.tsx', 'app/__tests__/x.tsx', 'tests/e2e.spec.ts', 'test/helpers.tsx', 'e2e/flow.ts',
    'app/x.stories.tsx', 'next.config.mjs', 'app/theme.config.ts', '.cache/x.tsx', 'dist/app.js', 'coverage/x.js', '.nunchi/x.tsx', 'cypress/x.ts']) put(p, rel, hit);
  put(p, 'app/test/page.tsx', hit);
  mkdirSync(join(p, 'outside'));
  put(p, 'outside/linked.tsx', hit);
  try { symlinkSync(join(p, 'outside'), join(p, 'app', 'linked'), 'dir'); symlinkSync(join(p, 'outside', 'linked.tsx'), join(p, 'app', 'one.tsx')); } catch {}
  const r = G.scanGuards({ project: p, root: join(p, 'app'), guards: guardsOf(['native-dialog']) });
  assert.deepEqual([...new Set(r.hits.map(h => h.file))], ['app/test/page.tsx']);
  assert.equal(r.hits.length, 6);
});

test('files over 1 MB are skipped and counted; a file that does not parse is listed, never a hit', () => {
  const p = tmp();
  put(p, 'app/big.js', `// generated\n${'const x = 1;\n'.repeat(Math.ceil((1024 * 1024) / 13) + 10)}alert('x');\n`);
  put(p, 'app/broken.tsx', 'export default function () { return <p>{alert("x")</p> }\n');
  put(p, 'app/ok.tsx', "alert('x');\n");
  const r = G.scanGuards({ project: p, guards: guardsOf(['native-dialog']) });
  assert.deepEqual(r.large, ['app/big.js']);
  assert.deepEqual(r.unparsed.map(u => u.file), ['app/broken.tsx']);
  assert.ok(!/alert/.test(JSON.stringify(r.unparsed)), 'no source text in the reason');
  assert.deepEqual(r.hits.map(h => h.file), ['app/ok.tsx']);
  assert.equal(r.files, 2);
});

test('a scan is deterministic: the same tree gives the same hits, in file order', () => {
  const p = tmp();
  for (const [kind, f] of [['dead-href', 'hit.tsx'], ['native-dialog', 'hit.tsx'], ['colour-literal', 'hit.css']]) put(p, `app/z-${kind}-${f}`, fixture(kind, f));
  const a = G.scanGuards({ project: p, guards: guardsOf(G.KINDS) });
  const b = G.scanGuards({ project: p, guards: guardsOf([...G.KINDS].reverse()) });
  assert.deepEqual(a, b);
  assert.deepEqual([...a.hits.map(h => h.file)], [...a.hits.map(h => h.file)].sort());
});

test('colour literals: named colours, hsl() and hwb() are read; ΔE and alpha decide what a token covers', () => {
  assert.ok(G.literalColour('tomato'));
  assert.ok(G.literalColour('hsl(0 100% 50%)'));
  assert.ok(G.literalColour('hsla(120, 50%, 50%, 0.5)'));
  assert.ok(G.literalColour('hwb(0 0% 0%)'));
  assert.equal(G.literalColour('rgb(var(--x))'), null);
  assert.deepEqual(G.coloursIn('1px solid #abc, 0 0 0 4px rgb(0 0 0 / 50%)').map(c => c.text), ['#abc', 'rgb(0 0 0 / 50%)']);
  assert.deepEqual(G.coloursIn('url(#ff0000) var(--x, #fff) "#123"').map(c => c.text), []);
  assert.deepEqual(G.coloursIn('Tomato', { named: false }), []);
  const p = tmp();
  put(p, 'app/a.css', '.a { color: #1f2938; }\n.b { color: rgb(31 41 55 / 0.5); }\n');
  const r = G.scanGuards({ project: p, guards: [{ kind: 'colour-literal', params: TOKENS }] });
  assert.deepEqual(r.hits.map(h => h.line), [2], 'one step off the token is the token; half transparent is not');
  assert.deepEqual(G.tokenColours({ colors: [{ value: 'rgb(31, 41, 55)' }, { value: 'evil;}' }, { value: 'rgb(31, 41, 55)' }] }), { colors: ['rgb(31, 41, 55)'], deltaE: 0.03 });
});

// ---- guards.json ----------------------------------------------------------------------------------------------------

const GOOD = () => ({ schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['confirm'] } }], baseline: [{ kind: 'native-dialog', file: 'app/a.tsx', anchor: '0123456789abcdef', count: 1, what: 'confirm' }] });
test('guards.json: typed parameters only; anything else is a state error, never a silent pass', () => {
  assert.deepEqual(G.validateGuards(GOOD()), GOOD());
  const bad = [
    d => { d.extra = 1; },
    d => { d.schema = 2; },
    d => { d.guards[0].params.calls = ['confirm', 'eval']; },
    d => { d.guards[0].params.regex = 'confirm\\('; },
    d => { d.guards[0].selector = 'CallExpression'; },
    d => { d.guards.push({ kind: 'native-dialog', params: { calls: ['alert'] } }); },
    d => { d.guards.push({ kind: 'no-eval', params: {} }); },
    d => { d.guards.push({ kind: 'raw-message', params: { pattern: '.*' } }); },
    d => { d.guards.push({ kind: 'colour-literal', params: { colors: ['red; } body { display:none'], deltaE: 0.03 } }); },
    d => { d.guards.push({ kind: 'colour-literal', params: { colors: ['#fff'], deltaE: 5 } }); },
    d => { d.baseline[0].file = '../outside.tsx'; },
    d => { d.baseline[0].file = '/etc/passwd'; },
    d => { d.baseline[0].file = 'app\\a.tsx'; },
    d => { d.baseline[0].anchor = 'xyz'; },
    d => { d.baseline[0].count = 0; },
    d => { d.baseline[0].line = 3; },
    d => { d.baseline[0].kind = 'dead-href'; },
    d => { d.baseline.push({ ...d.baseline[0] }); },
    d => { d.baseline[0].what = 'x'.repeat(200); },
    d => { d.guards = {}; },
  ];
  for (const change of bad) {
    const d = GOOD();
    change(d);
    assert.throws(() => G.validateGuards(d), e => e.code === 'CORRUPT', String(change));
  }
  assert.throws(() => G.parseGuards('{"schema":1,'), e => e.code === 'CORRUPT');
  assert.throws(() => G.parseGuards('[]'), e => e.code === 'CORRUPT');
});

test('guards.json on disk: missing is none; a link or a folder is refused; written sorted and stable', () => {
  const p = tmp();
  const path = join(p, '.nunchi', 'guards.json');
  assert.equal(G.readGuards(path), null);
  mkdirSync(path, { recursive: true });
  assert.throws(() => G.readGuards(path), e => e.code === 'CORRUPT');
  const q = tmp();
  writeFileSync(join(q, 'real.json'), JSON.stringify(GOOD()));
  mkdirSync(join(q, '.nunchi'));
  try {
    symlinkSync(join(q, 'real.json'), join(q, '.nunchi', 'guards.json'));
    assert.throws(() => G.readGuards(join(q, '.nunchi', 'guards.json')), e => e.code === 'UNSAFE_PATH');
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  const out = join(tmp(), 'guards.json');
  const doc = { schema: 1, guards: [{ kind: 'dead-href', params: { values: ['javascript:', '#'] } }, { kind: 'native-dialog', params: { calls: ['prompt', 'alert'] } }], baseline: [] };
  G.writeGuards(out, doc);
  const text = readFileSync(out, 'utf8');
  assert.equal(text, `${JSON.stringify({ baseline: [], guards: [{ kind: 'native-dialog', params: { calls: ['alert', 'prompt'] } }, { kind: 'dead-href', params: { values: ['#', 'javascript:'] } }], schema: 1 }, null, 2)}\n`);
  assert.deepEqual(G.readGuards(out), G.validateGuards(doc));
});

// ---- the baseline ---------------------------------------------------------------------------------------------------

test('the baseline is keyed by file and content: moved lines stay baselined, a new or changed hit is new', () => {
  const p = tmp();
  put(p, 'app/a.tsx', "export function A() {\n  if (window.confirm('Remove?')) go();\n  alert('Done');\n}\n");
  const guards = guardsOf(['native-dialog']);
  const base = G.baselineOf(G.scanGuards({ project: p, guards }).hits);
  assert.deepEqual(base.map(e => `${e.file}:${e.count}:${e.what}`).sort(), ['app/a.tsx:1:alert', 'app/a.tsx:1:confirm']);
  // ten lines added above: nothing is new
  put(p, 'app/a.tsx', `${'// note\n'.repeat(10)}export function A() {\n  if (window.confirm('Remove?'))   go();\n  alert('Done');\n}\n`);
  let c = G.compareBaseline(G.scanGuards({ project: p, guards }).hits, base);
  assert.equal(c.fresh.length, 0);
  assert.equal(c.known.length, 2);
  // the same call once more: one new hit; the text of one changed: a new hit and a gone entry
  put(p, 'app/a.tsx', "export function A() {\n  if (window.confirm('Remove?')) go();\n  alert('Done');\n  alert('Done');\n  alert('Saved');\n}\n");
  c = G.compareBaseline(G.scanGuards({ project: p, guards }).hits, base);
  assert.deepEqual(c.fresh.map(h => h.line), [4, 5]);
  put(p, 'app/a.tsx', "export function A() {\n  if (window.confirm('Delete?')) go();\n  alert('Done');\n}\n");
  c = G.compareBaseline(G.scanGuards({ project: p, guards }).hits, base);
  assert.deepEqual(c.fresh.map(h => h.what), ['confirm']);
  assert.deepEqual(c.gone.map(e => [e.what, e.now]), [['confirm', 0]]);
  // the same content in another file is another file's hit
  put(p, 'app/b.tsx', "export function A() {\n  if (window.confirm('Remove?')) go();\n  alert('Done');\n}\n");
  c = G.compareBaseline(G.scanGuards({ project: p, guards }).hits, base);
  assert.ok(c.fresh.some(h => h.file === 'app/b.tsx'));
});

test('anchors survive a formatter: reflowed lines, quote style, parentheses, comments, classes moved beside a colour', () => {
  const anchors = (files, kinds = G.KINDS) => {
    const p = tmp();
    for (const [rel, text] of Object.entries(files)) put(p, rel, text);
    return G.scanGuards({ project: p, guards: guardsOf(kinds) }).hits.map(h => `${h.kind} ${h.anchor}`).sort();
  };
  const before = {
    'app/a.tsx': [
      "export function A({ error, open }: any) {",
      "  if (window.confirm('Remove this fern?')) go();",
      '  return <div className="p-2 bg-[#abcdef] rounded" style={{ color: "#ff0000", boxShadow: "0 1px 2px rgba(0,0,0,.5)" }}>',
      '    <a href="#">Home</a><p>{error.message}</p><p>Hello &#123;&#123;name&#125;&#125; and welcome</p>',
      '  </div>;',
      '}',
    ].join('\n'),
    'app/a.css': '.card{color:#F00;box-shadow:0 0 0 1px rgba(0,0,0,.5)}\n',
  };
  const after = {
    'app/a.tsx': [
      '// formatted',
      'export function A({ error, open }: any) {',
      '  if (',
      '    window.confirm(',
      '      "Remove this fern?", // asked once',
      '    )',
      '  )',
      '    go();',
      '  return (',
      '    <div',
      '      className="rounded bg-[#ABCDEF] p-4"',
      "      style={{ color: '#ff0000', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.5)' }}",
      '    >',
      "      <a href='#'>Home</a>",
      '      <p>{(error).message}</p>',
      '      <p>',
      '        Hello &#123;&#123;name&#125;&#125;',
      '        and welcome',
      '      </p>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
    'app/a.css': '.card {\n  color: #f00;\n  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);\n}\n',
  };
  const a = anchors(before), b = anchors(after);
  assert.equal(a.length, 9, a.join('\n'));
  assert.deepEqual(b, a);
  // what the hit is changes its anchor: other words in the dialog, another colour
  const changed = anchors({ ...before, 'app/a.tsx': before['app/a.tsx'].replace('Remove this fern?', 'Delete this fern?').replace('#abcdef', '#abcdee') });
  assert.equal(changed.filter(x => !a.includes(x)).length, 2);
});

test('adding a guard baselines what is there; widening it baselines only what it adds', () => {
  const p = tmp();
  put(p, 'app/a.tsx', "alert('a');\nconfirm('b');\nprompt('c');\n");
  let r = G.addGuard(G.emptyGuards(), { project: p, kind: 'native-dialog', params: { calls: ['confirm'] } });
  assert.deepEqual(r.added, { calls: ['confirm'] });
  assert.deepEqual(r.doc.baseline.map(e => e.what), ['confirm']);
  // a new confirm appears, then the guard is widened to alert: the new confirm is not baselined by the widening
  put(p, 'app/a.tsx', "alert('a');\nconfirm('b');\nprompt('c');\nconfirm('new');\n");
  r = G.addGuard(r.doc, { project: p, kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } });
  assert.deepEqual(r.added, { calls: ['alert'] });
  assert.deepEqual(r.doc.guards, [{ kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } }]);
  const c = G.compareBaseline(G.scanGuards({ project: p, guards: r.doc.guards }).hits, r.doc.baseline);
  assert.deepEqual(c.fresh.map(h => h.line), [4]);
  // nothing to add: unchanged
  assert.equal(G.addGuard(r.doc, { project: p, kind: 'native-dialog', params: { calls: ['confirm'] } }).added, null);
  // removing what the widening added takes its baseline entries with it
  const back = G.removeGuard(r.doc, { kind: 'native-dialog', params: { calls: ['alert'] }, entries: r.baselined });
  assert.deepEqual(back.doc.guards, [{ kind: 'native-dialog', params: { calls: ['confirm'] } }]);
  assert.deepEqual(back.doc.baseline.map(e => e.what), ['confirm']);
  assert.deepEqual(G.removeGuard(back.doc, { kind: 'native-dialog' }).doc, G.emptyGuards());
  assert.throws(() => G.addGuard(G.emptyGuards(), { project: p, kind: 'native-dialog', params: { calls: ['eval'] } }), e => e.code === 'BAD_ARGS');
});

test('weakened since a ref: a removed guard, fewer calls, more allowed colours, a baseline that grew', () => {
  const before = G.validateGuards({ schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert', 'confirm'] } }, { kind: 'dead-href', params: { values: ['#'] } }, { kind: 'colour-literal', params: TOKENS }],
    baseline: [{ kind: 'native-dialog', file: 'app/a.tsx', anchor: '0123456789abcdef', count: 1 }] });
  assert.deepEqual(G.weakenedSince(before, before), []);
  assert.deepEqual(G.weakenedSince(null, before), []);
  const after = G.validateGuards({ schema: 1, guards: [{ kind: 'native-dialog', params: { calls: ['alert'] } }, { kind: 'colour-literal', params: { colors: [...TOKENS.colors, '#ff0000'], deltaE: 0.05 } }, { kind: 'raw-message', params: {} }],
    baseline: [{ kind: 'native-dialog', file: 'app/a.tsx', anchor: '0123456789abcdef', count: 2 }, { kind: 'native-dialog', file: 'app/b.tsx', anchor: 'fedcba9876543210', count: 1 }, { kind: 'raw-message', file: 'app/c.tsx', anchor: '00000000000000aa', count: 3 }] });
  const w = G.weakenedSince(before, after);
  assert.deepEqual(w.map(x => `${x.kind}:${x.why}`), ['native-dialog:narrowed', 'dead-href:removed', 'colour-literal:narrowed', 'native-dialog:baseline', 'native-dialog:baseline']);
  assert.deepEqual(w.filter(x => x.why === 'baseline').map(x => [x.file, x.count]), [['app/a.tsx', 1], ['app/b.tsx', 1]]);
});

test('the lint proposal: core rules only, one separate object scoped to files, the replace warning; plugins only when installed', () => {
  const doc = { guards: guardsOf(['native-dialog', 'dead-href', 'raw-message', 'mustache-text', 'colour-literal']) };
  const r = G.lintProposal({ guards: doc.guards, pkg: { devDependencies: { eslint: '9.0.0' } } });
  assert.match(r.text, /^\/\/ nunchi guards as ESLint core rules/);
  assert.match(r.text, /files: \['\*\*\/\*\.\{js,jsx,mjs,cjs,ts,tsx,mts,cts\}'\]/);
  assert.match(r.text, /'no-alert': 'error'/);
  assert.match(r.text, /'no-restricted-syntax': \['error',/);
  assert.match(r.text, /replaces this list instead of adding to it/);
  assert.match(r.text, /never writes your config/);
  assert.ok(!/jsx-a11y|stylelint|toMatchAriaSnapshot/.test(r.text + r.notes.join('\n')), 'nothing proposed that is not installed');
  assert.ok(r.notes.some(n => /colour literals/.test(n)));
  const next = G.lintProposal({ guards: doc.guards, pkg: { dependencies: { 'eslint-config-next': '16.4.1', '@playwright/test': '1.0.0' }, devDependencies: { stylelint: '16', 'stylelint-declaration-strict-value': '1' } } });
  assert.ok(next.notes.some(n => /jsx-a11y\/anchor-is-valid/.test(n)));
  assert.ok(next.notes.some(n => /declaration-strict-value/.test(n)));
  assert.ok(next.notes.some(n => /toMatchAriaSnapshot/.test(n)));
  // the snippet is a JavaScript object literal
  assert.doesNotThrow(() => new Function(`return (${r.text.split('\n').filter(l => !l.startsWith('//')).join('\n').replace(/,\s*$/, '')});`)());
});

test('the offer of a fixed kind: what was fixed, in the design\'s words', () => {
  assert.equal(G.guardKindOf({ rule: 'native-dialog', evidence: { type: 'confirm' } }), 'native-dialog');
  assert.equal(G.guardKindOf({ rule: 'dead-href', evidence: { href: '#' } }), 'dead-href');
  assert.equal(G.guardKindOf({ rule: 'raw-error-text' }), 'raw-message');
  assert.equal(G.guardKindOf({ rule: 'L6.raw-technical-text' }), 'raw-message');
  assert.equal(G.guardKindOf({ rule: 'missing-value', evidence: { kind: 'unreplaced {{…}}' } }), 'mustache-text');
  assert.equal(G.guardKindOf({ rule: 'missing-value', evidence: { kind: 'undefined' } }), null);
  assert.equal(G.guardKindOf({ rule: 'clipped-text' }), null);
  assert.deepEqual(G.paramsFromRows('native-dialog', [{ evidence: { type: 'confirm' } }]), { calls: ['confirm'] });
  assert.equal(G.labelOf('native-dialog', { calls: ['confirm'] }), '`window.confirm`');
  assert.equal(G.labelOf('dead-href', G.paramsFromRows('dead-href', [{ evidence: { href: '#' } }])), '`href="#"`');
  assert.equal(G.labelOf('native-dialog', { calls: ['alert', 'confirm'] }), '`alert` / `window.confirm`');
});

// ---- across platforms (Windows' rules checked on Linux through path.win32) ------------------------------------------------

test('paths in guards.json have forward slashes on every platform; Windows\' D:\\ and D:/ alike, another drive or .. is outside', () => {
  const W = path.win32, X = path.posix;
  assert.equal(G.projectPath('D:\\a\\shelf', 'D:\\a\\shelf\\app\\x.tsx', W), 'app/x.tsx');
  assert.equal(G.projectPath('D:\\a\\shelf', 'D:/a/shelf/app/x.tsx', W), 'app/x.tsx');
  assert.equal(G.projectPath('D:/a/shelf', 'd:\\a\\shelf\\app\\[id]\\page.tsx', W), 'app/[id]/page.tsx');
  assert.equal(G.projectPath('D:\\a\\shelf', 'E:\\a\\shelf\\x.tsx', W), null, 'another drive');
  assert.equal(G.projectPath('D:\\a\\shelf', 'D:\\a\\other\\x.tsx', W), null);
  assert.equal(G.projectPath('/a/shelf', '/a/shelf/app/x.tsx', X), 'app/x.tsx');
  assert.equal(G.projectPath('/a/shelf', '/a/shelf/app/a\\b.tsx', X), null, 'a backslash POSIX allows in a name');
  assert.equal(G.projectPath('/a/shelf', '/a/shelf/app/a\u202eb.tsx', X), null, 'a bidi override');
  assert.equal(G.projectPath('/a/shelf', '/a/shelf', X), null);
  assert.ok(G.insideProject('D:\\a\\shelf', 'D:/a/shelf/app', W) && G.insideProject('D:\\a\\shelf', 'D:\\a\\shelf', W) && G.insideProject('/a/shelf', '/a/shelf/..fern', X));
  assert.ok(!G.insideProject('D:\\a\\shelf', 'E:\\a\\shelf', W) && !G.insideProject('/a/shelf', '/a/other', X) && !G.insideProject('/a/shelf', '/a', X));
});

test('a file whose name a baseline cannot keep is listed and never read (POSIX names may hold a backslash)', { skip: process.platform === 'win32' && 'Windows names cannot hold a backslash (the rule itself is checked through path.win32 above)' }, () => {
  const p = tmp();
  put(p, 'app/odd\\name.tsx', "alert('x');\n");
  put(p, 'app/ok.tsx', "alert('x');\n");
  const r = G.scanGuards({ project: p, guards: guardsOf(['native-dialog']) });
  assert.deepEqual(r.odd, ['app/odd\\\\name.tsx']);
  assert.deepEqual(r.hits.map(h => h.file), ['app/ok.tsx']);
  const doc = G.addGuard(G.emptyGuards(), { project: p, kind: 'native-dialog', params: { calls: ['alert'] } }).doc;
  assert.deepEqual(doc.baseline.map(e => e.file), ['app/ok.tsx'], 'the baseline stays valid');
});

test('line endings: a CRLF checkout (Git for Windows\' core.autocrlf) gives the same hits, lines, columns and anchors as LF', () => {
  for (const [kind, f] of CASES.flatMap(([k, h, m]) => [[k, h], [k, m]])) {
    const lf = fixture(kind, f);
    const p = tmp(), q = tmp();
    put(p, `app/${f}`, lf);
    put(q, `app/${f}`, lf.replace(/\n/g, '\r\n'));
    const a = G.scanGuards({ project: p, guards: guardsOf(G.KINDS) }), b = G.scanGuards({ project: q, guards: guardsOf(G.KINDS) });
    assert.deepEqual(b.hits, a.hits, `${kind} ${f}`);
    assert.deepEqual(b.unparsed, []);
  }
});
