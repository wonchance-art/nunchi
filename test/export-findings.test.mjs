// `nunchi export --format md|json|sarif` (design 0.1-c §5, spec §7.4): redaction of every field at export time
// (selectors, paths, claim quotes, route params, notes, URLs), page text only with --include-page-text, Markdown
// escaping with no raw HTML, repo-relative locations and route templates, SARIF against the vendored schema, and
// byte-identical Markdown and JSON across two runs. Synthetic project, invented content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync, cpSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeRun, withAi, scene, tmp, HOSTILE } from './fixtures/board-project.mjs';
import { sarifProblems, githubProblems } from './fixtures/sarif/validate.mjs';
import { mdText } from '../src/export-findings.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
process.env.XDG_STATE_HOME = tmp('nunchi-export-f-xdg-');
// secret-shaped strings assembled here, so no secret-shaped literal is committed
const STRIPE = 'sk_' + 'live_' + 'FixtureOnly0000000000000003';
const GHP = 'gh' + 'p_' + 'FixtureOnlyFixtureOnlyFixtureOnly0042';
const AWS = 'AK' + 'IA' + 'FIXTUREONLY00042';
const SECRETS = [STRIPE, GHP, AWS, 'Hunter2Token'];
const MD_LINK = '[click me](https://evil.invalid/x) ![pic](https://evil.invalid/p.png) **bold** # head';

function project({ git = true } = {}) {
  const root = tmp('nunchi-export-f-');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fern-shelf', private: true, dependencies: { next: '15.0.0' } }));
  for (const f of ['app/page.tsx', 'app/garden/page.tsx', 'app/account/page.tsx']) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), 'export default function Page() { return <main />; }\n'); }
  const s = {
    home: scene('/', 'guest', 'normal', 'd'), garden: scene('/garden', 'guest', 'error', 'd'), account: scene('/account', 'signed-in', 'normal', 'd'),
    reset: scene(`/reset/${STRIPE}`, 'guest', 'normal', 'd'),
  };
  const f = (lens, rule, severity, sc, selector, evidence) => ({ lens, rule, severity, scene: sc.id, route: sc.route, viewport: sc.viewport, selector, box: null, evidence });
  const findings = [
    { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/assets/app-4f1c2a9b.js?token=Hunter2Token', kind: 'stripe-live-secret-key' } },
    f('L6', 'raw-error-text', 'high', s.garden, 'main p.err', { text: `TypeError: ${HOSTILE} ${MD_LINK} ${GHP}` }),
    f('L7', 'dead-href', 'low', s.home, `main > a#k-${STRIPE}`, { href: '#', name: 'Read more' }),
    f('L8', 'target-size-min', 'medium', s.account, 'button:has-text("Delete account of Ana Fern")', { width: 12, height: 12, minimum: 24, name: 'Delete account of Ana Fern' }),
    f('L1', 'horizontal-overflow', 'high', s.reset, 'html', { scrollWidth: 1400, viewportWidth: 1280 }),
    f('L9', 'native-dialog', 'medium', s.home, null, { type: 'confirm', message: `Delete ${AWS}?` }),
  ];
  const { findings: ann } = writeRun(root, '0001', { scenes: Object.values(s), findings });
  const p = { root, nunchi: join(root, '.nunchi'), findings: ann, scenes: s };
  withAi(p, [{ lens: 'L6', rule: 'L6.raw-technical-text', scene: s.garden, selector: 'main p.err', claim: `Shows "${HOSTILE}" and ${STRIPE} ${MD_LINK}`, file: 'app/garden/page.tsx', line: 7, status: 'confirmed', severity: 'high' },
    { lens: 'L5', rule: 'L5.same-action-different-verb', scene: s.home, selector: 'nav a', claim: 'Two verbs', file: `app/k-${GHP}/nav.tsx`, line: 3, status: 'confirmed', severity: 'low' },
    { lens: 'L6', rule: 'L6.vague-error', scene: s.home, selector: 'main p', claim: 'Vague', file: 'https://evil.invalid/x.tsx', line: 9, status: 'confirmed', severity: 'low' }]);
  return p;
}
const run = (p, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: p.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
const groupOf = (p, rule) => p.findings.find(x => x.rule === rule).group;

test('JSON and Markdown: byte-identical across two runs; SARIF too', () => {
  const p = project();
  for (const fmt of ['json', 'md', 'sarif']) {
    const a = run(p, 'export', '--format', fmt), b = run(p, 'export', '--format', fmt);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(a.stdout, b.stdout, fmt);
    assert.ok(a.stdout.length > 200);
  }
});

test('redaction: no secret-shaped string survives in any field of any format, with or without page text', () => {
  const p = project();
  const g = groupOf(p, 'dead-href');
  const d = run(p, 'decide', g, 'hold', '--note', `call ${GHP} about https://u:pw@x.invalid/?token=Hunter2Token`, '--from-chat');
  assert.equal(d.status, 0, d.stderr);
  for (const fmt of ['json', 'md', 'sarif']) for (const extra of [[], ['--include-page-text'], ['--status', 'all', '--include-page-text']]) {
    const r = run(p, 'export', '--format', fmt, ...extra);
    assert.equal(r.status, 0, r.stderr);
    for (const s of SECRETS) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s), `${fmt} ${extra.join(' ')} leaks ${s.slice(0, 6)}…`);
    assert.ok(!r.stdout.includes('u:pw@'), 'URL userinfo');
    assert.match(r.stdout, /secret\\?-shaped/);
  }
  const j = JSON.parse(run(p, 'export', '--format', 'json', '--include-page-text').stdout);
  const items = j.groups.flatMap(x => x.items.map(i => ({ ...i, rule: x.rule })));
  assert.match(items.find(i => i.rule === 'dead-href').element, /^main > a#k-\[secret-shaped: stripe-live-secret-key\]$/, 'the selector');
  assert.ok(items.some(i => /^\/reset\/\[secret-shaped: (stripe-live-secret-key|url-path-token)\]$/.test(i.route)), 'the route');
  assert.match(items.find(i => i.rule === 'dead-href').decision.note, /\[secret-shaped: github-token\]/);
  const secret = items.find(i => i.rule === 'secret-in-client-bundle');
  assert.deepEqual(Object.keys(secret.evidence).sort(), ['kind', 'url']);
  assert.match(secret.evidence.url, /token=REDACTED/);
  assert.match(items.find(i => i.rule === 'L6.raw-technical-text').evidence.claim, /\[secret-shaped: stripe-live-secret-key\]/, 'the claim quote');
  assert.deepEqual(items.find(i => i.rule === 'L5.same-action-different-verb').location, { path: 'app/k-[secret-shaped: github-token]/nav.tsx', line: 3, from: 'finding' }, 'a file path');
});

test('page text is left out by default: evidence text, claim quotes, control names from signed-in screens', () => {
  const p = project();
  const j = JSON.parse(run(p, 'export', '--format', 'json').stdout);
  assert.equal(j.pageText, false);
  assert.ok(j.counts.pageTextLeftOut >= 3);
  const items = j.groups.flatMap(x => x.items.map(i => ({ ...i, rule: x.rule })));
  const all = JSON.stringify(j);
  for (const t of ['TypeError', 'Ana Fern', 'Shows', 'Delete']) assert.ok(!all.includes(t), t);
  assert.equal(items.find(i => i.rule === 'L6.raw-technical-text').evidence.claim, undefined);
  assert.equal(items.find(i => i.rule === 'target-size-min').evidence.name, undefined, 'a signed-in control name');
  assert.equal(items.find(i => i.rule === 'target-size-min').element, 'button:has-text("…")', 'its name in the selector too');
  assert.equal(items.find(i => i.rule === 'dead-href').evidence.name, 'Read more', 'a visitor screen\'s control name stays');
  assert.deepEqual(items.find(i => i.rule === 'target-size-min').evidence, { height: 12, minimum: 24, width: 12 });
  const md = run(p, 'export', '--format', 'md');
  assert.match(md.stdout, /Page text is left out/);
  assert.match(md.stderr, /page text left out/);
  const withText = JSON.parse(run(p, 'export', '--format', 'json', '--include-page-text').stdout);
  assert.equal(withText.pageText, true);
  assert.match(JSON.stringify(withText), /Ana Fern/);
});

test('page text of signed-in screens: an AI aria= node keeps its role, a masked name and its states; a URL is left out; both counted', () => {
  const root = tmp('nunchi-export-f-aria-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fern-diary', private: true }));
  mkdirSync(join(root, 'app', 'account'), { recursive: true });
  writeFileSync(join(root, 'app', 'account', 'page.tsx'), 'export default function Page() { return <main />; }\n');
  const s = { acct: scene('/account', 'signed-in', 'normal', 'd'), home: scene('/', 'guest', 'normal', 'd') };
  const HASH = 'pkce_' + '9f8eAbC1d2E3f4G5h6I7j8K9L0mN', OOB = 'Q' + 'wErTy12UiOp34AsDf56GhJk78LzXc', CONFIRM = 'Zx9' + 'Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1';
  const f = (lens, rule, severity, sc, selector, evidence) => ({ lens, rule, severity, scene: sc.id, route: sc.route, viewport: sc.viewport, selector, box: null, evidence });
  writeRun(root, '0001', { scenes: Object.values(s), findings: [
    f('L3', 'link-to-missing-route', 'high', s.acct, 'main > a:nth-of-type(2)', { href: '/people/ana-fern-1987/diary?view=private', note: 'no route of the app matches this link' }),
    f('L7', 'dead-href', 'low', s.home, 'main > a.more', { href: `/verify?token_hash=${HASH}&oobCode=${OOB}&confirm=${CONFIRM}&reset_token=abc`, name: 'Read more' }),
  ] });
  const p = { root, nunchi: join(root, '.nunchi') };
  withAi(p, [
    { lens: 'L6', rule: 'L6.raw-technical-text', scene: s.acct, selector: 'aria=text: Welcome back, Ana Fern — balance 4,200', claim: 'Shows a balance', status: 'confirmed', severity: 'high' },
    { lens: 'L5', rule: 'L5.same-action-different-verb', scene: s.acct, selector: 'aria=group "Week 3": Ana dentist Tuesday', claim: 'Two verbs', status: 'confirmed', severity: 'low' },
    { lens: 'L6', rule: 'L6.vague-error', scene: s.acct, selector: 'aria=heading "Hello Ana" [level=1]', claim: 'Vague', status: 'confirmed', severity: 'medium' },
  ]);
  const items = j => Object.fromEntries(j.groups.flatMap(x => x.items.map(i => [x.rule, i])));
  const j = JSON.parse(run(p, 'export', '--format', 'json').stdout);
  const it = items(j);
  assert.equal(it['L6.raw-technical-text'].element, 'aria=text');
  assert.equal(it['L5.same-action-different-verb'].element, 'aria=group "…"');
  assert.equal(it['L6.vague-error'].element, 'aria=heading "…" [level=1]');
  assert.deepEqual(it['link-to-missing-route'].evidence, { note: 'no route of the app matches this link' }, 'a signed-in screen\'s link is page text');
  // three claims, three nodes, one link
  assert.equal(j.counts.pageTextLeftOut, 7);
  for (const fmt of ['json', 'md', 'sarif']) {
    const out = run(p, 'export', '--format', fmt).stdout;
    for (const t of ['Ana', 'Welcome', 'dentist', 'balance', 'Week 3', 'diary']) assert.ok(!out.includes(t), `${fmt}: ${t}`);
  }
  // a visitor's link stays, its credentials and random-looking values redacted
  assert.equal(it['dead-href'].evidence.href, '/verify?token_hash=REDACTED&oobCode=REDACTED&confirm=[secret-shaped: url-query-token]&reset_token=REDACTED');
  const all = items(JSON.parse(run(p, 'export', '--format', 'json', '--include-page-text').stdout));
  assert.equal(all['L5.same-action-different-verb'].element, 'aria=group "Week 3": Ana dentist Tuesday');
  assert.equal(all['link-to-missing-route'].evidence.href, '/people/ana-fern-1987/diary?view=private');
});

test('JSON is cleaned whole: an evidence key and the app\'s package.json path in a folder named like a key', () => {
  const outer = tmp('nunchi-export-f-deep-');
  execFileSync('git', ['init', '-q'], { cwd: outer });
  const root = join(outer, 'apps', `k-${GHP}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fern', private: true }));
  const sc = scene('/', 'guest', 'normal', 'd');
  const KEY = 'sk_' + 'live_' + 'KeyAsJsonKey00000000000007';
  writeRun(root, '0001', { scenes: [sc], findings: [
    { lens: 'L1', rule: 'horizontal-overflow', severity: 'high', scene: sc.id, route: sc.route, viewport: sc.viewport, selector: 'html', box: null, evidence: { scrollWidth: 1400, viewportWidth: 1280, [KEY]: 'v', nested: { [`k-${AWS}`]: 1 } } },
  ] });
  for (const extra of [[], ['--include-page-text']]) for (const fmt of ['json', 'md', 'sarif']) {
    const r = spawnSync(process.execPath, [CLI, 'export', '--format', fmt, ...extra], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const x of [GHP, KEY, AWS]) assert.ok(!r.stdout.includes(x), `${fmt} ${extra.join(' ')} leaks ${x.slice(0, 6)}…`);
  }
  const j = JSON.parse(spawnSync(process.execPath, [CLI, 'export', '--format', 'json', '--include-page-text'], { cwd: root, encoding: 'utf8' }).stdout);
  assert.equal(j.groups[0].items[0].location.path, 'apps/k-[secret-shaped: github-token]/package.json');
  assert.ok(Object.keys(j.groups[0].items[0].evidence).includes('[secret-shaped: stripe-live-secret-key]'));
});

test('Markdown: special characters escaped, no raw HTML, no link or image from data', () => {
  const p = project();
  const md = run(p, 'export', '--format', 'md', '--include-page-text').stdout;
  assert.match(md, /^# nunchi findings\n/);
  assert.ok(!/(^|[^\\])</.test(md), 'every < is escaped');
  assert.ok(!/(^|[^\\])\]\(/.test(md), 'no link or image');
  assert.ok(!md.includes('**bold**'));
  assert.ok(!/\n#+ [^\n]*head/.test(md.replace(/^## .*$/gm, '')), 'no heading from data');
  assert.ok(!/(^|[^\\])&#/.test(md), 'no entity from data');
  assert.equal(mdText('<img src=x onerror=alert(1)> [a](b) `c` *d* _e_ http://x.invalid a@b.invalid'), '\\<img src\\=x onerror\\=alert\\(1\\)\\> \\[a\\]\\(b\\) \\`c\\` \\*d\\* \\_e\\_ http\\://x\\.invalid a\\@b\\.invalid');
  assert.equal(mdText('line one\nline two‮evil'), 'line one line two evil');
  assert.equal(mdText('zero\u200bwidth \u200djoiner \u2060wj \u00adshy \u061cALM x\ud800'), 'zero width joiner wj shy ALM x\ufffd');
});

test('SARIF: valid against the vendored schema; file:line of the finding, else the route\'s page file, else the app; levels; L9 only has security-severity', () => {
  const p = project();
  const r = run(p, 'export', '--format', 'sarif', '--include-page-text');
  assert.equal(r.status, 0, r.stderr);
  const log = JSON.parse(r.stdout);
  assert.deepEqual(sarifProblems(log), []);
  assert.deepEqual(githubProblems(log), []);
  assert.deepEqual(log.runs[0].automationDetails, { id: 'nunchi/export/' }, 'apart from check\'s analysis');
  const results = log.runs[0].results;
  const where = id => results.filter(x => x.ruleId === id).map(x => `${x.locations[0].physicalLocation.artifactLocation.uri}:${x.locations[0].physicalLocation.region.startLine}`);
  assert.deepEqual(where('L6.raw-technical-text'), ['app/garden/page.tsx:7']);
  assert.deepEqual(where('raw-error-text'), ['app/garden/page.tsx:1']);
  assert.deepEqual(where('target-size-min'), ['app/account/page.tsx:1']);
  assert.deepEqual(where('secret-in-client-bundle'), ['package.json:1']);
  assert.deepEqual(where('horizontal-overflow'), ['package.json:1'], 'a route with no page file');
  assert.deepEqual(where('L6.vague-error'), ['app/page.tsx:1'], 'a finding\'s file that is a URL is no location');
  for (const x of results) assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(x.locations[0].physicalLocation.artifactLocation.uri), 'no scheme');
  for (const x of results) {
    assert.equal(x.locations.length, 1);
    assert.ok(x.partialFingerprints['nunchi/group/v1'] && x.partialFingerprints['nunchi/fp/v1']);
    assert.ok(!('markdown' in x.message));
  }
  const level = id => results.find(x => x.ruleId === id).level;
  assert.deepEqual([level('secret-in-client-bundle'), level('raw-error-text'), level('target-size-min'), level('dead-href')], ['error', 'error', 'warning', 'note']);
  const rules = Object.fromEntries(log.runs[0].tool.driver.rules.map(x => [x.id, x]));
  assert.equal(rules['secret-in-client-bundle'].properties['security-severity'], '9.5');
  assert.equal(rules['native-dialog'].properties['security-severity'], '5.5');
  for (const id of ['raw-error-text', 'dead-href', 'target-size-min', 'horizontal-overflow', 'L6.raw-technical-text']) assert.ok(!('security-severity' in rules[id].properties), id);
  const garden = results.find(x => x.ruleId === 'raw-error-text');
  assert.deepEqual(garden.locations[0].logicalLocations, [{ name: '/garden', kind: 'resource' }, { name: 'main p.err', kind: 'element' }]);
  assert.match(garden.message.text, /^Raw error message shown to users on \/garden \(element main p\.err\)\./);
  assert.ok(!r.stdout.includes('127.0.0.1') && !r.stdout.includes(p.root), 'route templates, no URLs or absolute paths');
});

test('SARIF of every status: what GitHub needs; fixed, dismissed and kept places are suppressed, a decision no person made under review', () => {
  const p = project();
  assert.equal(run(p, 'decide', groupOf(p, 'dead-href'), 'false-positive', '--reason', 'not-a-problem', '--from-chat').status, 0);
  assert.equal(run(p, 'decide', groupOf(p, 'target-size-min'), 'keep', '--reason', 'intended', '--from-chat').status, 0);
  const r = run(p, 'export', '--format', 'sarif', '--status', 'all', '--include-page-text');
  assert.equal(r.status, 0, r.stderr);
  const log = JSON.parse(r.stdout);
  assert.deepEqual(sarifProblems(log), []);
  assert.deepEqual(githubProblems(log), []);
  const by = id => log.runs[0].results.filter(x => x.ruleId === id);
  assert.deepEqual(by('dead-href').map(x => x.suppressions), [[{ kind: 'external', status: 'underReview', justification: 'Not a problem (nothing wrong here), not confirmed by a person (nunchi decide).' }]]);
  assert.equal(by('target-size-min')[0].suppressions[0].kind, 'external');
  assert.equal(by('raw-error-text')[0].suppressions, undefined, 'an open place is not suppressed');
});

test('with --include-page-text too: route templates, never a screen id, a URL of the app or an absolute path', () => {
  const p = project();
  for (const fmt of ['json', 'md', 'sarif']) {
    const out = run(p, 'export', '--format', fmt, '--include-page-text', '--status', 'all').stdout;
    for (const s of Object.values(p.scenes)) assert.ok(!out.includes(s.id) && !out.includes(mdText(s.id)), `${fmt}: screen id ${s.id}`);
    assert.ok(!out.includes(p.root) && !/127\.0\.0\.1|localhost:\d/.test(out), `${fmt}: no absolute path or app URL`);
  }
});

test('paths are the repository\'s: an app in a subfolder gets its prefix; statuses and usage', () => {
  const outer = tmp('nunchi-export-f-outer-');
  execFileSync('git', ['init', '-q'], { cwd: outer });
  const p = project({ git: false });
  const app = join(outer, 'web');
  cpSync(p.root, app, { recursive: true });
  const log = JSON.parse(spawnSync(process.execPath, [CLI, 'export', '--format', 'sarif'], { cwd: app, encoding: 'utf8' }).stdout);
  assert.ok(log.runs[0].results.some(x => x.locations[0].physicalLocation.artifactLocation.uri === 'web/app/garden/page.tsx'));
  const fixedOnly = JSON.parse(run(p, 'export', '--format', 'json', '--status', 'fixed').stdout);
  assert.equal(fixedOnly.groups.length, 0);
  assert.deepEqual(fixedOnly.statuses, ['fixed']);
  const later = JSON.parse(run(p, 'export', '--format', 'json', '--status', 'later,open').stdout);
  assert.deepEqual(later.statuses, ['open', 'held']);
  for (const args of [['--format', 'pdf'], ['--format', 'json', '--status', 'bogus'], ['--format', 'json', '--html', 'x'], ['--format', 'md', '--out'], ['--format', 'json', '--run', '0001'], ['--format', 'md', '--include-page-txt'], ['--format', 'md', '--url', 'http://x.invalid'], ['--format', 'json', '--fail-on', 'high']]) {
    const r = run(p, 'export', ...args);
    assert.equal(r.status, 1, args.join(' '));
  }
  const out = join(tmp('nunchi-export-f-out-'), 'share', 'findings.sarif');
  const w = run(p, 'export', '--format', 'sarif', '--out', out);
  assert.equal(w.status, 0, w.stderr);
  // owner-only, in a folder made private when nunchi creates it
  if (process.platform !== 'win32') { assert.equal(statSync(out).mode & 0o777, 0o600); assert.equal(statSync(join(out, '..')).mode & 0o777, 0o700); }
  assert.match(w.stdout, /^SARIF → /);
  assert.deepEqual(sarifProblems(JSON.parse(readFileSync(out, 'utf8'))), []);
  assert.equal(run(p, 'export', '--format', 'md', '--out', join(p.root, '.nunchi', 'runs', '0001', 'x.md')).status, 1, 'never into a run');
  assert.ok(!existsSync(join(p.root, '.nunchi', 'runs', '0001', 'x.md')));
});
