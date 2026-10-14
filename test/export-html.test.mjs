// `nunchi export --html` (spec §7.1): a static review page of one run plus the ledger. Hand-built run folders with
// invented content only; no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportHtml, buildModel, escapeHtml } from '../src/export-html.mjs';
import { annotate, foldRun, writeDecision, addApproved } from '../src/ledger.mjs';
import { scrubSecrets } from '../src/rules.mjs';
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
    const vp = vps.find(v => v.id === s.viewport);
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
  const manifest = { schema: 1, baseUrl: 'http://127.0.0.1:3000', viewports: vps, clock: '2026-01-01T00:00:00.000Z', health: { status: 'ok', problems: [] }, states: ['normal', 'error'], scenes: scenes.map(({ h1, controls, fullHeight, ...s }) => s) };
  const scope = { routes: [...new Set(scenes.map(s => s.route))].sort(), persons: ['guest', 'signed-in'], viewports: ['m', 'd'], states: ['normal', 'error'], changedSince: null };
  write(join(run, 'manifest.json'), manifest);
  write(join(run, 'run.json'), { schema: 1, id: '0001', parent: null, commit: '0123456789abcdef', dirty: true, scope, health: manifest.health });
  const ann = annotate(findings);
  write(join(run, 'findings.json'), { schema: 1, findings: ann });
  write(join(run, 'flow.json'), { schema: 1, order: [...new Set(scenes.map(s => s.route))] });
  if (ai) write(join(run, 'ai-findings.json'), { schema: 1, findings: ai });
  if (fold) write(join(nunchi, 'state', 'ledger.json'), foldRun({ schema: 1, fingerprintVersion: 1, runs: [], items: {} }, { id: '0001', scope, health: manifest.health, findings: ann }));
  if (decide) {
    const made = decide(ann).map(d => writeDecision(join(nunchi, 'decisions'), d));
    addApproved(join(nunchi, 'state', 'approved.json'), made.map(d => d.id));
  }
  return { root, nunchi, run, findings: ann };
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
  const imgs = readdirSync(join(a, 'img')).sort();
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
  const state = JSON.parse(readFileSync(join(p.nunchi, 'state', 'ledger.json'), 'utf8'));
  const rest = p.findings.filter(f => f.rule !== 'clipped-text');
  const scope = JSON.parse(readFileSync(join(p.run, 'run.json'), 'utf8')).scope;
  write(join(p.nunchi, 'state', 'ledger.json'), foldRun(state, { id: '0002', scope, health: { problems: [] }, findings: rest }));
  const run2 = join(p.nunchi, 'runs', '0002');
  for (const f of readdirSync(p.run, { recursive: true }).map(String)) {
    const src = join(p.run, f);
    try { write(join(run2, f), readFileSync(src)); } catch {}
  }
  write(join(run2, 'run.json'), { schema: 1, id: '0002', parent: '0001', commit: null, dirty: null, scope, health: { status: 'ok', problems: [] } });
  write(join(run2, 'findings.json'), { schema: 1, findings: rest });
  write(join(p.nunchi, 'runs', 'latest'), '0002\n');
  const json = JSON.parse(execFileSync('node', [CLI, 'export', '--html', 'review', '--json'], { cwd: p.root, encoding: 'utf8' }));
  assert.equal(json.run, '0002');
  const html = readFileSync(join(p.root, 'review', 'index.html'), 'utf8');
  assert.match(html, /Since run 0001/);
  assert.match(html, /<b class="good">1<\/b> fixed/);
  assert.match(html, /Gone on re-capture in run 0002/);
  assert.throws(() => execFileSync('node', [CLI, 'export'], { cwd: p.root, stdio: 'pipe' }), /--html/);
  assert.throws(() => execFileSync('node', [CLI, 'export', '--html', '.nunchi/runs/x'], { cwd: p.root, stdio: 'pipe' }), /outside \.nunchi\/runs/);
});
