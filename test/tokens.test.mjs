// Stage 0 (Tidy): colour, radius and font-size clustering into a token proposal, on synthetic style records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseColor, oklabOf, oklchOf, deltaE, contrastRatio, familyOf, buildTokens, readRunScenes, tokensCss, MERGE_DE } from '../src/tokens.mjs';
import { redactSelector } from '../src/selector-secrets.mjs';
import { stableJson } from '../src/stable.mjs';
import { tmp } from './fixtures/tmp.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const T = 'rgba(0, 0, 0, 0)';
const row = (selector, extra = {}) => ({ role: 'text', selector, color: 'rgb(17, 24, 39)', background: T, fontSize: '16px', fontWeight: '400', lineHeight: '24px', fontFamily: 'system-ui', radius: '0px', shadow: null, padding: '0px 0px 0px 0px', height: null, ...extra });
const btn = (selector, extra = {}) => row(selector, { role: 'button', color: 'rgb(255, 255, 255)', background: 'rgb(37, 99, 235)', radius: '8px', height: 40, ...extra });
const page = (background = 'rgb(255, 255, 255)') => ({ selector: 'body', background, radius: '0px', kind: 'page' });
const card = (selector, background, extra = {}) => ({ selector, background, radius: '8px', kind: 'box', on: 'rgb(255, 255, 255)', ...extra });
const border = (selector, color, on) => ({ selector, color, sides: 'trbl', width: '1px', on });
const scene = (id, screen, styles, paint = { schema: 1, surfaces: [page()], borders: [], svg: [] }) => ({ id, screen, styles, paint });
const tokenOf = (r, value) => r.colors.find(c => c.members.some(m => m.value === value))?.token;

test('colour parsing: legacy and CSS Color 4 computed values land in the same OKLab space', () => {
  const lab = s => oklabOf(parseColor(s));
  assert.ok(deltaE(lab('rgb(255, 0, 0)'), lab('color(srgb 1 0 0)')) < 1e-9);
  assert.ok(deltaE(lab('rgb(255, 0, 0)'), lab('oklch(0.62796 0.25768 29.2339)')) < 1e-3, 'oklch red');
  assert.ok(deltaE(lab('rgb(255, 0, 0)'), lab('lab(54.29 80.8 69.89)')) < 2e-3, 'CIE lab (D50) red');
  assert.ok(deltaE(lab('#ff0000'), lab('oklab(0.62796 0.22486 0.12585)')) < 1e-3, 'oklab red');
  const p3 = oklchOf(lab('color(display-p3 1 0 0)'));
  assert.ok(Math.abs(p3[0] - 0.6486) < 1e-3 && p3[1] > 0.29, 'display-p3 red is outside sRGB, kept as measured');
  assert.equal(parseColor('rgba(0, 0, 0, 0.1)').alpha, 0.1);
  assert.equal(parseColor('oklch(0.5 0.1 200 / 0.25)').alpha, 0.25);
  assert.equal(parseColor('color(rec2020 1 0 0)'), null, 'a space nunchi does not read is reported, never guessed');
  assert.equal(parseColor('linear-gradient(red, blue)'), null);
  assert.equal(familyOf(lab('rgb(100, 116, 139)')), 'grey', 'a slate grey is a grey');
  assert.equal(familyOf(lab('rgb(37, 99, 235)')), 'blue');
  assert.equal(familyOf(lab('rgb(220, 38, 38)')), 'red');
});

test('WCAG 2.x contrast: hand-rolled formula, translucent colours composited', () => {
  const c = (a, b) => Math.round(contrastRatio(parseColor(a), parseColor(b)) * 100) / 100;
  assert.equal(c('#000', '#fff'), 21);
  assert.equal(c('#777777', '#ffffff'), 4.48);
  assert.equal(c('rgb(255, 255, 255)', 'rgb(37, 99, 235)'), 5.17);
  assert.equal(c('rgba(0, 0, 0, 0.5)', '#ffffff'), 3.98, 'half-transparent black over white is mid grey');
});

test('tidy: near-duplicate greys and blues merge into the most-used member; a colour never merges with what it sits on', () => {
  const styles = [row('main > p'), row('main > p.b', { color: 'rgb(24, 24, 27)' }), row('main > h1', { role: 'h1', fontSize: '32px' }),
    row('main > p.muted', { color: 'rgb(107, 114, 128)', fontSize: '14px' }), row('main > p.muted2', { color: 'rgb(113, 113, 122)', fontSize: '14px' }),
    btn('main > button'), btn('main > button.again', { background: 'rgb(36, 99, 235)' })];
  const paint = { schema: 1,
    surfaces: [page(), card('main > div.one', 'rgb(249, 250, 251)'), card('main > div.two', 'rgb(250, 250, 250)', { radius: '7px' }), card('main > div.three', 'rgb(248, 249, 250)', { radius: '9px' }),
      { selector: 'main > button', background: 'rgb(37, 99, 235)', radius: '8px', kind: 'control', on: 'rgb(255, 255, 255)' },
      { selector: 'main > button.again', background: 'rgb(36, 99, 235)', radius: '8px', kind: 'control', on: 'rgb(255, 255, 255)' }],
    borders: [border('main > div.one', 'rgb(229, 231, 235)', 'rgb(249, 250, 251)'), border('main > div.two', 'rgb(228, 228, 231)', 'rgb(250, 250, 250)')],
    svg: [{ selector: 'main > svg > path', fill: 'rgb(107, 114, 128)', stroke: null }] };
  // two screens use the first set, one screen the variants: the most-used value leads
  const r = buildTokens({ scenes: [scene('a', '/a', styles, paint), scene('b', '/b', styles.slice(0, 1).concat(styles.slice(3, 4), styles.slice(5, 6)), { ...paint, surfaces: paint.surfaces.slice(0, 2).concat(paint.surfaces.slice(4, 5)) })] });
  assert.equal(tokenOf(r, 'rgb(249, 250, 251)'), tokenOf(r, 'rgb(250, 250, 250)'), 'sibling card fills merge');
  assert.equal(tokenOf(r, 'rgb(229, 231, 235)'), tokenOf(r, 'rgb(228, 228, 231)'), 'borders merge');
  assert.equal(tokenOf(r, 'rgb(17, 24, 39)'), tokenOf(r, 'rgb(24, 24, 27)'), 'text colours merge');
  assert.equal(tokenOf(r, 'rgb(37, 99, 235)'), tokenOf(r, 'rgb(36, 99, 235)'), 'blues merge');
  assert.notEqual(tokenOf(r, 'rgb(249, 250, 251)'), tokenOf(r, 'rgb(255, 255, 255)'), `a card on the page stays a token of its own, though ΔE < ${MERGE_DE}`);
  const kept = r.keptApart.find(k => k.a.value === 'rgb(249, 250, 251)' && k.b.value === 'rgb(255, 255, 255)');
  assert.deepEqual(kept, { a: { token: tokenOf(r, 'rgb(249, 250, 251)'), value: 'rgb(249, 250, 251)' }, b: { token: '--grey-1', value: 'rgb(255, 255, 255)' }, deltaE: kept.deltaE }, 'listed as kept apart, a and b each with its own token');
  assert.equal(kept.deltaE, Math.round(deltaE(oklabOf(parseColor('rgb(249, 250, 251)')), oklabOf(parseColor('rgb(255, 255, 255)'))) * 1e4) / 1e4, 'ΔE between the two colours seen against each other');
  const text = r.colors.find(c => c.token === tokenOf(r, 'rgb(17, 24, 39)'));
  assert.equal(text.value, 'rgb(17, 24, 39)', 'the proposed value is the most-used member, so it changes no pixel of that colour');
  assert.deepEqual(text.members.map(m => [m.value, m.uses, m.screens]), [['rgb(17, 24, 39)', 3, 2], ['rgb(24, 24, 27)', 1, 1]]);
  assert.ok(text.members[1].deltaE > 0 && text.members[1].deltaE <= MERGE_DE);
  assert.deepEqual(text.members[0].examples[0], { scene: 'a', selector: 'main > p', context: 'text' });
  assert.match(r.summary.line, /^\d+ greys → \d+ · 2 blues → 1 · 3 radii → 1 · 3 font sizes → 3$/, '7px and 9px are within 2px of the usual 8px');
  const roles = Object.fromEntries(r.roles.map(x => [x.role, x.value]));
  assert.deepEqual(roles, { background: 'rgb(255, 255, 255)', surface: r.colors.find(c => c.token === tokenOf(r, 'rgb(249, 250, 251)')).value, border: r.colors.find(c => c.token === tokenOf(r, 'rgb(229, 231, 235)')).value,
    text: 'rgb(17, 24, 39)', 'text-muted': 'rgb(107, 114, 128)', accent: 'rgb(37, 99, 235)', 'accent-foreground': 'rgb(255, 255, 255)' });
  assert.ok(r.roles.every(x => x.confidence >= 0 && x.confidence <= 1 && ['high', 'medium', 'low'].includes(x.level)));
  assert.match(tokensCss(r), /--color-text: var\(--grey-\d+\);/);
  assert.match(tokensCss(r), /--radius-1: 8px;/);
});

test('an already tidy page yields no merges', () => {
  const styles = [row('main > p'), row('main > h1', { role: 'h1', fontSize: '32px' }), row('main > p.muted', { color: 'rgb(75, 85, 99)', fontSize: '14px' }), btn('main > button')];
  const paint = { schema: 1, surfaces: [page(), card('main > div', 'rgb(229, 231, 235)'), { selector: 'main > button', background: 'rgb(37, 99, 235)', radius: '8px', kind: 'control', on: 'rgb(255, 255, 255)' }], borders: [border('main > div', 'rgb(156, 163, 175)', 'rgb(229, 231, 235)')], svg: [{ selector: 'main > svg > path', fill: 'rgb(75, 85, 99)', stroke: null }] };
  const r = buildTokens({ scenes: [scene('a', '/a', styles, paint)] });
  assert.ok(r.colors.every(c => c.members.length === 1), JSON.stringify(r.colors.map(c => c.members.map(m => m.value))));
  assert.equal(r.summary.colors.before, r.summary.colors.after);
  assert.deepEqual(r.keptApart, []);
  assert.equal(r.summary.line, '5 greys → 5 · 1 blues → 1 · 1 radii → 1 · 3 font sizes → 3');
  assert.ok(!/merges/.test(tokensCss(r)));
});

test('determinism: scene order does not matter, and two builds are byte-identical', () => {
  const s = i => scene(`s${i}`, `/r${i % 3}`, [row('main > p', { color: ['rgb(17, 24, 39)', 'rgb(20, 24, 39)', 'rgb(30, 30, 30)'][i % 3] }), btn('main > button', { background: i % 2 ? 'rgb(37, 99, 235)' : 'rgb(38, 99, 235)' })]);
  const scenes = [0, 1, 2, 3, 4, 5].map(s);
  const a = stableJson(buildTokens({ scenes })), b = stableJson(buildTokens({ scenes: [...scenes].reverse() }));
  assert.equal(a, b);
});

test('translucent and opaque colours never merge; status colours come from hue with capped confidence; failing contrast is reported', () => {
  const styles = [row('main > p'), row('main > p.two'), row('main > p.hint', { color: 'rgb(156, 163, 175)' }), row('main > p.err', { color: 'rgb(220, 38, 38)' }), row('main > p.ok', { color: 'rgb(22, 163, 74)' })];
  const paint = { schema: 1, surfaces: [page()], borders: [border('main > hr', 'rgba(0, 0, 0, 0.1)', 'rgb(255, 255, 255)'), border('main > div', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)')], svg: [] };
  const r = buildTokens({ scenes: [scene('a', '/a', styles, paint)] });
  assert.notEqual(tokenOf(r, 'rgba(0, 0, 0, 0.1)'), tokenOf(r, 'rgb(0, 0, 0)'));
  const role = n => r.roles.find(x => x.role === n);
  assert.equal(role('danger').value, 'rgb(220, 38, 38)');
  assert.equal(role('success').value, 'rgb(22, 163, 74)');
  assert.ok(role('danger').confidence <= 0.5, 'hue alone is never high confidence');
  assert.equal(role('text-muted').value, 'rgb(156, 163, 175)');
  const muted = r.contrast.find(c => c.fg === 'text-muted' && c.bg === 'background');
  assert.deepEqual([muted.ratio, muted.aa, muted.aaLarge], [2.54, false, false], 'a light grey fails AA on white');
});

test('radii and font sizes: near values share a token, pills and percentages stand apart', () => {
  const styles = [6, 7, 8, 12, 16, 9999].map((n, i) => btn(`main > button:nth-of-type(${i + 1})`, { radius: `${n}px` }))
    .concat([row('main > p.a', { fontSize: '15px' }), row('main > p.b', { fontSize: '16px' }), row('main > p.c', { fontSize: '16px', fontWeight: '600' }), row('main > p.d', { fontSize: '13px' }), row('main > p.e', { fontSize: '14px' }), row('main > p.f', { fontSize: '14.4px' })]);
  const paint = { schema: 1, surfaces: [page(), card('main > img', 'rgb(229, 231, 235)', { radius: '50%' }), card('main > span', 'rgb(229, 231, 235)', { radius: '999px' })], borders: [], svg: [] };
  const r = buildTokens({ scenes: [scene('a', '/a', styles, paint)] });
  assert.deepEqual(r.radii.map(x => [x.token, x.members.map(m => m.value).sort()]), [
    ['--radius-1', ['6px', '7px', '8px']], ['--radius-2', ['12px']], ['--radius-3', ['16px']], ['--radius-full', ['9999px', '999px']], ['--radius-50pct', ['50%']]]);
  assert.deepEqual(r.fontSizes.map(x => x.members.map(m => m.value).sort()), [['13px'], ['14.4px', '14px'], ['15px', '16px']]);
  assert.equal(r.fontSizes.find(f => f.role === 'body').value, '16px', 'the most-used plain-text size is the body size');
  assert.match(tokensCss(r), /--font-size-body: var\(--font-size-3\);/);
});

test('a run captured before paint.json existed still gets a proposal, from the text rows', () => {
  const r = buildTokens({ scenes: [{ id: 'a', screen: '/a', styles: [row('main > p'), btn('main > button'), row('main > div', { background: 'rgb(249, 250, 251)' })], paint: null }] });
  assert.equal(r.measured, 'styles-only');
  assert.ok(r.colors.some(c => c.value === 'rgb(249, 250, 251)' && c.contexts.surface === 1));
  assert.equal(r.roles.find(x => x.role === 'accent').value, 'rgb(37, 99, 235)');
});

test('CLI: nunchi tokens --run writes tokens.json and tokens.css into the run, byte-identical on a second call', () => {
  const dir = tmp('nunchi-tokens-');
  const scenes = [['~.guest.normal.d', '/', 'guest'], ['app.signed-in.normal.d', '/app', 'signed-in'], ['canary-1', '/', 'guest'], ['err.guest.normal.d', '/err', 'guest']];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, scenes: scenes.map(([id, route, person]) => ({ id, route, person, state: 'normal', viewport: 'd', status: 'captured', redirected: false, httpStatus: id.startsWith('err') ? 500 : 200, ...(id.startsWith('canary') ? { canary: 'L6', of: '~.guest.normal.d' } : {}) })) }));
  for (const [id] of scenes) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'styles.json'), JSON.stringify([row('main > p', { color: id.startsWith('canary') || id.startsWith('err') ? 'rgb(255, 0, 0)' : 'rgb(17, 24, 39)' }), btn('main > button')]));
    if (id !== 'app.signed-in.normal.d') writeFileSync(join(dir, id, 'paint.json'), JSON.stringify({ schema: 1, surfaces: [page()], borders: [], svg: [] }));
  }
  assert.deepEqual(readRunScenes(dir).map(s => [s.id, s.screen, !!s.paint]), [['~.guest.normal.d', '/', true], ['app.signed-in.normal.d', '/app (signed-in)', false]], 'canary copies and error pages are left out');
  const out = execFileSync('node', [CLI, 'tokens', '--run', dir], { encoding: 'utf8' });
  assert.match(out, /2 scenes · 2 screens · measured from mixed/);
  assert.match(out, /greys → \d+ · 1 blues → 1/);
  const first = readFileSync(join(dir, 'tokens.json'));
  assert.ok(existsSync(join(dir, 'tokens.css')));
  if (process.platform !== 'win32') for (const f of ['tokens.json', 'tokens.css']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, `${f} is owner-only`);
  assert.ok(!first.toString().includes('rgb(255, 0, 0)'), 'nothing from the canary copy or the error page');
  execFileSync('node', [CLI, 'tokens', '--run', dir], { encoding: 'utf8' });
  assert.ok(first.equals(readFileSync(join(dir, 'tokens.json'))));
  assert.equal(JSON.parse(execFileSync('node', [CLI, 'tokens', '--run', dir, '--json'], { encoding: 'utf8' })).schema, 1);
});
