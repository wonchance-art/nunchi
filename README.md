# nunchi

**nunchi notices what's off in every corner of your web app.**

*Nunchi* (눈치) is the Korean word for sensing that something is off before anyone says it.
nunchi sweeps every screen of your app, in every state, and reports what is broken or inconsistent,
each finding tied to evidence: the element, its box on the screenshot, the measurement, or file:line.

Built for people who make web apps with AI coding tools (Claude Code, Cursor, Codex, Lovable, Bolt, v0)
and don't write tests.

> **Preview (0.0.2).** nunchi finds defects; it does not yet verify them with a second AI, fix them, or
> show a progress board. Those are 0.1. Tested on Linux, macOS and Windows in CI, on Node 20, 22 and 24,
> but so far only against a synthetic benchmark app and small fixtures — tell us what it gets wrong on
> your app.

## Install (Claude Code)

```
/plugin marketplace add wonchance-art/nunchi
/plugin install nunchi@nunchi
```

Then, in your app's folder, ask Claude to check your app with nunchi (or run the `nunchi` skill). The first time,
it runs `nunchi setup`: two pinned packages from the lockfile (`npm ci --ignore-scripts`, so no install scripts
run) and Chromium (~170 MB), once.

Without Claude Code, from a clone of this repository: `node src/cli.mjs setup`, then
`node src/cli.mjs capture --url http://localhost:3000 --root <your app>`.

## What works today

- **Discover** every route (Next.js app and pages router, TanStack Start/Router, Vite + React Router)
- **Capture** each screen at phone (390) and desktop (1280) width, as a guest and signed in (a login you save
  once with a test account), deterministically: two runs of the same build give byte-identical evidence
- **Forced states** on screens that load data: **empty, error, slow, offline**, from a recording of your app's own
  responses (replayed, so screens stay comparable between runs)
- **Checks that need no AI** — layout overflow, clipped text, broken images, page errors and failed requests,
  raw error text shown to users, errors that look like empty lists, missing offline notices, leftover placeholder
  text, `NaN`/`undefined` on screen, accessibility (axe-core, target sizes, placeholder-only labels), native
  `alert`/`confirm`, dead links, links to routes that don't exist, screens nothing links to, dead ends, redirect
  loops, signed-in users bounced to the login page, secret keys in the browser bundle, one-off button shapes and
  heading styles against your app's own measured design system, and desktop controls missing on the phone
- **One line per problem, not per screen**: findings are fingerprinted and grouped, so a shared component's
  defect on 17 screens is one row (`nunchi findings`); your decisions (`nunchi decide <id> fix|keep|…`) are small
  files you commit, and what got fixed or came back is computed from the next capture
- **Runs** you can compare: each capture is its own folder with the commit and working-tree state it came from;
  a login that expired or an app that isn't running is reported once, not as a hundred findings

Not yet (0.1): AI lenses (copy, states, visual judgment) with a separate verifier, the fix-and-re-capture loop,
and the local progress board.

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

**미리보기(0.0.2).** 지금은 *찾기*까지입니다. 다른 AI가 다시 확인하기, 고치고 다시 찍기, 진행판은 0.1에서 나옵니다.
Claude Code에서 `/plugin marketplace add wonchance-art/nunchi` → `/plugin install nunchi@nunchi` 후, 앱 폴더에서
nunchi로 검사해 달라고 하면 됩니다. 처음 한 번 `nunchi setup`이 고정된 패키지 2개(설치 스크립트 없이)와 Chromium(약
170MB)을 받습니다. 실제 앱에서 틀리게 잡는 것이 있으면 알려 주세요.
