// Windows' rules for the lock's small files, on any machine (installed on stable.mjs's `io`), for waiters that run in
// one process (withLockAsync): a read or stat keeps the file open for a moment (`openMs`) as far as the *other*
// waiters are concerned — each waiter's step runs in its own turn of the event loop, and a step's own handle is closed
// before its next call, as readFileSync closes it — and while a file is open elsewhere it cannot be renamed over, nor a
// folder holding it renamed; a file deleted while open elsewhere stays, refusing every open (EPERM), until that handle
// closes (delete-pending); a file is unreadable for a moment while it is being renamed; a rename onto a folder that
// exists says EPERM, as Windows does. `posix: false` makes the lock read EPERM, EACCES and EBUSY as "busy".
// → { restore, stats } (how often each rule refused).
import { readFileSync, statSync, unlinkSync, renameSync, writeFileSync, utimesSync } from 'node:fs';
import { sep } from 'node:path';

export function windowsIo(io, { openMs = 2, renameMs = 1 } = {}) {
  const saved = { ...io };
  // the turn: one synchronous stretch of the event loop (one waiter's step); it ends at the next microtask checkpoint
  let turn = 0, armed = false;
  const now = () => { if (!armed) { armed = true; queueMicrotask(() => { turn++; armed = false; }); } return turn; };
  const opens = new Map(), pending = new Map(), renaming = new Map();     // path → { until, turn }
  const stats = { renameOverOpen: 0, renameFolderWithOpen: 0, deletePending: 0, openPending: 0, readDuringRename: 0 };
  const t = () => performance.now();
  const sweep = () => {
    for (const [p, o] of pending) if (o.until <= t()) { pending.delete(p); try { unlinkSync(p); } catch {} }
    for (const [p, o] of opens) if (o.until <= t()) opens.delete(p);
    for (const [p, o] of renaming) if (o.until <= t()) renaming.delete(p);
  };
  const busy = () => Object.assign(new Error('EPERM: operation not permitted (Windows rules)'), { code: 'EPERM' });
  const elsewhere = (map, p) => { const o = map.get(p); return !!o && o.until > t() && o.turn !== now(); };
  const openUnder = dir => [...opens.keys()].some(p => p.startsWith(dir + sep) && elsewhere(opens, p));
  const refusePending = p => { if (pending.has(p)) { stats.openPending++; throw busy(); } };
  const opened = p => opens.set(p, { until: t() + openMs, turn: now() });
  Object.assign(io, {
    posix: false,
    readFile: p => {
      sweep(); refusePending(p);
      if (elsewhere(renaming, p)) { stats.readDuringRename++; throw busy(); }
      const text = readFileSync(p, 'utf8');
      opened(p);
      return text;
    },
    stat: p => { sweep(); refusePending(p); const st = statSync(p); opened(p); return st; },      // Windows opens a file to stat it
    touch: (p, at = new Date()) => { sweep(); refusePending(p); utimesSync(p, at, at); },
    writeFile: (p, data) => { sweep(); refusePending(p); writeFileSync(p, data); },
    unlink: p => {
      sweep(); refusePending(p);
      if (elsewhere(opens, p)) { stats.deletePending++; pending.set(p, opens.get(p)); return; }
      unlinkSync(p);
    },
    rename: (from, to) => {
      sweep(); refusePending(from); refusePending(to);
      if (elsewhere(opens, to)) { stats.renameOverOpen++; throw busy(); }
      if (openUnder(from)) { stats.renameFolderWithOpen++; throw busy(); }
      try { renameSync(from, to); } catch (e) { if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') throw busy(); throw e; }
      renaming.set(to, { until: t() + renameMs, turn: now() });
    },
  });
  return { stats, restore: () => { sweep(); for (const p of pending.keys()) try { unlinkSync(p); } catch {} Object.assign(io, saved); } };
}
