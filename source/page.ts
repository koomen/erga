// The Factory page, /admin/factory (worker/source.ts), for admins with admin
// access: the one place to manage Erga's own source, its deploys and
// the factory's tasks. Three parts, on one page: the factory's task board
// (factory/page.ts), the source and deploy dashboard (below), and the
// factory's agent (factory/agent.ts; its panel is src/page/factory-agent.ts,
// built to /factory-agent.js). It has the layout every admin page shares
// (admin-layout.ts): the breadcrumb, Share with agent (upper right, as in the
// editor) and the sidebar, which collapses so the board gets the full width.
// The agent is the layout's, as on every admin page: on a wide window it sits
// on the left, as in the editor, and the board and the dashboard are beside
// it, one above the other; as in the editor, the user drags the agent by its
// head to the right, and its inner edge to resize it (admin-layout.ts;
// src/page/layout.ts, mountPaneLayout); narrower, tabs show one at a time. Each part's stylesheet is scoped to its pane
// (scopeCss). /source, /admin/source and /admin/deploys redirect here.
//
// The dashboard:
//
// One list: staging's history, newest first (staging is always at or ahead
// of main, so it holds every commit main has). When staging is far ahead, a
// break ("… N more commits only on staging …") leaves commits out: above it,
// staging's head and the 10 before it; below it, the 5 commits just after
// main's head, then main's head and the 5 before it. The break shows only
// when it leaves at least one commit out (17 or more ahead). Beside it, one dot column,
// with no header: every commit listed is on staging; a solid green circle is
// on main too, a hollow orange circle only on staging. Then two deploy
// columns, staging and production: each target's deploys (GET
// /api/deploys?history=100), one beside each commit it deployed: its state
// as plain text (live, deployed, failed, cancelled, or running) and when.
// A commit deployed more than once shows one deploy: the running one, else
// the live one, else the newest (a redeploy cancels the attempt before it).
// Only the live deploy has a background. Each target's status is in its column's head. Any deploy opens
// its log, past or live (GET /api/deploys/<name>/log?deploy=<id>, then
// { type: "deploy-log" } events). Merge moves main forward to staging's
// head, or to the commit a row's "Merge to here" names, only when that
// commit's full test run passed: the tests column (the production gate,
// deploy/gate.ts: GET /api/gate, { type: "gate" } events) shows each commit's
// run (running, passed, failed, cancelled); a click opens it (its shards,
// failed and flaky files, each shard's log, and Run again). Merge is off,
// with the reason, until the commit is green; "Merge to newest green" moves
// main to the newest staging commit that passed, when staging's head hasn't;
// Override (an admin in a browser, with a reason for the change log) is the
// emergency way past it. Also how to clone and
// push (staging moves only by the factory's Merge, one squash commit for each
// task, which shows as the task's card; "Allow a push to staging", an admin in
// a browser with a reason, is the emergency way past that rule), and the GitHub mirror's status (in the board's status row; a click
// opens a dialog: the mirror's state and Push now, or how to turn it on). It updates by itself (/api/events) and
// follows the system's light or dark.

import { esc, page as plainPage, type Session } from "../front";
import { adminResponse } from "../admin-layout";
import { BOARD_SCRIPT, BOARD_STYLE, boardMarkup } from "../factory/page";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether the factory is on (the `factory` setting). */
  factory: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  origin: string;
  mirrorUrl: string;
  /** This server's Worker (deploy/targets.ts), for the GitHub mirror's setup steps; null when it isn't one of Erga's targets. */
  worker: string | null;
}

const SOURCE_STYLE = `
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --bad: #ff8a65; }
  .pane-head { justify-content: space-between; }
  .head-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .head-actions:not(:has(> :not([hidden]))) { display: none; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  .merge-row[hidden], #merge-hint:empty { display: none; }
  #merge-hint { margin: -4px 0 10px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  @media (max-width: 640px) { .pane-head { flex-direction: column; align-items: stretch; gap: 10px; } .merge-row { justify-content: space-between; } .merge-row .count { white-space: normal; flex: 1; min-width: 0; } #merge-hint { margin-top: -6px; text-align: left; } }
  .card { padding: 0 0 10px; min-width: 0; background: var(--bg); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 4px 6px; font-size: 12px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  /* The dots: circles only. Hollow orange, only on staging; solid green, on main. */
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; flex: none; }
  .dot.staging-only { background: var(--bg); border: 2px solid var(--only-staging); }
  .dot.on-main { background: var(--on-main); border: 2px solid var(--on-main); }
  .grid { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto 70px 100px 132px 132px; align-items: center; }
  .grid > .head { position: sticky; top: 0; z-index: 2; background: var(--bg); height: 44px; display: flex; align-items: flex-end; padding-bottom: 6px; box-sizing: border-box; border-bottom: 1px solid var(--rule);
    font-size: 11.5px; font-weight: 600; letter-spacing: .02em; color: var(--soft); white-space: nowrap; }
  .grid > .head.deploy { justify-content: flex-start; padding-left: 2px; }
  .target { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; max-width: 144px; border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .target:hover { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .target b { font-weight: 650; color: var(--fg-strong); font-size: 11.5px; }
  .target .st { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; font-size: 11.5px; }
  .target .st i { width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); }
  .target.deployed .st i { background: var(--on-main); }
  .target.failed .st { color: var(--bad); }
  .target.failed .st i { background: var(--bad); }
  .target.cancelled .st i { background: transparent; border: 1.5px dashed var(--chrome); width: 4px; height: 4px; }
  .target.building .st i, .target.deploying .st i { background: transparent; border: 2px solid var(--only-staging); border-right-color: transparent; width: 5px; height: 5px; animation: spin .8s linear infinite; }
  .target[disabled] { cursor: default; }
  .target[disabled]:hover { background: transparent; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .row { display: contents; }
  .row > * { height: var(--row); display: flex; align-items: center; transition: background-color .15s; }
  .row:hover > * { background: color-mix(in srgb, var(--chrome) 8%, transparent); }
  .rail { position: relative; justify-content: center; }
  .rail::before, .rail::after { content: ""; position: absolute; left: calc(50% - 1px); width: 2px; height: 50%; display: none; opacity: .4; }
  .rail::before { top: 0; } .rail::after { bottom: 0; }
  .rail::before, .rail::after { background: var(--only-staging); }
  .rail.on-main::before, .rail.on-main::after { background: var(--on-main); }
  .rail.up::before, .rail.down::after { display: block; }
  .rail .dot { position: relative; z-index: 1; }
  .subj { min-width: 0; padding: 0 8px 0 6px; gap: 8px; }
  .subj span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--fg-strong); }
  .row.on-main .subj span { color: var(--fg); }
  .subj .here { flex: none; display: none; height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); cursor: pointer; }
  .task-card .here { flex: none; display: none; height: 20px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); cursor: pointer; }
  .row.staging-only:hover .subj .here, .subj .here:focus-visible, .row.staging-only:hover .task-card .here, .task-card .here:focus-visible { display: inline-flex; align-items: center; }
  .who { padding: 0 8px; font-size: 12px; color: var(--soft); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sha { padding: 0 6px; font: 11.5px var(--font-mono); color: var(--chrome); }
  .row time { margin: 0; justify-content: flex-end; padding-right: 8px; font-size: 12px; color: var(--soft); }
  /* A deploy, beside the commit it deployed: its state as plain text, then when. Colour only where it says something:
     muted for deployed, red for failed, orange with a turning dot while it runs, struck through for cancelled.
     Only the live one has a background: a low-contrast rounded rectangle. */
  .deps { min-width: 0; padding: 0 6px 0 2px; }
  .dep { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 22px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent;
    color: var(--soft); font: 500 12px var(--font-text); text-align: left; white-space: nowrap; cursor: pointer; }
  .dep:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .dep:focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  .dep .w { display: inline-flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .dep .at { font-size: 11.5px; color: var(--chrome); font-variant-numeric: tabular-nums; }
  .dep.live { background: color-mix(in srgb, var(--on-main) 11%, transparent); color: var(--on-main); font-weight: 600; }
  .dep.live:hover { background: color-mix(in srgb, var(--on-main) 16%, transparent); }
  .dep.live .at { color: color-mix(in srgb, var(--on-main) 70%, var(--soft)); }
  .dep.failed .w { color: var(--bad); }
  .dep.cancelled .w { color: var(--chrome); text-decoration: line-through; text-decoration-thickness: 1px; }
  .dep.building .w, .dep.deploying .w { color: var(--only-staging); }
  .dep.building .w::before, .dep.deploying .w::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--only-staging); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  /* A factory task: its merge commit is a long, thin card on its own line (the task's name, number and how many commits),
     its commits under it, their dots on the same rail, their subjects indented, a thin line down the indent.
     The card folds them away; "Collapse all", beside the heading, folds every task, so the list shows only tasks. */
  .row > .task-card { grid-column: 2 / span 4; display: grid; grid-template-columns: subgrid; align-items: center; height: 26px; align-self: center; margin: 0 4px 0 2px;
    border: 1px solid var(--rule); border-radius: 7px; background: color-mix(in srgb, var(--chrome) 7%, var(--bg)); cursor: pointer; }
  .row:hover > .task-card { background: color-mix(in srgb, var(--chrome) 13%, var(--bg)); }
  .task-card > * { display: flex; align-items: center; height: 100%; }
  .task-card .who, .task-card .sha { background: none; }
  .task-card .task-name { min-width: 0; gap: 7px; padding: 0 8px 0 4px; }
  .row.squash .task-name { padding-left: 8px; }
  .task-card .fold { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--soft); cursor: pointer; }
  .task-card .fold:hover { background: color-mix(in srgb, var(--chrome) 16%, transparent); }
  .task-card .fold:focus-visible { outline: 2px solid var(--caret); outline-offset: 0; }
  .task-card .fold svg { transition: transform .15s; }
  .row.folded .task-card .fold svg { transform: rotate(-90deg); }
  .task-card .num { flex: none; font: 600 11.5px var(--font-mono); color: var(--soft); }
  .task-card .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; color: var(--fg-strong); }
  .task-card .n { flex: none; margin-left: auto; font-size: 11.5px; color: var(--soft); white-space: nowrap; }
  .task-card time { margin: 0; justify-content: flex-end; padding-right: 8px; font-size: 12px; color: var(--soft); }
  .row.in-task .subj { position: relative; padding-left: 26px; }
  .row.in-task .subj::before { content: ""; position: absolute; left: 13px; top: 0; bottom: 0; border-left: 1px solid var(--rule); }
  .row.in-task.last .subj::before { bottom: 50%; }
  .row.in-task.hide { display: none; }
  .head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .fold-all { height: 24px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg); font: 500 12px var(--font-text); cursor: pointer; }
  .fold-all:hover { background: color-mix(in srgb, var(--chrome) 10%, var(--bg)); }
  .fold-all[hidden] { display: none; }
  /* The break, when staging is far ahead of main: a dashed rail and how many commits it leaves out. */
  .gap { display: contents; }
  .gap > * { height: var(--row); display: flex; align-items: center; }
  .gap .rail::before { content: ""; position: absolute; left: calc(50% - 1px); top: 0; bottom: 0; width: 0; height: auto; display: block; border-left: 2px dashed var(--only-staging); background: none; opacity: .5; }
  .gap .gap-text { grid-column: 2 / -1; padding: 0 6px; font: 12.5px var(--font-text); color: var(--soft); border-block: 1px dashed var(--rule); box-sizing: border-box; }
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); grid-column: 1 / -1; }
  @media (max-width: 760px) { .grid { grid-template-columns: 22px minmax(0, 1fr) auto 64px 80px 80px; } .who, .grid > .head.who-h, .row time, .grid > .head.time-h { display: none; } .target { max-width: 82px; } .row > .task-card { grid-column: 2 / span 2; } .target b { font-size: 10.5px; } .target .st span { display: none; }
    .dep { font-size: 11.5px; padding: 0 5px; } .dep .at { display: none; } }
  .boxes { display: grid; grid-template-columns: 1fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 760px) { .boxes { grid-template-columns: 1fr; } }
  .box { border: 1px solid var(--rule); border-radius: 12px; padding: 14px 16px; min-width: 0; }
  .box h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .box h2 .pill { margin-left: auto; height: 28px; font-size: 12.5px; padding: 0 10px; }
  .box p { margin: 0 0 6px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  .box p.error { color: var(--bad); }
  .box a { color: inherit; }
  pre { margin: 6px 0 8px; padding: 10px 12px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12.5px/1.6 var(--font-mono); overflow-x: auto; white-space: pre; }
  .setup ol { margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: var(--fg); }
  .setup li { margin: 4px 0; }
  .setup code, .box code { font: 12.5px var(--font-mono); }
  /* The tests column (the production gate): each commit's run, as plain text; green passed, red failed, orange running. */
  .tests { min-width: 0; padding: 0 4px 0 2px; }
  .gt { display: inline-flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 22px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent;
    color: var(--soft); font: 500 12px var(--font-text); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .gt:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .gt.passed { color: var(--on-main); font-weight: 600; }
  .gt.failed { color: var(--bad); font-weight: 600; }
  .gt.running { color: var(--only-staging); }
  .gt.running::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--only-staging); animation: pulse 1.2s ease-in-out infinite; }
  .gt.cancelled { color: var(--chrome); text-decoration: line-through; text-decoration-thickness: 1px; }
  .gt.none { color: var(--chrome); font-weight: 400; }
  .gt.none:not(:hover):not(:focus-visible) { opacity: .0; }
  .row:hover .gt.none { opacity: 1; }
  #merge-green[hidden], #merge-override[hidden] { display: none; }
  #gate-hint:has(#gate-why:empty) { display: none; }
  #gate-hint { margin: -4px 0 10px; font-size: 13.5px; text-align: right; color: var(--soft); }
  #merge-override { border: 0; background: transparent; color: var(--soft); font: 500 12.5px var(--font-text); text-decoration: underline; cursor: pointer; padding: 0 4px; }
  dialog#gate-dlg { width: min(820px, calc(100vw - 32px)); padding: 0; }
  #gate-dlg .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
  #gate-dlg h2 { margin: 0; font-size: 15px; flex: none; }
  #gate-dlg .meta { font-size: 12.5px; color: var(--soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #gate-dlg .close { margin-left: auto; height: 30px; }
  #gate-dlg .body { padding: 10px 16px 14px; font-size: 13px; }
  #gate-dlg .verdict { margin: 0 0 8px; }
  #gate-dlg .verdict.bad { color: var(--bad); } #gate-dlg .verdict.good { color: var(--on-main); }
  #gate-dlg table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  #gate-dlg td, #gate-dlg th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  #gate-dlg th { font-weight: 600; color: var(--soft); font-size: 11.5px; }
  #gate-dlg td.items { color: var(--soft); overflow-wrap: anywhere; }
  #gate-dlg td .bad { color: var(--bad); font-weight: 600; }
  #gate-dlg .log-btn { height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg); font: 500 12px var(--font-text); cursor: pointer; }
  #gate-dlg pre { margin: 10px 0 0; max-height: 40vh; overflow: auto; font-size: 11.5px; white-space: pre-wrap; }
  #gate-dlg pre:empty { display: none; }
  #gate-dlg .actions { display: flex; gap: 8px; margin-top: 10px; }
  dialog#deploy-log { width: min(820px, calc(100vw - 32px)); padding: 0; }
  #deploy-log .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
  #deploy-log h2 { margin: 0; font-size: 15px; }
  #deploy-log .meta { font-size: 12.5px; color: var(--soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #deploy-log .meta b { font-weight: 600; }
  #deploy-log .meta .live-on { color: var(--on-main); }
  #deploy-log .meta .bad { color: var(--bad); }
  #deploy-log .close { margin-left: auto; height: 30px; }
  #deploy-log pre { margin: 0; border-radius: 0 0 12px 12px; height: min(60vh, 520px); overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  #deploy-log pre .t { color: var(--chrome); }
  #deploy-log pre .s { color: var(--soft); }
`;

/** The source pane: the commits with their deploys, Merge, how to clone; or how to set it up. */
function sourceMarkup(c: SourcePageConfig): string {
  if (!c.ready) {
    return `<div class="pane-head"><h2>git log</h2></div>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. The steps:</p>
  <ol><li>Make the Artifacts repo <code>erga</code> in the namespace <code>erga</code>.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`;
  }
  const remote = `${c.origin}/git/erga.git`;
  const target = (name: string, label: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Deploys aren't set up yet"><b>${label}</b><span class="st"><i></i><span>not set up</span></span></button></div>`;
  return `
  <div class="pane-head">
    <div class="head-title"><h2>git log</h2><button class="fold-all" type="button" id="fold-all" hidden>Collapse all</button></div>
    <div class="head-actions"><div class="merge-row" id="merge-row" hidden><span class="count" id="ahead"></span><button class="pill" id="merge-green" type="button" hidden>Merge to newest green</button><button class="new" id="merge" disabled>Merge staging into main</button></div></div>
  </div>
  <p class="hint" id="merge-hint" role="status"></p>
  <p class="hint" id="gate-hint" role="status"><span id="gate-why"></span> <button type="button" id="merge-override" hidden title="An emergency only: moves main without a green test run. The change log keeps your reason.">Override…</button></p>
  <section class="card" aria-label="Commits">
    <div class="legend"><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main too</span></div>
    <div class="grid" id="grid">
      <div class="head"></div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head"></div><div class="head time-h"></div>
      <div class="head deploy" id="tests-head" title="The production gate: each staging commit's full test run (the end-to-end tests, the unit tests and the typecheck, in VMs). main moves only to a commit that passed.">tests</div>
      ${target("staging", "staging")}${target("production", "production")}
      <div class="none" id="loading">Loading…</div>
    </div>
  </section>
  <section class="boxes">
    <div class="box" id="clone">
      <h2>Clone and push</h2>
      <pre><code>git remote add erga ${esc(remote)}
git fetch erga</code></pre>
      <p>staging moves only by the factory's Merge: one commit for each task, with the task's title and summary. main only follows staging: merge here, or push one of staging's commits to main, once its tests passed. A push needs any username, and an agent token from <a href="/settings">Settings</a> as the password (admins only).</p>
      <p><button class="pill" type="button" id="staging-override" title="An emergency only: for 10 minutes, your pushes to staging land without the factory's Merge. The change log keeps your reason.">Allow a push to staging…</button> <span id="staging-open" role="status"></span></p>
    </div>
  </section>
  <dialog id="gate-dlg" aria-labelledby="gate-title">
    <div class="top"><h2 id="gate-title">Test run</h2><span class="meta" id="gate-meta"></span><button class="pill close" type="button" id="gate-close">Close</button></div>
    <div class="body"><p class="verdict" id="gate-verdict"></p><table><thead><tr><th>Shard</th><th>State</th><th>Time</th><th>Runs</th><th></th></tr></thead><tbody id="gate-shards"></tbody></table>
    <div class="actions"><button class="pill" type="button" id="gate-again">Run again</button></div><pre id="gate-log"></pre></div>
  </dialog>
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
`;
}

const SOURCE_SCRIPT = `
(() => {
  // The admin pages are one page (src/page/admin-nav.ts): what keeps running stops when another admin page is shown.
  const pageView = window.ergaView;
  const setInterval = (f, ms) => { const t = window.setInterval(f, ms); pageView.onLeave(() => clearInterval(t)); return t; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
  const ago = (t) => {
    if (!t) return "";
    const s = (t - Date.now()) / 1000;
    if (s > -60) return "just now";
    if (s > -3600) return rtf.format(Math.round(s / 60), "minute");
    if (s > -86400) return rtf.format(Math.round(s / 3600), "hour");
    if (s > -30 * 86400) return rtf.format(Math.round(s / 86400), "day");
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const TARGETS = ["staging", "production"];
  /** When staging is far ahead of main: how many of its newest commits show above the break, and how many of main's below it. */
  const GAP_TOP = 11, GAP_MAIN = 6;
  let view = null, deploys = null, busy = false, drawn = false;
  // The production gate's runs (GET /api/gate), by commit.
  let gate = null, gateBy = new Map();
  // Which task cards are folded, kept in the browser: every task (the default), or none, except those flipped one by one.
  // So with "Collapse all" (or before any choice), a task merged later comes folded too.
  const FOLDS = "erga:source-folded-tasks";
  let folds = { all: true, flip: [] };
  try { folds = { ...folds, ...JSON.parse(localStorage.getItem(FOLDS) || "{}") }; } catch {}
  const isFolded = (sha) => folds.all != folds.flip.includes(sha);
  const setFolded = (sha, on) => {
    folds.flip = folds.flip.filter((s) => s != sha);
    if (on != folds.all) folds.flip.push(sha);
    folds.flip = folds.flip.slice(-200);
    try { localStorage.setItem(FOLDS, JSON.stringify(folds)); } catch {}
  };
  const grid = document.getElementById("grid");
  const running = (state) => state == "building" || state == "deploying";
  const short = (t) => {
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + "m";
    if (s < 86400) return Math.round(s / 3600) + "h";
    if (s < 30 * 86400) return Math.round(s / 86400) + "d";
    return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const took = (r) => { const ms = (r.ended ?? Date.now()) - r.started; return ms < 60000 ? Math.round(ms / 1000) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"; };
  const targetOf = (name) => deploys?.targets?.find((t) => t.name == name) ?? null;
  /** A target's deploys by commit, newest first. */
  function byCommit(name) {
    const m = new Map();
    for (const r of targetOf(name)?.history ?? []) { if (!m.has(r.commit)) m.set(r.commit, []); m.get(r.commit).push(r); }
    return m;
  }
  /** The one deploy a commit shows in a target's column: the running one, else the live one, else the newest. */
  function shown(list) {
    if (running(list[0].state)) return list[0];
    return list.find((r) => r.live) ?? list[0];
  }
  const WORD = { building: "building", deploying: "deploying", deployed: "deployed", failed: "failed", cancelled: "cancelled" };
  function badge(name, r) {
    const t = targetOf(name);
    const tip = (r.live ? "Live on " + (t?.host ?? name) + ". " : "") + r.state[0].toUpperCase() + r.state.slice(1) + " · " + r.commit.slice(0, 7) + " · " + r.trigger + "\\n" +
      "Started " + new Date(r.started).toLocaleString() + (r.ended ? ", took " + took(r) : ", running for " + took(r)) + (r.error ? "\\n" + r.error : "") + "\\nClick for its log.";
    return '<button class="dep ' + esc(r.state) + (r.live ? " live" : "") + '" type="button" data-target="' + name + '" data-deploy="' + esc(r.id) + '" title="' + esc(tip) + '">' +
      '<span class="w">' + esc(r.live ? "live" : WORD[r.state] || r.state) + '</span><span class="at">' + short(r.started) + "</span></button>";
  }
  /** What a target shows on a commit's row: one deploy, or nothing. */
  function deployCell(name, sha, groups) {
    const list = groups.get(sha);
    if (list) return badge(name, shown(list));
    // A server without the history: whether the commit is live, as before.
    const t = targetOf(name);
    if (t && !t.history && (t.deployed ?? (t.state == "deployed" ? t.commit : null)) == sha) return '<span class="dep live" title="Live on ' + esc(t.host) + '"><span class="w">live</span><span class="at"></span></span>';
    return "";
  }

  // ---- the production gate (deploy/gate.ts) ----
  const GATE_WORD = { running: "running", passed: "passed", failed: "failed", cancelled: "cancelled" };
  /** Why main can't move to this commit (as the server says it: deploy/gate.ts, verdictOf), or "" when it can. */
  function gateWhy(sha, r) {
    const c = sha.slice(0, 7);
    if (!r) return c + " has no test run yet: Run tests (the tests column), then merge.";
    if (r.state == "passed") return "";
    if (r.state == "running") return "The tests of " + c + " are still running (" + r.shards.filter((s) => s.ended).length + " of " + r.shards.length + " shards done): merge when it is green.";
    if (r.state == "cancelled") return "The test run of " + c + " was cancelled: run it again, or merge a newer green commit.";
    return "The tests of " + c + " failed" + (r.failed.length ? ": " + r.failed.slice(0, 4).join(", ") + (r.failed.length > 4 ? " and " + (r.failed.length - 4) + " more" : "") : (r.error ? ": " + r.error : "")) + ".";
  }
  function gateCell(sha) {
    const r = gateBy.get(sha);
    if (!r) return '<button class="gt none" type="button" data-gate="' + sha + '" title="No test run. Click to run the tests of this commit.">run tests</button>';
    const done = r.shards.filter((s) => s.ended).length;
    const text = r.state == "running" ? "running " + done + "/" + r.shards.length : (GATE_WORD[r.state] || r.state) + (r.state == "passed" && r.flaky.length ? "*" : "");
    const tip = (r.state == "passed" ? "Passed" : r.state == "failed" ? "Failed" : r.state == "running" ? "Running" : "Cancelled") + " · " + sha.slice(0, 7) + " · " + r.trigger +
      "\\nStarted " + new Date(r.started).toLocaleString() + (r.ended ? ", took " + took(r) : ", running for " + took(r)) +
      (r.failed.length ? "\\nFailed: " + r.failed.join(", ") : "") + (r.flaky.length ? "\\nFlaky (passed when run again): " + r.flaky.join(", ") : "") + (r.error ? "\\n" + r.error : "") + "\\nClick for its shards and logs.";
    return '<button class="gt ' + esc(r.state) + '" type="button" data-gate="' + sha + '" title="' + esc(tip) + '">' + esc(text) + "</button>";
  }
  let gateAsking = false;
  async function loadGate() {
    if (gateAsking) return;
    gateAsking = true;
    try {
      const r = await fetch("/api/gate?limit=100", { headers: { Accept: "application/json" } }).catch(() => null);
      const body = r && r.ok ? await r.json().catch(() => null) : null;
      if (pageView.signal.aborted) return;
      if (body) { gate = body; gateBy = new Map(body.runs.map((x) => [x.commit, x])); }
      else if (r && r.status < 500) { gate = { runs: [] }; gateBy = new Map(); }
      render();
      if (gateOpen) drawGate();
    } finally { gateAsking = false; }
  }
  const gateDlg = document.getElementById("gate-dlg");
  let gateOpen = null; // { sha, shard: the log shown }
  function drawGate() {
    const sha = gateOpen.sha, r = gateBy.get(sha);
    document.getElementById("gate-title").textContent = "Tests of " + sha.slice(0, 7);
    document.getElementById("gate-meta").textContent = r ? [GATE_WORD[r.state] || r.state, "run " + r.attempt, r.trigger, new Date(r.started).toLocaleString() + (r.ended ? " · took " + took(r) : ""), gate?.runner ? "on " + gate.runner : ""].filter(Boolean).join(" · ") : "no run yet";
    const v = document.getElementById("gate-verdict"), why = gateWhy(sha, r);
    v.className = "verdict " + (why ? "bad" : "good");
    v.textContent = why ? why : "Passed: main may move to this commit." + (r.flaky.length ? " Flaky (failed once, passed when run again): " + r.flaky.join(", ") + "." : "");
    document.getElementById("gate-shards").innerHTML = (r?.shards ?? []).map((s) => {
      const bad = s.results.filter((x) => !x.ok).map((x) => x.name);
      const items = (s.items.length ? s.items.map((i) => bad.includes(i.name) ? '<span class="bad">' + esc(i.name) + "</span>" : esc(i.name)).join(", ") : s.phase ? "(" + esc(s.phase) + ")" : "") + (s.error ? ' <span class="bad">' + esc(s.error) + "</span>" : "");
      const t = s.ended ? Math.round((s.ended - s.started) / 1000) + "s" : "";
      return "<tr><td>" + s.n + (s.rerun ? " (rerun)" : "") + "</td><td>" + esc(s.state) + "</td><td>" + t + '</td><td class="items">' + items + "</td><td>" + (s.ended ? '<button class="log-btn" type="button" data-shard="' + s.n + '">Log</button>' : "") + "</td></tr>";
    }).join("");
    document.getElementById("gate-again").textContent = r ? (r.state == "running" ? "Running…" : "Run again") : "Run tests";
    document.getElementById("gate-again").disabled = r?.state == "running";
  }
  function openGate(sha) {
    gateOpen = { sha, shard: null };
    document.getElementById("gate-log").textContent = "";
    drawGate();
    if (!gateDlg.open) gateDlg.showModal();
  }
  async function runTests(sha) {
    const r = await fetch("/api/gate/" + sha + "/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { hint.className = "hint error"; hint.textContent = body.error || "Couldn't start the tests."; }
    await loadGate();
  }
  document.getElementById("gate-close").addEventListener("click", () => gateDlg.close());
  gateDlg.addEventListener("close", () => { gateOpen = null; if (location.hash.startsWith("#tests-")) history.replaceState(null, "", location.pathname + location.search); });
  document.getElementById("gate-again").addEventListener("click", () => { if (gateOpen) runTests(gateOpen.sha); });
  document.getElementById("gate-shards").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-shard]");
    if (!b || !gateOpen) return;
    const pre = document.getElementById("gate-log");
    pre.textContent = "Loading…";
    const r = await fetch("/api/gate/" + gateOpen.sha + "/log?shard=" + b.dataset.shard).catch(() => null);
    const body = r && r.ok ? await r.json().catch(() => null) : null;
    pre.textContent = body?.log || "No log for this shard.";
  });

  function render() {
    if (!view) return;
    const staging = view.branches.find((b) => b.name == "staging"), main = view.branches.find((b) => b.name == "main");
    // Staging far ahead of main: its head and the GAP_TOP - 1 commits before it, a break that counts the commits left out,
    // the commits just after main's head (afterMain), then main's head and the GAP_MAIN - 1 behind it, so the list shows
    // where production is. The break only when commits are left out; else staging's log, as always.
    const recent = staging?.commits ?? [], ahead = staging?.ahead ?? 0, after = staging?.afterMain ?? [];
    const only = recent.filter((x) => !x.inMain), top = only.slice(0, GAP_TOP);
    // Never cut a task's card in two: the commits of a task above the break go with it.
    while (top.length < only.length && only[top.length].inTask && top.some((x) => x.sha == only[top.length].inTask)) top.push(only[top.length]);
    const hidden = Math.max(0, ahead - top.length - after.length);
    const commits = hidden && after.length ? [...top, ...after.map((x) => ({ ...x, inMain: false })), ...(main?.commits ?? []).slice(0, GAP_MAIN).map((x) => ({ ...x, inMain: true }))] : recent;
    document.getElementById("loading")?.remove();
    const groups = Object.fromEntries(TARGETS.map((n) => [n, byCommit(n)]));
    // One row per commit, kept: a new commit fades in at the top, the oldest goes at the bottom.
    const rows = new Map([...grid.querySelectorAll(".row")].map((r) => [r.dataset.sha, r]));
    const want = new Set(commits.map((x) => x.sha));
    for (const [sha, r] of rows) if (!want.has(sha)) r.remove();
    grid.querySelector(".none.empty")?.remove();
    grid.querySelector(".gap")?.remove();
    if (!commits.length) { grid.insertAdjacentHTML("beforeend", '<div class="none empty">No commits yet. Fill the repository: bun source/import.ts</div>'); }
    let prev = null;
    // A task's card folds only an older merge's commits: a squash (one commit for the task, from the board) has none.
    const cards = new Set(commits.filter((x) => x.task && !x.inTask && x.task.commits.length).map((x) => x.sha));
    const foldAll = document.getElementById("fold-all");
    foldAll.hidden = !cards.size;
    foldAll.textContent = cards.size && [...cards].every(isFolded) ? "Expand all" : "Collapse all";
    commits.forEach((x, i) => {
      let r = rows.get(x.sha);
      if (!r) { r = document.createElement("div"); r.dataset.sha = x.sha; }
      const kind = x.inMain ? "on-main" : "staging-only";
      const next = commits[i + 1], card = x.task && !x.inTask, member = x.inTask && cards.has(x.inTask);
      r.className = "row " + kind + (card ? (cards.has(x.sha) ? " task-row" + (isFolded(x.sha) ? " folded" : "") : " task-row squash") : "") +
        (member ? " in-task" + (isFolded(x.inTask) ? " hide" : "") + (next?.inTask == x.inTask ? "" : " last") : "");
      if (member) r.dataset.task = x.inTask; else delete r.dataset.task;
      const up = i > 0, down = !!next || x.parents.length > 0, gapAfter = hidden && after.length && i == top.length - 1;
      const title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + (x.inMain ? " · on main" : " · only on staging");
      const n = card ? x.task.commits.length : 0;
      const tail = '<span class="who">' + esc(x.author) + '</span><code class="sha">' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + "</time>";
      r.innerHTML =
        '<span class="rail ' + (up ? "up " : "") + (down ? "down " : "") + (x.inMain ? "on-main" : "") + '"><i class="dot ' + kind + '" title="' + (x.inMain ? "On main (and staging)" : "Only on staging") + '"></i></span>' +
        (card
          ? '<span class="task-card"' + (n ? ' data-fold="' + x.sha + '"' : "") + ' title="' + esc(title) + '"><span class="task-name">' + (n ? '<button class="fold" type="button" data-fold="' + x.sha + '" aria-expanded="' + !isFolded(x.sha) + '" aria-label="' + (isFolded(x.sha) ? "Expand" : "Collapse") + " task " + x.task.id + '"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : "") +
            '<span class="num">#' + x.task.id + '</span><span class="name">' + esc(x.task.title) + '</span>' + (x.inMain || gateBy.get(x.sha)?.state != "passed" ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit (its tests passed)">Merge to here</button>') + (n ? '<span class="n">' + n + " commit" + (n == 1 ? "" : "s") + "</span>" : "") + "</span>" + tail + "</span>"
          : '<span class="subj" title="' + esc(title) + '"><span>' + esc(x.subject) + "</span>" + (x.inMain || gateBy.get(x.sha)?.state != "passed" ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit (its tests passed)">Merge to here</button>') + "</span>" + tail) +
        '<span class="tests">' + gateCell(x.sha) + "</span>" +
        TARGETS.map((n) => '<span class="deps" data-target="' + n + '">' + deployCell(n, x.sha, groups[n]) + "</span>").join("");
      grid.insertBefore(r, prev ? prev.nextSibling : document.getElementById("target-production").parentElement.nextSibling);
      prev = r;
      if (gapAfter) {
        const g = document.createElement("div");
        g.className = "gap";
        const n = hidden.toLocaleString() + " more commit" + (hidden == 1 ? "" : "s");
        g.innerHTML = '<span class="rail"></span><span class="gap-text" title="' + n + ' only on staging, not shown. Below: the commit main is at, which production deploys.">… ' + n + " only on staging …</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
    });
    drawn = true;
    const mergeBtn = document.getElementById("merge");
    // Nothing at all while main is at staging: no count, no button, no space. While a merge runs the button stays, disabled.
    if (!busy) document.getElementById("merge-row").hidden = !ahead;
    document.getElementById("ahead").textContent = !staging?.commit ? "" : ahead ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge" : "";
    // The production gate: Merge only when staging's head passed; else why, and the newest green commit after main, if any.
    const headRun = staging?.commit ? gateBy.get(staging.commit) : null;
    const why = !ahead ? "" : !gate ? "Reading the test runs…" : gateWhy(staging.commit, headRun);
    if (!busy) mergeBtn.disabled = !ahead || !!why;
    mergeBtn.title = why || "Moves main to staging's head: production deploys it.";
    const green = ahead && why ? only.find((x) => gateBy.get(x.sha)?.state == "passed") : null;
    const gb = document.getElementById("merge-green");
    gb.hidden = !green || busy;
    if (green) { gb.dataset.merge = green.sha; gb.textContent = "Merge to newest green (" + green.sha.slice(0, 7) + ")"; }
    document.getElementById("gate-why").textContent = why && gate ? why : "";
    document.getElementById("merge-override").hidden = !(why && gate && headRun?.state != "running");
    // The GitHub mirror: the fourth status in the board's row (factory/page.ts). Its title has the URL and any error; a click pushes now.
    const m = view.mirror, mp = document.getElementById("mirror-pill");
    if (mp) {
      mp.hidden = false;
      mp.className = "pill " + (m.state == "off" ? "" : m.state == "pushing" ? "pushing" : m.error ? "off" : "on");
      mp.textContent = "GitHub: " + (m.state == "off" ? "off" : m.state == "pushing" ? "pushing…" : m.error ? "behind" : m.lastPushAt ? "up to date" : "not pushed yet");
      const where = String(m.url || "").includes("/__github/") ? "A pretend GitHub, in the dev server (local development never pushes to the real one)" : String(m.url || "").replace(/^https?:\\/\\//, "").replace(/\\.git$/, "");
      mp.title = (m.state == "off" ? "Off: the server has no GITHUB_MIRROR_TOKEN. Click for how to turn it on." : (m.lastPushAt ? "Last pushed " + ago(m.lastPushAt) + (m.lastPushBy ? ", for " + m.lastPushBy : "") : "Not pushed yet") + (m.error ? ". " + m.error : "") + ". Click to push now.") + (where ? "\\n" + where : "");
      mp.setAttribute("aria-haspopup", "dialog");
      renderMirror(where);
    }
  }
  /** The mirror's dialog: how to turn it on while it's off; its state, any error, and Push now while it's on. */
  function renderMirror(where) {
    const m = view?.mirror, d = document.getElementById("mirror-dlg");
    if (!m || !d) return;
    const off = m.state == "off";
    document.getElementById("mirror-off").hidden = !off;
    document.getElementById("mirror-on").hidden = off;
    const push = document.getElementById("mirror-push");
    push.hidden = off;
    push.disabled = m.state == "pushing";
    push.textContent = m.state == "pushing" ? "Pushing…" : "Push now";
    if (off) return;
    document.getElementById("mirror-state").textContent = "GitHub sync is on. " + (m.state == "pushing" ? "It pushes now." : m.lastPushAt ? "Last pushed " + ago(m.lastPushAt) + (m.lastPushBy ? ", for " + m.lastPushBy : "") + "." : "Not pushed yet.");
    document.getElementById("mirror-where").textContent = where ? "Where: " + where : "";
    const err = document.getElementById("mirror-error");
    err.hidden = !m.error;
    err.textContent = m.error || "";
  }

  function renderTargets() {
    for (const n of TARGETS) {
      const b = document.getElementById("target-" + n), t = targetOf(n);
      b.className = "target " + (t ? t.state : "");
      b.disabled = !t;
      b.title = t ? (t.host + ": " + t.state + (t.deployed ? ", live on " + t.deployed.slice(0, 7) : "") + (t.error ? " (" + t.error + ")" : "") + ". Click for the latest deploy's log.") : "Deploys aren't set up yet";
      const what = !t ? "not set up" : { idle: "idle", building: "building", deploying: "deploying", deployed: "live", failed: "failed", cancelled: "cancelled" }[t.state] || t.state;
      b.querySelector(".st span").textContent = what + (t?.at ? " · " + ago(t.at) : "");
    }
    render();
  }

  async function load() {
    try {
      const r = await fetch("/api/source/branches", { headers: { Accept: "application/json" } });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      if (pageView.signal.aborted) return;
      view = body; render(); showOverrides();
    } catch (e) {
      const l = document.getElementById("loading");
      if (l) l.textContent = e.message;
    }
  }
  // Each change is an event, many while a deploy runs: the status and history are asked for at most every half second.
  let asking = null, again = false;
  async function loadDeploys() {
    if (asking) { again = true; return asking; }
    asking = (async () => {
      const r = await fetch("/api/deploys?history=100", { headers: { Accept: "application/json" } }).catch(() => null);
      // No answer, or a 5xx (a server restarting into its new version): keep what's shown, and the poll below asks again.
      const body = r && r.ok ? await r.json().catch(() => null) : null;
      if (pageView.signal.aborted) return;
      if (body || (r && r.status < 500)) deploys = body;
      renderTargets();
      if (open && !open.pinned) { const t = targetOf(open.target); if (t?.deployId && t.deployId != open.deployId) refreshLog(false); }
      await new Promise((ok) => setTimeout(ok, 500));
    })();
    await asking;
    asking = null;
    if (again) { again = false; loadDeploys(); }
  }

  // A deploy's log: the latest one's from a column's head (it follows the next deploy), or any one's from its badge.
  const dlg = document.getElementById("deploy-log"), pre = document.getElementById("log-lines");
  let open = null; // { target, deployId, pinned: a chosen deploy, shown: lines shown, state, heard: when an event last came }
  const line = (l) => '<span class="t">' + esc(new Date(l.at).toLocaleTimeString()) + "</span> " + (l.step ? '<span class="s">[' + esc(l.step) + "]</span> " : "") + esc(l.text) + "\\n";
  function append(lines) {
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.insertAdjacentHTML("beforeend", lines.map(line).join(""));
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
  async function openLog(name, deployId) {
    const t = targetOf(name);
    document.getElementById("log-title").textContent = (t?.host ?? name) + " deploy log";
    document.getElementById("log-meta").textContent = "";
    pre.textContent = "Loading…";
    open = { target: name, deployId: deployId ?? null, pinned: !!deployId, shown: 0, state: null, heard: 0 };
    if (!dlg.open) dlg.showModal();
    await refreshLog(true);
  }
  /** The log as the server has it now: what's new since what's shown (or all of it, for another deploy). */
  async function refreshLog(first) {
    if (!open) return;
    const name = open.target, want = open.pinned ? open.deployId : null;
    const r = await fetch("/api/deploys/" + name + "/log" + (want ? "?deploy=" + encodeURIComponent(want) : "")).catch(() => null);
    const log = r && r.ok ? await r.json().catch(() => null) : null;
    if (pageView.signal.aborted) return;
    if (!open || open.target != name) return;
    if (!log || !log.deployId) { if (first) { pre.textContent = r && r.status == 404 ? "This deploy isn't in the history any more." : "No deploy log yet."; } return; }
    const lines = log.lines || [];
    if (first || log.deployId != open.deployId) { pre.textContent = ""; open.shown = 0; }
    open.deployId = log.deployId; open.state = log.state;
    const meta = document.getElementById("log-meta");
    meta.innerHTML = [log.commit ? "<b>" + esc(log.commit.slice(0, 7)) + "</b>" : "",
      log.live ? '<span class="live-on">live</span>' : '<span class="' + (log.state == "failed" ? "bad" : "") + '">' + esc(log.state) + "</span>",
      log.trigger ? esc(log.trigger) : "", log.started ? esc(new Date(log.started).toLocaleString()) + (log.ended ? " · took " + took(log) : "") : ""].filter(Boolean).join(" · ");
    meta.title = log.error || "";
    if (lines.length > open.shown) { append(lines.slice(open.shown)); open.shown = lines.length; }
    if (first) pre.scrollTop = pre.scrollHeight;
  }
  // Live lines come as events only from the server running the deploy (staging's runs on staging's own server):
  // while the deploy shown runs and no events arrive, ask for the log every two seconds.
  setInterval(() => {
    if (!open || !dlg.open) return;
    const t = targetOf(open.target);
    if (!(running(open.state) || (!open.pinned && running(t?.state)))) return;
    if (Date.now() - open.heard < 2500) return;
    refreshLog(false);
  }, 2000);
  for (const n of TARGETS) document.getElementById("target-" + n).addEventListener("click", () => openLog(n));
  document.getElementById("log-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => { open = null; });
  grid.addEventListener("click", (e) => {
    const d = e.target.closest("button[data-deploy]");
    if (d) { openLog(d.dataset.target, d.dataset.deploy); return; }
  });

  const hint = document.getElementById("merge-hint"), mergeBtn = document.getElementById("merge");
  async function merge(commit) {
    busy = true; mergeBtn.disabled = true; hint.className = "hint"; hint.textContent = "Merging…";
    try {
      const r = await fetch("/api/source/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main", ...(commit ? { commit } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The merge failed (HTTP " + r.status + ").");
      hint.textContent = "";
    } catch (e) { hint.className = "hint error"; hint.textContent = e.message; }
    busy = false;
    await load();
  }
  mergeBtn.addEventListener("click", () => merge(null));
  document.getElementById("merge-green").addEventListener("click", (e) => merge(e.currentTarget.dataset.merge));
  // The staging rule's emergency override: the admins whose pushes to staging land now, and until when.
  function showOverrides() {
    const open = view?.stagingOverrides ?? [];
    document.getElementById("staging-open").textContent = open.map((o) => "Pushes to staging by " + o.login + " land until " + new Date(o.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ": " + o.reason).join(" · ");
  }
  document.getElementById("staging-override").addEventListener("click", async () => {
    const reason = prompt("Allow your pushes to staging for 10 minutes, without the factory's Merge? This is for emergencies only. Your reason goes in the change log (at least 10 characters):");
    if (reason == null) return;
    const out = document.getElementById("staging-open");
    try {
      const r = await fetch("/api/source/staging-override", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      await load();
    } catch (err) { out.textContent = err.message; }
  });
  // The emergency override: a person, here, with a reason the change log keeps (never an agent or a token).
  document.getElementById("merge-override").addEventListener("click", async () => {
    const reason = prompt("Move main to staging's head WITHOUT a green test run? This is for emergencies only. Your reason goes in the change log (at least 10 characters):");
    if (reason == null) return;
    busy = true; mergeBtn.disabled = true; hint.className = "hint"; hint.textContent = "Merging past the tests…";
    try {
      const r = await fetch("/api/source/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "staging", to: "main", override: reason }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The merge failed (HTTP " + r.status + ").");
      hint.textContent = body.override ? "main moved past the tests: the change log keeps your reason." : "";
    } catch (err) { hint.className = "hint error"; hint.textContent = err.message; }
    busy = false;
    await load();
  });
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-merge]");
    if (b) return merge(b.dataset.merge);
    const g = e.target.closest("button[data-gate]");
    if (g) { if (gateBy.get(g.dataset.gate)) openGate(g.dataset.gate); else runTests(g.dataset.gate); return; }
    const f = e.target.closest("[data-fold]");
    if (f) { const sha = f.dataset.fold; setFolded(sha, !isFolded(sha)); render(); }
  });
  document.getElementById("fold-all").addEventListener("click", () => {
    const cards = [...grid.querySelectorAll(".row.task-row:not(.squash)")].map((r) => r.dataset.sha);
    folds = { all: !cards.every(isFolded), flip: [] };
    try { localStorage.setItem(FOLDS, JSON.stringify(folds)); } catch {}
    render();
  });
  const mirrorDlg = document.getElementById("mirror-dlg");
  document.getElementById("mirror-pill")?.addEventListener("click", () => {
    document.getElementById("mirror-status").textContent = "";
    render();
    if (!mirrorDlg.open) mirrorDlg.showModal();
  });
  document.getElementById("mirror-close").addEventListener("click", () => mirrorDlg.close());
  document.getElementById("mirror-push").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    const status = document.getElementById("mirror-status");
    status.textContent = "Pushing…";
    const r = await fetch("/api/source/mirror", { method: "POST" }).catch(() => null);
    const body = r ? await r.json().catch(() => null) : null;
    status.textContent = !r || !r.ok ? (body?.error || "Couldn't push.") : "";
    await load();
  });

  // Live: an event says what changed; a reconnect reloads everything. A stream the server answers with an error
  // (a server restarting into its new version) the browser closes for good: open it again.
  let heard = 0;
  function listen() {
    if (pageView.signal.aborted) return;
    const events = new EventSource("/api/events");
    pageView.onLeave(() => events.close());
    events.onopen = () => { load(); loadDeploys(); };
    events.onerror = () => { if (events.readyState == EventSource.CLOSED) setTimeout(listen, 3000); };
    events.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type == "source") { load(); loadDeploys(); } // a move starts a deploy, here or on another server
      if (ev.type == "deploys") { heard = Date.now(); loadDeploys(); }
      if (ev.type == "gate") { gateHeard = Date.now(); loadGate(); }
      if (ev.type == "deploy-log" && open && ev.target == open.target) {
        if (ev.deployId == open.deployId) { open.heard = Date.now(); append(ev.lines || []); open.shown += (ev.lines || []).length; }
        else if (!open.pinned) { open.heard = Date.now(); refreshLog(false); }
      }
    };
  }
  let gateHeard = 0;
  listen();
  load(); loadDeploys(); loadGate().then(() => { const m = /^#tests-([0-9a-f]{7,40})$/.exec(location.hash); const sha = m ? [...gateBy.keys()].find((c) => c.startsWith(m[1])) : null; if (sha) openGate(sha); });
  // Another server's runs (erga.dev's page shows staging's) send no events: while one runs and none came lately, ask every 5 s.
  setInterval(() => { if (Date.now() - gateHeard > 4000 && gate?.runs?.some((r) => r.state == "running")) loadGate(); }, 5000);
  // Events don't tell everything: another server's deploy (erga.dev's page shows staging's, run by staging's server)
  // sends this page none, and a server that deploys itself cuts the stream and can miss its last change. So while
  // a deploy shows running (or the status didn't load) and no event came lately, ask for the status every two seconds.
  setInterval(() => {
    if (asking || Date.now() - heard < 2500) return;
    if (!deploys || deploys.targets?.some((t) => running(t.state) || t.history?.some((r) => running(r.state)))) loadDeploys();
  }, 2000);
  setInterval(() => { render(); renderTargets(); }, 30000);
})();
`;

/** Splits a selector list at its top-level commas (not those inside :is(...) and the like). */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch == "(" || ch == "[") depth++;
    else if (ch == ")" || ch == "]") depth--;
    else if (ch == "," && !depth) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** One selector, inside `scope`: ":root" and "body" become the scope itself (":root:not(...) x" keeps its test on the root). */
function scoped(sel: string, scope: string): string {
  if (sel.startsWith(":root") || sel == "body" || sel.startsWith("body ")) {
    const sp = sel.search(/\s/);
    const head = sp < 0 ? sel : sel.slice(0, sp), rest = sp < 0 ? "" : sel.slice(sp);
    return head == ":root" || head == "body" ? `${scope}${rest}` : `${head} ${scope}${rest}`;
  }
  return `${scope} ${sel}`;
}

/**
 * A pane's stylesheet, scoped to the pane (`scope`, an id selector), so the board's and the dashboard's rules
 * (both have a .card, a .row, a .dep...) never meet. A width query measures the pane, not the window
 * (@media max-width becomes @container), as the pane is narrower beside the agent. @keyframes stay as they are.
 */
export function scopeCss(css: string, scope: string): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth && j < css.length) { if (css[j] == "{") depth++; else if (css[j] == "}") depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith("@keyframes")) out.push(`${prelude} {${body}}`);
    else if (prelude.startsWith("@media")) out.push(`${prelude.replace(/^@media\s*\(((?:max|min)-width)/, "@container ($1")} {${scopeCss(body, scope)}}`);
    else if (prelude) out.push(`${selectors(prelude).map((s) => scoped(s, scope)).join(", ")} {${body}}`);
    i = j;
  }
  return out.join("\n");
}

const PAGE_STYLE = `
  /* The board and the dashboard, one above the other, beside the agent (admin-layout.ts). */
  .panes { min-width: 0; display: flex; flex-direction: column; gap: 28px; }
  .pane { container-type: inline-size; min-width: 0; }
  .pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .pane-head h2 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  .pane-head .sub { margin: 2px 0 0; font-size: 13px; }
  .pane-note { margin: -4px 0 10px; font-size: 13px; color: var(--soft); }
  .tabs { display: none; }
  /* Narrower, one at a time: tabs for the board and the dashboard (the agent covers the page, from its button). */
  @media (max-width: 999.98px) {
    .tabs { display: flex; gap: 4px; padding: 4px; margin: 0 0 14px; border: 1px solid var(--rule); border-radius: 12px; background: var(--bg); position: sticky; top: max(8px, env(safe-area-inset-top)); z-index: 6; }
    .tabs button { flex: 1; height: 34px; border: 0; border-radius: 9px; background: transparent; color: var(--soft); font: 550 13.5px var(--font-text); cursor: pointer; }
    .tabs button[aria-selected="true"] { background: var(--fg-strong); color: var(--bg); }
    .panes { display: block; }
    .pane { display: none; }
    body[data-tab="tasks"] #tasks, body[data-tab="source"] #source-pane { display: block; }
  }
  /* The GitHub mirror: its state and Push now, or how to turn it on. */
  dialog#mirror-dlg { width: min(600px, calc(100vw - 32px)); }
  #mirror-dlg p { margin: 0 0 12px; font-size: 13.5px; color: var(--soft); overflow-wrap: anywhere; }
  #mirror-dlg p.error { color: var(--bad, #c2410c); }
  #mirror-dlg ol { margin: 0 0 14px; padding-left: 22px; font-size: 13.5px; color: var(--fg); }
  #mirror-dlg li { margin: 0 0 10px; }
  #mirror-dlg li p { margin: 4px 0 0; }
  #mirror-dlg a { color: inherit; }
  #mirror-dlg code { font: 12.5px var(--font-mono); }
  #mirror-dlg pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--code-bg); color: var(--fg-strong); font: 12px/1.5 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  #mirror-dlg [hidden] { display: none; }
  #mirror-dlg .buttons { align-items: center; }
  #mirror-status { margin-right: auto; font-size: 12.5px; color: var(--soft); }
`;

/** The tabs on a phone: which pane shows, remembered in this browser and in the address (#tasks, #source; #agent opens the agent). */
const TABS_SCRIPT = `
(() => {
  const tabs = ["tasks", "source"];
  let tab = location.hash.slice(1);
  if (tab == "agent") { if (document.readyState == "loading") addEventListener("DOMContentLoaded", () => window.ergaAgent?.show(true)); else window.ergaAgent?.show(true); }
  if (!tabs.includes(tab)) { try { tab = localStorage.getItem("erga:admin-factory-tab") || "tasks"; } catch { tab = "tasks"; } }
  if (!tabs.includes(tab)) tab = "tasks";
  const show = (t) => {
    document.body.dataset.tab = t;
    for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab == t));
    try { localStorage.setItem("erga:admin-factory-tab", t); } catch {}
  };
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.addEventListener("click", () => { show(b.dataset.tab); history.replaceState(history.state, "", "#" + b.dataset.tab); });
  show(tab);
  window.ergaView.onLeave(() => { delete document.body.dataset.tab; });
})();
`;

/** The GitHub mirror's dialog: the steps that turn it on shown while it's off; its state and Push now while it's on. */
function mirrorDialog(c: SourcePageConfig): string {
  const repo = /github\.com\/([^/]+\/[^/]+?)(\.git)?$/.exec(c.mirrorUrl)?.[1] ?? "koomen/erga";
  const name = c.worker ? ` --name ${c.worker}` : " --name <this server's Worker>";
  return `<dialog id="mirror-dlg" aria-labelledby="mirror-title">
    <h2 id="mirror-title">GitHub sync</h2>
    <div id="mirror-on" hidden>
      <p id="mirror-state"></p>
      <p id="mirror-where"></p>
      <p class="error" id="mirror-error" hidden></p>
      <p>After each push or merge, Erga pushes staging and main to GitHub by itself. Push now does it at once.</p>
    </div>
    <div id="mirror-off" hidden>
      <p>GitHub sync is off: this server has no <code>GITHUB_MIRROR_TOKEN</code>. With a token, Erga pushes staging and main to <a href="https://github.com/${esc(repo)}" target="_blank" rel="noopener">github.com/${esc(repo)}</a> after each push or merge. To turn it on:</p>
      <ol>
        <li>Make a fine-grained token on GitHub: <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.
          <p>Resource owner: <code>${esc(repo.split("/")[0])}</code>. Repository access: only <code>${esc(repo)}</code>. Permissions: Contents, read and write. You must be able to push to that repository.</p></li>
        <li>Paste the token on <a href="/admin/api-keys">Admin › API keys</a> (GitHub mirror token). The server uses it within a minute. Or set it as a secret on this server's Worker. Paste the token when the command asks for it:
          <pre><code>bunx cf workers secrets update GITHUB_MIRROR_TOKEN${esc(name)}</code></pre>
          <p>Do this when no deploy runs: a new secret restarts the deploy pipeline.</p></li>
        <li>Come back to this page. The status changes to "GitHub: not pushed yet". Click it, then click Push now.</li>
      </ol>
      <p>To sync to a different repository, set <code>GITHUB_MIRROR_URL</code> in the deploy's environment, then deploy again. If GitHub's main has commits that Erga's main does not have, the sync stops for main. Pull those commits into Erga's main, and it continues.</p>
    </div>
    <div class="buttons"><span id="mirror-status" role="status" aria-live="polite"></span><button type="button" class="primary" id="mirror-push" hidden>Push now</button><button type="button" id="mirror-close" autofocus>Close</button></div>
  </dialog>`;
}

/** /admin/factory: the factory's board, the source and deploy dashboard, and the factory's agent, on one page (admins). */
export function adminFactoryPage(c: SourcePageConfig): Response {
  if (!c.admin) return plainPage("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return adminResponse({ session: c.session, title: "Factory", here: "factory", wide: true, style: PAGE_STYLE + scopeCss(BOARD_STYLE, "#tasks") + scopeCss(SOURCE_STYLE, "#source-pane"), body: `
  <div class="tabs" role="tablist" aria-label="Show"><button type="button" role="tab" data-tab="tasks">Tasks</button><button type="button" role="tab" data-tab="source">Source</button></div>
  <div class="panes">
    <section class="pane" id="tasks" aria-label="Tasks">${boardMarkup({ enabled: c.factory })}</section>
    <section class="pane" id="source-pane" aria-label="git log">${sourceMarkup(c)}</section>
  </div>
  ${c.ready ? mirrorDialog(c) : ""}
<script>${TABS_SCRIPT}</script>
<script>${BOARD_SCRIPT}</script>
${c.ready ? `<script>${SOURCE_SCRIPT}</script>` : ""}` });
}
