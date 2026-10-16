// `nunchi share`'s pack (spec §7.6): deterministic, listing every file with bytes and sha256; never the saved login,
// recordings, network or console evidence, text.txt, aria.yml, canaries or the ledger's state; visitor screens only by
// default; a screen whose captured text holds a secret-shaped string loses its screenshot; page text off in the page
// too; the fragment form for an artifact; and the scan of every text file just before a send. Synthetic projects only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildPack, scanPack, findSecret, secretShaped, withheldScenes } from '../src/share/pack.mjs';
import { exportHtml } from '../src/export-html.mjs';
import * as P from '../src/project.mjs';
import { shareProject, NEVER, PAGE_TEXT, FAKE_KEY } from './fixtures/share-project.mjs';
import { tmp } from './fixtures/tmp.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const packOf = (p, opts = {}) => {
  const led = P.loadLedger(p.nunchi, { root: p.root });
  return buildPack({ runDir: p.run, nunchiDir: p.nunchi, led, view: P.ledgerView(led), root: p.root, project: p.root, include: { signedIn: false, pageText: false }, version: '0.0.0-test', app: 'shop', ...opts });
};
const textOf = pack => pack.files.filter(f => /\.(html|json)$/.test(f.path)).map(f => f.data.toString('utf8')).join('\n');

test('share pack: the same run, ledger and choice give the same bytes; share.json lists every other file with its bytes and sha256', () => {
  const p = shareProject();
  const a = packOf(p), b = packOf(p);
  assert.deepEqual(a.files.map(f => [f.path, sha(f.data)]), b.files.map(f => [f.path, sha(f.data)]));
  assert.deepEqual(a.files.map(f => f.path).filter(x => !x.startsWith('img/')), ['findings.json', 'index.html', 'share.json']);
  const s = JSON.parse(a.files.find(f => f.path === 'share.json').data);
  assert.deepEqual(s.files.map(f => f.path), a.files.map(f => f.path).filter(x => x !== 'share.json'));
  for (const f of s.files) { const d = a.files.find(x => x.path === f.path).data; assert.deepEqual([f.bytes, f.sha256], [d.length, sha(d)], f.path); }
  assert.deepEqual([s.schema, s.tool, s.app, s.run, s.kind, s.wholeApp, s.form], [1, 'nunchi', 'shop', '0001', 'full', true, 'page']);
  // no clock: nothing in the pack names a time, whatever the clock says now
  assert.doesNotMatch(textOf(a), /2026-10-1\dT\d\d:/);
});

test('share pack: never the login, recordings, network or console evidence, text.txt, aria.yml, canaries or the ledger state', () => {
  const p = shareProject();
  const all = packOf(p, { include: { signedIn: true, pageText: true } });
  const text = textOf(all) + all.files.map(f => f.data.toString('latin1')).join('');
  for (const never of NEVER) assert.ok(!text.includes(never), `${never} reached the pack`);
  assert.deepEqual(all.files.map(f => f.path).filter(x => !/^img\/[0-9a-f]{16}\.jpg$/.test(x)), ['findings.json', 'index.html', 'share.json']);
});

test('share pack: visitor screens by default; signed-in screens only when the person turned them on (their findings go as text either way)', () => {
  const p = shareProject({ secretScreen: false });
  const off = packOf(p), on = packOf(p, { include: { signedIn: true, pageText: false } });
  const s = pk => JSON.parse(pk.files.find(f => f.path === 'share.json').data);
  assert.deepEqual([s(off).included, s(off).leftOut.signedInScreens], [{ screens: 4, persons: ['guest'], pageText: false }, 3]);
  assert.deepEqual([s(on).included.screens, s(on).included.persons, s(on).leftOut.signedInScreens], [7, ['guest', 'signed-in'], 0]);
  assert.equal(off.files.filter(f => f.path.startsWith('img/')).length, 4);
  assert.equal(on.files.filter(f => f.path.startsWith('img/')).length, 7);
  // the signed-in finding is in findings.json without a screenshot, counted as text only
  assert.equal(s(off).findings.textOnly, 2);
  const html = off.files.find(f => f.path === 'index.html').data.toString();
  assert.match(html, /Screenshot not shared: seen signed in\./);
  assert.match(JSON.stringify(JSON.parse(off.files.find(f => f.path === 'findings.json').data)), /link-unnamed/);
});

test('share pack: a screen whose captured text holds a secret-shaped string loses its screenshot (a fixture that triggers it, one that does not)', () => {
  assert.equal(secretShaped('Your key: [secret-shaped: stripe-live-secret-key]'), true);
  assert.equal(secretShaped(`token ${FAKE_KEY}`), true, 'a shape the scrubber still finds');
  assert.equal(secretShaped('Welcome back to the plant shelf'), false);
  const hit = shareProject({ secretScreen: true }), clean = shareProject({ secretScreen: false });
  const ids = p => [...withheldScenes(p.run, JSON.parse(readFileSync(join(p.run, 'manifest.json'))).scenes)];
  assert.deepEqual(ids(hit), ['help.guest.normal.d']);
  assert.deepEqual(ids(clean), []);
  const s = pk => JSON.parse(pk.files.find(f => f.path === 'share.json').data);
  assert.deepEqual([s(packOf(hit)).leftOut.secretShapedScreens, s(packOf(hit)).included.screens], [1, 3]);
  assert.deepEqual([s(packOf(clean)).leftOut.secretShapedScreens, s(packOf(clean)).included.screens], [0, 4]);
  assert.match(packOf(hit).files.find(f => f.path === 'index.html').data.toString(), /Screenshot not shared: its screen text looked like a key or token\./);
});

test('share pack: page text is off in the page too (export --html --no-page-text); the plain export keeps it, byte for byte as before', () => {
  const p = shareProject({ secretScreen: false });
  const pk = packOf(p, { include: { signedIn: true, pageText: false } });
  const html = pk.files.find(f => f.path === 'index.html').data.toString();
  for (const t of PAGE_TEXT) assert.ok(!html.includes(t), `${t} is page text`);
  assert.match(html, /a\.diary:has-text\(&quot;…&quot;\)/, 'a signed-in selector keeps its shape, not its words');
  // the plain export shows them, as it always did
  const out = tmp('nunchi-share-exp-');
  const led = P.loadLedger(p.nunchi, { root: p.root });
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out, ledger: led });
  const plain = readFileSync(join(out, 'index.html'), 'utf8');
  for (const t of ['PAGE-TEXT-CLAIM-1', 'Hello Ana Fern']) assert.ok(plain.includes(t), t);
  const out2 = tmp('nunchi-share-exp-');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out2, ledger: led, pageText: false });
  const off = readFileSync(join(out2, 'index.html'), 'utf8');
  for (const t of PAGE_TEXT) assert.ok(!off.includes(t), `${t} with --no-page-text`);
  // page text on, by the person's choice: it goes
  const on = packOf(p, { include: { signedIn: true, pageText: true } }).files.find(f => f.path === 'index.html').data.toString();
  assert.ok(on.includes('PAGE-TEXT-CLAIM-1'));
});

test('share pack: the fragment form for an artifact has no doctype, head or CSP meta (the service wraps the file); the page form is the offline page', () => {
  const p = shareProject();
  const frag = packOf(p, { form: 'fragment' }).files.find(f => f.path === 'index.html').data.toString();
  const page = packOf(p).files.find(f => f.path === 'index.html').data.toString();
  assert.ok(frag.startsWith('<meta name="generator" content="nunchi export --html">\n<title>nunchi · Run 0001</title>\n<style>'));
  assert.doesNotMatch(frag, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]|Content-Security-Policy/i);
  assert.match(frag, /<main id="main">/);
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /Content-Security-Policy/);
  assert.equal(JSON.parse(packOf(p, { form: 'fragment' }).files.find(f => f.path === 'share.json').data).form, 'fragment');
});

test('share scan: every text file of the pack, whole; a hit gives its file, kind and line only (a fixture that triggers it, one that does not)', () => {
  assert.equal(findSecret('{"a": "fine"}\n'), null);
  assert.deepEqual(findSecret(`{\n  "x": "${FAKE_KEY}"\n}`), { kind: 'stripe-live-secret-key', line: 2 });
  const files = [{ path: 'index.html', data: Buffer.from('<p>ok</p>') }, { path: 'findings.json', data: Buffer.from(`{"note":"Bearer ab12cd34ef56gh78ij90"}`) }, { path: 'img/x.jpg', data: Buffer.from(FAKE_KEY) }];
  assert.deepEqual(scanPack(files), { path: 'findings.json', kind: 'bearer-token', line: 1 });
  assert.equal(scanPack(files.filter(f => f.path !== 'findings.json')), null, 'images are not text');
  // a real pack passes the scan (nunchi's own hashes, styles and script are no secret)
  for (const form of ['page', 'fragment']) assert.equal(scanPack(packOf(shareProject(), { form, include: { signedIn: true, pageText: true } }).files), null, form);
});

test('share pack: the groups a person decided Fix (board or their terminal) apart from those your AI recorded', () => {
  const p = shareProject();
  const led = P.loadLedger(p.nunchi, { root: p.root });
  const { rows, groups } = P.ledgerView(led);
  const g = rule => groups.find(x => x.rule === rule).group;
  P.recordDecisions(led, { targets: P.resolveTargets(rows, groups, [g('raw-error-text')]), decision: 'fix', by: 't', channel: 'cli-tty' });
  P.recordDecisions(led, { targets: P.resolveTargets(rows, groups, [g('dead-href')]), decision: 'fix', by: 't', channel: 'cli-agent' });
  const s = JSON.parse(packOf(p).files.find(f => f.path === 'share.json').data);
  assert.deepEqual(s.groups, { toFix: [g('raw-error-text')], decidedByAgent: [g('dead-href')] });
});

test('share pack: findings.json is export --format json (page text off unless turned on)', () => {
  const p = shareProject();
  const f = JSON.parse(packOf(p).files.find(x => x.path === 'findings.json').data);
  assert.equal(f.pageText, false);
  assert.ok(f.counts.pageTextLeftOut > 0);
  assert.ok(!JSON.stringify(f).includes('PAGE-TEXT-CLAIM-1'));
  assert.equal(JSON.parse(packOf(p, { include: { signedIn: false, pageText: true } }).files.find(x => x.path === 'findings.json').data).pageText, true);
});
