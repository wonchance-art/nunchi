# nunchi

**nunchi notices what's off in every corner of your web app.**

*Nunchi* (눈치) is the Korean word for sensing that something is off before anyone says it.
This tool does that for your app: it sweeps every screen and state, finds what's broken or
inconsistent, has a second reviewer verify each finding against evidence, helps fix it,
and captures the screen again to confirm the fix — with a progress board that shows what
was checked and what's left.

Built for people who make web apps with AI coding tools (Claude Code, Cursor, Codex, Lovable, Bolt, v0)
and don't write tests.

> **Status: planning → 0.1 in progress.** Nothing is usable yet.
> The 0.1 spec will live in `docs/spec-0.1.md`.

## What it will do (0.1)

- Discover every route (Next.js, TanStack Start, Vite + React Router, or crawl)
- Capture each screen at phone (390) and desktop (1280) widths, deterministically,
  including forced **empty / error / slow / offline** states
- Hunt defects through 10 lenses: broken layout, state completeness, dead links and orphan routes,
  visual consistency (your app's real design system, measured), copy consistency, copy quality,
  leftover placeholders, accessibility, unsafe actions, phone/desktop parity
- Verify every AI finding with a separate reviewer before you see it
- Track each finding: found → confirmed → fixing → fixed (re-captured) → guarded (lint/contract rule)
- Show a local progress board: open defects, trend, coverage map, design-system drift, AI trust

## Principles

- No finding without evidence (a DOM element, selector, measurement or file:line)
- Coverage is counted: "0 defects" only means something if the corner was actually checked
- Fixed means re-captured and gone — not "the AI said so"
- Local first: no hosted service, no telemetry, no secrets required

## License

[MIT](LICENSE)

---

### 한국어

**nunchi는 웹앱 구석구석의 어긋남을 알아챕니다.** 모든 화면과 상태(빈 데이터 · 오류 · 느림 · 끊김)를 훑어 결함을 찾고,
별도 확인자가 증거로 확인한 뒤, 고치고, 다시 찍어 사라졌는지 확인합니다. 무엇을 봤고 무엇이 남았는지는 진행판에 숫자로 보입니다.
AI 코딩 도구로 웹앱을 만들고 테스트는 쓰지 않는 사람을 위해 만듭니다. 현재 0.1을 짓는 중이며 아직 쓸 수 있는 기능은 없습니다.
