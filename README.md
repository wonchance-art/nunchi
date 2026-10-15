# nunchi

**nunchi notices what's off in every corner of your web app.**

*Nunchi* (눈치) is the Korean word for sensing that something is off before anyone says it.
nunchi sweeps every screen of your app, in every state, and reports what is broken or inconsistent,
each finding tied to evidence: the element, its box on the screenshot, the measurement, or file:line.

Built for people who make web apps with AI coding tools (Claude Code, Cursor, Codex, Lovable, Bolt, v0)
and don't write tests.

> **Preview (0.0.2).** nunchi finds defects and shows them on a live local board where you decide; your AI then
> fixes what you decided *Fix*, and nunchi keeps a fix only when capturing again shows the defect gone and nothing
> else broken. The fix loop is new and not yet measured on its gate. Tested on Linux, macOS and Windows in CI, on Node 20, 22 and 24,
> but so far only against a synthetic benchmark app and small fixtures — tell us what it gets wrong on
> your app.

## Install (Claude Code)

```
/plugin marketplace add wonchance-art/nunchi
/plugin install nunchi@nunchi
```

Then, in your app's folder, ask Claude to check your app with nunchi (or run the `nunchi` skill). The first time,
it runs `nunchi setup`: the pinned packages from the lockfile (`npm ci --ignore-scripts`, so no install scripts
run) and Chromium (~170 MB), once.

Without Claude Code, from a clone of this repository: `node src/cli.mjs setup`, then
`node src/cli.mjs capture --url http://localhost:3000 --root <your app>`.

## What works today

- **Discover** every route (Next.js app and pages router, TanStack Start/Router, Vite + React Router)
- **Capture** each screen at phone (390) and desktop (1280) width, as a guest and signed in (a login you save
  once with a test account), deterministically: two runs of the same build give byte-identical evidence
- **Forced states** on screens that load data: **empty, error, slow, offline**, from a recording of your app's own
  responses (replayed, so screens stay comparable between runs)
- **A first look** (`nunchi capture --quick`): `/` and the key screens its navigation links to, then one per section
  (up to 8), with the checks that need no AI, on the board in a minute or two. It marks nothing fixed; the board says
  "Too early to say" and how far the full check that follows has come, then what the full check added. Screens the
  first look recorded are replayed by the full check, the rest are recorded and merged in
- **Checks that need no AI** — layout overflow, clipped text, broken images, page errors and failed requests,
  raw error text shown to users, errors that look like empty lists, missing offline notices, leftover placeholder
  text, `NaN`/`undefined` on screen, accessibility (axe-core, target sizes, placeholder-only labels), native
  `alert`/`confirm`, dead links, links to routes that don't exist, screens nothing links to, dead ends, redirect
  loops, signed-in users bounced to the login page, secret keys in the browser bundle, one-off button shapes and
  heading styles against your app's own measured design system, and desktop controls missing on the phone
- **One line per problem, not per screen**: findings are fingerprinted and grouped, so a shared component's
  defect on 17 screens is one row (`nunchi findings`); your decisions (`nunchi decide <id> fix|keep|…`) are small
  files you commit, and what got fixed or came back is computed from the next capture
- **A live board** (`nunchi open`): the verdict ("Ready to ship?"), every finding with its screenshot, all screens,
  and one-key decisions with undo, in your browser, updated as captures land. It listens on 127.0.0.1 only, and a
  one-time link gives your browser a key held in memory; your AI never sees it. Decisions your AI records from chat
  are shown, but a *keep* or *not a problem* counts only once you confirm it there. In Claude Code the plugin's hook
  also keeps the AI's tools out of nunchi's state, keys and board. The hook matches paths and words, and neither it
  nor the board is a security boundary against code running as your user: they attest who decided, against honest
  mistakes and naive prompt injections. For a repository you don't trust, run the agent in a container or as
  another user
- **A fix loop** (`nunchi fix`): your AI edits, nunchi does the rest. Fixes go on a branch of their own
  (`nunchi/fixes-MMDD`, the day's date), one commit per finding, after your own build, typecheck, lint and tests run
  (scripts you approve once in the board, run without install or pre/post scripts; a check blocks only when it newly
  fails, or fails worse than before the fix). nunchi captures the affected screens before and after from the same
  recorded data, and judges: *fixed*, *undone* (it broke something or did not remove the defect; two tries, then it is
  yours), or *needs you* (it also changed other parts of the screen: the board shows before and after, with a slider).
  It never pushes, resets or forces, never mixes your uncommitted work into an undo, and an AI saying "fixed" changes
  nothing
- **Several agents at once** (say, Claude Code and Codex in two worktrees): each says who it is, and nunchi records
  it as declared. Their hunts' answers stand side by side, the same defect found by both is one finding, a verifier
  of another vendor is labelled *cross-vendor* (never an approval), the board shows who is fixing and hunting right
  now ("Codex · AI review L6 · 12/40 units · 3 min"), and each worktree fixes against its own app server. Claims keep
  cooperating agents from fixing one finding, or one file, at once; they do not stop a malicious one
- **Runs** you can compare: each capture is its own folder with the commit and working-tree state it came from;
  a login that expired or an app that isn't running is reported once, not as a hundred findings

Not yet (0.1): guards that keep a fixed kind of defect from coming back, and `nunchi check`. The
AI lenses (copy, states, visual judgment) with a separate verifier, and the fix loop, are built and being measured.

## Benchmark

`bench/pebble` is a small synthetic to-do app with seeded UI defects; `bench/answers/pebble.json` is its answer key,
kept outside the app so a hunter pointed at the app never sees it. `npm run bench` builds the app, captures it with
the CLI exactly as a user would (twice, to check determinism) and writes `bench/out/report.md`. Today: every defect
owned by the non-AI checks is found (34/34), no false positives on the clean screens, evidence byte-identical.
The checks were tuned on this app once; a second, held-out app is what the 0.1 gates use.

## Principles

- No finding without evidence (a DOM element, selector, measurement or file:line)
- Coverage is counted: "0 defects" only means something if the corner was actually checked
- Fixed means re-captured and gone — not "the AI said so"
- Local first: no hosted service, no telemetry, secrets never written to evidence

## License

[MIT](LICENSE)

---

### 한국어

**nunchi는 웹앱 구석구석의 어긋남을 알아챕니다.** 모든 화면을 휴대폰 · 데스크톱 너비로, 손님 · 로그인 상태로,
빈 데이터 · 오류 · 느림 · 끊김 상태까지 찍어서 깨지거나 어긋난 곳을 찾고, 결함마다 증거(요소 · 화면 위 위치 · 측정값 ·
파일:줄)를 붙입니다. AI 코딩 도구로 웹앱을 만들고 테스트는 쓰지 않는 사람을 위해 만듭니다.

**미리보기(0.0.2).** *찾기*, 진행판(`nunchi open`, 내 브라우저에서 결정), 그리고 고치기(`nunchi fix`)까지 됩니다. AI가
고친 것은 별도 브랜치에 결함 하나당 커밋 하나로 남고, 다시 찍어서 결함이 사라지고 다른 곳이 깨지지 않았을 때만 고쳐진 것으로
칩니다(고치기 게이트는 아직 측정 전). 빠른 첫 보기(`nunchi capture --quick`)는 핵심 화면 최대 8개를 먼저 보여
주고, 결론은 이어지는 전체 검사가 끝난 뒤에 냅니다(그 전까지 진행판은 「Too early to say」).
Claude Code에서 `/plugin marketplace add wonchance-art/nunchi` → `/plugin install nunchi@nunchi` 후, 앱 폴더에서
nunchi로 검사해 달라고 하면 됩니다. 처음 한 번 `nunchi setup`이 고정된 패키지 2개(설치 스크립트 없이)와 Chromium(약
170MB)을 받습니다. 실제 앱에서 틀리게 잡는 것이 있으면 알려 주세요.
