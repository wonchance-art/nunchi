// Stage 0 (Tidy): regression tests from the adversarial review of the token proposal (2026-10-14 KST).
// Each pins a behaviour a mutation of src/tokens.mjs or the review's repro broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseColor, oklabOf, deltaE, familyOf, buildTokens, tokensCss, MERGE_DE } from '../src/tokens.mjs';
import { redactSelector } from '../src/selector-secrets.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const T = 'rgba(0, 0, 0, 0)';
const row = (selector, extra = {}) => ({ role: 'text', selector, color: 'rgb(17, 24, 39)', background: T, fontSize: '16px', fontWeight: '400', lineHeight: '24px', fontFamily: 'system-ui', radius: '0px', shadow: null, padding: '0px 0px 0px 0px', height: null, ...extra });
const btn = (selector, extra = {}) => row(selector, { role: 'button', color: 'rgb(255, 255, 255)', background: 'rgb(37, 99, 235)', radius: '8px', height: 40, ...extra });
const greyRow = (selector, g, extra = {}) => row(selector, { color: `rgb(${g}, ${g}, ${g})`, ...extra });
const page = (background = 'rgb(255, 255, 255)') => ({ selector: 'body', background, radius: '0px', kind: 'page' });
const card = (selector, background, extra = {}) => ({ selector, background, radius: '8px', kind: 'box', on: 'rgb(255, 255, 255)', ...extra });
const scene = (id, screen, styles, paint = { schema: 1, surfaces: [page()], borders: [], svg: [] }) => ({ id, screen, styles, paint });
const tokenOf = (r, value) => r.colors.find(c => c.members.some(m => m.value === value))?.token;
const lab = v => oklabOf(parseColor(v));
const role = (r, n) => r.roles.find(x => x.role === n)?.value;

test('merge threshold: ΔE 0.028 is one token, ΔE 0.036 is two', () => {
  const r = buildTokens({ scenes: [scene('a', '/a', [greyRow('p.a', 100), greyRow('p.a2', 100), greyRow('p.b', 108), greyRow('p.c', 140), greyRow('p.c2', 140), greyRow('p.d', 151)])] });
  assert.ok(deltaE(lab('rgb(100, 100, 100)'), lab('rgb(108, 108, 108)')) < MERGE_DE);
  assert.equal(tokenOf(r, 'rgb(108, 108, 108)'), tokenOf(r, 'rgb(100, 100, 100)'), 'ΔE 0.028 merges');
  const far = deltaE(lab('rgb(140, 140, 140)'), lab('rgb(151, 151, 151)'));
  assert.ok(far > 0.034 && far < 0.04, String(far));
  assert.notEqual(tokenOf(r, 'rgb(151, 151, 151)'), tokenOf(r, 'rgb(140, 140, 140)'), 'ΔE 0.036 stays apart');
});

test('a colour joins the nearest leader within range, not the first one', () => {
  // leaders 100 (3 uses) and 109 (2 uses) are ΔE 0.0315 apart; 106 is within range of both, nearer 109
  const r = buildTokens({ scenes: [scene('a', '/a', [greyRow('p.a', 100), greyRow('p.a2', 100), greyRow('p.a3', 100), greyRow('p.b', 109), greyRow('p.b2', 109), greyRow('p.m', 106)])] });
  assert.notEqual(tokenOf(r, 'rgb(100, 100, 100)'), tokenOf(r, 'rgb(109, 109, 109)'));
  assert.equal(tokenOf(r, 'rgb(106, 106, 106)'), tokenOf(r, 'rgb(109, 109, 109)'));
});

test('figure and ground: the proposal never brings a card closer to the page it sits on', () => {
  // three screens with a 250 page; /d has a white page with a 249 card. White would merge into 250 (ΔE 0.018),
  // which puts the card ΔE 0.003 from its page. The card or the page must keep its own value.
  const pg = v => ({ schema: 1, surfaces: [page(v)], borders: [], svg: [] });
  const scenes = ['a', 'b', 'c'].map(x => scene(x, `/${x}`, [row('main > p')], pg('rgb(250, 250, 250)')));
  scenes.push(scene('d', '/d', [row('main > p')], { schema: 1, surfaces: [page('rgb(255, 255, 255)'), card('main > div', 'rgb(249, 249, 249)')], borders: [], svg: [] }));
  const r = buildTokens({ scenes });
  const proposed = v => r.colors.find(c => c.members.some(m => m.value === v)).value;
  const own = deltaE(lab('rgb(255, 255, 255)'), lab('rgb(249, 249, 249)'));
  const now = deltaE(lab(proposed('rgb(255, 255, 255)')), lab(proposed('rgb(249, 249, 249)')));
  assert.ok(now >= own - 1e-9, `card and page were ΔE ${own.toFixed(4)} apart, the proposal puts them ${now.toFixed(4)} apart`);
  const k = r.keptApart.find(x => x.a.value === 'rgb(249, 249, 249)' && x.b.value === 'rgb(255, 255, 255)');
  assert.ok(k, JSON.stringify(r.keptApart));
  assert.notEqual(k.a.token, k.b.token);
  assert.equal(k.a.token, tokenOf(r, k.a.value));
  assert.equal(k.b.token, tokenOf(r, k.b.value));
  assert.equal(k.deltaE, Math.round(own * 1e4) / 1e4, 'ΔE between the two colours seen against each other');
});

test('accent: a coloured primary beats grey secondary buttons; form fields are never the accent; ties go to chroma', () => {
  const ctl = (selector, background) => ({ selector, background, radius: '8px', kind: 'control', on: 'rgb(255, 255, 255)' });
  const field = (selector, background) => ({ selector, background, radius: '4px', kind: 'field', on: 'rgb(255, 255, 255)' });
  const paintOf = surfaces => ({ schema: 1, surfaces: [page(), ...surfaces], borders: [], svg: [] });
  // A: grey secondary buttons (more of them) and a rose primary
  const a = buildTokens({ scenes: [scene('a', '/a', [row('main > p'), row('main > p.b')], paintOf([ctl('button.s1', 'rgb(229, 231, 235)'), ctl('button.s2', 'rgb(229, 231, 235)'), ctl('a.s3', 'rgb(229, 231, 235)'), ctl('button.p', 'rgb(225, 29, 72)')]))] });
  assert.equal(role(a, 'accent'), 'rgb(225, 29, 72)');
  assert.notEqual(role(a, 'danger'), 'rgb(225, 29, 72)', 'the accent is not also the danger colour');
  // B: white form fields and a purple button
  const b = buildTokens({ scenes: [scene('a', '/a', [row('main > p')], paintOf([field('input.a', 'rgb(250, 250, 250)'), field('input.b', 'rgb(250, 250, 250)'), field('select', 'rgb(250, 250, 250)'), ctl('button', 'rgb(126, 34, 206)')]))] });
  assert.equal(role(b, 'accent'), 'rgb(126, 34, 206)');
  // C: two coloured fills used equally: the saturated purple (chroma 0.25) beats a dull blue (0.08), although
  // the blue comes first by value and by family name
  const c = buildTokens({ scenes: [scene('a', '/a', [row('main > p')], paintOf([ctl('button.a', 'rgb(110, 120, 170)'), ctl('button.b', 'rgb(147, 51, 234)')]))] });
  assert.equal(role(c, 'accent'), 'rgb(147, 51, 234)');
});

test('contrast: two roles on the same token are reported at 1:1, failing AA', () => {
  const dark = 'rgb(17, 24, 39)';
  const r = buildTokens({ scenes: [scene('a', '/a', [row('main > p'), row('main > p.b')], { schema: 1, surfaces: [page(), card('div.a', dark), card('div.b', dark, { radius: '4px' })], borders: [], svg: [] })] });
  assert.equal(r.roles.find(x => x.role === 'surface').ref, r.roles.find(x => x.role === 'text').ref);
  assert.deepEqual(r.contrast.find(c => c.fg === 'text' && c.bg === 'surface'), { fg: 'text', bg: 'surface', ratio: 1, aa: false, aaLarge: false });
});

test('confidence: a role seen on one screen is a third as sure as one seen on three', () => {
  const one = buildTokens({ scenes: [scene('a', '/a', [row('main > p')])] });
  assert.equal(one.roles.find(x => x.role === 'background').confidence, 0.33);
  const three = buildTokens({ scenes: ['a', 'b', 'c'].map(x => scene(x, `/${x}`, [row('main > p')])) });
  assert.equal(three.roles.find(x => x.role === 'background').confidence, 1);
});

test('muted text must be readable (≥ 1.5:1); ties between candidates go to the colour seen on more screens', () => {
  // a near-white grey (1.25:1) used more than the real muted grey is not muted text
  const r = buildTokens({ scenes: [scene('a', '/a', [row('p.1'), row('p.2'), row('p.3'), row('p.4'), greyRow('p.x', 232), greyRow('p.y', 232, { fontSize: '14px' }), greyRow('p.z', 232, { fontWeight: '600' }), row('p.m', { color: 'rgb(107, 114, 128)' })])] });
  assert.notEqual(tokenOf(r, 'rgb(232, 232, 232)'), tokenOf(r, 'rgb(255, 255, 255)'));
  assert.equal(role(r, 'text-muted'), 'rgb(107, 114, 128)');
  // equal uses: rgb(51, 65, 85) is on two screens, rgb(17, 24, 39) on one; value order alone would pick the latter
  const t = buildTokens({ scenes: [scene('a', '/a', [row('p.a'), row('p.b'), row('p.c', { color: 'rgb(51, 65, 85)' })]), scene('b', '/b', [row('p.c', { color: 'rgb(51, 65, 85)' })])] });
  assert.equal(role(t, 'text'), 'rgb(51, 65, 85)');
});

test('hue families: Tailwind pink is pink, CSS purple and fuchsia are purple, red and rose are red', () => {
  const fam = c => familyOf(lab(c));
  assert.deepEqual(['#ec4899', '#db2777', 'rgb(128, 0, 128)', '#d946ef', '#dc2626', '#e11d48', '#ff0000', '#f97316', '#3b82f6'].map(fam),
    ['pink', 'pink', 'purple', 'purple', 'red', 'red', 'red', 'orange', 'blue']);
  const r = buildTokens({ scenes: [scene('a', '/a', [row('p'), row('p.b'), row('p.pink', { color: 'rgb(219, 39, 119)' })])] });
  assert.equal(role(r, 'danger'), undefined, 'pink is not a danger candidate');
});

test('tampered evidence cannot inject CSS: values are parsed strictly and re-serialised', () => {
  const evil = '}*{display:none}';
  const r = buildTokens({ scenes: [scene('a', '/a', [row('p', { color: `rgb(1, 2, 3);${evil}` }), row('p.b', { color: 'rgb(1, 2, 3x)' }), row('p.c', { fontSize: `16px;${evil}` }), btn('button', { radius: `8px;${evil}` })],
    { schema: 1, surfaces: [page(), card('div', 'rgb(229, 231, 235)', { radius: `9px${evil}` })], borders: [], svg: [] })] });
  const css = tokensCss(r);
  assert.ok(!css.includes('display'), css);
  assert.deepEqual(r.unparsed.map(u => u.value).sort(), [`16px;${evil}`, `8px;${evil}`, `9px${evil}`, 'rgb(1, 2, 3x)', `rgb(1, 2, 3);${evil}`].sort());
  assert.equal(parseColor('rgb(1, 2, 3);}*{display:none}x{a:b(3)'), null);
  assert.equal(parseColor('rgb(1, 2, 3e)'), null);
  assert.ok(!('css' in r), 'tokens.json does not carry a copy of the CSS');
});

test('selectors in token examples never carry a secret-shaped id', () => {
  const key = 'sk_' + 'live_' + 'Q'.repeat(10) + '1234567890ab';   // built at run time: no secret-shaped literal in the repo
  assert.equal(redactSelector(`div#sess_${key}`), 'div#sess_[secret-shaped: stripe-live-secret-key]', 'the evidence scrubber\'s format, though the id has no word boundary');
  assert.equal(redactSelector('main > div:nth-of-type(2)'), 'main > div:nth-of-type(2)', 'ordinary selectors are untouched');
  assert.equal(redactSelector(`div[data-testid="${'a1'.repeat(25)}"]`), 'div[data-testid="[secret-shaped: long-token]"]', 'a 40+ character token mixing letters and digits');
  const r = buildTokens({ scenes: [scene('a', '/a', [row(`div#sess_${key} > p`)])] });
  assert.ok(!JSON.stringify(r).includes(key));
});

test('CLI: a corrupt run file is a one-line error and exit code 2, not a stack trace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nunchi-tokens-bad-'));
  writeFileSync(join(dir, 'manifest.json'), '{"schema": 1, "scenes": [');
  let err;
  try { execFileSync('node', [CLI, 'tokens', '--run', dir], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { err = e; }
  assert.equal(err?.status, 2);
  assert.match(err.stderr, /^nunchi tokens: .*manifest\.json is not readable JSON/);
  assert.ok(!/\n\s+at /.test(err.stderr), err.stderr);
});
