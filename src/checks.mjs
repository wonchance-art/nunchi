// The check profile (design 0.1-c §4.3): what nunchi's fix loop (M3) will run of the repository's own checks, approved
// once through a human channel (the board's card, `/api/approve-checks`, or `nunchi fix --approve-checks` in the
// person's own terminal), never by the agent. It holds:
// - the exact `build`, `typecheck`, `lint` and `test` script lines of package.json, and their `pre*` / `post*` lines;
// - `serve`: the `dev` and `start` lines (and their pre/post lines), the scripts `fix --serve` may start the app with
//   (design §4.4 "the approved start script");
// - the SHA-256 of `.npmrc`, `.yarnrc`, `.yarnrc.yml` (and the file its `yarnPath` names), `bunfig.toml`,
//   `pnpm-workspace.yaml` and `.pnpmfile.cjs` (absent: null);
// - the `packageManager` field.
// Any change gives another hash, which asks again. Approved hashes live in the state store's `scripts-approved.json`
// (approved.json stays decision provenance). M2 builds the approval channel; the fix loop that reads it is M3.
import { join, resolve, relative, isAbsolute } from 'node:path';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stableJson } from './stable.mjs';
import { readDoc, updateDoc } from './state.mjs';

export const CHECK_SCRIPTS = ['build', 'typecheck', 'lint', 'test'];
export const SERVE_SCRIPTS = ['dev', 'start'];
export const CONFIG_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'pnpm-workspace.yaml', '.pnpmfile.cjs'];
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const MAX = 4 * 1024 * 1024;
function fileHash(path) {
  try { const st = lstatSync(path); if (!st.isFile() || st.size > MAX) return st.isSymbolicLink() ? 'symlink' : null; return sha256(readFileSync(path)); }
  catch { return null; }
}
const inside = (root, p) => { const r = relative(root, p); return r && !r.startsWith('..') && !isAbsolute(r); };

// → { scripts, files, packageManager, hash } or null when the project has no package.json.
export function checkProfile(projectDir) {
  const root = resolve(projectDir);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { return null; }
  const all = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  const scripts = {}, serve = {};
  for (const name of CHECK_SCRIPTS) for (const n of [`pre${name}`, name, `post${name}`]) if (typeof all[n] === 'string') scripts[n] = all[n];
  for (const name of SERVE_SCRIPTS) for (const n of [`pre${name}`, name, `post${name}`]) if (typeof all[n] === 'string') serve[n] = all[n];
  const files = {};
  for (const f of CONFIG_FILES) files[f] = fileHash(join(root, f));
  // `.yarnrc.yml` can point yarn at a JavaScript file of the repository: that file is part of what runs
  try {
    const m = /^\s*yarnPath:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(readFileSync(join(root, '.yarnrc.yml'), 'utf8'));
    if (m) { const p = resolve(root, m[1]); files[`yarnPath:${m[1]}`] = inside(root, p) ? fileHash(p) : 'outside the project'; }
  } catch {}
  const profile = { scripts, serve, files, packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : null };
  return { ...profile, hash: sha256(stableJson(profile)).slice(0, 32) };
}

export const scriptsApprovedPath = stateDir => join(stateDir, 'scripts-approved.json');
export const checksRequestPath = stateDir => join(stateDir, 'checks-request.json');
const isDoc = d => !!d && typeof d === 'object' && (d.profiles === undefined || (typeof d.profiles === 'object' && !Array.isArray(d.profiles)));
const READ = { validate: isDoc, why: 'is not a nunchi check-profile approval file', fix: 'delete it (the check scripts are then asked again)' };

export const approvedProfiles = file => new Set(Object.keys(readDoc(file, READ).doc?.profiles || {}));

// Approves the profile as it is now, through a human channel only. `seen`: the hash the person was shown; a profile that
// changed since is refused (STALE), so nobody approves lines they did not read.
export function approveProfile(file, projectDir, { seen, channel, by, generation = null }) {
  if (channel !== 'board' && channel !== 'cli-tty') throw Object.assign(new Error('check scripts are approved by a person only (the board, or your own terminal)'), { code: 'NOT_HUMAN' });
  const now = checkProfile(projectDir);
  if (!now) throw Object.assign(new Error('this project has no package.json'), { code: 'NO_PROFILE' });
  if (now.hash !== seen) throw Object.assign(new Error('the check scripts changed since they were shown; look at them again'), { code: 'STALE' });
  updateDoc(file, doc => {
    const cur = doc || { schema: 1 };
    if (cur.profiles?.[now.hash]) return doc;
    return { ...cur, schema: 1, note: 'check profiles a person approved (design §4.3); any change asks again', profiles: { ...(cur.profiles || {}), [now.hash]: { scripts: now.scripts, serve: now.serve, files: now.files, packageManager: now.packageManager, channel, by } } };
  }, { read: READ, prev: false, generation });
  return now.hash;
}
