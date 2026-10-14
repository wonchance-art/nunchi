// Stable serialization: sorted keys, fixed indentation, trailing newline.
// Every file the engine writes goes through here so equal data gives equal bytes.
import { writeFileSync, mkdirSync, openSync, fsyncSync, fchmodSync, chmodSync, closeSync, renameSync, unlinkSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, lstatSync, existsSync, utimesSync, constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
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

// Written through writeAtomic (temp file, then rename), so a reader or a crash sees the old bytes or the new ones,
// never half a file. Evidence holds screenshots and data of signed-in screens, recordings hold API responses:
// owner-only (D12), 0600 files in 0700 folders whatever the umask, and never written through a symbolic link.
export function writeStable(path, value) {
  privateDir(dirname(path));
  refuseLink(path);
  writeAtomic(path, typeof value === 'string' || value instanceof Uint8Array ? value : stableJson(value), { mode: 0o600 });
}

export const sha = (data, n = 16) => createHash('sha256').update(data).digest('hex').slice(0, n);

const POSIX = process.platform !== 'win32';
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The syncs (what makes a write survive a power loss) and renames go through here, and so does which platform's rules apply to a refused rename: no output
// shows them, so a test can watch the syncs and make renames refuse as Windows does.
export const io = { fsync: fd => fsyncSync(fd), rename: (from, to) => renameSync(from, to), posix: POSIX };

// Nothing is written, nor its mode changed, through a symbolic link: a link planted among nunchi's paths would
// send the write (or the chmod) outside the repository (D12).
export function refuseLink(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isSymbolicLink()) throw Object.assign(new Error(`${path} is a symbolic link; nunchi does not write through links (replace it with a real file or folder)`), { code: 'UNSAFE_PATH' });
}
// Modes are set explicitly, so a permissive umask cannot widen them; Windows has no POSIX modes.
export const setMode = (path, mode) => { refuseLink(path); if (POSIX) chmodSync(path, mode); };
// mkdir -p, and every folder it creates is 0700. Folders that already exist are left as they are.
export function privateDir(dir) {
  const created = [];
  for (let d = resolve(dir); !existsSync(d) && dirname(d) !== d; d = dirname(d)) created.push(d);
  if (!created.length) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of created) setMode(d, 0o700);
}

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

// Windows refuses a rename over a file another process has open for a moment (virus scanners, indexers, a
// reader), a rename of a folder while another process has a file in it open, and a new file or folder at a
// path still being deleted: EPERM, EACCES or EBUSY. Those are retried with backoff for up to `totalMs`, then
// thrown. POSIX never refuses for those reasons, so nothing is retried there.
const BUSY = new Set(['EACCES', 'EPERM', 'EBUSY']);
export function retryBusy(fn, totalMs = 5000, { posix = io.posix } = {}) {
  for (let wait = 5, waited = 0; ; wait = Math.min(wait * 2, 200)) {
    try { return fn(); }
    catch (e) {
      if (posix || !BUSY.has(e.code) || waited >= totalMs) throw e;
      sleep(wait); waited += wait;
    }
  }
}
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
// a folder in the way is not busy: it stays in the way
const renameRetry = (from, to) => retryBusy(() => { try { return io.rename(from, to); } catch (e) { if (isDir(to)) e.code = 'EISDIR'; throw e; } });

// What a crash in the middle of a write leaves: temp files of writeAtomic (and of older versions) and lock
// folders being made or removed. Removed from `dir` once they are an hour old (design §8.1).
const LEFTOVER = /^\..+\.tmp-\d+-[0-9a-f]{8}$|^.+\.\d+\.tmp$|\.lock\.d\.(tmp|gone|alive)-[0-9a-f]+$/;
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
// - stale: a holder on this machine (same host, boot and pid namespace) is judged by whether its process still
//   runs, never by age, so a clock jump or a sleeping laptop does not take a live lock away:
//   - Linux: its pid, and the start time of the process under that pid (a reused pid is another process);
//   - Windows: a freed pid goes to the next process made, at once, and there is no start time to tell them apart.
//     So the holder keeps `<file>.lock.d.alive-<token>` open with sharing mode 0 while it holds the lock; Windows
//     closes it when the process ends, however it ends. A taker that can open it knows the holder has ended,
//     whoever has its pid now; one refused (a sharing violation) knows it runs. The holder checks that its own
//     second open is refused before it relies on this; if not, the pid alone decides (below).
//   - otherwise (macOS, or Windows without that check): the pid alone. A reused pid then only makes takers wait
//     and end in LOCKED: it fails closed, never takes a live lock.
//   A holder elsewhere is stale once it has not touched the lock for `staleMs`.
// - a stale lock is removed by one taker at a time, under `<file>.lock.d.reap`, and only after reading again,
//   under it, that the lock still holds the owner judged stale and is still stale. A lock is never given back.
// - released only while it still holds our token.
// - Windows refuses to rename the lock folder while another process reads owner.json in it: those renames, and
//   the reads, are retried (retryBusy), so a release is never lost to a reader.
// Held only around read–change–write of a small file, and by `nunchi open` while it starts a board (withLockAsync,
// which waits without blocking), never across capture or network I/O. Acquisition backs
// off for `timeoutMs`, then fails with code LOCKED, also when a stale lock cannot be removed.
const procFile = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const bootId = () => procFile('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
const pidNs = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
// Linux: start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat, after the name).
const procStart = pid => { const s = procFile(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null : null; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// null when there is no lock, or no readable owner in it
function readOwner(dir) {
  let text;
  try { text = retryBusy(() => readFileSync(join(dir, 'owner.json'), 'utf8'), 1000); } catch { return null; }
  try { return JSON.parse(text); } catch { return null; }
}
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 };
// A rename onto a lock that exists: ENOTEMPTY or EEXIST; Windows says EPERM, EACCES or EBUSY.
const taken = e => e.code === 'ENOTEMPTY' || e.code === 'EEXIST' || (!io.posix && BUSY.has(e.code));
const sameMachine = o => !!o && o.host === hostname() && o.boot === bootId() && o.ns === pidNs();

// Windows: libuv's UV_FS_O_EXLOCK opens a file with sharing mode 0 (no other open succeeds while it is open).
const EXLOCK = 0x10000000;
function holdAliveWindows(file) {
  let fd;
  try { fd = openSync(file, constants.O_CREAT | constants.O_RDWR | EXLOCK, 0o600); } catch { return null; }
  const drop = () => { try { closeSync(fd); } catch {} try { unlinkSync(file); } catch {} };
  try { closeSync(openSync(file, 'r')); drop(); return null; }       // a second open worked: not exclusive, no use
  catch (e) { if (!BUSY.has(e.code)) { drop(); return null; } }      // refused: only this process can open it
  return { release: drop };
}
// true: the holder runs; false: it has ended; null: cannot tell (the pid decides)
function probeAliveWindows(file) {
  try { closeSync(openSync(file, 'r')); return false; }
  catch (e) { return BUSY.has(e.code) ? true : null; }
}
io.holdAlive = file => (POSIX ? null : holdAliveWindows(file));
io.probeAlive = file => (POSIX ? null : probeAliveWindows(file));

function staleOwner(dir, staleMs) {
  const owner = readOwner(dir);
  let touched;
  try { touched = statSync(owner ? join(dir, 'owner.json') : dir).mtimeMs; } catch { return null; }   // just released: try again
  if (sameMachine(owner)) {
    const running = owner.alive ? io.probeAlive(join(dirname(dir), owner.alive)) : null;
    if (running !== null) return running ? null : { owner };
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
    if (e.code !== 'EEXIST' && !(!io.posix && BUSY.has(e.code))) throw e;
    // a taker that died while removing a lock leaves its guard; it is cleared once it is old
    try { if (Date.now() - statSync(guard).mtimeMs > staleMs) rmSync(guard, RM); } catch {}
    return false;
  }
  try {
    const now = staleOwner(dir, staleMs);
    if (!now || (now.owner?.token ?? null) !== (judged.owner?.token ?? null)) return false;
    const gone = `${dir}.gone-${randomBytes(4).toString('hex')}`;
    try { retryBusy(() => io.rename(dir, gone), 1000); } catch { return false; }
    rmSync(gone, RM);
    if (now.owner?.alive) try { unlinkSync(join(dirname(dir), now.owner.alive)); } catch {}   // the ended holder's file
    return true;
  } finally { rmSync(guard, RM); }
}

function release(dir, token) {
  if (readOwner(dir)?.token !== token) return;                   // not ours (any more): leave it
  const gone = `${dir}.gone-${token}`;
  try { retryBusy(() => io.rename(dir, gone)); }
  catch (e) {                                                    // a lock that cannot be released is said, not left silently
    if (e.code === 'ENOENT') return;
    throw Object.assign(new Error(`${dir} could not be released (${e.code}); remove it if no nunchi is running`), { code: 'LOCKED' });
  }
  rmSync(gone, RM);
}

// The steps of taking a lock, shared by the blocking and the awaiting way to wait for it.
function prepareLock(path) {
  const dir = `${path}.lock.d`;
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString('hex');
  const ready = `${dir}.tmp-${token}`;
  // Windows: open before the lock is ours, so there is no moment it is held without its proof of life
  const aliveFile = `${dir}.alive-${token}`;
  const held = io.holdAlive(aliveFile);
  try { mkdirSync(ready); } catch (e) { held?.release(); throw e; }
  writeFileSync(join(ready, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), boot: bootId(), ns: pidNs(), start: procStart(process.pid), alive: held ? basename(aliveFile) : null, at: Date.now() }));
  return { path, dir, token, ready, held, t0: Date.now() };
}
// One try: → true when the lock is ours; false to wait and try again; throws LOCKED after `timeoutMs`.
function tryLock(l, { timeoutMs, staleMs }) {
  for (;;) {
    try { io.rename(l.ready, l.dir); return true; } catch (e) { if (!taken(e)) throw e; }
    const stale = staleOwner(l.dir, staleMs);
    if (stale && reap(l.dir, stale, staleMs)) continue;
    if (Date.now() - l.t0 > timeoutMs) {
      const o = readOwner(l.dir);
      const who = o ? ` (pid ${o.pid} on ${o.host}${sameMachine(o) ? `, ${alive(o.pid) ? 'running' : 'exited'}` : ''})` : '';
      throw Object.assign(new Error(`${l.path} is locked by another nunchi process${who}; try again in a moment, or remove ${l.dir} if no nunchi is running`), { code: 'LOCKED' });
    }
    return false;
  }
}
const abandon = l => { rmSync(l.ready, RM); l.held?.release(); };
// a long holder touches the lock between steps, so a holder on another machine does not judge it stale
function heldLock(l) {
  return {
    touch: () => { if (readOwner(l.dir)?.token === l.token) { const t = new Date(); try { utimesSync(join(l.dir, 'owner.json'), t, t); } catch {} } },
    release: () => { try { release(l.dir, l.token); } finally { l.held?.release(); } },   // the proof of life after the lock, never before
  };
}

export function withLock(path, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const l = prepareLock(path);
  try { for (let wait = 5; !tryLock(l, { timeoutMs, staleMs }); wait = Math.min(wait * 2, 100)) sleep(wait); }
  catch (e) { abandon(l); throw e; }
  const h = heldLock(l);
  try { return fn({ touch: h.touch }); } finally { h.release(); }
}
// The same lock, waited for without blocking (for a holder that awaits: `nunchi open` starting a board).
export async function withLockAsync(path, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const l = prepareLock(path);
  try { for (let wait = 5; !tryLock(l, { timeoutMs, staleMs }); wait = Math.min(wait * 2, 100)) await new Promise(r => setTimeout(r, wait)); }
  catch (e) { abandon(l); throw e; }
  const h = heldLock(l);
  try { return await fn({ touch: h.touch }); } finally { h.release(); }
}

// The parts of the lock a test needs to drive one race step by step.
export const lockInternals = { staleOwner, reap, release, holdAliveWindows, probeAliveWindows };
