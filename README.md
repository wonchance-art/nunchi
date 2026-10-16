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

(From a shell: `claude plugin marketplace add wonchance-art/nunchi`, then `claude plugin install nunchi@nunchi`.)
A session that was already open loads it after `/reload-plugins`. Then, in your app's folder with its dev server
running, ask Claude to check your app with nunchi, or type `/nunchi` (`/nunchi:nunchi` is its full name, for when
another command is also called `nunchi`). The first time, it runs `nunchi setup`: Chromium (~170 MB), once, and the
pinned packages from the lockfile if Claude Code did not already install them with the plugin (`npm ci
--ignore-scripts`, so no install scripts run).

**Updates.** The plugin carries no version number, so each commit on `main` is an update. Get it with
`claude plugin marketplace update nunchi` and `claude plugin update nunchi@nunchi`, or turn on auto-update for the
nunchi marketplace (`/plugin` → Marketplaces; Claude Code then checks after your first message in a session). An
open session keeps the old copy until `/reload-plugins`; a new session loads the update.

The plugin adds no `nunchi` command to your PATH. A few steps are yours to run in your own terminal (`nunchi login`
with a test account, approving the check scripts, adding guards): `nunchi setup --check` prints the command to use
there, `node "<where the plugin is>/src/cli.mjs"`, and Claude gives you the whole line when it asks.

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
  "Too early to say" and, in a bar at the top of every view (and the tab's title), how far the full check that follows
  has come ("Full check running · 33 of 72 screens · about 16 min left"), then what it added ("Full check done · 72
  screens · 16 new groups"); your AI says in chat when it starts and when it is done. Screens the first look recorded
  are replayed by the full check, the rest are recorded and merged in
- **Checks that need no AI** — layout overflow, clipped text, broken images, page errors and failed requests,
  raw error text shown to users, errors that look like empty lists, missing offline notices, leftover placeholder
  text, `NaN`/`undefined` on screen, accessibility (axe-core, target sizes, placeholder-only labels), native
  `alert`/`confirm`, dead links, links to routes that don't exist, screens nothing links to, dead ends, redirect
  loops, signed-in users bounced to the login page, secret keys in the browser bundle, one-off button shapes and
  heading styles against your app's own measured design system, and desktop controls missing on the phone
- **One line per problem, not per screen**: findings are fingerprinted and grouped, so a shared component's
  defect on 17 screens is one row (`nunchi findings`); your decisions (`nunchi decide <id> fix|keep|…`) are small
  files you commit, and what got fixed or came back is computed from the next capture
- **A live board** (`nunchi open`): the verdict ("Ready to ship?"), every finding with its screenshot, all screens
  (one at a time, both widths side by side, compared with the last full check), what was and wasn't checked
  (Coverage: every page × visitor/signed in × desktop/phone, each gap with the one sentence to tell your AI), and
  one-key decisions with undo, in your browser, updated as captures land. It listens on 127.0.0.1 only, and a
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
  it as declared. Their hunts' answers stand side by side, the same defect found by both is one finding (its Detail
  says who found it), a verifier of another vendor than every agent that found it is labelled *cross-vendor* (never
  an approval), the board shows who is fixing and hunting right now ("Codex · AI review L6 · 12/40 units · 3 min"),
  and each worktree fixes against its own app server. Claims keep
  cooperating agents from fixing one finding, or one file, at once; they do not stop a malicious one
- **Runs** you can compare: each capture is its own folder with the commit and working-tree state it came from;
  a login that expired or an app that isn't running is reported once, not as a hundred findings
- **Guards** that keep a fixed kind of defect from coming back: `window.confirm`/`alert`, `href="#"` and
  `javascript:` links, `{error.message}` in JSX, `{{ }}` left in JSX text, and colour literals outside your measured
  tokens. Read from your source (parsed, not grepped; tests, comments and `node_modules` never count). At the end of a
  batch of fixes the board offers the first four, for the kinds it fixed, on one card ("Stop these coming back?"); the
  colour guard you add with `nunchi guard --add colour-literal` in your own terminal. You add them, never your AI. They live in
  `.nunchi/guards.json` with a baseline of what was already there, so only new hits fail. `nunchi guard --lint` prints
  the same checks as an ESLint config object to paste (nunchi never writes your config)
- **`nunchi check`** for CI: no browser, no network. The guards over your source (a new hit fails), `--base
  origin/main` fails a pull request that removes or weakens a guard, `--sarif` writes a file for code scanning; on your
  own machine `--fail-on high` also fails on open findings. Exit 0 clean, 1 a hit, 2 a usage or state error
- **Exports**: `nunchi export --format md|json|sarif` — the findings to share or upload, secret-shaped strings
  replaced by their kind, text from your screens left out unless `--include-page-text`, paths relative to your
  repository and routes as templates

- **Sharing results with a Claude session in the cloud** (`nunchi share`, a 0.2 preview): off until you set it up
  in your own terminal (`nunchi share --setup`, confirmed with a code you type; your AI cannot), for that worktree. You
  choose where: a private Claude artifact (your AI publishes it, and Claude Code asks you before every publish of the
  pack nunchi prepared, and before your AI publishes a page `nunchi export --html` wrote), a Google Drive folder
  synced on your machine (nunchi writes files there, nothing else), or a private GitHub repository of its own (pushed
  with your git login, to the repository you named only; before each push nunchi checks, without your login, that it
  does not answer: a public one is refused). Only a check of the whole app goes by itself; a partial one only when you
  run `nunchi share`, marked partial. By default only screens seen as a visitor go, without text from your screens;
  never your saved login, recordings, cookies or tokens, and a screen whose text looks like a key goes without its
  screenshot. A screenshot can still show anything on the screen: use a test account and test data. The plugin's hook
  guards against honest mistakes, not against your AI: it does not see connectors' own uploads (a Google Drive
  connector's, say) or a copy made by inline Python or Node, so keep connectors you do not need off. A cloud session
  that fixes something proposes commits on a branch; only a re-capture on your machine says what is fixed. `nunchi
  share --off` stops it. If you only want to work from claude.ai while your machine runs the captures, Claude Code's
  Remote Control sends nothing off it

Being measured (0.1): the AI lenses (copy, states, visual judgment) with a separate verifier, the fix loop, the guards
with `nunchi check`, and the first look are built; their gates are not measured yet.

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

**미리보기(0.0.2).** *찾기*, 진행판(`nunchi open`, 내 브라우저에서 결정하고, 무엇을 확인했고 무엇을 못 했는지와 그때
AI에게 할 한 문장까지 봅니다), 그리고 고치기(`nunchi fix`)까지 됩니다. AI가
고친 것은 별도 브랜치에 결함 하나당 커밋 하나로 남고, 다시 찍어서 결함이 사라지고 다른 곳이 깨지지 않았을 때만 고쳐진 것으로
칩니다(고치기 게이트는 아직 측정 전). 빠른 첫 보기(`nunchi capture --quick`)는 핵심 화면 최대 8개를 먼저 보여
주고, 결론은 이어지는 전체 검사가 끝난 뒤에 냅니다(그 전까지 진행판은 「Too early to say」). 고친 종류가 다시 생기지 않게
막는 방지 규칙(`window.confirm`, `href="#"`, JSX의 `.message`, `{{ }}`, 토큰 밖 색)은 한 묶음의 고치기가 끝나면 진행판
카드에서 사람이 추가하고(색 규칙은 `nunchi guard --add colour-literal`), CI에서는 `nunchi check`(브라우저 · 네트워크
없이, `--base`로 방지 규칙을 약하게 한 PR도 잡음)로 돌립니다. `nunchi export --format md|json|sarif`로 결과를 내보낼 수
있습니다(비밀값은 종류만, 화면 문구는 요청할 때만). 클라우드의 Claude 세션에 결과를 보내는 `nunchi share`(0.2 미리보기)는
내 터미널에서 `nunchi share --setup`으로 직접 켜야만 동작합니다(입력하는 확인 코드, AI는 켤 수 없음). 비공개 Claude
아티팩트(nunchi가 준비한 결과를 게시할 때마다 Claude Code가 묻습니다) · 동기화되는 Google Drive 폴더 · 결과 전용 비공개 GitHub 저장소(로그인 없이
열리면 공개로 보고 보내지 않음) 중에서 고르고, 기본으로는 손님 화면의 스크린샷만, 화면 문구 없이 나갑니다. 로그인 정보 ·
녹화 · 쿠키 · 토큰은 나가지 않습니다. 저절로 가는 것은 앱 전체를 본 검사뿐이고, 일부만 본 검사는 `nunchi share`로 보낼 때
일부 검사로 표시됩니다. 끄기는 `nunchi share --off`.
Claude Code에서 `/plugin marketplace add wonchance-art/nunchi` → `/plugin install nunchi@nunchi` 후(이미 열린 세션은
`/reload-plugins`), 앱 폴더에서 nunchi로 검사해 달라고 하거나 `/nunchi`(전체 이름 `/nunchi:nunchi`)를 입력하면 됩니다.
처음 한 번 `nunchi setup`이 Chromium(약 170MB)을, Claude Code가 플러그인과 함께 설치하지 않았다면 고정된 패키지도(설치
스크립트 없이) 받습니다. 플러그인은 PATH에 `nunchi` 명령을 추가하지 않으므로, 내 터미널에서 직접 할 일(`login`, 검사
스크립트 승인, 방지 규칙 추가)은 `nunchi setup --check`가 알려 주는 `node "…/src/cli.mjs"` 명령으로 실행합니다. 실제
앱에서 틀리게 잡는 것이 있으면 알려 주세요.
업데이트: 플러그인에 버전 번호를 두지 않아서 `main`의 커밋 하나하나가 업데이트입니다. `claude plugin marketplace update nunchi`
→ `claude plugin update nunchi@nunchi`, 또는 `/plugin` → Marketplaces에서 nunchi의 자동 업데이트를 켜 둡니다(세션에서 첫
메시지를 보낸 뒤 확인합니다). 열려 있던 세션은 `/reload-plugins` 뒤에, 새 세션은 바로 새 판을 씁니다.
