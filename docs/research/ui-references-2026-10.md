# UI references review: "UI 정리" (Notion) and Component Gallery

> **한국어 요약 (오너용)**
>
> - **검토 대상**: ⑴ 바이브 코더용 Notion 노트 「바이브코딩 UI 총정리 노트」(작성자 @juuouse — 본문, 표 9개, 이미지 9장 확인). ⑵ component.gallery(Iain Bean — 컴포넌트 60종 색인과 14개 상세 페이지).
> - **배울 점**: Notion 노트는 **이름을 알면 AI에게 정확히 시킬 수 있다**는 원칙을 줍니다. 컴포넌트 이름, 한 줄 용도, 「어디에 + 이름 + 개수 + 조건」 프롬프트 공식이 그 예입니다. Component Gallery는 **같은 일을 하는 컴포넌트끼리 묶는 어휘**를 줍니다. 별칭과 "버튼 그룹·라디오·탭의 중간"이라는 식의 정의가 그 예입니다.
> - **채택**: 대안을 "같은 일을 하는 형제" 묶음(가족)으로 정리합니다. 대안마다 한 줄 트레이드오프를 붙이고, 변경 계획 문장은 프롬프트 공식으로 씁니다. 렌즈 후보 규칙 3개(한 화면 Primary 여러 개, 되돌릴 수 있는 동작에 빨강, 폼 오류를 알럿·토스트로만 표시)를 둡니다.
> - **배제**: 참고 사이트 목록(Mobbin 등)과 스크린샷·예시 임베드, 인기순(예시 수) 정렬, 스크롤 애니메이션 교체.
> - **실현성**: 4단계입니다. ⓪ "평소 버튼에 맞추기"와 ① 스타일은 즉시 미리보기됩니다(S). ② 같은 컴포넌트 안의 변형은 요소 단위 CSS 주입으로 미리보고, 적용은 AI가 합니다(M). ③ 구조 교체는 nunchi가 직접 그린 썸네일로 보여 주고, 원하면 AI 시험 구현 + 재캡처를 합니다(L, 수십 초).
> - 팝오버에는 한 번에 **최대 4개 선택지**만 보이고, 첫 줄은 항상 "평소 것에 맞추기"입니다.
> - 열린 질문은 §7에 있습니다. 컴포넌트 이름을 한·영 중 어떻게 표기할지, 구조 교체 "시험해 보기"를 어디서 실행할지(AI 실행 위치), T1 게이트를 ⓪단계에 적용할지 등입니다.

Status: research note, 2026-10-14 (KST). Not a spec change. Proposals here feed the design supporter (design-0.1-c §6a) and the live board (M2) only after owner review.

How it was made: a separate session read both sources (the Notion page through its public page API, including its 9 images; Component Gallery's index, 14 component pages and about page) and drafted this note without a nunchi checkout. The coordinating session mapped the lens candidates to the existing lenses (§4) and committed it. The sources were not re-read for the commit, so quotes and counts are as the reading session reported them.

---

## 1. Sources and terms of use

| Source | What it is | Licence / terms found | How we may use it |
|---|---|---|---|
| **Notion page "바이브코딩 UI 총정리 노트"** (author Instagram @juuouse). Public page `3d6063ed09fd80ec8b5ef9784079694e`. | Korean cheat-sheet for vibe coders: a prompt formula, links to 4 reference sites, about 120 component terms in 9 groups (Korean name, English name, one-liner), each group illustrated by one sample sheet, 16 scroll-animation terms. | No licence stated, so all rights reserved by default. | Principles only, paraphrased, with the source cited. No tables, images or copy text go into nunchi. |
| **component.gallery** (Iain Bean). Built with Astro on Cloudflare Pages; data from Airtable. | Index of 60 component types. Each page has a definition, aliases ("also known as") and links to real design systems' implementations (for example 118 for Button, 28 for Segmented control). | No licence on the site. The screenshots show third-party design systems, each under its own terms. | Component **names** and the idea of a job-based taxonomy are common vocabulary. Definitions are paraphrased. No screenshots or example embeds. Linking to a page as further reading is fine. |

The repo rule holds: copy no content, copy text or screens from real products. Everything below restates principles in our own words. Every icon or thumbnail mentioned is a nunchi-drawn generic schematic.

## 2. What each source teaches

### 2.1 Notion "UI 정리"
1. **Naming beats describing.** Its opening example contrasts describing a widget ("the thing that opens and closes") with naming it ("make it an accordion"). Once you know the name, edits take fewer rounds. For nunchi: when we flag an element, **name it** so the user can talk to their AI precisely.
2. **Prompt formula**: *[where] + [component name] + [count] + [details]*. Its worked prompt adds structure, form conditions and design notes, such as disabling the submit button with a spinner while submitting and showing a toast on success.
3. **Taxonomy by what the user does**, in 9 groups: page skeleton, moving and navigating, showing content, taking input, pressing, telling, small marks, states, layout and motion. This sorts by the *user's goal*, not the developer's.
4. **One-line usage principles printed in the sample images** (paraphrased):
   - Primary button: filled colour, **one per screen**.
   - Secondary: border only, **second in importance**.
   - Ghost or text button: no background, for low-stakes actions such as Cancel.
   - Destructive: **red only for actions that can't be undone**.
   - CTA: the single most important action.
   - Inline field error: **better than an alert** for a field's mistake.
   - Confirmation dialog: for "are you sure?" moments.
   - Toast: brief, then disappears.
5. **States are vocabulary too**: default, hover, active, focus, disabled, loading, selected, error, success, read-only. The sample sheet shows each state on the same button or field.
6. **Mobile is forgotten by default**: AI tends to build for desktop only unless asked for mobile too.
7. **Reference sites** (Mobbin, 60fps.design, MotionSites, Framer) and **scroll-animation terms** (fade-in-up, stagger, parallax and so on). These are inspiration catalogues.

### 2.2 Component Gallery
1. **One canonical name plus aliases.** Examples: Toggle = switch / lightswitch / toggle button. Select = dropdown / select input. Drawer = tray / flyout / sheet. Combobox = autocomplete / autosuggest. This solves the "what is it called" problem across ecosystems.
2. **Definitions that state the job and the difference from siblings**:
   - Dropdown menu holds actions or navigation. It is *not* a form input, unlike Select.
   - Popover opens on click and can hold interactive content, unlike Tooltip.
   - Segmented control is a hybrid of button group, radio buttons and tabs, used to switch options or views.
   - Combobox is a select plus free-text filtering.
3. **Implementations from many design systems per component**, filterable by tech and features (usage guidelines, accessibility). The breadth shows that one component has many acceptable looks, so a "variant" is a legitimate choice, not an error.
4. **The about page warns against copying the popular**: don't assume something is right because it's common (information cascades), and prefer decisions backed by research. This is a design principle we should keep in nunchi too.

## 3. Can it help vibe coders make UI decisions?

Yes, but at different points:

| Decision moment | Source idea that helps |
|---|---|
| "What is this thing called, so I can ask my AI?" | Notion naming principle; Component Gallery canonical name + aliases |
| "Which other shapes could do this job?" | Component Gallery sibling definitions (hybrid, differs from) |
| "Which of these looks fits *this* button?" | Notion one-liners (one primary per screen; red only for irreversible actions; ghost for cancel) |
| "How do I tell the AI to change it?" | Notion prompt formula |
| "Did I forget a state?" | Notion states list (loading/disabled on submit, inline error) |

## 4. Takeaways: adopt / partly adopt / reject

Plug-in points: **Lens** = a candidate rule. **Copy** = board explanation copy. **Knob** = a design-supporter knob or popover option. **Vocab** = component vocabulary.

| # | Idea (source) | Verdict | Plugs into | Reason |
|---|---|---|---|---|
| 1 | Name every flagged element with a canonical component name + aliases (CG, Notion) | **Adopt** | Vocab, Copy | Directly serves "tell your AI precisely". Generic names aren't anyone's IP. We keep our own ~30-entry vocabulary file with a canonical name, aliases and family. |
| 2 | Group alternatives by **job** into families (CG definitions, Notion groups) | **Adopt** | Knob, Vocab | Gives the popover its structure (§5.1). Users pick "a way to choose one of 3" instead of browsing component types. |
| 3 | One-line trade-off per option (Notion image captions) | **Adopt (paraphrased)** | Copy, Knob | Short "when to use" lines are what non-designers need at the moment of choice. We write our own lines (§5.3). |
| 4 | Prompt formula *where + name + count + details* (Notion) | **Adopt** | Change-plan text, fix-loop handoff | Change-plan entries become ready-to-paste AI instructions in a shape users already know. |
| 5 | "One primary per screen" (Notion) | **Partly adopt** | Lens: L4 (design system), new advisory rule | Good heuristic, but some screens legitimately repeat a primary (for example per card). Ship as an advisory finding with a per-screen count; don't block. |
| 6 | "Red only for irreversible actions" (Notion) | **Partly adopt** | Lens: L4 advisory rule, AI-confirmed; Copy | Needs semantics: is the action destructive? Use label heuristics plus AI confirmation. Advisory only. |
| 7 | "Inline field error beats alert" (Notion) | **Partly adopt** | Lens: L2 (states), next to L9 `native-dialog`; Copy | Only detectable if nunchi captures the invalid-submit state. Useful once state capture exists. |
| 8 | States vocabulary; submit → disabled + spinner (Notion) | **Partly adopt** | Copy, future state-capture lens (L2) | We name states in copy now. A detection rule waits for interaction capture. |
| 9 | "AI forgets mobile" (Notion) | **Adopt as copy** | Copy | Supports why nunchi captures every viewport (L10 parity). One line on the board's viewport switcher. |
| 10 | Rank options by popularity (CG example counts) | **Reject** | none | The CG author warns against information cascades. Our ranking is "match your app's own usual" first, then guards. |
| 11 | Embed or link real design-system screenshots as option previews (CG) | **Reject** | none | Third-party screens. The repo rule forbids it. Thumbnails are our own drawings. |
| 12 | Reference-site list: Mobbin, 60fps, MotionSites, Framer (Notion) | **Reject** | none | Galleries of real product screens. Out of scope and against the copy rule. |
| 13 | Scroll-animation vocabulary (Notion) | **Reject for swaps; vocab only** | Vocab (glossary) | Static captures can't judge motion. Keep names in the glossary only. |
| 14 | A specific icon library suggested by the note (Notion) | **Reject for nunchi's own UI drawings** | none | Its licence would permit it, but the rule is our own generic drawings. Users' apps may of course use any icon set. |
| 15 | Korean + English name pairs (Notion tables) | **Adopt (format only)** | Vocab, Copy | Our users are Korean vibe coders prompting AIs, often in English. Show both: `버튼 · Primary button`. |

## 5. Feature B: click an element, see alternatives, swap with one click

### 5.1 Organising alternatives: families by job

Each clickable element resolves to a **component type** (from vocab #1) and that type's **family**. The popover offers these tiers, in this order:

| Tier | Meaning | Example (Button) |
|---|---|---|
| ⓪ **Match usual** | Snap to the app's own dominant version of this component | 44px/4/500 → 40px/8/600 |
| ① **Look** (style knobs) | Size, corners, weight, spacing, colour | S/M/L, corners 0/4/8/16 |
| ② **Variant** (same component, other emphasis) | Filled ↔ outline ↔ text ↔ pill | primary ↔ secondary ↔ ghost |
| ③ **Swap** (sibling component, same job) | Another component that does the same job | button group ↔ segmented control |

Families for the most common components (our own vocabulary, informed by both sources):

| Family (job) | Members | Tier ② variants offered | Tier ③ swaps offered (when) |
|---|---|---|---|
| **Act** — do something | Button, Link, Icon button, FAB | Filled · Outline · Text · Pill; Destructive only if the label looks destructive | Button ↔ Link (inline text only); Icon button ↔ Button with label (when no visible label) |
| **Choose one** | Radio group, Segmented control, Select, Tabs (for views) | Radio: stacked · inline. Segmented: filled · underline | ≤5 short options: Radio ↔ Segmented. >5 or long labels: Select. Switching *views*: Tabs ↔ Segmented |
| **Choose many** | Checkbox group, Chips (multi), Multi-select | Checkbox: stacked · inline | ≤7: Checkboxes ↔ Chips; many: Multi-select / Combobox |
| **On/off** | Toggle, Checkbox | Toggle: with or without label | Toggle (applies instantly) ↔ Checkbox (applies on submit) |
| **Hidden options** | Dropdown menu, Button group, Overflow (⋯) | none | ≤3 actions: Button group ↔ Dropdown menu |
| **Group content** | Card, List row, Table row | Card: shadow · border · flat | List ↔ Card grid ↔ Table (by field count) |
| **Over the page** | Modal, Drawer, Bottom sheet, Popover | Modal: centred · full-screen on mobile | Modal ↔ Drawer (long forms) ↔ Bottom sheet (mobile) ↔ inline section |
| **Navigate** | Tabs, Top nav, Sidebar, Bottom tab bar, Breadcrumb | Tabs: underline · pill | Top nav ↔ Sidebar (by item count); Bottom tab bar on mobile |
| **Tell** | Toast, Alert, Inline error, Banner | Alert: subtle · strong | Field mistake: Alert/Toast → Inline error |

### 5.2 Keeping the choice small for non-designers
1. **At most four option chips visible per row**, and at most two rows open: tier ⓪ plus one more. Everything else sits behind "More looks…" or "Other components that do this job…".
2. **The first line is always the boring right answer**: "Match your usual". It's shown when the clicked element is an outlier, which is the L4-style finding T1 is gated on. Otherwise the first line is "Keep as is".
3. **Filter before showing.** Hide options that fail a guard (contrast, 44px target) or that don't fit the job (no Segmented for 9 options).
4. **Tier ③ is collapsed by default** and only appears when a family rule fires (for example a Select with ≤5 short options).
5. **Explain on hover, not up front.** Each chip has one trade-off line; only the selected chip's line stays visible.
6. **Scope default** = the minimal fix ("make this one match"). "All N like it" is the second radio option.

### 5.3 One-line trade-off copy (our wording, drawn from §2.1 principles)

| Option | Line |
|---|---|
| Match usual | "Same as the button on 9 other pages — users learn it once." |
| Filled | "For the one main action on this screen. Two filled buttons compete." |
| Outline | "For a second, less important action next to a filled one." |
| Text | "For low-stakes actions like Cancel or Back. Easy to miss as a main action." |
| Pill | "Softer, friendlier look. Fits if your other buttons are round too." |
| Destructive | "Red means 'can't undo'. Use it only for deletes and other irreversible actions." |
| Radio | "All options visible at once. Best for 2–5 choices that need reading." |
| Segmented | "Compact and quick for 2–4 short options. Labels must be short." |
| Select | "Saves space for many options, but hides them: one extra tap." |
| Tabs | "Switches whole views, not form values." |
| Toggle | "Takes effect immediately. Use a checkbox if it waits for Save." |
| Card grid | "Scannable and visual. Takes more space than a list." |
| Inline error | "Shows the mistake next to the field to fix. Better than a top alert." |
| Drawer | "Keeps the page in view. Good for long forms or details." |

### 5.4 Icons and thumbnails
- **Option chips** use tiny nunchi-drawn schematics, monochrome and 24×16, drawn in `currentColor`: ■ filled bar, □ outlined bar, — underline, ● capsule, ◉○○ radio, ▭▭▭ segmented, ▾ select. These are about 25 generic SVG glyphs. They sit in a single file so the board can theme them.
- **Tier ③ thumbnails** are wireframe sketches at about 120×72 showing the shape, never a real product. Each is labelled **"Sketch — not your screen"** so it's never mistaken for a preview.
- **Swapping an icon inside the user's icon button** (one reading of the owner's "다른 아이콘들"): nunchi can't know the user's icon set. It offers *direction* instead, for example "use a labelled button instead" or "add a visible label". The AI picks the glyph from the user's own library during apply.

### 5.5 Refined mock-up (live board, `nunchi open`)

```
┌ Screens ▸ /book · Desktop ─────────────────────────────────────────────┐
│  [captured screen]                                                      │
│        ┌───────────────────┐                                            │
│        │ Confirm booking ◉ │ ← clicked                                  │
│        └───────────────────┘                                            │
│   ┌ 버튼 · Primary button  (main action on this screen)   [?] [×] ─┐    │
│   │ ⓪ ★ Match your usual button                                  │    │
│   │    this: 44px · corners 4 · weight 500                        │    │
│   │    usual: 40px · corners 8 · weight 600  (used on 9 routes)   │    │
│   │    "Same as everywhere else — users learn it once."           │    │
│   │ ─ Other looks ───────────────────────────────────────────    │    │
│   │   [■ Filled ✔]  [□ Outline]  [— Text]  [● Pill]               │    │
│   │    ⓘ Outline: "for a second, less important action" —         │    │
│   │      ⚠ this would leave /book with no main action             │    │
│   │ ▸ Fine-tune (size · corners · weight)                         │    │
│   │ ▸ Other components that do this job (0 suggested)             │    │
│   │ Checks  contrast 4.6:1 ✔ · target 44px ✔ · 1 main action ✔    │    │
│   │ Apply to  ● this button (make it match)  ○ all N one-offs     │    │
│   │ [Preview on screen]  [Add to change plan]     Esc = keep      │    │
│   └───────────────────────────────────────────────────────────────┘    │
│  Change plan (1)                                                        │
│   • /book, "Confirm booking" button: primary button, 1 item —           │
│     match the usual button (40px, corners 8, weight 600).               │
└─────────────────────────────────────────────────────────────────────────┘
```

The pegroom figures (44/4/500 against 40/8/600 on 9 routes) are measured. "N one-offs" depends on how the cluster is defined and is not computed yet.

Tier ③ example: a single-choice group with 3 short options shown as a Select.

```
   ┌ 셀렉트 · Select  (choose one · 3 options)                [×] ─┐
   │ ⓪ Keep as is                                                  │
   │ ─ Other components that do this job ───────────────────────  │
   │   [▾ Select ✔]   [◉ Radio list]   [▭▭▭ Segmented]             │
   │   ┌sketch┐       ┌sketch┐         ┌sketch┐                    │
   │   │ ▾ ── │       │ ◉ ── │         │▭│▭│▭ │  Sketch — not your  │
   │   └──────┘       │ ○ ── │         └──────┘  screen             │
   │                  └──────┘                                     │
   │   Segmented: "compact and quick for 2–4 short options"        │
   │ [Try on my screen  (AI, ~30–60 s)]  [Add to change plan]       │
   └───────────────────────────────────────────────────────────────┘
```

Change-plan entries use the prompt formula *where + name + count + details*. They're stored as a plan only. The fix loop applies them, one root cause per commit, then nunchi re-captures and judges. nunchi never edits user code.

### 5.6 Feasibility and effort per swap level

| Level | Preview method | Apply | Feasibility | Effort (estimate) | Main risks |
|---|---|---|---|---|---|
| ⓪ Match usual | Computed-value remap from the app's dominant cluster (concept-preview experiment) | AI + re-capture | **High.** The data already exists from L4 clustering and `nunchi tokens`. | **S**: 2–3 days, on top of the popover shell | Cluster boundaries ("which buttons count as like it"); hover/focus states not previewed |
| ① Look (knobs) | CSS variable override + computed remap, instant | AI + re-capture | **High.** Proven. | **S**: 2–4 days | Tokens vs hard-coded values; contrast recompute per option |
| ② Variant | Element-scoped CSS injection (filled/outline/text/pill; card shadow/border/flat), instant | AI + re-capture | **Medium-high.** Recipes are generic; about 10 recipes cover Act and Group content. | **M**: 1–1.5 weeks | Pseudo-elements, framework class precedence (`!important` scoping), text colour flips, dark mode |
| ③ Swap | Own sketch thumbnails, instant. Optional "Try on my screen": AI implements the swap in a throwaway branch or worktree, then nunchi re-captures (30–60 s). | Fix loop | **Medium.** Sketches are easy; a true preview costs AI time and needs a sandbox policy. | **L**: sketches + family rules 1 week; "try on my screen" 2–3 weeks | Where the trial code lives; latency; keeping a trial out of the real plan until chosen |
| Popover shell + vocab + copy | Board UI, element hit-test from the capture's element boxes | none | **High** | **M**: ~1 week | Mapping a click to a component type, which needs a role/heuristic classifier |

**Verdict**: the owner's request is buildable. Clicking shows other looks and one click puts the change on screen for tiers ⓪–②: as an instant preview, then saved to the plan. Tier ③ shows drawn sketches instantly. A real on-screen result needs an AI trial run of tens of seconds. Suggested order: shell + vocab → ⓪ → ① → ② → ③ sketches → ③ trial.

## 6. Proposed follow-ups (not in this PR)
1. `vocab/components.json`, our own: canonical name, ko/en, aliases, family, one-line trade-off.
2. Advisory lens candidates from #5–#7 (L4, L2), each with a fixture that triggers it and one that does not.
3. ~25 option glyphs and ~12 tier-③ sketches as nunchi-owned SVG.
4. Popover prototype on the live board, using the pegroom `/book` case as the acceptance example.

## 7. Open questions for the owner
1. Component names on the board: Korean first (`버튼 · Primary button`) or English first?
2. Tier ③ "Try on my screen": may the AI create a throwaway branch or worktree in the user's repo for a trial, or is tier ③ sketch-only in 0.1?
3. Should tier ⓪ "Match usual" ship before the full T1 gate on L4? It reuses L4 data but needs no new judgement.
4. Advisory lenses #5–#7: in scope for 0.1-c, or backlog?
5. By "다른 아이콘들", did you mean option thumbnails (§5.4, covered) or swapping glyphs inside icon buttons (direction-only, applied by the AI)?

## Sources
- 바이브코딩 UI 총정리 노트, Notion, @juuouse. https://app.notion.com/p/UI-3d6063ed09fd80ec8b5ef9784079694e (read 2026-10-14 KST)
- The Component Gallery, Iain Bean. https://component.gallery/components/ and its pages button, segmented-control, tabs, select, radio-button, toggle, checkbox, card, navigation, modal, dropdown-menu, combobox, drawer, popover; https://component.gallery/about/ (read 2026-10-14 KST)
