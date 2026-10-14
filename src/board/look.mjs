// The look (owner-approved mock-up v3: grey #F3F4F6 ground, white panels and sidebar, accent #3346C2, severity
// dots with text labels), shared by the static review page (export --html, inlined) and the live board (served as
// /assets/board.css). One stylesheet, so the two never drift apart. No fonts or images from anywhere: system fonts.

export const BASE_CSS = `:root{--ground:#F3F4F6;--panel:#FFFFFF;--line:#E5E7EB;--line-soft:#EEF0F2;--ink:#1B1D21;--ink-2:#4A4E57;--muted:#5F636B;--soft:#F8F9FA;--accent:#3346C2;--accent-ink:#23318F;--accent-soft:#EEF0FB;--seg:#E9EBEF;
--high:#E2650F;--high-soft:#FFF4EB;--high-ink:#8A3B00;--medium:#C9A227;--medium-soft:#FBF3D6;--medium-ink:#6B5300;--low:#A6A9B0;--low-soft:#F1F2F4;--low-ink:#4A4E57;--blocker:#C8102E;--blocker-soft:#FDECEE;--blocker-ink:#9B0C23;--good:#1E6B3A;--good-soft:#E8F5EC;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--ground:#141518;--panel:#1C1E22;--line:#30333A;--line-soft:#2A2C31;--ink:#ECEDEF;--ink-2:#C4C7CD;--muted:#9CA0A8;--soft:#22252A;--accent:#8C9BFF;--accent-ink:#C9D0FF;--accent-soft:#272C4A;--seg:#2A2C31;
--high-soft:#3A2414;--high-ink:#FFB37A;--medium-soft:#352D12;--medium-ink:#E8CC6A;--low-soft:#2A2C31;--low-ink:#C4C7CD;--blocker-soft:#3D1419;--blocker-ink:#FF8A99;--good:#6FCF8E;--good-soft:#16301F;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 var(--sans)}
a{color:var(--accent)}a:hover{color:var(--accent-ink)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
code,.mono{font-family:var(--mono);font-size:.9em;overflow-wrap:anywhere}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600}h2{margin:0;font-size:15px;font-weight:600}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;z-index:10;background:var(--panel);padding:10px 14px}
.muted{color:var(--muted)}.small{font-size:13px}.warn{color:var(--high-ink)}.good{color:var(--good)}.pad{padding:0 18px}
.shell{display:flex;min-height:100vh}
.side{flex:0 0 232px;background:var(--panel);border-right:1px solid var(--line);padding:20px 14px;display:flex;flex-direction:column;gap:20px}
.brand{font-family:var(--mono);font-weight:500;font-size:17px;padding:0 10px}
.runbox{margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font-size:13px}
.runbox b{font-weight:600}
.nav{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nav a{display:flex;justify-content:space-between;align-items:center;min-height:44px;padding:0 10px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:14px}
.nav a:hover{background:var(--soft)}.nav .cnt{color:var(--muted)}
.nav a[aria-current="page"]{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.side-foot{margin-top:auto;padding:0 10px;font-size:12px;color:var(--muted)}
main{flex:1 1 auto;min-width:0;padding:28px 32px 48px}
.stack{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.view{display:none}.view:target{display:block}
body:not(:has(.view:target)):not(:has(.screen-panel:target)) #progress{display:block}
body:has(.screen-panel:target) #screens{display:block}
body:not(:has(.view:target)):not(:has(.screen-panel:target)) .nav a[data-nav="progress"],body:has(#findings:target) .nav a[data-nav="findings"],body:has(.detail:target) .nav a[data-nav="findings"],body:has(#screens:target) .nav a[data-nav="screens"],body:has(.screen-panel:target) .nav a[data-nav="screens"]{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.panel-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.hero h1{font-size:28px}.eyebrow{margin:0 0 4px;font-size:14px;color:var(--muted)}
.hero-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:16px}.hero-top p{margin:4px 0 0}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:8px;font-weight:600;text-decoration:none}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{color:#fff;filter:brightness(.92)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.tile{display:flex;flex-direction:column;gap:2px;padding:14px 16px;min-height:44px;border-radius:10px;background:var(--soft);color:var(--ink);text-decoration:none}
.tile-high{background:var(--high-soft);box-shadow:inset 0 0 0 1px #F6CBA8}.tile-blocker{background:var(--blocker-soft);box-shadow:inset 0 0 0 1px #F2B8C1}
.tile-n{font-size:28px;font-weight:500}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.facts{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:14px}
.meter-row{display:flex;justify-content:space-between;font-size:14px}
.meter{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.meter span{display:block;height:6px;background:var(--good)}
.statuses{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:10px 18px;font-size:14px}
.sev{display:inline-flex;align-items:center;gap:6px;padding:1px 10px 1px 8px;border-radius:999px;font-size:13px;font-weight:600;white-space:nowrap}
.sev .dot{width:8px;height:8px;border-radius:50%;flex:none}
.sev-blocker{background:var(--blocker-soft);color:var(--blocker-ink)}.sev-blocker .dot{background:var(--blocker)}
.sev-high{background:var(--high-soft);color:var(--high-ink)}.sev-high .dot{background:var(--high)}
.sev-medium{background:var(--medium-soft);color:var(--medium-ink)}.sev-medium .dot{background:var(--medium)}
.sev-low{background:var(--low-soft);color:var(--low-ink)}.sev-low .dot{background:var(--low)}
.tag,.st{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--low-soft);color:var(--low-ink)}
.tag-ai{background:var(--accent-soft);color:var(--accent-ink)}.tag-warn{background:var(--high-soft);color:var(--high-ink)}
.st-open{background:var(--panel);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}.st-regressed{background:var(--high-soft);color:var(--high-ink)}
.st-to-fix{background:var(--accent-soft);color:var(--accent-ink)}.st-fixed{background:var(--good-soft);color:var(--good)}
.head-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}.head-row p{margin:2px 0 0}
fieldset.seg{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:4px;border:0;border-radius:10px;background:var(--seg);align-self:flex-start;min-width:0}
.seg input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.seg label{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:7px;font-size:14px;color:var(--ink-2);cursor:pointer}
.seg input:checked+label{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.12)}
.seg input:focus-visible+label{outline:3px solid var(--accent);outline-offset:1px}
.seg .cnt{color:var(--muted);font-weight:400}
.seg-legend{float:left;align-self:center;padding:0 8px 0 6px;font-size:13px;color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:8px}
.list-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.kind+.kind,.list-box>.empty{border-top:1px solid var(--line-soft)}
.kind>summary,.unchecked-sum{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px;padding:8px 20px;background:var(--soft);cursor:pointer;list-style:none}
.kind>summary::-webkit-details-marker,.unchecked-sum::-webkit-details-marker{display:none}
.kind>summary::before,.unchecked-sum::before{content:"▸";color:var(--muted);margin-right:-4px}.kind[open]>summary::before,.unchecked[open]>.unchecked-sum::before{content:"▾"}
.kind-title{flex:1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:600;font-size:14px}
.rows{margin:0;padding:0;list-style:none}
.row a{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 14px;padding:12px 20px;border-top:1px solid var(--line-soft);color:var(--ink);text-decoration:none;min-height:44px}
.row a:hover{background:var(--accent-soft)}
.row-main{flex:1 1 300px;min-width:0;display:flex;flex-direction:column;gap:2px}.row-what{font-weight:500;overflow-wrap:anywhere}.row-where{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.row-tags{display:flex;flex-wrap:wrap;gap:6px}
.empty{display:none;margin:0;padding:16px 20px;color:var(--muted)}
.unchecked .kind{border-top:1px solid var(--line-soft)}.unchecked>p{margin:10px 0}
.clean-note{margin:0;padding:18px 20px;background:var(--good-soft);color:var(--good);border-radius:12px;font-weight:600}
.detail-nav{max-width:1000px;margin:0 auto 12px;display:flex;justify-content:space-between;gap:12px;font-size:14px}
.detail-nav a{display:inline-flex;align-items:center;min-height:44px}.pn{display:flex;gap:16px}
.detail-box{max-width:1000px;margin:0 auto}
.detail-head h1{font-size:22px;line-height:1.3;overflow-wrap:anywhere}.chips{margin:0 0 6px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}
.fig p{margin:0 0 6px}
.detail:has(.vt-m:checked) .fig-d,.detail:has(.vt-d:checked) .fig-m{display:none}
.shot{position:relative;width:100%;background-repeat:no-repeat;background-size:100% auto;background-color:var(--soft);border-radius:8px;box-shadow:0 0 0 1px var(--line)}
.fig-m .shot,.shot-m{max-width:390px;margin:0 auto}
.box{position:absolute;border:2px dashed #1B1D21;box-shadow:0 0 0 2px #FFFFFF;border-radius:3px;min-width:6px;min-height:6px}
.num{position:absolute;left:-11px;top:-11px;width:20px;height:20px;border-radius:50%;background:#1B1D21;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff}
.whole{margin-top:8px}.whole summary,.evidence summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--ink-2)}
.facts-dl{margin:0;display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 16px;font-size:14px}
.facts-dl dt{color:var(--muted)}.facts-dl dd{margin:0;overflow-wrap:anywhere}
.evidence{border-top:1px solid var(--line-soft);padding-top:4px}
.decide{max-width:1000px;margin:16px auto 0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 24px;display:flex;flex-direction:column;gap:8px}
.decide p{margin:0}.cmds{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.cmds li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.cmd-label{flex:0 0 180px;display:flex;flex-direction:column}
.cmd{flex:1 1 260px;padding:8px 10px;background:var(--soft);border:1px solid var(--line);border-radius:6px;user-select:all}
.copy{display:none;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.js .copy{display:inline-block}
.facts-inline{margin:0;display:flex;flex-wrap:wrap;gap:6px 18px;font-size:14px;color:var(--ink-2)}
.wall-wrap{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.wall{flex:999 1 520px;min-width:0;margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px}
.card a{display:block;height:100%;background:var(--panel);border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line);color:var(--ink);text-decoration:none}
.card a:hover{box-shadow:0 0 0 2px var(--accent)}
.thumb-wrap{position:relative;display:block}
.thumb{display:block;width:100%;aspect-ratio:16/10;background-size:cover;background-position:top center;background-color:var(--soft);border-bottom:1px solid var(--line-soft)}
.thumb-m{aspect-ratio:4/5}.thumb-none{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px}
.badge{position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.16)}
.badge-blocker{background:#FDECEE;color:#9B0C23}.badge-high{background:#FFF4EB;color:#8A3B00}.badge-medium{background:#FBF3D6;color:#6B5300}.badge-low{background:#F1F2F4;color:#4A4E57}.badge-clean{background:#E8F5EC;color:#1E6B3A}.badge-dark{background:#1B1D21;color:#fff}
.card-body{display:flex;flex-direction:column;gap:1px;padding:10px 12px 12px}.card-name{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.panels{flex:1 1 340px;max-width:460px;position:sticky;top:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panels-empty{margin:0;padding:18px}.panels:has(.screen-panel:target) .panels-empty{display:none}
.screen-panel{display:none}.screen-panel:target{display:block}
.sp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:14px 18px;border-bottom:1px solid var(--line-soft)}
.sp-head p{margin:2px 0 0}.sp-head a{display:inline-flex;align-items:center;min-height:44px;font-size:14px}
.screen-panel .shot{border-radius:0;box-shadow:none}
.sp-list{margin:0;padding:6px 0;list-style:none}
.sp-list a{display:flex;gap:10px;padding:10px 18px;min-height:44px;color:var(--ink);text-decoration:none}.sp-list a:hover{background:var(--accent-soft)}
.numb{flex:none;width:22px;height:22px;border-radius:50%;background:#1B1D21;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center}
.numb-none{background:var(--low-soft);color:var(--muted)}
.sp-text{display:flex;flex-direction:column;min-width:0}.sp-what{font-size:14px;font-weight:500;overflow-wrap:anywhere}.sp-text .small{color:var(--muted)}
.sp-sibs{padding:0 18px;border-top:1px solid var(--line-soft);background:var(--soft)}.sp-sibs summary{min-height:44px;display:flex;align-items:center;cursor:pointer}
.sp-sibs p{margin:0 0 10px;display:flex;flex-wrap:wrap;gap:4px 14px}.sp-sibs a{display:inline-flex;align-items:center;min-height:32px}
.view:focus,.screen-panel:focus{outline:none}
@media (max-width:760px){.shell{flex-direction:column}.side{flex:none;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px;gap:10px}
.side-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.brand{padding:0}.runbox{padding:4px 8px}
.nav{flex-direction:row;flex-wrap:wrap}.nav a{flex:1 1 auto;justify-content:center;gap:6px}.side-foot{display:none}
main{padding:16px 16px 40px}.panel-box{padding:18px 16px}.hero h1{font-size:22px}.facts-dl{grid-template-columns:1fr;gap:2px}.facts-dl dd{margin-bottom:8px}
.panels{max-width:none;position:static}.cmd-label{flex-basis:100%}.cmd{flex:1 1 0;min-width:0}.seg-legend{float:none;width:100%;padding:2px 6px}}
@media (prefers-color-scheme:dark){.btn-primary,.btn-primary:hover{color:#141518}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

// The live board's additions (design §3.4): the decision bar, tabs, the list as a listbox, banners, the undo toast,
// dialogs, label mode. Views are rendered one at a time by the page's script, so the static page's :target rules are
// switched off here. Every control is at least 44 px high; motion is off when the person asks for less of it.
export const BOARD_CSS = `
[hidden]{display:none!important}
/* the edge of a control (field, button, decision button, tick box): 3:1 or more against the panel, the ground and
   the selected row, light and dark (WCAG 1.4.11) */
:root{--control:#7A7F88}
/* the static page marks its view by :target; the board by aria-current only */
.board .nav a[data-nav]:not([aria-current="page"]){background:transparent!important;color:var(--ink)!important;font-weight:400!important}
.board .nav a[data-nav]:not([aria-current="page"]):hover{background:var(--soft)!important}
.board .view{display:block}.board .detail{display:block}
.board h1[tabindex="-1"]:focus,.board h2[tabindex="-1"]:focus{outline:none}
/* links that stand alone are targets like any control: 44 px (the skip link, "4 of 5" screens checked) */
.board .skip:focus{display:inline-flex;align-items:center;min-height:44px}
.board .meter-row a{display:inline-flex;align-items:center;min-height:44px;min-width:44px;justify-content:flex-end}
.board .meter-row{align-items:center}
button{font:inherit;color:inherit}
.b{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;min-width:44px;padding:0 14px;border:1px solid var(--control);border-radius:8px;background:var(--panel);color:var(--ink);font-size:14px;cursor:pointer;text-decoration:none}
.b:hover{background:var(--soft)}.b[disabled]{opacity:.55;cursor:not-allowed}
.b-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}.b-primary:hover{background:var(--accent);filter:brightness(.92);color:#fff}
.b-quiet{border-color:transparent;background:transparent;color:var(--accent)}.b-quiet:hover{background:var(--accent-soft)}
.kbd{display:inline-block;min-width:20px;padding:0 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;background:var(--soft);color:var(--ink-2);font:12px/18px var(--mono);text-align:center}
.side-foot a{color:var(--muted)}.side-foot button{min-height:44px;min-width:44px;padding:0;border:0;background:none;color:var(--accent);font-size:12px;cursor:pointer;text-decoration:underline}
.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:var(--seg);align-self:flex-start}
.tabs [role=tab]{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--ink-2);font-size:14px;cursor:pointer}
.tabs [role=tab][aria-selected=true]{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.12)}
.tabs .cnt{color:var(--muted);font-weight:400}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.field{display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--ink-2)}
.field select,.field input{min-height:44px;padding:0 10px;border:1px solid var(--control);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;font-size:14px}
.field input{min-width:220px}
.banner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;border-radius:10px;background:var(--accent-soft);color:var(--accent-ink);font-size:14px}
.banner-warn{background:var(--high-soft);color:var(--high-ink)}
.sect+.sect{border-top:1px solid var(--line-soft)}
.sect-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;min-height:44px;padding:4px 12px 4px 20px;background:var(--soft)}
.sect-head h2{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:14px}
.board .rows{outline:none}
.board .row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px 14px;padding:12px 20px;border-top:1px solid var(--line-soft);min-height:44px;cursor:pointer}
.board .row:hover{background:var(--soft)}
.board .row[aria-selected=true]{background:var(--accent-soft);box-shadow:inset 4px 0 0 var(--accent)}
.board .row:focus{outline:3px solid var(--accent);outline-offset:-3px}
.row .tick{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:2px solid var(--control);border-radius:5px;color:transparent;font-size:14px;line-height:1}
.row[aria-selected=true] .tick{border-color:var(--accent);background:var(--accent);color:#fff}
.tag-human{background:var(--good-soft);color:var(--good)}
/* the dock: the decision bar, and the undo toast right above it, kept at the bottom of the window as one; focus and
   scrolling stay clear of it (its height is --dock-h, measured by the page) */
html{scroll-padding-bottom:calc(var(--dock-h,0px) + 12px)}
.dock{position:sticky;bottom:0;z-index:5;display:flex;flex-direction:column;gap:8px}
.toolbar{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 -2px 10px rgba(27,29,33,.08)}
.toolbar .tb-label{align-self:center;padding:0 6px;font-size:13px;color:var(--muted)}
.dbtn{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:0;min-height:52px;min-width:44px;padding:4px 14px;border:1px solid var(--control);border-radius:8px;background:var(--panel);cursor:pointer;text-align:left}
.dbtn:hover{background:var(--soft)}.dbtn b{font-size:14px}.dbtn small{font-size:12px;color:var(--muted)}
.dbtn .kbd{margin-left:6px}
.dbtn-fix{border-color:var(--accent)}
.toast{position:fixed;left:50%;bottom:16px;z-index:20;transform:translateX(-50%);display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;max-width:min(680px,calc(100vw - 32px));padding:8px 8px 8px 18px;border-radius:12px;background:#1B1D21;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .2s}
.toast .b{background:transparent;border-color:#858A93;color:#fff}.toast .b:hover{background:#2C2F35}.toast :focus-visible{outline-color:#FFFFFF}
.toast[hidden]{display:none}
.dock>.toast{position:static;transform:none;align-self:center;max-width:100%}
/* the numbered markers sit half outside their box: room for them inside the panel */
.board .screen-panel .shot{width:calc(100% - 24px);margin:12px}
dialog{max-width:min(560px,calc(100vw - 32px));padding:22px 24px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink)}
dialog::backdrop{background:rgba(27,29,33,.45)}
dialog h2{font-size:17px;margin:0 0 10px}.dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}
.keys{width:100%;border-collapse:collapse;font-size:14px}.keys td{padding:6px 8px;border-top:1px solid var(--line-soft)}.keys td:first-child{white-space:nowrap}
.check{display:flex;align-items:center;gap:10px;min-height:44px;font-size:14px}.check input{width:20px;height:20px}
.confirm-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.confirm-list li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:10px 12px;border:1px solid var(--line-soft);border-radius:8px}
.confirm-list .what{flex:1 1 260px;display:flex;flex-direction:column;gap:2px;min-width:0}
.now{margin:0;padding:0;list-style:none;font-size:14px;color:var(--ink-2)}
.handoff{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;border-radius:10px;background:var(--good-soft);color:var(--good);font-weight:600}
.copyline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.copyline code{padding:8px 10px;background:var(--soft);border:1px solid var(--line);border-radius:6px}
.fig-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.fig-tools .seg-b{display:inline-flex;gap:4px;padding:4px;border-radius:10px;background:var(--seg)}
.seg-b button{min-height:44px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--ink-2);cursor:pointer;font-size:14px}
.seg-b button[aria-pressed=true]{background:var(--panel);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(27,29,33,.12)}
.history{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:14px}
.history li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.needs{padding:14px 16px;border-radius:10px;background:var(--high-soft);color:var(--high-ink);display:flex;flex-direction:column;gap:8px}
.needs .actions{display:flex;flex-wrap:wrap;gap:8px}
.lost{max-width:640px;margin:10vh auto;padding:28px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.label-banner{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;padding:12px 18px;border-radius:12px;background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.label-keys{display:flex;flex-wrap:wrap;gap:8px}
.board .card{list-style:none}.board .card button{display:block;width:100%;height:100%;padding:0;border:0;background:var(--panel);border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--control);color:var(--ink);text-align:left;cursor:pointer}
.board .card button:hover,.board .card button[aria-pressed=true]{box-shadow:0 0 0 3px var(--accent)}
.board .panels .screen-panel{display:block}
.empty-note{margin:0;padding:16px 20px;color:var(--muted)}
.loading{padding:24px;color:var(--muted)}
/* the live status: "Reconnecting…" while the board does not answer (empty, it takes no room) */
.live-status{margin:0;padding:4px 10px;border-radius:8px;background:var(--high-soft);color:var(--high-ink);font-size:13px;font-weight:600}.live-status:empty{display:none}
@media (max-width:760px){.board .side-foot{display:flex;flex-wrap:wrap;align-items:center;padding:0}.board .side-foot p{margin:0}.board .side-foot p:first-child{display:none}
.board .side-foot button{min-width:44px;font-size:14px}.field input{min-width:0;width:100%}.toolbar{gap:6px;padding:6px}.toolbar .tb-label{display:none}.dbtn{flex:1 1 40%;min-height:48px;padding:2px 10px}}
/* a short window (420 px or less: a phone on its side, 200% zoom at 640 × 360): the dock keeps its buttons in one row
   without their sub-labels, and the toast on one line, so it covers about a third of the window, not half */
@media (max-height:420px){.toolbar{flex-wrap:nowrap;gap:6px;padding:6px}.toolbar .tb-label{display:none}.dbtn{flex:1 1 0;min-width:0;min-height:44px;padding:2px 10px}.dbtn small{display:none}.dbtn b{white-space:nowrap}
.dock{gap:6px}.toast,.dock>.toast{flex-wrap:nowrap;gap:8px;padding:4px 4px 4px 14px}.toast>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toast .b{flex:none;white-space:nowrap}}
@media (prefers-color-scheme:dark){.b-primary,.b-primary:hover{color:#141518}
/* the toast is light on the dark board, so it stands out from the panel and the ground (3:1 or more) */
.toast{background:#ECEDEF;color:#141518}.toast .b{color:#141518;border-color:#6B7079}.toast .b:hover{background:#D9DBDF}.toast :focus-visible{outline-color:#141518}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
