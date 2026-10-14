// Stable serialization: sorted keys, fixed indentation, trailing newline.
// Every file the engine writes goes through here so equal data gives equal bytes.
import { writeFileSync, mkdirSync, chmodSync, renameSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

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

// Evidence holds screenshots and data of signed-in screens, recordings hold API responses: owner-only
// (D12). Modes are set explicitly, so a permissive umask cannot widen them; Windows has no POSIX modes.
const POSIX = process.platform !== 'win32';
// Nothing is written, nor its mode changed, through a symbolic link: a link planted among nunchi's paths would
// send the write (or the chmod) outside the repository.
export function refuseLink(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isSymbolicLink()) throw Object.assign(new Error(`${path} is a symbolic link; nunchi does not write through links (replace it with a real file or folder)`), { code: 'UNSAFE_PATH' });
}
export const setMode = (path, mode) => { refuseLink(path); if (POSIX) chmodSync(path, mode); };
// mkdir -p, and every folder it creates is 0700. Folders that already exist are left as they are.
export function privateDir(dir) {
  const created = [];
  for (let d = resolve(dir); !existsSync(d) && dirname(d) !== d; d = dirname(d)) created.push(d);
  if (!created.length) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of created) setMode(d, 0o700);
}
const bytes = value => (typeof value === 'string' || value instanceof Uint8Array ? value : stableJson(value));

export function writeStable(path, value) {
  privateDir(dirname(path));
  refuseLink(path);
  writeFileSync(path, bytes(value), { mode: 0o600 });
  setMode(path, 0o600);
}

// Replaced in one step (temp file in the same folder, then rename): a reader sees the old file or the
// new one, never half of one, and a crash leaves the old file intact.
export function writeStableAtomic(path, value) {
  privateDir(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, bytes(value), { mode: 0o600 });
    setMode(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

export const sha = (data, n = 16) => createHash('sha256').update(data).digest('hex').slice(0, n);
