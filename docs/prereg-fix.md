# Pre-registration: fix loop, detector sensitivity, re-check validation

Status: **draft, not registered** (2026-10-15 KST). Registered when the hash table below is filled and committed,
before the base sweep of §3. Common rules: [prereg-README.md](prereg-README.md).

The technical choices T1–T11 of [prereg-README.md](prereg-README.md) apply here as defaults unless the owner overrides
them before registration; the owner decisions D1–D10 are recorded there (2026-10-15 KST).

Covers design 0.1-c §9.4 (trials, functional checks, reporting, field sample, detector sensitivity, re-check
validation), spec §8 "Fix loop" (≥ 90% of seeded defects marked *fix* gone on re-capture, 0 caused regressions) and
the list in spec §9.5. `bench/fix-gate.mjs` (M3) is the harness; a harness run is not this gate.

## 1. Hashes and seeds

```prereg-sets
gate     fix
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/fix-gate.mjs bench/recheck-gate.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
app      bench/heldout/pegroom bench/answers/pegroom.json
sets     @fix-sets
seeds    order order-seq dev-sample review canaries
```

`@fix-sets` is the set builder's folder, a git repository of its own, kept outside nunchi's repository until the last
trial ends, so no fixer session can read it: `functional.json` (one check per seed and per field group),
`planted.json` (30 in-scope regressions), `clean.json` (20 clean fixes), `blind.json` (10 out-of-scope regressions),
`recheck.json` (30 still-there and 30 moved cases) and the regression taxonomy the builder worked from.

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-fix.md --key
fix-sets=<folder>`; never typed by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Decided 2026-10-15 KST ([prereg-README.md](prereg-README.md)): **D6** yes, the engine runs the repo's checks after a
person approves the check profile; **D7** pegroom, now; **D8** the sets are built by a different vendor's model session
that never read the fix judge, and reviewer A spot-checks 10 of their items. Still open: **D4** the owner names
reviewer A (spot check, diff review).

To build (spec §9.5, plus what this protocol adds; README builds B9–B13, each in the scorer set):
1. **Functional checks** (B9) in `bench/fix-gate.mjs`: declarative, run with the bundled browser after a trial ends, on the
   final code: the route answers and renders; a control is visible with its role and name; an image has a natural
   size; an element's box fits its container; a link's target answers 200.
2. **Sets with expectations** (B10): `planted`, `clean` and `blind` files in the recorded-fix format plus `expect`; the
   harness tallies *detected* and *false alarm* per §5.
3. **Fixer mode** (B11): per trial the harness prepares a fresh copy whose state is seeded from one base sweep (so AI items
   need one hunt and verification, not one per trial), with the seed's group decided Fix, and waits for a fresh fixer
   session; it then reads the engine's record. Today it applies recorded edits instead.
4. **A person approves the check profile** (B12) in the board, as a user does; the harness stops approving it as the
   operator. When the approval record does not bind the folder, one approval per app is copied into each trial and
   said in the report; otherwise one per trial.
5. **`bench/recheck-gate.mjs`** (B13): builds §6's cases into re-check plans (`recheck --plan`, the product path, with its
   controls) and scores the answers from a key kept outside the project.

## 3. Sample and procedure (Part A: the seeded trials — the gate)

**App:** pegroom (D7, decided). The fix loop was never run or tuned on it; its recall results are seen (spec §9.4), which
does not touch this gate. Pebble is excluded: the recorded edits and two engine fixes were tuned there (spec §9.5).

1. Register, commit, push.
2. **Base sweep**, once: capture (`--network record`, `--canaries` enough for 30 canary copies over the captures,
   seeded by `canaries`), the rule lenses, `hunt --budget all` and `verify` in fresh contexts. The owner decides Fix,
   in the board, for every group that holds a seed. Sample = every seed whose group the base sweep shows (rule seeds
   by rule, AI seeds confirmed and not suspect), except whole-app groups with no route (the loop refuses them, spec
   §6.2): listed. Seeds that share a group are one trial. At most 66 (pegroom has 38 rule and 28 AI seeds, spec
   §9.4); no draw.
3. **Independent trials** in the order `seededShuffle(seeds, order)`: a fresh copy and state per seed, a fresh fixer
   session told "fix them", `--serve start`, at most 2 attempts as the product allows. The seed's functional check
   runs on the final code.
4. **One sequential pass**: every seed on one copy in the order `order-seq`, one fixer session. Afterwards a full
   rule sweep of that copy and every functional check.
5. **`--serve dev`**: 10 seeds drawn with `dev-sample`, run again as independent trials under `--serve dev`.
6. **Field sample**: ≥ 20 confirmed groups of the field round-2 apps ([prereg-field.md](prereg-field.md)) decided Fix
   by the owner, as independent trials in local copies (nothing pushed upstream), with functional checks the set
   builder wrote before the trials.
7. **Diff review**: 10 kept fixes drawn with `review` from all kept fixes of steps 3, 4 and 6, shown to the diff
   reviewer without their outcome.

**Outcome per trial:** *fixed* = the engine's outcome `fixed` within 2 attempts **and** the functional check passes.
Everything else is *not fixed*: reverted twice, any *needs you* (a, b, c, diff, unbaselined), a refusal, a failed
functional check. *Fixed at the first attempt* is counted apart.

## 4. Primary statistic and pass rule

The gate passes only if every line holds:

| # | What | Rule |
|---|---|---|
| A1 | Fixed rate | F = fixed / n over §3 step 3's trials; pass iff **F ≥ 90%** (a point estimate, spec §8), its two-sided 95% Clopper–Pearson interval reported |
| A2 | No caused regression | over every kept fix of steps 3, 4 and 6: no functional check fails, step 4's final sweep shows no new rule finding by element identity on a route in the fixes' scopes, and no reviewed diff is judged to break something (confirmed by the owner) |
| B | Detector sensitivity | ≥ 28 of 30 planted in-scope regressions detected **and** ≤ 1 false alarm in 20 clean fixes (§5) |
| C | Re-check validation | §6's three rules |

Worked numbers: 54/60 → 90.0% (79.5–96.2%); 36/40 → 90.0% (76.3–97.2%). A rule on the lower bound would need 40/40
or 59/60, so the design's target is kept as a point estimate. With A2 and B holding, the claim is "0 caused
regressions detected in N kept fixes (true rate ≤ 3/N), detector sensitivity 28/30 (one-sided 95% lower bound
80.5%)"; 0 in 40 gives an upper bound of 7.2%. If C fails, A1 is reported for rule seeds only and the gate fails for
AI items.

## 5. Part B: detector sensitivity

Built by the set builder (D8: a different vendor's model session; reviewer A spot-checks 10 items for realism before
the first trial): not the fixer, and someone who has not read `src/fix/judge.mjs`, spec §6.5, design §4.5
or this file's thresholds. They work from a brief kept in `@fix-sets` (what is in and out of scope, in the words
below) and a written taxonomy of regressions (a control moved, hidden or renamed, a link broken, an overflow, a lost
image, a contrast drop, a shifted layout). Every item is a recorded fix of a pegroom seed (the edit that removes the
defect), plus for a regression one more edit:
- **in-scope (exactly 30)**: the break is visible to a person at 100% zoom on a screen the fix touches (the group's
  routes, and routes that render the same files): a defect of a kind the rule lenses report (spec §3), or a control
  that moved, appeared or vanished, or another visible change of the screen;
- **clean (exactly 20)**: the defect's own fix and nothing else;
- **out-of-scope (exactly 10)**: copy or logic changes that need no visual change: known blind spots.

Run with `bench/fix-gate.mjs --fixes <file>` (recorded edits, no AI fixer), independent trials, seeded order.
*Detected* = outcome `caused-regression` or any *needs you*. *False alarm* = a clean fix with any outcome but `fixed`.
An inconclusive outcome caused by the machine (the app did not start) is run once more; after that, the outcome
counts as the product showed it. Out-of-scope items are reported as blind spots, detected or not.

The drift thresholds (2 px, 1% of first-view pixels at YIQ 0.1) stay as built: tuning them on these sets would leave
nothing to measure them with. A calibration, if wanted, happens on Pebble before registration and enters the engine
hash.

Worked numbers: 28/30 → one-sided 95% lower bound 80.5%; 1/20 false alarms → upper bound 21.6%.

## 6. Part C: re-check validation (design §2.4, §9.4)

Three sets of 30 cases on pegroom, each a re-check packet built by `recheck --plan` within ordinary batches (with their
controls), answered by fresh re-checker contexts as the skill runs them:
- **still there**: a confirmed AI item of the base sweep, and the set builder's edit that changes its screen and keeps
  the defect; right answer `still-there`;
- **moved**: an edit that moves the defective element elsewhere on the same screen; right answer `still-there`;
- **already fixed**: a canary's claim asked on the scene it was copied from (spec §4.1); right answer `gone`.

Pass iff: still there ≤ 1 `gone` of 30; moved ≤ 1 `gone` of 30; already fixed ≤ 3 `still-there` of 30. Inconclusive
when `insufficient` is more than 3 of 30 in any set. A suspect batch (controls) is asked once more, then counted.
Upper bounds reported: 1/30 → 14.9%, 3/30 → 23.9% (one-sided 95%).

## 7. Secondary (reported, never gating)

First-attempt rate; per-outcome counts (needs you by kind); the `--serve dev` trials apart; the sequential pass's
outcomes and batch line; the field sample's rate (e.g. 18/20 → 68.3–98.8%); the diff review's four answers ("fixes the
cause", "hides it", "breaks or changes something else", "can't tell"); time per trial, and the fixer's tokens where
the agent reports them.

## 8. Exclusions

- A trial the harness could not run (an edit that does not apply, a copy that does not build at all) is a harness
  error: fixed and rerun once; listed. Engine refusals are outcomes, never exclusions.
- A seed whose functional check the set builder marks broken before any trial ran is rewritten then; after the first
  trial, check changes are amendments.

## 9. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | names reviewer A (D4); decides Fix and approves the check profile in the board |
| Fixer | a fresh agent session per trial, through the skill | fixes; never reads `@fix-sets` |
| Set builder | not the fixer: a different vendor's model session that never read the judge (D8) | builds `@fix-sets` and its taxonomy; reviewer A spot-checks 10 items (≈ 1 h) |
| Re-checkers | fresh agent contexts | answer re-check packets |
| Diff reviewer | reviewer A, a person who did not build nunchi | reviews 10 diffs blind to outcome (≈ 1 h) |
| Operator | an agent session or a person | runs the harness; never edits a fix |

## 10. Amendments

The common policy holds. The order seeds are printed by the harness; a trial run out of order is reported as such.
