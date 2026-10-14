// `nunchi export --html` (spec §7.1): a static review page of one run plus the ledger. Hand-built run folders with
// invented content only; no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportHtml, buildModel, escapeHtml } from '../src/export-html.mjs';
import { annotate, foldRun, runForFold, writeDecision, addApproved, approvalKey } from '../src/ledger.mjs';
import { scrubSecrets } from '../src/rules.mjs';
import { redactUrl, redactText } from '../src/network.mjs';
import { sceneDir, sceneIndex } from '../src/hunt.mjs';
import { stableJson } from '../src/stable.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
const SECRET = 'sk_' + 'live_' + 'FixtureOnly0000000000000001';      // assembled here so no secret-shaped literal is committed

// A JPEG header with a SOF0 segment is all jpegSize needs; the pixels are never decoded by the export.
function jpeg(w, h, salt = 0) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, salt & 255, 0xff, 0xd9]);
}
const write = (p, v) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof v === 'string' || Buffer.isBuffer(v) ? v : stableJson(v)); };

// project/.nunchi/runs/0001 with the given scenes and findings, folded into the ledger like `capture` does
function project({ scenes, findings = [], ai = null, decide = null, fold = true }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nunchi-export-')));
  const nunchi = join(root, '.nunchi');
  const run = join(nunchi, 'runs', '0001');
  const vps = [{ id: 'm', width: 390, height: 844 }, { id: 'd', width: 1280, height: 800 }];
  scenes.forEach((s, i) => {
    if (s.noFiles) return;
    const vp = vps.find(v => v.id === s.viewport) || vps[1];
    if (s.status === 'captured') {
      write(join(run, s.id, 'top.jpg'), jpeg(vp.width, vp.height, i));
      write(join(run, s.id, 'full.jpg'), jpeg(vp.width, s.fullHeight || 2000, i + 100));
    }
    write(join(run, s.id, 'measure.json'), { h1: s.h1 ?? null });
    write(join(run, s.id, 'controls.json'), s.controls || []);
    // files the export must never read: a cookie and a token in network evidence
    write(join(run, s.id, 'network.json'), { requests: [{ path: '/api/me?token=NETWORK-TOKEN-1', headers: { cookie: 'sid=COOKIE-VALUE-1' } }] });
    write(join(run, s.id, 'text.txt'), 'PAGE-TEXT-ONLY-IN-TEXT-TXT\n');
  });
  write(join(nunchi, 'har', 'guest.json'), { entries: { a: { body: 'HAR-BODY-1', headers: { authorization: 'Bearer HAR-TOKEN-1' } } } });
  const manifest = { schema: 1, baseUrl: 'http://127.0.0.1:3000', viewports: vps, clock: '2026-01-01T00:00:00.000Z', health: { status: 'ok', problems: [] }, states: ['normal', 'error'], scenes: scenes.map(({ h1, controls, fullHeight, noFiles, ...s }) => s) };
  const scope = { routes: [...new Set(scenes.map(s => s.route))].sort(), persons: ['guest', 'signed-in'], viewports: ['m', 'd'], states: ['normal', 'error'], changedSince: null };
  write(join(run, 'manifest.json'), manifest);
  write(join(run, 'run.json'), { schema: 1, id: '0001', parent: null, commit: '0123456789abcdef', dirty: true, wholeApp: true, scope, health: manifest.health });
  const ann = annotate(findings);
  write(join(run, 'findings.json'), { schema: 1, findings: ann });
  write(join(run, 'flow.json'), { schema: 1, order: [...new Set(scenes.map(s => s.route))] });
  if (ai) write(join(run, 'ai-findings.json'), { schema: 1, findings: ai });
  // folded the way the ledger folds a run folder
  if (fold) write(join(nunchi, 'state', 'ledger.json'), foldRun({ schema: 1, fingerprintVersion: 2, runs: [], items: {} }, runForFold(run)));
  if (decide) {
    const made = decide(ann).map(d => writeDecision(join(nunchi, 'decisions'), d));
    addApproved(join(nunchi, 'state', 'approved.json'), made.map(approvalKey));
  }
  return { root, nunchi, run, findings: ann };
}

// run 0002: a copy of 0001 holding only `findings`, folded into the ledger like the ledger folds it, made latest
function secondRun(p, findings) {
  const run2 = join(p.nunchi, 'runs', '0002');
  for (const f of readdirSync(p.run, { recursive: true }).map(String)) { try { write(join(run2, f), readFileSync(join(p.run, f))); } catch {} }
  const meta = JSON.parse(readFileSync(join(p.run, 'run.json'), 'utf8'));
  write(join(run2, 'run.json'), { ...meta, id: '0002', parent: '0001', commit: null, dirty: null });
  write(join(run2, 'findings.json'), { schema: 1, findings });
  write(join(p.nunchi, 'runs', 'latest'), '0002\n');
  const state = JSON.parse(readFileSync(join(p.nunchi, 'state', 'ledger.json'), 'utf8'));
  const next = foldRun(state, runForFold(run2));
  write(join(p.nunchi, 'state', 'ledger.json'), next);
  return next;
}
const scene = (route, person, state, viewport, extra = {}) => ({
  id: `${route === '/' ? '~' : route.slice(1).replace(/\//g, '~')}.${person}.${state}.${viewport}`, route, path: route, person, state, viewport,
  status: 'captured', reason: null, finalPath: route, httpStatus: 200, findings: 0, dataRequests: 1, replayMisses: 0, ...extra,
});
const finding = (rule, sev, s, extra = {}) => ({ lens: 'L1', rule, severity: sev, scene: s.id, route: s.route, viewport: s.viewport, selector: 'main > p', box: null, evidence: {}, ...extra });

function sample() {
  const home = scene('/', 'guest', 'normal', 'd', { h1: 'Harbor Notes' });
  const homeM = scene('/', 'guest', 'normal', 'm', { h1: 'Harbor Notes' });
  const notes = scene('/notes', 'signed-in', 'normal', 'd', { h1: HOSTILE, controls: [{ selector: 'main > button', box: [100, 200, 50, 20], name: 'Save' }] });
  const notesErr = scene('/notes', 'signed-in', 'error', 'd', { h1: 'Notes' });
  const about = scene('/about', 'guest', 'normal', 'd', { h1: 'About' });
  const findings = [
    finding('clipped-text', 'medium', notes, { selector: 'main > button', evidence: { text: HOSTILE } }),
    finding('raw-error-text', 'high', notesErr, { lens: 'L6', selector: 'body', evidence: { text: `Error: key ${SECRET} rejected` } }),
    finding('dead-href', 'low', home, { lens: 'L7', selector: 'footer a', evidence: { href: '/promo?token=URL-TOKEN-1&x=1' } }),
    finding('dead-href', 'low', homeM, { lens: 'L7', selector: 'footer a', evidence: { href: '/promo?token=URL-TOKEN-1&x=1' } }),
    finding('dead-href', 'low', notesErr, { lens: 'L7', selector: 'footer a', evidence: { href: '/promo?token=URL-TOKEN-1&x=1' } }),   // same group, second fingerprint
    { lens: 'L9', rule: 'secret-in-client-bundle', severity: 'blocker', scene: null, route: null, viewport: null, selector: null, box: null, evidence: { url: '/assets/app.js', kind: 'stripe-live-secret-key', masked: 'sk_l…' } },
  ];
  const ai = [
    { lens: 'L5', rule: 'L5.same-action-different-verb', severity: 'medium', scene: notes.id, route: '/notes', viewport: 'd', selector: 'main > button', box: [100, 200, 50, 20], evidence: { claim: `"Save" here, "Submit" elsewhere ${HOSTILE}`, unit: 'u1', groundedIn: ['controls.json'] }, source: 'ai', status: 'confirmed', verification: { verdict: 'confirmed', verifier: 'same-model check', reason: 'seen' } },
    { lens: 'L7', rule: 'L7.template-copy', severity: 'low', scene: home.id, route: '/', viewport: 'd', selector: 'main > p', box: null, evidence: { claim: 'scaffold copy', unit: 'u2', groundedIn: ['styles.json'] }, source: 'ai', status: 'claimed' },
    { lens: 'L6', rule: 'L6.unclear-label', severity: 'low', scene: home.id, route: '/', viewport: 'd', selector: 'main > a', box: null, evidence: { claim: 'REJECTED-CLAIM', unit: 'u3', groundedIn: [] }, source: 'ai', status: 'rejected' },
  ];
  return { scenes: [home, homeM, notes, notesErr, about], findings, ai };
}

const exportTwice = (p, opts = {}) => {
  const a = join(p.root, 'out-a'), b = join(p.root, 'out-b');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: a, ...opts });
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: b, ...opts });
  return [a, b];
};
const filesOf = dir => readdirSync(dir, { recursive: true }).map(String).filter(f => statSync(join(dir, f)).isFile()).sort();

test('export --html: byte-identical twice, linked and inline; images named by content hash', () => {
  const s = sample();
  const p = project({ ...s, decide: ann => [{ target: { group: ann.find(f => f.rule === 'raw-error-text').group }, decision: 'fix', by: 'tester' }] });
  const [a, b] = exportTwice(p);
  assert.deepEqual(filesOf(a), filesOf(b));
  for (const f of filesOf(a)) assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), `${f} differs`);
  const imgs = readdirSync(join(a, 'img')).filter(f => f.endsWith('.jpg')).sort();
  assert.equal(readFileSync(join(a, 'img', '.nunchi-export'), 'utf8'), imgs.map(f => f + '\n').join(''), 'the marker lists exactly the images written');
  assert.equal(imgs.length, 5, 'one full screenshot per captured scene');
  for (const f of imgs) assert.equal(f, createHash('sha256').update(readFileSync(join(a, 'img', f))).digest('hex').slice(0, 16) + '.jpg');
  const [c, d] = exportTwice(p, { inline: true });
  assert.ok(readFileSync(join(c, 'index.html')).equals(readFileSync(join(d, 'index.html'))));
  assert.ok(!existsSync(join(c, 'img')), 'inline export is one file');
  assert.match(readFileSync(join(c, 'index.html'), 'utf8'), /url\("data:image\/jpeg;base64,/);
  // a second export into the same folder replaces img/ rather than piling up
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: a, inline: true });
  assert.ok(!existsSync(join(a, 'img')));
});

test('export --html: app text is escaped as data; only the page\'s own script runs, under a strict CSP', () => {
  const p = project(sample());
  const out = join(p.root, 'out');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.equal((html.match(/<script/g) || []).length, 1, 'exactly one script element, the export\'s own');
  assert.ok(!html.includes('<img'), 'no <img> element at all: screenshots are CSS backgrounds');
  assert.ok(!/<[a-z]+[^>]*\son[a-z]+=/i.test(html), 'no inline event handler attribute');
  assert.ok(html.includes(escapeHtml('<script>alert(1)</script>')), 'the hostile heading is shown as text');
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'));
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.ok(!/https?:/.test(csp), 'nothing external is allowed');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'the script is allowed by its hash only');
  assert.ok(!/(href|src)="(https?:)?\/\//.test(html), 'no external link or load');
  assert.ok(!/@import|fonts\.googleapis/.test(html));
});

test('export --html: no HAR, cookies, tokens, network bodies or page text; secrets show location and kind only', () => {
  const p = project(sample());
  const out = join(p.root, 'out');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  for (const s of ['NETWORK-TOKEN-1', 'COOKIE-VALUE-1', 'HAR-BODY-1', 'HAR-TOKEN-1', 'PAGE-TEXT-ONLY-IN-TEXT-TXT', 'URL-TOKEN-1', SECRET, 'sk_l…', 'REJECTED-CLAIM']) assert.ok(!html.includes(s), `${s} leaked into the page`);
  assert.ok(html.includes('[secret-shaped: stripe-live-secret-key]'), 'a secret quoted in evidence text is replaced by its kind');
  assert.ok(html.includes('/assets/app.js'), 'the secret finding keeps its location');
  assert.ok(html.includes('token=REDACTED'), 'credential query values are redacted');
  assert.equal(scrubSecrets(`a ${SECRET} b`), 'a [secret-shaped: stripe-live-secret-key] b');
});

test('export --html: findings with ledger statuses, boxes from the element box, Screens badges and filters', () => {
  const s = sample();
  const p = project({ ...s, decide: ann => [
    { target: { group: ann.find(f => f.rule === 'raw-error-text').group }, decision: 'fix', by: 'tester' },
    { target: { group: ann.find(f => f.rule === 'dead-href').group }, decision: 'keep', reason: 'intended', by: 'tester', note: HOSTILE },
  ] });
  const m = buildModel({ runDir: p.run, nunchiDir: p.nunchi });
  assert.equal(m.inLedger, true);
  assert.equal(m.scenes.length, 5);
  const byRule = Object.fromEntries(m.groups.map(g => [g.rule, g]));
  assert.equal(byRule['raw-error-text'].status, 'to-fix');
  assert.equal(byRule['dead-href'].status, 'kept');
  assert.equal(byRule['clipped-text'].status, 'open');
  assert.ok(byRule['L5.same-action-different-verb'].ai.verified);
  assert.equal(byRule['L7.template-copy'].ai.verified, false, 'a claimed AI finding is not double-checked');
  assert.ok(!byRule['L6.unclear-label'], 'rejected AI claims never become items');
  // claimed AI items sit in a collapsed last section, rule and confirmed kinds before them
  assert.equal(m.kinds[m.kinds.length - 1].rule, 'L7.template-copy');
  assert.deepEqual(m.kinds.slice(0, 2).map(k => k.severity), ['blocker', 'high']);
  const out = join(p.root, 'out');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  for (const v of ['id="progress"', 'id="findings"', 'id="screens"', `id="f-${byRule['clipped-text'].group}"`]) assert.ok(html.includes(v), v);
  assert.match(html, /Not yet · 1 blocker, 1 high/);
  // the clipped button's box [100,200,50,20] on a 1280×2000 screenshot, cropped to a first-view-high window from the top
  assert.ok(html.includes('left:7.81%;top:25%;width:3.91%;height:2.5%'), 'box positioned in percentages of the crop');
  assert.ok(html.includes(`nunchi decide ${byRule['clipped-text'].group} keep --reason intended`), 'decisions are offered as CLI commands');
  for (const g of m.groups) assert.ok(html.includes(`<dt>Fingerprints</dt><dd class="mono">${g.fps.join(' ')}</dd>`), `every fingerprint of ${g.rule} in full`);
  assert.ok(!/<button[^>]*>\s*(Fix|Keep|Not a problem|Later)\b/.test(html), 'no decision buttons that would do nothing');
  assert.match(html, /class="badge badge-clean">Clean</, '/about has nothing: Clean');
  assert.match(html, /class="badge badge-medium">2 medium</, '/notes: the rule and the AI finding');
  assert.match(html, /class="badge badge-clean">Nothing open</, '/ on the phone: its one finding was kept');
  assert.ok(html.includes('id="sw-d" value="d" checked') && html.includes('id="ss-normal" value="normal" checked'), 'Screens default to desktop, normal');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'decision notes are data too');
  assert.match(html, /<nav class="side" aria-label="nunchi">/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /class="sev sev-high"><span class="dot" aria-hidden="true"><\/span>High</, 'severity has a text label beside its dot');
});

test('export --html: a run with zero findings is Clean; a run not in the ledger is folded in memory only', () => {
  const p = project({ scenes: [scene('/', 'guest', 'normal', 'd', { h1: 'Home' }), scene('/help', 'guest', 'normal', 'm', { h1: 'Help' })], fold: false });
  const out = join(p.root, 'out');
  const r = exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out });
  assert.equal(r.groups, 0); assert.equal(r.inLedger, false);
  assert.ok(!existsSync(join(p.nunchi, 'state', 'ledger.json')), 'the export never writes the ledger');
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /Clean · nothing found in this run/);
  assert.equal((html.match(/class="badge badge-clean">Clean</g) || []).length, 2);
  assert.match(html, /Probably · rules only — the AI review hasn’t run/);
  assert.match(html, /not in the local ledger/);
});

test('export --html: a defect gone in this run shows as fixed; CLI writes the page and refuses without --html', () => {
  const s = sample();
  const p = project(s);
  // a second run without the clipped text: the ledger marks it gone in 0002
  const next = secondRun(p, p.findings.filter(f => f.rule !== 'clipped-text'));
  assert.equal(Object.values(next.items).find(i => i.rule === 'clipped-text').goneAt, '0002');
  const json = JSON.parse(execFileSync('node', [CLI, 'export', '--html', 'review', '--json'], { cwd: p.root, encoding: 'utf8' }));
  assert.equal(json.run, '0002');
  const html = readFileSync(join(p.root, 'review', 'index.html'), 'utf8');
  assert.match(html, /Since run 0001/);
  assert.match(html, /<b class="good">1<\/b> fixed/);
  assert.match(html, /Gone on re-capture in run 0002/);
  assert.throws(() => execFileSync('node', [CLI, 'export'], { cwd: p.root, stdio: 'pipe' }), /--html/);
  assert.throws(() => execFileSync('node', [CLI, 'export', '--html', '.nunchi/runs/x'], { cwd: p.root, stdio: 'pipe' }), /outside \.nunchi\/runs/);
});

// ---- regressions from the adversarial review (2026-10-14 KST) ------------------------------------------

const htmlOf = (p, opts = {}) => { const out = join(p.root, 'out'); exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: out, ...opts }); return readFileSync(join(out, 'index.html'), 'utf8'); };
const oneFinding = (evidence, extra = {}) => {
  const home = scene('/', 'guest', 'normal', 'd', { h1: 'Home' });
  return project({ scenes: [home], findings: [finding('raw-error-text', 'high', home, { evidence, ...extra })] });
};
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'fixture-user', role: 'authenticated' })}.${'s'.repeat(24)}SIGTAIL`;

test('export --html: never deletes, follows or replaces what it did not write; the runs check survives symlinks', () => {
  const p = project(sample());
  const run = outDir => exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir });
  // a folder of the user's own: their index.html and img/logos/brand.svg stay as they were
  const mine = join(p.root, 'site');
  write(join(mine, 'index.html'), '<h1>my site</h1>');
  write(join(mine, 'img', 'logos', 'brand.svg'), '<svg/>');
  assert.throws(() => run(mine), e => e.code === 'EXPORT_TARGET' && /not written by nunchi export/.test(e.message));
  assert.equal(readFileSync(join(mine, 'index.html'), 'utf8'), '<h1>my site</h1>');
  rmSync(join(mine, 'index.html'));
  assert.throws(() => run(mine), e => e.code === 'EXPORT_TARGET' && /did not write/.test(e.message));
  assert.equal(readFileSync(join(mine, 'img', 'logos', 'brand.svg'), 'utf8'), '<svg/>');
  // a symlinked index.html is never written through
  const linked = join(p.root, 'linked');
  write(join(p.root, 'notes.txt'), 'my notes');
  mkdirSync(linked);
  symlinkSync(join(p.root, 'notes.txt'), join(linked, 'index.html'));
  assert.throws(() => run(linked), e => e.code === 'EXPORT_TARGET' && /symlink/.test(e.message));
  assert.equal(readFileSync(join(p.root, 'notes.txt'), 'utf8'), 'my notes');
  // a re-export removes only the images it listed; a file the user added to img/ stays
  const ok = join(p.root, 'review');
  run(ok);
  write(join(ok, 'img', 'mine.png'), 'PNG');
  run(ok);
  assert.equal(readFileSync(join(ok, 'img', 'mine.png'), 'utf8'), 'PNG');
  exportHtml({ runDir: p.run, nunchiDir: p.nunchi, outDir: ok, inline: true });
  assert.deepEqual(readdirSync(join(ok, 'img')), ['mine.png'], 'inline: our images and marker gone, the user\'s file kept');
  // .nunchi/runs through a symlink is still .nunchi/runs; so is the run folder itself
  symlinkSync(join(p.nunchi, 'runs'), join(p.root, 'sneaky'));
  assert.throws(() => run(join(p.root, 'sneaky', 'page')), e => e.code === 'EXPORT_TARGET' && /\.nunchi\/runs/.test(e.message));
  assert.ok(!existsSync(join(p.nunchi, 'runs', 'page')));
  // `--html --inline` is a missing value, not a folder called --inline
  assert.throws(() => execFileSync('node', [CLI, 'export', '--html', '--inline'], { cwd: p.root, stdio: 'pipe' }), /--html <dir>/);
  assert.ok(!existsSync(join(p.root, '--inline')));
});

test('scrubSecrets: whole private key blocks of every kind, cut-off ones included', () => {
  for (const kind of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ', '']) {
    const block = `-----BEGIN ${kind}PRIVATE KEY-----\nMIIBOgIBAAJBAKjFIXTUREBODY\nAAAAmore\n-----END ${kind}PRIVATE KEY-----`;
    assert.equal(scrubSecrets(`key: ${block} done`), 'key: [secret-shaped: private-key] done', kind);
  }
  assert.equal(scrubSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFIXTUREBODY\n-----END PGP PRIVATE KEY BLOCK-----'), '[secret-shaped: private-key]');
  assert.equal(scrubSecrets('x -----BEGIN RSA PRIVATE KEY-----\nMIIFIXTUREBODY cut off'), 'x [secret-shaped: private-key]', 'a block cut off before its END line');
  const html = htmlOf(oneFinding({ text: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKjFIXTUREBODY\n-----END RSA PRIVATE KEY-----' }));
  assert.ok(!html.includes('FIXTUREBODY'));
});

test('export --html: secrets inside arrays and objects are redacted leaf by leaf, before serialising', () => {
  // serialised first, `\n` becomes the letter n right before the token, and a word-boundary pattern no longer sees it
  const gh = 'ghp' + '_' + 'F1xture'.repeat(6);
  const html = htmlOf(oneFinding({ lines: ['Error:\n' + gh, 'Error:\n' + SECRET, { deeper: [`k=${SECRET}`] }], [`k ${SECRET}`]: 1 }));
  assert.ok(!html.includes('FixtureOnly') && !html.includes('F1xture'), 'no part of either key');
  assert.ok(html.includes('[secret-shaped: stripe-live-secret-key]') && html.includes('[secret-shaped: github-token]'));
});

test('export --html: redaction runs before clipping, so a cut never leaves part of a secret', () => {
  const html = htmlOf(oneFinding({ text: 'x'.repeat(384) + ' ' + SECRET }, { selector: 'main ' + 'p '.repeat(143) + SECRET }));
  assert.ok(!html.includes('sk_live_Fix') && !html.includes('FixtureOnly'), 'no prefix of the key survives the clip');
});

test('scrubSecrets and redactUrl: the wider set of secret shapes, credential params in any text, URL userinfo', () => {
  const cases = [
    ['ASIA' + 'Q'.repeat(16), 'aws-access-key-id'], ['github_' + 'pat_' + 'A1'.repeat(15), 'github-token'],
    ['xapp-' + '1-A0B1C2D3E4F5', 'slack-token'], ['xoxe.' + 'xoxp-1-abcdefgh12', 'slack-token'], ['AI' + 'za' + 'S'.repeat(35), 'google-api-key'],
    ['rk_' + 'live_' + 'R'.repeat(20), 'stripe-live-restricted-key'], ['sk-' + 'ant-' + 'api03-' + 'a'.repeat(30), 'anthropic-api-key'],
    ['key_sk_' + 'live_' + 'Z'.repeat(20), 'stripe-live-secret-key'], [JWT.replace(/\./g, '\n.'), 'jwt'],
  ];
  for (const [secret, kind] of cases) assert.ok(scrubSecrets(`v ${secret} w`).includes(`[secret-shaped: ${kind}]`) && !scrubSecrets(`v ${secret} w`).includes(secret.slice(-8)), `${kind}: ${secret}`);
  assert.equal(scrubSecrets('aws_secret_access_key = ' + 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYFIXTURE'), 'aws_secret_access_key = [secret-shaped: aws-secret-access-key]');
  assert.equal(scrubSecrets('Authorization: Bearer abc.def-ghi_jkl9'), 'Authorization: Bearer [secret-shaped: authorization]');
  assert.equal(scrubSecrets('Authorization: required for this page'), 'Authorization: required for this page', 'page text without a credential stays');
  assert.equal(scrubSecrets('sent Bearer ' + 'T'.repeat(23) + '7'), 'sent Bearer [secret-shaped: bearer-token]');
  // review B8: cookies, key headers, a digitless Basic credential, a token in a URL path
  assert.equal(scrubSecrets('Cookie: sid=fixture; theme=dark'), 'Cookie: [secret-shaped: cookie]');
  assert.equal(scrubSecrets('Set-Cookie: session=FixtureValue; Path=/; HttpOnly'), 'Set-Cookie: [secret-shaped: cookie]');
  assert.equal(scrubSecrets('document.cookie = "sid=fixture"'), 'document.cookie = "[secret-shaped: cookie]"');
  assert.equal(scrubSecrets('x-api-key: ' + 'fixture' + 'key42'), 'x-api-key: [secret-shaped: api-key]');
  assert.equal(scrubSecrets('{"apiKey": "' + 'abcdefghijklmnopqrstuv' + '"}'), '{"apiKey": "[secret-shaped: api-key]"}', 'no digit, but 20 characters or more');
  assert.equal(scrubSecrets('X-Auth-Token=' + 'Fx7'.repeat(4)), 'X-Auth-Token=[secret-shaped: api-key]');
  assert.equal(scrubSecrets('Authorization: Basic ' + 'Zml4dHVyZTpmaXh0dXJl'.replace(/\d/g, 'Q')), 'Authorization: Basic [secret-shaped: authorization]', 'base64 of user:password with no digit');
  assert.equal(scrubSecrets('GET /reset-password/' + 'aB3dE5gH7jK9mN1pQ3sT5vX7' + '?x=1'), 'GET /reset-password/[secret-shaped: url-path-token]?x=1');
  assert.equal(scrubSecrets('/invite/' + '9f8e7d6c5b4a39281706f5e4d3c2b1a0'), '/invite/[secret-shaped: url-path-token]');
  for (const keep of ['Cookie settings', 'Cookie: required', 'Session ID: shown below', '/settings/notification-preferences-for-teams', '/_next/static/chunks/app-3f9a8b7c6d5e.js', '/docs/GettingStartedWithTheApp']) {
    assert.equal(scrubSecrets(keep), keep, `page text and ordinary paths stay: ${keep}`);
  }
  assert.equal(redactUrl('https://bob:hunter2@db.example.test/x?token=1'), 'https://db.example.test/x?token=REDACTED');
  assert.equal(redactText('connect https://bob:hunter2@db.example.test failed'), 'connect https://db.example.test failed');
  const html = htmlOf(oneFinding({ message: 'see /x?api_key=K9FIXTURE9&y=1 and https://bob:hunter2pass@db.example.test/', href: 'https://ann:pw4fixture@h.example.test/p' }));
  for (const leak of ['K9FIXTURE9', 'hunter2pass', 'pw4fixture']) assert.ok(!html.includes(leak), leak);
});

test('export --html: an older run shows the ledger as it stood after that run, not later fixes', () => {
  const s = sample();
  const p = project(s);
  const next = secondRun(p, p.findings.filter(f => f.rule !== 'clipped-text'));
  assert.equal(Object.values(next.items).find(i => i.rule === 'clipped-text').goneAt, '0002', 'the ledger now says fixed');
  const m = buildModel({ runDir: p.run, nunchiDir: p.nunchi });
  const clipped = m.groups.find(g => g.rule === 'clipped-text');
  assert.equal(clipped.status, 'open', 'in run 0001 it was open; it is fixed only from 0002 on');
  assert.equal(m.asOfNow, false);
  const html = htmlOf(p);
  assert.match(html, /Not yet · 1 blocker, 1 high/);
  assert.match(html, /as they stood after this run/);
  assert.ok(!html.includes('Gone on re-capture'));
  // older runs gone (gc): the current ledger rewound instead, and the page says so
  const st = JSON.parse(readFileSync(join(p.nunchi, 'state', 'ledger.json'), 'utf8'));
  write(join(p.nunchi, 'state', 'ledger.json'), { ...st, runs: ['0000', ...st.runs] });
  const m2 = buildModel({ runDir: p.run, nunchiDir: p.nunchi });
  assert.equal(m2.asOfNow, true);
  assert.equal(m2.groups.find(g => g.rule === 'clipped-text').status, 'open');
});

test('export --html: scene ids that are not one plain path segment are never opened', () => {
  const home = scene('/', 'guest', 'normal', 'd', { h1: 'Home' });
  const evil = { ...scene('/evil', 'guest', 'normal', 'd'), id: '../../../../outside', noFiles: true };
  const p = project({ scenes: [home, evil], findings: [finding('clipped-text', 'medium', evil, { selector: 'main > b' })] });
  write(join(p.root, '..', 'outside', 'measure.json'), { h1: 'OUTSIDE-H1' });
  write(join(p.run, '..', '..', '..', '..', 'outside', 'measure.json'), { h1: 'OUTSIDE-H1' });
  write(join(p.run, '..', '..', '..', '..', 'outside', 'controls.json'), [{ selector: 'main > b', box: [1, 2, 3, 4] }]);
  const html = htmlOf(p);
  assert.ok(!html.includes('OUTSIDE-H1'));
  assert.equal(buildModel({ runDir: p.run, nunchiDir: p.nunchi }).scenes.length, 1);
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'c:x', '../x', null]) assert.equal(sceneDir(p.run, bad), null, String(bad));
  assert.equal(sceneDir(p.run, home.id), join(p.run, home.id));
  assert.equal(sceneIndex(p.run, '../../../../outside').idx.size, 0);
});

test('export --html: tampered run files cannot add markup through enums, ids or counts', () => {
  const home = scene('/', 'guest', 'normal', 'd', { h1: 'Home' });
  const odd = { ...scene('/odd', 'guest', 'normal', 'd', { h1: 'Odd' }), viewport: 'm"><q>Q</q>' };
  const p = project({ scenes: [home, odd] });
  const meta = '<meta http-equiv="refresh" content="0;url=data:,x">';
  write(join(p.run, 'findings.json'), { schema: 1, findings: [
    { lens: 'L1', rule: 'clipped-text', severity: `high">${meta}`, scene: home.id, route: '/', viewport: 'd"><u>U</u>', selector: 'main', box: ['<s>', 1, 2, 3], evidence: {}, fp: '"><i>I</i>', group: '<b>G</b>' },
    { lens: 'L1', rule: 'clipped-text', severity: 'low', scene: odd.id, route: '/odd', viewport: odd.viewport, selector: 'main', box: [1, 2, 3, 4], evidence: {}, fp: 'abcdefabcdef', group: 'abcdefabcdef' },
  ] });
  write(join(p.run, 'ai-findings.json'), { schema: 1, findings: [] });
  write(join(p.run, 'coverage.json'), { summary: { seen: '<em>E</em>', cells: '<em>' } });
  const man = JSON.parse(readFileSync(join(p.run, 'manifest.json'), 'utf8'));
  write(join(p.run, 'manifest.json'), { ...man, health: { status: 'recording-stale', problems: [{ status: 'recording-stale', scenes: '<del>D</del>', of: '<ins>' }] } });
  rmSync(join(p.nunchi, 'state', 'ledger.json'));
  const html = htmlOf(p);
  for (const bad of ['http-equiv="refresh"', '<u>', '<i>', '<b>G', '<q>', '<em>', '<del>', '<ins>', '<s>']) assert.ok(!html.includes(bad), bad);
  assert.equal((html.match(/<meta /g) || []).length, 5, 'only the page\'s own five meta elements');
  assert.ok(!/(?:id|href|for|name|data-copy)="[^"]*[<>]/.test(html), 'ids and links carry no markup');
});

test('export --html: screenshot labels are escaped once', () => {
  const s = { ...scene('/notes', 'signed-in', 'r&d', 'd', { h1: 'Notes' }) };
  const html = htmlOf(project({ scenes: [s] }));
  assert.ok(html.includes('aria-label="Screenshot of /notes, Signed in · Desktop · r&amp;d"'));
  assert.ok(!html.includes('&amp;amp;'));
});

test('export --html: hostile route, selector and evidence key, and a JWT, arrive as inert text', () => {
  const route = '/x<script>alert(3)</script>';
  const s = { ...scene('/x', 'guest', 'normal', 'd', { h1: 'X' }), route };
  const p = project({ scenes: [s], findings: [finding('raw-error-text', 'high', s, { route, selector: 'main"><svg onload=alert(4)>', evidence: { '<k onclick=alert(5)>': 'v', text: `token ${JWT} end` } })] });
  const html = htmlOf(p);
  assert.equal((html.match(/<script/g) || []).length, 1);
  for (const bad of ['<svg', '<k ', 'onclick=alert(5)>', 'SIGTAIL']) assert.ok(!html.includes(bad), bad);
  assert.ok(html.includes('/x&lt;script&gt;alert(3)&lt;/script&gt;'), 'the route is shown, escaped');
  assert.ok(html.includes('main&quot;&gt;&lt;svg onload=alert(4)&gt;'), 'the selector is shown, escaped');
  assert.ok(html.includes('&lt;k onclick=alert(5)&gt;'), 'the evidence key is shown, escaped');
  assert.ok(html.includes('[secret-shaped: jwt]'));
});

test('export --html: reads the M1a ledger (aliases, not looked at, blind runs) and off-origin screens', () => {
  const home = scene('/', 'guest', 'normal', 'd', { h1: 'Home' });
  const away = { ...scene('/pay', 'signed-in', 'normal', 'd'), status: 'capture-failed', reason: 'redirected-off-origin', finalOrigin: 'https://pay.example.test', finalPath: '/checkout', noFiles: true };
  const p = project({ scenes: [home, away], findings: [finding('clipped-text', 'medium', home, { selector: 'main > p' }), finding('dead-href', 'low', home, { lens: 'L7', selector: 'footer a' })] });
  const state = JSON.parse(readFileSync(join(p.nunchi, 'state', 'ledger.json'), 'utf8'));
  const clipped = Object.values(state.items).find(i => i.rule === 'clipped-text');
  // the run's findings.json names the clipped text by an older fingerprint; the ledger's aliases name it now
  const doc = JSON.parse(readFileSync(join(p.run, 'findings.json'), 'utf8'));
  for (const f of doc.findings) if (f.rule === 'clipped-text') Object.assign(f, { fp: 'a1a1a1a1a1a1', group: 'b2b2b2b2b2b2' });
  write(join(p.run, 'findings.json'), doc);
  // three later runs (as this one is numbered now) never looked at it again, and the last one could not judge
  write(join(p.run, 'run.json'), { ...JSON.parse(readFileSync(join(p.run, 'run.json'), 'utf8')), id: '0004' });
  write(join(p.nunchi, 'state', 'ledger.json'), { ...state, runs: ['0001', '0002', '0003', '0004'], blind: { '0004': 'recording-stale' },
    aliases: { fp: { a1a1a1a1a1a1: clipped.fp }, group: { b2b2b2b2b2b2: clipped.group } } });
  const m = buildModel({ runDir: p.run, nunchiDir: p.nunchi });
  const g = m.groups.find(x => x.rule === 'clipped-text');
  assert.equal(g.group, clipped.group);
  assert.equal(g.instances.length, 1, 'the run\'s old fingerprint reaches the ledger item');
  const html = htmlOf(p);
  assert.match(html, /Not looked at since run 0001/);
  assert.match(html, /This run could not tell what was fixed: most screens asked for data the recording does not have/);
  assert.match(html, /class="badge badge-dark">Left the app</);
  assert.ok(html.includes('Sent to https://pay.example.test') && !html.includes('href="https://pay'), 'the other site is named, never linked');
});

test('export --html: a decision this machine has not noted yet still counts, and the page is the same bytes later', () => {
  const s = sample();
  const p = project({ ...s, decide: ann => [{ target: { group: ann.find(f => f.rule === 'clipped-text').group }, decision: 'hold', by: 'tester' }] });
  const a = htmlOf(p);
  assert.equal(buildModel({ runDir: p.run, nunchiDir: p.nunchi }).groups.find(g => g.rule === 'clipped-text').status, 'held');
  assert.equal(htmlOf(p), a);
});
