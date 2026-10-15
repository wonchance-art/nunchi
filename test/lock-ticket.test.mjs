// The lock's place in line (D5 fairness, src/stable.mjs; a macOS runner, 2026-10-15 KST): a waiter that finds the lock
// taken is in line from its first try. Before, it made its ticket only after waiting 20 ms, so a waiter the machine set
// aside right after it asked had no place yet, and a process that released and asked again after it went first, again
// and again (the fair-lock test saw a waiter overtaken 4 times by 3 others on a busy macOS runner). Driven step by step
// here, so it does not depend on how busy the machine is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { lockInternals as I } from '../src/stable.mjs';
import { tmp } from './fixtures/hunt-run.mjs';

test('the lock: a waiter is in line from its first try, so one that released and asks again waits behind it however long the waiter is set aside', () => {
  const file = join(tmp('nunchi-lock-line-'), 'x.json');
  const opts = { timeoutMs: 5000, staleMs: 30000 };
  const x = I.prepareLock(file);
  assert.equal(I.tryLock(x, opts), true, 'X takes the free lock, without a ticket');
  const held = I.heldLock(x);
  const w = I.prepareLock(file);
  assert.equal(I.tryLock(w, opts), false, 'W finds it taken');
  assert.ok(w.ticket, 'and is in line at once');
  // W is set aside (a busy machine) while X releases and asks again, a moment later than W asked
  held.release();
  while (Date.now() <= w.t0) { /* a later millisecond than W's request */ }
  const again = I.prepareLock(file);
  assert.equal(I.tryLock(again, opts), false, 'X waits behind W');
  assert.ok(again.ticket);
  // W comes back: its turn, then X's
  assert.equal(I.tryLock(w, opts), true, 'W takes it');
  I.heldLock(w).release();
  assert.equal(I.tryLock(again, opts), true, 'then X');
  I.heldLock(again).release();
  assert.deepEqual(readdirSync(dirname(file)), [], 'no lock, ticket or temp file left behind');
});
