# Pre-registration: precision after verification

Status: **draft, not registered** (2026-10-15 KST). Registered when the hash table below is filled and committed,
**before the sweeps that make the population** (§3), so the sample's seed cannot be chosen after the population is
known. Common rules: [prereg-README.md](prereg-README.md).

The technical choices T1–T11 of [prereg-README.md](prereg-README.md) apply here as defaults unless the owner overrides
them before registration; the owner decisions D1–D10 are recorded there (2026-10-15 KST).

Covers design 0.1-c §9.2 (precision, strata, rubric, labellers, rule precision on field apps), §9.7 (D) (Codex's
confirmed claims) and spec §8 "Precision after verification". Label mode (`nunchi open --label`) is built (M2, spec
§7.2).

## 1. Hashes and seeds

```prereg-sets
gate     precision
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/precision-gate.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
seeds    sample decoys known
```

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-precision.md`; never
typed by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Decided 2026-10-15 KST ([prereg-README.md](prereg-README.md)): **D3** option (b), 150 confirmed groups from ≥ 3 apps,
pass at ≥ 135; option (a) (50 groups, an estimate) is struck. **D1** held-out apps 2 and 3, part of the population.
Still open: **D4** the owner names reviewer A, the second labeller.

To build (README builds B7 and B8: `bench/precision-gate.mjs` in the scorer set, label mode in the engine set):
1. `--pool` (B7): draws the strata of §3 with the registered `sample` seed (`stratifiedDraw` of `scripts/prereg-stats.mjs`);
   adds decoys (false claims made like `verify --plan`'s, on the pool apps' screens, seeded by `decoys`) and known-true
   items (held-out seeds phrased as a hunter would claim them, at their location, seeded by `known`; never a seed
   whose defect is also a sampled group); writes one label
   pool per labeller's copy, and the key (which item is which stratum, decoy or known) outside the project, as the
   other answer keys (spec §5.1).
2. Label mode serves a harness pool (B8): rule groups and the harness's items beside the ledger's AI groups, the banner's
   count from the pool, nothing that tells the strata apart (source, verdict, severity stay hidden, as now).
3. `--score` (B7): both labellers' labels and the key in, §4–§5's statistics out, through `scripts/prereg-stats.mjs`.

## 3. Population, sample and procedure

**Apps:** held-out apps 2 and 3 and the three field round-2 apps ([prereg-field.md](prereg-field.md)): five apps,
none the lenses were tuned on. Pebble and pegroom are excluded (development set; seen).

**Population:** per app, one sweep as a user runs it, after registration, with the registered engine: `capture`,
`hunt` at the default budget, `verify` in a fresh context, folded into that app's ledger. The population is the
ledger's AI groups and the sweep's rejected and insufficient claims at that moment; it is frozen when `--pool` runs.

**The pool** (unit: the ledger group; one item per group):

| Stratum | Items |
|---|---|
| confirmed, not suspect (the main stratum) | 150, an equal share per app, the shortfall of a small app taken from the others in seeded order |
| rejected by the verifier | 40 |
| insufficient | all, up to 20 |
| not double-checked (claimed only, suspect, too few decoys) | 10 |
| rule groups on the field apps (§6) | 100 |
| decoys (false claims) | 27 |
| known-true items | 27 |
| at most | 374 |

If an app set has fewer confirmed groups than the main stratum asks for, all are taken (a census) and the pass count
is recomputed for that n (§4).

**Labelling:** the owner and reviewer A each label **the whole pool**, apart, in their own copy
(`nunchi open --label --labeller <name>`; keys 1 correct, 2 wrong, 3 unsure; their own hash order). Neither sees the
other's labels, the verdicts, the severities or the board until both are done. Labelling comes **before** the field
round's judging of the same apps, which shows verdicts.

**Rubric** (design §9.2), shown to both labellers in writing before they start: an item is *correct* iff the defect
exists in the cited scene, at the cited element or its ancestor or descendant, is a defect under the lens definition
shown, and is not something that definition says the rule lenses report (for a rule item: under the rule's own
definition). *Unsure* counts as wrong. Severity is not labelled in this round (label mode has no severity key).

## 4. Primary statistic and pass rule

k = main-stratum items **both** labellers marked correct; n = main-stratum items after §7's exclusions.

**Pass iff the one-sided 95% Clopper–Pearson lower bound of k/n is ≥ 85%**: at n = 150, k ≥ 135 (135/150 → 85.0%;
134/150 → 84.3%). For a census below 150: n = 100 needs 92, 120 needs 109, 130 needs 118. The two-sided 95% interval
is reported beside it. (Option (a), 50 groups published as an estimate such as "86% (73–94)", was declined: 50 labels
show a lower bound ≥ 85% only at ≥ 47/50.)

**The measurement is valid only if all hold**, else it is *inconclusive* (no claim either way):
- Cohen's κ between the two labellers on the main stratum (three categories) ≥ 0.6;
- each labeller accepts ≤ 10% of decoys (≤ 2 of 27) and marks ≥ 90% of known-true items correct (≥ 25 of 27);
- *unsure* is ≤ 10% of either labeller's main-stratum labels.

## 5. Secondary (reported, never gating)

- Correct rate per stratum with two-sided 95% intervals: rejected (the verifier's false rejections), insufficient, not
  double-checked.
- Precision before verification, the strata weighted back to the population (`weightedProportion`).
- Per lens and per app (screening only), κ per stratum, each labeller's own rate.
- Codex (design §9.7 D): when the Codex sweeps of [prereg-codex.md](prereg-codex.md) ran, their confirmed groups are a
  stratum of their own (up to 50, same pool, same labellers), reported apart; otherwise the report says Codex's
  precision is unmeasured.
- Stop/pivot (spec §8 H16): the main stratum's rate is the post-verification precision compared with 70%.

## 6. Rule precision on field apps (design §9.2, new)

The rule groups of the three field round-2 apps, rules frozen (the engine hash above): 100 drawn with the `sample`
seed, an equal share per app, labelled in the same pool by the same two labellers. Correct only if both agree. **Pass
iff k/100 ≥ 85%** (a point estimate, as the design says), with the one-sided 95% lower bound reported (85/100 → 77.9%;
a lower bound ≥ 85% would need 92/100). Fewer than 100 rule groups: all of them, the rate and bound reported for that n.

## 7. Exclusions

- An item whose screenshot or element cannot be shown (evidence missing) is excluded and listed; more than 5% of the
  main stratum excluded makes the measurement inconclusive.
- Two items of one group (a duplicate the draw cannot make, but a pool built twice could) count once.
- A labeller who stops before the end is not replaced silently: their partial labels are reported, and a replacement
  labels the whole pool from the start.

## 8. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | names reviewer A (D4); first labeller |
| Second labeller | reviewer A, a person who did not build nunchi | labels the whole pool, blind (≈ 3 h) |
| Operator | an agent session or a person | runs the sweeps, `--pool` and `--score`; never labels |
| Verifiers | fresh agent contexts | the sweeps' `verify` step |

## 9. Amendments

The common policy holds. A rubric clarification asked by a labeller during labelling is answered in writing to both
labellers and listed; it is not a scoring change unless it changes a label already given, which is then an amendment.
