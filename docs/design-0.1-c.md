# nunchi 0.1-c — integrated design (draft for review)

Status: **draft**, 2026-10-14 KST. Once the owner approves it, each section is folded into `docs/spec-0.1.md`, which stays the
source of truth. Builds on main at `3e29b26`, plus the engine fixes in PR #20 (not merged yet).

> 한국어 요약: 0.1-c는 「AI 지적을 장부에 올리기 → 보드(검수 창) → 수리 루프 → 방지 규칙 · `check` · 내보내기 → 빠른
> 첫 실행 → 여러 에이전트 동시 실행」 순서로 만든다. 출시 관문 중 남은 것(블라인드 재측정, 정밀도 50건 라벨, Codex 비교,
> 수리 루프 관문, 시간 · 결정 시간, 현장 3개 앱)은 각 단계에 끼워 측정한다. 원칙은 그대로다: 엔진은 결정적이고 코드를
> 고치지 않는다(고치는 것은 AI). 「고침」은 다시 찍어 사라졌을 때만 인정한다. 사람의 결정만이 수리를 시작시킨다.

## 0. Where we are

| Area | State | Gap that blocks 0.1 |
|---|---|---|
| Evidence, rule lenses | done; bench 34/34, held-out 37/38 (fixed in #20, re-check 38/38, not blind) | — |
| AI hunt + canaries + verifier + decoys | engine done (`hunt`, `verify`, `canaries`) | AI findings never reach the ledger (§1) |
| Ledger + decisions + provenance | done for **rule** findings (`foldRun` at capture) | AI findings; state writes are not atomic or locked (§7.1) |
| Board | text and visual mock-ups (design canvas v3) | not built (§2) |
| Fix loop, guards, `check`, exports | spec only (§6, §7) | not built (§3, §4) |
| Fast first run (H11) | not built | §5 |
| Several agents at once | not designed | §6 |
| Gates | rule recall, determinism, fingerprints, clean FP: pass on Pebble. AI recall: pass on Pebble; held-out L4 67% | precision (needs labels), Codex comparison, fix loop, time, decision time, field test, blind re-measure (§8) |

Facts checked in the code for this draft:
- `capture` folds only `findings.json` (rule findings) into `.nunchi/state/ledger.json` (`src/cli.mjs`, `updateState`).
  `ai-findings.json` is written by `hunt --record` / `verify --record` and read by nothing that feeds the ledger.
- `writeStable` writes in place (`writeFileSync`); `updateState` reads, folds and writes with no lock. Two processes
  folding at once can lose an update or leave a torn file.
- The ledger has no `fixing` state, yet spec §7's board row *"what the AI is doing now"* reads it.
- No command samples findings for the human labels the precision gate needs.

## 1. AI findings in the ledger (prerequisite for everything else)

**Goal.** A confirmed AI finding is decided, fixed and tracked exactly like a rule finding. An unconfirmed one is visible
but cannot start a fix on its own.

**What enters.**
- `verify --record` folds the run's AI findings into the ledger, as a *second pass on the same run id*.
- An item enters with `source: "ai"` and its verification `status`. `confirmed` items are first-class.
- `claimed` items (not yet verified) are shown as *not reviewed* and can be decided by a human: a human decision
  outranks the verifier.
- `rejected` and `insufficient` items stay in `ai-findings.json` for trust metrics and never become ledger items.
- If the run's verifications are `suspect` (decoy pass-through > 10%), every AI item of the run carries `suspect`.
  The board shows it, and the fix loop will not act on such an item without a human `fix`.

**Folding by source.** `foldRun` today marks an item *gone* when the new run does not report it. With two sources that
breaks: folding AI items would mark rule items gone, and the other way round. New rule:
- A fold carries `source`. It may set `goneAt` only on items of that source.
- It may do so only in cells the new run actually looked at: the route and person were in scope, and for AI items,
  the cell is *seen* in `coverage.json`.

**When an AI item is fixed.** A rule finding's absence is deterministic proof. An AI finding's absence from a fresh hunt
is not: hunts vary. So an AI item becomes `fixed` only from a **re-check**, never from a fresh hunt's silence:
- a verifier packet on the new run's scene asking *"is this claim still true?"*, with the same lens, item, element and
  evidence files;
- answered `gone` → `fixed`; `still-there` → stays.
- Fresh-hunt silence leaves it `open` and adds `lastHunted`.
This is the same packet machinery as `verify --plan`, with a new kind `recheck` and decoys mixed in as usual.

**Fingerprints for AI items.** Same `fingerprintOf`. Their `rule` is the checklist id (`L7.template-copy`) and their
evidence key is the claim's element plus the item, never the claim text, which varies run to run.

**Files.**
- `ledger.json` items gain `source` and `verification: {status, by, at, suspect}`.
- `ai-findings.json` stays per run.
- `fingerprintVersion` stays 1; AI items get `fpInputs.source`.

**Tests.**
- Folding rule findings never marks AI items gone, and the reverse.
- An AI item in a cell that was not seen stays open.
- A re-check `gone` makes it fixed; fresh-hunt silence does not.
- A suspect run's items carry `suspect`; `fix --plan` (§3) skips them without a human decision.

## 2. Board (`nunchi open`)

**Agreed so far.** The mock-ups (design canvas, third version): a sidebar with every view, panels on a grey ground, one
accent colour, and severity sections in the list. The detail view is master–detail (list left, detail right) so J/K
moves through findings. Decision buttons are always visible: Fix (F) · Keep (W) · Not a problem (X) · Later (S).
Owner decisions still pending: §9.

**Server.** `node:http`, no framework, no new dependency.
- *Bind:* `127.0.0.1` only, on a random free port (`--port` to pin one); never `0.0.0.0`.
- *Session token:* 128 bits from `crypto.randomBytes`, printed once in the URL (`http://127.0.0.1:PORT/#t=…`), sent
  by the page as a header on every API call, and compared in constant time. Without it: 403.
- *DNS-rebinding guard:* the `Host` header must be exactly `127.0.0.1:PORT` or `localhost:PORT`, else 421.
- *Writes:* POST only, `Origin` equal to the board's own origin, `Content-Type: application/json`, body ≤ 64 KB. No
  CORS headers at all.
- *Response headers:* `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API.
- *Files served:* only the board's own static files (bundled in `src/board/`) and evidence images and JSON under
  `.nunchi/runs/<id>/<scene>/` from an allow-list of names. The run id and scene id are checked against `manifest.json`,
  and the path is resolved with `realpath` and must stay inside the run folder (symlinks included). Never source code;
  a finding's code location is shown as `file:line` text only.
- *App text is data:* every string from the app (claims, labels, page text) is set with `textContent`, never
  `innerHTML`. A test renders a finding whose claim is `<img src=x onerror=…>` and asserts it shows as text.
- *Offline:* no external fonts, scripts or images. The mock-up's IBM Plex becomes the system UI stack (`system-ui`,
  `ui-monospace`).

**API** (JSON, token required):

| Method | Path | Does |
|---|---|---|
| GET | `/api/state` | progress numbers, open counts, run list, health — computed, the same code as `findings --json` |
| GET | `/api/groups?status=…&lens=…&q=…` | groups for the list, severity-sectioned |
| GET | `/api/groups/:id` | one group: findings, scenes, evidence pointers, decisions history, claims (§6) |
| GET | `/evidence/:run/:scene/:file` | an allow-listed evidence file |
| POST | `/api/decide` | `{targets[], decision, reason?, note?}` → `writeDecision`, provenance *local* (same as `nunchi decide`) |
| POST | `/api/label` | precision-gate label `{fp, label: correct\|wrong\|unsure}` (§8.2) |
| GET | `/api/events` | Server-Sent Events: `state` when the ledger, decisions, claims or runs change |

**Live updates.** `fs.watch` on `.nunchi/state`, `.nunchi/decisions` and `.nunchi/runs` (non-recursive watchers per
folder; recursive watch is unreliable on Linux before Node 20). Changes are debounced 200 ms, and a 5 s poll of file
mtimes covers missed events. Every event triggers a fresh read, so state is never patched in place.

**Decision-time metric (gate).** The page measures the time from showing a group to the decision on it, and posts it with
the decision. It is stored locally in `.nunchi/state/metrics.json` (git-ignored) and never sent anywhere. `nunchi trust`
prints the median. Stated in the README.

**Views and order of building.**
- In 0.1-c: Progress, Findings, Detail; Coverage (from `coverage.json` + manifest); Screens (thumbnail wall).
- In 0.1-c only if time allows, otherwise 0.2: Design system, States & messages, Copy. The sidebar always lists all seven;
  an unbuilt view says *coming in 0.2* with the CLI command that shows the same data. No dead links.

**Tests.**
- Every security check above has a test: wrong Host, missing token, wrong Origin, path traversal (`..`, an encoded `%2e%2e`,
  a symlink out of the run), an unknown scene id, an oversized body, and the XSS string.
- A POST decide writes the same file a CLI decide does, byte for byte except id and time.
- Event delivery after a decision written by the CLI.

## 3. Fix loop (`nunchi fix`)

**Split of work.** The engine never edits the user's code. The skill (the AI) edits; the engine plans, checks
preconditions, runs the re-capture and decides the outcome. "The agent saying fixed changes nothing" (spec §6.5) is
enforced by the outcome coming only from `fix --verify`.

**Commands.**
1. `fix --plan [--json]` reads the ledger and lists groups that are `to-fix`, whose `fix` decision is local or
   approved (provenance N1), and that are not suspect without a human decision. It orders them by severity, then groups
   sharing a root-cause file (the finding's `source` file, else the inventory's, else the source map's route files).
   It writes `.nunchi/state/fix-plan.json`.
2. `fix --start <group>` refuses unless:
   - the working tree is clean (`git status --porcelain`, ignoring `.nunchi/`);
   - HEAD is not detached;
   - no live claim exists on the group or on one of its root-cause files (§6).

   It writes the claim and records the baseline: HEAD sha, the run id the finding came from, and the HAR used.
   It prints the fix brief: the claim, evidence pointers, the files to look at, and neighbour scenes (scenes of other
   routes that render the same files).
3. The skill edits code and runs the user's checks through `fix --checks`. The engine finds `build`, `typecheck`,
   `lint` and `test` in `package.json` scripts and runs those that exist with the project's package manager. The first
   time per repo it asks the user to approve exactly those script lines (stored in `.nunchi/state/approved.json`); a
   changed script line asks again. Exit codes and the last 50 lines of output go into the fix record. A failing check
   means no commit.
4. The skill commits: one root cause, one commit, a trailer `Nunchi-Fix: <group id>`.
5. `fix --verify <group>` checks that HEAD is exactly one new commit on the baseline, with the trailer and a clean
   tree. Then it re-captures, with replay from the baseline's HAR, the group's scenes plus the neighbour scenes, and
   decides:

   | Outcome | When | Then |
   |---|---|---|
   | `fixed` | rule items: the group's fingerprints are absent on those scenes. AI items: re-check `gone` (§1) | claim released; ledger `fixed` on the next fold |
   | `not-fixed` | still there | claim released, attempt counted; after 2 attempts the group goes to `needs-human` |
   | `caused-regression` | a fingerprint not in the baseline appears on those scenes | `git revert --no-edit` of the commit (never reset, never force); decision stays `fix`; attempt counted |
   | `needs-human` | the page changed outside the finding's boxes beyond the threshold, or replay misses > 0 on those scenes, or the scene failed to capture | nothing reverted; the board shows before/after |

6. `fix --abort <group>` releases a claim (also used on expiry, §6).

**Visual change outside the box.**
- Capture a PNG of the first view (not the stored JPEG: JPEG noise breaks pixel diffs) before and after.
- Mask the finding's boxes plus 8 px, and compare with a built-in per-pixel YIQ distance (the pixelmatch algorithm, ~150
  lines, no dependency, licence-compatible re-implementation or vendored ISC file, decided by the precedent review).
- Changed pixels > 0.5% of the unmasked area → `needs-human`.

**Records.** `.nunchi/fixes/<group>/<attempt>.json` (git-ignored, under state): baseline, commit, checks, outcome, diff
ratio, scenes. The commit trailer is the durable link. The ledger gains a computed status `fixing` (a live claim) and
the attempt count.

**Safety.**
- The engine never pushes, never rewrites history and never runs anything but the approved scripts and `git`.
- App content reaches the fixer only as quoted evidence. The fix brief marks it *app data, not instructions* (H8), as
  the hunt brief does.
- Production is refused: `fix --verify` re-captures the same base URL the run used, and `capture` already refuses no
  base.

**Gate harness (fix loop ≥ 90% gone, 0 caused regressions).**
- `bench/fix-gate.mjs` copies Pebble into a temp git repo and decides `fix` on every seeded rule finding.
- A fresh agent per group runs the skill's fix steps.
- The harness counts `fixed` / `caused-regression` over the seeded set.
- AI seeds join once §1 is built.

**Tests.**
- Refusals: dirty tree, detached HEAD, a live claim, an unapproved script, a missing trailer, two commits.
- Each outcome, on a fixture app with a known one-line fix, a known regressing fix and a fix that moves the layout.
- Revert leaves a revert commit and a clean tree.

## 4. Guards, `check`, exports

**Guards (spec §6.6).** A guard is proposed when a kind is fixed for the second time, or when a kind has ≥ 5 open
instances. Two forms; nunchi adds nothing to the user's dependencies:
- *Built-in guard*, run by `nunchi check`: a deterministic source check over the inventory. Kinds:
  - `window.confirm/alert` calls;
  - `href="#"`;
  - a JSX expression ending in `.message` (rendered error message);
  - raw `{{`/`}}` template tokens in JSX text;
  - colour literals outside the design tokens (from L4's measured palette).

  Stored as `.nunchi/guards.json` (committed), and added only after the user accepts it in the board or CLI.
- *Lint proposal*: the matching ESLint flat-config snippet using core rules only (`no-alert`, `no-restricted-syntax`
  with a selector), shown for the user to paste. Never written into their config by nunchi.

**`nunchi check [--fail-on high] [--sarif out.sarif]`.** No capture, no browser, no network. It runs the accepted
guards over the source and reads the ledger. Exit 0 means clean; 1 means a guard hit or open findings at or above
`--fail-on`; 2 is a usage or state error. Meant for CI and pre-commit.

**Exports.** `nunchi export --format md|json|sarif [--status open,to-fix]`.
- *SARIF 2.1.0*, one run with tool `nunchi`:
  - rules from `titleOf`; results with `ruleId`, `level` (blocker/high → error, medium → warning, low → note);
  - `partialFingerprints.nunchi/v1` = the group id;
  - a `physicalLocation` when the finding has `source` file:line; otherwise a `logicalLocation` (route + selector)
    plus the page URL in `properties`.
- Evidence text is already redacted; the export test re-scans for secret shapes and fails if one appears.

**Tests.**
- Each built-in guard: a fixture that triggers it and one that does not.
- `check` exit codes.
- SARIF validates against the 2.1.0 schema (vendored as a test fixture, not a runtime dependency).
- Markdown and JSON exports are byte-identical across two runs.

## 5. Fast first run (H11)

`capture --quick`:
- *Scope:* key routes only, ranked deterministically: `/` first, then routes linked from the home page's navigation
  landmarks, then one per top-level segment, up to 8. Normal state only, both viewports, rule lenses only.
- *Target:* about 2 minutes on a 25-route app.
- *Run contract:* it is a complete run of its own (the "complete or absent" contract stays). The skill then starts the
  deep sweep as the next run, and the board shows *deep sweep running* from the claim-style activity file (§6).
- *No live partial runs:* nothing fills a run folder in place; the board refreshes when the deep run completes.

Tests: the ranking is deterministic, and a quick run is a valid run (manifest, findings, ledger fold).

## 6. Several agents at once (Claude Code, Codex CLI, or two sessions)

**Shared state, separate work.** Every agent uses the same `.nunchi/`. What must not collide:
1. *Ledger and state writes.*
   - Every state file is written atomically: write `name.tmp-<pid>-<rand>` in the same folder, `fsync`, `rename`.
     On Windows, retry the rename on `EPERM`/`EBUSY` up to 10 × 50 ms.
   - Read–modify–write of `ledger.json` happens under a lock file `ledger.lock`, created with `wx` (`O_EXCL`). It holds
     pid, host and start time. A lock older than 30 s whose pid is gone (`process.kill(pid, 0)` on the same host) is
     stale and is taken over.
   - Decisions are already one new file each, so they never collide.
2. *Claims.* `.nunchi/state/claims/<group>.json` = `{agent, vendor, branch, worktree, files[], startedAt,
   expiresAt}`.
   - A claim lasts 30 minutes and is renewed by every `fix` command. `fix --start` refuses when a live claim covers
     the group or any of its root-cause files.
   - Expired claims are released, with a line in the board's activity.
3. *Working trees.* The fix loop needs a clean tree, so two agents fixing at once must use separate git worktrees.
   `fix --start` refuses a worktree another live claim already uses, and the skill tells the user to run
   `git worktree add`. Merging their branches is the user's (or their PR flow's) job.
4. *Hunts.* Answers gain `agent` and `vendor`. `hunt --record` keeps answers per (unit, agent) instead of replacing:
   a finding is grounded independently per agent, and the same fingerprint from two agents becomes one item with
   `agents: [...]`.
5. *Cross-vendor verification.* When the hunter and the verifier are different vendors, the verdict is labelled
   `cross-vendor` (H7). Still never auto-approved in 0.1.

**Board activity.** A *Now* list from live claims and in-progress runs: who, what, since when.

**Tests.**
- Two processes folding at once lose nothing: a stress test with 2 × 50 folds.
- A stale lock is taken over; a live one is not.
- Claim conflicts on a group and on a shared file.
- Two agents' answers on one unit are both kept.

## 7. Cross-cutting

### 7.1 State store
One module, `src/state.mjs`: atomic write, lock, read with schema check. Every state writer (ledger, claims, fixes,
metrics, approved) goes through it. The migration is mechanical and comes first in the §1 PR.

### 7.2 Determinism
- Board, fix and claim timestamps live only in state files, never in evidence.
- `export --format md|json` is deterministic; `sarif` too (no timestamps in the run object).

### 7.3 Security summary (threat → control)

| Threat | Control |
|---|---|
| A website the user visits drives the board (CSRF, DNS rebinding) | token, Host allow-list, Origin check, no CORS, 127.0.0.1 only |
| App text in evidence runs as script in the board | `textContent` only, CSP `script-src 'self'` |
| App text steers the hunter, verifier or fixer | quoted as data in every brief (H8), never followed; tests with injection strings in fixtures |
| Board serves arbitrary files | allow-listed names, manifest-checked ids, `realpath` containment |
| Fix loop runs arbitrary commands | only approved `package.json` script lines plus `git`; a changed line needs approval again |
| A decision from git dismisses a blocker | provenance N1 (exists) |
| Secrets in exports | already redacted at capture; re-scan in export tests |

## 8. Gates still open, and how each is measured

| Gate | Plan | Needs |
|---|---|---|
| Held-out benchmark (blind re-measure) | after #20 merges: a new builder agent makes held-out app 2 (different domain and stack again, e.g. Vue + Vite or SvelteKit); rule bench ×2 and AI gate ×3, recorded once | owner OK on cost (~15M subagent tokens last time) |
| Precision ≥ 85% (50 labels) | `nunchi label` (CLI) and the board's label mode: a stratified sample of 50 **confirmed** AI findings from the field apps (not the benchmarks), ≥ 5 per AI lens, shown with evidence only; the owner labels correct/wrong | §1 built; the owner's ~30 minutes |
| Codex CLI comparison | the same packets for Pebble and held-out 2, hunted by Codex CLI, scored by `ai-gate.mjs` | the owner's Codex access; the skill's steps work without Claude-only tools (a check of `SKILL.md`) |
| Fix loop ≥ 90%, 0 regressions | `bench/fix-gate.mjs` (§3) | §3 built |
| Time: 25 routes first run ≤ 15 min, incremental ≤ 3 min | measured on a field app with ≥ 25 routes; `--quick` + deep sweep + hunt budget | §5 |
| Decision time median ≤ 10 s | board metric (§2) over the owner's first 50 decisions | board built |
| Field test: 3 apps, ≥ 5 "didn't know, worth fixing" each | app 1 done (preview); apps 2–3 public vibe-coded apps, owner labels | owner judgement |
| Stop / pivot (H16) | evaluated after the precision gate | — |

## 9. Owner decisions needed

1. First screen of the board: Progress (recommended) or Findings.
2. Default grouping in Findings: by kind (recommended) or by screen.
3. Board language: English only (recommended for 0.1), or a Korean toggle.
4. May the fix loop run the repo's `build/typecheck/lint/test` scripts after a one-time approval of the exact lines
   (recommended), or should only the AI run them?
5. Held-out app 2 now, at roughly the same cost as the first (~15M subagent tokens)?
6. Codex CLI access for the comparison gate.

## 10. Milestones (one PR each, in order)

| # | PR | Depends on | Done when |
|---|---|---|---|
| M0 | merge #20 (engine fixes) | owner | merged |
| M1 | `src/state.mjs` (atomic + lock) + AI findings in the ledger (§1) + re-check packets | M0 | tests in §1, §6.1; Pebble bench unchanged |
| M2 | Board server + Progress/Findings/Detail + decide + labels + metrics (§2) | M1 | security tests; decide parity; offline |
| M3 | Fix loop engine + skill steps + fix gate harness (§3) | M1 | outcome tests; fix gate measured on Pebble |
| M4 | Guards + `check` + exports (§4) | M3 (guards come from fixes) | fixtures per guard; SARIF schema test |
| M5 | `--quick` first run (§5) | M1 | ranking tests; time measured |
| M6 | Claims + multi-agent answers + board activity (§6.2–6.5) | M2, M3 | concurrency tests |
| M7 | Coverage and Screens views; then the 0.2 views if time allows | M2 | — |
| G | Gates: held-out 2 (any time after M0), precision labels (after M1+M2), Codex (after M1), fix gate (M3), time (M5), field test 2–3 (after M2) | — | spec §9 updated per gate |

## 11. Review log

Filled in after the expert reviews of this draft (security, systems and data, UX and workflow, measurement).
