// (C) a Google Drive folder, synced on this machine (spec §7.6). nunchi writes the pack into the folder the person
// named inside "My Drive" and makes no network call: Drive for desktop uploads it. A cloud session reads it with the
// Google Drive connector. iCloud Drive and Dropbox reach the person's own devices, but no cloud session can read them,
// so setup does not offer them.
//
// - Where: `<My Drive>/<folder>/<run>/`, with the export's rules: the real path of every part checked (a link or a
//   Drive shortcut that leads out of My Drive is refused), `Shared drives` refused (shared by construction), nothing
//   replaced that nunchi did not write (`.nunchi-share` lists what it wrote in a run's folder), 0600 files and 0700
//   folders (the sync client ignores the modes).
// - Retention: the last RETAIN runs nunchi's own list (the state's) says it wrote here; for older ones it removes only
//   the files that list names, then the folders left empty.
// - nunchi cannot see Drive sharing: setup tells the person to check the folder is shared with nobody, and the cloud
//   side checks the folder's permissions with the connector.
import { readdirSync, existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { privateDir, refuseLink, setMode } from '../stable.mjs';
import { byRun } from '../ledger.mjs';
import { RETAIN } from './config.mjs';

export const MARKER = '.nunchi-share';
const lstatOr = p => { try { return lstatSync(p); } catch { return null; } };

// The Google Drive "My Drive" folders of this machine: Drive for desktop on macOS keeps each account in
// ~/Library/CloudStorage/GoogleDrive-<account>/My Drive; on Windows it is a drive letter with a "My Drive" folder.
export function driveRoots({ home = homedir(), platform = process.platform, exists = existsSync } = {}) {
  const out = [];
  const cloud = join(home, 'Library', 'CloudStorage');
  try { for (const n of readdirSync(cloud).sort()) if (/^GoogleDrive-/.test(n) && exists(join(cloud, n, 'My Drive'))) out.push(join(cloud, n, 'My Drive')); } catch {}
  if (platform === 'win32') for (const l of 'GHIJKLMNOPQRSTUVWXYZ') { const p = `${l}:\\My Drive`; if (exists(p)) out.push(p); }
  return out;
}
// How setup shows a root: the account folder's name cut ("GoogleDrive-…"), the home as ~
export function shownRoot(root, home = homedir()) {
  const r = root.replace(/GoogleDrive-[^/\\]+/, 'GoogleDrive-…');
  return r.startsWith(home + sep) ? `~${r.slice(home.length)}` : r;
}
// "nunchi/shop", "My Drive/nunchi/shop" or "/nunchi/shop/" → "nunchi/shop" (what the setup keeps), or null
export function folderOf(input) {
  let f = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (/^my drive(\/|$)/i.test(f)) f = f.replace(/^my drive\/?/i, '');
  if (!f || f.split('/').some(s => s === '.' || s === '..' || !s.trim())) return null;
  return f;
}
// Is the folder still a plain folder of My Drive, now? → null, or a refusal key: 'gone' (My Drive is not there:
// Drive signed out), 'shared-drive' (it lies in Shared drives), 'outside' (a link or a shortcut leads out of My Drive),
// 'not-folder'.
export function folderProblem(root, folder) {
  const r = lstatOr(root);
  if (!r || !r.isDirectory()) return 'gone';
  const target = join(root, ...folder.split('/'));
  if (/(^|[/\\])(Shared drives|\.shortcut-targets-by-id)([/\\]|$)/i.test(target)) return 'shared-drive';
  let realRoot;
  try { realRoot = realpathSync.native(root); } catch { return 'gone'; }
  if (/(^|[/\\])(Shared drives|\.shortcut-targets-by-id)([/\\]|$)/i.test(realRoot)) return 'shared-drive';
  // every part that exists: a real folder, inside the real My Drive
  let cur = root;
  for (const part of folder.split('/')) {
    cur = join(cur, part);
    const st = lstatOr(cur);
    if (!st) break;
    if (st.isSymbolicLink()) {
      let real = null; try { real = realpathSync.native(cur); } catch {}
      return real && /(^|[/\\])(Shared drives|\.shortcut-targets-by-id)([/\\]|$)/i.test(real) ? 'shared-drive' : 'outside';
    }
    if (!st.isDirectory()) return 'not-folder';
    const rel = relative(realRoot, realpathSync.native(cur));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'outside';
  }
  return null;
}

// Writes the pack to `<root>/<folder>/<run>/`. `written`: nunchi's list of what it wrote at this folder ([{ run, files }]).
// → { dir, files: the paths written, removed: runs removed by retention, written: the new list }
export function sendToFolder({ root, folder, run, files, written = [], retain = RETAIN }) {
  const base = join(root, ...folder.split('/'));
  const dir = join(base, run);
  privateDir(dir);
  refuseLink(dir);
  // a run folder already there: only one nunchi wrote (its marker), and only what the marker lists is replaced
  const marker = join(dir, MARKER);
  const had = lstatOr(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : null;
  const present = readdirSync(dir);
  if (!had && present.length) throw Object.assign(new Error(`${dir} holds files nunchi did not write`), { code: 'FOLDER_NOT_OURS' });
  const mine = new Set(had || []);
  for (const f of files) {
    const to = join(dir, ...f.path.split('/'));
    const st = lstatOr(to);
    if (st && (!st.isFile() || !mine.has(f.path))) throw Object.assign(new Error(`${to} was not written by nunchi`), { code: 'FOLDER_NOT_OURS' });
  }
  for (const f of files) {
    const to = join(dir, ...f.path.split('/'));
    privateDir(dirname(to));
    refuseLink(dirname(to));
    const tmp = join(dirname(to), `.${basename(to)}.nunchi-${process.pid}.tmp`);
    writeFileSync(tmp, f.data, { flag: 'wx', mode: 0o600 });
    setMode(tmp, 0o600);
    renameSync(tmp, to);
  }
  // what an earlier send of this run wrote and this one does not
  const now = new Set(files.map(f => f.path));
  for (const p of had || []) if (!now.has(p)) removeListed(dir, [p]);
  writeFileSync(`${marker}.tmp`, [...now].sort().map(p => `${p}\n`).join(''), { mode: 0o600 });
  renameSync(`${marker}.tmp`, marker);
  // retention: the last `retain` runs of nunchi's list (this one included)
  const list = [...written.filter(w => w.run !== run), { run, files: [...now].sort() }].sort((a, b) => byRun(a.run, b.run));
  const drop = list.slice(0, Math.max(0, list.length - retain));
  for (const w of drop) {
    const d = join(base, w.run);
    if (!lstatOr(d)?.isDirectory()) continue;
    removeListed(d, [...w.files, MARKER]);
    removeEmpty(d);
  }
  return { dir, removed: drop.map(w => w.run), written: list.slice(-retain) };
}
// Removes the files a list names under `dir` (plain files only; a link is removed as a link, never followed), then the
// folders on their way that are left empty.
function removeListed(dir, paths) {
  for (const p of paths) {
    const f = join(dir, ...p.split('/'));
    const rel = relative(dir, resolve(f));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    const st = lstatOr(f);
    if (st && (st.isFile() || st.isSymbolicLink())) { try { unlinkSync(f); } catch {} }
    for (let d = dirname(f); d !== dir && relative(dir, d) && !relative(dir, d).startsWith('..'); d = dirname(d)) { try { rmdirSync(d); } catch { break; } }
  }
}
const removeEmpty = d => { try { rmdirSync(d); } catch {} };
