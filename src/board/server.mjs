// The live board's server (design 0.1-c §3.1–§3.3), `node:http` only, no dependency.
//
// Security (design §3.2; every check has a test in test/board-security.test.mjs):
// - bound to 127.0.0.1 only; the Host header must be exactly `127.0.0.1:<port>` (never `localhost`, which may resolve
//   to ::1 where another process can listen): otherwise 421. This is the DNS-rebinding guard.
// - a session token per browser tab, 32 random bytes, in this process's memory only (never in a file, an argument, an
//   environment variable or a cookie). The browser gets a one-time launch code in the link's fragment
//   (`/#t=<code>`, valid 2 minutes, spent on first use), trades it for a token (POST /api/session), and drops the
//   fragment from the address bar. Every other request sends the token as `X-Nunchi-Token`, compared as
//   timingSafeEqual(sha256(a), sha256(b)). Screenshots are fetched with the token and shown as blob URLs; the live
//   channel is a fetch stream, not EventSource (neither <img> nor EventSource can send a header). Only the page shell
//   (/, its stylesheet and scripts, which hold no data) answers without a token.
// - `Sec-Fetch-Site`, when sent, must be same-origin or none; `req.url` must start with `/`. Writes are POST with
//   `Content-Type: application/json`, `Origin` equal to the board's, a body ≤ 64 KB. No CORS headers; OPTIONS → 405.
// - every response: a strict CSP, X-Frame-Options DENY, nosniff, no referrer, CORP and COOP same-origin, no-store.
// - files: the bundled board assets, and evidence screenshots from an allow-list of names, of runs and scenes the
//   run's manifest names; the run folder is no link and lies inside the real `.nunchi/runs`; the file is opened with
//   O_NOFOLLOW, fstat-ed and served from that descriptor, as image/jpeg only (no SVG, nothing else).
// - rate limits on failed keys, requests, writes and streams.
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, openSync, fstatSync, readSync, closeSync, lstatSync, realpathSync, readdirSync, statSync, unlinkSync, watch, constants, chmodSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir, userInfo } from 'node:os';
import { buildBoardModel, groupList, groupDetail, screenWall, safe, RUN_ID } from './model.mjs';
import { BASE_CSS, BOARD_CSS } from './look.mjs';
import { decidedText, CAP_MS } from './shared.mjs';
import * as P from '../project.mjs';
import { DECISIONS, protectOf, newId } from '../ledger.mjs';
import { listRuns, workTree } from '../runs.mjs';
import { readGeneration } from '../state.mjs';
import { readManifest, sceneDir } from '../hunt.mjs';
import { writeStable, privateDir, sha } from '../stable.mjs';
import { recordDecisionTime, metricsPath } from '../metrics.mjs';
import { checkProfile, approvedProfiles, approveProfile, scriptsApprovedPath, checksRequestPath } from '../checks.mjs';
import { labelPool, blindItem, lensTable, readLabels, writeLabel, LABELLER } from '../labels.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=()',
};
export const MAX_BODY = 64 * 1024;
export const MAX_URL = 2048;
export const CODE_TTL_MS = 120e3;
export const IDLE_MS = 2 * 3600e3;
export const MAX_SESSIONS = 32, MAX_STREAMS = 8;
// rate limits: [events, per milliseconds] — wrong keys or links (then a minute's wait for requests without a key),
// all requests, writes, link exchanges
export const LIMITS = { fail: [30, 60e3], req: [600, 10e3], write: [60, 10e3], session: [20, 60e3] };
const EVIDENCE_FILES = { 'full.jpg': 'image/jpeg', 'top.jpg': 'image/jpeg' };
const EVIDENCE_MAX = 32 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX12 = /^[0-9a-f]{12}$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;

// The page shell and its assets: bundled with nunchi, read once, the same bytes for every board.
function assets() {
  const read = f => readFileSync(join(HERE, f));
  return {
    '/': { body: read('assets/index.html'), type: 'text/html; charset=utf-8' },
    '/assets/board.js': { body: read('assets/board.js'), type: 'text/javascript; charset=utf-8' },
    '/assets/shared.mjs': { body: read('shared.mjs'), type: 'text/javascript; charset=utf-8' },
    '/assets/board.css': { body: Buffer.from(BASE_CSS + BOARD_CSS), type: 'text/css; charset=utf-8' },
  };
}

const hash = s => createHash('sha256').update(String(s)).digest();
// constant time, whatever the lengths
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(hash(a), hash(b));

// A window of `max` events per `ms`.
function limiter(max, ms) {
  let times = [];
  return { hit(now = Date.now()) { times = times.filter(t => now - t < ms); if (times.length >= max) return false; times.push(now); return true; }, reset() { times = []; } };
}

// The browser opener of this platform. The link is checked first: only a board link with a launch code is opened.
export function openerCommand(url, platform = process.platform) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/#t=[0-9a-f]{64}$/.test(url)) throw new Error('not a board link');
  if (platform === 'darwin') return { cmd: '/usr/bin/open', args: [url] };
  if (platform === 'win32') return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`], opts: { windowsVerbatimArguments: true } };
  return { cmd: 'xdg-open', args: [url] };
}
function openInBrowser(url) {
  const { cmd, args, opts = {} } = openerCommand(url);
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...opts }); c.on('error', () => {}); c.unref(); return true; } catch { return false; }
}

// Where the control socket lives (design §3.1: a local socket, mode 0600, through which a second `nunchi open` asks
// this server to open the browser with a fresh link). It never hands out a link or a token.
export function controlPath(stateDir, pid, platform = process.platform) {
  if (platform === 'win32') return `\\\\.\\pipe\\nunchi-board-${sha(`${stateDir}|${pid}`, 16)}`;
  const inState = join(stateDir, 'boards', `${pid}.sock`);
  if (Buffer.byteLength(inState) < 100) return inState;
  return join(tmpdir(), `nunchi-${(() => { try { return userInfo().uid; } catch { return 'u'; } })()}`, `${sha(`${stateDir}|${pid}`, 16)}.sock`);
}

const json = v => Buffer.from(JSON.stringify(v));
class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

// Starts a board for `projectDir` (the folder holding `.nunchi`). → { port, url, newLink(), close(), server }.
// `mode`: 'board' or 'label' (design §9.2: label mode serves only the label endpoints and evidence).
export async function startBoard({ projectDir, mode = 'board', port = 0, labeller = null, idleMs = IDLE_MS, onExit = null, now = () => Date.now() } = {}) {
  const project = resolve(projectDir);
  const nunchiDir = join(project, '.nunchi');
  const warnings = new Set();
  const st = P.stateOf(nunchiDir, { warn: w => warnings.add(w) });
  const stateDir = st.root.dir;
  const genFile = st.files.generation;
  const runsDir = st.runsDir;
  if (mode === 'label' && !LABELLER.test(String(labeller))) throw new Error('label mode needs a labeller name (lower-case letters, digits and -)');
  const files = assets();
  const sessions = [];                       // tokens, newest last
  const codes = new Map();                   // launch code → expiry
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([k, [max, ms]]) => [k, limiter(max, ms)]));
  let lockedUntil = 0;
  let lastActive = now();
  let origin = null, hostHeader = null;
  const by = P.whoAmI();

  // ---- the model, cached by what changes it ----------------------------------------------------------------------
  // the state's generation plus the decision folders (decisions that arrived through git bump no generation)
  const decisionsSig = () => {
    const dir = join(nunchiDir, 'decisions');
    try { return sha(readdirSync(dir).sort().map(n => { try { const s = statSync(join(dir, n)); return `${n}:${s.mtimeMs}`; } catch { return n; } }).join('|'), 12); } catch { return '-'; }
  };
  const version = () => `${readGeneration(genFile)}.${decisionsSig()}`;
  let cache = null;
  const model = () => {
    const v = version();
    if (cache && cache.v === v) return cache.m;
    warnings.clear();
    const m = buildBoardModel({ nunchiDir, projectDir: project, warn: w => warnings.add(w) });
    m.lenses = lensTable(project);
    cache = { v: version(), m };
    return m;
  };

  // ---- responses ---------------------------------------------------------------------------------------------------
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    const buf = Buffer.isBuffer(body) ? body : json(body);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
    res.end(buf);
  };
  const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });

  // ---- tokens --------------------------------------------------------------------------------------------------------
  const newLink = () => {
    const t = now();
    for (const [c, exp] of codes) if (exp < t) codes.delete(c);
    const code = randomBytes(32).toString('hex');
    codes.set(code, t + CODE_TTL_MS);
    return `${origin}/#t=${code}`;
  };
  const tokenOk = req => {
    const given = req.headers['x-nunchi-token'];
    if (typeof given !== 'string' || !HEX64.test(given)) return false;
    let ok = false;
    for (const s of sessions) ok = sameSecret(given, s) || ok;
    return ok;
  };
  const spendCode = code => {
    if (typeof code !== 'string' || !HEX64.test(code)) return false;
    const t = now();
    let hit = null;
    for (const [c, exp] of codes) { if (sameSecret(code, c) && exp >= t) hit = c; }
    if (!hit) return false;
    codes.delete(hit);
    return true;
  };

  // ---- live updates (design §3.3): a fetch stream of version changes --------------------------------------------------
  const streams = new Set();
  let last = null;
  const check = () => {
    let v;
    try { v = version(); } catch { return; }
    if (v === last) return;
    last = v;
    for (const res of streams) { try { res.write(`event: generation\ndata: ${JSON.stringify({ version: v })}\n\n`); } catch {} }
  };
  let timer = null, watcher = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 200); };
  // watch the state folder only, not recursively, with a 200 ms debounce; ENOENT, ENOSPC (or any watch error) leaves
  // the 3 s poll of the generation file, which runs either way
  try { privateDir(stateDir); watcher = watch(stateDir, { persistent: false }, soon); watcher.on('error', () => { try { watcher.close(); } catch {} watcher = null; }); } catch { watcher = null; }
  const poll = setInterval(check, 3000);
  const ping = setInterval(() => { for (const res of streams) { try { res.write(': ping\n\n'); } catch {} } }, 15000);
  poll.unref?.(); ping.unref?.();

  // ---- request pipeline ------------------------------------------------------------------------------------------------
  const readBody = req => new Promise((res, rej) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) { rej(new HttpError(413, 'the request body is larger than 64 KB')); req.resume(); return; }
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { rej(new HttpError(413, 'the request body is larger than 64 KB')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
  const readJsonBody = async req => {
    const buf = await readBody(req);
    try { const v = JSON.parse(buf.toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; } catch { throw new HttpError(400, 'the body is not a JSON object'); }
  };

  const handle = async (req, res) => {
    // §3.2 request checks, in order; each answers before anything is read
    if (typeof req.url !== 'string' || !req.url.startsWith('/')) return fail(res, 400, 'bad request target');
    if (req.url.length > MAX_URL) return fail(res, 414, 'the address is too long');
    if (req.headers.host !== hostHeader) return fail(res, 421, `this board answers only at ${hostHeader}`);
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return fail(res, 403, 'requests from other sites are refused');
    if (req.method === 'OPTIONS') return fail(res, 405, 'no CORS here', { allow: 'GET, POST' });
    if (req.method !== 'GET' && req.method !== 'POST') return fail(res, 405, 'only GET and POST');
    const t = now();
    // after too many requests with a wrong key or link, requests without a valid key wait a minute (a valid key is
    // never locked out, so another process cannot shut the person out of their board)
    const keyed = tokenOk(req);
    if (!keyed && t < lockedUntil) return fail(res, 429, 'too many requests without a valid key; wait a minute');
    if (!limits.req.hit(t)) return fail(res, 429, 'too many requests');
    let u;
    try { u = new URL(`${origin}${req.url}`); } catch { return fail(res, 400, 'bad request target'); }
    if (u.origin !== origin) return fail(res, 400, 'bad request target');
    const path = u.pathname;
    if (req.method === 'GET' && Number(req.headers['content-length'] || 0) > 0) return fail(res, 413, 'a GET has no body');

    // the page shell: no data, no token
    if (req.method === 'GET' && files[path] && !u.search) return send(res, 200, files[path].body, files[path].type);

    if (req.method === 'POST') {
      if (path !== '/api/session' && !limits.write.hit(t)) return fail(res, 429, 'too many changes at once');
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') return fail(res, 415, 'writes are application/json');
      if (req.headers.origin !== origin) return fail(res, 403, 'writes come from the board itself only');
    }
    // the one route without a token: trading a launch code for one
    if (req.method === 'POST' && path === '/api/session') {
      if (!limits.session.hit(t)) return fail(res, 429, 'too many attempts');
      const body = await readJsonBody(req);
      if (!spendCode(body.code)) { if (!limits.fail.hit(t)) lockedUntil = t + 60e3; return fail(res, 401, 'this link was used already or has expired: run nunchi open for a fresh one'); }
      const token = randomBytes(32).toString('hex');
      sessions.push(token);
      while (sessions.length > MAX_SESSIONS) sessions.shift();
      lastActive = t;
      return send(res, 200, { token, mode, ...(mode === 'label' ? { labeller } : {}) });
    }
    if (!keyed) { if (!limits.fail.hit(t)) lockedUntil = t + 60e3; return fail(res, 401, 'no key: open the board with nunchi open'); }
    if (path !== '/api/live') lastActive = t;
    return route(req, res, u, path);
  };

  // ---- routes (all with the token) -------------------------------------------------------------------------------------
  const route = async (req, res, u, path) => {
    const get = req.method === 'GET', post = req.method === 'POST';
    if (get && path === '/api/live') return live(req, res);
    if (get && path === '/api/generation') return send(res, 200, { version: version() });
    if (get && path.startsWith('/evidence/')) return evidence(res, path);
    if (mode === 'label') {
      if (get && path === '/api/label/pool') return send(res, 200, labelPoolOut());
      const m = /^\/api\/label\/item\/([0-9a-f]{12})$/.exec(path);
      if (get && m) return labelItem(res, m[1]);
      if (post && path === '/api/label') return labelPost(res, await readJsonBody(req));
      return fail(res, 404, 'not in label mode');
    }
    if (get && path === '/api/summary') return send(res, 200, summaryOut());
    if (get && path === '/api/groups') {
      const q = u.searchParams;
      return send(res, 200, groupList(model(), { status: q.get('status') || 'open', lens: q.get('lens') || null, q: q.get('q'), group: q.get('group') || 'kind' }));
    }
    const gm = /^\/api\/groups\/([0-9a-f]{12})$/.exec(path);
    if (get && gm) { const d = groupDetail(model(), gm[1]); return d ? send(res, 200, d) : fail(res, 404, 'no such group'); }
    if (get && path === '/api/screens') return send(res, 200, screenWall(model()));
    if (post && path === '/api/decide') return decide(res, await readJsonBody(req));
    if (post && path === '/api/confirm') return confirm(res, await readJsonBody(req));
    if (post && path === '/api/approve-checks') return approveChecks(res, await readJsonBody(req));
    return fail(res, 404, 'not found');
  };

  function live(req, res) {
    if (streams.size >= MAX_STREAMS) return fail(res, 429, 'too many live connections');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\n\nevent: generation\ndata: ${JSON.stringify({ version: version() })}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
  }

  // /evidence/<run>/<scene>/<file>: one screenshot of a scene the run's manifest names, never through a link
  function evidence(res, path) {
    const parts = path.split('/');
    if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'evidence') return fail(res, 404, 'not found');
    let run, scene, file;
    try { [run, scene, file] = parts.slice(2).map(decodeURIComponent); } catch { return fail(res, 400, 'bad address'); }
    for (const s of [run, scene, file]) if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s)) return fail(res, 400, 'bad address');
    const type = Object.hasOwn(EVIDENCE_FILES, file) ? EVIDENCE_FILES[file] : null;
    if (!type) return fail(res, 404, 'not an evidence file the board serves');
    if (!RUN_ID.test(run) || !listRuns(runsDir).complete.includes(run)) return fail(res, 404, 'no such run');
    let runsReal, runDir;
    try {
      runsReal = realpathSync(runsDir);
      runDir = join(runsDir, run);
      const ls = lstatSync(runDir);
      if (ls.isSymbolicLink() || !ls.isDirectory()) return fail(res, 404, 'no such run');
      const r = relative(runsReal, realpathSync(runDir));
      if (!r || r.startsWith('..') || isAbsolute(r)) return fail(res, 404, 'no such run');
    } catch { return fail(res, 404, 'no such run'); }
    let manifest;
    try { manifest = readManifest(runDir); } catch { return fail(res, 404, 'no such run'); }
    const entry = (Array.isArray(manifest.scenes) ? manifest.scenes : []).find(s => s && s.id === scene && s.canary === undefined);
    const dir = entry ? sceneDir(runDir, scene) : null;
    if (!dir) return fail(res, 404, 'no such scene');
    let fd;
    try {
      const sd = lstatSync(dir);
      if (sd.isSymbolicLink() || !sd.isDirectory()) return fail(res, 404, 'no such scene');
      const target = join(dir, file);
      if (!NOFOLLOW && lstatSync(target).isSymbolicLink()) return fail(res, 404, 'not found');     // no O_NOFOLLOW (Windows)
      fd = openSync(target, constants.O_RDONLY | NOFOLLOW);
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > EVIDENCE_MAX) return fail(res, 404, 'not found');
      const buf = Buffer.alloc(s.size);
      let at = 0;
      while (at < s.size) { const n = readSync(fd, buf, at, s.size - at, at); if (!n) break; at += n; }
      if (buf[0] !== 0xff || buf[1] !== 0xd8) return fail(res, 415, 'not a JPEG');
      return send(res, 200, buf.subarray(0, at), type);
    } catch { return fail(res, 404, 'not found'); } finally { if (fd !== undefined) closeSync(fd); }
  }

  // design §3.4 words: "Screens are from before your latest edits · Re-check" when the working tree is not the one the
  // latest run captured (asked of git at most every 10 s; no git, no word)
  let treeMemo = { at: -Infinity, tree: null };
  const treeNow = () => { const t = Date.now(); if (t - treeMemo.at > 10e3) treeMemo = { at: t, tree: workTree(project).tree }; return treeMemo.tree; };
  function summaryOut() {
    const m = model();
    const s = m.summary;
    const runTree = m.latestEv?.meta?.tree ?? null;
    const now = runTree ? treeNow() : null;
    const profile = checkProfile(project);
    let approved = false;
    try { approved = !!profile && approvedProfiles(scriptsApprovedPath(stateDir)).has(profile.hash); } catch {}
    const requested = existsSync(checksRequestPath(stateDir));
    const running = listRuns(runsDir).partial.map(p => p.replace(/\.partial$/, '')).filter(x => RUN_ID.test(x));
    const nowLines = [...running.map(r => `Capture running · run ${r}`), ...[...m.claims.entries()].map(([g, c]) => `${c.agent} is fixing ${safe(m.byId.get(g)?.headline || g, 80)}${c.minutes !== null ? ` · ${c.minutes} min` : ''}`)];
    return {
      version: version(), mode, project: safe(basename(project), 80), run: s.run, kind: s.kind, commit: s.commit ? safe(String(s.commit).slice(0, 7), 7) : null, dirty: s.dirty,
      verdict: s.verdict, bySeverity: s.bySeverity, byStatus: s.byStatus, toDecide: s.toDecide, toFix: s.toFix, handoff: s.handoff, since: s.since, running: s.running,
      fullCheck: s.fullCheck, previousFullCheck: s.previousFullCheck,
      confirm: s.confirm.map(c => ({ key: c.key, id: safe(c.id, 60), decision: c.decision, reason: c.reason, channel: c.channel, by: c.by ? safe(c.by, 80) : null, at: c.at ? safe(c.at, 40) : null,
        note: c.note ? safe(c.note, 500) : null, group: c.group, title: safe(c.title, 160), severity: c.severity })),
      health: { problems: s.health.problems.map(p => ({ status: safe(p.status, 40), scenes: p.scenes, of: p.of })), blind: s.health.blind ? safe(s.health.blind, 40) : null,
        scenes: { ...s.health.scenes, reasons: s.health.scenes.reasons.map(r => safe(r, 80)) } },
      ai: s.ai, now: nowLines,
      checks: profile ? { requested, approved, profile: { hash: profile.hash, scripts: Object.fromEntries(Object.entries(profile.scripts).map(([k, v]) => [safe(k, 40), safe(v, 400)])), files: Object.fromEntries(Object.entries(profile.files).map(([k, v]) => [safe(k, 120), v ? safe(v, 64) : null])), packageManager: profile.packageManager ? safe(profile.packageManager, 80) : null } } : null,
      counts: { groups: m.groups.length, screens: m.latestEv?.scenes.length || 0 },
      treeChanged: !!(runTree && now && now !== runTree),
      warnings: [...warnings].map(w => safe(w, 400)),
    };
  }

  // ---- writes ------------------------------------------------------------------------------------------------------
  const DISMISS = { keep: 'Kept', 'false-positive': 'Not a problem' };
  function decide(res, body) {
    const { targets: ids, decision, reason = null, note = null, ms = null, confirmed = false } = body;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(x => typeof x === 'string' && HEX12.test(x)) || new Set(ids).size !== ids.length) return fail(res, 400, 'targets: a list of group ids');
    if (typeof decision !== 'string' || !Object.hasOwn(DECISIONS, decision)) return fail(res, 400, 'unknown decision');
    const reasons = DECISIONS[decision];
    if (reasons.length ? !reasons.includes(reason) : reason !== null) return fail(res, 400, reasons.length ? `"${decision}" needs a reason: ${reasons.join(' | ')}` : `"${decision}" takes no reason`);
    if (note !== null && (typeof note !== 'string' || note.length > 500)) return fail(res, 400, 'a note is up to 500 characters');
    if (ms !== null && !(Number.isFinite(ms) && ms >= 0 && ms <= CAP_MS)) return fail(res, 400, 'ms: 0 to 120000');
    // checked against the ledger as it is now (the same functions as nunchi decide)
    const led = P.loadLedger(nunchiDir, { root: project, warn: w => warnings.add(w) });
    const { rows, groups } = P.ledgerView(led);
    let targets;
    try { targets = P.resolveTargets(rows, groups, ids, { prefix: false }); } catch (e) { if (e.code !== 'BAD_TARGET') throw e; return fail(res, 409, 'the list changed: one of these groups is gone', { stale: true }); }
    const mine = targets.map(t => rows.filter(r => (t.group ? r.group === t.group : r.fp === t.fp)));
    if (!confirmed) {
      const flat = mine.flat().filter(r => !r.goneAt);
      if (DISMISS[decision]) {
        const blocker = mine.filter(rs => rs.some(r => protectOf(r) === 'blocker')).length, l9 = mine.filter(rs => rs.some(r => r.lens === 'L9')).length;
        const high = mine.filter(rs => rs.some(r => r.severity === 'high')).length;
        if (blocker || l9 || mine.length > 10) {
          const parts = [blocker && `${blocker} ${blocker === 1 ? 'is a blocker' : 'are blockers'}`, high && `${high} ${high === 1 ? 'is' : 'are'} high`, l9 && `${l9} ${l9 === 1 ? 'is a safety or secret finding' : 'are safety or secret findings'}`].filter(Boolean);
          return fail(res, 409, 'confirm', { confirm: { text: `Mark ${mine.length === 1 ? '1 group' : `${mine.length} groups`} ${DISMISS[decision]}?${parts.length ? ` ${parts.join(', ')}.` : ''}`, ok: `Mark ${DISMISS[decision]}` } });
        }
      }
      if (decision === 'fix' && flat.some(r => r.source === 'ai' && !r.checked)) return fail(res, 409, 'confirm', { confirm: { text: 'This hasn’t been double-checked. Fix anyway?', ok: 'Fix anyway' } });
      if (decision !== 'fix' && decision !== 'reopen') {
        const claims = model().claims;
        const fixing = targets.map(t => claims.get(t.group || rows.find(r => r.fp === t.fp)?.group)).find(Boolean);
        if (fixing) return fail(res, 409, 'confirm', { confirm: { text: `${fixing.agent} is fixing this right now. Stop and mark ${decidedText(decision, null)}?`, ok: 'Stop and mark' } });
      }
    }
    const batch = targets.length > 1 ? newId() : null;
    const made = P.recordDecisions(led, { targets, decision, reason, note, by, channel: 'board', batch });
    cache = null;
    if (ms !== null && decision !== 'reopen') {
      try { recordDecisionTime(metricsPath(stateDir), { id: batch || made[0].id, ms, size: made.length, later: decision === 'hold' }); } catch {}
    }
    return send(res, 200, { ok: true, batch, made: made.map(d => ({ id: d.id, target: d.target, decision: d.decision, reason: d.reason })), decided: decidedText(decision, reason) });
  }

  function confirm(res, body) {
    const keys = body.keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 1000 || !keys.every(k => typeof k === 'string' && k.length < 200)) return fail(res, 400, 'keys: the decisions to confirm');
    const m = model();
    const waiting = new Set(m.summary.confirm.map(c => c.key));
    if (!keys.every(k => waiting.has(k))) return fail(res, 409, 'some of these decisions no longer wait for you', { stale: true });
    const led = P.loadLedger(nunchiDir, { root: project, warn: w => warnings.add(w) });
    P.confirmDecisions(led, keys);
    cache = null;
    return send(res, 200, { ok: true, confirmed: keys.length });
  }

  function approveChecks(res, body) {
    if (typeof body.profile !== 'string' || !/^[0-9a-f]{32}$/.test(body.profile)) return fail(res, 400, 'profile: the hash shown');
    try { approveProfile(scriptsApprovedPath(stateDir), project, { seen: body.profile, channel: 'board', by, generation: genFile }); }
    catch (e) { if (e.code === 'STALE' || e.code === 'NO_PROFILE') return fail(res, 409, e.message, { stale: true }); throw e; }
    cache = null;
    return send(res, 200, { ok: true });
  }

  // ---- label mode (design §9.2) -------------------------------------------------------------------------------------
  const pool = () => { const m = model(); if (!m.pool) m.pool = labelPool(m, labeller); return { m, pool: m.pool }; };
  function labelPoolOut() {
    const { pool: items } = pool();
    const done = readLabels(nunchiDir, labeller);
    return { labeller, total: items.length, done: items.filter(i => done.has(i.id)).length, items: items.map(i => ({ id: i.id, label: done.get(i.id) || null })) };
  }
  function labelItem(res, id) {
    const { m, pool: items } = pool();
    const item = items.find(i => i.id === id);
    if (!item) return fail(res, 404, 'not in the pool');
    return send(res, 200, blindItem(m, item, { lenses: m.lenses, label: readLabels(nunchiDir, labeller).get(id) || null }));
  }
  function labelPost(res, body) {
    const { pool: items } = pool();
    const item = typeof body.id === 'string' ? items.find(i => i.id === body.id) : null;
    if (!item) return fail(res, 404, 'not in the pool');
    if (!['correct', 'wrong', 'unsure'].includes(body.label)) return fail(res, 400, 'label: correct, wrong or unsure');
    writeLabel(nunchiDir, stateDir, { labeller, item, label: body.label, generation: null });
    return send(res, 200, { ok: true });
  }

  // ---- the server ------------------------------------------------------------------------------------------------------
  // requireHostHeader off: a request without Host gets this board's own refusal (421, with the security headers)
  const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
    handle(req, res).catch(e => {
      if (e instanceof HttpError) return fail(res, e.status, e.message, e.extra);
      if (P.LEDGER_ERRORS.includes(e.code)) return fail(res, 503, safe(e.message, 600));
      return fail(res, 500, 'the board hit an error; see nunchi findings in your terminal');
    });
  });
  server.headersTimeout = 10e3;
  server.requestTimeout = 30e3;
  server.keepAliveTimeout = 5e3;
  server.maxHeadersCount = 60;
  await new Promise((res, rej) => { server.once('error', rej); server.listen({ host: '127.0.0.1', port, exclusive: true }, res); });
  const actual = server.address().port;
  origin = `http://127.0.0.1:${actual}`;
  hostHeader = `127.0.0.1:${actual}`;
  last = version();

  let closed = false;
  const idle = setInterval(() => { if (now() - lastActive > idleMs) close('idle'); }, Math.min(60e3, Math.max(1000, Math.floor(idleMs / 4))));
  idle.unref?.();
  async function close(why = 'stop') {
    if (closed) return;
    closed = true;
    clearInterval(poll); clearInterval(ping); clearInterval(idle); clearTimeout(timer);
    try { watcher?.close(); } catch {}
    for (const res of streams) { try { res.end(`event: bye\ndata: ${JSON.stringify({ why })}\n\n`); } catch {} }
    streams.clear();
    await new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
    if (onExit) await onExit(why);
  }
  return { port: actual, origin, url: `${origin}/`, newLink, close, server, stateDir, mode, project, touch: () => { lastActive = now(); } };
}

// ---- the detached process (`nunchi open` starts it, design §3.1) --------------------------------------------------------

// The board record a second `nunchi open` finds: the port, never the token. → its path.
export const boardsDir = stateDir => join(stateDir, 'boards');
export function writeRecord(stateDir, rec) {
  const file = join(boardsDir(stateDir), `${rec.pid}.json`);
  writeStable(file, { schema: 1, note: 'a running nunchi board: its port and control socket (never its token)', ...rec });
  return file;
}

function controlServer(path, board, { onStop }) {
  const srv = createNetServer(sock => {
    sock.setEncoding('utf8');
    sock.setTimeout(3000, () => sock.destroy());
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d;
      if (buf.length > 1024) return sock.destroy();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let cmd = null;
      try { cmd = JSON.parse(buf.slice(0, i)).cmd; } catch {}
      board.touch();
      if (cmd === 'ping') sock.end(JSON.stringify({ ok: true, pid: process.pid, port: board.port, mode: board.mode, project: board.project }) + '\n');
      else if (cmd === 'open') sock.end(JSON.stringify({ ok: openInBrowser(board.newLink()) }) + '\n');
      else if (cmd === 'stop') { sock.end(JSON.stringify({ ok: true }) + '\n'); setTimeout(onStop, 50); }
      else sock.end(JSON.stringify({ ok: false }) + '\n');
    });
  });
  return srv;
}

async function main(argv) {
  const opt = { mode: 'board', port: 0, open: false, linkToParent: false, project: process.cwd(), labeller: null, idleMs: IDLE_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') opt.project = argv[++i];
    else if (a === '--mode') opt.mode = argv[++i] === 'label' ? 'label' : 'board';
    else if (a === '--port') opt.port = Number(argv[++i]) || 0;
    else if (a === '--open') opt.open = true;
    else if (a === '--link-to-parent') opt.linkToParent = true;
    else if (a === '--labeller') opt.labeller = argv[++i];
    else if (a === '--idle-ms') opt.idleMs = Math.max(1000, Number(argv[++i]) || IDLE_MS);
  }
  process.stdout.on('error', () => {});
  let record = null, sockPath = null, ctl = null;
  const cleanup = () => { try { if (record) unlinkSync(record); } catch {} try { if (sockPath && process.platform !== 'win32') unlinkSync(sockPath); } catch {} };
  const board = await startBoard({ projectDir: opt.project, mode: opt.mode, port: opt.port, labeller: opt.labeller, idleMs: opt.idleMs,
    onExit: async () => { try { ctl?.close(); } catch {} cleanup(); setTimeout(() => process.exit(0), 50).unref(); } });
  sockPath = controlPath(board.stateDir, process.pid);
  if (process.platform !== 'win32') {
    // the socket's folder is this user's alone (a folder in the shared temp folder could be someone else's)
    privateDir(dirname(sockPath));
    const ds = lstatSync(dirname(sockPath));
    if (ds.isSymbolicLink() || !ds.isDirectory() || (typeof process.getuid === 'function' && ds.uid !== process.getuid()) || (ds.mode & 0o077)) throw new Error(`${dirname(sockPath)} is not a private folder of this user; remove it and run nunchi open again`);
    try { const s = lstatSync(sockPath); if (s.isSocket()) unlinkSync(sockPath); } catch {}
  }
  ctl = controlServer(sockPath, board, { onStop: () => board.close('stop') });
  await new Promise((res, rej) => { ctl.once('error', rej); ctl.listen(sockPath, res); });
  if (process.platform !== 'win32') { try { chmodSync(sockPath, 0o600); } catch {} }
  record = writeRecord(board.stateDir, { pid: process.pid, port: board.port, mode: board.mode, project: board.project, socket: sockPath, ...(opt.labeller ? { labeller: opt.labeller } : {}) });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => board.close('signal'));
  process.on('exit', cleanup);
  if (opt.open) openInBrowser(board.newLink());
  // the parent (`nunchi open`) reads one line: the port, and a link only when its own stdin and stdout are the
  // person's terminal and no browser was opened
  process.stdout.write(JSON.stringify({ port: board.port, ...(opt.linkToParent ? { link: board.newLink() } : {}) }) + '\n');
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  main(process.argv.slice(2)).catch(e => {
    try { process.stdout.write(JSON.stringify({ error: String(e?.message || e).split('\n')[0] }) + '\n'); } catch {}
    process.exit(2);
  });
}
