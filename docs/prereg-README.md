# Gate pre-registrations (milestone G)

Status: **drafts, none registered**; the owner's decisions recorded (2026-10-15 KST, on main `8fdbc79`). Design 0.1-c
§9 asks for one `docs/prereg-<gate>.md` per measurement, committed before it starts, holding the engine, scorer and
answer-key hashes, the seeds and sample sizes, the primary statistic and pass rule, the exclusions and the amendment
policy. These are those files. No gate has been run for them and none of them states a result.

> 한국어 요약
> - 남은 관문 6개(홀드아웃 앱 2·3, 정밀도, 수리 루프, 결정 시간, 현장 시험 2–3차, Codex)의 사전 등록 초안이다.
>   시간 관문은 M5 이후라 자리만 잡았다.
> - 해시와 시드는 손으로 쓰지 않는다. 등록할 때 `scripts/prereg-hash.mjs`가 채우고, 측정 전후에 `--check`로 확인한다.
> - 통과 규칙은 Clopper–Pearson 정확 구간의 단측 95% 경계로 다시 계산했다(`scripts/prereg-stats.mjs`, 테스트 포함).
>   설계의 43/50 구간 「74–94%」는 틀렸고 73–94%가 맞다. 나머지 수치는 맞다.
> - 오너가 2026-10-15에 결정 10개를 모두 권장안대로 승인했다(「권장대로」). 남은 것은 사람 지정이다: nunchi를 만들지 않은
>   검토자 2명과 참가자 5명(D4). 등록 전에 만들 것 16개는 아래 목록에 있다.
> - 같은 날 통계 검토를 반영했다(맨 아래 「통계 검토 후 변경」). 홀드아웃 재현율은 「3번 중 2번」 대신 실행 평균의 부트스트랩
>   하한으로 판정하고(경계값에서 통과 확률 63% → 7%), 시드는 등록을 푸시한 뒤 공개 난수(drand)로 정하며, 등록한 규칙
>   자체도 해시로 묶는다.

## Decided (2026-10-15 KST, owner: as recommended)

The owner approved every recommendation on 2026-10-15 KST (「권장대로」). Decisions §11 already records (#1–#3,
#10–#15, owner response 2026-10-14 KST) stand as they were; D1, D2, D3, D5 and D6 settle §11 #7, #9, #6, #8 and #4.

| # | Decision | Chosen | Gates |
|---|---|---|---|
| D1 | Held-out apps 2 and 3 (§11 #7) | two new invented apps and their keys, written by a different vendor's model session that never tuned a lens; about 15M hunting tokens per app for 3 runs, plus verification | held-out, Codex (C), precision |
| D2 | Codex CLI access (§11 #9) | yes, before the held-out apps are captured, so (C) runs on the same frozen engine and stays blind | Codex |
| D3 | Precision target (§11 #6) | option (b): 150 confirmed groups from ≥ 3 apps, pass at ≥ 135 (one-sided 95% lower bound ≥ 85%); option (a) is struck | precision |
| D4 | The people | **approved; awaiting the owner to name the people** (below) | precision, held-out, fix, field, decision time |
| D5 | Decision-time study (§11 #8) | gated if D4 names ≥ 5 non-builder participants by the field round; otherwise "reported, not gated" for 0.1 | decision time |
| D6 | The engine runs the repo's checks after a person approves the check profile (§11 #4) | yes, as M3 is built | fix |
| D7 | The fix gate's app | pegroom, now (the fix loop never ran or was tuned on it) | fix |
| D8 | Who builds the fix gate's sets ("someone other than the fixer") | a different vendor's model session that never read the fix judge; reviewer A spot-checks 10 items | fix |
| D9 | Field round 3 | three fresh apps, chosen by the same registered rule | field round 3 |
| D10 | Upstream issues (field secondary: acknowledgement within 14 days) | the owner files the counted findings by hand from their own account: at most 5 per repository, neutral wording, after the count is final | field (secondary only) |

### D4: the people the owner still has to name

Approved in principle; no gate that needs a person is registered until the owner names that person (by role in these
files, never by name). Hours are rough.

| Role | How many | Does | Hours |
|---|---|---|---|
| Reviewer A | 1 person who did not build nunchi | labels the whole precision pool, blind (374 items, about 30 s each), before seeing any verdict of those apps | ≈ 3 |
| | | labels the confirmed AI claims on held-out clean scenes | ≈ 0.5 |
| | | held-out presence check: every seed (about 100) marked present or absent on the screens, before any scoring and blind to it | ≈ 2 |
| | | adjudicates held-out cases blind to runs and agents (location ties, seeds the app does not show) | ≤ 1 |
| | | spot-checks 10 items of the fix gate's sets for realism (D8) | ≈ 1 |
| | | reviews 10 kept fix diffs blind to their outcome | ≈ 1 |
| | | second gold judge for the decision-time study: classes and gold decisions of the candidate groups | ≈ 1 |
| | | second field judge: every confirmed and rule group of each field app, after labelling (about 2 h per app × 3) | ≈ 6 (+ 6 in round 3) |
| | | **total** | **≈ 15.5 (+ 6)** |
| Reviewer B | 1 person who did not build nunchi and judges nothing | reads the manual-pass briefing; uses each field app for 15 minutes before any nunchi output exists and writes down the defects seen | ≈ 1 (+ 0.75 in round 3) |
| Participants | ≥ 5 people who did not build nunchi, have built a web app with an AI coding tool, and have not seen the study app | one moderated session each: briefing, 3 practice groups, 30 study groups, one at a time | ≈ 0.5–0.75 each |

The owner's own part, for scale: labelling ≈ 3 h, field judging ≈ 6 h (+ 6 h), gold judging ≈ 1 h, Fix decisions and
check-profile approvals for about 60 fix trials, and moderating the 5 sessions (≈ 4 h).

**Later, after M5:** for the time gate, a reference machine, a lower-spec machine and an app with ≥ 25 routes that
nunchi was not tuned on ([prereg-time.md](prereg-time.md)).

## The pre-registrations

| Gate | File | Unblocked by | Pass rule (short) | Waits for |
|---|---|---|---|---|
| Held-out apps 2 and 3 | [prereg-heldout.md](prereg-heldout.md) | M1 | rule recall 100%; mean-of-runs recall of the on-checklist AI seeds (n ≥ 80) with a one-sided 95% exact-bootstrap lower bound ≥ 75%, and the same after verification with ≤ 10% of seed hits rejected; ≤ 0.1 confirmed false positives per clean scene in the worst run (upper bound); determinism; fingerprints ≥ 95% (replay and live); exclusions ≤ 5% | the apps (D1), Codex access (D2), reviewer A (D4); B1–B5 |
| Precision | [prereg-precision.md](prereg-precision.md) | M2 | ≥ 135/150 marked correct by both labellers; valid only with κ ≥ 0.6 over the whole pool (PABAK beside it), each labeller ≤ 10% decoys accepted and ≥ 90% known-true, *unsure* ≤ 10%; rule precision on field apps ≥ 85% (point) | the held-out apps (D1), reviewer A (D4); B7, B8 |
| Fix loop | [prereg-fix.md](prereg-fix.md) | M3 | fixed (2 attempts, functional check passing) ≥ 90% (point); no caused regression detected; ≥ 28/30 planted regressions detected and ≤ 1/20 false alarms; re-check: ≤ 1/30 false *gone* (still there), ≤ 1/30 (moved), ≤ 3/30 false *still there* | the sets (D8), reviewer A (D4); B9–B13 |
| Decision time | [prereg-decision-time.md](prereg-decision-time.md) | M2 | trivial and medium apart, each: median ≤ 10 s and agreement with gold ≥ 80% (points); Williams-design order; gated only with ≥ 5 participants (D5) | participants and reviewer A (D4); B14, B15 |
| Field rounds 2–3 | [prereg-field.md](prereg-field.md) | M2 | each of 3 apps ≥ 5 counted findings; stop/pivot if precision < 70% or < 3 counted findings per app on average | reviewers A and B (D4); B16 |
| Codex CLI | [prereg-codex.md](prereg-codex.md) | M1 | (A) 0 files differ; (B) 100% valid answers, rejections ≤ Claude Code's + 5 points, ≥ 95% cells seen; (C) one-sided 97.5% lower bound of Codex − Claude Code recall > −15 points; (D) measured or said unmeasured | Codex access (D2); B1–B4, B6 |
| Time | [prereg-time.md](prereg-time.md) | M5 (not merged) | stub | M5 |

**Order.** The fix gate depends on nothing else and can go first, on pegroom. Held-out, Codex, precision and field
are registered together at one engine commit: the held-out apps are captured and hunted by both agents, the field apps
are searched and selected, the precision sweeps run on all five apps, then labelling (blind), then field judging
(which shows verdicts), then the decision-time study on one field app.

## Builds needed before registration

Each lands in the engine or scorer set of the gate that needs it, so it is hashed at registration. Size: S (a day or
less), M (a few days), L (about a week), rough.

| # | Build | Gate | Size |
|---|---|---|---|
| B1 | Plan salt: `hunt --plan --salt <n>` enters the reference choice; salt 0 keeps today's plans byte for byte (contract test) | held-out, Codex | S |
| B2 | Sampled packets in `bench/ai-gate.mjs`: ≥ 3 non-seed units per seed unit, interleaved, seeded order (`--order`) | held-out, Codex | S |
| B3 | Location scorer in `bench/score.mjs`: a hit needs the seed's element or `file:line`; near misses listed for blind adjudication | held-out, Codex | M |
| B4 | Run tally in `bench/ai-gate.mjs --score`: found in how many of 3 runs; the exact bootstrap bound of mean-of-runs recall, the worst run, majority of 3, per-lens screening and the exclusions-as-misses sensitivity, through `scripts/prereg-stats.mjs` | held-out, Codex | S |
| B5 | Answer-key schema: each AI seed's location, checklist item and `offChecklist` flag | held-out | S |
| B6 | `bench/codex-gate.mjs`: one Codex CLI session per packet, answers in the `--score` layout, (A)'s byte comparison | Codex | M |
| B7 | `bench/precision-gate.mjs`: `--pool` (the population's hash, evidence-missing exclusions before labelling, stratified draw, decoys, known-true items, key outside the project) and `--score` (κ over the whole pool, PABAK) | precision | L |
| B8 | Label mode serves a harness pool: rule groups and harness items beside the AI groups, the banner counted from the pool | precision | M |
| B9 | Functional checks in `bench/fix-gate.mjs`: declarative, run in the browser after each trial | fix | M |
| B10 | Sets with expectations (`planted`, `clean`, `blind`) and their tally in `bench/fix-gate.mjs` | fix | S |
| B11 | Fixer mode in `bench/fix-gate.mjs`: fresh copies seeded from one base sweep, wait for a fresh fixer session, read the record | fix | L |
| B12 | The person approves the check profile in the board for each trial (the harness stops approving as the operator) | fix | S |
| B13 | `bench/recheck-gate.mjs`: still-there, moved and already-fixed cases into re-check plans, key outside the project, scoring | fix | M |
| B14 | Board study mode: each participant's order from the Williams design (`williamsSquare(6)` over 6 blocks of 5 groups), batch keys off | decision time | M |
| B15 | `bench/decision-study.mjs`: study copies; joins metrics, decision files and the gold file | decision time | S |
| B16 | `bench/field-tally.mjs`: the judges' sheets into counted, counted-apart and per-app totals | field | S |

## How a draft becomes registered

1. The people it needs are named (D4), and its builds are merged.
2. **Pick the beacon round.** The registrant reads drand's latest round
   (`https://api.drand.sh/<chain>/public/latest`; the drafts name the quicknet chain
   `52db9ba7…e971`: check its period and genesis at `https://api.drand.sh/<chain>/info` before relying on them) and
   writes into the doc's `beacon` line, in place of `ROUND`, a round that will be published at least 2 hours later.
3. On a clean tree: `node scripts/prereg-hash.mjs --fill docs/prereg-<gate>.md [--key <name>=<path> …]`. It hashes
   every set as git stores it at HEAD (keys outside the repository as given) and the doc's own rules (the `doc` row:
   the doc without its hash block and without its final `## Amendments` section), and writes the table between the
   doc's `prereg-hash` markers. Nobody types a hash.
4. Commit ("register <gate>") and push, before the beacon round's time. That push is the registration; its time (KST)
   is the registration time, and it is public.
5. **After the round is published:** `node scripts/prereg-hash.mjs --seeds docs/prereg-<gate>.md --beacon <that round's
   randomness>`. It refuses unless the registration is committed and on a remote branch. It writes the seeds (from the
   registered rows and the beacon) and the beacon value into the block; commit and push. Nobody types a seed, and
   nobody could know one while choosing what to register.
6. `node scripts/prereg-hash.mjs --check docs/prereg-<gate>.md [--key …]` before the first step and after the last;
   both outputs go into the results. Exit 1 (an engine, scorer or key file, a rule of the doc, or a seed changed)
   stops the measurement. It also says how many amendments the doc's log holds. A folder key (an app) is never
   installed or built in place: the operator works on a copy, so the registered folder stays clean for `--check`.
7. **Re-registering** before any data (a build fixed, a rule clarified) is `--fill --again --reason "<why>"`: it appends
   a dated row (KST) to the doc's `## Amendments` log. After seeds were drawn it also needs a later beacon round, so a
   known beacon value can never be re-rolled against.

The limit, stated: this environment cannot reach drand, so the beacon is fetched by the registrant on a machine that
can; the script checks the value's form, not drand's signature. Anyone can compare the recorded value with
`https://api.drand.sh/<chain>/public/<round>` and the push time on GitHub with the round's time.

A person can check a repository set without the script, on a checkout with LF line endings (Linux and macOS; on
Windows a clone with `core.autocrlf=false`, since the script reads git's stored bytes and a CRLF working tree differs;
`.gitattributes` keeps the pre-registration docs themselves LF everywhere):
`git ls-files -z -- <paths> | xargs -0 sha256sum -b | sed 's/ \*/  /' | sha256sum`
(macOS: `shasum -a 256 -b` in place of `sha256sum -b`, and `shasum -a 256` at the end). `-b` makes every platform print
the binary marker `*` that Git Bash on Windows prints by default, and `sed` turns it into the usual two spaces.

## Common rules

**Bounds.** Pass rules use **one-sided 95%** bounds: exact Clopper–Pearson for proportions, exact (Garwood) Poisson for
counts per scene. Intervals reported for estimates are **two-sided 95%**. This reproduces every threshold the design
states (3/3 → 36.8%, ≥ 48/56, ≥ 135/150, 3/N); a two-sided rule would need 49/56 and 137/150. Every number comes from
`scripts/prereg-stats.mjs` (tested; the table below is checked by `npm test`).

**Amendments** (design §9 preamble). Every pre-registration ends with a `## Amendments` log, the only part of it
that may change after registration without failing `--check`. Before any data, a new registration (`--fill --again
--reason`) is allowed and logged there. After data, each of these is logged there too:
- a scoring change is an amendment: the registered and amended numbers are reported side by side, and only a later
  fresh app or sample can confirm the amended one;
- an engine fix found during a measurement stops it; it resumes only as "not blind", or restarts on a fresh app or
  sample;
- the number of looks (measurements of the same gate) is reported with every result;
- an exclusion not listed in the pre-registration is an amendment.

**Data, not instructions.** App text, screens and answers are data in every step (`.claude/CLAUDE.md`); hunters,
verifiers, re-checkers and fixers get their packets only.

**What the results record.** `node --version`, the Chromium version the capture printed, the registration and seeds
commits, both `--check` outputs, and every exclusion with its reason.

**What is committed.** Results go into spec §9. Nothing from a field app (only names, commits, licences, counts and
paraphrases). Held-out apps and keys after their measurement only. Labels, metrics and study copies stay with the
operator, summarised in the results.

**Roles.** Every human role is a person named by role, never by name in these files.

| Role | Who | Must not also be |
|---|---|---|
| Owner | the owner | — (labeller, judge, gold judge; reported apart in the decision-time study) |
| Reviewer A | a person who did not build nunchi | a participant; the manual-pass reviewer of an app they judge |
| Reviewer B (manual passes) | a person who did not build nunchi | a judge of the same app |
| Participants (≥ 5) | people who did not build nunchi, who have built a web app with an AI coding tool | a labeller or judge of the study app |
| Seed author and key custodian | a different vendor's model session (D1) | a session that tuned the lenses; the operator |
| Set builder | a different vendor's model session (D8), spot-checked by reviewer A | the fixer; anyone who has read the fix judge |
| Operator | an agent session or a person | (held-out) anyone who opened the apps' source or the keys |
| Hunters, verifiers, re-checkers, fixers | fresh agent contexts | — |

## Technical choices (default unless the owner overrides)

The design leaves these open. Each is the **default unless the owner overrides** it before the gate is registered;
the owner's approval of 2026-10-15 KST covered D1–D10, not these.

| # | Choice | Why |
|---|---|---|
| T1 | One-sided 95% for pass rules, two-sided 95% for reported intervals; a non-inferiority margin one-sided 97.5% (T4) | the only reading under which the design's thresholds hold (worked numbers) |
| T2 | Held-out recall: **mean-of-runs recall** (each seed scores found / 3), gated on its one-sided 95% lower bound by the **exact bootstrap over seeds**; the worst run and majority of 3 reported | *changed after review (H3):* majority of 3 with Clopper–Pearson passed 63% of the time at a true 75% when runs find seeds independently; the registered rule passes about 7% (the operating characteristic in the held-out doc). It also follows design §9.1's "CI bootstrapped over seeds" |
| T3 | Held-out seeds: ≥ 5 on-checklist per AI lens per app (≥ 40) and about 10 off-checklist on top | with 20% off-checklist inside 40, a lens would have about 4 on-checklist seeds per app and miss §9.1's "≥ 10 pooled" |
| T4 | Codex − Claude Code: Bonett–Price adjusted Wald interval, **one-sided 97.5%** | a difference of paired proportions has no Clopper–Pearson bound; *changed after review:* 97.5% is the usual level for a non-inferiority margin (was 95%) |
| T5 | Clean scenes: per run, confirmed false positives on the clean scenes (repeated ones counted in each run); the gate takes **the worst of the 3 runs**, exact Poisson upper bound per scene | spec §8 counts false positives per scene of a sweep; *changed after review:* the denominator is now defined, and the worst run keeps a repeated false positive from counting as three independent ones |
| T6 | Fix rate ≥ 90% as a point estimate, interval reported | a lower bound ≥ 90% needs 40/40 or 59/60 |
| T7 | Re-check validation per set (still there, moved, already fixed); inconclusive when *insufficient* > 3 of 30 | otherwise answering *insufficient* to everything passes |
| T8 | Fix-gate drift thresholds frozen as built | calibrating on the gate's own sets leaves nothing to measure them with |
| T9 | Field: findings axe or Lighthouse would report are left out of the primary count and reported apart; stop/pivot's "< 3 per app" is the round's average | design §9.8 says "counted apart"; "per app" has no stated aggregate |
| T10 | Decision time: trivial and medium **gated apart** (median ≤ 10 s and agreement ≥ 80% each); *Later* is out of the timing and counts as a disagreement | *changed after review:* stricter than pooling, so a fast trivial class cannot carry a slow medium one (the review asked it for the median; agreement apart too is this draft's addition); design §3.5 records *Later* apart |
| T11 | Seeds come from the registered hashes **and a drand round published after the registration is pushed** | *changed after review:* hash-only seeds could be ground (five whitespace commits gave five seeds); now nobody can know a seed while choosing what to register |
| T12 | Precision: Cohen's κ ≥ 0.6 over **the whole pool**, PABAK and the main stratum's κ reported beside it | *new after review:* the main stratum is mostly *correct*, so its κ would collapse (and the gate turn inconclusive) even when the labellers agree |
| T13 | Decision time: the order follows a **Williams design** (6 blocks of 5 groups; every block in every position, after every other block once) | *new after review:* counterbalances order and first-order carry-over, which a random shuffle per participant does not |

## Worked numbers

Every figure the design states, recomputed (`node scripts/prereg-stats.mjs worked`; `npm test` fails if this table
and the helper disagree):

<!-- worked-numbers:begin -->
| What | Design says | Recomputed | Verdict |
|---|---|---|---|
| 3/3 found, lower bound | 37% (§9.1) | one-sided 95%: 36.8% · two-sided 95%: 29.2% | holds as a one-sided bound |
| 43/50 correct, interval | 74–94% (§9.2) | two-sided 95%: 73.3–94.2% · one-sided 95% lower: 75.3% | **wrong: 73–94%** (two-sided 95%) |
| pooled recall, 56 seeds, lower bound ≥ 75% | ≥ 48/56 (§9.1) | 48/56 → 75.7%, 47/56 → 73.6% (one-sided); two-sided needs 49/56 | holds: 48/56 (one-sided) |
| precision (b), 150 groups, lower bound ≥ 85% | pass at ≥ 135 (§9.2) | 135/150 → 85.0%, 134/150 → 84.3% (one-sided); two-sided needs 137/150 | holds: 135/150 (one-sided) |
| precision (a), 50 groups, lower bound ≥ 85% | "50 labels cannot show ≥ 85%" (§9.2) | possible only at ≥ 47/50 (one-sided), ≥ 48/50 (two-sided) | holds near 86%; not for every result |
| planted regressions detected | ≥ 28/30 (§9.4) | 28/30 → lower 80.5% (one-sided), 77.9% (two-sided) | a count rule; supports "sensitivity ≥ 80%" |
| false alarms on clean fixes | ≤ 1/20 (§9.4) | 1/20 → upper 21.6% (one-sided), 24.9% (two-sided) | a count rule; supports "≤ 22%" |
| 0 regressions in N, true rate | ≤ 3/N (§9.4) | N = 20: 13.9% vs 15.0% · N = 30: 9.5% vs 10.0% · N = 40: 7.2% vs 7.5% | holds (one-sided 95%: 1 − 0.05^(1/N) < 3/N) |
| re-check: false "gone" | ≤ 1/30 (§9.4) | 1/30 → upper 14.9% (one-sided) | a count rule |
| re-check: false "still there" | ≤ 3/30 (§9.4) | 3/30 → upper 23.9% (one-sided) | a count rule |
| fix loop, 90% of seeded fixes gone | ≥ 90% (spec §8) | 36/40 → 76.3–97.2% (two-sided); a lower bound ≥ 90% needs 40/40 or 59/60 | a point estimate (registered), interval reported |
| clean scenes, ≤ 0.1 confirmed FP per scene, upper bound | "gated on the upper bound" (§9.3) | 60 scenes: 0 FP → 0.050, 1 → 0.079, 2 → 0.105 per scene (exact Poisson, one-sided) | passes with ≤ 1 confirmed FP in 60 scenes |
| rule precision on field apps | ≥ 85%, lower bound reported (§9.2) | 85/100 → 76.5–91.4% (two-sided); a lower bound ≥ 85% needs 92/100 | a point estimate (as the design says) |
<!-- worked-numbers:end -->

**Found wrong in the design:** §9.2 gives 43/50 as "74–94%", twice (the bullet, and option (a)'s example "86%
(74–94)"). The two-sided 95% Clopper–Pearson interval is **73.3–94.2%, so 73–94%**. The conclusion stands (the lower
bound is below 85%). These drafts use 73–94; the design text is left as it is for the owner.

**Holds, with a caveat:** "50 labels cannot show ≥ 85%" is true at the expected 86%, but 47/50 (94%) would show it
(one-sided).

**Spec §8 rows these supersede when registered:** "Precision after verification: ≥ 85% on a 50-finding sample" (D3:
150 groups, pass at ≥ 135);
"Recall, AI lenses: ≥ 75% per lens, mean of 3 runs" (pooled primary plus per-lens screening, design §9.1).

## Apps and model work (rough)

People and their hours: D4 above.

| Need | How much |
|---|---|
| New apps | 2 held-out apps with keys, written by a different vendor's model session (D1); 3 field apps for round 2 and 3 fresh ones for round 3 (D9), found by the registered search; the study app is one of round 2's |
| Model work | held-out hunting ≈ 15M tokens per app for 3 runs, plus verification; the same on Codex's side (D2); 5 precision sweeps at the default budget (≈ 0.4M hunting tokens each, plus verification); the seed author's and the set builder's sessions (D1, D8); about 60 fixer sessions and their re-checks (not measured yet) |

## Changes after statistical review (2026-10-15 KST)

A separate statistical review of PR #31 found these; each is fixed in the drafts and tools, and where it changed a
technical choice the stricter option is the new default (still "default unless the owner overrides").

**High**
1. *`--check` could exit 0 without checking* when run through a link (the "is this the program" test compared raw
   paths). Both scripts now compare real paths (`realpathSync.native`), and a test runs them through a junction.
2. *The registered rules were not protected.* A `doc` row now hashes each pre-registration without its hash block and
   its final `## Amendments` log; `--check` fails when a rule changes and reports the amendment count;
   `--fill --again` needs `--reason` and logs a dated row.
3. *Held-out "found in ≥ 2 of 3 runs" made the gate easier* (63% pass at a true 75%, against 4% for one run). The gate
   is now the exact-bootstrap lower bound of mean-of-runs recall (about 7% at the threshold); the worst run and
   majority of 3 are reported; the operating characteristic is in the held-out doc (T2).
4. *Held-out exclusions favoured recall.* Reviewer A now checks every seed's presence before any scoring, blind to it;
   the 5% cap covers all exclusions; a sensitivity result counts excluded seeds as misses.

**Medium**
5. *Seed grinding:* seeds now need a drand round published after the registration is pushed (T11); `--seeds` refuses
   an unpushed registration.
6. *CRLF:* the docs are read with either line ending and written back with their own; `.gitattributes` keeps
   `docs/prereg-*.md` LF; the manual one-liner works on Windows (`-b` and `sed`) and names `shasum` for macOS. (This was
   also the Windows CI failure, with an 8.3 short temp path that the folder-key check now never compares.)
7. *Codex (C):* one-sided 97.5% (T4).
8. *Held-out clean scenes:* the denominator is defined, per run, gated on the worst run (T5).
9. *Precision κ:* over the whole pool, PABAK beside it (T12).
10. *Decision time:* trivial and medium gated apart (T10); a Williams design for the order (T13).
11. *Fix gate:* the owner cannot overrule the blind diff reviewer; a disagreement is reported.
12. *Room for post-hoc choices:* "evidence missing" is decided by `--pool` before labelling; the field test's "30
    minutes" (clone to the first HTTP 200, by the README's commands) and "most routes" (more than 50%) are numbers; the
    precision population's hash is recorded at `--pool`.

**Low**
13. The rule-precision interval is reported two-sided, as T1 says.
14. Decoys and known-true items are each 7.2% of the pool, about 10% of its AI items; the precision estimate is an
    equal-weight average across apps. Both now said.
15. `weightedProportion` throws on a stratum with members but no sample (it counted it as 0%); a comment named a
    bootstrap option that does not exist.
16. The clean-tree check includes ignored files (`--ignored`), allowing only an app's dependency and build folders.
    Results record the Node and Chromium versions.
17. A repeated `gate`, `seeds` or `beacon` line is an error, not an override.
18. A harness fix during the fix gate is an amendment.
19. Design §11 (`docs/design-0.1-c.md`, the line after its decisions table) still says #4–#9 need the owner. They were
    decided on 2026-10-15 KST (D1–D10 above); the design doc is left unchanged, as asked, and this note is the record.
