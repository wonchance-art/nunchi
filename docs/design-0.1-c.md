# nunchi 0.1-c — integrated design (v2, after expert review)

Status: **draft v2 for owner approval**, 2026-10-14 KST.
- v1 was reviewed by four independent experts (security, systems and data, UX and workflow, measurement) and one precedent
  survey; §13 maps every finding to its resolution.
- Once approved, each section is folded into `docs/spec-0.1.md`, which stays the source of truth.
- Base: main `3e29b26` plus PR #20 (engine fixes, open).

> 한국어 요약
> - **새 원칙 ①**: 「엔진의 검사는 정직한 실수를 막을 뿐, 오염된 AI 에이전트를 막지 못한다」를 신뢰 모델로 명시한다.
>   사람만 쓰는 통로(보드 · 사용자 터미널)를 두고, 그 통로에서 나온 결정만 결함 해제와 수리 시작을 확정한다.
> - **새 원칙 ②**: 「고침」은 범위가 같은 다시 찍기에서 사라졌을 때만 인정한다. 일부만 찍은 실행은 무엇도 고쳐졌다고 하지 않는다.
>   지금 장부에 이 버그가 있어 먼저 고친다(M1a).
> - **측정**: 계획한 표본(라벨 50개, 렌즈당 씨앗 3–4개, 감지기 검증 없는 「회귀 0」)으로는 관문이 주장하는 바를 입증하지 못한다.
>   사전 등록, 블라인드 라벨, 표본 확대, 심어 둔 회귀로 바꾼다. 비용과 사람 손이 드는 결정은 §11에서 오너가 정한다.
> - **순서**: 기존 결함 수정(M1a) → 상태 저장소 · AI 지적 장부화(M1) → 보드(M2) → 수리 루프(M3) → 방지 · `check` · 내보내기(M4)
>   → 빠른 첫 실행(M5) → 여러 에이전트(M6) → 나머지 화면(M7). 관문 측정은 각 단계 사이에 끼운다.

## 0. Where we are, and defects found in the existing code

| Area | State | Blocks 0.1 because |
|---|---|---|
| Evidence, rule lenses | done | — |
| AI hunt, canaries, verifier, decoys | engine done | AI findings never reach the ledger (§2) |
| Ledger, decisions, provenance | done for rule findings | **existing defects below**; no AI items; no claims (§2, §8) |
| Board, fix loop, guards, `check`, exports, quick run, several agents | not built | §3–§7 |
| Gates | rule recall, determinism, fingerprints and clean-FP pass on the benchmarks | most remaining gates are not yet measurable as specified (§9) |

**Existing defects** (verified by the reviewers against the code; fixed first, in M1a, each with a regression test):

| # | Defect | Where | Effect today |
|---|---|---|---|
| D1 | A fold marks items *gone* whenever the route is in scope, ignoring states, viewports, scene status and whole-app detectors | `ledger.mjs` gone loop, ~L120–129 | `--states normal` "fixes" every error-state finding; `--viewports m` "fixes" desktop-only and parity findings; a failed or redirected scene "fixes" its route; `--routes` "fixes" the secret finding and the flow findings |
| D2 | Folds are not monotonic | `foldRun` | an older run folded after a newer one sets `goneAt` older than `lastSeen` |
| D3 | A complete run can be left unfolded | `cli.mjs` — `finishRun` before `updateState` | a crash between them leaves a `latest` run the ledger never saw |
| D4 | Provenance can be forged | `ledger.mjs` `approved.has(d.id)`, `readDecisions` | a committed decision that reuses an approved id, or is dated in the future, dismisses a blocker or outranks later decisions |
| D5 | Approvals can be wiped | `readApproved` swallows a parse error; `addApproved` has no lock | the next write erases every approval; two concurrent decides lose one |
| D6 | In-place writes of committed or shared files | `writeDecision`, HAR `save`, `writeStable` for run files | a torn decision file is silently skipped; a torn HAR crashes the next capture |
| D7 | Input values are captured | `collect.mjs` falls back to `el.value` | a key shown in a settings field lands in `controls.json` and in claims |
| D8 | Secret masking keeps 4 characters | `rules.mjs` `mask` | against the rule "location and kind only" |
| D9 | git diff runs repo-configured programs | `runs.mjs` `workTree` `git diff` | `diff.external`, textconv and `core.fsmonitor` from `.git/config` run during capture |
| D10 | No base-URL guard | `capture` only checks `--url` is present | "never production" is only an instruction |
| D11 | Replay misses go live, writes included | `capture.mjs` replay handler | a stale recording can send POST/PUT/DELETE to a real backend |
| D12 | Signed-in evidence and HAR are world-readable | default umask | 0644 screenshots and API data on shared machines |

## 1. Trust model (new; governs §2–§7)

**Who is trusted for what.**
- The **engine** is trusted to be deterministic and to check grounding, scope and preconditions.
- The **AI agent** (hunter, verifier, fixer) is useful but untrusted. App text can steer it (prompt injection), so any
  control that only holds when the agent is honest is labelled as such.
- The **human** is the only party who can confirm that a defect may be left in place, or that code may run.

**Channels.** Every decision, approval and label records how it was made:
- `channel: "board"` — through the board UI, with the session token; the token is never shown to the agent (§3).
- `channel: "cli-tty"` — `nunchi decide` run in the user's own terminal. It needs stdin and stdout to be TTYs plus a
  typed 4-character confirmation code.
- `channel: "cli-agent"` — anything else, including the agent running `decide` after the user answered in chat.
- `channel: "git"` — arrived through a commit (exists today as "not approved").

**What each channel can do.**

| Action | board / cli-tty | cli-agent | git (until approved by a human channel) |
|---|---|---|---|
| Fix (start the fix loop) | yes | yes, for confirmed AI or rule findings, shown as "recorded by your AI" | no |
| Keep / Not a problem / Later | yes | recorded and shown; does **not** clear the finding from "Ready to ship" until confirmed in the board | display only |
| Approve check scripts, lens packs, labels | yes | **no** | no |

This keeps the chat path working for Codex and terminal users: the agent records what the user said. A dismissal only
becomes final once a human channel confirms it, in one batch screen ("3 decisions recorded by your AI — confirm").

**What the plugin enforces in addition** (Claude Code PreToolUse hook shipped with the plugin; Codex: documented as not
available, so the board confirmation above is the boundary there):
- deny Bash commands that run `nunchi … approve | label | fix --approve-checks`;
- deny requests to the board's port;
- deny Write/Edit under `.nunchi/state/**`, `.nunchi/decisions/**` and `.nunchi/lenses/**`.

**Honest limits, stated in the README and §8.3.**
- Claims coordinate cooperating agents; they do not stop a malicious one.
- Running the fix loop runs the repo's code; use a container for repos you did not write.
- Lens packs in a cloned repo are prompts; they need approval (§8.3).

## 2. AI findings in the ledger (M1)

**2.1 Fold contract (also fixes D1–D3).** A fold is
`foldRun(state, {run, source, coverage, detectors, health, findings, mode})`:
- **Keyed by `(run, source)`.**
  - `source` is `rule`, `ai`, `recheck` or `fix`.
  - `folds[]` replaces today's `runs[]` idempotence: `{run, source, key}`, where `key` is a hash of the inputs.
  - Re-folding a `(run, source)` with a different key replaces that contribution, so re-verifying works.
- **Cells.** Every item stores the cells it was seen in, `person.state.viewport` per route. `coverage` is built from
  `manifest.scenes`: status `captured`, not redirected, not a canary copy.
- **Gone only like-for-like.** An item may get `goneAt` only when all of these hold:
  1. every one of its last-seen cells was captured in this run;
  2. its detector class ran:
     - route-less findings (secrets), flow (unreachable / missing route) and L4 one-offs need `wholeApp`;
     - phone/desktop parity needs both viewports;
     - forced-state findings need both states of the pair;
  3. health has no `app-unreachable` or `recording-stale`, and no `login-expired` for signed-in cells.
- **Monotonic.** A fold whose run is older than the source's watermark is *presence-only*: it adds new items and
  updates examples, but never sets `goneAt` and never moves `lastSeen` back.
- **Catch-up.** Under the ledger lock, every fold first folds any complete run not yet folded, in id order.
- **Run metadata.** `run.json` gains `kind` (`sweep`, `quick` or `fix-probe`), `wholeApp` and detector flags.
  `quick` and `fix-probe` runs never fold as sweeps (§5, §6).

**2.2 What enters from AI.**
- `verify --record` folds the run's AI findings, keyed `(run, "ai")`, and refuses a run without an id.
- Canary copies are excluded.
- Grounding (selector or file:line) is re-checked against the run before an item is accepted, so a hand-written
  `ai-findings.json` cannot skip `hunt --record`.
- **Statuses and precedence**: human decision > latest non-suspect verdict > suspect verdict > claimed.
  - `rejected` and `insufficient` never become items; they stay in `ai-findings.json` for trust.
  - `claimed` (not double-checked) items are kept in a separate, collapsed section (§3.4).
- **A run is suspect when** its decoy pass-through is > 10%, **or it had fewer decoys than planned**: today a run whose
  pages offer no decoy target is never suspect, and that is wrong.
- **Severity.** Protection (blocker / L9 rules) uses `max(claimed, corrected)`; display uses the corrected one.
- **Group decisions** apply to an AI item only if the item is confirmed and not suspect, or if the decision was made
  after its latest verification. Otherwise it shows as *not double-checked*. For blocker and L9, a group decision never
  covers a new fingerprint.
- **Answer keys** (`hunt-key.json`, `verify-key.json`, `recheck-key.json`) move out of the project, to
  `$XDG_STATE_HOME/nunchi/<repo-hash>/keys/` (Windows: `%LOCALAPPDATA%`), mode 0600, and are covered by the deny hook.
- **Trust** is keyed by `(lens, source)`, because rule and AI share L1, L2, L4, L6, L7, L9 and L10.

**2.3 AI fingerprints.** `fingerprintOf` gets an AI branch. Today the AI evidence (`claim`, `unit`, `groundedIn`,
`line`) changes between hunts.
- Evidence key = `{element: normalizeSelector(selector) | null, file: evidence.file | null, anchor: sha(trimmed source
  line) | null}`; `inputs.source = "ai"`. `aria=` selectors are canonicalised to the `controls.json` selector when the
  accessible name matches exactly one control.
- **Group (AI)** = lens + checklist item + component identity: the grounded file, or the inventory file and symbol that
  renders the element, plus the accessible name. When neither is known, the group is the fingerprint. This stops one
  dismissal covering every structurally similar button in the app.
- `fingerprintVersion` stays 1, because no AI item exists yet; the change is gated on `source === "ai"`.
- Contract test: two hunts with a different reference scene, different claim wording and a source line moved by 3 give
  the same fingerprint.

**2.4 When an AI item is fixed: re-check.** A fresh hunt's silence is not evidence; hunts vary.
- An AI item becomes `fixed` only from a non-suspect **re-check**: one packet per (item × cell it was seen in). Each
  packet carries the old evidence (crop and box from the old run) and the new scene, and asks *"is this defect present
  anywhere in the new scene?"*.
  - Verdicts are `gone | still-there | insufficient`. Every cell must be `gone`.
  - `insufficient` leaves the item open and marks it *needs you*.
  - Packets carry no diff, commit message or fix brief.
- **Controls point the right way.** Each re-check batch carries known still-present claims as controls, whose correct
  answer is `still-there`: rule findings present in the new run, phrased as claims, and canary copies. A control
  answered `gone` counts as pass-through; > 10% makes the batch suspect, and a suspect batch never sets `goneAt`.
  (False-claim decoys would reward a verifier that says `gone` to everything.)
- **Skip when nothing changed.** When the scene's `top`, `full` and `textHash` are unchanged, and so is the hash of any
  grounded source file, the item is still there: `lastSeen` moves and no packet is sent. Only `to-fix` / `fixing` items,
  or items whose scenes changed, are re-checked.
- **Staleness.** After 2 hunts that saw the cell but did not claim the item, it becomes `stale`: shown apart, out of
  `fix --plan`, still decidable. This stops re-hunts with different selectors from growing the list without bound.
- `verify --plan --again` re-verifies a suspect run.

**2.5 Schema 2** (migrated on read; a corrupt state file is an error, never "empty").
- Items gain `source`, `cells`, `verification {status, by, vendor?, suspect, run}`, `lastHunted` and `silentHunts`.
- Run files gain `recheck-packets.json` and `recheck.json` (the key lives outside the project, §2.2).
- In hunter answers and fix records, `evidence.file` replaces today's overloaded word "source".

## 3. Board — `nunchi open` (M2)

**3.1 Process and lifetime.**
- `nunchi open` starts a **detached** server and exits 0, so an agent's command never blocks. `--no-browser` skips
  opening the browser; `--stop` stops the server.
- The server exits after 2 hours idle.
- A second `nunchi open` finds the running server through `state/boards/<pid>.json`, which holds the port only, never
  the token. It then asks that server, over a local socket (mode 0600), to open the browser with a fresh one-time link.
- When stdout is not a TTY (the agent ran it), the link is **never printed**: the server opens the browser itself and
  prints `board open on 127.0.0.1:<port>`.

**3.2 Server security** (`node:http`, no new dependency).
- *Bind:* 127.0.0.1 only. Only `127.0.0.1:<port>` is printed and accepted in `Host`, never `localhost` (it may resolve
  to `::1`, where another process can listen). Otherwise 421.
- *Token:* 32 bytes, per launch, in memory only.
  - The browser opens `/#t=<token>`. The page reads it, then calls `history.replaceState(null, "", "/")`.
  - Every request uses `fetch` with `X-Nunchi-Token`, compared as `timingSafeEqual(sha256(a), sha256(b))`.
  - Images are fetched and shown as blob URLs. The live channel is a `fetch` stream (`ReadableStream`), not
    `EventSource`, because neither `<img>` nor `EventSource` can send headers.
  - So no request, static files included, works without the token, except the bare page shell.
- *Request checks:* `Sec-Fetch-Site` must be `same-origin` or `none` when present. `req.url` must start with `/`.
  Writes are POST with `Content-Type: application/json`, `Origin` equal to the board's origin, and a body ≤ 64 KB.
  No CORS headers; OPTIONS → 405.
- *Response headers:*
  - CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self';
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`;
  - `Cache-Control: no-store` on everything (screenshots of signed-in pages).
- *Files:*
  - Only bundled board assets, plus evidence files from an allow-list of names.
  - Run and scene ids are checked against `manifest.json`. The run folder must not be a symlink (`lstat`), and
    containment is checked against `realpath(.nunchi/runs)`. The file is opened with `O_NOFOLLOW`, `fstat`ed and served
    from that descriptor.
  - Content-Type comes from the allow-list. No SVG.
- *Untrusted strings:*
  - Every string the board code did not write (app text, claims, git decision `by`/`note`, lens pack text) is rendered
    with `textContent`.
  - App URLs are never live links (plain text, or a link only to the captured base origin).
  - Colours are applied only after `CSS.supports("color", v)`, via `style.backgroundColor`.
  - Search is a plain substring match.
- *Offline:* no external fonts or scripts; system UI fonts.

**3.3 API** (all with the token).

| Method | Path | Does |
|---|---|---|
| GET | `/api/summary` | the verdict, counts, since last full check, health, activity — one function `summary()` shared with `findings --json` |
| GET | `/api/groups?status=&lens=&q=&group=` | groups for the list |
| GET | `/api/groups/:id` | one group: items, cells, evidence pointers, history, claim |
| GET | `/evidence/:run/:scene/:file` | an allow-listed evidence file |
| POST | `/api/decide` | `{targets[], decision, reason, note?, batch?, ms?}` → `writeDecision` with `channel: board` |
| POST | `/api/confirm` | confirms `cli-agent` decisions in one batch |
| POST | `/api/approve-checks` | approves a check profile (§4.3) |
| GET | `/api/live` | a fetch stream of `generation` changes |

`/api/label` exists only in label mode (`nunchi open --label`, §9.2).

**Live updates.**
- Every state write bumps `state/generation` (atomic, under the lock). The server watches only that folder,
  non-recursively, with a 200 ms debounce and a 3 s poll of that one file.
- `ENOENT` and `ENOSPC` fall back to polling. A JSON parse error means retry, never a crash.

**3.4 Interaction rules** (from the UX review; the agreed mock-up v3 stays the layout).
- **Verdict formula.** "Ready to ship? **Yes**" only when all of these hold:
  - no blocker or high is open, to fix, held, needs you, or not double-checked;
  - the last full check is newer than the last fix commit;
  - no confirmed AI item at blocker or high is suspect.

  Otherwise the verdict names what stands in the way:
  - "Not yet · 1 blocker, 6 high: 4 to decide, 3 waiting for the AI"
  - "Probably · rules only — the AI review hasn't run"
  - "Yes, for what was checked · 3 screens not checked"
  - "Too early to say · full check running" during a quick run.
- **Since last run** compares with the last full check, labelled "Since last full check (run 0007)". Probe runs are
  hidden from `runs` by default and removed first by `gc`.
- **One-key decisions that cannot misfire.**
  - Keys:

    | Key | Decision |
    |---|---|
    | F | Fix |
    | W | Keep = intended |
    | Shift+W | Keep = out of scope |
    | X | Not a problem = nothing wrong here |
    | Shift+X | Not a problem = right issue, wrong spot |
    | S | Later |

  - After each decision a 6-second toast offers the other reason and Undo (Z). The API always sends an explicit reason.
  - Buttons carry permanent sub-labels: Keep "Real, but leave it" · Not a problem "nunchi got it wrong" · Later "Still
    counts for shipping".
- **The list never moves under the keys.** While Findings or Detail is open, order and membership are frozen; a banner
  says "Updated: 2 new, 1 fixed · Show (R)". A focused row whose status changes updates in place. Decisions always
  target group ids.
- **Batches.**
  - Group by kind (default) · root-cause file · screen · lens. Each section has "Decide all N ▸".
  - Space toggles a row; Shift+J/K extends the selection.
  - One decision file per group with a shared `batch` id, so Z undoes the batch.
  - Confirm only dismissals that include a blocker, an L9 item or > 10 groups ("Mark 17 groups Not a problem? 2 are
    high.").
- **Not double-checked AI items** sit in a collapsed last section with [Ask the AI to double-check], which shows the
  message to copy. Fix on such an item asks "This hasn't been double-checked. Fix anyway?".
- **Default order:** severity → regressed → new since last full check → reach (screens) → rule before AI.
- **Detail.**
  - The screenshot is cropped to the box plus about 200 px of context; key `0` shows the whole screen.
  - The box is drawn white plus dark, dashed, so it reads on any screenshot and does not rely on colour.
  - "Seen on 17 screens · [ / ] to flip".
  - The next 2 groups' images are preloaded.
  - Code location has [Copy path] and a `vscode://file/` link.
- **Handoffs.**
  - When Open reaches 0: "All decided. 6 to fix. Go back to your AI chat and say *fix them*." [Copy].
  - The same line appears under the verdict.
  - The skill, after opening the board, says: "Decide in the board, then tell me *fix them*."
- **Fix states on the board.**
  - A live claim shows "Claude is fixing · 3 min". Deciding against it warns: "Claude is fixing this right now. Stop and
    mark Not a problem?".
  - *Needs you* has three kinds, each with actions:
    - (a) "The fix also changed other parts of this screen (4%). Is that OK?" → [Looks fine, mark fixed] [Undo this fix]
      [Try again with a note…]
    - (b) "The AI couldn't fix this in 2 tries." → [Try again with a note…] [Keep] [Later]
    - (c) "Couldn't re-check: the screen didn't load." → "Start your app, then tell your AI *retry*."
  - Before/after is side by side with a slider (←/→), for both viewports.
  - "Looks fine" counts as fixed only when the defect itself is gone.
- **Undo and reopen.** Z undoes the last decision or batch of the session by writing `reopen`. Detail history has
  [Reopen]. Undoing a fix that already landed is the AI's `fix --undo <group>`; the board shows the sentence to say.
- **Accessibility.**
  - The list is a listbox with roving focus. Sections are headings, tabs are a tablist with arrow keys, and the decision
    bar is a toolbar.
  - After a decision, focus moves to the next row, and `aria-live=polite` says "Kept (intended). Next: Raw error text,
    high, 4 screens".
  - The Now line is announced at most every 10 s.
  - Single-key shortcuts can be turned off (WCAG 2.1.4), and keys are off in text fields. `?` shows help; `/` searches.
  - Severity uses text plus shape. The board honours `prefers-reduced-motion` and `prefers-color-scheme`, and holds at
    200% zoom.
- **Views.** The sidebar lists only built views. A footer link "More views in 0.2" lists the CLI commands that show the
  same data.
- **Words** (one strings table, so a Korean toggle is cheap later):

  | CLI and spec | Board |
  |---|---|
  | fix / to-fix | Fix / To fix |
  | keep / kept | Keep / Kept |
  | false-positive / dismissed | Not a problem |
  | hold / held | Later |
  | needs-human | Needs you |
  | caused-regression | Broke something else — undone |
  | not seen: budget | Not checked: AI budget ran out |
  | evidence tree ≠ working tree | Screens are from before your latest edits · Re-check |

  `decide` also accepts `not-a-problem` and `later`. Times show as relative or local; storage stays KST.

**3.5 Decision-time metric.** The time from showing a group to its first key:
- paused while the tab is hidden (`visibilitychange`) and after 30 s idle;
- capped at 120 s;
- a batch is recorded once with its size;
- *Later* is recorded apart.

Stored in `state/metrics.json`, never sent. `nunchi trust` prints singles and batches separately. The gate protocol is
§9.6.

## 4. Fix loop — `nunchi fix` (M3)

**4.1 Split of work.** The engine never edits code. The skill edits; the engine plans, checks preconditions, captures
and judges. An outcome comes only from the engine's probes.

**4.2 Branch and working tree.**
- `fix --start` refuses on the default branch. It creates `nunchi/fixes-<date>` from HEAD (or a per-group branch when
  several agents work, §7).
- A dirty tree is refused, and the skill offers the user one choice, once, in the fix plan:
  1. commit the changes as "WIP before nunchi fixes" (recommended);
  2. stash them;
  3. stop.
- The plan says: "Fixes go on branch nunchi/fixes-1014; merge it when you're happy."

**4.3 Checks.** The engine runs the repo's checks, so "checks passed" is not the AI's word.
- **Check profile**, approved once through a human channel (board card or `cli-tty`), never by the agent. It contains:
  - the exact `build`, `typecheck`, `lint` and `test` script lines;
  - their `pre*` and `post*` lines;
  - the sha256 of `.npmrc`, `.yarnrc*`, `.yarnrc.yml` (and its `yarnPath` target), `bunfig.toml`, `pnpm-workspace.yaml`
    and `.pnpmfile.cjs`;
  - the `packageManager` field.

  Any change asks again. Stored in `state/scripts-approved.json` (`approved.json` stays decision provenance).
- **Running.**
  - `npm run --ignore-scripts <name>`, or the pnpm, yarn or bun equivalent, verified per version in the
    implementation PR;
  - `shell: false`, with environment `PATH, HOME, LANG, TERM, CI=1, NODE_ENV=test` only;
  - corepack never downloads (`COREPACK_ENABLE_AUTO_PIN=0`), and a missing package-manager binary is refused;
  - 10-minute timeout;
  - output passed through the secret scanner before it is stored or printed.
- **Baseline.** Checks run once at `fix --start`. A check blocks the commit only if it newly fails, or its error count
  rises: "lint was already failing before this fix (40 problems) — not blocking; still 40 after." A missing script is
  said plainly: "no test script — nunchi relies on re-capture."
- `--checks` records the tree hash it ran on; `--verify` requires a passing record whose tree equals the commit's.

**4.4 Probes, not runs.**
- `fix --start` captures **P0**: scope = the group's routes plus the routes rendering its root-cause files; all persons,
  both viewports, the baseline's states. It uses strict replay from a HAR snapshot (sha recorded) and PNG first views,
  with whole-app detectors off. `run.json` gets `kind: fix-probe`.
- `fix --verify` captures **P1** with identical options, on P0's scope plus `affectedRoutes(diff base..HEAD)`. Routes
  added there have no baseline, so a new finding on them gives *needs you*, not a revert.
- Under strict replay, a request with no recording is aborted and counted, never sent live; any miss gives *needs you*.
  This also fixes D11 for probes, and `capture --network replay` gets the same strictness.
- **Proof the served code is the commit.** The engine either starts the app itself from the worktree with the approved
  start script (`--serve`), or writes a probe file into the worktree's static folder and fetches it back. Without that
  proof the outcome is *needs you*.
- The base URL must be loopback, a private address, `*.local`, or listed in a user-written `.nunchi/config.json`
  `allowHosts`. This fixes D10 for every capture.
- Probe runs are folded only for the group's fingerprints, and only on outcome `fixed` (source `fix`). On revert they
  are discarded. They are pinned against `gc` until the attempt closes.

**4.5 Judging.**
- **Same defect, not same fingerprint.** A wrapper `<div>` changes selector paths. Matching is by
  `(rule, cell, element identity)`, where element identity is either the normalised selector, or the same tag, the same
  accessible name and a box overlap (IoU) ≥ 0.5.
- **Flaky rules** (`layout-shift`, `font-not-loaded`, `page-error`) are re-captured once on that scene before they count.
- Chunk-hash URL segments (`[0-9a-f]{6,}`) are normalised for secret findings. This is a rule-fingerprint change, so it
  is `fingerprintVersion` 2 with a migration of decisions through the stored inputs, in M1a.

| Precedence | Outcome | When | Then |
|---|---|---|---|
| 1 | inconclusive → *needs you (c)* | scene failed or redirected, a health problem, replay misses, or no proof of the served code | nothing reverted |
| 2 | caused-regression | a new defect by element identity in a cell of P0's scope (flaky rules re-checked) | revert; attempt counted |
| 3 | not-fixed | the defect is matched in any cell | **revert** (no unverified code stays); attempt counted |
| 4 | visual drift → *needs you (a)* | outside the finding's boxes, DOM geometry of the neighbouring elements changed, or PNG pixels differ by more than the calibrated threshold | commit kept, shown before/after |
| 5 | fixed | none of the above; for AI items, a non-suspect re-check (§2.4) from a fresh context (`fix --verify --record`) | fold P1 for this group only; claim released |

After 2 attempts the group is *needs you (b)*. The attempt count is derived from `git log` trailers, so it survives lost
state and works across worktrees.

**4.6 Diff policy.** `fix --verify` computes `git diff --name-only base HEAD`. It gives *needs you* when any of these
hold:
- a path matches `.nunchi/**`, `package.json`, a lockfile, `.npmrc`, `.yarnrc*`, `.env*`, `.github/**`, `.husky/**`,
  `.git*` or `*.config.*`;
- the diff adds a dependency, a script or an outbound URL literal;
- the diff touches a file outside the claim's root-cause files and the source-map files of the group's routes.

`--verify` prints the diffstat with the flagged paths. Root-cause files come from:
1. the grounded `evidence.file` (AI);
2. else the inventory files whose strings match the finding's text or element;
3. else the route's own page file.

They are never layout or frame files, so two groups don't all "share" `app/layout.tsx`.

**4.7 Git hardening.**
- Every git call runs as
  `git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat --no-optional-locks`,
  with `--no-ext-diff --no-textconv` on diffs, `GIT_TERMINAL_PROMPT=0` and a timeout. This also fixes D9 in
  `workTree`.
- The commit check is `git rev-list --parents -n1 HEAD` = `[HEAD, base]`, plus the `Nunchi-Fix: <group>` trailer and a
  clean tree.
- Revert happens only when `HEAD == fixCommit`: `git revert --no-commit`, then a commit with the `Nunchi-Revert: <group>
  attempt <n>` trailer, hooks off, a 60 s timeout.
  - Any failure → `git revert --abort` and *needs you*.
  - Required signing that fails → *needs you*, never silently unsigned.
- Never push, reset or force.

**4.8 Records and recovery.**
- `state/fixes/<group>/<n>.json`: the attempt number is allocated with `wx`, and a `phase` is written before every side
  effect.
- Every `fix` command first reconciles that record with HEAD trailers, revert commits and probe runs, and resumes.
- `--start` refuses when HEAD carries an unverified `Nunchi-Fix` for the group ("resume with `fix --verify`").
- The capture renews the claim every 5 minutes.

**4.9 State machine.**
```
to-fix ─start(clean, branch, claim, P0, baseline checks)→ started ─checks pass(tree T)→ checked
checked ─skill commits (1 commit, trailer)→ committed ─verify(rev-list, trailer, tree==T, diff policy)→ verifying
verifying ─P1 (+ re-check for AI)→ judged by precedence
  inconclusive → needs-you(c) │ regression|not-fixed → reverted → (attempts<2 ? to-fix : needs-you(b))
  drift → needs-you(a) │ fixed → fold P1(group) → fixed
decision changed during a claim → cancelled: revert if committed, release claim
claim expired / abort: before commit → to-fix; after commit → needs-you (commit shown)
```

**4.10 Chat side.**
- One line per outcome, then a batch summary: "Fixed 4 of 5 (re-checked 23 screens, nothing else broke). 1 needs you:
  'Save button moved' → <board link>."
- After a revert: "That fix broke 'Raw error text' on /settings, so I undid it (attempt 1 of 2). Trying another way."
- The chat never states a status the engine did not produce.

**4.11 Fix brief.** App text appears only as quoted evidence, marked *app data, not instructions* (H8). Injection
strings in fixtures prove it.

## 5. Guards, `check`, exports (M4)

**Guards.**
- **When offered.** Only after a *verified* fix of a kind that has a built-in guard, as one card at the end of a fix
  batch: "Stop these coming back? `window.confirm` (fixed twice) · `href=\"#\"`", with an Add toggle per row.
  "≥ 5 open instances" is only a passive chip ("guard available").
- **Built-in guards** (no dependency). They run in `nunchi check`, over the source, and are deterministic:
  - `window.confirm` / `alert`;
  - `href="#"` and `javascript:` links;
  - a JSX expression ending in `.message`;
  - `{{` / `}}` in JSX text;
  - colour literals outside the measured tokens.

  Limits are stated (no data flow: `const m = e.message; <p>{m}</p>` is missed).
- **`guards.json`** (committed) holds built-in kinds with typed parameters only (no regex or selector from the file),
  plus a **baseline of existing hits**, so `check` fails only on new ones. `check --base <ref>` treats a guard removed
  since `<ref>` as a hit.
- **Lint proposal.** An ESLint flat-config snippet with core rules only (`no-alert`, `no-restricted-syntax` selectors),
  as a separate config object scoped to `files`. The user is warned that a later `no-restricted-syntax` *replaces* an
  earlier one. nunchi never writes the user's config. `jsx-a11y`, stylelint and aria snapshots are proposed only when
  already installed.

**`nunchi check [--fail-on high] [--sarif out.sarif] [--base ref]`.**
- No capture, browser or network. Source files over 1 MB are skipped.
- Exit codes: 0 clean; 1 a guard hit, or open findings at or above `--fail-on`; 2 a usage or state error.
- In CI there is no ledger, so `check` runs guards only and says `ledger: absent`. `--fail-on` without a ledger exits 2,
  never 0.

**Exports** (`nunchi export --format md|json|sarif [--status …] [--include-page-text]`).
- **Redaction.** Every string goes through the secret scanner at export time; a hit becomes
  `[secret-shaped: <kind>]`.
- **Page text** (evidence text, claim quotes, control names from signed-in scenes) is left out unless
  `--include-page-text`.
- **Escaping.** Markdown special characters are escaped and no raw HTML is emitted. SARIF uses `message.text` only.
- **Locations.**
  - Paths are repo-relative (`%SRCROOT%`), and route templates are used instead of URLs.
  - SARIF gives every result a `physicalLocation`: the finding's file, else the route's page file with `startLine` 1.
    The route and element go in `message.text` and `logicalLocations`.
  - SARIF also carries `partialFingerprints` (`nunchi/group/v1`, `nunchi/fp/v1`).
- **Levels.** blocker and high → `error`; medium → `warning`; low → `note`. `security-severity` is set only for L9.
- **Limits.** Truncated deterministically to GitHub's limits (to be re-verified in the PR), stating it.
- **Checks.** The SARIF schema is vendored as a test fixture. Markdown and JSON exports are byte-identical across two
  runs.

## 6. Fast first run — `capture --quick` (M5)

- **Scope.** Key routes only: `/` first, then routes linked from the home page's navigation landmarks, then one per
  top-level segment, up to 8. Normal state, both viewports, rule lenses only. About 2 minutes on a 25-route app.
- **Kind.** `kind: quick`: folded *presence-only* (adds and regressions, never `goneAt`); whole-app detectors off.
  `hunt` and `verify` default to the latest non-quick run.
- **Recordings.** A quick run records HAR for its routes. The deep run then **records with merge** whenever the recording
  lacks its routes, instead of replaying and going live (today it would become `recording-stale`).
- **No live partial runs.** The board shows: "First look: 8 key screens · full check running, 12 of 25 screens (about 6
  min left)". The verdict is "Too early to say" until the full check lands, then "Full check done: 16 new groups".
- Spec §7 ("fills the board live") is amended to this.

## 7. Several agents at once (M3 minimal, M6 full)

- **One shared state root.** `state/`, `claims/`, the ledger, approvals and fix records live under
  `$(git rev-parse --git-common-dir)/nunchi/`, so every worktree sees them. Runs stay per worktree and record it. Only
  runs on the tracked branch fold as sweeps; fix-branch runs are probes (§4.4).
- **Claims.** `claims/<group>.json` holds `{token, worktree, branch, url, files[], declaredAgent, declaredVendor,
  startedAt, lastRenewal}`.
  - Acquired under the claims lock, plus one marker per root-cause file (`claims/files/<sha256(path)>`, created with
    `wx`).
  - Expiry is computed by the reader as `lastRenewal + 30 min`, never from a value the writer set.
  - Worktree and branch come from `git rev-parse`, never from arguments. Agent and vendor are shown as "declared".
- **Each worktree needs its own app server.** `fix --start` and `--verify` require `--url` when the worktree differs, and
  refuse a URL another live claim uses. Copy: "Start the app from this folder on a free port (e.g. `PORT=3001 npm run
  dev`), then verify with `--url http://127.0.0.1:3001`."
- **Refusal copy** (never mentions worktrees on the single-agent path): "Claude Code is already fixing in this folder
  (branch nunchi/fixes-1014, 4 min). To fix in parallel: `git worktree add ../myapp-2 -b nunchi/fixes-2`, open that
  folder in Codex, start the app there on another port. Or wait: deciding and capturing still work here."
- **Hunts.** `agent` and `vendor` go in the answers file's header (`recordHunt` refuses unknown unit keys today). A cell
  is *seen* when any agent answered it completely, and a re-hunt replaces answers within the same agent only. The same
  fingerprint from two agents becomes one item with `agents: [...]`. A verdict whose verifier vendor differs from the
  hunter's is labelled `cross-vendor`; still never auto-approved.
- **Board activity.** "Now" lists claims and running hunts with progress: "Codex · AI review L6 · 12/40 units · 3 min".

## 8. Cross-cutting

**8.1 State store — `src/state.mjs` (M1).**
- `writeAtomic`:
  - tmp name `<name>.tmp-<pid>-<rand>` in the same folder;
  - fsync the file, rename, then fsync the folder (POSIX);
  - on Windows, retry `EACCES`, `EPERM` and `EBUSY` with backoff for up to 5 s;
  - leftover tmp files older than 1 hour are deleted on start.
- `withLock(name, fn)`:
  - `mkdir <name>.lock.d` plus `owner.json {token, pid, host, procStart, bootId, pidNs, at}`, with a heartbeat touch
    every 5 s;
  - **stale** = (same `bootId` and `pidNs`, and the pid is gone or its `procStart` differs) or no heartbeat for 30 s;
    `EPERM` means alive;
  - **steal** by renaming the folder to `<name>.lock.reap-<rand>`, re-reading its token, and proceeding only if it is
    the one judged stale;
  - **release** only while the token is still ours;
  - held only around read–fold–write, never across capture or network I/O; acquisition backs off for 5 s, then fails
    with a clear error.
- `ledger.json` keeps `rev`; a commit fails if another writer advanced it. `ledger.json.prev` is kept.
- `readJson` checks the schema and retries once. A corrupt file is an error (exit 2), never empty (fixes D5).
- Every write bumps `state/generation`.
- Folders are created 0700 and files 0600, evidence and HAR included (fixes D12).

**Writers that move to it:**
- ledger;
- `approved.json` (written *before* the decision file);
- decisions (tmp + rename; fixes D6);
- HAR saves (plus a lock per person);
- run files written after completion: hunt plan and key, hunt mirror, source slices, `ai-findings.json`,
  `coverage.json`, `canary-score.json`, verify packets, `verify.json`, re-check files (plus a per-run lock);
- the new files: claims, fixes, `fix-plan`, metrics, labels, `guards.json`, `scripts-approved.json`.

**`gc`** keeps every run named by a live claim, a fix record, an open item's `lastSeen` or evidence run, or a pinned
probe.

**8.2 Determinism.** Board, claim, fix and metric timestamps live only in state, never in evidence or exports.

**8.3 Threats and controls.**

| Threat | Control | Holds against a compromised agent? |
|---|---|---|
| A website drives the board (CSRF, DNS rebinding, cross-site images or streams) | 127.0.0.1-only Host, per-launch header token, Sec-Fetch-Site, CORP, no CORS | yes |
| The agent dismisses real defects or approves its own scripts or labels | channels (§1); dismissals need board confirmation; deny hook (Claude Code) | yes in the board; partly in the CLI (TTY + code) |
| A forged or future-dated decision from git | content-hash approvals, filename = id, folder = target, `at` ≤ now + 5 min, first-seen ordering, display-only until approved | yes |
| App text runs as script in the board | `textContent` only, strict CSP, no live app URLs | yes |
| App text steers the hunter, verifier or fixer | quoted as data (H8); outcomes come from engine probes; re-check controls | partly: the engine judges outcomes, not intent |
| The fix loop runs arbitrary code | check profile with pre/post and package-manager config hashes, `--ignore-scripts`, an allow-listed environment, diff policy, a human approval channel | **no**: the checks execute the working tree, so the diff policy and the human are the boundary. Stated in the README |
| A fix touches nunchi's control files, CI or package files | diff policy → needs you | yes |
| git runs repo-configured programs | hardened flags on every call | yes |
| Writes to a real backend during a fix | strict replay; base-URL guard | yes |
| Secrets or page data in exports or check output | export-time redaction, page text off by default, mask returns empty | yes |
| A cloned repo's lens packs or guards steer the tool | lens and guard packs need content-hash approval on first load or change; `guards.json` takes typed parameters only | yes |
| Two boards, stale boards | per-launch token, idle exit, `boards/<pid>.json` without the token | yes |

## 9. Measuring the gates (pre-registered)

Each measurement gets `docs/prereg-<gate>.md`, committed before it starts. It holds:
- the engine, scorer and answer-key hashes;
- seeds and sample sizes;
- the primary statistic and pass rule;
- exclusions and the amendment policy.

A scoring change after seeing results is an **amendment**: original and amended numbers are reported side by side, and
only a later fresh app can confirm it. Canary hit rate is a run-health number, never evidence for recall. Bounds below
are exact binomial (Clopper–Pearson), 95%.

**9.1 AI recall.**
- 3–4 seeds per lens cannot show 75%: 3/3 has a lower bound of 37%.
- **Primary.** Pooled recall on held-out seeds: ≥ 56 seeds over ≥ 2 fresh apps; pass if the lower bound is ≥ 75% (≥
  48/56 found).
- **Per lens.** Screening only (≥ 10 seeds pooled). A lens is experimental if its estimate is < 75% or it has ≥ 2
  misses.
- **Independence.** The unit is the seed; the CI is bootstrapped over seeds. Each run varies a plan salt (reference
  choice) and packet order on a fresh capture.
- **Packets.** Built from a random unit sample with ≥ 3 non-seed units per seed unit, interleaved.
- **Scoring.** The answer key carries element locations, and a hit needs the same location; human adjudication is
  blind to the run.
- **Budget recall.** End-to-end recall at the default budget is reported too.
- **Post-verification recall.** On confirmed claims only, with the same target; the verifier may reject ≤ 10% of seed
  hits.
- **Pebble** is the development set: reported, never pooled.

**9.2 Precision.**
- 50 labels cannot show ≥ 85%: 43/50 gives 74–94%.
- **Unit.** The ledger group.
- **Pool.** Blinded and mixed: the sample, ~15% verifier-rejected claims, ~10% decoys and ~10% known-true items. Source
  and verdict are hidden, and the lens definition, claim and evidence are shown.
- **Strata.** Confirmed (main), rejected (≥ 20), insufficient (all, up to 20), not double-checked (≥ 10), weighted back
  to the population.
- **Rubric.** Correct iff the defect exists in the cited scene, at the cited element or its ancestor or descendant, is a
  defect under the lens definition, and is not a rule finding. Severity is labelled apart; *unsure* counts as wrong; if
  it is > 10%, the gate is inconclusive.
- **Labellers.** The owner plus a second labeller who did not build nunchi (≥ 50% of the pool); κ ≥ 0.6. An item is
  correct only if both agree. The labeller is validated on the known items: decoy acceptance ≤ 10%, known-true ≥ 90%.
- **Two options for the target** (owner decision §11):
  - (a) n = 50, published as an estimate with its interval, e.g. "86% (74–94)";
  - (b) n = 150 groups from ≥ 3 apps, pass at ≥ 135.
- `nunchi open --label` provides label mode: its own keys 1/2/3, a banner "Labelling for the precision check ·
  23/50", and no decision bar. Labels are stored as `.nunchi/labels/<fp>.json`.
- **Rule precision on field apps** (new): a blinded sample of ≥ 100 groups, rules frozen, ≥ 85% with the lower bound
  reported.

**9.3 Clean scenes.** ≥ 30 clean scenes per app, clean units in every run, verified, confirmed false positives labelled,
gated on the upper bound.

**9.4 Fix loop.**
- **Trials.** Each seeded group is an independent trial from a fresh copy, in a pre-registered seeded order, plus one
  sequential pass.
- **Functional checks.** One per seed, scripted before the run: the control is still visible with its name, the image
  renders, the route is still reachable. A "gone" that breaks it counts as not fixed.
- **Reporting.** First-attempt and two-attempt rates; *needs you* counts as not fixed. A human reviews ≥ 10 diffs blind
  to the outcome.
- **Field sample.** ≥ 20 confirmed field groups decided `fix`.
- **Detector sensitivity**, before "0 caused regressions" means anything. Built by someone other than the fixer:
  - ≥ 30 planted in-scope regressions, which must be detected as regression or needs-you ≥ 28/30;
  - ≥ 20 clean fixes, with ≤ 1 false alarm;
  - ≥ 10 out-of-scope regressions (copy, logic), recorded as known blind spots.

  The claim is then "0 detected in N (true rate ≤ 3/N), detector sensitivity X%".
- **Re-check validation** (§2.4): ≥ 30 each of still-there, already-fixed (canary claims asked on their original scene)
  and moved cases; false "gone" ≤ 1/30, false "still there" ≤ 3/30.

**9.5 Time.**
- T1: invocation → quick-run findings on the board.
- T2: deep capture plus rule lenses.
- T3: AI hunt at the default budget plus verification, folded into the ledger.

The ≤ 15 min target applies to T3 (or the claim says "rule-lens first run"). The protocol: a reference machine and a
lower-spec machine, a pre-chosen app with ≥ 25 routes, 3 cold runs, median and max; setup and the app build reported
apart; AI tokens and latency reported.

**9.6 Decision time.** A task study:
- 30 groups from an unseen field app, pre-classified trivial / medium / hard, with gold decisions;
- ≥ 5 participants who did not build nunchi, with order counterbalanced; the owner is reported separately;
- the median for trivial and medium must be ≤ 10 s, with agreement with gold ≥ 80%; the hard median and p90 are
  reported without a gate;
- the learning curve is reported.

**9.7 Codex CLI.**
- (A) Engine outputs are byte-identical when Codex drives the skill.
- (B) The protocol works: 100% schema-valid answers, grounding rejections ≤ Claude's + 5 points, ≥ 95% cells seen; check
  first that Codex reads the JPEGs.
- (C) Non-inferiority on held-out seeds, paired by seed: the lower bound of Codex − Claude recall must be above −15
  points.
- (D) Codex's confirmed claims join the precision pool, or the report says its precision is unmeasured.

**9.8 Field test.**
- **Apps.** Pre-registered selection: a search query, eligibility (licence, an AI builder named, ≥ 10 routes, builds
  locally), the first 3 eligible taken in order, and the rejected ones logged.
- **A finding counts if** it is correct under the §9.2 rubric, is a distinct group, is at least medium or blocks a task,
  and is absent from the repo's issues, README and TODOs and from a 15-minute manual pass by a non-builder done before
  seeing nunchi's output.
- **Judging.** Findings that axe or Lighthouse would also report are counted apart. Two judges must agree (owner plus
  a non-builder).
- **Secondary.** Upstream acknowledgement within 14 days.

**9.9 Held-out apps and stop/pivot.**
- **Held-out apps.** ≥ 2 fresh apps, ≥ 40 seeds each (≥ 5 per AI lens) and ≥ 30 clean scenes.
  - Seeds are drawn from a taxonomy of real field defects and written by a different vendor's model or a human, never by
    the session that tuned the lenses.
  - About 20% of seeds are off-checklist, reported apart as coverage.
  - The answer key's hash goes in the pre-registration.
- **Stop/pivot.** Each round uses a fresh sample from fresh findings, with lenses frozen before sampling; the number of
  looks is reported.
- **Live stability.** A fingerprint-stability check from two live captures a day apart, without replay.

## 10. Precedents (from the survey; adopt / partly / reject)

| Topic | Choice | Verdict and why |
|---|---|---|
| Local server auth | Jupyter launch token + Vite Host allow-list (after CVE-2025-24010) | adopt the pattern; header token, not a cookie (cookies are shared across localhost ports) |
| Live updates | SSE semantics over a fetch stream; polling fallback | adopt; WebSocket rejected (no need for two-way, cross-site WebSocket risk) |
| File watching | chokidar techniques (watch folders, debounce, re-hash) | partly: the techniques, not the dependency |
| Visual diff | DOM geometry first; pixelmatch algorithm (ISC) on PNG | adopt; odiff rejected (native binaries); JPEG diffs rejected |
| SARIF | physical location always, partialFingerprints, logical location as extra | adopt |
| Guards | ESLint core rules (`no-alert`, `no-restricted-syntax`); built-in source checks with a baseline (Betterer idea) | adopt; jsx-a11y, stylelint and aria snapshots only when already installed |
| Fix loop | Aider (commit per change, lint/test hook, undo only its own commits); Copilot Autofix (re-scan decides) | adopt; SWE-agent/OpenHands containers rejected as default (too heavy), offered as advice for untrusted repos |
| Locks | proper-lockfile design (mkdir, heartbeat, stale) | partly: the design, not the dependency |
| Atomic write | write-file-atomic approach | partly: hand-rolled (~100 lines) |

## 11. Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Board first screen | **Progress**; its main button is "Decide N →" |
| 2 | Default grouping | **By kind**; root-cause file second |
| 3 | Board language | **English for 0.1**; one strings table, so Korean later is cheap |
| 4 | May the engine run the repo's checks after a one-time human approval of the check profile? | **Yes** (§4.3): otherwise "checks passed" is only the AI's word |
| 5 | AI-recorded dismissals (`cli-agent`) need a board confirmation before they count for "Ready to ship" | **Yes** (§1) |
| 6 | Precision gate target | **(b) 150 groups from ≥ 3 apps with a second labeller** for a "≥ 85%" claim; or (a) 50 as an estimate with interval. Needs a second person either way for blinding |
| 7 | Held-out apps | **2 new apps after M1**, seeds from a different vendor's model or a human: roughly 2 × the last cost (~15M tokens each) |
| 8 | Decision-time study | **≥ 5 non-builder participants**; or drop the gate to "reported, not gated" for 0.1 |
| 9 | Codex CLI access | **Yes, early (M1)**: needed for §9.7 and to test §7 |
| 10 | Fix existing defects D1–D12 first (M1a) | **Yes**; D1 and D4 make today's ledger say things that are not true |

## 12. Milestones (one PR each)

| # | PR | Depends on | Done when |
|---|---|---|---|
| M0 | merge #20 | owner | merged |
| M1a | existing defects D1–D12: coverage-aware, monotonic fold with catch-up; provenance hardening; atomic decisions and HAR; no input values; empty mask; hardened git; base-URL guard; strict replay; file modes; secret chunk-hash normalisation (fp v2 with migration) | M0 | a regression test per defect; Pebble bench unchanged except the documented fp v2 |
| M1 | `state.mjs` (atomic, lock, generation, state root via git common dir) + ledger schema 2 + AI fold + AI fingerprint + re-check engine with still-present controls + trust by (lens, source) + keys outside the project | M1a | §2 tests; fingerprint-stability contract test |
| M2 | Board (§3) + channels + PreToolUse deny hook + label mode | M1 | every §3.2 security check tested; decide parity with the CLI; offline; a11y checks |
| M3 | Fix loop (§4) incl. minimal claims, probes, check profile, diff policy, judging, records + skill steps + fix-gate harness | M1, M2 (approval channel) | §4 outcome tests; refusals; recovery; harness runs on Pebble |
| M4 | Guards with baseline + `check` + exports | M3 | a fixture per guard; SARIF schema; export redaction tests |
| M5 | `--quick` + HAR merge | M1 | ranking deterministic; presence-only fold; no recording-stale after a quick run |
| M6 | Multi-agent answers + board activity + per-worktree URL rules | M2, M3 | concurrency stress tests (2 × 50 folds), claim conflicts |
| M7 | Coverage and Screens views; the 0.2 views if time allows | M2 | — |
| G | Gates per §9, each with a pre-registration: held-out 2+3 (after M1), precision (after M2), Codex (from M1), fix-loop and detector sensitivity (after M3), time (after M5), decision time (after M2), field 2–3 (after M2) | — | spec §9 updated per gate |

## 13. Review log

Four reviews of v1 (2026-10-14 KST), each by an independent agent with the code at hand, plus a precedent survey.
*Adopted* means it is in v2 as stated; *changed* means adopted in a different form, with the reason given.

**Security (21 findings).**

| # | Finding | Resolution |
|---|---|---|
| S1 | Agent can produce "human" decisions, approvals, labels | adopted → §1 channels, deny hook, token never to the agent |
| S2 | Provenance forgery (existing) | adopted → D4, M1a |
| S3 | Approved script lines don't bound executed code | adopted → §4.3 check profile; limit stated honestly in §8.3 |
| S4 | Fix commit can touch any path | adopted → §4.6 diff policy, root-cause files from the source map |
| S5 | Token cannot reach images and SSE; leak paths | adopted → §3.2 fetch for everything, fragment stripped |
| S6 | Worktrees don't share `.nunchi/` | adopted → §7 state root via git common dir |
| S7 | Stale-lock race, pid reuse, containers | adopted → §8.1 mkdir lock, heartbeat, rename-steal, fencing via `rev` |
| S8 | Claims check-then-write, self-declared expiry | adopted → §7 claims under a lock, per-file markers, reader-computed expiry |
| S9 | AI judgement can mark fixed or hide (re-check decoys, zero-decoy runs, readable keys, severity downgrade, no-op fold, hand-written findings) | adopted → §2.2, §2.4 |
| S10 | Structural AI groups over-cover dismissals | adopted → §2.3 component identity |
| S11 | Production not refused; re-capture may test other code | adopted → D10, §4.4 proof of served code |
| S12 | git hardening | adopted → §4.7, D9 |
| S13 | Exports leak page data, markdown injection | adopted → §5 exports, D7, D8 |
| S14 | `check` false green in CI | adopted → §5 `check` |
| S15 | Untrusted repo's lens packs, decisions and code | adopted → §1, §8.3 |
| S16 | `.nunchi/fixes` not ignored | adopted → `state/fixes/` |
| S17 | CSP and XSS gaps | adopted → §3.2 |
| S18 | Two boards, `localhost` | adopted → §3.1, §3.2 |
| S19 | Path-serving details | adopted → §3.2 |
| S20 | File permissions | adopted → D12, §8.1 |
| S21 | Doc misstated the code | corrected in §0 and §8.1 |

**Systems and data (32 findings).**

| # | Finding | Resolution |
|---|---|---|
| Y1 | Second fold with the same run id is a no-op | adopted → §2.1 `(run, source)` folds |
| Y2 | Fold ignores states, viewports, scene status, detectors (existing) | adopted → D1, §2.1 |
| Y3 | AI fingerprint unstable | adopted → §2.3 |
| Y4 | Canary copies would enter the ledger | adopted → §2.2 |
| Y5 | Re-check decoys point the wrong way | adopted → §2.4 still-present controls |
| Y6 | Re-check scope, matching, cost | adopted → §2.4 per cell, old + new evidence, skip unchanged |
| Y7 | AI items never leave `open` | adopted → §2.4 `stale` |
| Y8 | Out-of-order folds (existing) | adopted → D2 |
| Y9 | Runs left unfolded (existing) | adopted → D3 |
| Y10 | Claimed and suspect items vs group decisions and trust | adopted → §2.2 |
| Y11 | Verify run folded as a normal run; revert leaves ledger wrong | adopted → §4.4 probes |
| Y12 | Baseline not like-for-like | adopted → §4.4 P0 / P1 |
| Y13 | Fingerprint equality is the wrong "gone"/"new" test | adopted → §4.5 element identity, flaky re-check, chunk hashes |
| Y14 | Not-fixed leaves an unverified commit | adopted → revert on not-fixed; attempts from trailers |
| Y15 | Replay misses go live (existing) | adopted → D11, strict replay |
| Y16 | Checks not enforced; approved.json collision | adopted → §4.3 tree hash, `scripts-approved.json` |
| Y17 | Records path, crash recovery, claim expiry | adopted → §4.8 |
| Y18 | Root-cause files collapse to "everything" | adopted → §4.6 |
| Y19 | AI outcome can't come from verify alone | adopted → `fix --verify --record` re-check |
| Y20 | Worktrees vs shared state | adopted → §7 |
| Y21 | Lock design | adopted → §8.1 |
| Y22 | Atomic write details | adopted → §8.1 |
| Y23 | Full writer list | adopted → §8.1 |
| Y24 | Quick run marks ledger fixed and poisons the HAR | adopted → §6 |
| Y25 | Stream token; watcher edge cases | adopted → §3.3 generation file |
| Y26 | `/api/state` cost | adopted → `summary()` and per-fold counts |
| Y27 | Answers format rejects `agent` | adopted → §7 header fields |
| Y28 | gc deletes referenced runs | adopted → §8.1 gc pins |
| Y29 | `fixing` not in `view()` | adopted → §4.9 precedence |
| Y30 | Gate math, label file | adopted → §9.4, §9.2 |
| Y31 | Schema 2 and naming | adopted → §2.5 |
| Y32 | Milestone cycle | adopted → §12 order |

**UX and workflow (28 findings).**

| # | Finding | Resolution |
|---|---|---|
| U1 | No decide → fix handoff | adopted → §3.4 handoffs |
| U2 | Server lifetime | adopted, **changed**: the URL is not stable, because a stored token conflicts with S1/S5; reuse via local socket instead |
| U3 | Worktree verifies the wrong code | adopted → §7, §4.4 |
| U4 | Pre-failing checks | adopted → §4.3 baseline |
| U5 | Dirty tree | adopted → §4.2 |
| U6 | Script approval channel | adopted → §1, §4.3 |
| U7 | Needs-human dead end | adopted → §3.4 three kinds with actions |
| U8 | User changes their mind mid-fix | adopted → §4.9 cancelled |
| U9 | Late result; "since last run" | adopted → §3.4, §4.4 |
| U10 | Verdict formula | adopted → §3.4 |
| U11 | List reorders under keys | adopted → §3.4 |
| U12 | Reason step | adopted → §3.4 keys and toast |
| U13 | Keep vs Not a problem | adopted → sub-labels |
| U14 | Batches | adopted → §3.4 |
| U15 | Unverified items | adopted → collapsed section, one vocabulary |
| U16 | Guard noise | adopted → §5 |
| U17 | Worktree copy | adopted → §7 |
| U18 | Quick-run numbers jump | adopted → §6 |
| U19 | Too many consents | adopted → sweep plan and fix plan in the skill (M2/M3) |
| U20 | Evidence box hard to find | adopted → §3.4 detail |
| U21 | Placeholder views | adopted → §3.4 views |
| U22 | Label mode | adopted → `open --label` |
| U23 | Undo and reopen | adopted |
| U24 | Copy table | adopted → §3.4 words |
| U25 | Keys | adopted |
| U26 | Accessibility | adopted |
| U27 | Results in chat | adopted → §4.10 |
| U28 | Board optional | adopted: the chat path stays, with the §1 confirmation rule |

**Measurement (23 findings).**

| # | Finding | Resolution |
|---|---|---|
| E1, E3, E4, E5 | Precision n, strata, labeller bias, rubric | adopted → §9.2; target is owner decision 6 |
| E2 | Confirmed-only hides verifier misses | adopted → strata and post-verification recall |
| E6, E7, E8 | Per-lens recall sample, run independence, packets and scorer | adopted → §9.1 |
| E9 | Held-out protocol | adopted → §9.9; cost is owner decision 7 |
| E10 | Scoring amendments | adopted → §9 preamble |
| E11 | Fix gate | adopted → §9.4 |
| E12 | Regression detector sensitivity | adopted → planted regressions |
| E13 | Decision time | adopted → §9.6; owner decision 8 |
| E14 | Time gate | adopted → §9.5 |
| E15 | Codex | adopted → §9.7 |
| E16 | Field test | adopted → §9.8 |
| E17 | Re-check validation | adopted → §9.4 |
| E18 | Decoy power | adopted: ≥ 20 decoys in gate runs; templates for every lens (M1) |
| E19 | Clean scenes | adopted → §9.3 |
| E20 | Rule precision on field apps | adopted → §9.2 |
| E21 | Stop/pivot data re-use | adopted → §9.9 |
| E22 | Live stability | adopted → §9.9 |
| E23 | Pre-registration | adopted → §9 preamble |

**Conflicts between reviews and how they were settled.**
1. **Stable bookmarkable board URL (U2) vs token never on disk (S5).** Security wins: the agent can read any file the
   board can. Reuse works through a 0600 local socket instead.
2. **The agent records decisions from chat (U28) vs only human channels count (S1).** Both kept: agent-recorded decisions
   are visible at once and start fixes for confirmed findings, but dismissals count only after a board confirmation.
3. **Fewer prompts (U19) vs more approvals (S3, S15).** Approvals are bundled into the two plan messages (sweep plan,
   fix plan) and one board card, never asked mid-loop.

**Not verified by the reviewers, to verify in the implementation PRs.**
- Whether the agents' Bash tools give a TTY (the §1 `cli-tty` rule depends on it).
- pnpm, yarn and bun pre/post-script behaviour per version.
- Which hooks `git revert` runs per git version.
- Whether Codex CLI has a hook like PreToolUse.
- GitHub's SARIF limits and how it shows results without a file location.
- Whether `eslint-config-next` enables `jsx-a11y/anchor-is-valid`.
