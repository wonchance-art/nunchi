# Pre-registration: field test, rounds 2 and 3

Status: **draft, not registered** (2026-10-15 KST). Registered when the hash table below is filled and committed,
before the search of §3 is run. Common rules: [prereg-README.md](prereg-README.md).

Covers design 0.1-c §9.8 and §9.9 (stop/pivot) and spec §8 "Field test: 3 public vibe-coded apps: ≥ 5 findings per
app that a human judges 'didn't know, worth fixing'" and "Stop / pivot (H16)". Round 1 (spec §9.2) was a preview with
rule and computed lenses only; its three apps are seen. Round 2 is the gate. Round 3 runs only after a fix-and-rerun
round, as H16 asks: a fresh sample from fresh findings, the lenses frozen again (D9).

## 1. Hashes and seeds

```prereg-sets
gate     field
engine   src lenses hooks skills/nunchi/SKILL.md .claude-plugin package.json package-lock.json
scorer   bench/field-tally.mjs scripts/prereg-stats.mjs scripts/prereg-hash.mjs
seeds    judge-order
```

The apps are not hashed here: they are chosen after registration by §3's rule, and each one's repository and commit
are recorded in the round's log before it is captured. Round 3 is registered on its own (this file copied, `gate
field-3`), with the engine of that round.

<!-- prereg-hash:begin -->
*Not registered.* Filled at registration by `node scripts/prereg-hash.mjs --fill docs/prereg-field.md`; never typed
by hand.
<!-- prereg-hash:end -->

## 2. Before registration

Owner decisions ([prereg-README.md](prereg-README.md)): **D4** (the second judge and the manual-pass reviewer),
**D9** (round 3 on fresh apps), **D10** (upstream issues, the secondary measure).

To build: `bench/field-tally.mjs`, a tally of the judges' sheets (one JSON per app: each group, each judge's answers to
§4's questions) into §4's counts. Counting by hand is not allowed.

## 3. App selection (registered now, run once)

- **Search**, run once after registration with the GitHub search API, logged with its time (KST) and the full result
  list in order: query `lovable OR v0 OR bolt OR cursor OR "claude code" OR replit in:readme` with qualifiers
  `pushed:>=2026-07-01 fork:false archived:false`, sort `updated`, order `desc`, up to 300 results.
- **Eligibility**, checked in result order, each rejection logged with its reason:
  1. an OSI-permissive licence in the repository (MIT, Apache-2.0, BSD-2/3-Clause, ISC);
  2. the README names the AI builder used to make it;
  3. a web app (not a library, template or mobile app), with an English or Korean interface;
  4. ≥ 10 routes, counted by `nunchi discover`;
  5. builds and starts locally from its own README within 30 minutes of the operator's time, without a paid service
     or a real account (stub values the README documents are fine);
  6. not one of round 1's apps, and not an app any nunchi session has opened before;
  7. no adult content; no real people's data needed to use it.
- **The first 3 eligible apps** are the round's apps. An app that fails later (it stops building) is logged, and the
  next eligible one is taken.

Nothing from the apps is committed: evidence stays on the operator's machine; the log holds repository names,
commits, licences, counts and one-line paraphrases of counted findings, never their text or screens.

## 4. Procedure and counting rule

Per app, in this order:
1. **Manual pass**: the manual-pass reviewer, who has not seen any nunchi output for the app, uses the app for 15
   minutes and writes down every defect they notice (screen, what).
2. **Sweep** as a user runs it, with the registered engine: `capture`, rule lenses, `hunt` at the default budget,
   `verify` in a fresh context, folded into the ledger.
3. **Precision labelling** of the app's groups, blind, if the app is in that pool ([prereg-precision.md](prereg-precision.md)).
4. **Judging**: the two judges, apart, go through every group the board shows as confirmed or rule (in the order
   `judge-order`) and answer for each:
   - (a) correct under the precision rubric?
   - (b) at least *medium*, or does it block a task?
   - (c) already known: in the repository's issues (open or closed), README or TODO/FIXME comments, or in the manual
     pass's notes?
   - (d) would axe or Lighthouse (default categories, desktop and phone) report it? (Every L8 axe rule finding is yes.)

A finding **counts** iff both judges answer (a) yes, (b) yes, (c) no and (d) no, and it is a distinct group. Findings
with (d) yes that would otherwise count are **counted apart** (reported, not in the primary count).

## 5. Pass rule and stop/pivot

- **Field gate (round 2):** passes iff **each** of the 3 apps has ≥ 5 counted findings (spec §8).
- **Stop/pivot (H16), judged after round 3 (after round 2 when no round 3 is run):** the AI lenses go experimental
  and 0.1 ships rule and computed lenses only if the round's post-verification precision is < 70% (the main stratum of
  [prereg-precision.md](prereg-precision.md), point estimate) **or** the counted findings average < 3 per app.
- The number of looks (rounds measured) is reported with every result.

## 6. Secondary (reported, never gating)

- Counted findings per lens and per app; the counted-apart (axe/Lighthouse) findings; the judges' agreement on (a)–(d).
- The manual pass's defects that nunchi missed (a recall hint on real apps, not a recall measure).
- Upstream acknowledgement within 14 days (D10): of the counted findings filed, how many a maintainer acknowledged.
- Rule precision on these apps: in [prereg-precision.md](prereg-precision.md) §6.
- Sweep time and tokens per app.

## 7. Exclusions

- A group whose screen the judges cannot load from the evidence is left out and listed.
- An app the operator cannot sweep (capture fails on most routes) is replaced by the next eligible one; logged.

## 8. Who does what

| Role | Who | Does |
|---|---|---|
| Owner | the owner | D4, D9, D10; first judge; files upstream issues if D10 says so |
| Second judge | a person who did not build nunchi | judges apart from the owner |
| Manual-pass reviewer | a person who did not build nunchi and is neither judge | 15 minutes per app before any output |
| Operator | an agent session or a person | runs the search, the eligibility checks and the sweeps |

## 9. Amendments

The common policy holds. The search is run once; running it again (to get other apps) is an amendment, reported with
both result lists.
