# Pre-registration: Codex CLI compatibility

Status: **draft, not registered** (2026-10-15 KST). Registered with the held-out measurement
([prereg-heldout.md](prereg-heldout.md)), at the same engine, before either held-out app is captured. Common rules:
[prereg-README.md](prereg-README.md).

The technical choices T1–T11 of [prereg-README.md](prereg-README.md) apply here as defaults unless the owner overrides
them before registration; the owner decisions D1–D10 are recorded there (2026-10-15 KST).

Covers design 0.1-c §9.7 (A)–(D) and spec §8 "Compatibility: same benchmark results from Claude Code and Codex CLI".
The design names the two agents; neither is a model name.

## 1. Hashes and seeds

```prereg-sets
gate     codex
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/score.mjs bench/ai-gate.mjs bench/codex-gate.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
apps     @app-2 @app-3
keys     @key-2 @key-3
seeds    probe
```

The apps and keys are the held-out ones, given the same way. The plan salts, packet orders and unit samples are those
registered in [prereg-heldout.md](prereg-heldout.md): both agents get the same packets.

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-codex.md --key app-2=<folder>
--key app-3=<folder> --key key-2=<file> --key key-3=<file>`; never typed by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Decided 2026-10-15 KST ([prereg-README.md](prereg-README.md)): **D2** yes, before the held-out capture. The owner
provides an installed, signed-in Codex CLI the operator may run, before step 3 of the held-out procedure. If it arrives
later anyway, the held-out apps are seen by then and (C) is reported as not blind.

To build (README build B6, with B1–B4 shared with the held-out gate): `bench/codex-gate.mjs` hands each held-out
packet to a fresh Codex CLI session (one per packet, packet files only, the same hunter brief), collects the answers in
the `bench/ai-gate.mjs --score` layout, and runs (A)'s byte comparison. It never calls a model on its own; the
operator starts the sessions.

## 3. Procedure and pass rules

The gate passes only if (A), (B) and (C) pass, and (D) is either measured or stated as unmeasured.

**Pre-check: does Codex read the screenshots?** Three invented test images, each a JPEG of a plain page with one large
word and one coloured shape (the `probe` seed picks the words and shapes), are asked about in a packet like a
hunter's. All three must be answered right; otherwise (B) and (C) are void and the report says "Codex does not read
the screenshots: compatibility not claimed".

**(A) Engine outputs are byte-identical.** On Pebble (allowed here: this is not a recall measure), with one recording:
Codex and Claude Code each drive the skill's sweep up to the AI step. Compared: the capture's evidence (as `bench/run.mjs
--twice` compares), `hunt-plan.json` at the same salt, and `ai-findings.json` from `hunt --record` of one fixed answers
file. **Pass: 0 files differ.**

**(B) The protocol works**, on the held-out runs (3 runs per app, the same packets as Claude Code's):
- **100%** of Codex's answer files are schema-valid (`hunt --record` refuses none for its shape);
- grounding rejections: Codex's rejected claims ÷ its claims ≤ Claude Code's rate on the same packets **+ 5 points**;
- cells seen: Codex's seen cells ÷ the cells of its packets **≥ 95%**.

**(C) Non-inferior recall, paired by seed.** Per seed and agent, found in at least 2 of 3 runs (as
[prereg-heldout.md](prereg-heldout.md) P2). With b = seeds only Codex found and c = seeds only Claude Code found, over
the n on-checklist seeds: **pass iff the one-sided 95% lower bound of Codex − Claude Code recall is above −15
points**, by the Bonett–Price adjusted Wald interval for paired proportions (`pairedDifference` in
`scripts/prereg-stats.mjs`).

Worked numbers at n = 80 (the held-out minimum): b = 2, c = 5 (−3.8 points) → lower bound −9.6: pass; b = 0, c = 7
(−8.8) → −14.4: pass; b = 0, c = 8 fails; no discordant seed → −2.8. At n = 64: b = 2, c = 5 → −12.0: pass; b = 0,
c = 6 (−9.4) → −15.9: fails. At n = 56, b = 0, c = 5 already fails. The margin is narrow at these sizes: an observed
deficit much past 8 points does not pass at n = 80.

**(D) Precision.** Codex's own sweeps of the precision apps join the precision pool as a stratum of their own
([prereg-precision.md](prereg-precision.md) §5); without them the report says Codex's precision is unmeasured.

## 4. Secondary (reported, never gating)

The paired seeded bootstrap of the mean-of-runs difference (`bootstrapMean` over per-seed differences, the held-out
`bootstrap` seed); recall per agent per lens; tokens, packets and minutes per agent; which skill steps Codex could not
follow as written (the deny hook does not exist in Codex: spec §7.2).

## 5. Exclusions

A Codex session that fails for the machine (no network, an expired sign-in) is rerun once; a packet answered only
partly counts as answered with its cells not seen. A seed excluded from the held-out measurement is excluded here.

## 6. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | provides Codex CLI access before the held-out capture (D2) |
| Operator | a person, or an agent session with Codex CLI access, that never opens the apps' source or the keys | runs the Codex sessions and the comparison |
| Hunters | fresh Codex CLI sessions, one per packet | read their packet's files only |
| Seed author and key custodian | as in the held-out pre-registration | gives the keys for scoring |

## 7. Amendments

The common policy holds. A change to the skill so that Codex can follow it is an engine change: it needs a new
registration before any Codex data, or the results are reported as an amendment.
