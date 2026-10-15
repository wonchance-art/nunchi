// Claims (design 0.1-c §7, M3 minimal): who is fixing which group, so two agents never fix one group, or one file,
// at once. A claim coordinates cooperating agents; it does not stop a malicious one (design §1).
// - `state/claims/<group>.json` {token, worktree, branch, url, files[], declaredAgent, declaredVendor, startedAt,
//   lastRenewal}, created with `wx` under the claims lock (`state/claims.lock.d`), plus one marker per root-cause file
//   (`state/claims/files/<sha256(path)>`, also `wx`), so two groups never claim one file.
// - Expiry is the reader's: lastRenewal + 30 minutes, never a value the writer set. An expired claim is taken over.
// - Worktree and branch come from git (the caller passes what `git rev-parse` said), never from arguments; agent and
//   vendor are what the agent declared, and are shown as "declared".
// - The capture renews the claim every 5 minutes; every fix command renews it too.
import { join, resolve } from 'node:path';
import { openSync, writeSync, fsyncSync, closeSync, readdirSync, rmSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { withLock, writeAtomic, privateDir, refuseLink, stableJson } from '../stable.mjs';
import { bumpGeneration } from '../state.mjs';
import { declaredName, sameName } from '../agents.mjs';

export const CLAIM_TTL_MS = 30 * 60e3;
export const RENEW_MS = 5 * 60e3;
const GROUP = /^[0-9a-f]{12}$/;
export const claimsDir = stateDir => join(stateDir, 'claims');
const claimFile = (stateDir, group) => join(claimsDir(stateDir), `${group}.json`);
const markersDir = stateDir => join(claimsDir(stateDir), 'files');
const markerOf = (stateDir, file) => join(markersDir(stateDir), createHash('sha256').update(String(file)).digest('hex'));
const lockOf = stateDir => join(stateDir, 'claims');
const read = p => { try { if (!lstatSync(p).isFile()) return null; return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// Live by the reader's clock (design §7).
export const claimLive = (c, now = Date.now()) => { const at = Date.parse(c?.lastRenewal); return Number.isFinite(at) && now - at <= CLAIM_TTL_MS; };
export const claimMinutes = (c, now = Date.now()) => { const s = Date.parse(c?.startedAt); return Number.isFinite(s) ? Math.max(0, Math.round((now - s) / 60e3)) : null; };
// A URL's origin, as said to the person.
export const originOf = url => { try { return new URL(url).origin; } catch { return null; } };
// The app server a URL reaches, as claims compare them (M6 review): its host and port, every name of this machine one
// host (localhost and *.localhost, 127.0.0.0/8, [::1], 0.0.0.0, [::] and IPv4-mapped loopback), so
// http://localhost:3001 and http://127.0.0.1:3001 are one server. A port is one server whatever the scheme. → a key or
// null when it is no URL.
const LOOPBACK = h => h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0' || h === '[::1]' || h === '[::]'
  || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d+\.\d+\.\d+)\]$/.test(h);
export function addressKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return `${LOOPBACK(host) ? 'loopback' : host}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
}
// Two worktree paths as one folder (M6): compared as real paths (a link, Windows' 8.3 names), and on Windows whatever
// the slashes or the case (the version control tool says `D:/a/b`, node `D:\a\b`). `platform`, `real`: for tests.
export function samePath(a, b, { platform = process.platform, real = realpathSync.native } = {}) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const norm = p => { let r; try { r = real(p); } catch { r = p; } return platform === 'win32' ? r.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : resolve(r); };
  return norm(a) === norm(b);
}

export function readClaim(stateDir, group) { return GROUP.test(group) ? read(claimFile(stateDir, group)) : null; }
// Every claim on record, with its group: { group, claim, live }.
export function listClaims(stateDir, now = Date.now()) {
  let names = [];
  try { names = readdirSync(claimsDir(stateDir)).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const m = /^([0-9a-f]{12})\.json$/.exec(n);
    if (!m) continue;
    const c = read(join(claimsDir(stateDir), n));
    if (c) out.push({ group: m[1], claim: c, live: claimLive(c, now) });
  }
  return out;
}

const kst = ms => new Date(ms + 9 * 3600e3).toISOString().replace('Z', '+09:00');
// A new file, written once (`wx`): EEXIST when it is there already.
function createOnce(path, text) {
  refuseLink(path);
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function dropClaim(stateDir, group, c) {
  for (const f of Array.isArray(c?.files) ? c.files : []) {
    const m = markerOf(stateDir, f), mk = read(m);
    if (mk && mk.group === group && mk.token === c.token) rmSync(m, { force: true });
  }
  rmSync(claimFile(stateDir, group), { force: true });
}

// Takes the claim of `group`, or says who holds what stands in the way. `mine`: the token of this attempt's claim
// (a resumed attempt keeps it). → { ok: true, token, claim } | { ok: false, why: 'group' | 'folder' | 'url' | 'file',
// claim, group, file? }.
// `fresh`: the token a new claim gets (the caller wrote it into its record first, so a command that dies right after
// taking the claim finds it its own when it resumes).
export function acquireClaim(stateDir, { group, worktree, branch, url, files = [], agent = null, vendor = null, mine = null, fresh = null, now = Date.now(), generation = null }) {
  if (!GROUP.test(group)) throw new Error('a claim names a 12-hex group');
  privateDir(markersDir(stateDir));
  const r = withLock(lockOf(stateDir), () => {
    const all = listClaims(stateDir, now);
    const own = all.find(x => x.group === group);
    if (own && own.live && own.claim.token !== mine) return { ok: false, why: 'group', claim: own.claim, group };
    // one fixer per folder: another live claim made from this worktree
    const here = all.find(x => x.group !== group && x.live && samePath(x.claim.worktree, worktree));
    if (here) return { ok: false, why: 'folder', claim: here.claim, group: here.group };
    // each worktree runs its own app server: a URL another live claim uses is refused
    const o = addressKey(url);
    const sameUrl = o && all.find(x => x.group !== group && x.live && !samePath(x.claim.worktree, worktree) && addressKey(x.claim.url) === o);
    if (sameUrl) return { ok: false, why: 'url', claim: sameUrl.claim, group: sameUrl.group };
    // expired claims are taken over (theirs and their markers removed)
    for (const x of all) if (!x.live) dropClaim(stateDir, x.group, x.claim);
    const token = own && own.claim.token === mine && mine ? mine : (typeof fresh === 'string' && /^[0-9a-f]{32}$/.test(fresh) ? fresh : randomBytes(16).toString('hex'));
    const sorted = [...new Set(files.map(String))].sort();
    const made = [];
    for (const f of sorted) {
      const m = markerOf(stateDir, f);
      const text = stableJson({ schema: 1, group, token, file: f });
      try { createOnce(m, text); made.push(m); continue; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const mk = read(m);
      const holder = mk && GROUP.test(String(mk.group)) ? read(claimFile(stateDir, mk.group)) : null;
      if (mk && mk.group !== group && holder && holder.token === mk.token && claimLive(holder, now)) {
        for (const p of made) rmSync(p, { force: true });
        return { ok: false, why: 'file', claim: holder, group: mk.group, file: f };
      }
      rmSync(m, { force: true });
      createOnce(m, text); made.push(m);
    }
    const startedAt = own && own.claim.token === mine && own.claim.startedAt ? own.claim.startedAt : kst(now);
    const claim = { schema: 1, note: 'who is fixing this group (design §7): expiry is lastRenewal + 30 minutes, computed by the reader', token, worktree, branch, url: url ?? null, files: sorted,
      declaredAgent: declaredName(agent, 'agent').name ?? null, declaredVendor: declaredName(vendor, 'vendor').name ?? null, startedAt, lastRenewal: kst(now) };
    const file = claimFile(stateDir, group);
    if (own) rmSync(file, { force: true });
    createOnce(file, stableJson(claim));
    return { ok: true, token, claim };
  });
  if (r.ok && generation) bumpGeneration(generation);
  return r;
}

// lastRenewal moves to now while the token is still the claim's. → false when the claim is gone or someone else's.
export function renewClaim(stateDir, group, token, now = Date.now()) {
  if (!GROUP.test(group) || !token) return false;
  return withLock(lockOf(stateDir), () => {
    const c = read(claimFile(stateDir, group));
    if (!c || c.token !== token) return false;
    writeAtomic(claimFile(stateDir, group), stableJson({ ...c, lastRenewal: kst(now) }), { mode: 0o600 });
    return true;
  });
}

// The address the claim's attempt checks the app at moves to `url` (fix --start or --verify given another --url),
// unless another live claim uses it: each worktree runs its own app server (design §7). The claim is renewed.
// → { ok: true, claim } | { ok: false, why: 'url', claim, group } | { ok: false, why: 'gone' } (not this token's).
export function moveClaimUrl(stateDir, group, token, url, { now = Date.now() } = {}) {
  if (!GROUP.test(group) || !token) return { ok: false, why: 'gone' };
  return withLock(lockOf(stateDir), () => {
    const c = read(claimFile(stateDir, group));
    if (!c || c.token !== token) return { ok: false, why: 'gone' };
    const o = addressKey(url);
    const other = o && listClaims(stateDir, now).find(x => x.group !== group && x.live && addressKey(x.claim.url) === o);
    if (other) return { ok: false, why: 'url', claim: other.claim, group: other.group };
    const claim = { ...c, url: url ?? null, lastRenewal: kst(now) };
    writeAtomic(claimFile(stateDir, group), stableJson(claim), { mode: 0o600 });
    return { ok: true, claim };
  });
}

// Removes the claim (and its file markers) while the token is still the claim's.
export function releaseClaim(stateDir, group, token, { generation = null } = {}) {
  if (!GROUP.test(group) || !token) return false;
  const done = withLock(lockOf(stateDir), () => {
    const c = read(claimFile(stateDir, group));
    if (!c || c.token !== token) return false;
    dropClaim(stateDir, group, c);
    return true;
  });
  if (done && generation) bumpGeneration(generation);
  return done;
}

// Renews every RENEW_MS while `fn` runs (a capture can take longer than the claim lives). → fn's result.
export async function whileRenewing(stateDir, group, token, fn, { every = RENEW_MS, now = Date.now } = {}) {
  const t = setInterval(() => { try { renewClaim(stateDir, group, token, now()); } catch {} }, every);
  try { return await fn(); } finally { clearInterval(t); try { renewClaim(stateDir, group, token, now()); } catch {} }
}

// The refusal copy (design §7). `why: 'group' | 'folder'` with another declared agent: the parallel-worktree advice;
// the same declared agent in this folder (the single-agent path) is never told about worktrees.
// `hint`: what to do about the claim holding the way, from its attempt's record (the loop knows it): resume it at the
// step it stopped at, or, when no open attempt owns the claim (a command was stopped), wait for it or release it.
export function refusalText(r, { me = null, folder = 'myapp', worktree = null, now = Date.now(), hint = null } = {}) {
  const c = r.claim || {};
  // a claim is a file anything can write: its agent is a declared name, or none
  const theirs = declaredName(c.declaredAgent, 'agent').name ?? null, mine = declaredName(me, 'agent').name ?? null;
  const who = theirs || 'Your AI';
  const min = claimMinutes(c, now);
  const branch = c.branch || 'its branch';
  if (r.why === 'group' && worktree && c.worktree && !samePath(c.worktree, worktree)) return `${who} is already fixing this finding in another folder (branch ${branch}${min !== null ? `, ${min} min` : ''}). Wait for it, or decide something else in the board: deciding and capturing still work here.`;
  if (r.why === 'url') return `Another fix (branch ${branch}) is checking the app at ${originOf(c.url) || c.url}. Start the app from this folder on a free port (e.g. \`PORT=3001 npm run dev\`), then verify with \`--url http://127.0.0.1:3001\`.`;
  if (r.why === 'file') return `${who} is fixing another finding in ${r.file} right now (branch ${branch}${min !== null ? `, ${min} min` : ''}). Fix this one when that fix is done.`;
  // worktrees are advice for two different agents, and only when both said who they are: an agent that did not say
  // (no --agent) is taken for the same one (the single-agent path never hears about worktrees); names are compared
  // as declared names are, case aside (M6 review: "codex" and "Codex" are one agent)
  const same = !mine || !theirs || sameName(mine, theirs);
  const next = hint || `resume with \`nunchi fix --verify ${r.group}\`, or stop it with \`nunchi fix --abort ${r.group}\``;
  if (same) return r.why === 'folder'
    ? `A fix of another finding (group ${r.group}) is still open in this folder (branch ${branch}${min !== null ? `, ${min} min` : ''}): ${next}.`
    : `This finding is already being fixed (branch ${branch}${min !== null ? `, ${min} min` : ''}): ${next}.`;
  return `${who} is already fixing in this folder (branch ${branch}${min !== null ? `, ${min} min` : ''}). To fix in parallel: \`git worktree add ../${folder}-2 -b nunchi/fixes-2\`, open that folder in ${mine || 'your AI'}, start the app there on another port. Or wait: deciding and capturing still work here.`;
}
