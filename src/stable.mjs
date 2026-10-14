// Stable serialization: sorted keys, fixed indentation, trailing newline.
// Every file the engine writes goes through here so equal data gives equal bytes.
import { writeFileSync, mkdirSync, openSync, fsyncSync, fchmodSync, closeSync, renameSync, unlinkSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, lstatSync, utimesSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

export const stableJson = value => JSON.stringify(sortKeys(value), null, 2) + '\n';

// Written to a temp file and renamed into place, so a reader or a crash sees the old bytes or the new ones,
// never half a file.
export function writeStable(path, value) {
  writeAtomic(path, typeof value === 'string' || value instanceof Uint8Array ? value : stableJson(value));
}

export const sha = (data, n = 16) => createHash('sha256').update(data).digest('hex').slice(0, n);

const POSIX = process.platform !== 'win32';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The syncs are what make a write survive a power loss, and no output shows them: a test can watch them here.
export const io = { fsync: fd => fsyncSync(fd) };

// Write-temp-then-rename in the same folder (a rename within one folder is atomic). The temp file is
// `.<name>.tmp-<pid>-<random>`, created exclusively ('wx'); it never appears in the output.
// - mode: `mode` when given; else the mode of the file it replaces (an owner-only file stays owner-only); else
//   the default under the umask.
// - durable: fsync the file before the rename and the folder after it (POSIX), for committed and shared files
//   (decisions, approvals, the ledger). Run evidence skips it: a run folder is renamed into place only once
//   it is complete.
export function writeAtomic(path, data, { durable = false, mode } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  let keep = mode;
  if (keep === undefined) try { keep = statSync(path).mode & 0o7777; } catch {}
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx', keep ?? 0o666);
    try {
      if (keep !== undefined && POSIX) fchmodSync(fd, keep);
      writeFileSync(fd, data);
      if (durable) io.fsync(fd);
    } finally { closeSync(fd); }
    renameRetry(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  if (durable && POSIX) syncFolder(dir);
}

// Some file systems cannot sync a folder; that is not an error. Anything else is.
const NO_FOLDER_SYNC = new Set(['EISDIR', 'EINVAL', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF']);
function syncFolder(dir) {
  let fd;
  try { fd = openSync(dir, 'r'); } catch (e) { if (NO_FOLDER_SYNC.has(e.code)) return; throw e; }
  try { io.fsync(fd); } catch (e) { if (!NO_FOLDER_SYNC.has(e.code)) throw e; } finally { closeSync(fd); }
}

// Windows refuses a rename over a file another process has open for a moment (virus scanners, indexers).
const BUSY = new Set(['EACCES', 'EPERM', 'EBUSY']);
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
function renameRetry(from, to) {
  for (let wait = 10, waited = 0; ; wait *= 2) {
    try { return renameSync(from, to); }
    catch (e) {
      if (POSIX || !BUSY.has(e.code) || waited >= 5000 || isDir(to)) throw e;
      sleep(wait); waited += wait;
    }
  }
}

// What a crash in the middle of a write leaves: temp files of writeAtomic (and of older versions) and lock
// folders being made or removed. Removed from `dir` once they are an hour old (design §8.1).
const LEFTOVER = /^\..+\.tmp-\d+-[0-9a-f]{8}$|^.+\.\d+\.tmp$|\.lock\.d\.(tmp|gone)-[0-9a-f]+$/;
export function sweepLeftovers(dir, { olderThanMs = 3600e3, now = Date.now() } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const removed = [];
  for (const n of names.sort()) {
    if (!LEFTOVER.test(n)) continue;
    const p = join(dir, n);
    try {
      if (now - lstatSync(p).mtimeMs < olderThanMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(n);
    } catch {}
  }
  return removed;
}

// ---- lock (spec §5; design 0.1-c §8.1) -------------------------------------------------------------------
// `<file>.lock.d` is the lock, a folder holding owner.json.
// - taken by renaming a folder that already holds owner.json into place: the rename fails while the lock exists,
//   so there is never a lock without its owner.
// - stale: a holder on this machine (same host, boot and pid namespace) is judged by its process alone (gone, or
//   its pid now names another process), never by age, so a clock jump or a sleeping laptop does not take a live
//   lock away. A holder elsewhere is stale once it has not touched the lock for `staleMs`.
// - a stale lock is removed by one taker at a time, under `<file>.lock.d.reap`, and only after reading again,
//   under it, that the lock still holds the owner judged stale and is still stale. A lock is never given back.
// - released only while it still holds our token.
// Held only around read–change–write of a small file, never across capture or network I/O. Acquisition backs
// off for `timeoutMs`, then fails with code LOCKED, also when a stale lock cannot be removed.
const procFile = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const bootId = () => procFile('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
const pidNs = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
// Linux: start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat, after the name).
const procStart = pid => { const s = procFile(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null : null; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readOwner = dir => { try { return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch { return null; } };
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 };
// A rename onto a lock that exists: ENOTEMPTY or EEXIST; Windows says EPERM, EACCES or EBUSY.
const taken = e => e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || (!POSIX && BUSY.has(e.code));

function staleOwner(dir, staleMs) {
  const owner = readOwner(dir);
  let touched;
  try { touched = statSync(owner ? join(dir, 'owner.json') : dir).mtimeMs; } catch { return null; }   // just released: try again
  if (owner && owner.host === hostname() && owner.boot === bootId() && owner.ns === pidNs()) {
    if (!alive(owner.pid)) return { owner };
    const start = procStart(owner.pid);
    return owner.start && start && owner.start !== start ? { owner } : null;
  }
  return Date.now() - touched > staleMs ? { owner } : null;
}

// → true when the stale lock judged was removed (the caller tries to take the lock again at once).
function reap(dir, judged, staleMs) {
  const guard = `${dir}.reap`;
  try { mkdirSync(guard); } catch (e) {
    if (e.code !== 'EEXIST' && !(!POSIX && BUSY.has(e.code))) throw e;
    // a taker that died while removing a lock leaves its guard; it is cleared once it is old
    try { if (Date.now() - statSync(guard).mtimeMs > staleMs) rmSync(guard, RM); } catch {}
    return false;
  }
  try {
    const now = staleOwner(dir, staleMs);
    if (!now || (now.owner?.token ?? null) !== (judged.owner?.token ?? null)) return false;
    const gone = `${dir}.gone-${randomBytes(4).toString('hex')}`;
    try { renameSync(dir, gone); } catch { return false; }
    rmSync(gone, RM);
    return true;
  } finally { rmSync(guard, RM); }
}

function release(dir, token) {
  if (readOwner(dir)?.token !== token) return;                   // not ours (any more): leave it
  const gone = `${dir}.gone-${token}`;
  try { renameSync(dir, gone); } catch { return; }
  rmSync(gone, RM);
}

export function withLock(path, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const dir = `${path}.lock.d`;
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString('hex');
  const ready = `${dir}.tmp-${token}`;
  mkdirSync(ready);
  writeFileSync(join(ready, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), boot: bootId(), ns: pidNs(), start: procStart(process.pid), at: Date.now() }));
  const t0 = Date.now();
  try {
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try { renameSync(ready, dir); break; } catch (e) { if (!taken(e)) throw e; }
      const stale = staleOwner(dir, staleMs);
      if (stale && reap(dir, stale, staleMs)) continue;
      if (Date.now() - t0 > timeoutMs) {
        const o = readOwner(dir);
        throw Object.assign(new Error(`${path} is locked by another nunchi process${o ? ` (pid ${o.pid} on ${o.host})` : ''}; try again in a moment, or remove ${dir} if no nunchi is running`), { code: 'LOCKED' });
      }
      sleep(wait);
    }
  } catch (e) { rmSync(ready, RM); throw e; }
  // a long holder touches the lock between steps, so a holder on another machine does not judge it stale
  const touch = () => { if (readOwner(dir)?.token === token) { const t = new Date(); try { utimesSync(join(dir, 'owner.json'), t, t); } catch {} } };
  try { return fn({ touch }); }
  finally { release(dir, token); }
}

// The parts of the lock a test needs to drive one race step by step.
export const lockInternals = { staleOwner, reap, release };
