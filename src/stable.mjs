// Stable serialization: sorted keys, fixed indentation, trailing newline.
// Every file the engine writes goes through here so equal data gives equal bytes.
import { writeFileSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync } from 'node:fs';
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

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Write-temp-then-rename in the same folder (a rename within one folder is atomic). The temp name carries the
// pid and a random part, so two writers never share one; it never appears in the output. durable: fsync the
// file before the rename and the folder after it (POSIX), for committed and shared files (decisions, approvals,
// the ledger). Run evidence skips the fsync: a run folder is renamed into place only once it is complete.
export function writeAtomic(path, data, { durable = false } = {}) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, data); if (durable) fsyncSync(fd); } finally { closeSync(fd); }
    renameRetry(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  if (durable && process.platform !== 'win32') {
    try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
  }
}

// Windows refuses a rename over a file another process has open for a moment (virus scanners, indexers).
const BUSY = new Set(['EACCES', 'EPERM', 'EBUSY']);
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
function renameRetry(from, to) {
  for (let wait = 10, waited = 0; ; wait *= 2) {
    try { return renameSync(from, to); }
    catch (e) {
      if (process.platform !== 'win32' || !BUSY.has(e.code) || waited >= 5000 || isDir(to)) throw e;
      sleep(wait); waited += wait;
    }
  }
}

// ---- lock (spec §5; design 0.1-c §8.1) -------------------------------------------------------------------
// `<file>.lock.d` is the lock: mkdir is atomic on every file system. owner.json inside says who holds it.
// - stale: the holder ran on this machine and boot (same pid namespace) and its process is gone or is another
//   process with a reused pid; or the lock was not touched for `staleMs` (another machine, or a holder that died
//   without a trace). EPERM from the liveness probe means alive.
// - a stale lock is taken over by renaming the folder away first, so two takers cannot both win, and only if it
//   still holds the owner judged stale.
// - released only while it still holds our token.
// Held only around read–change–write of a small file, never across capture or network I/O. Acquisition backs
// off for `timeoutMs`, then fails with code LOCKED.
const procFile = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const bootId = () => procFile('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
const pidNs = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
// Linux: start time of a process in clock ticks since boot (field 22 of /proc/<pid>/stat, after the name).
const procStart = pid => { const s = procFile(`/proc/${pid}/stat`); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null : null; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readOwner = dir => { try { return JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch { return null; } };

function staleOwner(dir, staleMs) {
  const owner = readOwner(dir);
  let touched;
  try { touched = statSync(owner ? join(dir, 'owner.json') : dir).mtimeMs; } catch { return null; }   // just released: try again
  if (Date.now() - touched > staleMs) return { owner };
  if (!owner || owner.host !== hostname() || owner.boot !== bootId() || owner.ns !== pidNs()) return null;
  if (!alive(owner.pid)) return { owner };
  const start = procStart(owner.pid);
  return owner.start && start && owner.start !== start ? { owner } : null;
}

function reap(dir, judged) {
  const away = `${dir.replace(/\.d$/, '')}.reap-${randomBytes(4).toString('hex')}`;
  try { renameSync(dir, away); } catch { return; }               // someone else took it over or released it
  if ((readOwner(away)?.token ?? null) !== (judged?.token ?? null)) {
    try { renameSync(away, dir); return; } catch {}                // not the holder judged stale: give it back
  }
  rmSync(away, RM);
}
// Windows: a folder another process still reads cannot be removed or made again for a moment.
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 };
const busy = e => e.code === 'EEXIST' || (process.platform === 'win32' && BUSY.has(e.code));

export function withLock(path, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const dir = `${path}.lock.d`;
  const token = randomBytes(8).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  const t0 = Date.now();
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try { mkdirSync(dir); break; } catch (e) { if (!busy(e)) throw e; }
    const stale = staleOwner(dir, staleMs);
    if (stale) { reap(dir, stale.owner); continue; }
    if (Date.now() - t0 > timeoutMs) {
      const o = readOwner(dir);
      throw Object.assign(new Error(`${path} is locked by another nunchi process${o ? ` (pid ${o.pid} on ${o.host})` : ''}; try again in a moment, or remove ${dir} if no nunchi is running`), { code: 'LOCKED' });
    }
    sleep(wait);
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname(), boot: bootId(), ns: pidNs(), start: procStart(process.pid), at: Date.now() }));
  const ours = () => readOwner(dir)?.token === token;
  // a long holder touches the lock between steps, so it is not judged stale
  const touch = () => { if (ours()) { const t = new Date(); try { utimesSync(join(dir, 'owner.json'), t, t); } catch {} } };
  try { return fn({ touch }); }
  finally { if (ours()) rmSync(dir, RM); }
}
