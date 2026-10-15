// Helpers of the board's fix-loop tests (test/board-fix*.test.mjs): an attempt of the fix loop on a synthetic git
// project, the board with a key, and the decisions written. Split out of test/board-fix.test.mjs so each of its files
// stays well under the per-file test timeout on the slowest CI runner (Windows, Node 20).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startBoard } from '../../src/board/server.mjs';
import * as F from '../../src/fix/loop.mjs';
import { edit, commitWith } from './fix-project.mjs';
import { boardRequest } from './board-call.mjs';

export const ctxOf = p => F.openFix({ cwd: p.root, root: p.root, deps: { capture: p.cap.capture, prove: async () => ({ ok: true }) } });
export async function attempt(p, change) {
  assert.equal((await F.startFix(ctxOf(p), p.group)).code, 0);
  edit(p.root, 'app/settings/page.jsx', ...change);
  const c = await F.checkFix(ctxOf(p), p.group);
  commitWith(p.root, c.json.trailers);
  return F.verifyFix(ctxOf(p), p.group);
}
export async function board(p) {
  const b = await startBoard({ projectDir: p.root });
  const origin = b.origin;
  const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
  // a fresh connection per request: the fix loop runs between calls (fixtures/board-call.mjs)
  const call = (path, body, { token = s.token } = {}) => boardRequest(origin, path, { token, body });
  return { b, call };
}
export const decisionsOf = nunchi => readdirSync(join(nunchi, 'decisions'), { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(nunchi, 'decisions', f), 'utf8')));
