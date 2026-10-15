// The Coverage and Screens views' words and geometry (M7; the mock-up the owner approved on 2026-10-15 KST, §5): one
// strings table, the map's marks (shape and word, never colour alone), stacked markers for overlapping boxes. Pure
// functions: no server, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../src/board/shared.mjs';

const C = W.COVERAGE;

test('words: the mock-up §5 strings, in the table', () => {
  assert.equal(C.sub('0012', true), 'What nunchi looked at in run 0012 (full check), and what it didn’t');
  assert.equal(C.sub('0012', false), 'What nunchi looked at in run 0012, and what it didn’t');
  assert.equal(C.ofCells(400, 440), '400 of 440 cells on checked screens');
  assert.equal(C.wholeRan, 'Ran over the whole app: links, one-off styles, secrets in the bundle');
  assert.equal(C.wholeNot('only the pages asked for'), 'Not a full check: only the pages asked for. Whole-app checks can’t mark anything fixed.');
  assert.equal(`${C.gapsH}${C.gapsMore}`, 'What wasn’t checked, and what to do');
  assert.deepEqual(['full', 'partly', 'rules', 'not', 'none'].map(k => W.MARKS[k].word), ['Looked at fully', 'Partly', 'Rules only', 'Not checked', 'Not captured here']);
  assert.equal(C.reason.budget, 'Not checked: AI budget ran out', 'the existing words (not-seen-budget)');
  assert.equal(C.reason['canary-missed'], 'Doesn’t count: the AI missed a test defect nunchi planted');
  assert.equal(C.reason.redirected('/login'), 'Not checked: sent to /login');
  assert.equal(C.reason.other('timeout'), 'Not checked: capture failed (timeout)');
  assert.equal(C.budgetMore(['L4'], W.thousands(70000)), 'The budget goes to the worst defects first; L4 comes last. The rest needs about 70,000 more tokens.');
  assert.equal(C.budgetMore(['L5', 'L4'], '1,000'), 'The budget goes to the worst defects first; L5 and L4 come last. The rest needs about 1,000 more tokens.');
  assert.equal(C.notLooked(1, '0007'), '1 open finding can’t be marked fixed: not looked at since run 0007');
  assert.equal(C.tell(C.say.hunt('L6', '/cart')), 'Tell your AI “hunt L6 on `/cart` again”');
  assert.equal(C.startThen, 'Start your app, then tell your AI “capture again”');
  assert.equal(C.loginThen, 'Run nunchi login in your own terminal, then tell your AI “capture again”');
  assert.equal(C.copy('capture again'), 'Copy “capture again”', 'Copy is named by its sentence');
  assert.equal(W.SCREENS.shown(40, 128), '40 shown of 128');
  assert.equal(W.SCREENS.fixOf('Raw error text', 1), 'Fix of “Raw error text”, attempt 1');
  assert.equal(W.SCREENS.unchanged('0009'), 'Unchanged since run 0009 (same pixels and text)');
  assert.equal(W.SCREENS.gone('0013'), 'This screen isn’t in run 0013.');
  assert.deepEqual(W.KEY_HELP_SCREENS.filter(([k]) => ['V', 'B', '[ / ]', 'C', '1–9'].includes(k)).map(([k, v]) => `${k} ${v}`), ['V Desktop or phone', 'B Both widths', '[ / ] Other states of this page', 'C Compare', '1–9 Finding n']);
  assert.ok(!W.MORE_VIEWS.some(([v]) => /Coverage/.test(v)), '"More views in 0.2" no longer lists the Coverage map: the view is built');
  assert.equal(W.lensLabel('L10', 'Parity (phone first view and fixed elements)'), 'L10 Parity', 'the pack\'s name without its note');
  assert.equal(W.lensLabel('L8'), 'L8 Accessibility', 'a lens with no pack: the spec\'s name');
});

test('marks: a cell is a shape and a word under each Checks choice; a gap is anything but ● and ·', () => {
  const lens = (id, status, reason = null) => ({ lens: id, status, reason });
  const cell = { checked: true, why: null, ai: { seen: 6, of: 7, lenses: [lens('L1', 'seen'), lens('L6', 'not-seen', 'canary-missed')] } };
  assert.deepEqual(W.coverageMark(cell), { kind: 'partly', text: '6 of 7', gap: true });
  assert.deepEqual(W.coverageMark({ ...cell, ai: { seen: 7, of: 7, lenses: [] } }), { kind: 'full', text: '7 of 7', gap: false });
  assert.deepEqual(W.coverageMark({ ...cell, ai: null }), { kind: 'rules', text: 'Rules only', gap: true });
  assert.deepEqual(W.coverageMark({ checked: false, why: 'Not checked: sent to /login', ai: null }), { kind: 'not', text: 'sent to /login', gap: true });
  assert.deepEqual(W.coverageMark(null), { kind: 'none', text: 'none', gap: false });
  assert.deepEqual(W.coverageMark(cell, 'rules'), { kind: 'ok', text: 'Checked', gap: false });
  assert.deepEqual(W.coverageMark(cell, 'L1'), { kind: 'full', text: 'Looked', gap: false });
  assert.deepEqual(W.coverageMark(cell, 'L6'), { kind: 'not', text: 'Doesn’t count: the AI missed a test defect nunchi planted', gap: true });
  assert.deepEqual(W.coverageMark(cell, 'L2'), { kind: 'none', text: 'Doesn’t apply here', gap: false });
  assert.equal(W.markCounts([{ kind: 'full' }, { kind: 'not' }, { kind: 'full' }]), '● 2 · ✕ 1');
  assert.equal(W.markCounts([]), '· none');
  // the accessible name is the whole sentence
  assert.equal(W.cellName('/cart', 'Signed in, Desktop, Normal', cell), '/cart, Signed in, Desktop, Normal: partly. AI 6 of 7. L6 doesn’t count: the AI missed a test defect nunchi planted.');
  assert.equal(W.cellName('/checkout', 'Visitor, Desktop, Normal', { checked: false, why: 'Not checked: sent to /login' }), '/checkout, Visitor, Desktop, Normal: sent to /login.');
  // why a screen was not checked, in the board's words
  assert.equal(W.notCheckedText({ status: 'captured', reason: 'redirected to /login', redirected: true, finalPath: '/login' }), 'Not checked: sent to /login');
  assert.equal(W.notCheckedText({ status: 'capture-failed', reason: 'redirected-off-origin', finalOrigin: 'https://pay.example.test' }), 'Not checked: left the app (https://pay.example.test)');
  assert.equal(W.notCheckedText({ status: 'capture-failed', reason: 'no-dom' }), 'Not checked: the screen didn’t load');
  assert.equal(W.notCheckedText({ status: 'not-seen', reason: 'login-expired' }), 'Not checked: the saved login no longer worked');
  assert.equal(W.notCheckedText({ status: 'capture-failed', reason: 'timeout' }), 'Not checked: capture failed (timeout)');
});

test('markers: boxes that overlap by IoU 0.5 or more are one stacked marker ("1 2"), so ① is never hidden under ②', () => {
  const m = (left, top, width, height, n) => ({ left, top, width, height, n });
  const out = W.stackMarks([m(0.1, 0.1, 0.2, 0.05, 2), m(0.1, 0.1, 0.2, 0.05, 1), m(0.6, 0.6, 0.1, 0.1, 3)]);
  assert.deepEqual(out.map(x => x.label), ['1 2', null, '3']);
  assert.deepEqual(out[1].ns, [1, 2], 'the box drawn without a number still knows its numbers (to mark it when focused)');
  // IoU just under a half: two markers
  assert.deepEqual(W.stackMarks([m(0, 0, 0.2, 0.2, 1), m(0.07, 0, 0.2, 0.2, 2)]).map(x => x.label), ['1', '2']);
  assert.ok(W.iou(m(0, 0, 0.2, 0.2), m(0.06, 0, 0.2, 0.2)) >= 0.5);
  assert.deepEqual(W.stackMarks([m(0, 0, 0.2, 0.2, 1), m(0.06, 0, 0.2, 0.2, 2)]).map(x => x.label), ['1 2', null]);
  // the first view: one view high, taller when a box sits lower, never past the image
  const img = { w: 1280, h: 2000, dpr: 1, vh: 800 };
  assert.equal(W.shotGeometry(img, [], { first: true }).ch, 800);
  assert.equal(W.shotGeometry(img, [{ box: [40, 900, 120, 32] }], { first: true }).ch, 900 + 32 + W.CONTEXT_PX);
  assert.equal(W.shotGeometry(img, [{ box: [40, 1900, 120, 32] }], { first: true }).ch, 2000);
});

test('markers (review of PR #35): a small element inside another, 1 px from its corner, stacks once the numbers would touch on screen; far apart, never', () => {
  const img = { w: 390 * 2, h: 2000 * 2, dpr: 2, vh: 844 * 2 };
  const g = W.shotGeometry(img, [{ box: [16, 700, 100, 32], n: 1 }, { box: [17, 701, 8, 8], n: 3 }, { box: [200, 1500, 50, 20], n: 4 }], { first: true });
  assert.deepEqual(W.stackMarks(g.marks).map(m => m.label), ['1', '3', '4'], 'IoU alone: the 8×8 box is not half of the link');
  // shown 300 px wide: a marker is about 8% of the width
  const near = { x: W.MARKER_PX / 300, y: W.MARKER_PX / (300 * g.ch / img.w) };
  assert.deepEqual(W.stackMarks(g.marks, { near }).map(m => [m.label, m.ns]), [['1 3', [1, 3]], [null, [1, 3]], ['4', [4]]]);
  assert.equal(W.COVERAGE.gap.incomplete(2), '2 AI cells not checked: the AI’s answer was incomplete');
});
