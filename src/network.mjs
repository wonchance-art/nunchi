// Network layer of the evidence pipeline (spec §2.2, §2.3): which hosts the app may reach,
// which requests are "data", how they are recorded and replayed, and how forced states
// (empty, error) rewrite them. Pure functions plus one small Recording class; no I/O at import.
import { readFileSync, existsSync } from 'node:fs';
import { writeStable, sha } from './stable.mjs';

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
// Supabase's #access_token, `?apikey=`). Their values never reach evidence, recordings or keys.
export const SECRET_PARAM = /^(access_token|refresh_token|id_token|provider_token|token|auth|authorization|apikey|api_key|key|secret|client_secret|password|pass|pwd|session|session_id|sessionid|sid|jwt|code|otp|signature|sig|x-amz-signature|x-amz-security-token|x-amz-credential|x-goog-signature|x-goog-credential)$/i;
const redactParams = (params, keep) => { for (const [k, v] of [...params]) if (SECRET_PARAM.test(k)) params.set(k, keep ? `REDACTED-${sha(v, 8)}` : 'REDACTED'); };
const redactPart = (part, keep) => {
  if (!part.includes('=')) return part;
  const p = new URLSearchParams(part);
  if (![...p.keys()].some(k => SECRET_PARAM.test(k))) return part;
  redactParams(p, keep);
  return p.toString();
};

// A URL or path as it may be written into evidence: credential values replaced, in the query and in
// a `#a=1&b=2` fragment. Only the query and fragment are touched; everything before them is kept as is.
// `scheme://user:password@host` → `scheme://host`: credentials in the authority are dropped too.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s"'<>]*@/gi;
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
// values still replay fine.
const SECRET_FIELDS = /^(access_token|refresh_token|provider_token|provider_refresh_token|id_token|session_token|api_key|apikey|secret|client_secret|password)$/i;
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
export class Recording {
  constructor(entries = {}) { this.entries = entries; }
  static load(path) {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return new Recording(data.entries || {});
  }
  save(path) { writeStable(path, { schema: 1, note: 'nunchi recording: data responses only, tokens redacted', entries: this.entries }); }
  loader() {
    const counters = new Map();
    const next = key => { const i = counters.get(key) || 0; counters.set(key, i + 1); return i; };
    return {
      add: (key, res) => {
        const i = next(key);
        const list = (this.entries[key] ||= []);
        if (list.length === i) {
          const body = isJson(res.contentType) ? (() => { try { return JSON.stringify(redactJson(JSON.parse(res.body))); } catch { return res.body; } })() : res.body;
          list.push({ status: res.status, contentType: res.contentType, body });
        }
      },
      take: key => {
        const list = this.entries[key];
        if (!list || !list.length) return null;
        return list[Math.min(next(key), list.length - 1)];
      },
    };
  }
}
