# nunchi 0.1 spec

Status: approved plan (2026-10-13 KST), being built in three steps: 0.1-a → 0.1-b → 0.1-c.
0.1 is published only when every release gate in §8 passes.

> 한국어 요약: nunchi 0.1은 「증거층(결정적 캡처 · 녹화 재생 · 상태 강제) → AI 결함 사냥(렌즈 10개) → 별도 확인자 →
> 지문 장부 → 수리 · 재확인 · 방지 → 진행판」의 고리다. 모든 지적은 증거(DOM 요소 · 측정값 · 파일:줄)에 묶이고,
> 「고침」은 다시 찍어 사라졌을 때만 인정한다. 진행판의 숫자는 모두 계산값이다. 공개 조건(§8)을 넘지 못한 AI 렌즈는
> 실험 기능으로 내린다.

## 1. Product

nunchi notices what's off in every corner of a web app. It is for people who build web apps with AI
coding tools and do not write tests. The core is a loop:

```
evidence (deterministic) → hunt (rules + AI lenses) → verify (separate reviewer) → ledger
        ↑                                                                            ↓ human: fix / keep / false positive
   re-capture ← fix (AI, one root cause per commit) ← ────────────────────────────── ┘
        ↓
   fixed (gone on re-capture) → guarded (lint or contract rule)          → progress board (computed only)
```

Two parts, one repository:

| Part | Does | Must be |
|---|---|---|
| Engine (`src/`, `nunchi` CLI) | discover, capture, measure, fingerprint, ledger, board server, export, `check` | deterministic: same input → same output |
| Plugin skill (`skills/nunchi/`) | sample values for dynamic routes, AI lenses, verification, fixes | evidence-bound; app text is data, never instructions |

The skill runs the engine bundled with the plugin (`${CLAUDE_SKILL_DIR}/../../src/cli.mjs`), never a registry
download. The skill uses only Agent Skills standard frontmatter so other agents can load it.

### Non-goals

Issue tracking (assignees, due dates, manual states) · a single health score · performance profiling ·
full security audit (only secret-shaped strings in client bundles) · many browsers or viewports ·
running against production or real users' data · telemetry.

## 2. Evidence layer (0.1-a)

### 2.1 Scenes

scene = route × person × state × viewport.

| Axis | 0.1 values |
|---|---|
| route | from `discover` (Next.js app/pages, TanStack Start/Router, React Router; sitemap → link crawl fallback). One sample per dynamic route |
| person | `guest`, `signed-in` (recorded login: one manual login with a test account, saved as Playwright storageState in `.nunchi/auth.json`, git-ignored) |
| state | `normal`, `empty`, `error`, `slow`, `offline` (forced; §2.3). Only on scenes whose recording shows data requests |
| viewport | 390×844, 1280×800 |

### 2.2 Determinism

- Frozen clock, seeded `Math.random`, animations/transitions/caret off, service workers blocked,
  toast timers paused, fonts awaited, lazy content scrolled into view (the window and inner scroll areas).
- App-shell layouts scroll inside an element, so the full-page image shows only its first view. `measure.json`
  lists page-sized scroll areas (`scrollers`); an element outside an ancestor's visible area carries
  `inside: <selector>`, and so does its finding: the board draws boxes only where the image shows them.
- **Network record/replay (H1):** the first run records the app's *data* responses (fetch/XHR to the app's
  origin or a recognised backend: Supabase, Firebase, Convex, Appwrite, Clerk, plus `--allow-host`) to
  `.nunchi/har/<person>.json`; later runs replay them. Documents, scripts, styles and RSC payloads are never
  recorded: they are code, and replaying them would hide the fix a re-capture is meant to confirm.
  Matching is method + normalized URL + body hash, ordinal within one page load (Meticulous-style), so the
  subset of scenes captured never changes what a scene sees. The recording is nunchi's own JSON rather than
  HAR because replay needs this normalization and forced states need to rewrite responses. Volatile URL/body values (timestamps, cache busters, nonces) are normalized before
  recording. A replay miss is logged as *capture drift*, never as a UI defect, and offers a re-record.
  *Strict replay (2026-10-14 KST, design 0.1-c D11):* in replay (forced states and canary copies included) a request
  the recording cannot answer is aborted, never sent live, reads included: the page sees a failed request and the
  miss is counted. A write (not GET/HEAD/OPTIONS) that is not a data request (a beacon, a form post, a server action)
  is aborted and counted the same way. Recording still goes live: the app's server must be an allowed base URL
  (§2.4), and a backend the app calls from the browser is reached as the app would reach it.
  A recording is saved by writing a temporary file and renaming it, so a reader never sees half of one; one that does
  not parse is an error naming the way out (delete it or `--network record`), not a crash.
  Server-side requests (SSR/RSC) are not covered in 0.1: those cells show *not seen: server render*.
- Third-party requests (analytics, ads, payment widgets) are blocked and listed. The browser itself runs
  under a PAC policy: the app's host and local hosts go direct, font hosts go direct or through the user's
  proxy, everything else (including the browser's own update and telemetry traffic) goes to a closed port.
- Timing-dependent measurements are kept out of the deterministic evidence: layout shift is stored as the
  web.dev band (good ≤ 0.1, needs-improvement ≤ 0.25, poor) and the raw value goes to `volatile.json`.
  Layout shift is read before nunchi scrolls or injects styles.
- Cookies, auth headers and tokens are stripped from HAR and evidence before they are written. Credential
  query and fragment parameters (`token`, `access_token`, `apikey`, `code`, `X-Amz-Signature`, …) are replaced
  by `REDACTED` in every URL the evidence keeps (requests, links, image sources, final path, aria snapshot,
  console text); recording keys keep a short hash instead, so requests that differ only by token stay distinct.
- *Form fields (2026-10-14 KST, D7):* what an input, textarea or select holds (typed, or filled in by the app: a key
  on a settings page, a name) is never written. In `controls.json` a field has its `type`, its `label` (`<label>` or
  `aria-labelledby`) and, as its name, only `aria-label`/`title`; a submit/button/reset input keeps its value as its
  name (the app's own label). In `aria.yml` the field's node, name, state and placeholder stay and its value is cut
  (`- textbox "API key"`). Screenshots are not masked: they are what the image lenses judge.
- Gate: same build, two runs → byte-identical screenshots.

### 2.3 Forced states

Derived from the recording, so they work with any auth:

| State | How | Looks for |
|---|---|---|
| empty | array responses → `[]`, list fields emptied and count fields zeroed (two levels deep) | blank areas, no next-step guidance |
| error | data requests → 500 `{"message":"Internal Server Error"}` | raw error text, endless skeleton, error that looks empty (`error-looks-empty`), no retry |
| slow | hold responses, capture at 1.5 s | no loading indicator, layout shift, double-submit risk |
| offline | `context.setOffline(true)` after load | no offline message (`no-offline-notice`) |

### 2.4 Runs and the evidence pack

Every capture is a **run**: `.nunchi/runs/<id>/` (git-ignored), ids sequential (`0001`, `0002`, …). It is written
as `<id>.partial` and renamed when complete, so a reader never sees half a run and an interrupted capture leaves
the previous run intact; `.nunchi/runs/latest` names the newest complete run. `nunchi runs` lists them,
`nunchi gc --keep N` removes older ones (runs referenced by open reviews will be kept, 0.1-c). `--out <dir>` writes
in place without a run (tests, scripts).

`run.json` (metadata, not compared between runs): id, parent run, git commit, `dirty` and a `tree` hash of the
working tree (uncommitted and untracked edits included, `.nunchi/` excluded) — so *evidence is from the code you
have now* holds without the user committing — scope (routes, persons, viewports, states, `--changed-since`),
network mode per person, run health.

*Safety (2026-10-14 KST, design 0.1-c D9, D10, D12):*
- **Base URL.** `capture` refuses a base URL that is not loopback (`localhost`, `*.localhost`, 127/8, `::1`,
  `0.0.0.0`), a private address (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10) or `*.local`, unless
  its host is listed in `.nunchi/config.json` (`{"allowHosts": ["preview.example.dev"]}`, exact host names), a file
  the user writes. Judged on the URL as written, never by DNS; http and https only. The refusal (exit 2) says how to
  list a preview host; no run folder is made. A config file that does not parse is an error, not "nothing listed".
- **git** runs with the repository's own programs off: `--no-optional-locks`, `-c core.fsmonitor=false
  -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat`, every configured filter driver's commands emptied,
  `--no-ext-diff --no-textconv --ignore-submodules=dirty` on diffs, the caller's `GIT_*` variables dropped,
  `GIT_CONFIG_NOSYSTEM=1`, no prompt, a 60 s timeout (`workTree` and `--changed-since`). An edit inside a submodule
  is therefore not part of `tree`.
- **File modes.** Run folders, evidence and recordings (everything written through `writeStable`) are 0700
  (folders) and 0600 (files), set explicitly whatever the umask. Before it starts, `capture` makes `.nunchi/har/`,
  `runs/` and `state/` 0700 (so the ledger's first write lands in a private folder) and tightens `auth.json` and
  `evidence/` left by an older version. Windows has no POSIX modes and keeps its ACLs.

**Run health** — whole-run failures are reported once instead of as one finding per screen, judged from the
evidence only: *login-expired* (≥2 and ≥half of signed-in screens bounced to a sign-in page: every signed-in scene
becomes *not seen: login expired*, no findings), *app-unreachable* (≥half of scenes have no DOM, including
Chromium's own error page, which is never treated as a screen), *recording-stale* (≥half of replayed data screens
missed the recording). The CLI prints `RUN PROBLEM …` and exits 3 for the first two.

**Scene id** = route template (not the sample path) + person + state + viewport, e.g.
`app~tasks~[id].signed-in.error.m`. The route encoding is one-to-one and safe on every file system (`/` → `~`,
capitals → `^` + lower case, other unsafe characters → `%XX`, Windows device names escaped); `manifest.json` also
keeps the structured key (route, path, person, state, viewport), and readers use that, never the folder name.

Per scene:

| File | Content |
|---|---|
| `top.jpg`, `full.jpg` | first view and full page |
| `aria.yml` | Playwright `ariaSnapshot` |
| `text.txt` | visible text |
| `styles.json` | computed-style samples of visible elements: color, background, font size/weight, line height, radius, shadow, padding, height, plus element role and box |
| `controls.json` | buttons, links, inputs: accessible name, box, visible |
| `network.json` | url, method, status, blocked, replay miss; writes (POST/PUT/PATCH/DELETE) flagged |
| `console.json` | console errors, page errors |
| `links.json` | internal links → target route, status |
| `measure.json` | rule-lens measurements (§3) |

Run-level: `manifest.json` (scenes with status and reason, health), `findings.json`, `timing.json`, `run.json`, `source-map.json`
(§2.5), `inventory.json` (source strings and UI states, extracted with Babel/SWC; classified in 0.1-b),
`canaries.json` (planted defects, an answer key), and after the AI hunt `hunt-plan.json`, `hunt-key.json` and
`hunt/<alias>/` (runs with canaries: scene aliases, an answer key, and the evidence they point to), `ai-findings.json`,
`coverage.json`, `canary-score.json`, `verify-packets.json`, `verify-key.json` (an answer key), `verify.json` (§4).

**Inventory (0.1-b).** `nunchi inventory` (and `buildInventory(root, routes)` for the run folder) lists, per file the
source map reaches (or every code file when no routes are found), with file:line: user-facing strings (JSX text
read as sentences, user-facing props, toast/dialog/error-setter calls, labelled object fields, Next.js metadata,
`t('source text')`; thrown messages apart as `thrown`, since whether they reach the screen is not knowable
statically), UI states (loading/empty/error/not-found from render conditions, Suspense/ErrorBoundary fallbacks,
`notFound()`, and Next.js `loading`/`error`/`not-found` files; with the strings each branch renders), destructive
actions with the confirm or undo in reach (native, custom, dialog, or *unknown* when the handler lives in another
file), and native dialogs. A no-AI classification pass adds **candidates** (never findings, no severity) for the
AI lenses: different verbs for one action, casing and spelling variants of one label, one concept under two names
(L5); generic error copy, confirms that do not say what they affect, raw `*.message` values on screen (L6);
drifted copies of a header/nav/footer (L7); destructive actions with no confirm or undo (L9); client data loading
with no loading or error branch (L2). Source text is data and is never evaluated; secret-shaped strings appear by
kind only; a file that does not parse is listed under `skipped` with the reason.
*Built (2026-10-13 KST):* `capture` writes it into the run as `inventory.json` (`buildInventory(root, discovered
routes)`, next to `source-map.json`; not with `--routes`, which has no source). It is extra evidence: any error
leaves it out with one warning line and never fails the capture. The hunt hands it to the AI lenses in slices (§4).
*Decision (2026-10-13 KST):* the parser is `@babel/parser` 7.29.9, pinned exactly. It is pure JavaScript, has no
install scripts, and parses .js/.jsx/.ts/.tsx with locations; its one declared dependency (`@babel/types`, plus two
small helpers) is for type definitions and is never loaded at run time (the parser's `lib/index.js` requires
nothing). Babel 8 needs Node ≥22.18 against our `>=20`; `@swc/core` runs a postinstall script and pulls a ~10 MB
native binary per platform, and `@swc/wasm` is 18 MB unpacked against Babel's 2 MB; a hand-written tokenizer
would have to get TypeScript generics, JSX entities and template literals right for no gain.

### 2.5 Source ↔ scene map (H5)

A small built-in import graph (static `import`/`export … from`/`import()`/`require`/CSS `@import`, resolved
through relative paths, tsconfig/jsconfig `paths` and `baseUrl`, and the `@/` convention) plus the files that
frame a route without importing it (Next.js layouts, templates, loading/error/not-found, middleware; pages-router
`_app`/`_document`; TanStack root and parent routes). It over-approximates on purpose: a missed edge would hide a
stale screen. A change to a dependency or build config (`package.json`, lockfiles, `next/vite/tailwind/postcss`
config, `tsconfig*`) affects every route. `nunchi map` prints it; `capture --changed-since <ref>` captures only the
routes it says changed (uncommitted and untracked files included); `capture` writes `source-map.json` with the
evidence.

*Decision (2026-10-13 KST):* dependency-cruiser was adopted in the precedent survey but is **not** used. It brings
18 direct dependencies (including an interactive prompt library and a webpack plugin) for one feature, against the
"pinned, minimal dependencies" rule (H15); the needed graph is ~200 lines. Next.js `.nft.json` traces need a
production build and are left for a later version. Used to (a) mark coverage
cells *stale* when files they depend on change, (b) pick scenes to re-capture incrementally, (c) pick
neighbour scenes for regression checks after a fix. The board header shows *evidence tree ≠ working tree* (§2.4 `run.json`).

## 3. Lenses

A lens is a data file (H8): id, definition of a defect, checklist items, good/bad examples, severity rubric,
method. Packs: built-in, external (pinned by sha256), project (`.nunchi/lenses/`, last word). Packs cannot execute code.
Later packs override earlier ones (ESLint-style `extends`).

| Lens | Defect | Method | Step |
|---|---|---|---|
| L1 broken | horizontal overflow, clipped text without ellipsis, overlap, broken image, font not loaded, layout shift (CLS), page error, 4xx/5xx | rule + AI (image) | a / b |
| L2 states | in a forced state the user cannot tell what happened or what to do | rule + AI | a / b |
| L3 flow | links to missing routes, orphan routes, dead-end screens, redirect loops, signed-in user bounced to login | computed (link graph; linkinator-style) — §3.1 | a |
| L4 visual consistency | values outside the app's measured design system (colors, type sizes, radii, shadows, button shapes, heading scale) | computed (§3.2) + AI grouping | a / b |
| L5 copy consistency | same situation different words, same concept different names, mixed tone, different verbs for the same action | AI | b |
| L6 copy quality | errors that don't say what happened and what to do, confirms that don't say what is deleted, `undefined`/`NaN`/`[object Object]`, raw errors | rule + AI | a / b |
| L7 vibe-coding leftovers | Lorem ipsum, John Doe, example.com, TODO on screen, "Coming soon" sprawl, `href="#"`, empty `onClick`, hard-coded fake numbers, debug UI, drifted copies of nav/footer | rule + AI | a / b |
| L8 accessibility | axe (contrast, names, alt, labels, duplicate ids), target size (WCAG 2.5.8: < 24px medium, < 44px low; links inline in text exempt), no focus style | rule | a |
| L9 safety | destructive action without confirm/undo, `window.confirm`, input lost on leave, secret-shaped strings in client JS (location and kind only: not one character of the value, 2026-10-14 KST) | rule + AI | a / b |
| L10 parity | control on desktop missing on phone, fixed element covering content, primary action missing from phone first view | computed (§3.2) + AI | a / b |

Severity: **blocker** (core task impossible, data loss, secret exposed) · **high** (broken, wrong or raw error
where many users pass) · **medium** (inconsistency, missing state guidance, AA violation) · **low** (polish;
collapsed by default). Reach raises one level: same cause in ≥10 places, or on a core path (first view,
sign-up, checkout).


### 3.1 L3 flow (computed)

Built from the evidence and the source, no AI; written to `flow.json` in the run:
- **Nodes** = route templates (from discover, so every route of the app; from `--routes`, only those), each with
  how it is reached: `entry`, `link`, `code`, `redirect` or nothing.
- **Edges** = internal `<a href>` links seen on captured normal screens (persons, viewports, up to three
  scene + selector examples) and literal navigations in the files a route renders (`router.push/replace`,
  `redirect`, `navigate`, `location.assign`, `href=`, `to=`, `href:`; template literals keep their static
  part; file:line). An edge is **shared navigation** (`global`) when its link sits in nav/header/footer and
  reaches the same target from ≥80% of a person's screens in that section — the board hides those by default.
- **Order and groups** (the wall's order, R7): breadth-first from `/` over link edges in the order a visitor meets
  them (guest before signed-in, desktop before phone), unreached routes after, by path. One order per run,
  whatever the viewport. Groups = first path segment shared by ≥2 routes (`/app/*`); single pages go to `/`.

| Rule | Severity | When |
|---|---|---|
| `link-to-missing-route` | high | an internal link matches no route of the app (assets and `/api/` links are not judged; only when routes come from discover) |
| `redirect-loop` | high | the browser gave up after too many redirects |
| `signed-in-bounced` | high | a signed-in person was sent to a sign-in page (an expired login is a run problem instead, §2.4) |
| `unreachable-route` | low | no captured link, no navigation in the source and no redirect leads here (only when the whole app was captured, not `--changed-since`). Low because a button that navigates in code nunchi cannot read would make it wrong |
| `dead-end` | low | no visible link to another screen on any viewport and no navigation in its source; error pages excluded |


### 3.2 L4 measured design system and L10 parity (computed)

**L4.** The app's design system is what its screens actually use. `design-system.json` (per run, per viewport)
lists colours, backgrounds, type sizes, weights, families, radii, shadows, button shapes (height · radius · weight
of filled or outlined buttons and button-styled links; icon-only plain buttons and controls under 24px are left
to L8) and the h1–h3 scale, each with the screens that use it and up to three examples, plus a `size` summary
(how many distinct values: the progress board's "is it converging" number). Framework error pages are left out.
One-offs are judged per person and viewport over routes (a public page seen by both persons is one route):

| Rule | Severity | When |
|---|---|---|
| `one-off-button-shape` | low | a button shape only one route uses, while ≥3 routes share the most common one (≥4 routes have buttons) |
| `one-off-heading-size` / `one-off-heading-color` | low | an h1/h2/h3 size or colour only one route uses, under the same rule, and that route does not also use the usual value (a second heading style on one page is a variant) |

AI grouping (0.1-b) adds what values cannot: two shapes that are the same component, near-duplicate colours.

**L10.** For each route and person captured at both widths: a named control visible on desktop that the phone
neither shows nor keeps in a menu (nav, dialog, details, `role=menu|dialog|navigation`, popover, or a region a
visible `aria-controls` toggle opens) is `missing-on-phone` (medium; evidence says `hidden` or `absent`).
`measure.json` keeps the page's hidden named controls (`hiddenControls`) for this. Fixed elements covering
content and the phone's first view are AI-lens checks (0.1-b).


### 3.3 Lens packs (built 2026-10-13 KST, 0.1-b)

`src/lenses.mjs` loads `lenses/*.json` (built-in) → the files listed in `.nunchi/lenses.lock.json`
(`{"packs": [{"path", "sha256"}]}`, paths inside the project; a hash mismatch refuses the whole load; nothing is
downloaded) → `.nunchi/lenses/*.json` (project). Files are read in name order; a file holds one lens or `{"lenses": [...]}`. A
later lens with the same id replaces the earlier one; one with `extends` (its own id — ids are L1…L10) merges into
it: scalars replaced, `scenes`/`severityRubric` merged by key, examples appended, checklist items replaced by id,
appended, or removed with `{"id", "off": true}`. The project's own packs load last (decided 2026-10-13 KST): a pack the
project adopted never overrides what the project itself wrote.

Schema (strict: unknown keys are refused, keys that look executable — `on…`, `script`, `exec`, `run`, … — are named
as such, only plain JSON values, length limits): `id`, `name`, `definition`, `checklist` (`{id: "L6.kebab-name",
question, scenes?}`), `examples` (`good`/`bad` text), `severityRubric` (blocker/high/medium/low → text), `method`
(`ai`/`rule`/`computed`), `scenes` (`{states?, viewports?, persons?}`; `{}` = all), and `evidence` — the per-scene files
the hunter reads (added to the list above because L1 needs images and L5 does not), plus an optional `source`
(boolean: the unit also gets its route's source inventory slice, §4; added 2026-10-13 KST). Only `method: "ai"`
lenses are hunted.

Built-in packs cover the AI parts: L1 (visual: overlap, unreadable text, collapsed layout, distorted media,
unstyled), L2 (forced states only: what happened, next step, failure that looks normal, endless loading, no loading
indicator when slow), L4 (same component with two looks, near-duplicate colours and sizes), L5, L6, L7 (template
copy, demo data, debug UI, nav/footer drifted from the reference screen's), L9 (destructive action without
confirm/undo, input lost on leave) and L10 (fixed element covering content, primary action not in the phone's first
view). Each names the rule findings it must not repeat. Their recall is unmeasured until the AI-lens gate runs (§8).

## 4. Hunting and verification (0.1-b)

- **Work unit (H4):** 1–3 scenes × 1 lens. Input = lens definition + checklist + the scenes' evidence +
  one reference scene from the same app. The scene under review goes first or last in the prompt.
  The hunter answers every checklist item: *defect (with evidence)* / *none* / *cannot judge*. A cell is
  *seen* only when every item has an answer.
- **Grounding:** every finding names a DOM element (selector + box) or file:line. Image-only claims are rejected.
- **Canaries (H2):** each run injects known defects into copies of a few scenes (kinds and difficulty taken
  from real defects). A missed canary voids *seen* for that batch and re-runs it. Canary hit rate is shown as
  an upper bound of recall.
- **Verifier:** gets the claim and its evidence only (not the hunter's reasoning), may re-capture the scene,
  returns confirmed / rejected / insufficient + corrected severity + one-line reason. Rule-lens findings skip it.
  Pages with a history of false positives get a stricter threshold.
- **Decoys (H3):** false claims mixed into the verifier's input. Decoy pass-through > 10% → that run's
  verifications are marked *suspect*.
- **Who verifies (H7):** a different vendor's model only after the user opts in once; otherwise the same
  model in a fresh context, labelled *same-model check*. 0.1 never auto-approves.

*Built (engine side, 0.1-b, 2026-10-13 KST):*
- `src/canary.mjs`: eight mutation kinds, each an in-page function applied after load and before anything is
  measured (a delimited hook in `captureOne`): `verb-swap` and `term-swap` (L5), `vague-error` and
  `vague-confirm` (L6), `template-copy` (L7: a paragraph replaced by scaffold copy), `blank-state` (L2),
  `remove-confirm` (L9: a destructive control loses its `aria-haspopup`/`aria-controls`/ellipsis cue), `fixed-cover`
  (L10). Each names the checklist item of the built-in packs it should be found under (a contract test keeps the
  ids in step), and none is something a rule lens reports: the lenses tell the hunter not to repeat rule findings,
  so such a canary could only be missed (the first `stray-todo`, a visible TODO, was replaced for that reason on
  2026-10-13 KST). Each returns selector (built like
  `collect()`'s), box and before/after text, or nothing when the page has no suitable element. Which scenes and
  kinds: seeded from the run scope (routes, persons, viewports, states), one scene per route first, kinds not
  yet planted first, and only kinds whose lens and checklist item look at that scene in the loaded packs (L2 on
  forced states, L7/L9/L10 on normal screens; a project pack that turns an item off turns its canary off); the
  first kind that fits the page is planted; a copy where none fits is dropped (at most
  3 × n tries). `capture --canaries <n>` (CLI default 3, API default 0). Copies are captured after every
  rule and computed finding, appear in `manifest.json` as `canary: k, of: <scene>` with id `<scene>.canary-<k>`,
  and in `canaries.json` (kind, lens, expected checklist id, selector, box); their rule findings are dropped,
  and flow, design system, parity and run health never see them.
- `nunchi canaries --score`: a canary is hit when `ai-findings.json` has a claim of its lens on the copy at
  the same element, an ancestor/descendant or a box overlapping ≥ half of the smaller one. Writes
  `canary-score.json` (per lens, labelled an upper bound of recall). A missed canary voids *seen* for its batch in
  `coverage.json` (every cell of that lens on that route, the screens the copy came from included → `not-seen`,
  reason `canary-missed`, summary counted again, plus a `canaries` block); without coverage.json it is printed.
  Re-hunting is the skill's job: a later answers file replaces a unit's earlier answer. A canary whose cell the
  hunt never saw (cut by the budget, not answered) is *not hunted*: listed apart, neither planted nor missed, and
  voids nothing — nobody looked, so it measures nothing.
- `src/verify.mjs`, `nunchi verify --plan`: one packet per AI claim (`source: 'ai'`, `status: 'claimed'`, not on a
  canary copy): lens, rule, severity, scene, route, viewport, selector, box, evidence minus reasoning-like
  keys, and the scene's evidence files. Decoys = ⌈n/4⌉ (20% of packets): false claims on visible, unclaimed
  controls of the claimed scenes, from `controls.json` (a clear label claimed unclear `L6.unclear-label`,
  ordinary copy claimed as scaffold `L7.template-copy`, a non-destructive control claimed destructive without
  confirm `L9.destructive-without-confirm`, two identically named controls claimed as different verbs
  `L5.same-action-different-verb`), the claim's own lens first. A decoy has the evidence shape `hunt --record`
  gives a real claim (`claim`, `groundedIn: ["controls.json"]`), and the hunt unit id is left out of every
  packet, so a decoy cannot be told apart by its form. Order is a seeded shuffle; the key
  (`verify-key.json`: decoy or finding index + claim hash) is a separate file.
- `nunchi verify --record <verdicts.json> [--vendor <name>]`: verdict, corrected severity, one-line reason per
  packet → `status` and `verification` on each finding in `ai-findings.json` (confirmed takes the corrected
  severity); `verify.json` has counts, decoy pass-through (confirmed decoys ÷ answered decoys) and `suspect`
  when it is above 10% or no decoy was answered (then every verification of the run carries `suspect: true`).
  The verifier is recorded as *same-model check* unless `--vendor` names another vendor; nothing is sent
  anywhere. A plan refuses verdicts once the claims it was built from changed.
- Not done yet: decoys come only from controls (no L2/L10 decoys); "stricter threshold for pages with a history of
  false positives" is not built; the verifier's re-capture is the skill's job.

- **Trust:** per-lens precision = fix ÷ (fix + false positive) over the last 20 human decisions; below 70%
  the lens's new findings go to *suspect*. Resolution rate (confirmed findings that reached *fixed*) beside it.
- **Budget (H14):** per-run token cap (default 400,000, §4 *Default budget*); estimate shown before a deep sweep;
  hitting the cap leaves cells *not seen: budget*, never silently skipped.

**Built (2026-10-13 KST): `nunchi hunt --plan` and `--record`** (`src/hunt.mjs`).
- *Plan* (`hunt --plan [--run] [--lens] [--budget] [--json]`, writes `hunt-plan.json` into the run): per AI lens,
  scenes matching its `scenes` filter are grouped by route + person + state across viewports (≤3 per unit). Each unit
  gets one reference scene: another route, same person and viewport, same state if one exists else normal, picked
  by a hash of the group (deterministic, spread over the app). Files are listed reference first, the scenes under
  review last (only the lens's `evidence` files; the reference gets `top.jpg` instead of `full.jpg`). Checklist items
  with their own `scenes` filter list the scenes they apply to. Scenes not captured, not seen or redirected are
  listed as not seen with that reason. Unit id = hash of lens content, scenes, reference and items. Each unit has a
  `batch`: its lens on its route (hash), the scope a missed canary voids.
- *Canaries in the plan:* a canary copy is grouped on its own (never in a unit with the scene it copies) and is
  never a reference. In a run with canaries, every scene of the plan goes by an alias (`s` + 10 hex, salted with
  the canary seed) and `files` point at `hunt/<alias>/…`, the scene's evidence files hard-linked (copied where links
  fail) there; the alias → scene map is `hunt-key.json`, an answer key the hunter never reads. `--record` maps the
  answers back, so `ai-findings.json` and `coverage.json` name scenes. Runs without canaries keep scene ids and get
  no key or mirror.
- *Source slices (2026-10-13 KST):* a lens pack with `"source": true` (built-in: L2, L5, L6, L7, L9) gets, when the
  run has `inventory.json`, the slice of its route: `hunt/source/<first 12 hex of sha256(route)>.json` =
  `{schema, route, note, files: [{file, strings, states, actions, dialogs}] (the inventory files whose routes include
  it), candidates (every candidate touching those files)}`, written on first use. It is listed after the reference
  scene's files and before the scenes under review, and counted in the estimate. A route no inventory file renders,
  or a run without `inventory.json`, gets no slice. Candidates are hints; a defect the code causes is grounded with
  `source: file:line`.
- *Estimate:* text files bytes/4; JPEGs width × height / 750 after scaling to ≤1568 px long edge and ≤1.15 MP (max
  1,600; read from the JPEG header); per unit, the lens text (bytes/4) + 80 tokens per checklist item per scene for
  the answer. An estimate, not a measurement. Units are spent in a fixed order — lens by lens, worst defects first
  (L1 broken, L9 data loss, L6 copy that fails the user, L2 states, L10 phone, L7 leftovers, L5 and L4 consistency),
  and within a lens normal screens first, then error, empty, slow, offline; by route; guest first — and from the
  first unit that does not fit, every later unit is *not seen: budget*.
- *Default budget (decided 2026-10-13 KST):* 400,000 tokens when `--budget` is not given; `--budget all` lifts it.
  Measured on the benchmark app (100 scenes + 3 canaries, 217 units, 1.25M tokens for everything): spent screen by
  screen, as first built, the default saw every lens on 7 of 13 routes and nothing of the other 6; spent lens by
  lens it sees L1, L9 and L6 on all 13 routes. A Claude subscription's weekly use is not published in tokens, and
  a sweep is fresh input (screenshots, no cache), so the default leaves room for re-hunts and the verifier in the
  same week. The plan says when the default applied (`budgetDefault: true`).
- *Record* (`hunt --record <answers.json|dir> [--root]`, writes `ai-findings.json` and `coverage.json`; a folder is
  read in name order, and a unit answered again in a later file takes the later answer — a re-hunt — while a unit
  answered twice in one file is refused and left unanswered): every item
  must be answered `defect`/`none`/`cannot-judge`; a defect needs a scene under review, a claim, a severity and a
  ground — a selector found verbatim in that scene's controls/styles/links/measure JSON or an `aria=<node>` line of
  aria.yml, and/or a `file:line` that exists under the app root (not `.nunchi/`, `node_modules/`, `.git/`; symlinks
  must stay inside). Anything else is listed in `rejected` with a reason; an item whose only defects were rejected
  counts as unanswered, so the unit stays *not seen: incomplete*. Findings use the rule-finding shape plus
  `source: "ai"`, `status: "claimed"`; box comes from controls.json or measure.json when the selector has one.
  Answers naming another plan id are refused. Answers are parsed and compared as strings only.

## 5. Ledger (0.1-b)

Revised after the board review (N1, N2, N7, N8) and the first field test (1,082 findings on 34 screens are
unreadable one by one). Built in `src/ledger.mjs`:

- **Fingerprint** (`fp`, v1) = lens + rule + route template + the element (selector without `:nth-*`, React/Radix
  ids, CSS-module/emotion/styled-components hashes, digits) + evidence with measurement values removed (sizes,
  notes, the page's data in quoted text; numbers bucketed to powers of two). Person, viewport and state are not
  part of it: the same defect on the phone and the desktop, in normal and error state, is one. Every finding in a
  run's `findings.json` carries its `fp`.
- **Fingerprint v2** (2026-10-14 KST, design 0.1-c §4.5): a version changes the recipe of named rules only, and
  `inputs.v` says which recipe made a fingerprint. v2 changes `secret-in-client-bundle` alone: a build names a bundle
  after its content, so the bundle path's hash-like parts become `[hash]` (Vite/Rollup's `-<8 characters>` suffix;
  any run of 6+ letters and digits that is lower-case hex or holds a digit: webpack, Parcel, CRA, Turbopack's
  `1grrdrpshlkcw.js`, esbuild), and a rebuild keeps the secret's fingerprint. Every other rule's fingerprint is the
  v1 one (a contract test pins v1 values). The evidence of a secret is `{url, kind}`: v1's `masked` (four characters
  of the value) is gone. **Migration:** a v1 `ledger.json` is migrated on read: secret items get their v2 fingerprint
  and group from what they stored (rule, route, selector, evidence), items that now share one merge (first seen is the
  earliest), `masked` is dropped, and `aliases` (old → new) is kept in the state. A decision made under v1 follows its
  item: through `aliases`, or, for one from another machine, by the v1 fingerprint of what the state holds now. The
  decision file is never rewritten; the view moves its target and keeps its id (`targetWas`).
- **Group** = the fingerprint without the route: a shared component's defect on 17 screens is one group, the
  unit a person decides on and the fix loop fixes. Low contrast groups by its colour pair (the design token),
  not by element. Root-cause groups by source file + symbol come with the inventory (§2.4).
- **Decisions** are append-only files, `.nunchi/decisions/<group-…|fp-…>/<id>.json` (committed; two people
  never edit the same file): `fix`, `keep` (reason `intended` | `out-of-scope`), `false-positive` (reason
  `not-a-problem` | `wrong-place`), `hold`, `reopen`; who and when (KST). The latest decision on the fingerprint
  or its group wins; a group decision covers screens found later.
- **Provenance (N1):** decisions made with `nunchi decide` on this machine are recorded in
  `.nunchi/state/approved.json` (git-ignored). Anything else came through git: it is shown, but it cannot dismiss
  a blocker or an L9 (safety/secret) finding, and the fix loop will not act on an unapproved `fix` until
  `nunchi approve`.
- **Status is computed, never committed:** each complete run is folded into `.nunchi/state/ledger.json`:
  `open` → `fixed` when a run that looked again (the route in scope, the same persons, the app reachable, the
  login working) no longer finds it → `regressed` when it comes back. With decisions: `to-fix`, `kept`,
  `dismissed`, `held`. `fingerprintVersion` and each fingerprint's inputs are stored so a new version migrates
  decisions instead of orphaning them (v2, above).
- **CLI:** `nunchi findings` (one row per kind; `--rule <rule>` lists its groups; `--status`, `--all`, `--json`),
  `nunchi decide <id…> <decision> [--reason] [--note]`, `nunchi approve <id…>|--all`, `nunchi trust`.

Field app 1 (§9.2) after this: 1,082 findings → 578 unique defects → 99 groups → 9 kinds on one screen of text.

## 6. Fix loop (0.1-c)

1. Fix by root cause, in the shared function or component.
2. Refuse to start on a dirty working tree.
3. One root cause = one commit. Before committing: the user's build, typecheck, lint and tests pass.
4. Re-capture the scenes and their neighbours (source map) with replay. Gone = fixed. New finding nearby =
   *caused regression*, fix reverted to *fix*. Visual change outside the finding's box → human.
5. The agent saying "fixed" changes nothing; only re-capture does.
6. Guard: on a second occurrence of a kind, or ≥5 instances, propose a rule (e.g. no `*.message` in JSX or
   toast arguments, no `window.confirm`, no `href="#"`, `stylelint-declaration-strict-value` for tokens,
   `toMatchAriaSnapshot` for structure). Added to the user's repo only with consent.

## 7. Progress board and exports (0.1-c)

Local server (`nunchi open`) that watches the ledger and redraws live. Views: progress · findings board ·
finding detail · coverage map · design system · screen wall · states & messages · copy groups.
Keyboard: J/K move, F fix, W keep, X false positive, S hold; batch decisions by root cause, kind or lens (H13).

| Metric | Computed from | Helps decide |
|---|---|---|
| open findings by severity | ledger | what to fix first |
| new / fixed / regressed vs previous run | ledger + runs | is it improving, is fixing breaking things |
| trend (blocker + high) per run | `.nunchi/runs/` | ready to ship? |
| coverage | seen cells ÷ all cells, not-seen by reason, stale cells | where are the blind spots |
| design-system size | distinct colors / type sizes / radii / button shapes, first run → now | is it converging |
| AI trust | lens precision, resolution rate, canary hit rate, decoy pass rate | how far to trust the AI |
| guarded kinds | ledger | can this mistake come back |
| what the AI is doing now | ledger `fixing` + re-capture queue | wait or look elsewhere |

Exports: SARIF, Markdown, JSON. `nunchi check`: no capture; runs guard rules and ledger state for CI,
exit code only. First run (H11): key routes × rule lenses within ~2 minutes; the deep sweep continues and
fills the board live.

## 8. Release gates (0.1)

| Gate | Target |
|---|---|
| Recall, rule lenses | 100% of seeded defects in the benchmark app (40 seeded, 3–5 per lens) |
| Recall, AI lenses | ≥75% per lens, mean of 3 runs. A lens below this ships as *experimental*, off by default |
| Precision after verification | ≥85% on a 50-finding human-labelled sample |
| False positives on clean scenes | ≤0.1 confirmed false positives per defect-free scene |
| Determinism | same build, 2 runs → byte-identical screenshots |
| Fingerprint stability | ≥95% identical fingerprints across runs with no code change (bench: 2 runs, 100%, 54/54) |
| Fix loop | ≥90% of seeded defects marked *fix* are gone on re-capture, 0 caused regressions |
| Time | 25 routes: first run ≤15 min, incremental ≤3 min |
| Decision time | median ≤10 s per human decision |
| Compatibility | same benchmark results from Claude Code and Codex CLI |
| Field test | 3 public vibe-coded apps: ≥5 findings per app that a human judges "didn't know, worth fixing" |
| Held-out benchmark | a second benchmark app, never opened during development, used only for the gates |
| Stop / pivot (H16) | after two fix-and-rerun rounds, if post-verification precision < 70% or field findings < 3 per app: AI lenses go experimental and 0.1 ships rule/computed lenses only |

The benchmark app is synthetic (a small to-do/notes app, Next.js + fake auth). Answer keys are stored where the
hunting model cannot read them.

## 9. Build order

| Step | Contents | Done when |
|---|---|---|
| 0.1-a | computed lenses L3 flow ✔ L4 measured design system ✔ L10 parity ✔ · runs + run health + scene ids + URL redaction + scroll-area boxes ✔ · plugin skeleton ✔ · discover ✔ · capture + evidence pack ✔ · rule lenses (L1, L6, L7, L8, L9 rule parts) ✔ · browser network policy ✔ · recorded login ✔ · record/replay ✔ · forced states ✔ · evidence pack ✔ · rule and computed lenses (L1 L3 L4 L6 L7 L8 L9 L10 rule parts) · source map ✔ · benchmark app ✔ · tool security (no telemetry, no install scripts, pinned deps, npm trusted publishing, stripped secrets) | rule-lens recall 100%, 2-run byte identity, timings measured, token budget defaults set |
| 0.1-b | inventory extractor · AI lenses · verifier · canaries · decoys · ledger ✔ · fingerprints ✔ · trust metrics ✔ · lens packs · budget | AI-lens recall, precision, fingerprint stability gates |
| 0.1-c | fix loop · guards · board (mock-ups agreed) · exports · `check` · fast first run · batch decisions | fix-loop gate, field test, all gates |

Later: 0.2 baseline comparison (Argos-style flake handling), fake sessions + synthetic data (Supabase first),
server-side request mocks, interaction scenes, dead-click probe, focus order, light/dark axis, URL-only mode.
0.3 auto-approval (cross-vendor verifier + weekly sample + reversal rate), intent comparison (mock-ups, PRD,
planned screens), scheduled runs, artifact sharing, optional CI workflow example.

### 9.1 Benchmark results (0.1-a gates)

`npm run bench` on 2026-10-13 KST (last: 12:59 KST, rule and computed lenses), capturing twice (100 scenes, ~136 s per capture):

| Gate | Target | Result |
|---|---|---|
| Rule- and computed-lens recall | 100% of seeded defects those lenses own | 34/34 (L1 7/7, L2 3/3, L3 2/2, L4 3/3, L6 3/3, L7 6/6, L8 6/6, L9 3/3, L10 1/1) |
| False positives on clean scenes | ≤ 0.1 per scene | 0 on 8 scenes |
| Determinism | 2 captures byte-identical | identical (1,005 files, `flow.json` and `design-system.json` included) |

Caveats, kept honest:
- One rule (`placeholder-as-label`) and three noise fixes (prefetch 404s, 44px guidance for text links, redirected
  scenes) were made after the first benchmark run showed them. The fixes are general, but this is exactly how a
  benchmark gets overfitted: the held-out second benchmark (§8) is what keeps the gate honest.
- The computed lenses were tuned once against the benchmark (2026-10-13 KST): L4 first counted a guest's
  sign-in prompt as the same screen as the signed-in page, which hid two seeded one-offs, and counted Next.js's
  own 500 page as the app's style. Both fixes are general rules (§3.2), but they were found here — the held-out
  benchmark has to confirm them.
- P41 (`/reports` unreachable) was not seeded: L3 found it and the source confirms it; it is in the answer key
  with that note.
- 7 seeded defects are not scored yet: L5 ×2, L6 ×2, L7, L9, L2 slow (AI lenses, 0.1-b).
- "Findings not in the answer key" are mostly the same defect seen from another person, viewport or state (the
  ledger in 0.1-b collapses them) plus real extra defects the app happens to have (tasks overflow on phone,
  client-rendered lists shifting layout, a TypeError in the task page's error state).

### 9.2 Field test 1 (2026-10-13 KST, preview, rule and computed lenses only)

Three public, MIT-licensed apps made with AI builders, built and served locally, captured with the CLI as a user
would (samples for dynamic routes taken from each app's own data). Nothing from them is committed here.

| App | Made with | Routes / scenes | Findings before → after the fixes below | Unique after (route + rule + element) |
|---|---|---|---|---|
| [d33pm3/Multi-agent-Full-Stack-App](https://github.com/d33pm3/Multi-agent-Full-Stack-App) | Lovable (Vite + React Router) | 17 / 34 | 2,379 → 1,082 | 961, of which 281 phone touch guidance (low) |
| [rangeva/online-dev-tools](https://github.com/rangeva/online-dev-tools) | Lovable (Vite + React Router) | 3 / 6 | 56 → 12 | 12 |
| [jalcantarab/v0-vibecodex](https://github.com/jalcantarab/v0-vibecodex) | v0 (Next.js 14) | 26 / 52 | 233 → 133 | 83 |

**False positives the field test exposed, all fixed with a test each:** a phone sidebar that is only rendered
when its menu button is pressed read as `missing-on-phone` (262 + 36 + 51); screen-reader-only text read as
`clipped-text` (34); no WCAG 2.5.8 spacing exception, so every small but well-spaced link was `target-size-min`
(861 → 56); 44px touch guidance applied on desktop; a tool *named* "Lorem Ipsum Generator" read as placeholder
text; next/font's local Arial fallback face read as `font-not-loaded` on machines without Arial (52); a guide that
mentions "a TypeError when …" or quotes an error read as `raw-error-text` / `missing-value`; clickable cards and
size variants (sm/lg) read as one-off button shapes; hidden elements' names compared with different spacing.
Benchmark P25 (an 18px toggle with 12px clear around it) was re-judged: it passes 2.5.8 by spacing and is now
phone touch guidance — recorded in the answer key.

**After the fixes**, judged by Claude per unique finding (the gate needs a human; the owner's judgement is pending):
- Wrong: the L4 one-offs (4 of 4 on these apps were intended variants: a landing-page heading, filter chips, card
  buttons), now severity *low*; one quoted error in a guide (`missing-value`).
- To check: two React hydration errors (#422/#425) on one page — nunchi freezes the clock, which can itself cause a
  server/client date mismatch.
- The rest hold by the rule's definition. Candidates for "didn't know, worth fixing": a link to `/document-vault`
  where the route is `/doc-vault`; chat history and quick actions unreachable on the phone (`hidden lg:flex`, no
  alternative); 92 icon buttons without a name; 2.98:1 sidebar text; images missing from `public/`; a link to a
  guide that does not exist; the app's own link to a docs page that answers 404; "Coming soon" links to `#`; links
  nested inside buttons (the visible button is 40px, the part that navigates is 20px); phone pages wider than the
  screen. The small app (3 routes) has 3 kinds of real finding, short of the ≥5 the gate asks for.
- Volume is the real problem for a user: 1,082 findings on 34 screens is unreadable without the ledger's grouping
  by root cause (0.1-b) — accessibility (contrast, names) dominates and repeats per screen.

### 9.3 AI-lens gate, first measurement (2026-10-13 KST)

`bench/ai-gate.mjs` on the benchmark capture (100 scenes + 3 canary copies, `inventory.json` included). Each run hunts
the same 67 of 217 units: the 23 that cover the answer key's AI seeds, the units on the clean screens (`/about`,
`/help`) and the 17 on canary copies. Six hunters per run, each a fresh subagent with one packet (units and lens
text only, nothing about why a unit was picked; canary copies in a packet of their own). Fresh context per packet,
not per unit. About 0.7M subagent tokens per run.

| Lens | AI seeds | Found (run 1 / 2 / 3) | Mean recall | Gate ≥75% |
|---|---|---|---|---|
| L2 | 1 (no loading indicator, slow) | 1 / 1 / 1 | 100% | pass on this seed |
| L5 | 2 (Sign in/Log in/Login; Save/Submit) | 2 / 2 / 2 | 100% | pass on these seeds |
| L6 | 2 (vague error; native "Are you sure?") | 2 / 2 / 2 | 100% | pass on these seeds |
| L7 | 1 (drifted header copy) | 1 / 1 / 1 | 100% | pass on this seed |
| L9 | 1 (Clear all, no confirm or undo) | 1 / 1 / 1 | 100% | pass on this seed |
| L1, L4, L10 | 0 | — | unmeasured | — |

Every hit was read: each is the seeded defect, grounded in a selector or file:line (the native confirm only through
the source slice). 117/117 cells seen per run, 0 answers rejected.

*Canaries.* `template-copy` (L7) hit 3/3. `fixed-cover` (L10) was an invalid canary: the bar sat under the last
footer link and covered nothing, and two of three hunters rightly answered none (the mutator now requires an
element's middle inside the band). `blank-state` (L2) was *ambiguous*: the original screen already failed the same
item (on error it says only "No notes yet."), and every hunter flagged both; the scorer now lists such canaries
apart instead of as misses, and a claim grounded only in an aria node or source now counts by its checklist item.

*Clean screens* (7 claims over 3 runs, for a human to label): `L4` on `/help` ×3 compares the heading with the
Notes screen's off-palette heading, so the claim lands on the screen that matches (wrong place; L4 now asks for the
odd one out); `L5` on `/about` ×4, "Log in" in the header vs "Login" on the sign-in button, is the seeded
inconsistency (P33) seen from another page and likely true.

*Lens fixes from the hunters' notes:* L2 no longer asks a hunter to restate `no-offline-notice`; L6.unclear-confirm
accepts a confirmation found in the source slice (a native `confirm()` never shows on screen); L4 claims only the
odd one out. These changes are not re-measured yet.

*Verdict:* recall is 100% on every AI seed in three runs, but the seed set is too thin to call the gate met: 1–2
seeds per lens, none for L1, L4 and L10, all on the app the lenses were written against. Still needed: ≥3 AI seeds
per lens, the held-out benchmark (§8), and the precision gate (a human-labelled sample of 50 verified findings).

*Seeds added (2026-10-13 KST, P42–P58):* every AI lens now has three seeds in the benchmark app, 24 in all, none of
them caught by a rule or computed lens (bench: rule recall 34/34, 0 false positives on clean scenes, identical
evidence). L1: a squashed photo, an "Archived" stamp over item titles, an unstyled "Connected apps" list; L2: a
"Loading task…" that never ends after a failure, an empty notes screen with no way to write one; L4: a button one
step off the brand green, an input with its own height and border, one dashboard card styled unlike the others; L5:
"memos" for notes; L6: sync metadata ("rev 7f3a9c2e · etag …") on screen; L7: marketing numbers on the private
dashboard, an open debug JSON panel; L9: "Empty archive" without confirm or undo, a details field with no draft
beside "Back to tasks"; L10 (phone): a fixed tip bar over Save, a promo block that pushes Login below the first
view, a cookie banner over the footer links. Each has an `ai` match hint (lens, route, state or viewport, checklist
id or words). The inventory does not yet treat "empty" as a destructive verb (P54).

*Re-measure on the 24 seeds (2026-10-13 KST):* the same method on a new capture (100 scenes + 3 canary copies):
89 of 212 units per run, nine hunter packets, three runs (about 3.6M subagent tokens in all).

| Lens | Seeds | Found (run 1 / 2 / 3) | Mean recall |
|---|---|---|---|
| L1 | 3 | 1 / 1 / 1, then 3 / 3 / 3 with the fix below | 33% → 100% |
| L2, L4, L5, L6, L7, L9, L10 | 3 each | 3 / 3 / 3 each | 100% |

- *L1 fix:* the hunters saw the "Archived" stamp over item titles and the squashed photo in every run but answered
  cannot-judge: neither is a control, and L1 read only the screenshots, controls.json and measure.json. L1 now also
  reads styles.json (the stamp has a row) and aria.yml (the photo is an `img` node). An L1-only re-run of the same
  units with the fixed lens, three runs, found all three L1 seeds every time, grounded in those files, with no
  claim on the clean screens.
- *Canaries:* 2 of 2 hit in every run (`fixed-cover` on the phone home screen, `blank-state` on a slow task
  screen); the third, `blank-state` on the notes error screen, was ambiguous again (the original already fails the
  same item). Canary placement should avoid screens that already fail the planted item; not built.
- *Clean screens:* the L4 wrong-place claims of the first measurement are gone (L4 now claims only the odd one
  out); the one remaining claim, L5 "Log in" (header) vs "Login" (sign-in button) on `/about`, in every run, is
  the seeded P33 inconsistency seen from another page.
- 166/166 cells seen per run, no answer rejected.

*Verdict:* every AI lens reaches the recall gate on the benchmark's seeds (≥75%, mean of three runs; L1 after the
evidence fix). Still open before the gate counts for release: the held-out benchmark (a second app never opened
during development; measured in §9.4), the precision gate (a human-labelled sample of 50 verified findings), and the Codex CLI
comparison (§8).

### 9.4 Held-out benchmark, first measurement (2026-10-13 KST)

*The app:* `bench/heldout/pegroom/`, an invented community tool library (borrow tools, book workbench slots). A
separate agent built it and wrote its answer key, `bench/answers/pegroom.json`, from the lens and rule
definitions. The session that measured it read neither, and nothing was tuned on it. It is not in CI; see
`bench/heldout/README.md`.
- *Stack:* a React Router SPA built with Vite, with a dependency-free Node server and cookie sessions. Pebble is Next.js.
- *Size:* 15 routes in one route-object config; 180 scenes plus 3 canary copies.
- *Seeds:* 38 rule seeds across 32 rule ids, 28 AI seeds (3–4 per AI lens), and 3 clean routes.

Run with `node bench/run.mjs --app bench/heldout/pegroom --twice`. The runner and AI gate now read build, start,
samples, login and answer key from each app's `bench.json`.

*Rule and computed lenses (0.1-a gates):*

| Gate | Target | Result |
|---|---|---|
| Rule-lens recall | 100% | 37/38 (97.4%) — **fails** |
| False positives on clean scenes | ≤ 0.1 per scene | 0 on 20 scenes |
| Determinism (2 runs) | identical | identical (1,837 files) |
| Fingerprint stability | ≥ 95% | 100% (42/42) |

The miss is `signed-in-bounced` on `/account/billing`. The app sends a signed-in member to
`/sign-in?next=%2Faccount%2Fbilling`, but the rule's pattern `(log-?in|sign-?in|auth)(\/|$)` is tested against a
path that still includes the query string, so it never matches. This is an engine bug, not a seed error. Capture
took 253 s.

*AI lenses:* same method as §9.3, run on the same capture. Per run, the gate picked 137 of 288 units.
- Run 1 hunted every picked unit: 44 packets (the canary packet split into four canary-only packets).
- Runs 2 and 3 hunted only the seed and canary units (31 packets each); the clean-screen units ran in run 1 only,
  by the owner's call on cost.
- Cost: 106 hunters in total, about 15M subagent tokens.

| Lens | Seeds | Found (run 1 / 2 / 3) | Mean | Gate |
|---|---|---|---|---|
| L1 | 3 | 3 / 3 / 3 | 100% | pass |
| L2 | 4 | 4 / 4 / 3 | 92% | pass |
| L4 | 3 | 2 / 2 / 2 | 67% | **fail** |
| L5, L6, L7 | 4 each | 4 / 4 / 4 each | 100% | pass |
| L9, L10 | 3 each | 3 / 3 / 3 each | 100% | pass |

- *L4 miss (all three runs):* on `/bookings/:id` the status is a grey square uppercase tag, while the bookings
  list shows the same status as a green rounded pill. No hunter claimed it. The inconsistency lives between two
  screens, and the unit's reference scene was not the list screen, so the counterpart was never in view. Fix
  direction: give L4 units references that share components with the scene under review.
- *L2 miss (run 3 only):* the hunter found the seed (a failed availability load drawn as a fully booked week)
  but cited `aria=group "Week of 19 January"`, and the claim was rejected. The aria.yml line is
  `group "Week of 19 January": Week of 19 January Mon 19 …`, with inline text after the colon. The engine indexes
  the whole line, so the node is not addressable by its role and name. This is an engine bug: 4 claims rejected,
  2 cells left unseen.
- *Canaries, as scored: 1 of 3 hit per run.* `vague-error` on the plans error screen was hit in every run. The
  other two failures are in the canaries, not the hunt:
  - `fixed-cover` (`/tools`, desktop) was flagged by every hunter in every run, with the right bar and band. Each
    claim cited the elements the bar covers once the page scrolls (tool cards, footer links), not ones inside the
    first-view band the scorer checks, so the scorer counts a miss.
  - `blank-state` (dashboard error screen) blanks a message, which the `blank-state` rule already reports. The
    hunters said exactly that and, as L2 instructs, did not repeat it. They also flagged the missing next step.
    This kind of canary cannot test an AI lens.
- *Clean screens (run 1):* 5 claims, both kinds traceable to the engine rather than to hunter judgement:
  - L6 unclear-confirm on `/help` and `/history`. The `confirm("Proceed?")` belongs to the booking detail page. With
    every route in one React Router config file, the source map gives every route the whole app's files, so each
    screen's source slice carries every screen's strings.
  - L5 'cancel' vs 'Release slot' on `/help`. This is a real cross-screen wording difference seen from Help; a
    human should label it.

*Engine issues found, not fixed here.* Fixing them would turn this app into a tuning set; the numbers above stay
as the held-out result, and a later re-measure on pegroom is reported as not blind.
1. `signed-in-bounced` must strip `?` and `#` before matching the sign-in pattern.
2. aria.yml nodes of the form `role "name": text` must be addressable as `aria=role "name"`.
3. React Router source map: route each config entry to its `element` component, not to the config file.
   Otherwise source slices and `dead-end` see the whole app on every route.
4. L4 references: pick a scene that shares components with the one under review.
5. Canary scoring: a `fixed-cover` hit should also count claims on elements under the bar at any scroll
   position; `blank-state` should not be planted where a rule reports the same thing.
6. When an app throws on `!res.ok` without reading the body, Chromium never marks the request finished, so the
   `networkidle` waits run to their timeouts. This only slows the capture.

*Verdict:* the held-out app fails two gates: rule recall (37/38, one engine bug) and L4 recall (67%). Seven of
eight AI lenses pass. Determinism, fingerprint stability and clean-screen false positives hold. Release still
needs the fixes above and a fresh held-out app for a blind re-measure, besides the precision gate and the Codex
comparison.

## 10. Open items

- *Resolved 2026-10-13 KST:* a plugin installed from git has no `node_modules`, so capture could not start.
  `nunchi setup` installs the pinned packages from `package-lock.json` (`npm ci --ignore-scripts`: integrity
  hashes checked, no install scripts) and Chromium through the pinned playwright-core; every command that needs
  them says so instead of failing with a stack trace. CI (`.github/workflows/ci.yml`) runs the tests on Linux, macOS
  and Windows × Node 20/22/24, a fresh install exactly as a plugin user gets it, and the benchmark gates.

- Whether the skill can be invoked as `/nunchi` or only as `/nunchi:nunchi` once installed from the
  marketplace (plugin skills are namespaced). Verify on a clean install.
- Reserve the npm name with a 0.0.x publish through trusted publishing (needs the owner's npm account).
