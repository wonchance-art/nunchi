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
// The keys of the Screens and Coverage views (M7 mock-up §3.6, §4.5), their own sections of the help dialog.
export const KEY_HELP_SCREENS = [
  ['J / K', 'Next / previous screen'], ['← → ↑ ↓', 'Card to card (the wall)'], ['Space', 'Quick look (the wall)'], ['Enter', 'Open the screen; on a screen, the finding'],
  ['/', 'Search (the wall)'], ['V', 'Desktop or phone'], ['B', 'Both widths'], ['[ / ]', 'Other states of this page'], ['0', 'Whole screen'],
  ['C', 'Compare'], ['1–9', 'Finding n'], ['Esc', 'Back to all screens'],
];
export const KEY_HELP_COVERAGE = [
  ['← → ↑ ↓', 'Cell to cell'], ['Home / End', 'First / last cell of the row'], ['Ctrl+Home / Ctrl+End', 'First / last cell of the map'],
  ['J / K', 'Next / previous cell with a gap'], ['Enter / Space', 'What was looked at there'], ['Esc', 'Close it, back to the cell'],
];
// Views that are built; the rest are listed with the CLI command that shows the same data (design §3.4 views).
export const MORE_VIEWS = [
  ['Design system', 'nunchi tokens'], ['States & messages', 'nunchi inventory'],
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

// ---- Coverage and Screens beyond the wall (M7: the mock-up the owner approved on 2026-10-15 KST, §5) --------------

// A lens as the board names it: "L6 Copy quality" (the pack's name without its note in brackets). Lenses judged by the
// engine alone have no pack: their names are the spec's (§3).
export const LENS_NAMES = { L1: 'Broken', L2: 'States', L3: 'Flow', L4: 'Visual consistency', L5: 'Copy consistency', L6: 'Copy quality', L7: 'Vibe-coding leftovers', L8: 'Accessibility', L9: 'Safety', L10: 'Parity' };
export const lensNumber = id => { const m = /^L(\d+)$/.exec(String(id)); return m ? Number(m[1]) : 1e9; };
export const lensLabel = (id, packName = null) => `${id} ${(typeof packName === 'string' && packName.trim() ? packName.replace(/\s*\([^)]*\)\s*$/, '') : LENS_NAMES[id]) || ''}`.trim();
// Thousands with a comma, the same on every machine (no locale).
export const thousands = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// "Normal and Error", "a, b and c"
export const andList = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// The marks of the coverage map: a shape and a word, never colour alone (design §3.4 accessibility).
export const MARKS = {
  full: { sym: '●', word: 'Looked at fully' }, partly: { sym: '◐', word: 'Partly' }, rules: { sym: '○', word: 'Rules only' },
  not: { sym: '✕', word: 'Not checked' }, none: { sym: '·', word: 'Not captured here' }, ok: { sym: '✓', word: 'Checked' },
};
export const MARK_ORDER = ['full', 'partly', 'rules', 'not', 'none', 'ok'];
const NOT_CHECKED = 'Not checked: ';
// A route inside a sentence to copy is the app's data: control characters and quotes are dropped (they could end the
// quoted sentence or start another line) and it is put in backticks, so it reads as an address, never as words to obey.
export const routeInSay = route => `\`${String(route ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/["'`\u2018\u2019\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim()}\``;
const routesInSay = routes => listText((Array.isArray(routes) ? routes : [routes]).map(routeInSay), 5);
export const COVERAGE = {
  nav: 'Coverage', title: 'Coverage',
  sub: (run, full) => `What nunchi looked at in run ${run}${full ? ' (full check)' : ''}, and what it didn’t`,
  screensChecked: 'Screens checked', aiLooked: 'AI looked at', pagesOpened: 'Pages opened', wholeApp: 'Whole-app checks', aiReview: 'AI review',
  ofCells: (n, m) => `${n} of ${m} cells on checked screens`,
  of: (n, m) => `${n} of ${m}`,
  notCheckedN: n => `${n} not checked`, notN: n => `${n} not`,
  wholeRan: 'Ran over the whole app: links, one-off styles, secrets in the bundle',
  wholeNot: why => `Not a full check: ${why}. Whole-app checks can’t mark anything fixed.`,
  gapsH: 'What wasn’t checked', gapsMore: ', and what to do', usuallyFine: 'Usually fine', nothingMissing: 'Everything in this run’s scope was looked at.',
  mapH: 'Map', noGapPages: 'No page has a gap.',
  checksRules: 'Rule checks', checksAll: 'Rules + every AI lens', checksLens: label => `AI: ${label}`,
  showAll: 'All pages', showGaps: 'Gaps only', state: 'State', checks: 'Checks', show: 'Show', page: 'Page', otherStates: 'Other states',
  footnote: '“6 of 7”: AI lenses that looked at this screen, of those that apply to it. ● ◐ ○ all mean the rule checks ran. Other states: empty, error, slow and offline screens of the page, counted by mark.',
  showing: (n, gaps) => (gaps ? `Showing ${plural(n, 'page')} with gaps` : `Showing ${plural(n, 'page')}`),
  // why a screen or an AI cell was not looked at (§5): the board's words for the engine's reasons
  reason: {
    budget: WORDS['not-seen-budget'], 'not-answered': 'Not checked: the AI didn’t answer', incomplete: 'Not checked: the AI’s answer was incomplete',
    'canary-missed': 'Doesn’t count: the AI missed a test defect nunchi planted',
    // a loaded AI lens that applies to the screen but was not in the hunt (`hunt --lens`): the "— not in this hunt" words
    'not-hunted': 'Not checked: not in this hunt',
    redirected: path => `${NOT_CHECKED}sent to ${path}`, 'redirected-off-origin': origin => `${NOT_CHECKED}left the app (${origin})`,
    'no-dom': 'Not checked: the screen didn’t load', 'browser-error-page': 'Not checked: the browser showed an error page',
    'redirect-loop': 'Not checked: redirect loop', 'login-expired': 'Not checked: the saved login no longer worked',
    other: reason => `${NOT_CHECKED}capture failed (${reason})`,
  },
  // the reason as a map cell says it: the words after "Not checked: " ("✕ sent to /login")
  short: text => (String(text).startsWith(NOT_CHECKED) ? String(text).slice(NOT_CHECKED.length) : String(text)),
  noForced: 'Not captured: nunchi forces empty, error, slow and offline only where the page loads data',
  lensNA: 'Doesn’t apply here', looked: 'Looked', none: 'none',
  aiNotRun: run => `AI review hasn’t run on run ${run}`, aiOlder: run => `AI review: run ${run} (not this run)`,
  aiOlderMore: run => `Its cells are shown for run ${run}’s screens.`, changedSinceAi: 'changed since the AI looked',
  aiUnreadable: run => `The AI review’s record of run ${run} couldn’t be read (coverage.json): AI columns show nothing.`,
  lensSubset: lenses => `This hunt covered ${lenses} only`,
  needsSample: 'Not opened: needs a sample address', unresolved: 'Not opened: nunchi couldn’t work out its address from the code',
  notLooked: (n, run) => `${n} open finding${n === 1 ? '' : 's'} can’t be marked fixed: not looked at since run ${run}`,
  budgetMore: (lenses, tokens) => `The budget goes to the worst defects first; ${andList(lenses)} ${lenses.length === 1 ? 'comes' : 'come'} last. The rest needs about ${tokens} more tokens.`,
  aiLine: (run, lenses, budget, byDefault) => `run ${run} · ${plural(lenses, 'lens', 'lenses')}${budget === null ? ' · no token budget' : ` · budget ${thousands(budget)} tokens${byDefault ? ' (the default)' : ''}`}`,
  // "Tell your AI “…”" (the board's pattern, as "fix them" and "retry")
  tell: say => `Tell your AI “${say}”`,
  startThen: 'Start your app, then tell your AI “capture again”',
  loginThen: 'Run nunchi login in your own terminal, then tell your AI “capture again”',
  say: {
    again: 'capture again', hunt: (lens, route) => `hunt ${lens} on ${routeInSay(route)} again`, budget: 'review what the AI budget skipped', finish: 'finish the AI review',
    run: 'run the AI review', every: 'run the AI review with every lens', sample: routes => `find a sample address for ${routesInSay(routes)}, then capture again`,
    routeToo: routes => `capture ${routesInSay(routes)} too`, states: 'capture again with every state', record: 'record the app’s data again',
  },
  copy: say => `Copy “${say}”`, showOnMap: 'Show on map', showShort: 'Show', openScreen: 'Open this screen', openFinding: 'Open finding', clear: 'Clear filters',
  byLens: 'By lens', ruleChecks: 'Rule checks', aiCol: 'AI review (cells on checked screens)', rulesOnly: '— rules only', aiOnly: '— AI only', whole: 'Whole app',
  notInHunt: '— not in this hunt',
  // the gap rows (§3.3): count + kind, where, why
  gap: {
    problem: { 'login-expired': 'The saved login no longer worked: signed-in screens showed the sign-in page and weren’t checked', 'app-unreachable': 'Most screens didn’t load at all', 'recording-stale': 'Most screens asked for data the recording doesn’t have' },
    notLoaded: (n, why) => `${plural(n, 'screen')} didn’t load${why ? `: ${why}` : ''}`,
    canary: n => `${plural(n, 'AI cell')} ${n === 1 ? 'doesn’t' : 'don’t'} count: the AI missed a test defect nunchi planted`,
    budget: n => `${plural(n, 'AI cell')} not checked: AI budget ran out`,
    notAnswered: n => `${plural(n, 'AI cell')} not answered`,
    incomplete: n => `${plural(n, 'AI cell')} not checked: the AI’s answer was incomplete`,
    pages: (n, routes, why) => `${plural(n, 'page')} not opened: ${routes} — ${why}`,
    needsSampleWhy: 'needs a sample address. Until it has one, no run is a full check.',
    unresolvedWhy: 'nunchi couldn’t work out its address from the code',
    redirects: n => `${plural(n, 'screen')} ${n === 1 ? 'was' : 'were'} sent to another page, so ${n === 1 ? 'it is' : 'they are'} judged as that page`,
    offOrigin: (n, origins) => `${plural(n, 'screen')} left the app (${origins})`,
    states: list => `Captured with ${list} only`,
    noLogin: 'Signed-in screens: not captured (no saved login)',
    loginHint: 'If parts of your app need a login, run this in your own terminal:', loginCmd: 'nunchi login --url <your app> --path /login',
    wasOn: (title, where) => `“${title}” was on ${where}, which hasn’t loaded since.`,
    pagesWhere: n => `${n} pages, see map`,
  },
  // the selected cell's panel (§3.2)
  ranIn: run => `Ran in run ${run}`, lensesLooked: (n, m) => `${n} of ${m} lenses looked`, openHere: 'Open here', tellAi: 'Tell your AI',
  judgedAs: path => `The screen is judged as ${path}, in its own row.`, close: 'Close',
  lookedText: (findings, cannot) => ['Looked', findings ? plural(findings, 'finding') : null, cannot ? `couldn’t judge ${plural(cannot, 'question')}` : null, !findings && !cannot ? 'nothing found' : null].filter(Boolean).join(' · '),
  // states of the view (§3.5)
  loading: 'Loading coverage…', noRun: 'Nothing captured yet. Tell your AI “capture my app”.',
  running: (line, shown) => `${line}. This shows run ${shown} until it finishes.`,
  quick: n => `First look: ${plural(n, 'key screen')}, rule checks only · the full check isn’t done yet`,
  prev: 'This is the first cell with a gap', next: 'This is the last cell with a gap',
};
// Why a scene was not checked, in the board's words. `s`: a scene as the board's model has it.
export function notCheckedText(s) {
  const R = COVERAGE.reason;
  if (s.reason === 'redirected-off-origin') return R['redirected-off-origin'](s.finalOrigin || 'another site');
  if (s.status === 'captured' && s.redirected) return R.redirected(s.finalPath || '?');
  const k = String(s.reason || s.status || '');
  return typeof R[k] === 'string' && !['budget', 'not-answered', 'incomplete', 'canary-missed', 'not-hunted'].includes(k) ? R[k] : R.other(k || 'unknown');
}
// An AI cell's reason in the board's words.
export const aiReasonText = reason => (typeof COVERAGE.reason[reason] === 'string' ? COVERAGE.reason[reason] : COVERAGE.reason.other(reason || 'unknown'));

// A map cell's mark under the Checks filter (§3.2): `cell` as /api/coverage gives it ({ checked, why, ai }), or null
// when there is no screen there; `checks`: 'all' (rules + every AI lens), 'rules', or a lens id. → { kind, text, gap }
// (a gap is anything but ● and ·; ✓ is no gap).
export function coverageMark(cell, checks = 'all') {
  const out = (kind, text) => ({ kind, text, gap: !['full', 'none', 'ok'].includes(kind) });
  if (!cell) return out('none', checks === 'all' || checks === 'rules' ? COVERAGE.none : COVERAGE.lensNA);
  if (!cell.checked) return out('not', checks !== 'all' && checks !== 'rules' ? cell.why : COVERAGE.short(cell.why));
  if (checks === 'rules') return out('ok', MARKS.ok.word);
  const ai = cell.ai;
  if (checks !== 'all') {
    if (!ai) return out('rules', MARKS.rules.word);
    const l = ai.lenses.find(x => x.lens === checks);
    if (!l) return out('none', COVERAGE.lensNA);
    return l.status === 'seen' ? out('full', COVERAGE.looked) : out('not', aiReasonText(l.reason));
  }
  if (!ai || !ai.of) return out('rules', MARKS.rules.word);
  if (ai.seen === ai.of) return out('full', COVERAGE.of(ai.seen, ai.of));
  if (ai.seen === 0) return out('rules', COVERAGE.of(ai.seen, ai.of));
  return out('partly', COVERAGE.of(ai.seen, ai.of));
}
// Marks counted ("● 6 · ✕ 2"), in the legend's order; "· none" when there is nothing.
export const markParts = marks => { const n = {}; for (const m of marks) n[m.kind] = (n[m.kind] || 0) + 1; return MARK_ORDER.filter(k => n[k]).map(k => ({ kind: k, sym: MARKS[k].sym, n: n[k] })); };
export function markCounts(marks) {
  const parts = markParts(marks).map(p => `${p.sym} ${p.n}`);
  return parts.length ? parts.join(' · ') : `${MARKS.none.sym} ${COVERAGE.none}`;
}
// A cell's accessible name: the whole sentence ("/cart, Signed in, Desktop, Normal: partly. AI 6 of 7. L6 doesn’t
// count: the AI missed a test defect nunchi planted."); the marks themselves are hidden from assistive technology.
export function cellName(route, where, cell, checks = 'all') {
  const m = coverageMark(cell, checks);
  const head = `${route}, ${where}: ${(m.kind === 'not' ? m.text : m.kind === 'none' ? (cell ? COVERAGE.lensNA : MARKS.none.word) : MARKS[m.kind].word).replace(/^./, c => c.toLowerCase())}.`;
  if (!cell || !cell.checked || checks === 'rules') return head;
  const ai = cell.ai;
  if (!ai) return `${head} ${MARKS.rules.word}.`;
  if (checks !== 'all') return head;
  const missed = ai.lenses.filter(l => l.status !== 'seen').map(l => `${l.lens} ${aiReasonText(l.reason).replace(/^./, c => c.toLowerCase())}.`);
  return [head, `AI ${COVERAGE.of(ai.seen, ai.of)}.`, ...missed].join(' ');
}

export const SCREENS = {
  show: 'Show', all: 'All', open: 'Open findings', not: 'Not checked', changed: run => `Changed since run ${run}`, shown: (n, m) => `${n} shown of ${m}`,
  pages: 'Pages', search: 'Search', searchHint: 'Page or route', noMatch: 'No screen matches these filters.',
  ai: (n, m) => `AI ${n} of ${m}`, rulesOnly: 'Rules only', aiBudget: 'AI not checked: budget', changedWord: 'Changed',
  allScreens: 'All screens', findingsH: n => `Findings on this screen (${n})`, sameNumber: 'Same defect, same number on both widths.',
  fixedHere: (run, n) => `Fixed here since run ${run} (${n})`, fixedIn: (title, run) => `${title} · fixed in run ${run}`,
  samePage: n => `Same page, ${plural(n, 'other screen')}`, both: 'Both', compare: 'Compare', off: 'Off', view: 'View',
  runLast: run => `Run ${run} (last full check)`, fixOf: (title, n) => `Fix of “${title}”, attempt ${n}`, sideBySide: 'Side by side', slider: 'Slider',
  unchanged: run => `Unchanged since run ${run} (same pixels and text)`, changedPx: run => `Changed since run ${run}: pixels and text differ.`,
  notIn: run => `Not captured in run ${run}`, gcd: 'The screens of this fix were removed (nunchi gc)', gone: run => `This screen isn’t in run ${run}.`,
  back: 'Back to all screens', before: run => `Before: run ${run}`, after: run => `After: run ${run}`, afterUndone: n => `After (attempt ${n}, undone)`,
  ruleChecks: ok => `Rule checks ${ok ? '✓' : '✕'}`, aiLenses: (n, m, notes) => `AI ${n} of ${m} lenses${notes ? ` (${notes})` : ''}`, rulesOnlyAi: 'AI: rules only',
  doesntCount: lens => `${lens} doesn’t count`, notChecked: lens => `${lens} not checked`, changedSince: run => `Changed since run ${run}`,
  coverageLink: 'Coverage ▸', coverageHere: 'Coverage on this screen ▸', prev: 'Previous (K)', next: 'Next (J)',
  position: (i, n, filters) => `${i} of ${n} shown${filters ? ` (${filters})` : ''}`, alsoOn: n => `also on ${plural(n, 'other screen')}`,
  onlyOn: vp => `${WIDTH[vp] || vp} only`, judged: (why, path) => `${why}. It is judged as ${path}.`, openRoute: path => `Open ${path}`,
  nothing: 'Nothing found on this screen.', notOutlined: why => `Not outlined: ${why}`, whole: 'Whole screen', firstView: 'First view',
  first: 'This is the first screen', last: 'This is the last screen', loading: 'Loading screens…',
  said: (name, label, badge, i, n) => `${name}, ${label}: ${badge}. ${i} of ${n}.`,
  firstLook: 'First look', notYet: 'Not checked yet',   // during a first look (M5b): its key screens, and the others
};

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
export function shotGeometry(img, boxes = [], { crop = false, first = false } = {}) {
  const px = boxes.map(b => ({ ...b, x: b.box[0] * img.dpr, y: b.box[1] * img.dpr, w: b.box[2] * img.dpr, h: b.box[3] * img.dpr }));
  let cy = 0, ch = img.h;
  if (crop && px.length) {
    const ctx = CONTEXT_PX * img.dpr;
    let top = Math.max(0, Math.min(...px.map(b => b.y)) - ctx), bottom = Math.min(img.h, Math.max(...px.map(b => b.y + b.h)) + ctx);
    const want = Math.min(img.h, img.vh);
    if (bottom - top < want) { bottom = Math.min(img.h, top + want); top = Math.max(0, bottom - want); }
    cy = Math.round(top); ch = Math.max(1, Math.round(bottom - top));
  }
  // `first`: the first view, taller when a box sits lower, so every box shows (the Screen detail's default, M7)
  if (first) {
    const ctx = CONTEXT_PX * img.dpr;
    cy = 0; ch = Math.max(1, Math.round(Math.min(img.h, Math.max(Math.min(img.h, img.vh), ...px.filter(b => b.y < img.h).map(b => b.y + b.h + ctx)))));
  }
  const posY = ch >= img.h ? 0 : cy / (img.h - ch);
  const marks = px.map(b => ({ left: b.x / img.w, top: (b.y - cy) / ch, width: b.w / img.w, height: b.h / ch, n: b.n || null }));
  return { cy, ch, posY, marks };
}
// Markers of boxes that overlap by IoU 0.5 or more are one stacked marker ("1 2"), so no number hides another (M7
// mock-up §0.1). `marks` as shotGeometry gives them (fractions of one region, so IoU is the same as in pixels). →
// the marks with `label` (the numbers that marker says, or null when another marker says them) and `ns`.
export const iou = (a, b) => {
  const x = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  const i = x * y, u = a.width * a.height + b.width * b.height - i;
  return u > 0 ? i / u : 0;
};
// A marker's size on screen (CSS px): its 20 px disc and its 2 px ring.
export const MARKER_PX = 24;
// `near` ({ x, y }: a marker's size as fractions of the region's width and height on screen): markers whose anchors (the
// boxes' top-left corners, where the numbers sit) are closer than that on both axes are stacked too, so a link and the
// small icon inside it never put one number on top of another (review of PR #35).
export function stackMarks(marks, { near = null } = {}) {
  const out = marks.map(m => ({ ...m, ns: m.n ? [m.n] : [], label: null }));
  const lead = out.map((_, i) => i);
  const close = (a, b) => iou(a, b) >= 0.5 || (!!near && Math.abs(a.left - b.left) < near.x && Math.abs(a.top - b.top) < near.y);
  for (let i = 0; i < out.length; i++) {
    if (lead[i] !== i || !out[i].n) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (lead[j] !== j || !out[j].n || !close(out[i], out[j])) continue;
      lead[j] = i;
      if (!out[i].ns.includes(out[j].n)) out[i].ns.push(out[j].n);
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (lead[i] !== i) { out[i].ns = out[lead[i]].ns; continue; }
    if (out[i].n) { out[i].ns.sort((a, b) => a - b); out[i].label = out[i].ns.join(' '); }
  }
  return out;
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
