# Pre-registration: decision time

Status: **draft, not registered** (2026-10-15 KST; revised after the statistical review the same day). Registered when
the hash table below is filled and pushed, before the first participant's session; the seeds come after the push. Common rules: [prereg-README.md](prereg-README.md).

The technical choices T1–T13 of [prereg-README.md](prereg-README.md) apply here as defaults unless the owner overrides
them before registration; the owner decisions D1–D10 are recorded there (2026-10-15 KST).

Covers design 0.1-c §9.6 and §3.5 and spec §8 "Decision time: median ≤ 10 s per human decision". The board measures
the time (spec §7.2 *Decision time*: from showing a group to its first decision key, paused while the tab is hidden
and after 30 s idle, capped at 120 s, kept in `state/metrics.json`, never sent).

## 1. Hashes and seeds

```prereg-sets
gate     decision-time
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/decision-study.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
study    @study-app @gold
seeds    groups orders
beacon   drand 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971 ROUND
```

`@study-app` is the clone of the study app at its pinned commit (a field round-2 app, §3); `@gold` is the judges'
file: the 30 groups, each with its class and gold decision. Both stay with the operator, outside nunchi's repository.

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-decision-time.md --key
study-app=<folder> --key gold=<file>`, and the seeds by `--seeds` after the push; never typed by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Decided 2026-10-15 KST ([prereg-README.md](prereg-README.md)): **D5** gated if the owner names ≥ 5 non-builder
participants by the field round; otherwise "reported, not gated" for 0.1 (§8). Still open: **D4** the owner names the
participants and reviewer A (the second gold judge).

To build (README builds B14 and B15, in the engine or scorer set):
1. **Study mode** for the board (B14): a fixed list order per participant (the Williams design of §3), batch keys off, one study copy
   per participant so each has its own `metrics.json`. Today the list order is the board's own (severity first).
2. **`bench/decision-study.mjs`** (B15): prepares the study copies from one sweep of the study app and the gold file, then
   joins each participant's `metrics.json` with their decision files and the gold file, and prints §4–§5.

## 3. Sample and procedure

**Study app:** one field round-2 app ([prereg-field.md](prereg-field.md)), chosen by the owner before registration, that
none of the participants has seen. It is swept once with the registered engine (capture, rules, AI hunt at the default
budget, verify).

**Groups:** the judges classify candidate groups, drawn from the sweep's confirmed AI and rule groups in the seeded
order `groups`, as *trivial*, *medium* or *hard*, and give each a gold decision (fix, keep, or not a problem; reasons
not compared). Both judges work apart; a group enters the study only when they agree on both its class and its gold
decision. Drawing stops at 10 groups per class: 30 groups.

**Participants:** at least 5 people who did not build nunchi, who have built a web app with an AI coding tool, and who
have not seen the study app, its groups or the gold file. The owner does the same task apart, reported separately.

**Session** (one per participant, about 30 minutes, a moderator present):
1. The moderator reads the written briefing (what the board is, what Fix, Keep, Not a problem and Later mean, "decide
   as you would for your own app"), the same words for everyone.
2. A practice block of 3 Pebble groups, not counted.
3. The 30 study groups, one at a time, in the participant's order (below); no batch decisions.
4. Nothing is said about speed.

**Order: a Williams design** (statistical review; T13). The 30 groups are dealt into 6 blocks of 5: each class's 10
groups, in the seeded order `orders`, go round the blocks in turn, so every block holds one or two groups of each class;
within a block the order is fixed by `orders`. The blocks follow `williamsSquare(6)` (`scripts/prereg-stats.mjs`):
participant p (1, 2, … in the order the sessions take place) takes row p:

| Participant | Block order |
|---|---|
| 1 | 1 2 6 3 5 4 |
| 2 | 2 3 1 4 6 5 |
| 3 | 3 4 2 5 1 6 |
| 4 | 4 5 3 6 2 1 |
| 5 | 5 6 4 1 3 2 |
| 6 | 6 1 5 2 4 3 |

Every block takes every position once and follows every other block once over the 6 rows. With 5 participants the
square is incomplete (row 6 unused) and the report says so; a sixth participant completes it.

## 4. Primary statistic and pass rule

Over the non-builder participants' decisions, **trivial and medium apart** (about 10 × 5 = 50 decisions each): all four
hold, or the gate fails.

| # | What | Rule |
|---|---|---|
| T1 | Time, trivial | the median decision time (nearest rank, as `nunchi trust`) **≤ 10 s** |
| T2 | Time, medium | the median decision time **≤ 10 s** |
| T3 | Agreement, trivial | the share of decisions equal to gold (decision kind) **≥ 80%** |
| T4 | Agreement, medium | the share of decisions equal to gold **≥ 80%** |

All are point estimates, as the design states them. Gating each class apart is stricter than pooling them: a fast
trivial class cannot carry a slow medium one (statistical review; T10). Worked numbers: 40/50 agreements → 80%
(66.3–90.0%, two-sided 95% Clopper–Pearson, ignoring that decisions cluster by participant).

## 5. Secondary (reported, never gating)

- Hard groups: median and p90, no gate.
- Per participant: median and agreement; the median of the participants' medians.
- The learning curve: time by position in the sequence (1–30), per participant and pooled.
- The owner's times and agreement, apart.
- *Later* decisions: count and time, apart (design §3.5).

## 6. Exclusions

- A *Later* is not a decision: its time is left out of T1 and T2, and it counts as a disagreement in T3 and T4.
- A participant who decides fewer than 24 of the 30 groups is replaced by a new participant; the partial data are
  reported apart.
- A decision interrupted by the moderator for a technical problem is left out and logged with the reason. A time at the
  120 s cap is kept as 120 s.

## 7. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | names the participants and reviewer A (D4); one gold judge; does the task apart |
| Gold judge | reviewer A, a person who did not build nunchi and not a participant | the second judge of class and gold (≈ 1 h) |
| Participants | ≥ 5 people who did not build nunchi | decide the 30 groups |
| Moderator | a person (the owner may moderate) | reads the briefing, notes interruptions, never helps decide |
| Operator | an agent session or a person | builds the study copies, runs the scorer |

## 8. Amendment policy

The common policy holds. If fewer than 5 participants are named by the field round (D5), the measure is "reported,
not gated": §4's rules are reported as targets and the spec §8 row says so.

## Amendments

| When (KST) | What | Why |
|---|---|---|
