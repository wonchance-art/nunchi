// What the board's page and the engine share (design 0.1-c §3.4): the one strings table, the keys, the screenshot
// geometry and the decision-time clock. Pure: no Node and no DOM, so the same file is imported by the engine
// (export --html, the board server, `nunchi trust`) and served to the board's page as /assets/shared.mjs.

// ---- words (design §3.4 "Words"): one table, so a Korean toggle is cheap later ------------------------------

export const SEV = { blocker: 0, high: 1, medium: 2, low: 3 };
export const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
export const SEV_LABEL = { blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low' };
export const STATUS_LABEL = { open: 'Open', regressed: 'Came back', 'to-fix': 'To fix', held: 'Later', kept: 'Kept', dismissed: 'Not a problem', fixed: 'Fixed' };
// the board also shows these (the ledger computes them; the static export has no use for them)
export const MORE_STATUS = { stale: 'Stale', mixed: 'Mixed', 'needs-you': 'Needs you' };
export const FILTERS = [['open', 'Open'], ['to-fix', 'To fix'], ['held', 'Later'], ['kept', 'Kept'], ['dismissed', 'Not a problem'], ['fixed', 'Fixed'], ['all', 'All']];
export const WHO = { guest: 'Visitor', 'signed-in': 'Signed in' };
export const WIDTH = { d: 'Desktop', m: 'Phone' };
export const STATES = ['normal', 'empty', 'error', 'slow', 'offline'];
export const STATE_LABEL = { normal: 'Normal', empty: 'Empty', error: 'Error', slow: 'Slow', offline: 'Offline' };
export const PERSONS = ['guest', 'signed-in'];
export const VPS = ['d', 'm'];
export const CONTEXT_PX = 200;                            // design §3.4: the box plus about 200 px of context

// CLI and spec word → board word (design §3.4). `decide` accepts the board's `not-a-problem` and `later` too.
export const WORDS = {
  fix: 'Fix', 'to-fix': 'To fix', keep: 'Keep', kept: 'Kept', 'false-positive': 'Not a problem', dismissed: 'Not a problem',
  hold: 'Later', held: 'Later', 'needs-human': 'Needs you', 'caused-regression': 'Broke something else — undone',
  'not-seen-budget': 'Not checked: AI budget ran out', 'tree-differs': 'Screens are from before your latest edits: tell your AI “capture again”',
  reopen: 'Reopened',
  // design §5: a kind with ≥ 5 open places and a built-in guard nobody added (a passive chip)
  'guard-available': 'guard available',
  // a verification whose run had fewer decoys than its claims called for: not suspect, and no double-check (verify.mjs)
  'too-few-decoys': 'too few decoys to check the checker',
};
// The fix loop on the board (design §3.4 "Fix states on the board"): the three *needs you* kinds with their actions,
// before/after, and the sentence that undoes a fix that landed (the AI's `fix --undo`).
export const FIX_WORDS = {
  a: share => `The fix also changed other parts of this screen (${share}). Is that OK?`,
  b: 'The AI couldn’t fix this in 2 tries.',
  c: 'Couldn’t re-check: the screen didn’t load.',
  cThen: 'Start your app, then tell your AI “retry”.',
  looksFine: 'Looks fine, mark fixed', undo: 'Undo this fix', tryAgain: 'Try again with a note…', keep: 'Keep', later: 'Later',
  note: 'A note for your AI (what to do differently)', send: 'Try again',
  before: 'Before', after: 'After', slider: 'Before and after', width: 'Before/after width', needs: 'Needs you',
  undoSay: (title, id) => `undo the fix of “${title}” (nunchi fix --undo ${id})`,
  landed: commit => `Fixed by your AI in commit ${commit}. To undo it, tell your AI:`,
  // the other kinds (owner-approved mock-ups): paths, routes and commits come from the record, as data
  diff: 'The fix changed files only you can approve:',
  copyPath: 'Copy path',
  unbaselined: (routes, n) => `The fix also reaches ${routes}, which had no screenshot${n === 1 ? '' : 's'} before.`,
  nowShows: titles => `It now shows ${titles}.`,
  interrupted: commit => `This fix (commit ${commit}) wasn’t re-checked.`,
  interruptedThen: 'Tell your AI “retry” to check it, or “undo it”.',
  revert: (commit, reason) => `nunchi couldn’t undo this fix (commit ${commit}): ${reason}.`,
  revertThen: 'Undo it yourself:',
  revertSay: commit => `git revert ${commit}`,
  other: 'nunchi couldn’t finish this fix on its own.',
  // why a revert could not run (the record's `reason`, a key)
  revertWhy: {
    signing: () => 'your repository requires signed commits, and signing failed',
    'not-head': () => 'it is no longer the last commit',
    'in-progress': () => 'another git operation (a merge, rebase or revert) was in progress',
    'half-done': () => 'it was no longer the last commit, or an undo was left half done',
    dirty: paths => `you had changes that were not committed${paths ? ` (${paths})` : ''}`,
    occupied: paths => `undoing it would overwrite files git does not show as changed${paths ? ` (${paths})` : ''}`,
    'wrong-branch': (paths, branch) => `you were not on its branch${branch ? `, ${branch}` : ''}`,
    failed: () => 'git could not apply the undo',
  },
  // [Undo this fix] refused (the same safe revert as the AI's fix --undo): said on the card
  undoRefused: {
    'not-head': commit => `Not undone: this fix (commit ${commit}) is no longer the last commit, and nunchi undoes only its own last commit. Undo it yourself with git revert ${commit}.`,
    'wrong-branch': (commit, { branch, on }) => `Not undone: you are ${on ? `on ${on}` : 'on a detached HEAD'}, not on the fix branch ${branch}. Switch back to it, then press Undo this fix again.`,
    dirty: (commit, { paths }) => `Not undone: you have changes that are not committed (${paths}). Commit or stash them, then press Undo this fix again.`,
    occupied: (commit, { paths }) => `Not undone: undoing it would overwrite or remove files git does not show as changed (${paths}). Move them somewhere safe, then press Undo this fix again.`,
    filtered: commit => `Not undone: this repository runs files through git filters (Git LFS or similar), so nunchi does not undo here. Undo it yourself with git revert ${commit}.`,
  },
  undone: 'Undone: it is to fix again',
  // the short label of each kind (the history rows)
  short: {
    a: 'the fix also changed other parts of the screen', b: 'the AI couldn’t fix this in 2 tries', c: 'couldn’t re-check',
    diff: 'changed files only you can approve', unbaselined: 'reaches a screen with no screenshot before', interrupted: 'wasn’t re-checked',
    revert: 'nunchi couldn’t undo it', other: 'nunchi couldn’t finish it',
  },
  // Detail history: one row per attempt, newest first
  attemptsH: 'Fix attempts',
  attempt: n => `Attempt ${n}`,
  outcome: {
    fixed: 'Fixed', undone: 'Undone at your request', 'caused-regression': 'Broke something else — undone', 'not-fixed': 'Didn’t remove it — undone',
    'try-again': 'Undone to try again with your note', cancelled: 'Stopped: you decided otherwise', aborted: 'Stopped before a commit',
  },
  needsRow: kind => `Needs you — ${FIX_SHORT[kind] || FIX_SHORT.other}`,
  revertedIn: 'reverted in',
  copyCommit: commit => `Copy commit ${commit}`,
};
const FIX_SHORT = FIX_WORDS.short;
// Up to five, then "and N more" (paths and routes on a card).
export const listText = (items, max = 5) => `${items.slice(0, max).join(', ')}${items.length > max ? ` and ${items.length - max} more` : ''}`;
// "Claude Code is fixing · 4 min" (design §3.4), "just started" under a minute.
export const fixingMinutes = minutes => (minutes === null || minutes === undefined ? 'just started' : minutes < 1 ? 'just started' : `${minutes} min`);
export const fixingText = c => `${c.agent} is fixing · ${fixingMinutes(c.minutes)}`;
export const pctText = share => `${Math.max(1, Math.round((Number(share) || 0) * 100))}%`;
export const REASON_LABEL = { intended: 'intended', 'out-of-scope': 'out of scope', 'not-a-problem': 'nothing wrong here', 'wrong-place': 'right issue, wrong spot' };
// The decision bar's buttons: label and permanent sub-label (design §3.4).
export const DECISION_BUTTONS = [
  { decision: 'fix', reason: null, key: 'F', label: 'Fix', sub: 'Let the AI fix it' },
  { decision: 'keep', reason: 'intended', key: 'W', label: 'Keep', sub: 'Real, but leave it' },
  { decision: 'false-positive', reason: 'not-a-problem', key: 'X', label: 'Not a problem', sub: 'nunchi got it wrong' },
  { decision: 'hold', reason: null, key: 'S', label: 'Later', sub: 'Still counts for shipping' },
];
// Keys (design §3.4): one key, one decision, always with an explicit reason.
export const DECISION_KEYS = {
  f: { decision: 'fix', reason: null },
  w: { decision: 'keep', reason: 'intended' },
  W: { decision: 'keep', reason: 'out-of-scope' },
  x: { decision: 'false-positive', reason: 'not-a-problem' },
  X: { decision: 'false-positive', reason: 'wrong-place' },
  s: { decision: 'hold', reason: null },
};
// The key a person pressed, by its place on the keyboard (`code`) and Shift, so a shortcut is the same on every layout
// (a Korean layout sends key "ㄹ" for F) and with Caps Lock on ("W" without Shift is still w). `?` and `/` are
// characters wherever a layout puts them: those, and keys with no letter, digit or bracket place (arrows, Enter, Esc,
// Home, End), come from `key`.
export function keyOf(e) {
  const code = typeof e?.code === 'string' ? e.code : '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return e.shiftKey ? letter[1] : letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit && !e.shiftKey) return digit[1];
  if (!e.shiftKey && code === 'BracketLeft') return '[';
  if (!e.shiftKey && code === 'BracketRight') return ']';
  if (code === 'Space') return ' ';
  return typeof e?.key === 'string' ? e.key : '';
}
// The other reason the undo toast offers.
export const OTHER_REASON = { intended: 'out-of-scope', 'out-of-scope': 'intended', 'not-a-problem': 'wrong-place', 'wrong-place': 'not-a-problem' };
// What a decision is called after it was made ("Kept (intended)").
export function decidedText(decision, reason) {
  const d = { fix: 'To fix', keep: 'Kept', 'false-positive': 'Not a problem', hold: 'Later', reopen: 'Reopened' }[decision] || decision;
  return reason && REASON_LABEL[reason] ? `${d} (${REASON_LABEL[reason]})` : d;
}
// Every key the board answers, for the help dialog (design §3.4 accessibility: `?` shows help).
export const KEY_HELP = [
  ['J / ↓', 'Next finding'], ['K / ↑', 'Previous finding'], ['Enter', 'Open the finding'], ['Esc', 'Back to the list (and hides the undo toast)'],
  ['F', 'Fix'], ['W', 'Keep: intended'], ['Shift+W', 'Keep: out of scope'], ['X', 'Not a problem: nothing wrong here'],
  ['Shift+X', 'Not a problem: right issue, wrong spot'], ['S', 'Later'], ['Z', 'Undo the last decision or batch'],
  ['Space', 'Select the row'], ['Shift+J / Shift+K', 'Extend the selection'], ['R', 'Show the updated list'],
  ['0', 'Whole screen (finding)'], ['[ / ]', 'Other screens it was seen on'], ['/', 'Search'], ['?', 'This help'],
];
// Views that are built; the rest are listed with the CLI command that shows the same data (design §3.4 views).
export const MORE_VIEWS = [
  ['Coverage map', 'nunchi findings --all'], ['Design system', 'nunchi tokens'], ['States & messages', 'nunchi inventory'],
  ['Copy groups', 'nunchi inventory --json'], ['AI trust', 'nunchi trust'], ['Guards', 'nunchi guard'],
];
// The guard card's words (design §5, the owner's, 2026-10-15 KST). Backticks mark code. `added`: n hits there now
// became the baseline of what was added; `takenBack`: the row's label (code already); `unreadable`: guards.json as the
// repository names it, and why it cannot be read — the same line on the card, in `fix --summary` and `nunchi guard`.
export const GUARD_WORDS = {
  added: n => (n > 0 ? `Added · the ${n === 1 ? '1 already in your code is its' : `${n} already in your code are its`} baseline; a new one fails \`nunchi check\`. Commit \`.nunchi/guards.json\`.`
    : 'Added · none in your code now.'),
  takenBack: label => `Taken back · ${label} isn't guarded.`,
  unreadable: (name, reason) => `Can't read \`${name}\`: ${reason}. Guards can't be added until it's fixed — \`git checkout -- .nunchi/guards.json\` restores the committed one.`,
};
export const LABELS = { 1: 'correct', 2: 'wrong', 3: 'unsure' };
export const LABEL_WORDS = { correct: 'Correct: a real defect', wrong: 'Wrong: not a defect', unsure: 'Unsure' };

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const human = rule => { const r = String(rule).replace(/^L\d+\./, '').replace(/-/g, ' '); return r.charAt(0).toUpperCase() + r.slice(1); };
export const sceneLabelText = s => `${WHO[s.person] || s.person} · ${WIDTH[s.viewport] || s.viewport} · ${STATE_LABEL[s.state] || s.state}`;

// ---- screenshot geometry (shared by the static export's markup and the board's DOM) -----------------------------

// Where a box can be drawn: an element box, not in a scroll area the image cannot show, inside the image.
// `img`: { w, h, dpr } of the screenshot.
export function drawable(f, img) {
  if (!img) return { ok: false, why: 'no screenshot' };
  if (!Array.isArray(f.box)) return { ok: false, why: 'no element box' };
  if (f.inside) return { ok: false, why: 'inside a scroll area, not in the image' };
  const [x, y, w, h] = f.box.map(v => v * img.dpr);
  if (!(w > 0 && h > 0)) return { ok: false, why: 'hidden element' };
  if (x >= img.w || y >= img.h || x + w <= 0 || y + h > img.h + 1) return { ok: false, why: 'outside the screenshot' };
  return { ok: true };
}

// A screenshot region: with `crop`, the boxes plus CONTEXT_PX of context (at least one first view high), else the
// whole image. → { cy, ch, posY, marks: [{ left, top, width, height, n }] }, fractions of the region (0–1).
// `boxes` are [{ box: [x, y, w, h] in CSS px, n? }]; `img` is { w, h, dpr, vh } in image pixels.
export function shotGeometry(img, boxes = [], { crop = false } = {}) {
  const px = boxes.map(b => ({ ...b, x: b.box[0] * img.dpr, y: b.box[1] * img.dpr, w: b.box[2] * img.dpr, h: b.box[3] * img.dpr }));
  let cy = 0, ch = img.h;
  if (crop && px.length) {
    const ctx = CONTEXT_PX * img.dpr;
    let top = Math.max(0, Math.min(...px.map(b => b.y)) - ctx), bottom = Math.min(img.h, Math.max(...px.map(b => b.y + b.h)) + ctx);
    const want = Math.min(img.h, img.vh);
    if (bottom - top < want) { bottom = Math.min(img.h, top + want); top = Math.max(0, bottom - want); }
    cy = Math.round(top); ch = Math.max(1, Math.round(bottom - top));
  }
  const posY = ch >= img.h ? 0 : cy / (img.h - ch);
  const marks = px.map(b => ({ left: b.x / img.w, top: (b.y - cy) / ch, width: b.w / img.w, height: b.h / ch, n: b.n || null }));
  return { cy, ch, posY, marks };
}
// Percentages as the export writes them (two decimals).
export const pct = n => `${Math.round(n * 10000) / 100}%`;

// A decision's time as the person reads it while recent: whole minutes and hours, rounded down (59.5 minutes is
// "59 min ago", never "60 min ago"); "just now" within a minute either way (clocks differ a little). → null when it
// is a day or more away (the page shows the local time then) or no time at all.
export function relativeTime(at, now) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const s = Math.floor((now - t) / 1000);
  if (s < -60 || s >= 86400) return null;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// ---- decision time (design §3.5) --------------------------------------------------------------------------------

// The time from showing a group to its first key: paused while the tab is hidden and after IDLE_MS without input,
// capped at CAP_MS. Pure: the caller passes the clock's readings (performance.now() on the page), so a test can
// drive it with a fake clock.
export const IDLE_MS = 30000;
export const CAP_MS = 120000;
export class DecisionClock {
  constructor() { this.reset(null, 0); }
  // a group is shown (a row focused, a detail opened): the clock starts from zero
  reset(id, now) { this.id = id; this.spent = 0; this.since = now; this.last = now; this.hidden = false; }
  // what has counted so far: running time up to `now`, never past IDLE_MS after the last input, never while hidden
  settle(now) {
    if (this.since === null) return;
    const until = Math.min(now, this.last + IDLE_MS);
    if (!this.hidden && until > this.since) this.spent += until - this.since;
    this.since = now;
  }
  input(now) { this.settle(now); this.last = now; if (!this.hidden) this.since = now; }
  hide(now) { this.settle(now); this.hidden = true; }
  show(now) { this.settle(now); this.hidden = false; this.last = now; this.since = now; }
  // the reading at the first key, in whole milliseconds, capped
  read(now) { this.settle(now); return Math.min(CAP_MS, Math.round(this.spent)); }
}
