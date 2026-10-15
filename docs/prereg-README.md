# Gate pre-registrations (milestone G)

Status: **drafts, none registered** (2026-10-15 KST, on main `8fdbc79`). Design 0.1-c §9 asks for one
`docs/prereg-<gate>.md` per measurement, committed before it starts, holding the engine, scorer and answer-key hashes,
the seeds and sample sizes, the primary statistic and pass rule, the exclusions and the amendment policy. These are
those files. No gate has been run for them and none of them states a result.

> 한국어 요약
> - 남은 관문 6개(홀드아웃 앱 2·3, 정밀도, 수리 루프, 결정 시간, 현장 시험 2–3차, Codex)의 사전 등록 초안이다.
>   시간 관문은 M5 이후라 자리만 잡았다.
> - 해시와 시드는 손으로 쓰지 않는다. 등록할 때 `scripts/prereg-hash.mjs`가 채우고, 측정 전후에 `--check`로 확인한다.
> - 통과 규칙은 Clopper–Pearson 정확 구간의 단측 95% 경계로 다시 계산했다(`scripts/prereg-stats.mjs`, 테스트 포함).
>   설계의 43/50 구간 「74–94%」는 틀렸고 73–94%가 맞다. 나머지 수치는 맞다.
> - 오너가 정할 것 10개가 아래에 있다. 사람으로는 nunchi를 만들지 않은 검토자 2명과 참가자 5명이 필요하다.

## Owner decisions needed

Decisions §11 already records (#1–#3, #10–#15, owner response 2026-10-14 KST) are respected and not reopened. The
ones below are open; each names the gates that wait for it.

| # | Decision | Options | Recommendation | Waits |
|---|---|---|---|---|
| D1 | Held-out apps 2 and 3 (design §11 #7) | (a) two new invented apps and keys written by a different vendor's model session; (b) written by a person; (c) none: AI recall stays at pegroom's, which is no longer blind, and 0.1 claims no AI recall | **(a)**: about 15M hunting tokens per app for 3 runs, plus verification, as pegroom cost | held-out, Codex (C), precision |
| D2 | Codex CLI access (§11 #9) | (a) yes, before the held-out apps are captured; (b) yes, later: (C) is then not blind; (c) no: spec §8's compatibility row is dropped and the README says Claude Code only | **(a)** | Codex |
| D3 | Precision target (§11 #6) | (a) 50 groups, an estimate with its interval, e.g. "86% (73–94)", no "≥ 85%" claim; (b) 150 groups from ≥ 3 apps, pass at ≥ 135 | **(b)**: the only one that can support spec §8's "≥ 85%"; each labeller labels about 374 items (≈ 3 h) instead of about 224 | precision |
| D4 | The people. Who recruits the non-builders (role table below) | (a) the owner recruits two reviewers now and five participants by the field round; (b) the gates needing them are reported as not measured | **(a)**: reviewer A (second labeller, held-out adjudicator, diff reviewer, gold judge, second field judge), reviewer B (manual passes) | precision, held-out, fix, field, decision time |
| D5 | Decision-time study (§11 #8) | (a) gated, ≥ 5 non-builder participants; (b) "reported, not gated" for 0.1 | **(a)** if D4 finds five people by the field round, else (b) | decision time |
| D6 | May the engine run the repo's checks after a person approves the check profile? (§11 #4) | (a) yes, as M3 is built; (b) no: the loop changes and the fix pre-registration is redrafted | **(a)** | fix |
| D7 | The fix gate's app | (a) pegroom now: the fix loop never ran or was tuned on it; (b) wait for held-out apps 2 and 3 | **(a)**: unblocked today | fix |
| D8 | Who builds the fix gate's sets (30 planted regressions, 20 clean fixes, 10 out-of-scope, 60 re-check cases, the functional checks), "someone other than the fixer" | (a) a person who did not build nunchi (about 1–2 days); (b) a different vendor's model session that never read the judge, with reviewer A spot-checking 10 items | **(b)** | fix |
| D9 | Field round 3 | (a) three fresh apps; (b) the round-2 apps again | **(a)**: round 2's findings tune the lenses, so its apps are no longer fresh | field round 3 |
| D10 | Upstream issues (field secondary: acknowledgement within 14 days) | (a) the owner files the counted findings by hand from their account, at most 5 per repository, neutral wording, after the count is final; (b) drop the secondary | **(a)**: a maintainer's acknowledgement is the one outside check of "worth fixing" | field (secondary only) |

**Later, after M5:** for the time gate, a reference machine, a lower-spec machine and an app with ≥ 25 routes that
nunchi was not tuned on ([prereg-time.md](prereg-time.md)).

## The pre-registrations

| Gate | File | Unblocked by | Pass rule (short) | Waits for |
|---|---|---|---|---|
| Held-out apps 2 and 3 | [prereg-heldout.md](prereg-heldout.md) | M1 | rule recall 100%; on-checklist AI seeds found in ≥ 2 of 3 runs with a one-sided 95% lower bound ≥ 75% (48/56; n ≥ 80 here), and the same after verification with ≤ 10% of seed hits rejected; ≤ 0.1 confirmed false positives per clean scene (upper bound); determinism; fingerprints ≥ 95% (replay and live) | D1, D2, D4; plan salt, packets, location scorer, run tally, key schema |
| Precision | [prereg-precision.md](prereg-precision.md) | M2 | (b) ≥ 135/150 marked correct by both labellers; (a) an estimate; valid only with κ ≥ 0.6, each labeller ≤ 10% decoys accepted and ≥ 90% known-true, *unsure* ≤ 10%; rule precision on field apps ≥ 85% (point) | D1, D3, D4; pool harness, label mode for harness pools |
| Fix loop | [prereg-fix.md](prereg-fix.md) | M3 | fixed (2 attempts, functional check passing) ≥ 90% (point); no caused regression detected; ≥ 28/30 planted regressions detected and ≤ 1/20 false alarms; re-check: ≤ 1/30 false *gone* (still there), ≤ 1/30 (moved), ≤ 3/30 false *still there* | D4, D6, D7, D8; functional checks, sets, fixer mode, board approval, re-check harness |
| Decision time | [prereg-decision-time.md](prereg-decision-time.md) | M2 | trivial and medium groups: median ≤ 10 s and agreement with gold ≥ 80% (points) | D4, D5; study mode, study scorer |
| Field rounds 2–3 | [prereg-field.md](prereg-field.md) | M2 | each of 3 apps ≥ 5 counted findings; stop/pivot if precision < 70% or < 3 counted findings per app on average | D4, D9, D10; tally |
| Codex CLI | [prereg-codex.md](prereg-codex.md) | M1 | (A) 0 files differ; (B) 100% valid answers, rejections ≤ Claude Code's + 5 points, ≥ 95% cells seen; (C) one-sided 95% lower bound of Codex − Claude Code recall > −15 points; (D) measured or said unmeasured | D2; Codex runner |
| Time | [prereg-time.md](prereg-time.md) | M5 (not merged) | stub | M5 |

**Order.** The fix gate depends on nothing else (D6–D8) and can go first. Held-out, Codex, precision and field are
registered together at one engine commit: the held-out apps are captured and hunted by both agents, the field apps are
searched and selected, the precision sweeps run on all five apps, then labelling (blind), then field judging (which
shows verdicts), then the decision-time study on one field app.

## How a draft becomes registered

1. The owner decisions it waits for are in, its builds are merged, and its open choices are struck (precision (a) or
   (b)).
2. On a clean tree: `node scripts/prereg-hash.mjs --fill docs/prereg-<gate>.md [--key <name>=<path> …]`. It reads the
   doc's `prereg-sets` block, hashes every set as git stores it at HEAD (keys outside the repository as given), derives
   the seeds from those hashes, and writes the table between the doc's `prereg-hash` markers. Nobody types a hash or a
   seed.
3. Commit ("register <gate>") and push. That commit is the registration; its time (KST) is the registration time.
4. `node scripts/prereg-hash.mjs --check docs/prereg-<gate>.md [--key …]` before the first step and after the last;
   both outputs go into the results. Exit 1 (something changed) stops the measurement.

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
| Seed author and key custodian | a different vendor's model session, or a person | a session that tuned the lenses; the operator |
| Set builder | a person, or a different vendor's model session | the fixer; anyone who has read the fix judge |
| Operator | an agent session or a person | (held-out) anyone who opened the apps' source or the keys |
| Hunters, verifiers, re-checkers, fixers | fresh agent contexts | — |

## Technical choices in these drafts

The design leaves these open; each draft makes a choice the owner can override before registering.

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

**Spec §8 rows these supersede when registered:** "Precision after verification: ≥ 85% on a 50-finding sample" (D3);
"Recall, AI lenses: ≥ 75% per lens, mean of 3 runs" (pooled primary plus per-lens screening, design §9.1).

## People, apps and cost (rough)

| Need | How much |
|---|---|
| Reviewer A | labelling ≈ 3 h ((b)) or 2 h ((a)); held-out adjudication ≤ 1 h; 10 diffs ≈ 1 h; gold judging ≈ 1 h; field judging ≈ 2 h per app × 3 |
| Reviewer B | 15 min per field app × 3 (×6 with round 3) |
| Participants | 5 × about 30–45 min |
| Owner | labelling ≈ 3 h; field judging ≈ 2 h per app × 3; gold judging ≈ 1 h; Fix decisions and check-profile approvals for about 60 trials; moderating 5 sessions |
| New apps | 2 held-out apps with keys (D1); 3 field apps per round, found by the registered search; the study app is one of them |
| Model work | held-out hunting ≈ 15M tokens per app for 3 runs, plus verification; the same on Codex's side (D2); 5 precision sweeps at the default budget (≈ 0.4M hunting tokens each, plus verification); about 60 fixer sessions and their re-checks (not measured yet) |
