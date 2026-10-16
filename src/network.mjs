// Network layer of the evidence pipeline (spec §2.2, §2.3): which hosts the app may reach,
// which requests are "data", how they are recorded and replayed, and how forced states
// (empty, error) rewrite them. Pure functions plus one small Recording class; no I/O at import.
import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeStable, sha, stableJson, withLock, privateDir } from './stable.mjs';

// Base-URL guard (D10). Capture visits every screen and, recording, lets the app's data requests through, so
// it runs only against a server the user runs: loopback, a private address, `*.local`, or a host the user
// listed in `.nunchi/config.json` (`allowHosts`). Judged on the URL as written, never by a DNS answer.
const bare = host => String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
const v4 = h => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  const n = m && m.slice(1).map(Number);
  return n && n.every(x => x <= 255) ? n : null;
};
// Link-local addresses (169.254/16, fe80::/10) are not on the list: cloud metadata services answer there
// (169.254.169.254), as does AWS's on fd00:ec2::254. A user can still list one.
const localV4 = ([a, b, c, d]) => a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a + b + c + d === 0;
export function isLocalHost(host) {
  const h = bare(host);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const a = v4(h);
  if (a) return localV4(a);
  if (!h.includes(':')) return false;
  // IPv6 as the URL parser writes it: compressed, lower case, an IPv4-mapped address as two hex groups
  if (h === '::1' || h === '::') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) { const [x, y] = mapped.slice(1).map(g => parseInt(g, 16)); return localV4([x >> 8, x & 255, y >> 8, y & 255]); }
  return /^f[cd][0-9a-f]{2}:/.test(h) && h !== 'fd00:ec2::254';      // unique local fc00::/7, not the metadata address
}
const listed = entry => { try { return bare(new URL(String(entry).includes('://') ? entry : `http://${entry}`).hostname); } catch { return null; } };
const parse = url => { try { return new URL(url); } catch { return null; } };
// null when the URL may be captured, else why not.
// A saved login (Playwright storageState, from `nunchi login`) works only at the host it was saved at: cookies are kept
// per host, and `localhost` and `127.0.0.1` are two hosts. → the hosts it holds cookies or storage for, when none of
// them is the host of `baseUrl` (or a parent domain of it, for a cookie); null when one is, or when it names no host.
// Host names only, never a cookie or a value (the state holds live sessions).
export function loginElsewhere(state, baseUrl) {
  let host;
  try { host = bare(new URL(baseUrl).hostname); } catch { return null; }
  const cookies = Array.isArray(state?.cookies) ? state.cookies.map(c => bare(String(c?.domain ?? '')).replace(/^\./, '')).filter(Boolean) : [];
  const origins = Array.isArray(state?.origins) ? state.origins.map(o => { try { return bare(new URL(String(o?.origin)).hostname); } catch { return ''; } }).filter(Boolean) : [];
  const hosts = [...new Set([...cookies, ...origins])].sort();
  if (!hosts.length) return null;
  if (cookies.some(d => host === d || host.endsWith('.' + d)) || origins.includes(host)) return null;
  return hosts;
}

export function baseUrlProblem(url, allowHosts = []) {
  const u = parse(url);
  if (!u) return 'not a URL (expected something like http://localhost:3000)';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https servers are captured';
  if (isLocalHost(u.hostname) || allowHosts.some(h => listed(h) === bare(u.hostname))) return null;
  return 'not a local or private address';
}
// The message the CLI prints and capture() throws.
export function baseUrlRefusal(url, allowHosts = []) {
  const problem = baseUrlProblem(url, allowHosts);
  if (!problem) return null;
  const u = parse(url);
  const hint = u && /^https?:$/.test(u.protocol)
    ? ` If it is a preview or staging server with test data, add its host to .nunchi/config.json yourself: {"allowHosts": ["${bare(u.hostname)}"]}` : '';
  return `refusing ${u && u.origin !== 'null' ? u.origin : url}: ${problem}. nunchi captures only a server you run (localhost, a private address or *.local), never production.${hint}`;
}

// Backends that vibe-coded apps call straight from the browser. Their data requests are part of
// the app, not third-party noise: allowed, recorded and replayed. Analytics and ads stay blocked.
export const BACKEND_SUFFIXES = [
  '.supabase.co', '.supabase.in',
  '.firebaseio.com', '.firebasedatabase.app', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com', 'firebasestorage.googleapis.com',
  '.convex.cloud', '.appwrite.io', '.clerk.accounts.dev',
];
export const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

export function isBackendHost(host, extra = []) {
  return extra.includes(host) || BACKEND_SUFFIXES.some(s => (s.startsWith('.') ? host.endsWith(s) : host === s));
}

// Data = what the app fetches at runtime. Documents, scripts, styles and React Server Component
// payloads are code, not data: replaying them would hide the very fix nunchi re-captures to confirm.
export function isDataRequest({ resourceType, headers }) {
  if (resourceType !== 'fetch' && resourceType !== 'xhr') return false;
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (h.rsc === '1' || 'next-router-state-tree' in h || /text\/x-component/.test(h.accept || '')) return false;
  return true;
}

const VOLATILE_PARAMS = new Set(['_', '_t', 't', 'ts', 'timestamp', 'cb', 'cachebust', 'cache_bust', 'nonce', '_rsc', 'rand', 'random']);
// Query and fragment parameters that carry credentials (magic links, signed URLs, OAuth codes,
// Supabase's #access_token and ?token_hash=, Firebase's ?oobCode=, any `*_token`, `?apikey=`). Their values never reach
// evidence, recordings or keys.
export const SECRET_PARAM = /^(access_token|refresh_token|id_token|provider_token|[\w.-]*_token|token|token_hash|oobcode|auth|authorization|apikey|api_key|key|secret|client_secret|password|pass|pwd|session|session_id|sessionid|sid|jwt|code|otp|signature|sig|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential)$/i;
const redactParams = (params, keep) => { for (const [k, v] of [...params]) if (SECRET_PARAM.test(k)) params.set(k, keep ? `REDACTED-${sha(v, 8)}` : 'REDACTED'); };
const redactPart = (part, keep) => {
  if (!part.includes('=')) return part;
  const p = new URLSearchParams(part);
  if (![...p.keys()].some(k => SECRET_PARAM.test(k))) return part;
  redactParams(p, keep);
  return p.toString();
};

// A URL or path as it may be written into evidence: credential values replaced, in the query and in
// a `#a=1&b=2` fragment, and `scheme://user:password@host` → `scheme://host` (credentials in the authority).
// Nothing else before the query is changed.
// (the scheme starts where a scheme can: never retried inside a long word, which made a 40,000-letter string take 2 s)
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s"'<>]*@/gi;
export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(url);
  const [, rawHead, query = '', hash = ''] = m;
  const head = rawHead.replace(USERINFO, '$1');
  const q = query ? '?' + redactPart(query.slice(1), false) : '';
  const h = hash ? '#' + redactPart(hash.slice(1), false) : '';
  return head + q + h;
}

// Free text (console messages, navigation errors) can quote URLs: credential values in it go too.
export function redactText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(USERINFO, '$1').replace(/([?&#])([\w.-]+)=([^&#\s"'<>]+)/g, (all, sep, k) => (SECRET_PARAM.test(k) ? `${sep}${k}=REDACTED` : all));
}

// Same request across runs → same key: params sorted, cache-busters dropped, epoch-like numbers masked,
// credentials replaced by a short hash (requests that differ only by token stay distinct).
export function normalizeUrl(url) {
  const u = new URL(url);
  redactParams(u.searchParams, true);
  const params = [...u.searchParams].filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()))
    .map(([k, v]) => [k, /^\d{10}(\d{3})?$/.test(v) ? '<epoch>' : v])
    .sort((a, b) => (a[0] + '=' + a[1] < b[0] + '=' + b[1] ? -1 : 1));
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`;
}

// The app's own origin is written as `app:` so a recording survives a new port or host
// (localhost:3000 → 127.0.0.1:3001, or a fresh preview URL).
export function requestKey(method, url, body, appOrigin) {
  let n = normalizeUrl(url);
  if (appOrigin && n.startsWith(appOrigin + '/')) n = 'app:' + n.slice(appOrigin.length);
  return `${method} ${n}${body ? ' #' + sha(body, 12) : ''}`;
}

// Tokens never land in a recording. Replay does not match on auth headers, so redacted
// values still replay fine. String values only: `token`, `jwt`, `authorization`, `session` and any `*_token` (since the
// review of PR #33; `access_token`, `refresh_token`, `id_token`… included), keys, secrets and passwords.
const SECRET_FIELDS = /^(token|jwt|authorization|session|[a-z0-9_]*_token|api_key|apikey|secret|client_secret|password)$/i;
export function redactJson(value) {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.test(k) && typeof v === 'string' ? '[redacted]' : redactJson(v);
    return out;
  }
  return value;
}

const COUNT_FIELDS = /^(count|total|totalcount|total_count|totalitems|total_items|length|size)$/i;
// Empty state: lists become empty, their counts zero. Two levels deep covers {data: [...]} envelopes.
export function emptyJson(value, depth = 0) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object' && depth < 2) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) out[k] = [];
      else if (typeof v === 'number' && COUNT_FIELDS.test(k)) out[k] = 0;
      else if (v && typeof v === 'object') out[k] = emptyJson(v, depth + 1);
      else out[k] = v;
    }
    return out;
  }
  return value;
}

const isJson = type => /\bjson\b/i.test(type || '');

// Rewrite one data response for a forced state. Returns null when the state does not touch it.
export function forceResponse(state, res) {
  if (state === 'error') return { status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Internal Server Error' }) };
  if (state === 'empty') {
    if (!isJson(res.contentType)) return null;
    try { return { ...res, body: JSON.stringify(emptyJson(JSON.parse(res.body))) }; } catch { return null; }
  }
  return null;
}

// Recorded responses per request key, in the order a single page load asked for them.
// Replay starts every page load at the first response, so the subset of scenes captured
// never changes what a scene sees.
// `routes` (since M5, design 0.1-c §6): which screens the recording holds, route → the viewports whose normal screen
// was captured while recording (`{"/tasks": ["d", "m"]}`). A capture that meets a route the recording lacks records it
// with merge (capture.mjs) instead of replaying a recording that cannot answer it. `null`: a recording written before
// coverage was kept, which covers every route (replayed as before).
const isMap = x => !!x && typeof x === 'object' && !Array.isArray(x);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => stableJson(x) === stableJson(b[i]));
export class Recording {
  constructor(entries = {}, routes = {}) { this.entries = entries; this.routes = routes; this.before = new Map(); }
  // A recording that does not parse is an error with a way out, never a crash or an empty recording.
  static load(path) {
    if (!existsSync(path)) return null;
    let data = null, why = 'not a nunchi recording';
    try { data = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { why = String(e.message).split('\n')[0]; }
    const routesOk = r => r === undefined || (isMap(r) && Object.values(r).every(v => Array.isArray(v) && v.every(x => typeof x === 'string')));
    if (!isMap(data) || (data.entries !== undefined && !isMap(data.entries)) || !routesOk(data.routes)) {
      throw Object.assign(new Error(`the recording ${path} is damaged (${why}): delete it, or capture again with --network record`), { code: 'BAD_RECORDING' });
    }
    return new Recording(data.entries || {}, data.routes === undefined ? null : data.routes);
  }
  // Does it hold the normal screen of `route` at viewport `vp`?
  covers(route, vp) { return this.routes === null || (Array.isArray(this.routes[route]) && this.routes[route].includes(vp)); }
  // The screen was captured while recording (or merging) its data. A recording that covers every route stays so.
  recorded(route, vp) {
    if (this.routes === null) return;
    this.routes[route] = [...new Set([...(this.routes[route] || []), vp])].sort();
  }
  doc() { return { schema: 1, note: 'nunchi recording: data responses only, tokens redacted', entries: this.entries, ...(this.routes === null ? {} : { routes: this.routes }) }; }
  // Two recordings of one person as one (`base`: the one on disk; `mine`: this capture's). A request the base holds
  // keeps its responses — what a screen already recorded was answered stays what it is answered, so strict replay holds
  // for it — unless mine holds the same responses and more after them (a recording run that saw more of one page
  // load); a request only mine holds is added. `replace` (`--network record`, review of PR #33): what mine recorded
  // replaces the base's answers for those requests, so recording again is the way out of a stale or bad answer.
  // Screens held: both (one that covers every route makes the result cover every route). The same two recordings
  // always give the same bytes: keys are written sorted (stableJson).
  static merge(base, mine, { replace = false } = {}) {
    const entries = { ...base.entries };
    for (const [k, list] of Object.entries(mine.entries)) {
      const was = entries[k];
      if (!list.length) continue;
      if (replace || !Array.isArray(was) || !was.length) entries[k] = list;
      else if (list.length > was.length && sameList(was, list.slice(0, was.length))) entries[k] = list;
    }
    const routes = base.routes === null || mine.routes === null ? null : {};
    if (routes) for (const r of [base.routes, mine.routes]) for (const [route, vps] of Object.entries(r || {})) routes[route] = [...new Set([...(routes[route] || []), ...vps])].sort();
    return new Recording(entries, routes);
  }
  // Takes back what this capture added for these requests (the screens that added them failed, review of PR #33): a
  // request it added is removed, one it extended is cut back to what it held before.
  forget(keys) {
    for (const k of keys) {
      if (!this.before.has(k)) continue;
      const n = this.before.get(k);
      if (n === 0) delete this.entries[k]; else this.entries[k].length = n;
      this.before.delete(k);
    }
  }
  // Saved under the person's lock and merged with what is on disk then (another capture may have saved since this
  // one loaded it), written in one step and owner-only (it holds the app's API responses): a capture reading it, or
  // one that crashes while saving, never sees half a recording, and two captures saving at once lose nothing.
  // A file that no longer parses is replaced, as before. A lock that stays busy (another capture saving for longer than
  // `timeoutMs`, twice) never loses the run: what this capture recorded is written beside it,
  // `<person>.json.unsaved-<pid>`, and said (→ { saved: false, side }); else → { saved: true }.
  save(path, { replace = false, timeoutMs = 5000 } = {}) {
    privateDir(dirname(path));                       // the lock is made in the folder: it is owner-only first (D12)
    const write = () => {
      let disk = null;
      try { disk = Recording.load(path); } catch (e) { if (e.code !== 'BAD_RECORDING') throw e; }
      writeStable(path, (disk ? Recording.merge(disk, this, { replace }) : this).doc());
    };
    for (const wait of [timeoutMs, timeoutMs * 4]) {
      try { withLock(path, write, { timeoutMs: wait }); return { saved: true }; }
      catch (e) { if (e.code !== 'LOCKED') throw e; }
    }
    const side = `${path}.unsaved-${process.pid}`;
    writeStable(side, this.doc());
    return { saved: false, side };
  }
  // One page load's view of the recording. `added`: the requests it added responses for; `used`: those it was
  // answered from the recording.
  loader() {
    const counters = new Map();
    const next = key => { const i = counters.get(key) || 0; counters.set(key, i + 1); return i; };
    const added = new Set(), used = new Set();  // (this.before: request → how many responses it held before this capture added any)
    const addAt = (key, i, res) => {
      const list = this.entries[key] || [];
      if (list.length === i) {
        const body = isJson(res.contentType) ? (() => { try { return JSON.stringify(redactJson(JSON.parse(res.body))); } catch { return res.body; } })() : res.body;
        if (!this.before.has(key)) this.before.set(key, list.length);
        list.push({ status: res.status, contentType: res.contentType, body });
        this.entries[key] = list;
        added.add(key);
      }
    };
    const fresh = new Set();                    // requests this page load found missing from the recording (merge)
    return {
      added, used,
      add: (key, res) => addAt(key, next(key), res),
      take: key => {
        const list = this.entries[key];
        if (!list || !list.length) return null;
        used.add(key);
        return list[Math.min(next(key), list.length - 1)];
      },
      // Merge (a screen the recording lacks): a request the recording holds is answered from it, as replay answers it,
      // so this screen sees now what every later replay of it will see; one it lacks goes live, and its responses are
      // added in the order this page load asked for them, as recording adds them. → { res } or { add(res) }.
      ask: key => {
        const i = next(key);
        const list = this.entries[key];
        if (!fresh.has(key) && list && list.length) { used.add(key); return { res: list[Math.min(i, list.length - 1)] }; }
        fresh.add(key);
        return { res: null, add: res => addAt(key, i, res) };
      },
    };
  }
}
