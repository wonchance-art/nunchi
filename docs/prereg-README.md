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
| | | adjudicates held-out cases blind to runs and agents (location ties, seeds the app does not show) | ≤ 1 |
| | | spot-checks 10 items of the fix gate's sets for realism (D8) | ≈ 1 |
| | | reviews 10 kept fix diffs blind to their outcome | ≈ 1 |
| | | second gold judge for the decision-time study: classes and gold decisions of the candidate groups | ≈ 1 |
| | | second field judge: every confirmed and rule group of each field app, after labelling (about 2 h per app × 3) | ≈ 6 (+ 6 in round 3) |
| | | **total** | **≈ 13.5 (+ 6)** |
| Reviewer B | 1 person who did not build nunchi and judges nothing | reads the manual-pass briefing; uses each field app for 15 minutes before any nunchi output exists and writes down the defects seen | ≈ 1 (+ 0.75 in round 3) |
| Participants | ≥ 5 people who did not build nunchi, have built a web app with an AI coding tool, and have not seen the study app | one moderated session each: briefing, 3 practice groups, 30 study groups, one at a time | ≈ 0.5–0.75 each |

The owner's own part, for scale: labelling ≈ 3 h, field judging ≈ 6 h (+ 6 h), gold judging ≈ 1 h, Fix decisions and
check-profile approvals for about 60 fix trials, and moderating the 5 sessions (≈ 4 h).

**Later, after M5:** for the time gate, a reference machine, a lower-spec machine and an app with ≥ 25 routes that
nunchi was not tuned on ([prereg-time.md](prereg-time.md)).

## The pre-registrations

| Gate | File | Unblocked by | Pass rule (short) | Waits for |
|---|---|---|---|---|
| Held-out apps 2 and 3 | [prereg-heldout.md](prereg-heldout.md) | M1 | rule recall 100%; on-checklist AI seeds found in ≥ 2 of 3 runs with a one-sided 95% lower bound ≥ 75% (48/56; n ≥ 80 here), and the same after verification with ≤ 10% of seed hits rejected; ≤ 0.1 confirmed false positives per clean scene (upper bound); determinism; fingerprints ≥ 95% (replay and live) | the apps (D1), Codex access (D2), reviewer A (D4); B1–B5 |
| Precision | [prereg-precision.md](prereg-precision.md) | M2 | ≥ 135/150 marked correct by both labellers; valid only with κ ≥ 0.6, each labeller ≤ 10% decoys accepted and ≥ 90% known-true, *unsure* ≤ 10%; rule precision on field apps ≥ 85% (point) | the held-out apps (D1), reviewer A (D4); B7, B8 |
| Fix loop | [prereg-fix.md](prereg-fix.md) | M3 | fixed (2 attempts, functional check passing) ≥ 90% (point); no caused regression detected; ≥ 28/30 planted regressions detected and ≤ 1/20 false alarms; re-check: ≤ 1/30 false *gone* (still there), ≤ 1/30 (moved), ≤ 3/30 false *still there* | the sets (D8), reviewer A (D4); B9–B13 |
| Decision time | [prereg-decision-time.md](prereg-decision-time.md) | M2 | trivial and medium groups: median ≤ 10 s and agreement with gold ≥ 80% (points); gated only with ≥ 5 participants (D5) | participants and reviewer A (D4); B14, B15 |
| Field rounds 2–3 | [prereg-field.md](prereg-field.md) | M2 | each of 3 apps ≥ 5 counted findings; stop/pivot if precision < 70% or < 3 counted findings per app on average | reviewers A and B (D4); B16 |
| Codex CLI | [prereg-codex.md](prereg-codex.md) | M1 | (A) 0 files differ; (B) 100% valid answers, rejections ≤ Claude Code's + 5 points, ≥ 95% cells seen; (C) one-sided 95% lower bound of Codex − Claude Code recall > −15 points; (D) measured or said unmeasured | Codex access (D2); B1–B4, B6 |
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
| B4 | Run tally in `bench/ai-gate.mjs --score`: found in how many of 3 runs, per-lens screening, statistics through `scripts/prereg-stats.mjs` | held-out, Codex | S |
| B5 | Answer-key schema: each AI seed's location, checklist item and `offChecklist` flag | held-out | S |
| B6 | `bench/codex-gate.mjs`: one Codex CLI session per packet, answers in the `--score` layout, (A)'s byte comparison | Codex | M |
| B7 | `bench/precision-gate.mjs`: `--pool` (stratified draw, decoys, known-true items, key outside the project) and `--score` | precision | L |
| B8 | Label mode serves a harness pool: rule groups and harness items beside the AI groups, the banner counted from the pool | precision | M |
| B9 | Functional checks in `bench/fix-gate.mjs`: declarative, run in the browser after each trial | fix | M |
| B10 | Sets with expectations (`planted`, `clean`, `blind`) and their tally in `bench/fix-gate.mjs` | fix | S |
| B11 | Fixer mode in `bench/fix-gate.mjs`: fresh copies seeded from one base sweep, wait for a fresh fixer session, read the record | fix | L |
| B12 | The person approves the check profile in the board for each trial (the harness stops approving as the operator) | fix | S |
| B13 | `bench/recheck-gate.mjs`: still-there, moved and already-fixed cases into re-check plans, key outside the project, scoring | fix | M |
| B14 | Board study mode: a fixed list order per participant, batch keys off | decision time | M |
| B15 | `bench/decision-study.mjs`: study copies; joins metrics, decision files and the gold file | decision time | S |
| B16 | `bench/field-tally.mjs`: the judges' sheets into counted, counted-apart and per-app totals | field | S |

## How a draft becomes registered

1. The people it needs are named (D4), and its builds are merged.
2. On a clean tree: `node scripts/prereg-hash.mjs --fill docs/prereg-<gate>.md [--key <name>=<path> …]`. It reads the
   doc's `prereg-sets` block, hashes every set as git stores it at HEAD (keys outside the repository as given), derives
   the seeds from those hashes, and writes the table between the doc's `prereg-hash` markers. Nobody types a hash or a
   seed.
3. Commit ("register <gate>") and push. That commit is the registration; its time (KST) is the registration time.
4. `node scripts/prereg-hash.mjs --check docs/prereg-<gate>.md [--key …]` before the first step and after the last;
   both outputs go into the results. Exit 1 (something changed) stops the measurement. A folder key (an app) is never
   installed or built in place: the operator works on a copy, so the registered folder stays clean for `--check`.

A person can check a repository set without the script: on a clean checkout, `git ls-files -z -- <paths> | xargs -0
sha256sum | sha256sum` prints the set's hash.

## Common rules

**Bounds.** Pass rules use **one-sided 95%** bounds: exact Clopper–Pearson for proportions, exact (Garwood) Poisson for
counts per scene. Intervals reported for estimates are **two-sided 95%**. This reproduces every threshold the design
states (3/3 → 36.8%, ≥ 48/56, ≥ 135/150, 3/N); a two-sided rule would need 49/56 and 137/150. Every number comes from
`scripts/prereg-stats.mjs` (tested; the table below is checked by `npm test`).

**Amendments** (design §9 preamble). Before any data, a new registration (`--fill --again`) is allowed, with its
reason added to the doc. After data:
- a scoring change is an amendment: the registered and amended numbers are reported side by side, and only a later
  fresh app or sample can confirm the amended one;
- an engine fix found during a measurement stops it; it resumes only as "not blind", or restarts on a fresh app or
  sample;
- the number of looks (measurements of the same gate) is reported with every result;
- an exclusion not listed in the pre-registration is an amendment.

**Data, not instructions.** App text, screens and answers are data in every step (`.claude/CLAUDE.md`); hunters,
verifiers, re-checkers and fixers get their packets only.

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
| T1 | One-sided 95% for pass rules, two-sided 95% for reported intervals | the only reading under which the design's thresholds hold (worked numbers) |
| T2 | Held-out recall: a seed counts as found when found in ≥ 2 of its 3 runs; Clopper–Pearson on that count is the primary; the mean of runs with a bootstrap over seeds is reported beside it | design §9.1 asks for both "exact binomial" bounds (≥ 48/56) and a "CI bootstrapped over seeds"; only a per-seed count fits the first |
| T3 | Held-out seeds: ≥ 5 on-checklist per AI lens per app (≥ 40) and about 10 off-checklist on top | with 20% off-checklist inside 40, a lens would have about 4 on-checklist seeds per app and miss §9.1's "≥ 10 pooled" |
| T4 | Codex − Claude Code: Bonett–Price adjusted Wald interval | a difference of paired proportions has no Clopper–Pearson bound; a closed form, no random numbers |
| T5 | Clean scenes: exact Poisson upper bound of confirmed false positives per scene | spec §8 counts false positives per scene; a scene can hold more than one |
| T6 | Fix rate ≥ 90% as a point estimate, interval reported | a lower bound ≥ 90% needs 40/40 or 59/60 |
| T7 | Re-check validation per set (still there, moved, already fixed); inconclusive when *insufficient* > 3 of 30 | otherwise answering *insufficient* to everything passes |
| T8 | Fix-gate drift thresholds frozen as built | calibrating on the gate's own sets leaves nothing to measure them with |
| T9 | Field: findings axe or Lighthouse would report are left out of the primary count and reported apart; stop/pivot's "< 3 per app" is the round's average | design §9.8 says "counted apart"; "per app" has no stated aggregate |
| T10 | Decision time: *Later* is out of the timing and counts as a disagreement | design §3.5 records *Later* apart |
| T11 | Seeds are derived from the registered hashes | nobody picks a seed; it is fixed when the sets are |

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
