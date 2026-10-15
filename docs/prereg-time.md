# Pre-registration: time (stub)

Status: **waiting for M5** (2026-10-15 KST). Not drafted: the quick run (`capture --quick`) and HAR merge that T1 and
T2 time do not exist yet (design 0.1-c §6, §12 M5). This file is written in full, with its hash block, once M5 merges.
Common rules: [prereg-README.md](prereg-README.md).

What it will hold (design §9.5, spec §8 "Time: 25 routes: first run ≤ 15 min, incremental ≤ 3 min"):
- T1 invocation → quick-run findings on the board; T2 deep capture plus rule lenses; T3 AI hunt at the default budget
  plus verification, folded into the ledger. The ≤ 15 min target applies to T3, or the claim says "rule-lens first
  run".
- A reference machine and a lower-spec machine; a pre-chosen app with ≥ 25 routes; 3 cold runs each; median and
  maximum; setup and the app's build reported apart; AI tokens and latency reported.

What the owner will need to supply then ([prereg-README.md](prereg-README.md), "Later"):
- the two machines (their specification is part of the registration);
- an app with ≥ 25 routes that nunchi was not tuned on. Pebble has 13 routes and pegroom 15, so neither qualifies; a
  field app or a new invented app does.
