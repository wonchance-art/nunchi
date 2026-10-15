// The look of the board's Coverage and Screen detail views and the wall's new parts (M7), served after BASE_CSS and
// BOARD_CSS in /assets/board.css. The live board's only: the static export (export --html) does not inline it, so its
// bytes do not change. The same tokens as the v3 look: marks repeat their shape in colour (good, medium, low and high
// ink), never colour alone; every control 44 px; no sideways scroll at 390 px; the map is a list below 760 px.
export const VIEWS_CSS = `
.board .seg-b{display:inline-flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:var(--seg)}
/* the pressed button of a segmented control: a 2 px edge in ink-2 (3:1 and more on its background and on the group's,
   both themes), not only a lighter fill and bold text (review of PR #35; M2's controls too) */
.board .seg-b button[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--ink-2)}
.seg-b .cnt{color:var(--muted);font-weight:400}
.cv-fl{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.link-44{display:inline-flex;align-items:center;min-height:44px}
/* a select whose options are long (a fix's title) shrinks to its row, never wider than the window */
.board .field{max-width:100%;min-width:0}.board .field select{max-width:100%;min-width:0;flex:0 1 auto}
.keys-h{font-size:14px;margin:16px 0 4px}
.fig-where{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px}
/* Coverage: the totals */
.cv-totals{margin:0;gap:10px}
.cv-row{display:grid;grid-template-columns:170px minmax(0,1fr);gap:2px 16px;align-items:center;font-size:14px}
.cv-row dt{color:var(--muted)}.cv-row dd{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;overflow-wrap:anywhere}
.cv-row .meter{flex:1 1 160px;max-width:360px}.cv-num{font-weight:600}
/* Coverage: what wasn't checked */
.cv-gaps h2{display:flex;flex-wrap:wrap;align-items:baseline;gap:0}.cv-count{margin-left:auto;padding:0 10px;border-radius:999px;background:var(--soft);font-weight:600}
.cv-gap-list{list-style:none;margin:0;padding:0}
.cv-gap{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line-soft)}
.cv-mark{flex:none;width:20px;text-align:center;font-weight:600;color:var(--ink-2)}
.cv-gap-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.cv-gap-body p{margin:0}
.cv-gap-line{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 16px;font-size:14px}.cv-gap-line b{font-weight:600}
.cv-where{font-size:13px;overflow-wrap:anywhere}
.cv-say{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:14px}
.cv-found{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px}
.cv-fine-h{font-size:14px;margin:10px 0 0;color:var(--ink-2)}
.cv-muted{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:6px 0 0}
/* Coverage: the map */
.cv-legend{margin:0;display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--ink-2)}
.cv-mk,.cv-mark{font-family:"Apple Symbols","Segoe UI Symbol","DejaVu Sans","Noto Sans Symbols 2",sans-serif;font-weight:700}
.cv-mk-full,.cv-mk-ok{color:var(--good)}.cv-mk-partly{color:var(--medium-ink)}.cv-mk-rules,.cv-mk-none{color:var(--ink-2)}.cv-mk-not{color:var(--high-ink)}
.cv-body{display:flex;flex-direction:column;gap:16px}
.cv-grid-wrap{min-width:0}
.cv-grid{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px}
.cv-grid th,.cv-grid td{padding:4px 8px;border-top:1px solid var(--line-soft);text-align:left;vertical-align:middle;overflow-wrap:anywhere}
.cv-grid thead th{border-top:0;font-size:12px;font-weight:600;color:var(--ink-2);overflow-wrap:normal;word-break:normal}
.cv-grid .cv-page-h{width:26%}
.cv-page{font-weight:400}.cv-page .mono{display:block}.cv-name{display:block;font-size:12px;color:var(--muted)}
.cv-cell{height:44px;cursor:pointer;border-radius:4px}
.cv-cell:hover{background:var(--soft)}
.cv-cell:focus{outline:3px solid var(--accent);outline-offset:-3px}
.cv-cell.cv-sel{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.cv-cell-not{color:var(--ink-2);cursor:default}
.cv-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.cv-panel .sp-head h2{overflow-wrap:anywhere}
.cv-pscene{padding:12px 18px;border-top:1px solid var(--line-soft);display:flex;flex-direction:column;gap:8px}
.cv-pscene:first-of-type{border-top:0}.cv-pscene p{margin:0}
.cv-panel .facts-dl{grid-template-columns:100px minmax(0,1fr);align-items:center}
.cv-lenses{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:13px}
.cv-lenses li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 12px;padding:2px 0;border-top:1px dotted var(--line)}
.cv-ln{color:var(--ink-2)}
@media (min-width:1280px){.cv-body:not(.cv-all){flex-direction:row;align-items:flex-start}.cv-body:not(.cv-all)>.cv-grid-wrap{flex:1 1 auto}
.cv-body:not(.cv-all)>.cv-panel{flex:0 0 340px;position:sticky;top:16px}}
/* Coverage on a phone: the map as a list of pages */
.cv-list{list-style:none;margin:0;padding:0}
.cv-page-d{border-top:1px solid var(--line-soft)}
.cv-page-d>summary{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:2px 10px;min-height:44px;padding:4px 0;cursor:pointer;list-style:none;font-size:14px;overflow-wrap:anywhere}
.cv-page-d>summary::-webkit-details-marker{display:none}
.cv-page-d>summary::before{content:"▸";color:var(--muted);margin-right:-4px}.cv-page-d[open]>summary::before{content:"▾"}
.cv-page-d>summary>span:first-of-type{flex:1 1 auto;min-width:0}
.cv-sum{white-space:nowrap}
.cv-lines{list-style:none;margin:0;padding:0 0 8px 14px}
.cv-line{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:0 10px;width:100%;min-height:44px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--ink);font-size:14px;text-align:left;cursor:pointer}
.cv-line:hover{background:var(--soft)}
.cv-other{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 10px;padding:8px}
.cv-panel-li .cv-panel{margin:4px 0 8px}
/* Coverage: by lens */
.cv-lens{width:100%;border-collapse:collapse;font-size:14px}
.cv-lens th,.cv-lens td{padding:8px;border-top:1px solid var(--line-soft);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.cv-lens thead th{border-top:0;font-size:12px;color:var(--ink-2)}.cv-lens tbody th{font-weight:500}
.cv-lens-d>summary{display:flex;align-items:center;min-height:44px;cursor:pointer;font-weight:600;list-style:none}.cv-lens-d>summary::-webkit-details-marker{display:none}
.cv-lens-d>summary::before{content:"▸";color:var(--muted);margin-right:8px}.cv-lens-d[open]>summary::before{content:"▾"}
.cv-lens-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}.cv-lens-list li{display:flex;flex-direction:column;gap:2px}
/* a narrow window (a phone, 200% zoom): every row of the totals stays, stacked */
@media (max-width:760px){.cv-row{grid-template-columns:minmax(0,1fr)}.cv-row .meter{flex-basis:100%;max-width:none}}
/* Screens: the wall's groups and its quick look */
.wall-groups{flex:999 1 520px;min-width:0;display:flex;flex-direction:column;gap:18px}
.wall-g-h{margin:0 0 8px;font-size:14px;color:var(--ink-2);overflow-wrap:anywhere}
.sp-open{margin:0;padding:6px 18px 14px}
/* Screen detail */
.sd .detail-nav,.sd-box{max-width:1180px}
.sd .pn{align-items:center;flex-wrap:wrap}
.sd-head h1{font-size:22px;line-height:1.3;overflow-wrap:anywhere}.sd-head p{margin:0}
.badge-inline{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.sd-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.sd-tl{margin-left:6px}.sd-tl:first-child{margin-left:0}.sd-hint{margin-right:4px}
.sd-body{display:flex;gap:20px;align-items:flex-start}
.sd-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}.sd-same{margin:0 12px}
.sd-figs{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:16px}
.sd-figs.sd-both{flex-direction:row;align-items:flex-start}.sd-both>.sd-fig:first-child{flex:3 1 0;min-width:0}.sd-both>.sd-fig:last-child{flex:1 1 0;min-width:0}
.sd-fig{margin:0;display:flex;flex-direction:column;gap:6px;min-width:0}.sd-fig p{margin:0}
.sd-fig .shot{width:calc(100% - 24px);margin:12px}
.sd-cap{font-weight:600;color:var(--ink-2)}
.sd-sbs{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sd-sbs figure{margin:0;min-width:0}
.sd-side{flex:0 0 340px;min-width:0;display:flex;flex-direction:column;gap:8px}.sd-side h2{font-size:15px}.sd-side p{margin:0}
.sd-list a{padding:10px 8px}
.sd-h3{font-size:14px;margin:8px 0 0}
.sd-fixed{list-style:none;margin:0;padding:0;font-size:14px;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.sd .sp-sibs{padding:0 12px;border-radius:8px}
.sd-sibs-list{list-style:none;margin:0;padding:0 0 8px;display:flex;flex-direction:column}
.sd-sibs-list a{display:flex;align-items:center;min-height:44px}
.box.box-on{border:4px solid #1B1D21;box-shadow:0 0 0 2px #FFFFFF}
.box.box-on .num{background:#FFFFFF;color:#1B1D21;box-shadow:0 0 0 2px #1B1D21}
.num.num-stack{width:auto;min-width:20px;padding:0 6px;border-radius:10px;white-space:nowrap}
@media (max-width:1100px){.sd-body{flex-direction:column;align-items:stretch}.sd-side{flex:none;width:100%}}
/* the list's numbers look like the markers on the screenshot (ringed), in the dark too */
@media (prefers-color-scheme:dark){.board .sp-list .numb{box-shadow:0 0 0 2px #FFFFFF}}
@media (max-width:760px){.sd-figs.sd-both{flex-direction:column}.sd-both>.sd-fig{width:100%}.sd-sbs{grid-template-columns:1fr}.sd-hint{display:none}}
/* forced colours (Windows contrast themes): the selected cell, the edges of segmented buttons and the pressed one, and
   the markers keep their own drawing (their dark disc and white ring read on any screenshot) */
@media (forced-colors:active){
.cv-cell.cv-sel{outline:3px solid Highlight;outline-offset:-3px}
.board .seg-b{border:1px solid ButtonText}.board .seg-b button{border:1px solid ButtonText}
.board .seg-b button[aria-pressed=true]{background:Highlight;color:HighlightText;forced-color-adjust:none}
.box,.num,.numb{forced-color-adjust:none}}
`;
