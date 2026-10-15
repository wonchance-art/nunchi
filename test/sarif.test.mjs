// SARIF 2.1.0 (design 0.1-c §5, spec §7.4): the vendored OASIS schema (sha256 pinned, no network) and a minimal
// validator for the draft-04 keywords it uses; levels, security-severity only for L9, a physical location on every
// result, partialFingerprints, repo-relative URIs, deterministic truncation to GitHub's limits, said when it happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validate, SCHEMA, sarifProblems, URI_RE, URI_REFERENCE_RE } from './fixtures/sarif/validate.mjs';
import { sarifLog, uriOf, plainText, LEVEL, SECURITY_SEVERITY, GITHUB_LIMITS, truncationLine, SARIF_SCHEMA } from '../src/sarif.mjs';
import { redactText } from '../src/network.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('./fixtures/sarif/sarif-schema-2.1.0.json', import.meta.url));
// raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json (its id: the OASIS
// errata01 schema), fetched 2026-10-15 KST
const SCHEMA_SHA256 = 'c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e';

const result = (i, extra = {}) => ({ ruleId: `rule-${i % 3}`, severity: ['blocker', 'high', 'medium', 'low'][i % 4], message: `Finding ${i} on /plants/[id]. More.`, path: `app/plants/[id]/page ${i}.tsx`, line: i + 1,
  logical: [{ name: '/plants/[id]', kind: 'resource' }, { name: 'main > a.more', kind: 'element' }], fingerprints: { 'nunchi/group/v1': `g${i}`, 'nunchi/fp/v1': `f${i}` }, ...extra });
const rules = new Map([['rule-0', { title: 'Rule zero', tags: ['L1', 'rule'] }], ['rule-1', { title: 'Secret', tags: ['L9', 'rule', 'security'], security: true }], ['rule-2', { title: 'Two' }]]);

test('the vendored schema is the pinned one, and the validator is not vacuous', () => {
  assert.equal(createHash('sha256').update(readFileSync(SCHEMA_PATH)).digest('hex'), SCHEMA_SHA256);
  assert.equal(SCHEMA.id, SARIF_SCHEMA);
  const good = sarifLog({ version: '0.0.2', rules, results: [result(0)] }).log;
  assert.deepEqual(sarifProblems(good), []);
  const bad = [
    d => { delete d.version; },
    d => { d.runs[0].results[0].level = 'critical'; },
    d => { d.runs[0].results[0].message = {}; },
    d => { d.runs[0].results[0].nonsense = 1; },
    d => { d.runs[0].tool.driver.rules[0].defaultConfiguration.level = 'fatal'; },
    d => { d.runs[0].results[0].locations[0].physicalLocation.region.startLine = 0; },
    d => { d.runs = []; d.version = '2.0.0'; },
  ];
  for (const change of bad) {
    const d = JSON.parse(JSON.stringify(good));
    change(d);
    assert.notDeepEqual(sarifProblems(d), [], String(change));
  }
});

test('levels by severity; security-severity on L9 rules only; every result located; partialFingerprints; paths as URI references', () => {
  const { log } = sarifLog({ version: '0.0.2', rules, results: [0, 1, 2, 3, 5].map(i => result(i)) });
  assert.deepEqual(sarifProblems(log), []);
  assert.deepEqual(LEVEL, { blocker: 'error', high: 'error', medium: 'warning', low: 'note' });
  const run = log.runs[0];
  for (const r of run.results) {
    assert.equal(r.level, LEVEL[['blocker', 'high', 'medium', 'low'][Number(r.partialFingerprints['nunchi/fp/v1'].slice(1)) % 4]]);
    assert.equal(r.locations.length, 1);
    assert.equal(r.locations[0].physicalLocation.artifactLocation.uriBaseId, '%SRCROOT%');
    assert.ok(r.locations[0].physicalLocation.region.startLine >= 1);
    assert.match(r.locations[0].physicalLocation.artifactLocation.uri, /^app\/plants\/%5Bid%5D\/page%20\d\.tsx$/);
    assert.deepEqual(Object.keys(r.partialFingerprints), ['nunchi/fp/v1', 'nunchi/group/v1']);
    assert.deepEqual(Object.keys(r.message), ['text']);
    assert.deepEqual(r.locations[0].logicalLocations.map(l => l.kind), ['resource', 'element']);
  }
  const byId = Object.fromEntries(run.tool.driver.rules.map(r => [r.id, r]));
  assert.equal(byId['rule-1'].properties['security-severity'], SECURITY_SEVERITY.high);
  assert.ok(!('security-severity' in byId['rule-0'].properties) && !('security-severity' in byId['rule-2'].properties));
  assert.ok(byId['rule-1'].properties.tags.includes('security'));
  assert.equal(byId['rule-0'].defaultConfiguration.level, 'error', 'the worst result of the rule');
  assert.ok(!JSON.stringify(log).includes('file://'), 'no absolute path of this machine');
  assert.equal(uriOf('a b/[c]/%d/é.tsx'), 'a%20b/%5Bc%5D/%25d/%C3%A9.tsx');
});

test('the same results in any order give the same bytes', () => {
  const list = Array.from({ length: 40 }, (_, i) => result(i));
  const a = sarifLog({ version: '1', rules, results: list }).text;
  const b = sarifLog({ version: '1', rules, results: [...list].reverse() }).text;
  assert.equal(a, b);
});

test('truncation to GitHub\'s limits: worst first, the same every time, and said', () => {
  assert.equal(GITHUB_LIMITS.resultsKept, 5000);
  assert.equal(GITHUB_LIMITS.gzipBytes, 10 * 1024 * 1024);
  const list = Array.from({ length: 5003 }, (_, i) => result(i));
  const r = sarifLog({ version: '1', rules, results: list });
  assert.equal(r.kept, 5000);
  assert.equal(r.log.runs[0].results.length, 5000);
  assert.deepEqual(r.truncated, { kept: 5000, of: 5003, why: 'GitHub keeps 5,000 results per run' });
  assert.equal(r.log.runs[0].properties.truncated.of, 5003);
  assert.ok(r.log.runs[0].results.slice(0, 1251).every(x => x.level === 'error'));
  assert.equal(r.log.runs[0].results.at(-1).level, 'note', 'the low ones go first');
  assert.match(truncationLine(r.truncated), /^SARIF truncated: 5,000 of 5,003 results kept, worst first/);
  assert.equal(sarifLog({ version: '1', rules, results: [...list].reverse() }).text, r.text);
  // over the size limit: the most results that fit
  const small = sarifLog({ version: '1', rules, results: list.slice(0, 50), maxBytes: 12000 });
  assert.ok(Buffer.byteLength(small.text) <= 12000 && small.kept > 0 && small.kept < 50);
  assert.match(small.truncated.why, /would be over/);
  assert.deepEqual(sarifProblems(small.log), []);
  assert.equal(sarifLog({ version: '1', rules, results: list.slice(0, 3) }).truncated, null);
});

test('every string of the log passes the secret scanner, whoever built it', () => {
  const key = 'sk_' + 'live_' + 'FixtureOnly0000000000000009';
  const { text } = sarifLog({ version: '1', rules: new Map([[`r-${key}`, { title: `t ${key}` }]]), results: [result(1, { ruleId: `r-${key}`, message: `m ${key}`, path: `app/${key}/page.tsx`, logical: [{ name: `/r/${key}`, kind: 'resource' }], fingerprints: { 'nunchi/fp/v1': key } })] });
  assert.ok(!text.includes(key));
  assert.match(text, /secret-shaped: stripe-live-secret-key/);
});

test('text and URIs: control and format characters flattened, clipped by code point, well-formed; a colon never reads as a scheme', () => {
  assert.equal(plainText('zero​width ‍joiner ⁠wj ­shy ؜ALM ‮RTL ⁦iso⁩ \u0085nel'), 'zero width joiner wj shy ALM RTL iso nel');
  assert.equal(plainText('a'.repeat(998) + '\u{1F33F}' + 'bb'), 'a'.repeat(998) + '\u{1F33F}…', 'the emoji is one code point, kept whole');
  assert.equal(plainText('a'.repeat(999) + '\u{1F33F}\u{1F33F}'), 'a'.repeat(999) + '…', 'never half of it');
  assert.equal(plainText('x\ud800y'), 'x�y', 'a lone surrogate');
  assert.ok(plainText('a'.repeat(5000)).isWellFormed());
  assert.equal(uriOf('c:x/page.tsx'), 'c%3Ax/page.tsx');
  assert.equal(uriOf('https://evil.invalid/x.tsx'), 'https%3A//evil.invalid/x.tsx');
  assert.equal(uriOf('app/plants/[id]/page.tsx'), 'app/plants/%5Bid%5D/page.tsx');
  // a long word is not retried at every letter for a URL's credentials (it took 2 s for 40,000 letters)
  const t0 = process.hrtime.bigint();
  redactText('a'.repeat(200000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'linear');
  assert.equal(redactText('see https://ana:pw@x.invalid/ and xhttps://u:p@y.invalid/'), 'see https://x.invalid/ and xhttps://y.invalid/');
});

test('truncation: both reasons named; the size worked out once per result is the size written; the most that fit', () => {
  const list = Array.from({ length: 5003 }, (_, i) => result(i, { message: `${'Finding on /plants/[id]. '.repeat(8)}${i}` }));
  const r = sarifLog({ version: '1', rules, results: list, maxBytes: 600000 });
  assert.ok(r.kept > 0 && r.kept < 5000);
  assert.equal(r.truncated.why, 'GitHub keeps 5,000 results per run; and the file would be over 0.57 MB');
  assert.equal(r.log.runs[0].properties.truncated.why, r.truncated.why);
  assert.equal(Buffer.byteLength(r.text), r.bytesAt(r.kept), 'worked out, not measured again');
  assert.ok(Buffer.byteLength(r.text) <= 600000 && r.bytesAt(r.kept + 1) > 600000, 'the most that fit');
  for (const max of [3000, 12000, 50000, 200000, Infinity]) {
    const x = sarifLog({ version: '1', rules, results: list.slice(0, 300), maxBytes: max });
    assert.equal(Buffer.byteLength(x.text), x.bytesAt(x.kept), `exact at ${max}`);
    assert.ok(x.kept === 300 || x.bytesAt(x.kept + 1) > max);
    assert.deepEqual(sarifProblems(x.log), []);
  }
  assert.equal(sarifLog({ version: '1', rules, results: list.slice(0, 5001) }).truncated.why, 'GitHub keeps 5,000 results per run');
});

test('the whole log is scrubbed, every key and string; suppressions for what a person dismissed or kept, or what is fixed', () => {
  const key = 'sk_' + 'live_' + 'FixtureOnly0000000000000009';
  const r = sarifLog({ version: `1-${key}`, rules: new Map([['rule-0', { title: 'Zero', tags: [`t-${key}`] }]]),
    results: [result(0, { ruleId: 'rule-0', logical: [{ name: '/x', kind: `k-${key}` }], fingerprints: { [`fp-${key}`]: 'x' }, suppression: { status: 'accepted', justification: `Kept ${key}` } })] });
  assert.ok(!r.text.includes(key));
  const x = r.log.runs[0].results[0];
  assert.deepEqual(x.suppressions, [{ kind: 'external', status: 'accepted', justification: 'Kept [secret-shaped: stripe-live-secret-key]' }]);
  assert.deepEqual(sarifProblems(r.log), []);
  assert.equal(sarifLog({ version: '1', rules, results: [result(0)] }).log.runs[0].results[0].suppressions, undefined);
});

test('the validator reads uri and uri-reference by RFC 3986', () => {
  for (const u of ['app/page.tsx', 'app/%5Bid%5D/page%201.tsx', '', '/abs', 'x?q=1#f']) assert.ok(URI_REFERENCE_RE.test(u), u);
  for (const u of ['app/[id]/page.tsx', 'a b', '%zz', 'a\\b']) assert.ok(!URI_REFERENCE_RE.test(u), u);
  assert.ok(URI_RE.test(SARIF_SCHEMA) && URI_RE.test('http://[::1]:80/x'));
  assert.ok(!URI_RE.test('app/page.tsx'), 'a URI has a scheme');
  const bad = sarifLog({ version: '1', rules, results: [result(0)] }).log;
  bad.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'app/[id]/page.tsx';
  assert.notDeepEqual(sarifProblems(bad), []);
});
