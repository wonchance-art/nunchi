// `nunchi check [--fail-on <severity>] [--sarif <file>] [--base <ref>] [--root <dir>] [--json]` (design 0.1-c §5, spec
// §7.3): what CI runs. No capture, no browser, no network, and nothing written but the SARIF file asked for.
//
// - The guards of `.nunchi/guards.json` run over the source; a hit not in the baseline fails (exit 1).
// - `--base <ref>`: the guards file as it was at <ref> (read with the hardened git, never a checkout); a guard removed
//   or narrowed since, or a baseline that grew, fails like a hit, so a guard cannot be weakened silently.
// - The ledger, when this machine has one: open findings at or above `--fail-on` fail (the verdict's own count of
//   what stands in the way, summary.mjs standingOf). In CI there is no ledger: guards only, said as `ledger: absent`;
//   `--fail-on` without a ledger is a state error (exit 2), never a pass.
// - Exit codes: 0 clean; 1 a guard hit (or a weakened guard) or findings at or above --fail-on; 2 a usage or state
//   error (a malformed guards file, an unknown ref, a ledger that cannot be read).
import { join, resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readGuards, parseGuards, guardsPath, scanGuards, compareBaseline, weakenedSince, labelOf, hitLabel, KINDS } from './guards.mjs';
import { gitRunner } from './runs.mjs';
import { stateRoot, stateFiles } from './state.mjs';
import { SEV, SEVERITIES } from './board/shared.mjs';
import { sarifLog, truncationLine } from './sarif.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Is there a ledger on this machine for this project? Read-only: nothing is created to find out (CI has none).
export function ledgerPresent(project) {
  const root = stateRoot(project);
  if (existsSync(stateFiles(root.dir).ledger)) return true;
  return !!(root.legacy && existsSync(join(root.legacy, 'ledger.json')));
}

// The guards file at <ref>: `git rev-parse --verify <ref>^{commit}`, then the blob `<commit>:<path>` (cat-file: no
// textconv, no filters, no checkout). → the document, or null when the file did not exist there.
export function guardsAt(project, ref, { git = null } = {}) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\u0000-\u001f\s]/.test(ref)) throw fail('BAD_ARGS', '--base takes a git ref (a branch, a tag or a commit)');
  let run = git;
  try { run ||= gitRunner(project); } catch (e) { throw fail('BAD_STATE', `--base needs git: ${String(e.message).split('\n')[0]}`); }
  let commit, prefix;
  try {
    commit = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    prefix = run(['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim();
  } catch { throw fail('BAD_STATE', `--base ${ref}: not a commit in this repository (in CI, fetch it first: git fetch --depth=1 origin ${ref})`); }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw fail('BAD_STATE', `--base ${ref}: not a commit in this repository`);
  const path = `${prefix}.nunchi/guards.json`;
  try { run(['cat-file', '-e', `${commit}:${path}`]); } catch { return null; }
  let text;
  try { text = run(['cat-file', 'blob', `${commit}:${path}`], { encoding: 'utf8' }); } catch (e) { throw fail('BAD_STATE', `--base ${ref}: ${path} cannot be read (${String(e.message).split('\n')[0]})`); }
  return parseGuards(text, `${path} at ${ref}`);
}

// → { code, lines, json, sarif: { text, kept, of, truncated } | null }. `ledger`: a function that loads the ledger
// (project.mjs loadLedger) and returns { rows, groups, standing(g) }; called only when one exists.
export function runCheck({ project, root = project, failOn = null, base = null, sarif = false, version = '0', ledger = null, git = null }) {
  project = resolve(project); root = resolve(root);
  if (failOn !== null && !SEVERITIES.includes(failOn)) throw fail('BAD_ARGS', `--fail-on takes ${SEVERITIES.join(', ')}`);
  const nunchiDir = join(project, '.nunchi');
  const doc = readGuards(guardsPath(nunchiDir));
  const before = base ? guardsAt(project, base, { git }) : null;
  const guards = doc?.guards || [];
  const scan = scanGuards({ project, root, guards });
  const cmpd = compareBaseline(scan.hits, doc?.baseline || []);
  const weakened = base ? weakenedSince(before, doc) : [];
  const lines = [];
  lines.push(`nunchi check · ${guards.length ? `guards: ${guards.map(g => labelOf(g.kind, g.params)).join(', ')} (${guards.length} of ${KINDS.length} built-in)` : 'guards: none (.nunchi/guards.json does not exist or lists none: nunchi guard shows the built-in ones)'} · ${plural(scan.files, 'file')} read`);
  if (cmpd.fresh.length) {
    lines.push(`new guard hits: ${cmpd.fresh.length}`);
    for (const h of cmpd.fresh) lines.push(`  ${h.file}:${h.line}:${h.column}  ${hitLabel(h)}`);
  } else if (guards.length) lines.push('new guard hits: 0');
  if (cmpd.known.length) lines.push(`baselined: ${cmpd.known.length} (there when the guard was added)`);
  if (cmpd.gone.length) lines.push(`gone from the baseline: ${cmpd.gone.reduce((n, e) => n + e.count - e.now, 0)} (nunchi guard --baseline, in your own terminal, tightens it)`);
  if (base) {
    if (!weakened.length) lines.push(`since ${base}: no guard removed or weakened`);
    for (const w of weakened) lines.push(`  since ${base}: ${w.why === 'removed' ? `guard removed: ${w.label}` : w.why === 'narrowed' ? `guard weakened: ${w.label} (${w.detail})` : `baseline grew: ${w.file} (${w.what ? hitLabel({ kind: w.kind, what: w.what }) : w.label}, +${w.count})`}`);
  }
  if (scan.large.length) lines.push(`skipped: ${plural(scan.large.length, 'file')} over 1 MB (${scan.large.slice(0, 3).join(', ')}${scan.large.length > 3 ? ', …' : ''})`);
  if (scan.unparsed.length) lines.push(`not checked: ${plural(scan.unparsed.length, 'file')} that do not parse (${scan.unparsed.slice(0, 3).map(u => `${u.file}${u.line ? `:${u.line}` : ''}`).join(', ')}${scan.unparsed.length > 3 ? ', …' : ''})`);

  // the ledger (local only)
  let led = null;
  const present = ledgerPresent(project);
  if (!present) {
    lines.push('ledger: absent (guards only)');
    if (failOn) throw fail('NO_LEDGER', `--fail-on ${failOn} needs nunchi's ledger, and there is none here (in CI there never is): run check without --fail-on, or capture first`);
  } else if (!failOn) lines.push('ledger: present, not judged (--fail-on not given)');
  else if (ledger) led = ledger();
  const standing = led && failOn ? led.groups.filter(g => SEV[g.severity] <= SEV[failOn] && led.standing(g)) : [];
  if (led) {
    const bySev = SEVERITIES.map(s => [s, standing.filter(g => g.severity === s).length]).filter(([, n]) => n);
    lines.push(`ledger: run ${led.run ?? '—'} · ${plural(standing.length, 'group')} at or above ${failOn} still stand${standing.length === 1 ? 's' : ''} in the way${bySev.length ? ` (${bySev.map(([s, n]) => `${n} ${s}`).join(', ')}: nunchi findings)` : ''}`);
  }

  const failed = cmpd.fresh.length + weakened.length;
  const code = failed || standing.length ? 1 : 0;
  lines.push(code ? `exit 1: ${[failed && plural(failed, 'guard hit'), standing.length && `${plural(standing.length, 'open finding group')} at or above ${failOn}`].filter(Boolean).join(', ')}` : 'exit 0: clean');

  let sarifOut = null;
  // paths in SARIF are the repository's: the project folder's place in it (no git: the project's own)
  let prefix = '';
  if (sarif) { try { prefix = (git || gitRunner(project))(['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim(); } catch {} }
  if (sarif) {
    const rules = new Map(), results = [];
    for (const g of guards) rules.set(`nunchi.guard/${g.kind}`, { title: `nunchi guard: ${labelOf(g.kind, g.params).replace(/`/g, '')}`, tags: ['guard'] });
    const nth = new Map();                             // the same call twice in a file: two results, two fingerprints
    for (const h of cmpd.fresh) {
      const k = `${h.kind}:${h.file}:${h.anchor}`;
      nth.set(k, (nth.get(k) || 0) + 1);
      results.push({ ruleId: `nunchi.guard/${h.kind}`, severity: 'high', message: `${hitLabel(h).replace(/`/g, '')}: new since the baseline (nunchi guard ${h.kind}).`, path: `${prefix}${h.file}`, line: h.line, column: h.column,
        logical: [], fingerprints: { 'nunchi/guard/v1': `${h.kind}:${h.anchor}`, 'nunchi/fp/v1': `${k}:${nth.get(k)}` } });
    }
    for (const w of weakened) {
      if (!rules.has(`nunchi.guard/${w.kind}`)) rules.set(`nunchi.guard/${w.kind}`, { title: `nunchi guard: ${w.label.replace(/`/g, '')}`, tags: ['guard'] });
      const file = w.why === 'baseline' ? w.file : '.nunchi/guards.json';
      results.push({ ruleId: `nunchi.guard/${w.kind}`, severity: 'high', message: w.why === 'removed' ? `Guard removed since ${base}: ${w.label.replace(/`/g, '')}.` : w.why === 'narrowed' ? `Guard weakened since ${base}: ${w.label.replace(/`/g, '')} (${w.detail.replace(/`/g, '')}).` : `Baseline grew since ${base}: ${w.count} more ${w.label.replace(/`/g, '')} allowed in ${w.file}.`,
        path: `${prefix}${file}`, line: 1, logical: [], fingerprints: { 'nunchi/guard/v1': `${w.kind}:${w.why}:${w.anchor ?? ''}`, 'nunchi/fp/v1': `${w.kind}:${w.why}:${w.file ?? ''}:${w.anchor ?? ''}` } });
    }
    if (led && standing.length && led.results) {
      const more = led.results(new Set(standing.map(g => g.group)));
      for (const [id, r] of more.rules) rules.set(id, r);
      results.push(...more.results);
    }
    sarifOut = sarifLog({ version, rules, results });
    const cut = truncationLine(sarifOut.truncated);
    if (cut) lines.push(cut);
  }
  const json = {
    code, guards: guards.map(g => ({ kind: g.kind, params: g.params, label: labelOf(g.kind, g.params) })), files: scan.files,
    hits: { new: cmpd.fresh, baselined: cmpd.known.length, gone: cmpd.gone }, ...(base ? { base, weakened } : {}),
    skipped: { large: scan.large, unparsed: scan.unparsed },
    ledger: present ? { present: true, run: led?.run ?? null, failOn, standing: standing.map(g => ({ group: g.group, rule: g.rule, severity: g.severity })) } : { present: false },
    ...(sarifOut ? { sarif: { results: sarifOut.kept, of: sarifOut.of, truncated: sarifOut.truncated } } : {}),
  };
  return { code, lines, json, sarif: sarifOut };
}
