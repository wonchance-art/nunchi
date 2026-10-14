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
  *Strict replay (2026-10-14 KST, design 0.1-c D11):* in replay every fetch/XHR miss and every non-GET is aborted,
  never sent live: a data request the recording cannot answer (read or write) fails in the page and is counted as a
  miss when it is asked for (a slow scene's too); a write that is not a data request (a beacon, a form post, a
  server action) is aborted and counted the same way. An EventSource stream is aborted and a WebSocket closed before
  it reaches a server; both are listed as `streams` in `network.json`, apart from the misses (a stream is never
  recorded, so re-recording would not help). What a page sends while it unloads never leaves the browser, in every
  mode: a keepalive fetch or a beacon sent on beforeunload/pagehide/unload (a navigation inside the scene, an iframe
  moving on) is sent by Chromium from the browser process, where request routing and offline emulation do not reach
  (measured on Chromium 141 and 153), so an init script in every frame drops fetch, XHR and `sendBeacon` once the
  page starts to unload, and `fetchLater()` never sends. A scene ends by disposing its context, which runs no unload
  handler. Forced states and canary
  copies replay whenever their person does not capture live, even from an empty recording. Recording still goes
  live: the app's server must be an allowed base URL (§2.4), and a backend the app calls from the browser is reached
  as the app would reach it; a held slow request that outlives its page is dropped, not a crash.
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
  name (the app's own label). In `aria.yml` a field (textbox, searchbox, spinbutton, combobox, slider, listbox) keeps
  its node, name, state and placeholder; its value and every other child (a select's options and `[selected]`) are
  cut (`- textbox "API key"`). Editors hold what the user wrote too: the text of contenteditable regions and
  `role=textbox|searchbox` elements is cut from `text.txt` and `aria.yml`, and their controls and links are left out.
  Screenshots are not masked: they are what the image lenses judge.
- *Secret-shaped strings on the page (2026-10-14 KST):* every string capture writes (page text, aria snapshot,
  controls, measurements, console, network keys, findings) goes through `scrubSecrets`, the scrubber the HTML export
  uses too (§7.1: the shapes of §3 L9 and more, whole private-key blocks, any JWT); a match is written as
  `[secret-shaped: <kind>]`. URL userinfo (`https://user:pass@`) is dropped with the credential query values.
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
`wholeApp` (no `--routes`, no `--changed-since` and no dynamic route skipped for a missing sample: whole-app
detectors judged every route), `unresolved` (paths discover cannot resolve, skipped by every run; they never
make a run partial, and are listed so they stay visible), network mode per person, run health, and since M1
(2026-10-14 KST, design 0.1-c §2.1, §7) `kind` (`sweep` for a capture; `fix-probe` for the fix loop's probes since
M3, §6.5; `quick` comes with M5; a run without one is a sweep) and `worktree` (`main`, or `wt:<name>` for a linked git
worktree: runs stay
in their worktree's folder, the ledger is shared, §5.1). In a repository the next run id is taken after every id any
worktree used (a counter in the shared state, under its lock), so ids stay one sequence. Every file of a run is
written to a temp file in the same folder (created exclusively, keeping the mode of the file it replaces) and
renamed into place, so files written into a complete run later (hunt, verify, canary score) are never seen half
written. Two captures started at once never get the same id.

*Safety (2026-10-14 KST, design 0.1-c D9, D10, D12):*
- **Base URL.** `capture` refuses a base URL that is not loopback (`localhost`, `*.localhost`, 127/8, `::1`,
  `0.0.0.0`), a private address (10/8, 172.16/12, 192.168/16, fc00::/7) or `*.local`, unless its host is listed in
  `.nunchi/config.json` (`{"allowHosts": ["preview.example.dev"]}`, exact host names), a file the user writes.
  Link-local addresses (169.254/16, fe80::/10) and `fd00:ec2::254` are refused unless listed: cloud metadata services
  answer there. Judged on the URL as written, never by DNS; http and https only. The refusal (exit 2) says how to
  list a preview host; no run folder is made. A config file that does not parse is an error, not "nothing listed".
  Redirect hops are not routed, so a scene whose page ends on another origin is not captured: `capture-failed`,
  reason `redirected-off-origin`, with `finalOrigin` in the manifest and nothing collected from that page.
- **git** runs with the repository's own programs off: `--no-optional-locks`; config overrides
  `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `diff.external=`, `core.pager=cat`, and every configured filter
  driver's commands emptied, passed as `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` so any filter name works (`a=b`
  included); `--no-ext-diff --no-textconv --ignore-submodules=dirty` on diffs; the caller's `GIT_*` variables dropped;
  `GIT_CONFIG_NOSYSTEM=1`, no prompt, a 60 s timeout; `--end-of-options` before a `--changed-since` ref. git older
  than 2.31, or a filter command still set after the overrides, fails closed: `workTree` reports no repository and
  `--changed-since` refuses (`workTree` and `--changed-since` are the engine's git calls). An edit inside a
  submodule is not part of `tree`.
- **File modes.** Run folders, evidence, recordings and the hunt mirror (everything written through `writeStable`
  or `privateDir`) are 0700 (folders) and 0600 (files), set explicitly whatever the umask. Before it starts, `capture`
  makes `.nunchi/har/`, `runs/` and `state/` 0700 (so the ledger's first write lands in a private folder; the ledger
  commands and `gc`, whose catch-up fold can write it first, do the same for `state/`) and tightens `auth.json` and `evidence/` left by an older version. A symbolic
  link at any of these paths, or at a file the engine writes, is refused (exit 2), never followed. Windows has no
  POSIX modes and keeps its ACLs. The ledger's own files (`ledger.json`, `approved.json`) are written by the ledger
  and protected by the 0700 `state/` folder; in a repository that folder is the shared one under the common git
  folder (§5.1), made 0700 the same way, and `.nunchi/state` is not made.

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
| `paint.json` | the colours `styles.json` misses (it keeps only elements with their own text and controls): page and container backgrounds, border and outline colours, inline SVG fill and stroke, each with what it is seen against (§3.2.1) |
| `controls.json` | buttons, links, inputs: accessible name, box, visible |
| `network.json` | url, method, status, blocked, replay miss; writes (POST/PUT/PATCH/DELETE) flagged |
| `console.json` | console errors, page errors |
| `links.json` | internal links → target route, status |
| `measure.json` | rule-lens measurements (§3) |

Run-level: `manifest.json` (scenes with status, reason, `finalPath` and `redirected`, health; a scene is
redirected when its final path differs from the path it opened, query and fragment aside. Readers derive the flag
from `reason`, `path` and `finalPath` for manifests written before it existed, so older runs read the same; a
redirected scene feeds no link edges, design-system screens or parity pairs, and counts as a redirect to its
final route), `findings.json`, `timing.json`, `run.json`, `source-map.json`
(§2.5), `source-hashes.json` (since M1: per route a hash of the contents of its files and the app config,
§4.1), `inventory.json` (source strings and UI states, extracted with Babel/SWC; classified in 0.1-b),
`canaries.json` (planted defects, an answer key), and after the AI hunt `hunt-plan.json` and
`hunt/<alias>/` (runs with canaries: scene aliases and the evidence they point to), `ai-findings.json`,
`coverage.json`, `canary-score.json`, `verify-packets.json`, `verify.json` (§4), after a re-check
`recheck-packets.json`, `recheck/<alias>/` and `recheck.json` (§4.1), and after `nunchi tokens` `tokens.json` and
`tokens.css` (§3.2.1). The answer keys (`hunt-key.json`, `verify-key.json`, `recheck-key.json`) are not in the run
since M1: they are kept outside the project (§5.1). Files written into a complete run (hunt, verify, canaries,
re-check) are read, changed and written under the run's own lock (`run-files.lock.d` in the run folder).

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
`_app`/`_document`; TanStack root and parent routes). React Router routes start from what the route config says
they render, not from the config file, which imports every page:
- discover records each route's `components` (from `element`, `Component`, and wrappers such as
  `<Guard><Page/></Guard>`, plus those of its enclosing layout routes) and its `lazy` modules;
- the map follows those through the config file's imports;
- the config file itself is part of every route it declares, but its imports are not followed.

A component that can't be followed (defined in the config file itself, or with no import found) falls back to the
config file and everything it imports. It over-approximates on purpose: a missed edge would hide a stale screen. A change to a dependency or build config (`package.json`, lockfiles, `next/vite/tailwind/postcss`
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

### 3.2.1 Tokens: design supporter Stage 0, Tidy (built 2026-10-14 KST)

Stage 0 turns the look the app already has into a token proposal, with no visual change intended. Later stages
(a concept to move towards, a migration) build on it. Everything here is computed from the evidence. There is no
AI, and the engine never edits the app (the CSS is a file in the run).

**Measurement (`paint.json`, per scene, schema 1).** It is kept apart from `styles.json`, so the L4 inventory and the
fingerprints do not move. Rows are deduplicated like `styles.json`: the first element in document order keeps its
selector. Each list holds at most 400 rows.

| List | Row | Recorded when |
|---|---|---|
| `surfaces` | `background`, `radius`, `kind`, `on`, `selector` | `<html>` and `<body>` with a background (`kind: page`); when both are transparent, the browser's white canvas (`canvas`, light scheme only). Any other visible element whose `background-color` is not transparent and whose box is ≥ 256 px² with a short side ≥ 2 px (smaller fills are dots and hairlines). `kind`: `control` (link, button), `field` (input, select, textarea), `band` (≥ 90% of the viewport wide) or `box`. Transparent means alpha 0, read from the alpha component only |
| `borders` | `color`, `sides` (`trbl` subset, or `outline`), `width`, `on`, `selector` | a visible border side with width > 0, a style other than none or hidden, and a colour that is not transparent; one row per colour; outlines likewise |
| `svg` | `fill`, `stroke`, `selector` | a visible inline SVG shape (`path`, `circle`, `rect`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `use`) outside `<defs>`, `<symbol>`, masks and patterns; `none`, `url(#…)` paints and zero opacity are left out |

`on` is the background the colour is seen against: for a surface, the nearest ancestor's background; for a border,
the element's own background, else its ancestor's; the canvas at the top. The lookup is memoised per ancestor, so the
walk stays linear in the size of the DOM. Selectors in `paint.json` and in token examples have secret-shaped `id` and
`data-testid` values replaced by `REDACTED` (the bundle scanner's shapes, plus any 40+ character token mixing letters
and digits).

**Proposal (`nunchi tokens [--run <id>] [--json]`).** It reads captured scenes only (framework error pages, redirected
scenes and canary copies are left out) and writes `tokens.json` and `tokens.css` into the run. An unreadable run
file is a one-line error with exit code 2.
- *Uses.* A use is a distinct style row on a screen (route × person). A screen seen at two widths or in several states
  counts once.
- *Colours.* Text colours come from `styles.json`. Backgrounds, borders and SVG paint come from `paint.json`; a run
  without `paint.json` falls back to the text rows' own backgrounds (`measured: styles-only`).
  - Colours are clustered in OKLab by leader clustering. In order of uses, then screens, then value, each colour joins
    the nearest cluster leader within ΔE_OK ≤ 0.03 (about one just-noticeable difference) whose alpha is within 0.1.
    Otherwise it leads a new cluster.
  - Figure and ground keep their separation. For every pair of colours seen against each other (a card and the page,
    a line and its card), the proposed values stay at least min(their own ΔE, 0.03) apart; otherwise the card or the
    line would fade. A colour never joins a cluster holding a colour it is seen against, and a post-pass splits off any
    member whose move would still bring such a pair closer (the one that moved, the lighter one when both did).
    Such pairs are listed under `keptApart` as `{a: {token, value}, b: {token, value}, deltaE}`, with the ΔE between
    the two colours themselves.
  - A cluster's proposed value is its leader, the most-used member, so that colour does not change. Each member
    lists its uses, its screens, its ΔE from the leader, the contexts it is used in and up to three examples
    (scene, selector).
  - Families: OKLCh chroma < 0.05 is grey. Otherwise the family comes from the hue angle: pink below 12° and from
    340°, red to 45°, orange to 80°, yellow to 120°, green to 175°, cyan to 230°, blue to 285°, purple to 340°.
    So Tailwind pink is pink, rose and red are red, and CSS purple and fuchsia are purple. Tokens are
    `--<family>-<n>`, lightest first.
  - Values are parsed strictly: every number of a colour, and `<number>px` or `<number>%` for radii and sizes.
    Anything else is listed under `unparsed` and left out, so a tampered evidence file cannot put CSS into
    `tokens.css`. Radii and sizes are written back from the parsed numbers.
- *Roles,* inferred from usage, each with a confidence: the share of that usage the cluster holds among the clusters
  eligible for the role × screen coverage (screens ÷ 3, at most 1, so a one-screen run is never above 0.33). High is
  ≥ 0.6 and medium ≥ 0.3. Ties go to the colour seen on more screens, then to the value; the token name is never used.
  - `background`: page records.
  - `surface`: the most-used container fill. It may equal the background, as with white cards on a white page.
  - `border`.
  - `text`.
  - `text-muted`: a grey on the same side of the background as the text, with less contrast but ≥ 1.5:1.
  - `accent`: a control fill (button, link styled as a button; never a form field) other than the background and the
    surface. When any such fill has a hue, greys (secondary and outline buttons) are not candidates. Ties go to the
    more saturated colour. Without control fills, the accent is the most-used coloured link colour.
  - `accent-foreground`: the text colour most often set on the accent.
  - `danger`, `success`, `warning`: the most-used red, green, or orange/yellow. These are guessed from hue only, so
    their confidence is capped at 0.5.
- *Contrast* (WCAG 2.x, hand-written): text and muted text on the background and the surface, accent foreground on
  the accent, accent and danger on the background. Each pair reports its ratio, AA (4.5:1) and AA for large text (3:1).
  Two roles on one token (dark cards in the text colour) are reported at 1:1, failing.
- *Files.* `tokens.json` holds the data. `tokens.css` holds the proposal as custom properties; it is not repeated in
  the JSON.
- *Radii* are one token when |a − b| ≤ max(2 px, 20% of the larger). Values ≥ 500 px are `--radius-full`, and
  percentages stand alone.
- *Font sizes* are one token when |a − b| ≤ max(0.5 px, 7% of the larger). The most-used plain-text size is
  `--font-size-body`.
- The CLI prints one line, e.g. `23 greys → 6 · 9 blues → 3 · 7 radii → 3 · 11 font sizes → 8`, then the roles and
  the contrast. The same input gives byte-identical files.

*Limits.* The following are not measured:
- gradients and `background-image`;
- images and video;
- `::before` and `::after` paint;
- box-shadow colours (they stay strings in `styles.json`);
- text over images;
- colours inside shadow DOM and iframes;
- elements beyond the 400-row caps.

Further caveats:
- Alpha colours are compared as written, not composited.
- A use is a distinct style row, not an element, because the evidence deduplicates identical rows.
- Roles are guesses from usage. A dark-mode capture is not an axis yet (0.2).
- Two near-white tints of different hue can merge, because their chroma is too low for hue to count (on pegroom a
  pale green chip fill joins a pale blue one at ΔE 0.023). The member list shows this; there is no hue guard yet.

*Measured (2026-10-14 KST, real-data sanity check, thresholds not tuned to either app).* Capture time is unchanged
(Pebble 124.5 s against 125.1 s before). `styles.json`, `measure.json`, `findings.json` and `design-system.json` are
byte-identical to a capture without `paint.json`. Pebble `--twice` stays 34/34 and identical (1,140 files), and
fingerprints are 52/52. After the review fixes (14:01 KST) it is again 34/34, identical and 52/52 (129.7 s), and
both summaries below are unchanged. pegroom's accent confidence rose from 0.81 to 0.93, because form fields no longer
count as accent candidates. On a synthetic page with 10,000 filled leaves at depth 300, `collect()` takes 660 ms with
the memoised lookup, against 2,643 ms before.

| App | Scenes · screens | `nunchi tokens` summary | Roles |
|---|---|---|---|
| Pebble | 96 · 24 | 10 greys → 9 · 2 blues → 2 · 2 greens → 1 · 6 radii → 4 · 9 font sizes → 7 | background = surface = white; accent green, AA 7.49:1 against its white foreground |
| pegroom (seen held-out) | 176 · 28 | 14 greys → 12 · 3 reds → 3 · 2 blues → 1 · 1 greens → 1 · 1 oranges → 1 · 1 yellows → 1 · 6 radii → 4 · 10 font sizes → 8 | cream page with white cards; the two are kept apart at ΔE 0.016; all seven contrast pairs pass AA |

Both apps are small and hand-styled, so there are few merges. The sprawl case is covered by the fixture
`test/fixtures/tokens/greys.html` (12 greys → 5).


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
(boolean: the unit also gets its route's source inventory slice, §4; added 2026-10-13 KST), and an optional
`reference` (`"spread"`, the default: each unit's reference screen is picked by hash so references spread over the app;
`"nearest"`: the route sharing the most leading path segments comes first, so `/bookings/:id` is compared with
`/bookings`; built-in: L4, added 2026-10-14 KST after the held-out miss in §9.4). Only `method: "ai"` lenses are hunted.

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
  keys, and the scene's evidence files. Decoys = max(3, ⌈n/4⌉) (20% of packets, at least `MIN_CONTROLS` = 3, the
  re-check's minimum too): false claims on visible, unclaimed controls of the claimed scenes first, then of the run's
  other captured scenes (never a canary copy; the scene's own route and viewport), in a seeded order, from
  `controls.json` (a clear label claimed unclear `L6.unclear-label`,
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
- *M1 (2026-10-14 KST, design 0.1-c §2.2):*
  - **Fewer decoys than planned is no double-check.** The key records `decoysPlanned` (max(3, ⌈n/4⌉) for n claims)
    and `verify.json` says it too, so a run with no decoy target can no longer pass unchecked. *Changed (review of PR
    #29, round 2, 2026-10-15 KST):* such a run was suspect whatever its verifier did; a small app could never be
    double-checked and never be told why. Now it has its own outcome, **too few decoys to check the checker**
    (`verify.json` `outcome: "too-few-decoys"`, `suspect: false`, `tooFewDecoys` with the counts; each verification
    `tooFewDecoys: true`). It is not suspect, and it is not a double-check either: those AI findings stay *not
    double-checked* (the ledger's `checkedAi` is false; a rejection there keeps the claim, as a suspect one does), and
    `verify --record`, `findings`, the board's tag, Detail and Progress line and the export say "too few decoys to
    check the checker". `verify --plan --again` is refused for it (a new plan of the same screens has no more
    decoys; capturing more screens gives more). A decoy confirmed or left unanswered in such a run still makes it
    suspect (pass-through or "no decoy was answered" come first). Decoys are never doubled up on one element to
    reach 3.
  - **Decoys stay off what the run claims** (review of PR #29, round 2, 2026-10-15 KST). A selector claimed on any
    scene of the run is no decoy on any scene (a shared header or nav is the same element on every screen: a decoy
    there could be true, and a correct verifier confirming it made the run suspect), nor is an element whose
    accessible name a claim of the same rule names (the claimed control's `controls.json` name, its identity name or
    its `aria=` name). One element gives at most one decoy: by selector across the run's screens, and by rule and
    name.
  - **`verify --plan --again`** verifies a suspect run once more: findings whose verdict came from a suspect
    verification are claims again (packets show the severity as claimed, never the earlier verifier's correction),
    and the new verdicts replace them. On a run that is not suspect it is refused (exit 1).
  - **`verify --record` folds the run's AI findings into the ledger** as its `(run, "ai")` fold (§5.1), and
    `--root <dir>` names the app's source when it is not the current folder. A run without an id (an `--out`
    folder) is recorded but not folded (said on stderr); a ledger that cannot be brought up to date at that moment
    only warns, and the next ledger command folds it.
  - **The answer key is kept outside the project** (§5.1), and so are `hunt-key.json` and `recheck-key.json`.
  - **Verdicts count only from the key** (review of PR #28, 2026-10-14 KST). `ai-findings.json` and `verify.json` are
    files in the project that anything can write. `verify --record` stores the verdicts in the key beside the
    packets (`recorded: {verdicts, vendor}`); a new plan keeps the rounds recorded before whose claims still match
    (`earlier`). The ledger takes a finding's status, corrected severity, verifier and `suspect` only from those
    rounds (`verdictsFromKey`): a status the key does not back with a recorded verdict on a packet whose claim hash
    still matches the finding is a claim, as severe as claimed; a claim reworded since its verdict is a claim again.
    `ai-findings.json` and `verify.json` stay as copies for people and the review page. `verify --plan --again` asks
    the key, not `verify.json`, whether the run is suspect. A status written into `ai-findings.json` by hand only
    leaves that finding out of the next plan (so it stays a claim in the ledger).
  - **An unanswered decoy passes through**: pass-through is (decoys confirmed + decoys left unanswered) ÷ all decoys,
    so skipping the hard ones does not make a verifier look careful. "No decoy was answered" is still said first.
  - **`hunt --record` folds too** (its claims, not double-checked yet, and the cells it saw), so a hunt that claims
    nothing still counts towards staleness (§5.1). `verify --record` replaces that fold with the verdicts.
  - *Choice (2026-10-14 KST):* the re-check plans at least 3 controls before anything can be fixed (§4.1). The
    verify plan kept ⌈n/4⌉ decoys, raising it left to the M2 review. *Raised (review of PR #29, 2026-10-15 KST):*
    the verify plan has at least 3 decoys as well (`decoysWanted`, the same function as the re-check's
    `controlsWanted`): with one decoy, a verifier that confirms at random passes half the time. So that small runs
    can offer 3, decoys come from any captured scene of the run once the claimed scenes run out. The 0.1-b verify
    contract test pins the new counts (8 claims → 3 decoys, 1 → 3, 40 → 10).
- Not done yet: decoys come only from controls (no L2/L10 decoys); "stricter threshold for pages with a history of
  false positives" is not built; the verifier's re-capture is the skill's job.

- **Trust:** per-lens precision = fix ÷ (fix + false positive) over the last 20 human decisions; below 70%
  the lens's new findings go to *suspect*. Resolution rate (confirmed findings that reached *fixed*) beside it.
  Since M1 trust is kept per lens **and source** (design §2.2: rules and the AI share L1, L2, L4, L6, L7, L9 and L10,
  and one must not lend the other its record): `nunchi trust --json` keys a rule lens as before (`L6`) and the AI's
  as `L6/ai`, each entry naming its `lens` and `source`. The *suspect* mark is shown, not yet applied to new findings.
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
  the canary seed) and `files` point at `hunt/<alias>/…`, the scene's evidence files copied there (since M1 copies
  with one modification time, never hard links: a link shares the original's inode and date, and a canary copy,
  captured after the scenes, would be told apart); the alias → scene map is `hunt-key.json`, an answer key the
  hunter never reads. `--record` maps the
  answers back, so `ai-findings.json` and `coverage.json` name scenes. Runs without canaries keep scene ids and get
  no key or mirror.
- *Source slices (2026-10-13 KST):* a lens pack with `"source": true` (built-in: L2, L5, L6, L7, L9) gets, when the
  run has `inventory.json`, the slice of its route: `hunt/source/<first 12 hex of sha256(route)>.json` =
  `{schema, route, note, files: [{file, strings, states, actions, dialogs}] (the inventory files whose routes include
  it), candidates (every candidate touching those files)}`, written on first use. It is listed after the reference
  scene's files and before the scenes under review, and counted in the estimate. A route no inventory file renders,
  or a run without `inventory.json`, gets no slice. Candidates are hints; a defect the code causes is grounded with
  `evidence: {file, line}` (an older answer's `source: "file:line"` is read the same way, M3).
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
  aria.yml (a node with inline text also by its role and name alone), and/or `evidence: {file, line}` naming a line that exists under the app root (not `.nunchi/`, `node_modules/`, `.git/`; symlinks
  must stay inside). Anything else is listed in `rejected` with a reason; an item whose only defects were rejected
  counts as unanswered, so the unit stays *not seen: incomplete*. Findings use the rule-finding shape plus
  `source: "ai"`, `status: "claimed"`; box comes from controls.json or measure.json when the selector has one.
  Answers naming another plan id are refused. Answers are parsed and compared as strings only.
  *Since M1 (2026-10-14 KST):* each finding also carries its `identity` (§5.1, design §2.3): the element (an
  `aria=` selector canonicalised to the selector of the first control of the scene, in document order, with that
  accessible name and role), its accessible name, the grounded file, `anchor` (a hash of the source line with its
  whitespace removed, plus which occurrence it is when the same text stands on several lines; taken now, from the
  source the hunter read), `fileHash` (of the whole file) and the component. A defect grounded in a `file:line` only
  whose line is blank is refused (`source-not-found`, "a blank line"). The hunt key is read from outside the project; a
  plan of a run with canaries whose key is missing is refused (exit 2: "run hunt --plan again") instead of
  recording findings that name aliases.

### 4.1 Re-check (built 2026-10-14 KST, design 0.1-c §2.4, M1)

A fresh hunt's silence is not evidence (hunts vary). An AI item becomes *fixed* only through a re-check that was not
suspect and said `gone` in every cell it was seen in (`src/recheck.mjs`).
- `nunchi recheck --plan [--run <id>] [--root <dir>] [--json]` on a newer run (default: the latest). Items re-checked:
  AI items standing in the ledger (open, came back, to fix, later; not kept, not a problem, fixed or stale unless
  decided *fix*), also one whose latest verdict was a rejection (it stays open until a re-check says gone, so it is
  asked about rather than left open forever). An item last seen in a run newer than this one is left out and said
  (`newer` in the key; "seen in a run newer than …: re-check against the newest run"): comparing an older screen
  would read as the defect coming and going. An item another worktree saw last is left out too, and said
  (`otherWorktrees`): only that worktree can say it is gone (§5.1 *Streams*), and a "still there" from here would
  only make this worktree's branch its owner. Per item × cell it was seen in:
  - the cell not captured in this run (failed, redirected, error page, not in scope) → `not-captured`: the item
    cannot be fixed by this run;
  - seen in this very run (a hunt claimed it here) → nothing to compare;
  - **unchanged** → still there, no packet, `lastSeen` moves. It takes all of: the screen's `top`, `full` and
    `textHash` equal those of the screen it was last seen on; the hash of the route's source files at both captures
    equal (`source-hashes.json`, written by `capture` beside `source-map.json`: per route a hash of the contents of
    every file the source map says the route renders, and of the app's config files at the root); a grounded file
    outside those files with the same hash on the tree the run was captured from (`run.json` `tree`); and a lens
    whose defects show on a screenshot. L9 (and L3) judge behaviour (what a delete does, what leaving loses): their
    items are always asked. A run without `source-hashes.json` (`--routes`, an older capture) never says unchanged.
    *Choice (2026-10-14 KST):* the route's file set is the source map's static over-approximation; what it misses
    (data, CSS reached only through tooling) usually shows on the screen, which must be identical too.
  - else one packet: the claim (`lens` and the hunter's sentence), the **old** screen (where it was last seen: its
    files, the element's selector and box there) and the **new** screen. No diff, commit message or fix brief, no
    run or scene id: every screen goes by an alias (`s` + 10 hex; old and new sides never share one), its evidence
    (`top.jpg`, `full.jpg`, `aria.yml`, `text.txt`, `controls.json`) **copied** under `recheck/<alias>/` in the run,
    every file and folder with one and the same modification time (2001-09-09 10:46:40 KST). A hard link would
    share the original's inode and date, which tell an older run's screen or a canary copy apart; the hunt mirror
    (`hunt/<alias>/`) is copied the same way.
  - **Controls**: known still-present defects, correct answer `still-there`, **only on screens that changed** since
    the previous complete run (`top` or `full` differ): a control on an unchanged screen would be a tell, so it is
    not made and counts as missing. Real packets can show an unchanged screen (a run without source hashes, a
    behaviour lens, code that changed under the same pixels): such a packet is real, and its right answer is
    `still-there` anyway. Controls are:
    - rule findings present on the same screen in the previous run and this one, one per finding × screen,
      phrased as a hunter of an AI lens would claim them (`target-size-min` → L1 "“Home” is too small to tap
      reliably.", `clipped-text` → L1 "The text “…” is cut off.", `placeholder-text` → L7, `raw-error-text` and
      `missing-value` → L6, `blank-state` → L2, …), never under the rule's own lens or title (AI items are never
      filed under a rule lens). A rule with no such phrasing, or whose defect does not show on a screen (page
      errors, failed requests, the link graph), is never a control;
    - canary copies: this run's copy of a screen and kind paired with the previous run's copy of the same screen
      and kind (`of` + `kind` in `canaries.json`): the old side is the previous run's copy, the new side this
      run's, so the two sides are two captures like a real packet's.
    At least 3 controls are planned (`max(3, ⌈n/4⌉)` for n packets; with fewer, a re-checker answering at random
    passes too often).
  - Order is a seeded shuffle; the answer key (`recheck-key.json`: per packet the item and cell or "control", the
    unchanged, not-captured and newer items, the new screens' hashes) is kept outside the project. With no packet to
    ask (everything unchanged or not captured), the plan records itself at once.
- `nunchi recheck --record <verdicts.json> [--run <id>] [--json]`: `{packet, verdict: gone | still-there |
  insufficient, reason}` per packet (one line, ≤ 300 characters; unknown packets, other verdicts, a packet answered
  twice, or packets of another plan are refused and nothing is written). The verdicts are stored **in the key**
  (`recorded`), outside the project, and `recheck.json` in the run is a copy for people to read: counts, the controls
  (`planned`, `total`, `answered`, `passedThrough`, `rate`), `suspect` and per item its verdict per cell. The CLI
  prints the control counts ("controls 3 of 3 planned, passed through (answered gone or unanswered) 0/3").
  **Suspect** when fewer controls were made than planned, when none was answered, or when more than 10% of the
  controls passed through — answered `gone`, **or left unanswered** (skipping the hard ones must not make a batch
  look careful). The ledger folds the run's `(run, "recheck")` fold (§5.1) **from the key only**: the results and
  `suspect` are recomputed from the key's plan and its recorded verdicts; a `recheck.json` written by hand is never
  read. Every cell `gone` and the batch not suspect → fixed; any `still-there` or `unchanged` → still there
  (`lastSeen` moves; the old evidence moves only on `unchanged`, when the element and box still hold);
  `insufficient` (and nothing still there) → open and *needs you*. A later claim of the item brings it back (*came
  back*). Recording again with other verdicts replaces that run's re-check. A re-check whose run is older than a
  sighting of the item already folded when the re-check was recorded can say "still there", never "gone".
- The skill runs the re-checker in a fresh context with only the packets and their files (SKILL.md, re-check).
- The fix loop's own re-check from a fresh context is `fix --verify <group> --record` (M3, §6.1, §6.5): the same
  packets, controls and keys, on the probe P1 with P0 as the screens before.
- Not done yet: re-check validation sets (§9.4 of the design).

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
  after its content, so a hash-like part of the bundle's file name becomes `[hash]` and a rebuild keeps the secret's
  fingerprint. Only the file name, never a folder, and only these parts: a whole name of 13 characters of
  `[0-9a-z_-]` with a digit (Turbopack, `1grrdrpshlkcw.js`); a `-<8 characters>` suffix with a digit, `_`, `-` or an
  inner capital (Vite/Rollup, esbuild, `index-Boalzs1w.js`); a `-`/`.`-separated part of 8+ letters and digits that is
  lower-case hex or has a digit between letters (webpack, CRA, Parcel). Words and words with a number
  (`checkout2.js`, `facade.js`) stay, so two bundles never become one. Every other rule's fingerprint is the
  v1 one (a contract test pins v1 values). The evidence of a secret is `{url, kind}`: v1's `masked` (four characters
  of the value) is gone. **Migration:** a v1 `ledger.json` is migrated on read: secret items get their v2 fingerprint
  and group from what they stored (rule, route, selector, evidence), items that now share one (two builds of one
  bundle) merge without making the defect easier to call fixed (first seen is the earliest; the cells and
  whole-app coverage of both; open if either was open; looked at when both were), `masked` is dropped, and
  `aliases` (old → new) is kept in the state. A decision made under v1 follows its item: through `aliases`, or, for one from another machine, by the v1
  fingerprint of what the state holds now. When a merged item's old decisions disagree (one dismissed, another to
  fix, hold or reopen), the dismissal does not carry over: open beats dismissed. The decision file is never
  rewritten; the view moves its target and keeps its id (`targetWas`), and its approval and first-seen time stay
  those of the file as written. The migration runs inside the ledger's read (the same checks as any read: no
  link, a parse error by position only), and the next ledger command writes the migrated state back under the
  ledger lock.
- **Group** = the fingerprint without the route: a shared component's defect on 17 screens is one group, the
  unit a person decides on and the fix loop fixes. Low contrast groups by its colour pair (the design token),
  not by element. Root-cause groups by source file + symbol come with the inventory (§2.4).
- **Decisions** are append-only files, `.nunchi/decisions/<group-…|fp-…>/<id>.json` (committed; two people
  never edit the same file): `fix`, `keep` (reason `intended` | `out-of-scope`), `false-positive` (reason
  `not-a-problem` | `wrong-place`), `hold`, `reopen`; who and when (KST). The latest decision on the fingerprint
  or its group wins; a group decision covers screens found later. Written to a temp file, synced and renamed into
  place; a file that is torn, is not a decision, is not a regular file (a link is never followed), is larger than
  64 KB, or does not match its place (file name = id, folder = target) is an error naming the file (exit 2), never
  skipped. Errors give the file and the parse position, never the file's text; `approved.json` and `ledger.json`
  are read the same way.
- **Order (0.1-c M1a, design §8.3):** a decision's time is the earlier of its date and when this machine first saw
  it (kept in the ledger state, by id and content), so one that arrives late cannot outrank decisions made after
  it arrived. A decision dated more than 5 minutes after it arrived never counts, not even once its date passes.
- **Provenance (N1; hardened in 0.1-c M1a):** decisions made with `nunchi decide` on this machine are recorded in
  `approved.json` of the state store (`.nunchi/state/`, or the repository's shared state folder since M1, §5.1;
  git-ignored either way) by id **and content** (`<id>:<SHA-256 of the record>`), before the
  decision file is written, under a lock (since M1 a revision-checked commit, §5.1). A file that reuses an approved id with other content is not approved.
  Approvals written before are carried over once and each one is said: a bare id binds to the one file with that
  id, except when two files share it or the file is a keep or false-positive on a blocker or L9 finding (the file
  may have been swapped since): those move to `legacy`, are never honoured, and need `nunchi approve` again.
  Anything not approved came through git: it is shown, but it cannot dismiss a blocker or an L9 (safety/secret)
  finding, and the fix loop will not act on an unapproved `fix` until `nunchi approve`. An `approved.json` that
  cannot be read is an error and is never replaced by an empty one.
- **Status is computed, never committed:** each complete run is folded into the state store's `ledger.json`
  (`.nunchi/state/`, or the repository's shared state folder since M1, §5.1):
  `open` → `fixed` when a run that looked again no longer finds it → `regressed` when it comes back. With
  decisions: `to-fix`, `kept`, `dismissed`, `held`. `fingerprintVersion` and each fingerprint's inputs are stored
  so a new version migrates decisions instead of orphaning them (v2, above). Since 0.1-c M1a:
  - *like for like:* each item keeps the cells it was seen in (`person.state.viewport` on its route); a sighting
    by a narrower run keeps the cells that run did not look at. It is `fixed` only when a run at the same origin
    captured every one of them (captured, not redirected, not an error page, not a canary copy), with the other
    side of a comparison too (parity: the desktop; `error-looks-empty`: the empty state; `no-offline-notice`:
    normal), and the app was reachable, the recording current and, for signed-in cells, the login working.
    Whole-app findings (route-less secrets, `unreachable-route`, `link-to-missing-route`, L4 one-offs) keep what
    the runs that saw them looked at (route × cell; routes the app no longer has drop out) and need a `wholeApp`
    run that looked at all of it again; a route an earlier run looked at that this run did not (it failed, answered
    an error or redirected this time) makes the run partial, while a route no run has looked at (always broken,
    always redirected, unresolved) does not. `--states`, `--viewports`, `--routes`, `--changed-since` and a
    skipped sample fix nothing they did not look at. A run that would fix ≥ 10 items and more than half of the open ones
    while most of its screens show one and the same text (another app, or one error page) fixes nothing, and
    `findings` says so.
  - *looked at:* each item records the last run that looked at all its cells; `findings` says when an open item
    has not been looked at for 3 runs (it cannot be marked fixed until a run covers it).
  - *monotonic:* a run older than the newest folded one only adds what it saw: it never marks anything fixed,
    never moves `lastSeen` back, and brings an item back only if it saw it after the last run that looked at it.
  - *catch-up:* every ledger command (and `capture`, `gc`) first folds the complete runs not folded yet, in run
    order, under a lock, so a crash between a run completing and its fold leaves nothing unfolded. `gc` removes
    only runs the ledger holds and exits 2 when it cannot bring the ledger up to date. A ledger or run file that
    cannot be read is an error (exit 2), never "empty". Temp files and lock folders a crash left are removed once
    they are an hour old.
  - *lock:* `<file>.lock.d`, a folder taken by renaming a folder that already holds its owner into place. A holder
    on this machine is stale only when its process has ended, never by age (Linux: its pid and that process's start
    time; Windows, where a freed pid goes to the next process at once: a file the holder keeps open with sharing
    mode 0, which Windows closes when the process ends; elsewhere, or if that file cannot be made exclusive: the
    pid alone, so a reused pid makes takers wait and end in LOCKED, never take a live lock); one on another
    machine, after 30 s without a touch. One taker at a time removes a
    stale lock, after checking again that it still holds the owner judged stale; a lock is never given back and is
    released only by its owner. Waiting ends after 5 s with an error. Renames Windows refuses while another process
    reads in the folder (EPERM, EACCES, EBUSY) are retried with backoff, for the lock, the ledger files, run folders
    and `runs/latest` (last writer wins; a failed `latest` write never fails a capture).
- **Channels (2026-10-15 KST, design §1, §7.2):** a decision records how it was made (`channel`: board, cli-tty,
  cli-agent) and an optional `batch`; approved.json keeps the channel per approval and the keys a person confirmed in
  the board. A keep or false-positive no person made or confirmed shows as kept / dismissed but does not clear
  "Ready to ship" (summary.mjs).
- **CLI:** `nunchi findings` (one row per kind; `--rule <rule>` lists its groups; `--status`, `--all`, `--json`),
  `nunchi decide <id…> <decision> [--reason] [--note]`, `nunchi approve <id…>|--all`, `nunchi trust`.
  Since M1 `findings` lists double-checked AI kinds as `AI · <checklist item>` beside the rule kinds, collapses AI
  groups not double-checked (claimed only, or a verdict that was suspect, rejected or insufficient, or from a run with
  too few decoys to check the checker, §4) into one line
  (`--all`, `--status` and `--rule` list them; `--json` names them under `notDoubleChecked`), and says how many AI
  groups are stale and how many AI findings need you.

Field app 1 (§9.2) after this: 1,082 findings → 578 unique defects → 99 groups → 9 kinds on one screen of text.

### 5.1 State store, schema 2 and AI items (built 2026-10-14 KST, design 0.1-c §2, §7, §8.1, M1)

**State store** (`src/state.mjs`).
- *Root.* In a git repository the state lives in `$(git rev-parse --git-common-dir)/nunchi/<app>/state/`, so every
  worktree of the repository reads one ledger and one approval list. `<app>` is `root` for an app at the top of the
  repository and `app-<12 hex of its path in the repository>` for one in a subfolder, so two apps of a monorepo never
  share a ledger (the design names `<common>/nunchi/`; the app key is added). git runs through the hardened runner
  (§2.4 *Safety*). Without git, or with a git nunchi cannot run safely (older than 2.31, a filter command still set),
  the state stays in `.nunchi/state`, per folder.
- *A shared folder that cannot be written* (a read-only or foreign-owned `.git`, `nunchi` there being a file: the
  probe meets `EACCES`, `EPERM`, `EROFS`, `ENOTDIR` or `EEXIST`): the worktree keeps its state in `.nunchi/state`
  instead, says so in one line on stderr, and records the choice in `.nunchi/state/fallback.json`, so every later
  command (the review page too) picks the same root without a word; deleting that file tries the shared folder
  again. Another error is an error. In that fallback, state files committed to git are refused (exit 2, "committed
  to git: state that came through git is never read"), as below.
- *Moving an older `.nunchi/state` in.* The first ledger command in a repository moves `.nunchi/state/ledger.json`
  and `approved.json` into the shared folder and says so on stderr; the old files are kept beside, renamed
  `<name>.moved`, never deleted. Everything in that ledger came from this worktree's runs, so its folds and items are
  tagged with this worktree's stream. When the shared folder already has a ledger (another worktree moved its own
  first), the open items the shared ledger does not have (seen in runs since removed, say) are carried over as they
  stand, tagged with this worktree's stream, with the coverage sets they name; the shared ledger's record of an item
  wins; and what was not carried is said on stderr: items already fixed there (history only), which of its runs were
  folded (this worktree's runs on disk are folded again by its next ledger command) and when decisions were first
  seen. Approvals are added (both lists are this machine's).
  - **Never taken from a moved file: `decisionsSeen`** (when this machine first saw each decision). A file can claim
    any time, and an early one would let a decision outrank decisions made after it; the decisions are noted again,
    from the next command on.
  - **A file committed to git is never adopted.** The candidates are listed with `git ls-files -z -- .nunchi/state`
    (through the hardened runner); a committed `ledger.json` or `approved.json` stays where it is, unread, and is
    said ("committed to git, so it was not moved … git rm --cached"): anyone with push access could have written it,
    approvals of blockers included.
- *Writes* (`updateDoc`): read the document and its `rev`, change it, then under the file's lock commit only if
  `rev` on disk is still the one read; otherwise read again and redo the change (no lost update; a holder whose lock
  was taken over as stale finds the `rev` the new holder wrote and reads again, unless both write in the same
  instant). After 4 conflicts the whole read–change–write runs under the lock, so
  a busy file still makes progress. The commit writes `rev + 1`, keeps the file it replaces as `ledger.json.prev`
  (the ledger only, as the design names; approvals have no `.prev`), writes atomically and synced (§5 *lock*,
  `writeAtomic`), and bumps the state's `generation` file (a counter under its own lock, taken after the
  document's, so locks are always taken in one order). Nothing to write: nothing is written, no generation. Every
  CLI write of the ledger and the approvals bumps the generation; the library functions bump it when given its path.
  *Order (2026-10-14 KST):* the generation is bumped **after** the document is written. A reader that sees a new
  generation finds the new document; one that read the document between the two sees the new document with the old
  generation, and catches up at the next bump. So a reader (the M2 board) caches by each document's `rev` and reads
  again whenever the generation changes; it never takes an unchanged generation to mean an unchanged document.
- *Reads* (`readDoc`): a file that cannot be read or parsed is read once more after 20 ms (a Windows reader can meet
  a rename), then it is an error (exit 2) naming `ledger.json.prev` as the way back, never "empty". A link, a folder
  or a file over the size cap is not read again. A ledger of a newer schema is refused, never half understood.
- *Run ids.* Runs stay in their worktree's `.nunchi/runs`; the shared folder keeps `run-ids.json`, the last id any
  worktree used, taken under its lock, so new runs of different worktrees never share an id. A counter that cannot
  be read counts as 0 (the runs folder still gives the floor).
- *Answer keys outside the project.* `hunt-key.json`, `verify-key.json` and `recheck-key.json` are written to
  `$XDG_STATE_HOME/nunchi/<hash>/keys/<run>/` (an absolute `XDG_STATE_HOME` on any platform; else
  `%LOCALAPPDATA%\nunchi\…` on Windows; else `~/.local/state/nunchi/…`), files 0600 in 0700 folders. `<hash>` is the
  first 16 hex of the SHA-256 of the real path of the folder holding the run (one worktree's `.nunchi/runs`, or the
  parent of an `--out` folder): run ids are numbered per worktree, so the design's per-repository folder is made per
  runs folder. A hunt or verify key an older nunchi left inside the run is read once, written outside and removed
  from the run, **without** any verdicts it holds (`recorded`, `earlier`): a file in the project can say anything. A
  re-check key came after keys moved out, so one inside the project is never read. Every folder from the state base
  (`…/nunchi`) down to the key is nunchi's own: a symbolic link among them is refused (`UNSAFE_PATH`), never written
  through. `gc` removes the keys of the runs it removes. The fold reads keys without moving anything (`peekKey`).
- *M2 deny hook (notes, 2026-10-14 KST; built 2026-10-15 KST, §7.2).* What an agent in the project must not read or write once M2 adds the hook:
  the answer keys' folder (`$XDG_STATE_HOME/nunchi/**`, or its Windows and home fallbacks), whose path the CLI
  prints to the agent ("the answer key is kept outside the project (…)") — the hook must deny that folder by path,
  since printing it tells the agent where it is; and the shared state, `<git-common-dir>/nunchi/**` (ledger,
  approvals, run-id counter, generation), not only `.nunchi/state`. The hook (§7.2) denies both, by path, in Claude
  Code.
- *Run files* written after a capture (hunt, verify, canaries, re-check) take the run's own lock (§2.4).

**Schema 2** (`ledger.json`, migrated on read; the next ledger command writes it back with `rev`).
- `folds[]` replaces the bare run list as the record of what was folded: `{run, source, key, stream, kind?}`.
  `source` is `rule` (a capture's findings), `ai` (its verified AI findings) or `recheck` (a re-check's verdicts);
  `fix` (since M3: a fix probe folded for its own group, §6.5). `key` is a hash of the fold's inputs. `stream` is the
  worktree whose run it was (`main` or
  `wt:<name>`): run ids are per worktree, so a run of another worktree with the same id is folded, never mistaken
  for one already folded. `runs` stays the sorted list of runs folded as captures, every worktree's. A schema-1
  ledger becomes schema 2 with one `rule` fold per run (`key: null`, its stream) and `source: "rule"` on every item;
  nothing else changes.
- *Streams* (review of PR #28, 2026-10-14 KST). Every item says the stream (worktree) that last saw it (`stream`; an
  item without one is `main`'s), and each stream's capture runs are its own (`captureRuns`; a run in `runs` that no
  fold records is `main`'s):
  - the watermark is per stream: a run older than its own stream's newest folded run is presence-only (§5); another
    worktree's newer run does not make this one's runs old;
  - only the stream that last saw an item can say it is gone (rule items in the sweep, AI items in the re-check):
    worktrees on two branches would otherwise fix and bring back each other's items in turn. A sighting from another
    stream still counts (it moves `lastSeen`, makes a fixed item come back, and makes that stream the item's);
  - *not looked at for 3 runs* counts the runs of the item's own stream;
  - `findings` names this worktree's latest run in its header ("run 0001 · …"), and the review page's "latest run"
    is this worktree's: a page of this worktree's latest run reads AI rows from the ledger even when another
    worktree captured since.
- *Kinds* (`run.json` `kind`): only a `sweep` folds as one. A `quick` run is presence-only (adds and brings back,
  never fixes). A `fix-probe`, or a kind this nunchi does not know, is recorded in `folds` and not folded: the fix
  loop folds a probe for its own group (§6.5). A run without `kind` is a sweep. Every worktree's `capture` is a sweep
  (as a branch switch in one folder is); the fix loop's captures are probes (M3).
- *Re-folding.* A `(run, source)` folded again with the same key changes nothing; with another key an `ai` or
  `recheck` fold replaces exactly what that run contributed (a re-verify, a re-recorded re-check). A `rule` fold is
  never redone: a complete run's findings do not change, and a different key would mean the run folder was edited;
  the first fold stands.
- *Catch-up.* Every ledger command folds, for this worktree's runs: the complete runs not folded yet (rule), then
  every run that was hunted (`ai-findings.json` or `coverage.json`) and is not folded or changed since (`ai`; its
  key hashes `ai-findings.json`, `coverage.json`, `source-hashes.json` and the verify key), then every re-check whose
  verdicts the re-check key records (`recheck`; keyed by the key file). `hunt --record`, `verify --record` and
  `recheck --record` fold through the same path.

**AI items** (`source: "ai"`). They keep what each fold contributed, `hunts` (per hunt: the verdict its verifier gave,
the claimed and corrected severities, the cells and the screens' hashes, element and box; or `silent`: the hunt saw a
cell of the item, same lens, and did not claim it) and `rechecks` (per re-check, its verdict per cell); everything
else is derived from those, the same whatever order the folds come in:
- *What enters.* Only an `(run, "ai")` fold of a run with an id and of kind sweep, from its `ai-findings.json` and
  `coverage.json`, with statuses, severities, verifier and `suspect` **from the verify key's recorded verdicts only**
  (§4 M1; a status the key does not back is `claimed`; `verify.json` is never read). Canary copies are left out.
  Grounding is checked again against the run (a hand-written `ai-findings.json` cannot skip `hunt --record`): the
  scene is a captured screen of the run (not redirected, not an error page), route and viewport are that scene's,
  the lens and checklist item agree, the severity is one of the four, the selector is in the scene's evidence (or an
  `aria.yml` node), and a `file:line` passes the check `hunt --record` makes (`checkSource`: a file of the app under
  the root, not `.nunchi`, dependencies or git, the line inside the file; a name the source map knows is not
  enough). A claim grounded in a file line only must name a line that is not blank (`source-line-blank`; `hunt
  --record` refuses it as `source-not-found`): a blank line cannot tell two defects of the file apart. At least one
  ground. *Since the review (2026-10-14 KST):* `hunt --record` folds the hunt at once — its claims as `claimed`
  (shown collapsed, not double-checked, until `verify --record` replaces the fold) and the cells it saw — so a hunt
  that claims nothing still makes the items it saw and did not claim older (staleness), and a sighting is never
  taken for silence.
- *Fingerprint* (design §2.3; recipe `AI_RECIPE` 1, gated on `source: "ai"`, so no rule fingerprint moves and
  `fingerprintVersion` stays 2): lens + checklist item + route + `{element, file, anchor, name}` — the canonical
  element, the grounded file, the grounded line's hash and the element's accessible name (digits and spaces
  normalised). The claim's words, the hunt unit, the reference screen, the line number and the severity are not in
  it: two hunts with a different reference scene, other words and the line moved by 3 give one fingerprint (contract
  test). The identity is computed from the run again at the fold; the anchor is taken from the hunt (it hashed the
  source the hunter read, and a later edit must not re-key the item), and so is the canonical element when it still
  fits (the cited selector itself, or for an `aria=` node one of the scene's controls of that name), so the
  fingerprint does not move with how the fold canonicalises.
  - *Neither merging nor splitting* (review of PR #28, 2026-10-14 KST): `name` keeps two controls apart whose
    selectors normalise alike (`li:nth-of-type(1) > button` "Delete" and `li:nth-of-type(2) > button` "Archive");
    the anchor hashes the line with all whitespace removed (a reformat keeps it) plus, when the same text stands on
    several lines of the file (`return (`), which occurrence it is; an `aria=` node is the first control in document
    order with that name (and role, when that narrows it), so a second control of the name added further down does
    not move it — the design's "exactly one control" made one item two whenever a second appeared.
- *Group:* lens + checklist item + component: the grounded file, else the one inventory file of the route whose
  strings hold the element's accessible name exactly, plus that name (digits and spaces normalised). The inventory
  records no symbols, so the design's "file and symbol" is file and name. When neither is known the group is the
  fingerprint, so one dismissal never covers every similar button.
- *Exists* while some hunt claims it as `confirmed` or `claimed`; `rejected` and `insufficient` never make an item
  (they stay in `ai-findings.json`). A claim counts as seen unless a verifier that was not suspect rejected it.
- *Verification* (`{status, by, vendor?, suspect, tooFewDecoys?, run, at?}`): the latest verdict that was not suspect
  and not from a run with too few decoys (§4), else the latest other one, else `claimed`. A human decision is above all of them (the view, §5). A later verdict that was
  not suspect and says rejected or insufficient stays on the item (shown not double-checked) rather than hiding it.
- *Severity:* displayed = the severity a confirming verifier gave, else the claimed one; protection (`protect`, what
  blocker/L9 rules and `seriousTarget` use) = the most severe any present claim or verdict gave, so a verifier that
  lowers a blocker does not let a git dismissal hide it.
- *Group decisions* (view): one covers an AI item only when the item is double-checked (confirmed, not suspect, not
  from a run with too few decoys) or
  the decision came after its latest verification (`verification.at`, when that verdict was folded; a claimed-only
  item has none, and a verification from a run with too few decoys counts as none either, since it is no double-check:
  M3, 2026-10-15 KST); on a blocker or L9 item never a fingerprint first folded after the decision (`addedAt`). Otherwise
  the row's `note` says why. A decision on the fingerprint applies as for rule items.
- *Fixed* only from a re-check (§4.1): a capture's silence never fixes an AI item, and the rule fold never touches
  one. `lastSeen` moves with a claim, a `still-there` or an `unchanged`; `lookedAt` is the last hunt or re-check.
- *Stale:* after 2 hunts later than its last sighting that saw one of its cells (same lens) and did not claim it,
  an open item's status is `stale` (shown apart; still decidable; not re-checked unless decided *fix*). A claim
  makes it open again. `lastHunted` and `silentHunts` are on the item.
- *Needs you:* a re-check that said `insufficient` and nothing still there (`needsYou: {reason, run}`).
- *Not done yet:* a different vendor's verifier labelled `cross-vendor` on items (recorded as `by`, M6 for several
  agents); a lock per person for recordings (their saves are atomic since M1a). (the board's live view of `generation` came with M2.)
- *Answers name `evidence.file` (M3, 2026-10-15 KST, design §2.5).* A hunter grounds a defect in the source with
  `"evidence": {"file": "app/tasks.tsx", "line": 2}`, the shape recorded findings and fix records already carry
  (`source` on a finding means `rule` or `ai`). An answer written before says `"source": "app/tasks.tsx:2"`: it is read
  the same way and gives the same record (a test pins it); a defect that gives both, an `evidence` that is not
  `{file, line}`, or an unknown key in it is refused (`bad-shape`), and a file or line that does not check out is
  `source-not-found` as before. The skill, the gate's hunter brief (bench/ai-gate.mjs) and the tests use the new
  shape.
- *Measured (2026-10-14 21:24 KST, after M1):* Pebble `node bench/run.mjs --twice` is unchanged: rule recall 34/34,
  0 false positives on 8 clean scenes, determinism identical (1,140 files), fingerprints 100% (52/52), 152 s per
  capture. Rule fingerprints do not move (the AI recipe is gated on `source: "ai"`).

## 6. Fix loop (0.1-c)

1. Fix by root cause, in the shared function or component.
2. Refuse to start on a dirty working tree.
3. One root cause = one commit. Before committing: the user's build, typecheck, lint and tests pass.
4. Re-capture the scenes and their neighbours (source map) with replay. Gone = fixed. New finding nearby =
   *caused regression*, fix reverted to *fix*. Visual change outside the finding's box → human.
5. The agent saying "fixed" changes nothing; only re-capture does.
6. Guard: on a second occurrence of a kind, or ≥5 instances, propose a rule (e.g. no `*.message` in JSX or
   toast arguments, no `window.confirm`, no `href="#"`, `stylelint-declaration-strict-value` for tokens,
   `toMatchAriaSnapshot` for structure). Added to the user's repo only with consent. (M4, not built.)

Built in M3 (2026-10-15 KST, design 0.1-c §4 and §7 minimal) as `nunchi fix`, in `src/fix/`. The engine never edits
code: the skill edits; the engine plans, checks preconditions, runs the checks, captures and judges. An outcome comes
only from the engine's probes.

### 6.1 Commands and the chat side

- `fix --plan` lists the groups decided Fix (most serious first) with their root-cause files, attempts used, and
  what holds one back (a decision that came through git and needs `approve`, an AI item nobody double-checked, a
  group with no route to re-check: "fix by hand"); the branch ("Fixes go on branch nunchi/fixes-1015; merge it when
  you're happy."); the checks and whether they are approved (when not, it asks the board: `state/checks-request.json`);
  on a dirty tree the one choice: commit as "WIP before nunchi fixes" (recommended), stash, or stop. It writes
  `state/fix-plan.json` (the batch `--summary` reports). The skill shows the plan as one consent (U19).
- `fix --start <group> [--url <base> | --serve dev|start] [--agent <name>] [--vendor <name>]` → branch, claim, recording
  snapshot, baseline checks, P0, then the **fix brief**. `--brief <group>` prints it again.
- `fix --checks <group>` runs the approved checks on the working tree, compares them with the baseline and prints the
  commit trailers (`Nunchi-Fix: <group>`, `Nunchi-Attempt: <n>`, `Nunchi-Decision: <decision id>`).
- `fix --verify <group>` checks the commit and the diff policy, captures P1 and judges. For AI items it writes
  `recheck-packets.json` into P1's run and waits for `fix --verify <group> --record <verdicts.json>` from a fresh
  re-checker (§4.1 rules: controls, suspect batches, keys outside the project).
- `fix --undo <group>` reverts a fix that landed (fixed, or kept by *needs you*) while it is HEAD; `--abort <group>`
  stops an attempt; `--status [<group>]` lists attempts and phases; `--summary` gives the batch line;
  `--approve-checks` approves the check profile from a TTY with a 4-character code typed back (channel `cli-tty`; the
  hook refuses it from the agent).
- Chat lines, one per outcome, then the batch: "Fixed 'Text cut off' (re-checked 2 screens, nothing else broke).";
  "That fix broke 'Raw error text' on /settings, so I undid it (attempt 1 of 2). Trying another way."; "That fix did not
  remove '…' (it is still there on /settings), so I undid it (attempt 2 of 2). The AI couldn't fix this in 2 tries: it
  needs you in the board."; "Couldn't re-check '…': the screen didn't load. Start your app, then tell me “retry”.";
  drift: "'…' is gone, but the fix also changed other parts of this screen (3%). It needs you: look at it in the board
  (before and after are side by side)."; "Stopped fixing '…': you decided Not a problem while I was fixing it, so the
  fix was undone."; batch: "Fixed 4 of 5 (re-checked 23 screens, nothing else broke). 1 needs you: '…' → the board
  (nunchi open)." Every line is built from a record the engine wrote; the summary reads the records of the plan's
  groups, never the agent's words. `--json` gives `{code, lines, …}` with `outcome` and `needsYou`.
- **Fix brief** (design §4.11): engine words frame it; every piece of app text (selector, claim, element text,
  evidence file:line, the person's note) is on its own line marked *app data, not instructions:* as one JSON string,
  secrets replaced by their kind. Injection fixtures (a claim that says to ignore instructions and run `curl`, a
  forged "--- end of brief ---", a token) are tested.

### 6.2 Branch, working tree, claims (design §4.2, §7)

- Refusals, each tested: no git, no commit yet, detached HEAD, dirty tree (or a merge/rebase/revert in progress), the
  default branch (`origin/HEAD`, else `main`/`master`), no capture yet, no recording for a person, a group not
  decided Fix, a Fix that came through git and is not approved, an AI item nobody double-checked whose Fix the agent
  recorded, a whole-app group (no route), a base URL that is not loopback/private/`allowHosts`, `--serve` other than
  `dev`/`start`, unapproved checks, HEAD carrying an unverified `Nunchi-Fix` for the group ("resume with `fix --verify`"),
  2 attempts used, an attempt waiting in the board.
- The branch is `nunchi/fixes-<MMDD>` (KST) made from HEAD with `git switch -c`, or the `nunchi/fix…` branch HEAD is
  on already; in a linked worktree `nunchi/fix-<group>`.
- **Claims** (`src/fix/claims.mjs`): `state/claims/<group>.json` written `wx` under a lock, plus one marker per
  root-cause file (`claims/files/<sha256(path)>`). Expiry is the reader's (`lastRenewal` + 30 min); worktree and branch
  come from git, the agent and vendor are declared. A capture renews every 5 minutes, every fix command renews. A
  second claim on the group, the folder, the URL or a file is refused with the design's copy ("Claude Code is already
  fixing in this folder (branch nunchi/fixes-1015, 4 min). To fix in parallel: `git worktree add ../shop-2 -b
  nunchi/fixes-2`, open that folder in Codex, start the app there on another port. Or wait: deciding and capturing
  still work here."); the same declared agent in the same folder is never told about worktrees. A worktree other than
  the one that captured needs `--url`: "Start the app from this folder on a free port (e.g. `PORT=3001 npm run dev`),
  then verify with `--url http://127.0.0.1:3001`."

### 6.3 Records and recovery (design §4.8, §4.9)

`state/fixes/<group>/<n>.json`, `n` allocated with `wx`. A `phase` is written before every side effect: starting →
claiming → branching → snapshot → baseline → p0 → started → checking → checked → committed → verifying → (recheck) →
judged; closing phases fixed, reverted, needs-you, cancelled, aborted, undone, through reverting, undoing and
folding. Every `fix` command first reconciles the group's latest record with HEAD, its trailers, revert commits and
the ledger, and resumes what a command that died left half done (a revert half done → `revert --abort`, *needs you*;
a fold half done → folded). Cancellation: a decision other than Fix during an open attempt reverts the fix commit when
it is HEAD (else *needs you*, the commit shown) and releases the claim. Claim expired or `--abort`: before a commit →
to fix again; after → *needs you* with the commit. The attempt count is the number of commits carrying the group's
`Nunchi-Fix` and its current `Nunchi-Decision` on any branch (`git log --all`), so it survives
lost state and works across worktrees; a new Fix decision (*Try again with a note…*) starts a new count.

### 6.4 Checks (design §4.3)

- The check profile (`src/checks.mjs`): the exact `build`, `typecheck`, `lint`, `test` lines and their `pre*`/`post*`
  lines, the `dev`/`start` lines `--serve` may run, the sha256 of `.npmrc`, `.yarnrc*`, `.yarnrc.yml` (and its
  `yarnPath` target), `bunfig.toml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, and `packageManager`. Approved only through
  the board or `cli-tty` into `state/scripts-approved.json`; any change has another hash and asks again.
- Running, verified on this machine (2026-10-15 KST): npm 10.9.4 `npm run --ignore-scripts <name>` runs the line only;
  pnpm 10.28.0 `pnpm --config.enable-pre-post-scripts=false run <name>` runs the line only (pnpm has no
  `run --ignore-scripts`: it errors); yarn 1.22.22 and bun 1.4.2 run `pre`/`post` whatever flag is given, so a check
  with a pre or post line is refused there and said plainly; yarn 2+ runs none. `shell: false` (on Windows the
  manager's `.cmd` shim through `cmd.exe /d /s /c`, the script name checked to be a plain word); environment
  `PATH, HOME, LANG, TERM, CI=1, NODE_ENV=test` and corepack's `COREPACK_ENABLE_AUTO_PIN=0`,
  `COREPACK_ENABLE_NETWORK=0`, `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (Windows adds `SystemRoot`, `PATHEXT`, `COMSPEC`,
  `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`); a missing manager binary is refused; 10 minutes, then the
  process tree is killed; output loses colour codes and passes the secret scanner before it is stored or printed.
- Baseline at `--start`; a check blocks only when it newly fails or its count rises: "lint was already failing before
  this fix (40 problems) — not blocking; still 40 after."; "no test script — nunchi relies on re-capture."
- `--checks` records the tree hash it ran on (refusing when the checks themselves changed files); `--verify` requires
  a passing record whose tree equals the commit's.

### 6.5 Probes, judging and the diff policy (design §4.4–§4.7)

- **P0** at `--start`: the group's routes plus the routes rendering its root-cause files; each route as every person
  the sweep saw it as (a visitor the sweep saw redirected to the login page is no screen of a signed-in route, so no
  failed screen of a probe either; found by the harness run, §6.7), both viewports, the baseline's states; strict replay from a snapshot of each person's recording copied into the attempt's folder
  (`<n>-har/`, sha256 in the record); PNG first views (`top.png`); whole-app detectors off; `run.json` `kind:
  fix-probe`. A P0 that failed a screen, has a health problem or replay misses aborts the start; a P0 that no longer
  shows the defect too ("it may be fixed already").
- **P1** at `--verify`, identical options, scope P0's plus `affectedRoutes(diff base..HEAD)`.
- **Proof of the served code**: `--serve dev|start` starts the approved script from this folder on a port nobody
  listened on (`PORT`, plus `--port`/`--hostname 127.0.0.1` for next, vite and similar), or with `--url` a probe file
  is written into `public/` or `static/`, fetched back and removed. Without proof the outcome is *needs you (c)*.
- Probe runs are never `latest`, are hidden from `runs` (`runs --all` lists them), are recorded in the ledger's folds
  and folded only by the fix loop: only the group's fingerprints, only on `fixed` (source `fix`); discarded on revert;
  `gc` removes probes first and keeps those of an open attempt.
- **Judging** (`src/fix/judge.mjs`), by precedence: 1 inconclusive → *needs you (c)* (a screen failed or redirected, a
  health problem, replay misses, no proof); 2 caused-regression (a new defect by `(rule, cell, element identity)` in
  P0's scope; identity = normalised selector, or the same tag and accessible name with IoU ≥ 0.5; flaky rules
  `layout-shift`, `font-not-loaded`, `page-error` re-captured once first) → revert, attempt counted; 3 not-fixed (the
  defect matched in any cell; an AI item still there in the re-check) → revert, attempt counted; 4 visual drift →
  *needs you (a)*, commit kept (outside the group's boxes a control moved more than 2 px, appeared or went, or more than
  1% of first-view pixels differ by pixelmatch's YIQ distance, threshold 0.1); 5 fixed (for AI items a non-suspect
  re-check from a fresh context; too few controls is suspect). A new finding on a route only P1 has → *needs you*
  (no baseline), never a revert. After 2 attempts → *needs you (b)*.
- **Diff policy** (`src/fix/policy.mjs`), on `git diff --name-only base HEAD`: *needs you* when a path is `.nunchi/**`,
  `package.json`, a lockfile, `.npmrc`, `.yarnrc*`, `.env*`, `.github/**`, `.husky/**`, `.git*` or `*.config.*`; when
  the diff adds an import of a package the project does not depend on (tsconfig path aliases are not packages), a
  `<script`, or an outbound URL literal; or when it touches a file outside the root-cause files and the source-map files
  of the group's routes. The flagged paths are printed with the diffstat. Root-cause files: the grounded
  `evidence.file` (AI), else inventory files whose strings match the finding's text or element name, else the route's
  page file; never a layout or frame file (layout, template, loading, error, not-found, `_app`, `_document`, a TanStack
  root, middleware).
- **Git** (`src/fix/git.mjs`): every call through the hardened runner (`core.fsmonitor`, `core.hooksPath`,
  `diff.external`, the pager and filter drivers off as `GIT_CONFIG_COUNT` overrides, `--no-optional-locks`, no system
  config, `GIT_TERMINAL_PROMPT=0`, the caller's `GIT_*` dropped, a timeout; `--no-ext-diff --no-textconv` on diffs). The
  commit check is `rev-list --parents -n1 HEAD` = `[HEAD, base]`, the `Nunchi-Fix` trailer and a clean tree (`.nunchi/`
  aside). A revert only when HEAD is the fix commit: `revert --no-commit`, a commit with `Nunchi-Revert: <group> attempt
  <n>`, hooks off, 60 s; any failure → `revert --abort` and *needs you*; a required signing that fails → *needs you*,
  never unsigned. Never push, reset or force.

### 6.6 The board's side (design §3.4)

A live claim shows "Claude Code is fixing · 4 min" on the group, and deciding against it asks first. *Needs you* has
the three kinds with their actions: (a) "The fix also changed other parts of this screen (3%). Is that OK?" with
[Looks fine, mark fixed] [Undo this fix] [Try again with a note…], and before/after side by side with a slider
(←/→ in steps of 5, both viewports); (b) "The AI couldn’t fix this in 2 tries." with [Try again with a note…] [Keep]
[Later]; (c) "Couldn’t re-check: the screen didn’t load. Start your app, then tell your AI “retry”." *Looks fine*
(`POST /api/fix-accept`) marks fixed only an attempt that is (a) with the defect gone, and folds it as a fix. [Undo
this fix] and a landed fix show the sentence to tell the AI: "undo the fix of “Text cut off” (nunchi fix --undo
<group>)". *Try again with a note…* records a new Fix decision whose note the next brief quotes as app data. The
verdict counts a group waiting in a fix record as *needs you*.

### 6.7 Measured and limits

- Tests: every outcome row, refusal and recovery path above on synthetic git repositories in temp folders with a fake
  capture (`test/fix-*.test.mjs`), plus one end-to-end run with real Chromium and real git, and the board's fix states
  in Chromium with axe.
- The gate harness `bench/fix-gate.mjs` runs the loop on Pebble with recorded fixes (`bench/fixes/pebble.json`); a
  harness run is not the gate (design §9.4, pre-registered apart).
- Limits: the drift threshold (1%) is not calibrated yet (the gate does that); `--serve start` serves the build in
  the folder, which matches the commit only when `build` is one of the checks; the other *needs you* kinds (diff
  policy, no baseline, an interrupted or half-done revert) show in the verdict and `fix --status` with their line but
  have no card of their own in the board yet; guards (principle 6) are M4.

## 7. Progress board and exports (0.1-c)

Local server (`nunchi open`, built in M2: §7.2) that watches the ledger and redraws live. Views: progress · findings board ·
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

### 7.1 `nunchi export --html` (built 2026-10-14 KST)

A static review page of one run plus the ledger, the read-only precursor of the board (`src/export-html.mjs`).
`nunchi export --html <dir> [--run <id>] [--inline] [--json]` writes `<dir>/index.html` and `<dir>/img/<sha256 of the
bytes, 16 hex>.jpg` (each scene's `full.jpg`, copied byte for byte, so identical screens share one file); `--inline`
puts the images in `index.html` as data URIs instead (one file; pegroom: 8 MB against 6.1 MB linked).
- *Output folder* (hardened after review, 2026-10-14 KST): nothing is replaced that an export did not write.
  `img/.nunchi-export` lists the images written there, and a re-export removes only those. An `img/` with other
  files and no list, an `index.html` without the `<meta name="generator" content="nunchi export --html">` marker,
  and a symlinked `index.html` or `img/` are all refused before anything changes. `index.html` is written to a new
  file and renamed into place. A folder inside `.nunchi/runs` or inside the run is refused, checked on the real path
  of its nearest existing parent (so a symlink cannot get round it), case-insensitively on Windows and macOS.
  A `--html` value starting with `--` is a missing value.
- *Views* (mock-up v3 layout, system fonts): **Progress** (verdict as in design §3.4 where it can be computed
  statically: blocker/high open → "Not yet · …", no AI review → "Probably · rules only", screens not seen → "Yes, for
  what was checked · …"; open groups by severity; new, fixed and came back since the parent run; screens checked; AI
  review; counts per decision). **Findings** (one section per kind, worst first, low collapsed; a row per group with
  where, source and status; status tabs Open · To fix · Later · Kept · Not a problem · Fixed · All; AI claims not
  double-checked in a last collapsed section). **Finding detail** (the screenshot cropped to the boxes plus ~200 px,
  at least one first view high, with Desktop/Phone when both exist and "Whole screen"; code file:line when the
  finding has one; seen on; decision; evidence details collapsed; the four `nunchi decide <group> …` commands with
  Copy, never buttons that do nothing). **Screens** (every non-canary scene as a card with a badge — "2 high · 1
  medium", "Clean", "Nothing open", "Sent to sign-in", "Redirected", "Not seen" — filtered by width, who and state;
  a selected screen shows large with numbered dashed boxes and its findings).
- *Data*: the run's `manifest.json`, `run.json`, `findings.json`, `flow.json` (wall order), `measure.json` (the h1 as
  a screen name), `ai-findings.json` (confirmed and claimed only), `verify.json` and `coverage.json`. The ledger is
  read through its own functions: the CLI brings it up to date first as `findings` does (`syncLedger`: runs not
  folded yet, decisions not noted yet; approvals bound to content), and statuses come from `view()`. The run's
  findings are named through the ledger's fingerprint aliases (a run captured before fingerprint v2 still meets its
  items). A run the ledger has not folded is folded in memory only, with current fingerprints. AI findings of this
  worktree's latest run come from the ledger once it folded the run's hunt or re-check (an `ai` or a `recheck` fold,
  M1, §5.1): a run that was only re-checked shows what the re-check fixed and what it found still there; otherwise,
  and for an older run, they are folded in memory the same way (`foldAi`). `view()` gets its `now` from the data (the latest decision
  date or first-seen time), never the clock. The page also says when an open group has not been looked at since run N
  (the ledger's `notLookedAt`), when the run could not tell what was fixed (`state.blind`), and when a screen left
  the app (`redirected-off-origin`: "Left the app", the other origin as text). A finding without a box takes its
  element's box from the scene's evidence (the hunt's selector index). Boxes are percentages of the screenshot (CSS
  px × the first view's pixel ratio); none is drawn for an element inside a scroll area (`inside`) or outside the
  image, and the page says why.
- *Determinism*: no clock or random value; ids are hashes of scene and group ids; every list sorted. Two exports of
  the same run, ledger and decisions are byte-identical (test, and pegroom: identical).
- *Redaction and escaping*: HAR, `network.json`, `console.json`, `text.txt` and `aria.yml` are never read. Every
  string that did not come from the exporter goes through one helper: credential query values and URL userinfo
  (`https://user:pass@`) are redacted (`redactText`), then secret shapes are replaced by `[secret-shaped: <kind>]`,
  then it is clipped, then HTML-escaped. `scrubSecrets` (`src/rules.mjs`) is the one scrubber for capture and export
  alike: whole private key blocks of every kind, Stripe secret and restricted keys, AWS access key ids and secret keys,
  GitHub, Slack, Google, Anthropic and OpenAI keys, `Authorization:` values after a scheme (`Basic`, `Bearer`, `Token`,
  `Digest`, `Negotiate`: any value, a digitless base64 `user:password` included) or holding a digit, `Bearer` values
  that hold a digit, cookie headers with a `name=value` pair (`Cookie:`, `Set-Cookie:`, `document.cookie =`: the whole
  value, `cookie`), headers named like a key or token (`x-api-key`, `api_key`, `apiKey`, `X-Auth-Token`,
  `x-csrf-token`, `private-token`, `client_secret` …: a value with a digit or of 20+ characters, `api-key`), a URL path
  segment of 24+ characters mixing lower case, upper case and digits or of 32+ hex digits (`url-path-token`; review of
  PR #29, 2026-10-15 KST; *known limit:* redaction is by pattern, so a token that is only a path segment and does not
  have that shape, shorter, one case, or words joined by `-`, is shown as it is), any JWT (also
  split across lines), each after no letter or digit; `selector-secrets.mjs` runs it first and then the same kinds
  with no boundary at all, plus `long-token`. It is wider than the L9 bundle scan, which it does not change. Objects
  and arrays are redacted leaf by leaf before they are serialised. URLs are never links; secret findings show
  location and kind only. Run files are data too: severities, statuses and viewports are checked against their
  enums, group and fingerprint ids must be 12 hex (others are hashed), counts are numbers, boxes four numbers, and a
  scene id that is not one plain path segment is left out and never opened (`sceneDir`, shared with the hunt).
  Screenshots are CSS backgrounds, so the page has no `<img>`. CSP (meta): `default-src 'none'; img-src 'self' data:;
  style-src 'unsafe-inline'; script-src 'sha256-…'; base-uri 'none'; form-action 'none'` — the one inline script
  (current view, Copy buttons) is allowed by its hash, and the page works without it (views are `:target`
  sections, filters are radio buttons with `:has()`).
- *Older runs*: `--run <id>` of a run that is not the ledger's latest shows the ledger as it stood after that run,
  folded again from the run folders up to it as the ledger folds them (`runForFold`, `foldRun`, `migrateState`); when
  one of them is gone or unreadable, the current ledger is rewound instead (fixed, came back or looked at later →
  undone) and the page says statuses are as of now. Decisions are always as of now.
- *Accessibility*: nav, main and aside landmarks, a skip link, visible focus, 44 px primary targets, severity as
  text beside its dot, filters as native radio groups, `prefers-color-scheme` honoured; 360 px to wide desktop.
- *Not done*: page text is shown (claims, evidence text) — the `--include-page-text` default of design §5 applies to
  md/json/sarif, and screenshots carry the same text anyway; no per-run trend; no cropping or downscaling of the
  images; the verdict does not check "last full check newer than the last fix commit" (not built in M3 either: §10).
  Publishing the page (e.g. as an Artifact) is the skill's job, only with the user's explicit OK, since it sends the
  screenshots off the machine.

### 7.2 `nunchi open`: the live board (built 2026-10-15 KST, design 0.1-c §3, §1, §9.2, M2)

The live version of §7.1's page, where the person decides (`src/board/`). The look, the strings table and the
screenshot geometry are the export's: one stylesheet (`src/board/look.mjs`, inlined by the export, served by the
board), one pure module for words, keys, crop and box geometry and the decision clock (`src/board/shared.mjs`,
imported by the engine and served to the page). The export's bytes did not change in M2, until the review of PR #29
(2026-10-15 KST) moved rules into the shared stylesheet on purpose (Deviations, below). The page builds its DOM from
data with `textContent` only (no markup is ever parsed from data; a test checks the script has no `innerHTML`), so
the export's string renderers cannot be reused as they are; what is shared is the view model's inputs, the words,
the geometry and the CSS classes.

**Process (§3.1).** `nunchi open [--no-browser] [--stop] [--label [--labeller <name>]] [--port <n>]` starts
`src/board/server.mjs` detached and returns at once. The server writes `state/boards/<pid>.json` (pid, port, mode,
project, control socket: never a key) and listens on a control socket (Unix: `state/boards/<pid>.sock`, or a 0700
folder of this user in the temp folder when that path is too long; Windows: a named pipe), mode 0600, that answers
`ping`, `open` (the server opens the browser itself with a fresh link) and `stop`, and never returns a link or a
key. A second `nunchi open` pings this project's records (a record whose board does not answer is removed) and reuses
a live board of the same mode; the check and the start run under a lock (`state/boards/launch.lock.d`, the state's
lock, waited for without blocking), so two `nunchi open` at once start one board. A running board keeps its port: a
`--port` that differs is ignored, and said ("--port N is ignored: the running board keeps port M"). The board stops after 2 hours without a request (the live stream and the polling
fallback do not count), telling an open tab. The link is printed only when stdin and stdout are the person's
terminal and no browser is opened (`--no-browser`); run by an agent, the output is `board open on 127.0.0.1:<port>`
and nothing secret. The server never writes a link to its stdout (which carries `{"port"}` only): `nunchi open`
hands it an extra pipe as fd 3 and asks for the link with `--link-to-parent`, and the link goes over that pipe (a
file or terminal on fd 3 gets nothing). Started any other way, the server hands out no link: it opens the browser
itself, or nothing (tested by running the script directly). The browser opener is an absolute path from a fixed
list (`/usr/bin/xdg-open`, `/usr/local/bin/xdg-open`, `/bin/xdg-open`, `/run/current-system/sw/bin/xdg-open`;
`/usr/bin/open`; `C:\Windows\System32\cmd.exe /d /s /c start`), never PATH, `$BROWSER` or `ComSpec`, given only a URL
that matches a board link, with an allow-listed environment: the desktop session's `DISPLAY`, `WAYLAND_DISPLAY`,
`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR` and `XDG_CURRENT_DESKTOP` (macOS `TMPDIR`; Windows `SystemRoot`,
`windir`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, `PATHEXT`), `HOME` from the account (not the
variable) and a fixed system `PATH`. The detached server gets an allow-listed environment too (PATH and the user's
config for git, `XDG_STATE_HOME` / `LOCALAPPDATA` for the answer keys, locale, temp folders, the desktop session):
never `NODE_*`, `LD_*`, `DYLD_*`, `BROWSER` or `GIT_*` (tested on `/proc/<pid>/environ`). Its working folder is the
OS temp folder (this user's on Windows; `launch.mjs` `serverCwd`), never the project or its state, which sit in the
project's `.git` or `.nunchi` (on Windows a process inside a folder keeps it from being removed or renamed: a
worktree, a checkout); git's user name is read in the project. A running board still watches the state folder (not
recursively), which can keep the project from being renamed or removed on Windows while it runs: `nunchi open
--stop` stops it and releases the folder (as does its 2-hour idle stop). The hook's
matcher keeps `NotebookRead`: matching a tool that a newer Claude Code no longer has costs nothing, and an older one
still has it.

**Security (§3.2; `test/board-security.test.mjs` has a test per check).**
- *Bind* 127.0.0.1 only. *Host* must be exactly `127.0.0.1:<port>`, or 421 (also without a Host header: node's own
  400 is switched off so the refusal carries the headers).
- *Key* (safer than the design, see below): the link carries a **one-time launch code** in its fragment
  (`/#t=<64 hex>`, valid 2 minutes, spent on first use); the page trades it (`POST /api/session`) for a **per-tab key**
  of 32 random bytes and drops the fragment (`history.replaceState`). Keys and codes live in the server's memory only:
  not in a file, an argument, an environment variable or a cookie (tested on the detached process's
  `/proc/<pid>/cmdline` and `environ`). Every request sends `X-Nunchi-Token`, compared as
  `timingSafeEqual(sha256(a), sha256(b))`; a cookie or query parameter never counts. A reloaded tab has no key and
  says to run `nunchi open` again (the key is never stored, `sessionStorage` included).
- Only the page shell answers without a key: `/`, `/assets/board.js`, `/assets/shared.mjs`, `/assets/board.css`,
  bundled files with no data of the project (tested), and `/favicon.ico` (204, empty). Screenshots are fetched with
  the key and shown as blob URLs.
- *Requests:* `Sec-Fetch-Site`, when sent, must be `same-origin` or `none` (403); `req.url` must start with `/` (400)
  and be ≤ 2048 characters (414); GET and POST only, OPTIONS 405; a GET has no body (413, by Content-Length or any
  Transfer-Encoding, the page shell included); writes need `Content-Type: application/json` (415), `Origin` equal to
  `http://127.0.0.1:<port>` (403) and a body ≤ 64 KB (413,
  by Content-Length or while streaming); the link trade (`POST /api/session`) reads at most 1 KB, so a long body is
  refused before its code is looked at. At most 64 connections at once (`server.maxConnections`; the page needs a
  handful); node closes one more. No CORS header on any response.
- *Headers* on every response, refusals included: the CSP of the design, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, CORP and COOP `same-origin`, `Cache-Control: no-store`, and a Permissions-Policy.
- *Files:* the bundled assets and `/evidence/<run>/<scene>/<full.jpg|top.jpg>` only. The run must be a complete run
  of `.nunchi/runs` (not a partial folder), its folder no link and inside the real `.nunchi/runs`; the scene one the
  run's manifest names, not a canary copy, its folder no link; the file opened with `O_NOFOLLOW` (on Windows, which
  has none, refused when `lstat` says link), `fstat`-ed, read from that descriptor, served as `image/jpeg` only if
  it starts like a JPEG (415 otherwise). No listing, no SVG, nothing else.
- *Rate limits:* 30 wrong keys or links a minute, then a minute in which requests **without** a valid key get 429 (a
  valid key is never locked out, so another process cannot shut the person out); a request with no key at all (what
  the browser fetches by itself) is refused but not counted as a guess. Requests without a key have a budget of their
  own (60 per 10 s), so they never use up the person's: 600 requests and 60 writes per 10 s, counted only for
  requests with a valid key. The page shell is never limited or locked out (the same bytes for everyone). A link
  trade tries the code first, so a fresh link always works; failed trades are limited to 20 a minute and wait out the
  lockout. 8 live streams.
- *Strings:* every string the board's code did not write (app text, selectors, claims, decision `by` and `note`, lens
  text, URLs) is redacted (credential URL parts and query values, then secret shapes) and clipped on the server, and
  set with `textContent` on the page. Secret findings show location and kind only. App URLs are never links; the
  one link to a file is `vscode://file/<path>:<line>` for a file inside the project. [Copy path] copies the whole
  path (redacted, not the clipped one shown, at most 4096 characters); a path holding a control character (C0, C1,
  DEL, bidi marks and overrides, line separators, BOM) is shown with U+FFFD in their place and gets neither [Copy
  path] nor a link.
- *Offline:* no external script, style, font or image (tested on the assets, and in the browser test every request
  goes to the board or a blob of its own).

**API (§3.3), all with the key.** `GET /api/summary` (summary.mjs `summary()`, the same function `findings --json`
carries as `summary`; plus the latest run, the Now lines, confirmations, the check card, and whether the working
tree differs from the latest run's), `GET /api/groups?status=&lens=&q=&group=` (sections of group ids for the tab,
lens and plain substring asked, by `kind` | `file` | `screen` | `lens`; AI groups not double-checked in their own
sections; and every group of the ledger by id, so the page can update rows it shows whatever they match now),
`GET /api/groups/:id` (instances with their screen, box and whether it can be drawn; screens with evidence
addresses; evidence details; decisions on the group or its fingerprints with how each was made; code location),
`GET /api/screens` (the latest run's screens with the export's badges and numbered findings),
`GET /evidence/…`, `POST /api/decide`, `POST /api/undo`, `POST /api/confirm`, `POST /api/approve-checks`,
`GET /api/live`, and `GET /api/generation` (the polling fallback). Added to the design's table: `POST /api/session`,
`/api/screens`, `/api/generation`, `/api/undo`. In label mode only `/api/label/pool`, `/api/label/item/:id`, `POST /api/label`, the evidence and
the live endpoints answer (the others 404, so nothing unblinds).
- *Live updates:* the server watches the state folder (not recursively, 200 ms debounce) and polls every 3 s; what it
  compares is the generation **plus a signature of `.nunchi/decisions`** (names and times of its folders), because a
  decision that arrives through git bumps no generation, **plus the live claims** (group and agent of each claim
  not expired by the reader's clock), because a claim bumps none either and expires without a write; a cached model
  takes the claims as they are on each request (their minutes too). A change sends `event: generation` with the new version on
  every open stream (a `fetch` stream read with `ReadableStream`, SSE framing, a ping every 15 s); the page then
  reloads the summary and, in place, the list and detail it shows. A stream that fails or ends falls back to polling
  `/api/generation` every 3 s, and is tried again once the board answers (after 3 s of polling, doubling to 60 s while
  it cannot be opened). A request that gets no answer at all is retried with a growing wait (1, 2, 4, then 8 s;
  the first poll after a stream that ran and ended comes after 1 s), and the first miss shows "Reconnecting…" beside
  the run box, said once by the polite live region; only 4 in a row say "The board is not running" (about 8 s after a
  hard kill, against 36 s before the review of PR #29, round 2); an answer of any status (429, 503) means it is
  running and clears the status. Tested by closing the server and every connection under an open page. `nunchi decide` now bumps the generation after it writes the decision files too (the
  approvals' bump came before the files existed).
- The model (`src/board/model.mjs`) is ledger-wide, as `findings` sees it (`view()` through `project.mjs`), not one
  run: a partial latest run does not hide open items. Evidence comes from the run that last saw each item: a rule
  item's findings in that run (box from the finding or the scene's evidence index), an AI item's own record per cell.
  It is cached by version (the one read before the build, so a change that lands during a build makes the next
  request build again) and rebuilt on a change.

**Decisions (§3.4) and parity.** `POST /api/decide {targets, decision, reason, note?, ms?, confirmed?}` checks the ids
against the ledger as it is now (stale → 409), requires the reason the decision takes and refuses one it does not
(`reasonProblem`, the check `buildDecision` makes, so `nunchi decide x fix --reason intended` is refused too), then
writes through `project.mjs` `recordDecisions`, the function `nunchi decide` uses: the approval first (channel
`board`), then one decision file per target (a shared `batch` id when there are several, from `nunchi decide` too:
`project.mjs` `batchFor`), then the generation. A
group holding an AI finding nobody double-checked is decided on each of its fingerprints (`resolveTargets`, for the
CLI and the board alike), because a group decision does not cover such a finding (§2.2) and would count for none of
them; it stays one group for the questions and the decision time.
Parity is tested: the same decision from the CLI and the board gives files that differ only in id, time, author,
channel and the batch's id (both sides give a group decided on its fingerprints one batch), and the same status. The server asks for a confirmation (409 with the sentence; the page shows it
with Cancel focused) before a dismissal that includes a blocker (by protected severity), an L9 finding or more than
10 groups ("Mark 17 groups Not a problem? 2 are high."), before fixing an AI finding nobody double-checked ("This
hasn't been double-checked. Fix anyway?"), and before deciding against a live claim (the fix loop's
`claims/<group>.json`, §6.2, read with the reader-computed 30-minute expiry).
`POST /api/confirm {keys}` confirms the dismissals the agent recorded or that came through git, all at once (the keys
the summary lists; stale → 409). `POST /api/approve-checks {profile}` approves the check profile shown
(`src/checks.mjs`: the build, typecheck, lint and test lines and their pre/post lines, the package-manager config
hashes, `packageManager`) into `state/scripts-approved.json` with channel `board`; a changed profile has another
hash and asks again. The card appears when the fix loop asks
(`state/checks-request.json`, §6.4), and lists the `dev`/`start` lines `--serve` may run.

**Channels (design §1).** A decision file names the channel it was written by (`board`, `cli-tty`, `cli-agent`) and
its batch; `approved.json` keeps the channel per approval key (`channels`) and the keys a person confirmed in the
board (`confirmed`); a key approved before channels has none (`unknown`). The view gives each decision `channel`
(`git` when not approved here) and `human` (board or cli-tty, or confirmed). `nunchi decide` is `cli-tty` only when
stdin and stdout are TTYs and the person types back a 4-character code it shows (a wrong answer records nothing);
otherwise, or with `--from-chat`, `cli-agent`. `nunchi approve` records its channel the same way. A *keep* or *not a
problem* that no person made or confirmed is recorded and shown (`findings` still says kept / dismissed) but does
not clear the group from "Ready to ship" (the verdict says "N to confirm"; `findings` says so in a line). A *fix*
from the agent counts (design §1 table). `decide` takes the board's words `not-a-problem` and `later`.

**Interaction (§3.4).**
- *Verdict* (summary.mjs): "Too early to say · a capture is running" (a `.partial` run folder), "· nothing captured
  yet", "· this run had a problem"; then "Not yet · 1 blocker, 6 high: 4 to decide, 1 to confirm, 3 waiting for the AI,
  2 later" over blocker and high groups, each counted once by its most pressing reason (needs you, to decide, to
  confirm, not double-checked, verified by a suspect check, waiting for the AI, later); "Not yet · N fixes since the
  last full check: capture again" (commits with a `Nunchi-Fix:` trailer after the full check's commit, through the
  hardened git runner); "Probably · rules only — the AI review hasn't run"; "Yes, for what was checked · no full
  check yet" or "· N screens not checked" (a screen redirected to another page is not checked, here and in the
  counts, as in the export); "Yes".
- *Since last full check:* a full check is a sweep with `wholeApp`; the panel counts groups new, fixed and back after
  the previous full check, labelled "Since last full check (run 0007)" (that run), or "First full check (run N)".
- *Keys:* F, W, Shift+W, X, Shift+X, S, always with an explicit reason, read by their place on the keyboard and
  Shift (`code`, so they are the same on any layout, a Korean one included, and with Caps Lock on); `?` and `/` are
  the characters (`key`), wherever a layout puts them; after each decision a 6-second toast with the
  other reason and Undo (Z); Z writes `reopen` for the last decision or batch (as the design says; restoring an
  earlier decision would write the agent's dismissal back as the board's), and only while its toast shows. The page
  sends the ids of the decisions it made (`POST /api/undo {decisions}`); the server reopens exactly their targets (the
  fingerprints of a group decided on its fingerprints), only for decisions approved with channel `board`, and answers
  409 unless each target still shows that decision (decided again since, here, in the terminal or through git:
  nothing is undone). Buttons carry the permanent sub-labels, except in a window 420 px high or less (below).
- *Frozen list:* while Findings or Detail is open, order and members stay; rows take new statuses in place; a banner
  says "Updated: 2 new, 1 fixed · Show (R)". Decisions target group ids.
- *Batches:* group by kind (default), root-cause file (the grounded file of an AI item, else "No file known"),
  screen or lens; "Decide all N ▸" per section; Space toggles a row, Shift+J/K extends.
- *Not double-checked AI groups* sit in a collapsed last section with [Ask the AI to double-check], which shows the
  sentence to copy. One verified in a run with too few decoys (§4) is among them, tagged "AI · not double-checked
  (too few decoys to check the checker)"; Detail's Reviewer line and the Progress AI line say it too, never "suspect".
- *Default order:* severity → came back → new since the last full check → reach (screens) → rule before AI; sections
  follow the order of their first group.
- *Detail:* the crop of the box plus 200 px (at least a first view high), 0 for the whole screen, the white + dark
  dashed box, "Seen on N screens · [ / ] to flip", Desktop/Phone, the next two groups' screenshots preloaded,
  [Copy path] and the editor link, decisions with how each was made and [Reopen], J/K for the next and previous group.
- *Handoff:* "All decided. 6 to fix. Go back to your AI chat and say “fix them”." [Copy], under the verdict and on
  Findings, once nothing is left to decide (AI findings not double-checked wait for the AI first).
- *Fix states:* a live claim shows "<agent> is fixing · N min"; *needs you* from a re-check that could not tell
  ("Look at the screen, then decide; or tell your AI “re-check it”"). The fix loop's kinds (a), (b) and (c),
  before/after and `fix --undo` are §6.6 (M3).
- *Accessibility:* landmarks (nav, main), a skip link; the list is one listbox per section (multi-select, roving
  focus), sections are headings, the status tabs a tablist with arrows, the decision bar a toolbar with arrows; after
  a decision the focus moves to the next row and a polite live region says "Kept (intended). Next: Raw error text,
  high, 4 screens"; the Now line is announced at most every 10 s; single-character shortcuts can be turned off in
  the keys dialog (`?`), and keys are off in text fields (`/` searches; Esc goes back to the row); the focus never
  falls to the page: a redraw (a live update, an undo) puts it back on the same control, the row or the heading, Z in
  Detail goes back to the finding it reopened, and a tab that lost the board focuses and says its message; Shift+J and
  Shift+K say how many groups are selected; severity is a word beside its dot; every
  control is at least 44 px, and so are the links that stand alone (the skip link, "4 of 5" screens checked, the
  sidebar's two buttons); reduced motion stops all transitions; dark mode; no sideways scroll at 390 px. Tested
  with axe (no violation) on each view, light at 1280 px and dark at 390 px. Non-text contrast (WCAG 1.4.11): the
  edge of a field, button, decision button, tick box and screen card is `--control` (#7A7F88, 3.4:1 or more against
  the panel, the ground and a selected row, light and dark); the toast's buttons and focus ring are 3:1 or more on
  the toast, and in dark mode the toast is light so that it stands out from the panel (tested in both schemes).
- *The dock:* the decision bar and the undo toast right above it are one sticky dock at the bottom of the window,
  on a phone too (2 × 2 buttons there), so the toast never covers the bar whatever its height; the page measures the
  dock (`--dock-h`) and `scroll-padding-bottom` keeps the focused row clear of it (WCAG 2.4.11), also when the
  toast makes the dock taller. On a view without a bar the toast sits at the bottom of the window, inside `main` (so it is in a landmark, axe
  `region`). Esc while it shows hides it and does Esc's usual step in the same press (back to the list from Detail,
  clearing a selection); the Keys help says so. The toast waits
  while the pointer is over it or the focus is in it, and gets its 6 seconds again after (WCAG 2.2.1); hidden with
  the focus inside (Esc, Undo, the other reason), the focus goes back to the row, or the view's heading. A screen's
  numbered markers have room inside the Screens panel (they sit half outside their box). Tested at 1280 × 560,
  800 × 520 and 390 × 640. In a window 420 px high or less (a phone on its side, 200% zoom at 640 × 360) the bar's
  buttons sit in one row without their sub-labels and the toast is on one line, still 44 px each: the dock takes 16%
  of a 640 × 360 window, 32% with the toast (32% and 51% before); tested at 640 × 360 and 800 × 420, measured in
  one evaluation.
- *Views:* only Progress, Findings (and Detail) and Screens; "More views in 0.2" lists the commands that show the rest.
  It and "Keys (?)" are at the foot of the sidebar, and in the header on a phone (≤ 760 px), 44 px each.
- *Words:* one table (`shared.mjs`), English. Decision times show as relative or local; files keep KST. The main
  button's "Decide N" is the number the verdict says is to decide when it says one (blocker and high; they come first
  in the list), else every group to decide (`summary.decideNow`). "Screens are from before your latest edits: tell
  your AI “capture again”" when the working tree differs. A request with no answer says "the board did not answer
  (is it still running? nunchi open starts it)", never the browser's "Failed to fetch".

**Decision time (§3.5).** The page's `DecisionClock` runs from showing a group (focusing its row, opening its detail)
to the first decision key, paused while the tab is hidden and after 30 s without input, capped at 120 s. The board
keeps it in `state/metrics.json` (`metrics.mjs`): singles, batches (once, with their size) and Later apart, keyed by
decision or batch id, durations only (no clock), stable JSON, never sent. Undo is no decision. `nunchi trust`
prints "decision time (board): singles median …, p90 … · batches … · later, apart …".

**Label mode (§9.2).** `nunchi open --label [--labeller <name>]` (default: git's user name as a folder name, the same
every time: NFKD, marks removed, NFC, lower case, anything but letters of any script and digits as `-`, up to 40
characters; a name with no letter or digit left, or a Windows device name, becomes `u-<6 hex of its hash>`): a board that
serves only labelling. The pool is the ledger's AI groups that are still there and the latest run's rejected and
insufficient claims; decoys and known-true items come from the gate's harness (§9), which knows which they are. Each
item shows the lens's name, definition and checklist question, the claim, the screenshot with its box, the element
and file:line; hidden are rule or AI, the verdict, the verifier, the severity, statuses and decisions. The order is
a hash of labeller and item. Keys 1 (correct), 2 (wrong), 3 (unsure), J/K; a banner "Labelling for the precision
check · 23/50"; no decision bar. A label is `.nunchi/labels/<labeller>/<id>.json` `{id, lens, rule, label, labeller,
channel: board, at}`, written atomically, and its content is noted in `state/labels-approved.json`.

**The deny hook (design §1; spec §5.1 notes).** `hooks/hooks.json` runs `src/deny-hook.mjs` before Read,
NotebookRead, Write, Edit, MultiEdit, NotebookEdit, Bash, Grep, Glob and WebFetch; exit 2 with the reason denies.
It fails closed: input it cannot read (not JSON, over 4 MB) and an error while judging deny the call. The command is
`command -v node >/dev/null 2>&1 || exit 0; node …/deny-hook.mjs` (a POSIX shell, as Claude Code runs hooks; Git Bash
on Windows): without node there is no hook, the documented limit. Git is asked for the common folder only when the
project uses nunchi: a `.nunchi` in the folder or one above, or a `nunchi` folder in the repository's common git
folder (found with file checks up to the nearest `.git`, a linked worktree's `.git` file followed through its
`gitdir:` line and `commondir`), so a call in a project that never used nunchi, or outside a repository, spawns
nothing (85 → 69 ms a call measured here, most of it node's start); the path rules hold there all the same. It
denies every tool the shared state (`<git-common-dir>/nunchi/**`, by git's own answer and by any `.git/nunchi` in a
path) and `.nunchi/state/**`; the answer keys (`$XDG_STATE_HOME/nunchi`, `%LOCALAPPDATA%\nunchi`,
`~/.local/state/nunchi`, all three); `.nunchi/auth.json`; a run's `canaries.json` and older keys; a running board's
port (any loopback name, curl, nc, `/dev/tcp`, WebFetch), control socket and `/proc/<pid>`, and any
`/proc/<n>/cmdline|environ|mem|maps|fd`. It denies writes (Write, Edit, and Bash commands that are not plain reads)
to `.nunchi/decisions/**`, `.nunchi/labels/**`, `.nunchi/lenses/**`, `lenses.lock.json` and `.nunchi/config.json`
(reads stay open: they are committed). It denies `nunchi … approve`, `… label` / `--label`, `--approve-checks`,
nunchi (by name, `npx nunchi@<version>` included, or its `cli.mjs`) under `script`, `unbuffer`, `expect`, `socat`,
`tmux`, `screen`, `dtach`, `abduco`, `zellij`, `winpty` or a pty module (Python `pty` or `pexpect`, `node-pty`,
ConPTY): it would pass for `cli-tty`; `XDG_STATE_HOME=`, `LOCALAPPDATA=`, `HOME=`, `USERPROFILE=` or `APPDATA=` set
in a command that runs nunchi, and `export`/`set`/`$env:` of `XDG_STATE_HOME` or `LOCALAPPDATA` anywhere (the answer
keys would land where the hook does not look); and running `board/server.mjs` or `board/launch.mjs` directly (node,
bun, deno, npx, `import(…)`) or any `--link-to-parent`.
A Bash command is read as segments (also at `$(`, backticks and parentheses), with words joined as a shell joins
them (`.nu"nchi"`, escapes), `cd` followed, globs and braces expanded against the file system (`.nunchi/runs/*/*.json`
is the files it names), pieces of words checked as paths (inline code), and `sh -c` / `eval` judged as commands;
inline code that names nunchi's places in pieces (`join('.git', 'nunchi')`) is denied. Recursive reads — `grep -r`,
`rg`, `find` with `-exec`/`-ok`/`-delete`, `find` or `rg --files` into `xargs` — are denied when they reach the state,
the keys, `auth.json` or a run's canaries, unless their filters leave those out (`--exclude-dir=.git
--exclude-dir=.nunchi`, `--include`, `-g '!.git'`, `-t`, `-name`, `-path … -prune`); rg's own skipping of dot folders
counts unless `--hidden`, `-.` or `-uu`. Process lists with command lines (`ps aux`, `ps -ef`, `ps -o args`, `pgrep -a`,
`top -c`, `/proc/*/cmdline`, and Grep or Read of `/proc`) are denied only while a board record of this project is in the
state (the one-time link is in a browser's command line only then; `ps aux | grep vite` is an everyday command
otherwise), and the message says so; a record a crashed board left keeps the rule on until the next `nunchi open` or
`--stop` removes it. Grep and Glob are denied with a base in `.git`, `.nunchi` itself, `.nunchi/runs`
or `/proc`. Links are followed before deciding. A pure data hook: no network, nothing written. Limits: it reads paths and
words in the call; a command that builds a path at run time is not seen. Codex CLI has no such hook. The skill
states the same rules for other agents.

*What this is, and is not.* The hook, the channels and the board's confirmation are an **attestation** of who
decided: they hold against honest mistakes and naive prompt injection (an agent that follows text on a screen, or
guesses a command). They are **not a security boundary** against code that runs as the same user as the person:
such code can read the same files, start the same processes and drive the same browser. A text hook in particular
cannot see a script that imports `board/launch.mjs`, or a copy of the board's script edited to print its link: it
sees the `--link-to-parent` flag (checked in the words as the shell joins them, whatever the script is called) and
the script's own names, nothing a file does once it runs. Nor does it judge archives and recursive copies of the
whole project or of `.git` (`tar`, `zip`, `cp -r`, `rsync`): they take the state and the canaries along, and the copy
lies outside the paths it guards; nor `find -path` patterns (`find . -path '*nunchi*state*'` lists the state's
files). For a repository you do not trust, run the agent in a container or as a separate user.

**Deviations from design §3, and why (the safer option each time).**
- One-time code in the link, traded for a per-tab key, instead of the key itself in the fragment: a link that leaks
  (shell history, a browser's command line, a process list) is spent or expired. A reload needs a fresh link.
- The page shell's assets answer without a key (a module script cannot send a header); they hold no data.
- The decisions folder is watched as well as the generation (git-arrived decisions); `decide` bumps after writing.
- Z writes `reopen` (the design's wording), never a copy of an earlier decision.
- Approvals of `nunchi approve` record their channel instead of being refused when run by the agent: a `cli-agent`
  approval of a dismissal counts for status but not for "Ready to ship" until confirmed, which keeps the chat path
  (Codex) working; the hook denies the command in Claude Code.
- Primary buttons have dark text in dark mode (white on the dark accent is 2.6:1), in the shared stylesheet since the
  review of PR #29, so the export has it too: the export's bytes changed there on purpose, by that rule and by
  `.row-where` wrapping anywhere (a long route without a break no longer runs out of its row).

**Measured (2026-10-15 00:32–00:49 KST).** Pebble `node bench/run.mjs --twice` is unchanged: rule recall 34/34, 0 false
positives on 8 clean scenes, determinism identical (1,141 files; `origin/main` gives the same 1,141 on this machine,
so the one file more than M1's note is the environment's), fingerprints 100% (52/52), 151 s per capture. Held-out
pegroom (a scratch copy): 180 screens, rule recall 38/38; the board on that run (1440 px and 390 px, Progress,
Findings, Detail, Screens, the undo toast) loads every screenshot through the key, sends nothing but to itself, and
showed two bugs fixed before merge: the favicon lockout and the Progress mark (§7.2 rate limits; tests added).
After the fixes of the review of PR #29 (2026-10-15 02:56 KST), the bench is unchanged: rule recall 34/34, 0 false
positives on 8 clean scenes, determinism identical (1,141 files), fingerprints 100% (52/52); 170 s per capture, with
the Node 24 test suite running beside it. The suite: 429 tests on Node 22.22.0 and on Node 24.21.0, Chromium
included. After round 2 of the review (2026-10-15 04:04–04:09 KST): rule recall 34/34, 0 false positives on 8 clean
scenes, determinism identical (1,141 files), fingerprints 100% (52/52), 160 s per capture with the Node 24 suite
beside it; 438 tests on Node 22.22.0 and on Node 24.21.0, Chromium included.

**Known limits (review of PR #29, 2026-10-15 KST; left as they are).**
- The hook's check of the board's port names `127.0.0.1`, `localhost`, `::1`, `0.0.0.0` and `0`; other spellings of
  loopback (`127.1`, `127.0.1`, `2130706433`, `0x7f000001`) reach the port unseen. The board still answers only with
  the key, and the Host check refuses any Host but `127.0.0.1:<port>`.
- On Windows the control socket is a named pipe with the default access of the user's session: another local user
  may be able to connect and send `open` or `stop` (never a link or a key: the pipe hands out neither).
- The decision time is measured by the page and sent as `ms` (0 to 120000, checked): whoever holds the tab's key can
  send any value in that range, so the metric is the person's own record, not a proof.

**Not done in M2:** the fix loop's states and probe runs hidden from `runs` came with M3 (§6.6); Coverage and
Screens beyond the wall (M7) are later milestones; label pools from the gate harness (G); Korean words (the table is
ready).

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

*Engine issues found, not fixed in the measuring PR.* Fixing them there would have turned this app into a tuning
set; the numbers above stay as the held-out result, and a later re-measure on pegroom is reported as not blind.
Status after the fix PR (2026-10-14 KST), each with a synthetic fixture that triggers it and one that does not:
1. *Fixed.* `signed-in-bounced` matches the sign-in pattern on the path only (`isSignInPath`):
   `/sign-in?next=%2Fbilling` is a sign-in page, `/designs?from=login` is not.
2. *Fixed.* aria.yml nodes of the form `role "name": text` are also addressable as `aria=role "name"` (the
   whole line still works); the hunter brief and the skill say so.
3. *Fixed.* React Router routes map to the components their config names, not to the config file (§2.5).
   Source slices and `dead-end` now see each route's own files.
4. *Fixed.* Lens packs may set `reference: "nearest"` (§3.3); L4 does, so a detail page is compared with its list
   page. Other lenses keep the hash spread, so their measured plans are unchanged.
5. *Fixed.* A `fixed-cover` canary is hit by a claim of its item anywhere on the copy; the ambiguity check against
   the original still applies. `blank-state` is no longer planted where the message is the main area's only text.
6. *Does not reproduce.* In the pegroom capture, error-state scenes took a median of 1.09 s, normal ones 1.08 s,
   and no scene took more than 2.1 s. The networkidle waits did not run to their timeouts. No change.

*Re-check after the fixes (2026-10-14 KST, not blind):* Pebble unchanged (rule recall 34/34, identical, 100%);
pegroom rule recall 38/38, 0 false positives on 20 clean scenes, identical (1,837 files), fingerprints 100% (43/43).
The AI-lens re-measure waits for a fresh held-out app.

*Verdict:* the held-out app fails two gates: rule recall (37/38, one engine bug) and L4 recall (67%). Seven of
eight AI lenses pass. Determinism, fingerprint stability and clean-screen false positives hold. Release still
needs a fresh held-out app for a blind re-measure with the fixes above, besides the precision gate and the Codex
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
