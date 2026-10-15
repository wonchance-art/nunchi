# Pre-registration: held-out apps 2 and 3

Status: **draft, not registered** (2026-10-15 KST; revised after the statistical review the same day). It becomes
registered when the hash table below is filled by `scripts/prereg-hash.mjs --fill` and pushed, before either app is
built or captured. Common rules (sides, amendments, roles, registration steps): [prereg-README.md](prereg-README.md).

The technical choices T1–T13 of [prereg-README.md](prereg-README.md) apply here as defaults unless the owner overrides
them before registration; the owner decisions D1–D10 are recorded there (2026-10-15 KST).

Covers design 0.1-c §9.1 (AI recall), §9.3 (clean scenes), §9.9 (held-out apps, live stability) and these rows of
spec §8: recall of rule lenses, recall of AI lenses, false positives on clean scenes, determinism, fingerprint
stability, held-out benchmark. Pegroom (spec §9.4) was held-out app 1; it is seen now. Pebble is the development set:
reported, never pooled.

## 1. Hashes and seeds

```prereg-sets
gate     heldout
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/score.mjs bench/ai-gate.mjs bench/run.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
apps     @app-2 @app-3
keys     @key-2 @key-3
seeds    salt-1 salt-2 salt-3 order-1 order-2 order-3 sample
beacon   drand 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971 ROUND
```

`@app-2` and `@app-3` are each app's folder, a git repository of its own, kept outside nunchi's repository by the seed
author until §3's last step; `@key-2` and `@key-3` are their answer keys, kept apart from the apps. `ROUND` is set at
registration to a drand round published after the push (README, "How a draft becomes registered").

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-heldout.md --key app-2=<folder>
--key app-3=<folder> --key key-2=<file> --key key-3=<file>`, and the seeds by `--seeds` after the push; never typed by
hand.
<!-- prereg-hash:end -->

## 2. Before registration

Decided 2026-10-15 KST ([prereg-README.md](prereg-README.md)): **D1** two new invented apps and their keys, written by
a different vendor's model session that never tuned a lens (about 15M hunting tokens per app for 3 runs); **D2** Codex
access before the apps are captured, so the Codex comparison runs on the same frozen engine
([prereg-codex.md](prereg-codex.md)). Still open: **D4** the owner names reviewer A (presence check, labelling,
adjudication).

To build (README builds B1–B5; each lands in the scorer or engine set above, so it is hashed):
1. **Plan salt** (B1). `hunt --plan --salt <n>`: the salt enters the reference scene's hash (`pickReference`), so each run
   compares a scene with another reference. Salt 0 keeps today's plans byte for byte (a contract test).
2. **Packets** (B2, `bench/ai-gate.mjs --packets`): units from a seeded random sample of the plan with at least 3 non-seed
   units per seed unit, interleaved in a seeded order, plus the clean units and canary copies; `--order <seed>`. The
   hunter brief is unchanged.
3. **Location scorer** (B3, `bench/score.mjs`): a hunter claim hits a seed only at the seed's location: the same element
   (selector equal after normalisation, or an ancestor or descendant of it, or a box overlapping at least half of the
   smaller one, as a canary hit) or a `file:line` inside the seed's line range; lens and route must match, and the
   checklist item when the seed names one. Claims that match a seed's lens and route but not its location are listed
   for blind adjudication (§6).
4. **Run tally** (B4, `bench/ai-gate.mjs --score`): per seed, found in how many of the 3 runs; the primary (§4: the exact
   bootstrap bound of mean-of-runs recall, `latticeBootstrap`), the worst run, majority of 3 and the sensitivity result
   (§6), through `scripts/prereg-stats.mjs`.
5. **Answer-key schema** (B5): each AI seed carries its location (`at`: selector or `aria=` node, box, or `file` and
   `lines`), its checklist item when it has one, and `offChecklist: true` when no checklist item covers it.

Supplied by the seed author (D1, §7), per app:
- an invented app (no real product's content, copy or screens) on a stack nunchi supports (spec §2.5: Next.js app or
  pages router, React Router, TanStack Router); the two apps use two different stacks, and at most one shares a stack
  with Pebble (Next.js app router) or pegroom (React Router);
- at least 12 routes, a `bench.json` like pegroom's;
- **AI seeds**: at least 5 per AI lens (L1, L2, L4, L5, L6, L7, L9, L10) covered by a checklist item, so at least 40,
  plus about 10 off-checklist seeds (about 20% of all AI seeds); drawn from a written taxonomy of real field defects,
  never written by a session that tuned the lenses;
- **rule seeds**: at least 30, over at least 25 rule ids;
- **clean scenes**: at least 30 captured scenes on routes with no seed;
- the answer key with locations (item 5 above).

## 3. Sample and procedure

Unit: the seed. Sample: every seed of both answer keys (no draw). The primary pool is the on-checklist AI seeds,
**n ≥ 80** by construction (≥ 56 required by design §9.1).

1. Register (this file, hashes filled), commit, push; after the beacon round, derive the seeds (`--seeds`), commit,
   push. Nothing below starts before both pushes.
2. Per app, the operator copies the app folder (the registered one is never installed or built) and runs `node
   bench/run.mjs --app <copy> --twice`: rule recall, clean-scene rule findings, determinism and fingerprint stability
   (replay). The results record `node --version` and the Chromium version the capture printed.
3. Per app, three AI runs `r = 1, 2, 3`, each on its own capture with 3 canary copies (run 1 on step 2's first capture,
   runs 2 and 3 on new captures replaying its recording):
   `hunt --plan --budget all --salt <salt-r>`, packets with `--order <order-r>` and the unit sample from `sample`,
   one fresh hunter subagent per packet (packet files only), then `verify --plan` and a fresh verifier context per
   verify packet (`verify --record`).
4. Codex runs on the same captures, salts and packets ([prereg-codex.md](prereg-codex.md)), before step 6.
5. One end-to-end sweep per app through the skill at the default budget (400,000 tokens), hunt and verify: budget
   recall (§5).
6. **Presence check, before any scoring:** reviewer A gets every seed's description and location and the captured
   screens of step 2's first capture, and no run's claims or results, and marks each seed *present* or *absent*. The
   list is committed before step 7.
7. Scoring: the custodian gives the keys; `bench/ai-gate.mjs --score` per app and pooled. Adjudication (§6).
8. Live stability: two live captures of each app a day apart, without replay (§5).
9. The results go into spec §9 with this file's commit; the apps and keys are then copied into `bench/heldout/` and
   `bench/answers/`, and `--check` is run against the originals to show they are the registered ones. From then on
   both apps are *seen*.

## 4. Primary statistic and pass rule

The gate passes only if every line holds:

| # | What | Rule |
|---|---|---|
| P1 | Rule recall | 100% of rule seeds found, both apps (deterministic, as in spec §9.1) |
| P2 | AI recall, pooled | R = mean-of-runs recall over the on-checklist AI seeds (each seed scores found / 3); pass iff the one-sided 95% lower bound of R by the **exact bootstrap over seeds** (`latticeBootstrap`) is ≥ 75% |
| P3 | AI recall after verification | as P2, a seed counting in a run only when a confirmed, non-suspect claim hit it; and the verifier rejected ≤ 10% of the claims that hit seeds |
| P4 | Clean scenes | per run, confirmed false positives on the clean scenes of both apps (rule findings, and confirmed AI claims the two labellers do not both mark correct), a false positive repeated in another run counted again there; the gate takes **the worst of the 3 runs**: its one-sided 95% exact Poisson upper bound ÷ the clean scenes ≤ 0.1 |
| P5 | Determinism, fingerprints | 2 captures byte-identical per app; fingerprint stability ≥ 95% with replay and ≥ 95% live (step 8) |

**Why the mean of runs, and what the rule does** (statistical review H3). A seed found in at least 2 of 3 runs, counted
with Clopper–Pearson, was the first draft's rule: when runs find seeds independently it inflates recall, and at a true
per-run recall of 75%, exactly the threshold, it passed 63% of the time. The registered rule uses all three runs and
the seed as the unit, as design §9.1 asks ("the CI is bootstrapped over seeds"). The exact bootstrap is the
percentile bootstrap's own limit (every resample counted, by convolution): no seed, no Monte Carlo error. Pass
probabilities at n = 80 seeds, 3 runs, from `node scripts/prereg-stats.mjs oc` (the independent model by 4,000 seeded
simulations, the all-or-none model exactly):

<!-- heldout-oc:begin -->
| True per-run recall | Model | Mean of runs, bootstrap bound (registered) | Majority of 3, Clopper–Pearson (replaced) | One run, Clopper–Pearson |
|---|---|---|---|---|
| 70% | independent | 0% | 15% | 0% |
| 75% | independent | 7% | 63% | 4% |
| 80% | independent | 64% | 96% | 25% |
| 85% | independent | 99% | 100% | 69% |
| 70% | all-or-none | 1% | 0% | 0% |
| 75% | all-or-none | 7% | 4% | 4% |
| 80% | all-or-none | 35% | 25% | 25% |
| 85% | all-or-none | 79% | 69% | 69% |
<!-- heldout-oc:end -->

*Independent*: every run of every seed finds it on its own; *all-or-none*: a seed is found in all runs or in none.
Real hunts lie between (spec §9.3–§9.4: most seeds were found in all three runs or in none). At the threshold the
registered rule passes about 7% of the time, a little over the nominal 5%: the percentile bootstrap is slightly
generous at this n, and the table says so rather than hiding it.

Worked numbers: when every seed is found in all runs or in none, 80 seeds pass at 66 found (Clopper–Pearson needed
67). With 64 seeds found 3/3, 6 found 2/3, 4 found 1/3 and 6 never, R = 86.7% and its lower bound is 80.8% (pass);
with 60, 8, 6 and 6, R = 84.2% and the bound 78.3%.

Clean scenes (P4): with 60 clean scenes, a worst run with 0 confirmed false positives gives an upper bound of 0.050 per
scene, 1 gives 0.079, 2 give 0.105 (fails). *Why the worst run:* spec §8 counts false positives per scene of a sweep;
taking each run apart keeps that unit, and taking the worst one avoids treating a false positive the hunter repeats
in every run as three independent ones.

**Per lens (screening, design §9.1).** Pooled over both apps, each AI lens has ≥ 10 on-checklist seeds. A lens is
*experimental* (off by default) if its mean-of-runs recall is < 75% or it has ≥ 2 seeds missed in a majority of runs.
Screening does not fail the gate; it decides how a lens ships.

## 5. Secondary (reported, never gating)

- **The worst run:** seeds found in the run that found fewest, with its two-sided 95% Clopper–Pearson interval.
- **Majority of 3** (the replaced rule): seeds found in ≥ 2 of 3 runs, with its Clopper–Pearson bound.
- Recall per run (run 1, 2, 3) with two-sided 95% intervals; recall per app; per lens per run.
- The sensitivity result of §6.
- Off-checklist seeds: found / seeded, apart (coverage).
- Budget recall: seeds found by the default-budget sweep (step 5), and the cells it left *not seen: budget*.
- Canary hit rate per run: run health only, never evidence of recall.
- Rejected answers, cells seen, tokens and minutes per run.

## 6. Exclusions and adjudication

- **Absent seeds** are only those reviewer A marked absent in step 6's presence check, made before any scoring and
  blind to every result. Nothing found absent later is excluded.
- A seed whose scenes failed to capture in a run (`not-captured`, an app crash) is re-captured once. Still failing, it
  counts as missed in that run if nunchi caused it, and is excluded and listed if the app did.
- **All exclusions together** (absent seeds and capture failures) above 5% of the on-checklist seeds make the gate
  inconclusive.
- **Sensitivity:** P2 and P3 are also computed with every excluded seed counted as missed in every run, and reported
  beside the registered numbers.
- Claims that match a seed's lens and route but not its location (§2 item 3) go to reviewer A as adjudicator, blind to
  the run and to which agent made them, with the seed's description and the claim's evidence: *same defect* counts as
  a hit.
- Canary copies are never seeds or clean scenes.

## 7. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | names reviewer A (D4); approves the registration; first labeller |
| Seed author and key custodian | a different vendor's model session that never tuned a lens (D1) | writes both apps, the taxonomy and the keys; keeps them outside the repository until step 9; gives the keys for scoring |
| Operator | an agent session or a person that never opens the apps' source or the keys | runs steps 2–5 and 7–8 |
| Hunters, verifiers | fresh agent contexts, one per packet | read their packet's files only |
| Labellers | the owner and reviewer A (a person who did not build nunchi) | label the AI claims on clean scenes (rubric of [prereg-precision.md](prereg-precision.md)) |
| Reviewer A | a person who did not build nunchi, not the seed author | the presence check (step 6) and §6's adjudication, blind to runs and agents |

## 8. Amendment policy

The common policy holds. In particular: each miss is explained once, after scoring; an engine fix made from it makes
the app *seen*, and any re-measure on it is reported as not blind. A scorer change after scoring is reported beside
the registered numbers, and only a later fresh app can confirm it.

## Amendments

| When (KST) | What | Why |
|---|---|---|
