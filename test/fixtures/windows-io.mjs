// Windows' rules for the lock's small files, on any machine (installed on stable.mjs's `io`): a read keeps the file
// open for a moment (`openMs`), and while a file is open it cannot be renamed over, and a folder holding it cannot be
// renamed; a file deleted while open stays in its folder, refusing every open (EPERM), until the last handle closes
// (delete-pending); a file is unreadable for a moment while it is being renamed; a rename onto a folder that exists
// says EPERM, as Windows does. `posix: false` makes the lock read EPERM, EACCES and EBUSY as "busy". → { restore,
// stats } (how often each rule refused).
import { readFileSync, statSync, unlinkSync, renameSync, writeFileSync, utimesSync } from 'node:fs';
import { sep } from 'node:path';

export function windowsIo(io, { openMs = 2, renameMs = 1 } = {}) {
  const saved = { ...io };
  const opens = new Map(), pending = new Map(), renaming = new Map();
  const stats = { renameOverOpen: 0, renameFolderWithOpen: 0, deletePending: 0, openPending: 0, readDuringRename: 0 };
  const now = () => performance.now();
  const sweep = () => {
    const t = now();
    for (const [p, until] of pending) if (until <= t) { pending.delete(p); try { unlinkSync(p); } catch {} }
    for (const [p, until] of opens) if (until <= t) opens.delete(p);
    for (const [p, until] of renaming) if (until <= t) renaming.delete(p);
  };
  const busy = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted (Windows rules)`), { code });
  const isOpen = p => (opens.get(p) || 0) > now();
  const openUnder = dir => [...opens.keys()].some(p => p.startsWith(dir + sep) && isOpen(p));
  const refusePending = p => { if (pending.has(p)) { stats.openPending++; throw busy(); } };
  Object.assign(io, {
    posix: false,
    readFile: p => {
      sweep(); refusePending(p);
      if ((renaming.get(p) || 0) > now()) { stats.readDuringRename++; throw busy(); }
      const text = readFileSync(p, 'utf8');
      opens.set(p, now() + openMs);
      return text;
    },
    stat: p => { sweep(); refusePending(p); const st = statSync(p); opens.set(p, now() + openMs); return st; },     // Windows opens a file to stat it
    touch: (p, t = new Date()) => { sweep(); refusePending(p); utimesSync(p, t, t); },
    writeFile: (p, data) => { sweep(); refusePending(p); writeFileSync(p, data); },
    unlink: p => {
      sweep(); refusePending(p);
      if (isOpen(p)) { stats.deletePending++; pending.set(p, opens.get(p)); return; }
      unlinkSync(p);
    },
    rename: (from, to) => {
      sweep(); refusePending(from); refusePending(to);
      if (isOpen(to)) { stats.renameOverOpen++; throw busy(); }
      if (openUnder(from)) { stats.renameFolderWithOpen++; throw busy(); }
      try { renameSync(from, to); } catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw busy(); throw e; }
      renaming.set(to, now() + renameMs);
    },
  });
  return { stats, restore: () => { sweep(); for (const p of pending.keys()) try { unlinkSync(p); } catch {} Object.assign(io, saved); } };
}
