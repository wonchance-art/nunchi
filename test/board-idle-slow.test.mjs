// The board's idle stop and a slow machine (§3.2; CI Windows node 20, 2026-10-15 KST): the person's requests keep the
// board up, and the time spent answering one is not idle time. A runner slow enough to take longer than the idle time
// over one answer (the first builds the model) used to stop the board right after answering, while the person was
// still using it. The model build is held here for longer than the idle time, as such a machine does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBoard } from '../src/board/server.mjs';
import { smallProject } from './fixtures/board-project.mjs';

test('§3.2 an answer that takes longer than the idle time (a slow machine) does not stop the board right after it: the person is still there', async () => {
  const p = smallProject();
  let gone = null, hold = false;
  const busy = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* a slow machine */ } };
  const b = await startBoard({ projectDir: p.root, idleMs: 1200, onExit: why => { gone = why; }, testHooks: { afterBuild: () => { if (hold) { hold = false; busy(1600); } } } });
  try {
    const origin = b.origin;
    const s = await (await fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code: b.newLink().split('#t=')[1] }) })).json();
    const call = path => fetch(origin + path, { headers: { 'x-nunchi-token': s.token } }).then(r => r.json());
    hold = true;                                        // the next model build takes 1.6 s, longer than the idle time
    const t0 = Date.now();
    await call('/api/summary');
    assert.ok(Date.now() - t0 >= 1600, 'the answer took longer than the idle time');
    assert.equal(hold, false, 'that answer built the model');
    // the person goes on, a request every 200 ms: the board stays up
    for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 200)); await call('/api/summary'); }
    assert.equal(gone, null, 'still up');
  } finally { await b.close(); }
});
