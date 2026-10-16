// What the board's Progress view says, computed once for the board (`/api/summary`) and `nunchi findings --json`
// (`summary`), so the two never disagree (design 0.1-c §3.3, §3.4). Deterministic: the same ledger and run folders
// give the same summary; the clock and the process table are read only to tell whether a capture is still running or
// has stopped (runs.mjs captureStates, passed in as `captures`).
//
// The verdict formula (design §3.4). "Ready to ship? Yes" only when all of these hold:
// - no blocker or high group is open, to fix, held, needs you, or not double-checked, and none is kept or called
//   "not a problem" by a decision no person made or confirmed (design §1: the AI recorded it, or it came through git);
// - the last full check is newer than the last fix commit (a commit with a `Nunchi-Fix:` trailer, the fix loop's);
// - no double-checked AI item at blocker or high was double-checked by a suspect verification.
// Otherwise the verdict names what stands in the way.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { captureStates, STALE_MS } from './runs.mjs';
import { captureRuns, latestRunOf, byRun, titleOf, foldKindOf } from './ledger.mjs';
import { SEV, plural, human } from './board/shared.mjs';

const readJsonOr = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const SERIOUS = s => s === 'blocker' || s === 'high';
const ACTIVE = new Set(['open', 'regressed', 'to-fix', 'held', 'stale']);
const DISMISS = new Set(['keep', 'false-positive']);

// Why a group stands in the way, most pressing first (one reason per group).
export const STANDING = ['needs-you', 'decide', 'confirm', 'unchecked', 'suspect', 'fix', 'later'];
const STANDING_WORDS = { 'needs-you': n => `${n} need${n === 1 ? 's' : ''} you`, decide: n => `${n} to decide`, confirm: n => `${n} to confirm`,
  unchecked: n => `${n} not double-checked`, suspect: n => `${n} verified by a suspect check`, fix: n => `${n} waiting for the AI`, later: n => `${n} later` };

// A decision that keeps a finding or calls it not a problem, that no person made or confirmed (design §1).
export const unconfirmed = d => !!d && DISMISS.has(d.decision) && d.human === false;

// The groups whose latest fix attempt waits for the person: needs you, and still the very Fix decision that attempt
// was made for (a newer Fix — "Try again with a note…" — or another decision has answered it). `records`: group →
// latest record (fix/records.mjs latestRecords).
export function fixNeedsOf(records, rows) {
  const out = new Set();
  for (const [g, rec] of records) {
    if (rec?.phase !== 'needs-you') continue;
    const d = rows.filter(r => r.group === g).map(r => r.decision).filter(Boolean).sort((a, b) => (a.at || '') < (b.at || '') ? -1 : (a.at || '') > (b.at || '') ? 1 : a.id < b.id ? -1 : 1).pop();
    if (d?.decision === 'fix' && (!rec.decision?.id || d.id === rec.decision.id)) out.add(g);
  }
  return out;
}

// One group's reason to stand in the way (any severity), or null. `fixNeeds`: groups whose latest fix attempt waits for
// the person (the fix loop's records, design §4.9).
export function standingOf(g, rows, fixNeeds = new Set()) {
  const mine = rows.filter(r => r.group === g.group);
  const reasons = new Set();
  if (fixNeeds.has(g.group) && mine.some(r => !r.goneAt && r.status === 'to-fix')) reasons.add('needs-you');
  for (const r of mine) {
    if (r.goneAt) continue;
    if (r.needsYou) reasons.add('needs-you');
    if (r.status === 'open' || r.status === 'regressed' || r.status === 'stale') reasons.add(r.source === 'ai' && !r.checked ? 'unchecked' : 'decide');
    if ((r.status === 'kept' || r.status === 'dismissed') && unconfirmed(r.decision)) reasons.add('confirm');
    if (r.status === 'to-fix') reasons.add('fix');
    if (r.status === 'held') reasons.add('later');
    if (r.source === 'ai' && r.verification?.status === 'confirmed' && r.verification.suspect && ACTIVE.has(r.status)) reasons.add('suspect');
  }
  return STANDING.find(x => reasons.has(x)) || null;
}

// The runs of this worktree's stream that were full checks (a sweep of the whole app), oldest first.
function fullChecks(state, stream, runsDir) {
  return captureRuns(state, stream).filter(id => {
    const fold = (state.folds || []).find(f => f.run === id && f.source === 'rule' && (f.stream ?? 'main') === stream);
    if (fold?.kind && fold.kind !== 'sweep') return false;
    return readJsonOr(join(runsDir, id, 'run.json'), {})?.wholeApp === true;
  });
}

// A screen is checked when it was captured at its own address: a redirected one showed another page (judged in that
// page's own scene), so it is not checked — the same for the verdict, the counts, the export and the board's Coverage.
export const checkedScene = s => s.status === 'captured' && !/^redirected/.test(s.reason || '');

// The time a full check has left (design §6 "about 6 min left"), from its own measured times only: the mean time of the
// routes it has finished (each route's every person, viewport and forced state), times the routes left, rounded up to
// whole minutes. Null until a route is done, and once none is left (what remains then is the canaries and the fold).
export function minutesLeft({ routes, done, routeMs }) {
  const left = routes - done;
  if (!Array.isArray(routeMs) || !routeMs.length || left <= 0) return null;
  const mean = routeMs.reduce((a, b) => a + b, 0) / routeMs.length;
  return Math.max(1, Math.ceil((mean * left) / 60000));
}

// The fast first run on the board (design §6, the agreed words):
// - while the latest capture of this worktree is a quick first look and a sweep is being captured after it: "First
//   look: 8 key screens · full check running, 12 of 25 screens (about 6 min left)";
// - once that sweep lands, until the next capture does: "Full check done: 16 new groups" (groups whose first sighting
//   is that sweep: the first look did not show them).
// A sweep that is not of the whole app (a dynamic route without a sample, --changed-since, --routes) says why, in the
// words capture prints for it (review of PR #33): "· skipped /posts/[id] (needs-sample)", or "· only the routes given
// (--routes)". "Screens" here are routes (the design's own count: 8 key screens, a 25-route app).
const PARTIAL_REASONS = new Set(['needs-sample', 'unchanged']);
export function partialWhy({ wholeApp, routesGiven = false, skipped = [] }) {
  if (wholeApp) return '';
  if (routesGiven) return ' · only the routes given (--routes)';
  const why = (Array.isArray(skipped) ? skipped : []).filter(s => s && PARTIAL_REASONS.has(s.reason)).map(s => `${s.route} (${s.reason})`);
  if (!why.length) return '';
  return ` · skipped ${why.slice(0, 3).join(', ')}${why.length > 3 ? ` and ${why.length - 3} more` : ''}`;
}
// The captures the board names besides that full check (M5b; the owner's text mock-ups, 2026-10-15 KST), the words
// computed here once for the board's Now lines, Coverage and `findings`:
// - a capture running: "Capture running · run 0007 · 12 of 25 screens (about 6 min left)" (how far, and the time left by
//   minutesLeft), or "Capture running · run 0007" before its first route is done (or with no progress file); one whose
//   writer runs here but made no progress for 10 minutes says so in place of the time left: "… 12 of 25 screens (no
//   progress for 10 min)" (the owner's decision on the review of PR #36: no "capture again" beside a capture that runs);
// - a capture stopped (runs.mjs captureStates): "Capture stopped · run 0002 (no progress for 10 min) — tell your AI
//   “capture again”", or "(its process ended)" when its writer on this machine is gone (said so for good). The minutes
//   are the rule's (STALE_MS), so a line stays the same while the folder stays and is not announced again each minute.
const FIRST_LOOK_IDLE = n => `First look: ${plural(n, 'key screen')} · the full check has not started — tell your AI “full check”`;
const STOPPED_WHY = { 'no-progress': `no progress for ${STALE_MS / 60e3} min`, ended: 'its process ended' };
// how far a capture is: "12 of 25 screens (about 6 min left)", or "(no progress for 10 min)" in place of the time left
const howFar = (p, quiet) => { const min = quiet ? null : minutesLeft(p); return `${p.done} of ${p.routes} screens${quiet ? ` (${STOPPED_WHY['no-progress']})` : min ? ` (about ${min} min left)` : ''}`; };
function runningText(run, p, quiet = false) {
  if (!p || !(p.done > 0)) return `Capture running · run ${run}${quiet ? ` (${STOPPED_WHY['no-progress']})` : ''}`;
  return `Capture running · run ${run} · ${howFar(p, quiet)}`;
}
const stoppedText = (run, why) => `Capture stopped · run ${run} (${STOPPED_WHY[why] || STOPPED_WHY['no-progress']}) — tell your AI “capture again”`;
// Which stopped capture is said: the newest, and only while it is the latest thing this worktree did (newer than its
// latest run, and no capture running); a later capture, running or complete, answers it.
function stoppedShown(captures, latest) {
  if (captures.some(c => c.state === 'running')) return null;
  const s = captures.filter(c => c.state === 'stopped').pop() ?? null;
  return s && (!latest || byRun(s.run, latest) > 0) ? s : null;
}
function firstRun(state, stream, runsDir, rows, live, stopped) {
  const runs = captureRuns(state, stream);
  const latest = runs[runs.length - 1] ?? null;
  const kind = id => foldKindOf(state, id, stream);
  if (latest && kind(latest) === 'quick') {
    const screens = readJsonOr(join(runsDir, latest, 'run.json'), {})?.scope?.routes;
    const n = Array.isArray(screens) ? screens.length : 0;
    const now = live.filter(x => x.progress?.kind === 'sweep' && byRun(x.run, latest) > 0).pop() ?? null;
    // no full check after it (M5b): it has not started, unless a capture running or stopped says what happens instead
    if (!now) return { firstLook: { run: latest, screens: n, full: null, text: live.length || stopped ? null : FIRST_LOOK_IDLE(n) }, fullCheckDone: null };
    const full = now.progress, quiet = now.why === 'no-progress', min = quiet ? null : minutesLeft(full);
    return { firstLook: { run: latest, screens: n, full: { run: now.run, done: full.done, routes: full.routes, minutesLeft: min, wholeApp: full.wholeApp },
      text: `First look: ${plural(n, 'key screen')} · full check running, ${howFar(full, quiet)}${partialWhy(full)}` }, fullCheckDone: null };
  }
  const previous = runs[runs.length - 2] ?? null;
  if (latest && previous && kind(latest) === 'sweep' && kind(previous) === 'quick') {
    const meta = readJsonOr(join(runsDir, latest, 'run.json'), {});
    const first = new Map();
    for (const r of rows) if (typeof r.firstSeen === 'string' && (!first.has(r.group) || byRun(r.firstSeen, first.get(r.group)) < 0)) first.set(r.group, r.firstSeen);
    const n = [...first.values()].filter(id => id === latest).length;
    const why = partialWhy({ wholeApp: meta?.wholeApp === true, routesGiven: meta?.routesGiven === true, skipped: meta?.skipped });
    return { firstLook: null, fullCheckDone: { run: latest, after: previous, newGroups: n, wholeApp: meta?.wholeApp === true, text: `Full check done: ${plural(n, 'new group')}${why}` } };
  }
  return { firstLook: null, fullCheckDone: null };
}

// `git`: the hardened git runner of the project (runs.mjs gitRunner), to count commits with a `Nunchi-Fix:` trailer
// after the last full check's commit; null when there is no git. `captures`: the capture folders still being written by
// a writer that is still there, and those that stopped (runs.mjs captureStates: the one reading of the clock and of
// processes here; a test passes its own).
export function summary({ state, rows, groups, stream = 'main', runsDir, git = null, fixNeeds = new Set(), captures = captureStates(runsDir) }) {
  const latest = latestRunOf(state, stream);
  const live = captures.filter(c => c.state === 'running');
  // a stopped capture is not there for the verdict (M5b): it goes by the complete runs; the Now line says it stopped
  const stopped = stoppedShown(captures, latest);
  const { firstLook, fullCheckDone } = firstRun(state, stream, runsDir, rows, live, stopped);
  const lines = [...live.filter(x => x.run !== firstLook?.full?.run).map(x => ({ run: x.run, state: 'running', text: runningText(x.run, x.progress, x.why === 'no-progress') })),
    ...(stopped ? [{ run: stopped.run, state: 'stopped', text: stoppedText(stopped.run, stopped.why) }] : [])];
  const meta = latest ? readJsonOr(join(runsDir, latest, 'run.json'), {}) : {};
  const manifest = latest ? readJsonOr(join(runsDir, latest, 'manifest.json'), {}) : {};
  const running = live.length > 0;
  const checks = fullChecks(state, stream, runsDir);
  const full = checks[checks.length - 1] ?? null, previous = checks[checks.length - 2] ?? null;
  const fixCommits = git && full ? fixCommitsSince(git, readJsonOr(join(runsDir, full, 'run.json'), {})?.commit) : null;
  const scenes = (Array.isArray(manifest.scenes) ? manifest.scenes : []).filter(s => s && s.canary === undefined);
  const notSeen = scenes.filter(s => !checkedScene(s));
  const problems = (Array.isArray(manifest.health?.problems) ? manifest.health.problems : []).map(p => ({ status: String(p.status), scenes: Number(p.scenes) || 0, of: Number(p.of) || 0 }));

  // groups, by severity and by status, and why each stands in the way. Groups, never rows, and counted as the board's
  // tabs count them: a group with rows in two statuses counts in both; "came back" and stale count as open
  const bySeverity = { blocker: 0, high: 0, medium: 0, low: 0 };
  const byStatus = { open: 0, 'to-fix': 0, held: 0, kept: 0, dismissed: 0, fixed: 0, stale: 0 };
  const standing = {};
  for (const x of STANDING) standing[x] = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const g of groups) {
    const keys = new Set(Object.keys(g.statuses).map(s => (s === 'regressed' ? 'open' : s)));
    if (keys.has('stale')) keys.add('open');
    for (const k of keys) if (Object.hasOwn(byStatus, k)) byStatus[k]++;
    if ([...keys].some(k => ACTIVE.has(k))) bySeverity[g.severity] = (bySeverity[g.severity] || 0) + 1;
    const why = standingOf(g, rows, fixNeeds);
    if (why) standing[why][g.severity]++;
  }
  const serious = Object.fromEntries(STANDING.map(x => [x, standing[x].blocker + standing[x].high]));
  const seriousTotal = Object.values(serious).reduce((a, b) => a + b, 0);
  const bh = { blocker: STANDING.reduce((n, x) => n + standing[x].blocker, 0), high: STANDING.reduce((n, x) => n + standing[x].high, 0) };

  // AI review: did a hunt run on the last full check (or the latest run)?
  const aiRan = (state.folds || []).some(f => f.source === 'ai' && (f.stream ?? 'main') === stream && (f.run === full || f.run === latest));
  const ai = rows.filter(r => r.source === 'ai' && !r.goneAt);
  let verdict;
  // a quick first look is no verdict (design §6): too early to say until the full check lands
  if (firstLook?.full) verdict = { answer: 'too-early', text: 'Too early to say · full check running' };
  else if (running) verdict = { answer: 'too-early', text: 'Too early to say · a capture is running' };
  else if (firstLook) verdict = { answer: 'too-early', text: 'Too early to say' };
  else if (!latest) verdict = { answer: 'too-early', text: 'Too early to say · nothing captured yet' };
  else if (problems.some(p => p.status === 'app-unreachable' || p.status === 'login-expired')) verdict = { answer: 'too-early', text: 'Too early to say · this run had a problem' };
  else if (seriousTotal) {
    const head = [bh.blocker && plural(bh.blocker, 'blocker'), bh.high && `${bh.high} high`].filter(Boolean).join(', ');
    const parts = STANDING.filter(x => serious[x]).map(x => STANDING_WORDS[x](serious[x]));
    verdict = { answer: 'not-yet', text: `Not yet · ${head}: ${parts.join(', ')}` };
  } else if (fixCommits) verdict = { answer: 'not-yet', text: `Not yet · ${plural(fixCommits, 'fix', 'fixes')} since the last full check: capture again` };
  else if (!aiRan) verdict = { answer: 'probably', text: 'Probably · rules only — the AI review hasn’t run' };
  else if (!full) verdict = { answer: 'yes-checked', text: 'Yes, for what was checked · no full check yet' };
  else if (notSeen.length) verdict = { answer: 'yes-checked', text: `Yes, for what was checked · ${plural(notSeen.length, 'screen')} not checked` };
  else verdict = { answer: 'yes', text: 'Yes' };

  // since the last full check (design §3.4): what the runs after the previous full check found new, fixed and back
  const after = id => typeof id === 'string' && (!previous || byRun(id, previous) > 0);
  const groupsWhere = pred => new Set(rows.filter(pred).map(r => r.group)).size;
  const since = {
    label: previous ? `Since last full check (run ${previous})` : full ? `First full check (run ${full})` : 'No full check yet',
    against: previous,
    new: groupsWhere(r => after(r.firstSeen) && !r.goneAt),
    fixed: groupsWhere(r => r.goneAt && after(r.goneAt)),
    back: groupsWhere(r => r.regressedAt && after(r.regressedAt) && !r.goneAt),
  };

  // decisions that wait for a person (design §1): dismissals the AI recorded or that came through git, once each
  const confirm = [], seenIds = new Set();
  for (const r of rows) {
    const d = r.decision;
    if (!(r.status === 'kept' || r.status === 'dismissed') || !unconfirmed(d) || seenIds.has(d.key)) continue;
    seenIds.add(d.key);
    const g = groups.find(x => x.group === r.group);
    confirm.push({ id: d.id, key: d.key, decision: d.decision, reason: d.reason ?? null, channel: d.channel, by: d.by ?? null, at: d.at ?? null, note: d.note ?? null,
      target: d.target, group: r.group, title: g?.source === 'ai' ? human(g.rule) : titleOf(r.rule), severity: g?.severity ?? r.severity });
  }
  confirm.sort((a, b) => SEV[a.severity] - SEV[b.severity] || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.id < b.id ? -1 : 1));

  // what to decide (the main button's "Decide N"), and the handoff once nothing is left (design §3.4)
  // (AI findings not double-checked wait for the AI's double-check first, so they do not hold the handoff back)
  const open = r => !r.goneAt && (r.status === 'open' || r.status === 'regressed' || r.status === 'stale' || !!r.needsYou) && !(r.source === 'ai' && !r.checked);
  const toDecide = groups.filter(g => rows.some(r => r.group === g.group && open(r))).length;
  // to fix by the AI: a group whose fix waits for the person is not, so "All decided. N to fix…" never hands the AI a
  // fix it cannot take on (design §3.4); those are counted apart
  const fixNeedsYou = groups.filter(g => g.statuses['to-fix'] && fixNeeds.has(g.group)).length;
  const toFix = groups.filter(g => g.statuses['to-fix'] && !fixNeeds.has(g.group)).length;
  // the main button's "Decide N": the number the verdict says is to decide (blocker and high, worst first in the list)
  // when it says one, so the two never disagree; otherwise every group to decide
  const decideNow = seriousTotal && serious.decide ? serious.decide : toDecide;
  const handoff = !toDecide && toFix ? { toFix, text: `All decided. ${toFix} to fix. Go back to your AI chat and say “fix them”.`, say: 'fix them' } : null;
  return {
    run: latest, kind: meta.kind ?? 'sweep', fullCheck: full, previousFullCheck: previous, running, runningRuns: live.map(x => x.run), captures: lines, firstLook, fullCheckDone,
    // the Now lines, in one order for the board and `findings` (M5b review): the full check done, the first look, the
    // captures running or stopped
    now: [fullCheckDone?.text, firstLook?.text, ...lines.map(c => c.text)].filter(Boolean),
    verdict, bySeverity, byStatus, standing, toDecide, decideNow, toFix, fixNeedsYou, handoff, since, confirm,
    health: { problems, blind: (latest && state.blind?.[latest]) || null, scenes: { total: scenes.length, checked: scenes.length - notSeen.length, notSeen: notSeen.length, reasons: [...new Set(notSeen.map(s => String(s.reason || s.status)))].sort() } },
    ai: { ran: aiRan, groups: new Set(ai.map(r => r.group)).size, doubleChecked: new Set(ai.filter(r => r.checked).map(r => r.group)).size,
      notDoubleChecked: new Set(ai.filter(r => !r.checked).map(r => r.group)).size, stale: groups.filter(g => g.status === 'stale').length,
      needsYou: rows.filter(r => r.needsYou && !r.goneAt).length, suspect: ai.some(r => r.verification?.suspect),
      tooFewDecoys: ai.some(r => r.verification?.tooFewDecoys === true) },
    commit: meta.commit ?? null, dirty: meta.dirty ?? null,
  };
}

// Commits with a `Nunchi-Fix:` trailer (the fix loop's, design §4.7) after `commit`, through the hardened git runner;
// null when there is no git or no commit to compare with.
export function fixCommitsSince(run, commit) {
  if (!run || !commit || !/^[0-9a-f]{7,64}$/.test(commit)) return null;
  try {
    const out = run(['log', '--format=%(trailers:key=Nunchi-Fix,valueonly)%x00', `${commit}..HEAD`, '--'], { encoding: 'utf8' });
    return out.split('\0').filter(x => x.trim()).length;
  } catch { return null; }
}
