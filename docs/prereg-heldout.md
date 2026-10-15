# Pre-registration: held-out apps 2 and 3

Status: **draft, not registered** (2026-10-15 KST). It becomes registered when the hash table below is filled by
`scripts/prereg-hash.mjs --fill` and committed, before either app is built or captured. Common rules (sides,
amendments, roles, registration steps): [prereg-README.md](prereg-README.md).

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
seeds    salt-1 salt-2 salt-3 order-1 order-2 order-3 sample bootstrap
```

`@app-2` and `@app-3` are each app's folder, a git repository of its own, kept outside nunchi's repository by the seed
author until §3's last step; `@key-2` and `@key-3` are their answer keys, kept apart from the apps.

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-heldout.md --key app-2=<folder>
--key app-3=<folder> --key key-2=<file> --key key-3=<file>`; never typed by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Owner decisions ([prereg-README.md](prereg-README.md)): **D1** (two new apps, who writes them, the token budget) and
**D2** (Codex access before step 4, so the Codex comparison runs on the same frozen engine,
[prereg-codex.md](prereg-codex.md)). People: **D4** (the second labeller and the adjudicator).

To build (each lands in the scorer or engine set above, so it is hashed):
1. **Plan salt.** `hunt --plan --salt <n>`: the salt enters the reference scene's hash (`pickReference`), so each run
   compares a scene with another reference. Salt 0 keeps today's plans byte for byte (a contract test).
2. **Packets** (`bench/ai-gate.mjs --packets`): units from a seeded random sample of the plan with at least 3 non-seed
   units per seed unit, interleaved in a seeded order, plus the clean units and canary copies; `--order <seed>`. The
   hunter brief is unchanged.
3. **Location scorer** (`bench/score.mjs`): a hunter claim hits a seed only at the seed's location: the same element
   (selector equal after normalisation, or an ancestor or descendant of it, or a box overlapping at least half of the
   smaller one, as a canary hit) or a `file:line` inside the seed's line range; lens and route must match, and the
   checklist item when the seed names one. Claims that match a seed's lens and route but not its location are listed
   for blind adjudication (§6).
4. **Run tally** (`bench/ai-gate.mjs --score`): per seed, found in how many of the 3 runs; the primary and secondary
   statistics of §4–§5 through `scripts/prereg-stats.mjs`.
5. **Answer-key schema**: each AI seed carries its location (`at`: selector or `aria=` node, box, or `file` and
   `lines`), its checklist item when it has one, and `offChecklist: true` when no checklist item covers it.

Supplied by the seed author (§7), per app:
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

1. Register (this file, hashes filled), commit, push. Nothing below starts before that commit.
2. Per app, the operator runs `node bench/run.mjs --app <app folder> --twice`: rule recall, clean-scene rule findings,
   determinism and fingerprint stability (replay).
3. Per app, three AI runs `r = 1, 2, 3`, each on its own capture with 3 canary copies (run 1 on step 2's first capture,
   runs 2 and 3 on new captures replaying its recording):
   `hunt --plan --budget all --salt <salt-r>`, packets with `--order <order-r>` and the unit sample from `sample`,
   one fresh hunter subagent per packet (packet files only), then `verify --plan` and a fresh verifier context per
   verify packet (`verify --record`).
4. Codex runs on the same captures, salts and packets ([prereg-codex.md](prereg-codex.md)), before step 6.
5. One end-to-end sweep per app through the skill at the default budget (400,000 tokens), hunt and verify: budget
   recall (§5).
6. Scoring: the custodian gives the keys; `bench/ai-gate.mjs --score` per app and pooled. Adjudication (§6).
7. Live stability: two live captures of each app a day apart, without replay (§5).
8. The results go into spec §9 with this file's commit; the apps and keys are then copied into `bench/heldout/` and
   `bench/answers/`, and `--check` is run against the originals to show they are the registered ones. From then on
   both apps are *seen*.

## 4. Primary statistic and pass rule

The gate passes only if every line holds:

| # | What | Rule |
|---|---|---|
| P1 | Rule recall | 100% of rule seeds found, both apps (deterministic, as in spec §9.1) |
| P2 | AI recall, pooled | K = on-checklist AI seeds found in **at least 2 of the 3 runs**; pass if the one-sided 95% Clopper–Pearson lower bound of K/n is ≥ 75% |
| P3 | AI recall after verification | as P2, counting a seed only when a confirmed, non-suspect claim hit it; and the verifier rejected ≤ 10% of the claims that hit seeds |
| P4 | Clean scenes | confirmed false positives over all clean scenes (rule findings, and confirmed AI claims that the two labellers do not both mark correct): one-sided 95% exact Poisson upper bound ≤ 0.1 per scene |
| P5 | Determinism, fingerprints | 2 captures byte-identical per app; fingerprint stability ≥ 95% with replay and ≥ 95% live (step 7) |

Worked numbers (from `scripts/prereg-stats.mjs`):

| n (on-checklist seeds) | 56 | 60 | 64 | 70 | 80 |
|---|---|---|---|---|---|
| smallest K that passes P2 | 48 | 51 | 55 | 59 | 67 |

- 48/56 has a one-sided lower bound of 75.7%, 47/56 of 73.6%.
- Clean scenes (P4): with 60 scenes, 0 confirmed false positives give an upper bound of 0.050 per scene, 1 gives
  0.079, 2 give 0.105 (fails). With 80 scenes, 3 give 0.097 (passes).

**Per lens (screening, design §9.1).** Pooled over both apps, each AI lens has ≥ 10 on-checklist seeds. A lens is
*experimental* (off by default) if its majority recall is < 75% or it has ≥ 2 missed seeds. Screening does not fail
the gate; it decides how a lens ships.

## 5. Secondary (reported, never gating)

- Mean-of-runs recall (each seed scores found/3), with a seeded percentile bootstrap over seeds (`bootstrap`, 20,000
  resamples, two-sided 95%): design §9.1's "the CI is bootstrapped over seeds". Reported beside P2 so the majority
  rule's effect is visible.
- Recall per run (run 1, 2, 3) with two-sided 95% Clopper–Pearson intervals; recall per app; per lens per run.
- Off-checklist seeds: found / seeded, apart (coverage).
- Budget recall: seeds found by the default-budget sweep (step 5), and the cells it left *not seen: budget*.
- Canary hit rate per run: run health only, never evidence of recall.
- Rejected answers, cells seen, tokens and minutes per run.

## 6. Exclusions and adjudication

- A seed whose scenes failed to capture in a run (`not-captured`, an app crash) is re-captured once. Still failing, it
  counts as missed in that run if nunchi caused it, and is excluded and listed if the app did. More than 5% of seeds
  excluded makes the gate inconclusive.
- A seed the key describes but the app does not show (a seed author's bug) is excluded only when the adjudicator (§7),
  looking at the screens without knowing any run's result, finds it absent. Listed.
- Claims that match a seed's lens and route but not its location (§2 item 3) go to the adjudicator, blind to the run
  and to which agent made them, with the seed's description and the claim's evidence: *same defect* counts as a hit.
- Canary copies are never seeds or clean scenes.

## 7. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | decisions D1, D2, D4; approves the registration; first labeller |
| Seed author and key custodian | a different vendor's model session, or a person, that never tuned a lens | writes both apps, the taxonomy and the keys; keeps them outside the repository until step 8; gives the keys for scoring |
| Operator | an agent session or a person that never opens the apps' source or the keys | runs steps 2–7 |
| Hunters, verifiers | fresh agent contexts, one per packet | read their packet's files only |
| Labellers | the owner and the second labeller (a person who did not build nunchi) | label the AI claims on clean scenes (rubric of [prereg-precision.md](prereg-precision.md)) |
| Adjudicator | a person who did not build nunchi and is not the seed author | decides §6's cases blind to runs and agents |

## 8. Amendments

The common policy holds. In particular: each miss is explained once, after scoring; an engine fix made from it makes
the app *seen*, and any re-measure on it is reported as not blind. A scorer change after scoring is reported beside
the registered numbers, and only a later fresh app can confirm it.
