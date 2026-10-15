// The Ops page, /admin/ops, for admins with admin access: the one place to
// manage Erga's environments, its Cloudflare credential, its own source and
// its deploys. It has the layout every admin page shares: the breadcrumb,
// Share with agent, the admin's agent and the sidebar. /admin/ops,
// /source, /admin/factory and /admin/deploys redirect here.
//
// Status, at the top: one card for each environment (production, staging,
// the control Worker): its state, when, the commit that is live, and its
// latest deploy's log. And the control Worker's Cloudflare credential, with a
// link to /install, where an admin connects or disconnects it.
//
// Git Repository, below: how to clone and push, the GitHub mirror, Merge
// and Cut release, then the git log:
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
// head, or to the commit a row's "Merge to here" names. Above the log, how to clone and
// push, and the GitHub mirror's status (beside Merge; a click opens a dialog:
// the mirror's state and Push now, or how to turn it on). Releases are tags:
// a tagged commit's row carries its version, "stable" on the newest release
// tag, and "edge" on the newest commit of main the store has (GET
// /api/releases). Cut release (beside Merge) cuts the next one: a dialog with
// the version (the next patch version, which the admin may change) and short
// notes, the tag's message (POST /api/source/release). It follows the
// system's light or dark.
//
// A downstream (an Erga on its own domain, forked from erga.dev's: the
// repository's `upstream`) sees its own environments and hosts, and where it
// stands against erga.dev: upstream's commits it doesn't have yet come first
// in the log, as their own kind of row (a hollow blue dot, no deploys), then a
// line says how many ("erga.dev: 12 commits (v0.15.0) that you do not have ·
// 3 commits of your own"); its own commits (not on erga.dev) carry "yours".
// Update from erga.dev (POST /api/source/update) merges upstream's channel
// into staging; when files conflict, a box lists them and the two ways out
// (the admin agent, or a merge in a checkout pushed to staging), and Drop.
// Each environment's card lists its domains (GET /api/domains), with Add and
// remove (POST and DELETE), through the instance's own Cloudflare grant.
//
// It updates by itself, with no reload: /api/events says what changed (a push
// or a merge, the mirror, each step of a deploy, a redeploy, its log lines),
// for this server and for Erga's other server too (deploy/relay.ts passes each
// server's events to the other). Only rows that changed are drawn again, so
// the scroll, an open log or dialog, and the focus stay.

import { esc, page as plainPage } from "../pages/index.ts";
import type { Session } from "../platform";
import { adminResponse, type AdminLayout } from "../admin/index.ts";
import { CONTROL, TARGETS } from "../../deploy/targets.ts";

export interface SourcePageConfig {
  session: Session;
  admin: boolean;
  /** Whether this server has a repository (an Artifacts binding, or local development's stand-in). */
  ready: boolean;
  origin: string;
  mirrorUrl: string;
  /** This server's Worker, for the GitHub mirror's setup steps; null when it isn't one of Erga's targets. */
  worker: string | null;
  /** Each environment's hostname, as the fleet has them (deploy/fleet.ts): erga.dev's own (deploy/targets.json) unless given. */
  hosts?: Record<"production" | "staging" | "control", string>;
  /** A downstream: where upstream is (the page names it on Update, and in the clone box). */
  upstream?: string;
  /** The page's shell: the admin layout (the app, in local development), or the control Worker's own (control/routes.ts). */
  layout?: (o: AdminLayout) => Response;
}

const SOURCE_STYLE = `
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --upstream: #2563eb; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --upstream: #7aa7ff; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --upstream: #7aa7ff; --bad: #ff8a65; }
  .pane-head { justify-content: space-between; }
  /* Ops: Status (each environment, and the Cloudflare credential), then the Git repository. */
  .ops-section { margin: 0 0 32px; }
  #status-head { margin: 0 0 4px; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  .ops-section h3 { margin: 14px 0 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); }
  .envs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .env { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 12px; }
  .env.cloudflare { max-width: calc((100% - 24px) / 3); box-sizing: border-box; }
  .env-top { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .env-top b { font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .env-top .host { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--font-mono); color: var(--soft); }
  .env .st { display: inline-flex; align-items: center; gap: 7px; min-width: 0; font-size: 13.5px; color: var(--fg); }
  .env .st > span { min-width: 0; overflow-wrap: anywhere; }
  .env .st i { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--chrome); }
  .env.deployed .st i { background: var(--on-main); }
  .env.failed .st { color: var(--bad); }
  .env.failed .st i { background: var(--bad); }
  .env.building .st i, .env.deploying .st i { background: transparent; border: 2px solid var(--only-staging); border-right-color: transparent; width: 6px; height: 6px; animation: spin .8s linear infinite; }
  .env-more { display: flex; align-items: center; gap: 8px; min-height: 22px; }
  /* Each environment's domains: one chip each, removable, and Add. */
  .env-domains { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 22px; }
  .env-domains[hidden] { display: none; }
  .env-domains .dom { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 4px 1px 8px; border: 1px solid var(--rule); border-radius: 999px; font: 11.5px var(--font-mono); color: var(--fg); }
  .env-domains .dom span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .env-domains .dom.primary { color: var(--fg-strong); }
  .env-domains .dom button { flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--soft); font: 13px/1 var(--font-text); cursor: pointer; }
  .env-domains .dom button:hover { background: color-mix(in srgb, var(--bad) 14%, transparent); color: var(--bad); }
  .env-domains .add { height: 22px; padding: 0 8px; border: 1px dashed var(--rule); border-radius: 999px; background: transparent; color: var(--soft); font: 500 11.5px var(--font-text); cursor: pointer; }
  .env-domains .add:hover { color: var(--fg-strong); border-color: var(--chrome); }
  #domain-dlg label { display: block; margin: 0 0 12px; font-size: 13px; color: var(--soft); }
  #domain-dlg input { display: block; width: 100%; margin-top: 4px; box-sizing: border-box; font: 14px var(--font-mono); padding: 7px 10px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--fg); }
  #domain-dlg .buttons { display: flex; align-items: center; gap: 8px; }
  #domain-dlg .buttons span { flex: 1; font-size: 13px; color: var(--soft); }
  #domain-dlg .buttons .error { color: var(--bad); }
  .env-commit { font: 11.5px var(--font-mono); color: var(--chrome); }
  .env-log { margin-left: auto; height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); cursor: pointer; }
  .env-log:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .env-log[hidden] { display: none; }
  .repo-note { margin: -4px 0 14px; font-size: 13.5px; color: var(--soft); }
  .repo-note a { color: inherit; }
  .repo-tools { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin: 0 0 14px; }
  .repo-tools .box.clone { margin: 0; }
  .box.actions { padding: 10px 14px; }
  .box.actions .head-actions { display: flex; flex-wrap: wrap; justify-content: flex-start; margin: 8px 0 0; }
  .box.actions #merge-hint { margin: 8px 0 0; text-align: left; }
  @media (max-width: 760px) { .envs, .repo-tools { grid-template-columns: 1fr; } .env.cloudflare { max-width: none; } }
  .head-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .head-actions:not(:has(> :not([hidden]))) { display: none; }
  .merge-row { display: flex; align-items: center; gap: 10px; }
  .merge-row .count { font-size: 13px; color: var(--soft); white-space: nowrap; }
  .merge-row[hidden], #merge-hint:empty { display: none; }
  /* A downstream: where it stands against erga.dev, and Update. */
  .update-row { display: flex; align-items: center; gap: 10px; }
  .update-row .count { font-size: 13px; color: var(--soft); }
  .update-row[hidden] { display: none; }
  #update-hint { margin: 8px 0 0; font-size: 13.5px; }
  #update-hint:empty { display: none; }
  #update-hint.error { color: var(--bad); }
  .box.conflict { margin: 0 0 14px; border-color: color-mix(in srgb, var(--bad) 45%, var(--rule)); }
  .box.conflict[hidden] { display: none; }
  .box.conflict h2 { color: var(--bad); }
  .box.conflict ul { margin: 0 0 8px; padding-left: 20px; font-size: 13.5px; color: var(--fg); }
  .box.conflict li code { font: 12.5px var(--font-mono); }
  .box.conflict .ways { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin: 8px 0 0; }
  .box.conflict .ways h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--fg-strong); }
  .box.conflict .ways p { margin: 0 0 4px; }
  .box.conflict pre { margin: 4px 0 0; }
  .box.conflict .buttons { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; }
  @media (max-width: 760px) { .box.conflict .ways { grid-template-columns: 1fr; } }
  #merge-hint { margin: -4px 0 10px; font-size: 13.5px; text-align: right; }
  #merge-hint.error { color: var(--bad); }
  @media (max-width: 640px) { .pane-head { flex-direction: column; align-items: stretch; gap: 10px; } .merge-row { justify-content: space-between; } .head-actions { flex-wrap: wrap; margin-left: 0; } .merge-row { flex: 1 1 100%; } .merge-row .count { white-space: normal; flex: 1; min-width: 0; } #merge-hint { margin-top: -6px; text-align: left; } }
  .card { padding: 0 0 10px; min-width: 0; background: var(--bg); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 4px 6px; font-size: 12px; color: var(--soft); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  /* The dots: circles only. Hollow orange, only on staging; solid green, on main. */
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box; flex: none; }
  .dot.staging-only { background: var(--bg); border: 2px solid var(--only-staging); }
  .dot.on-main { background: var(--on-main); border: 2px solid var(--on-main); }
  /* Hollow blue, dashed: on erga.dev, not merged here yet. */
  .dot.upstream { background: var(--bg); border: 2px dashed var(--upstream); }
  .legend .up-only[hidden] { display: none; }
  .grid { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto auto 80px 116px 116px 116px; align-items: center; }
  .grid > .head { position: sticky; top: 0; z-index: 2; background: var(--bg); height: 58px; display: flex; align-items: flex-end; padding-bottom: 6px; box-sizing: border-box; border-bottom: 1px solid var(--rule);
    font-size: 11.5px; font-weight: 600; letter-spacing: .02em; color: var(--soft); white-space: nowrap; }
  .grid > .head.deploy { justify-content: flex-start; padding-left: 2px; }
  .target { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; max-width: 100%; border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .target:hover { background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .target b { font-weight: 650; color: var(--fg-strong); font-size: 11.5px; }
  .target .host { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--font-mono); color: var(--soft); }
  .target .st { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; font-weight: 500; font-size: 11.5px; }
  .target .st span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .target .st i { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--chrome); }
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
  .rail.upstream::before, .rail.upstream::after { background: var(--upstream); }
  .rail.up::before, .rail.down::after { display: block; }
  .rail .dot { position: relative; z-index: 1; }
  .subj { min-width: 0; padding: 0 8px 0 6px; gap: 8px; }
  .subj > span:first-child { flex: 1 1 auto; min-width: 2ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; color: var(--fg-strong); }
  /* A release or channel badge keeps its whole width: the subject shortens instead, at any width. */
  .subj .rel { flex: none; margin-left: 0; }
  .row.on-main .subj span { color: var(--fg); }
  .row.upstream .subj > span:first-child { color: var(--soft); }
  .rel.own { color: var(--only-staging); font-weight: 500; }
  /* The line between upstream's commits and this instance's: how far behind, how far ahead. */
  .gap.upstream-line .rail::before { border-left-color: var(--upstream); }
  .gap.upstream-line .gap-text { color: var(--fg); }
  .subj .here { flex: none; display: none; height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); cursor: pointer; }
  .row.staging-only:hover .subj .here, .subj .here:focus-visible { display: inline-flex; align-items: center; }
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
  .dep .w { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .dep .at { font-size: 11.5px; color: var(--chrome); font-variant-numeric: tabular-nums; }
  .dep.live { background: color-mix(in srgb, var(--on-main) 11%, transparent); color: var(--on-main); font-weight: 600; }
  .dep.live:hover { background: color-mix(in srgb, var(--on-main) 16%, transparent); }
  .dep.live .at { color: color-mix(in srgb, var(--on-main) 70%, var(--soft)); }
  .dep.failed .w { color: var(--bad); }
  .dep.cancelled .w, .dep.rolled-back .w { color: var(--chrome); text-decoration: line-through; text-decoration-thickness: 1px; }
  .dep.building .w, .dep.deploying .w { color: var(--only-staging); }
  .dep.building .w::before, .dep.deploying .w::before { content: ""; display: inline-block; vertical-align: middle; margin: -2px 6px 0 0; width: 6px; height: 6px; border-radius: 50%; background: var(--only-staging); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .head-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
  #mirror-pill { height: 28px; font-size: 12.5px; padding: 0 10px; }
  #mirror-pill.off { color: var(--bad); }
  #mirror-pill[hidden], #release-pill[hidden] { display: none; }
  /* The break, when staging is far ahead of main: a dashed rail and how many commits it leaves out. */
  .gap { display: contents; }
  .gap > * { height: var(--row); display: flex; align-items: center; }
  .gap .rail::before { content: ""; position: absolute; left: calc(50% - 1px); top: 0; bottom: 0; width: 0; height: auto; display: block; border-left: 2px dashed var(--only-staging); background: none; opacity: .5; }
  .gap .gap-text { grid-column: 2 / -1; padding: 0 6px; font: 12.5px var(--font-text); color: var(--soft); border-block: 1px dashed var(--rule); box-sizing: border-box; }
  .none { padding: 18px 4px; font-size: 13.5px; color: var(--soft); grid-column: 1 / -1; }
  @media (max-width: 760px) { .grid { grid-template-columns: 22px minmax(0, 1fr) 70px 70px 70px; } .who, .grid > .head.who-h, .sha, .grid > .head.sha-h, .row time, .grid > .head.time-h { display: none; } .target { padding: 2px 3px; } .target b { max-width: 100%; overflow: hidden; text-overflow: ellipsis; } .target b { font-size: 10.5px; } .target .st span, .target .host { display: none; } .grid > .head { height: 44px; }
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
  .box.clone { margin: 0 0 14px; padding: 10px 14px; }
  .box.clone pre { margin: 4px 0 6px; padding: 8px 12px; }
  .box.clone p { margin: 0; font-size: 12.5px; }
  .rel { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 1px 7px; border-radius: 999px; font: 600 11.5px/1.5 var(--font-text); color: var(--fg-strong); border: 1px solid var(--rule); background: color-mix(in srgb, var(--chrome) 8%, transparent); vertical-align: 1px; white-space: nowrap; }
  .rel .chan { font-weight: 500; color: var(--soft); }
  .rel .chan.stable { color: #1f9d55; }
  .rel.edge-only { color: var(--soft); font-weight: 500; }
  #release-dlg label { display: block; margin: 0 0 12px; font-size: 13px; color: var(--soft); }
  #release-dlg input, #release-dlg textarea { display: block; width: 100%; margin-top: 4px; box-sizing: border-box; font: 14px var(--font-text); padding: 7px 10px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--fg); }
  #release-dlg input { font-family: var(--font-mono); }
  #release-dlg textarea { min-height: 84px; resize: vertical; }
  #release-dlg .buttons { display: flex; align-items: center; gap: 8px; }
  #release-dlg .buttons span { flex: 1; font-size: 13px; color: var(--soft); }
  #release-dlg .buttons .error { color: var(--bad); }
  dialog#deploy-log { width: min(820px, calc(100vw - 32px)); padding: 0; }
  #deploy-log .top { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--rule); }
  #deploy-log h2 { margin: 0; font-size: 15px; }
  #deploy-log .meta { font-size: 12.5px; color: var(--soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #deploy-log .meta b { font-weight: 600; }
  #deploy-log .meta .live-on { color: var(--on-main); }
  #deploy-log .meta .bad { color: var(--bad); }
  #deploy-log .close { margin-left: auto; height: 30px; }
  #deploy-log .rollback { height: 30px; white-space: nowrap; }
  #deploy-log .rollback[data-armed="1"] { color: var(--bad); border-color: var(--bad); }
  #deploy-log pre { margin: 0; border-radius: 0 0 12px 12px; height: min(60vh, 520px); overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
  #deploy-log pre .t { color: var(--chrome); }
  #deploy-log pre .s { color: var(--soft); }
`;

/** The source pane: the commits with their deploys, Merge, how to clone; or how to set it up. */
function sourceMarkup(c: SourcePageConfig): string {
  if (!c.ready) {
    return `<div class="pane-head"><h2>Git Repository</h2></div>
  <div class="box setup"><h2>Not set up on this server</h2><p>The repository lives in Cloudflare Artifacts, which this server isn't bound to yet. The steps:</p>
  <ol><li>Make the Artifacts repo <code>erga</code> in the namespace <code>erga</code>.</li><li>Deploy with <code>ERGA_ARTIFACTS_NAMESPACE=erga</code>, which adds the binding.</li><li>Push the history in: <code>bun source/import.ts</code>.</li></ol></div>`;
  }
  const remote = `${c.origin}/git/erga.git`;
  const hosts = c.hosts ?? { production: TARGETS.production.host, staging: TARGETS.staging.host, control: CONTROL.host };
  const upstreamName = c.upstream ? esc(c.upstream.replace(/^https?:\/\//, "").replace(/^ops\./, "")) : "erga.dev";
  const target = (name: string, label: string, host: string) => `<div class="head deploy"><button class="target" type="button" id="target-${name}" data-target="${name}" disabled title="Deploys aren't set up yet"><b>${label}</b><span class="host">${esc(host)}</span><span class="st"><i></i><span>not set up</span></span></button></div>`;
  const env = (name: string, label: string, host: string) => `<div class="env" id="env-${name}" data-target="${name}"><div class="env-top"><b>${label}</b><a class="host" href="https://${esc(host)}" target="_blank" rel="noopener">${esc(host)}</a></div><span class="st"><i></i><span>not set up</span></span><span class="env-more"><code class="env-commit"></code><button class="env-log" type="button" data-target="${name}" hidden>Log</button></span><div class="env-domains" id="domains-${name}" hidden></div></div>`;
  return `
  <section class="ops-section" id="status" aria-labelledby="status-head">
    <h2 id="status-head">Status</h2>
    <h3>Environments</h3>
    <div class="envs">${env("production", "Production", hosts.production)}${env("staging", "Staging", hosts.staging)}${env("control", "Control", hosts.control)}</div>
    <h3>Cloudflare</h3>
    <div class="env cloudflare" id="env-cloudflare"><div class="env-top"><b>Deploy credential</b><a class="host" href="/install">Manage</a></div><span class="st"><i></i><span id="cloudflare-state">…</span></span></div>
  </section>
  <section class="ops-section" id="repo" aria-labelledby="repo-head">
  <div class="pane-head">
    <div class="head-title"><h2 id="repo-head">Git Repository</h2></div>
  </div>
  <p class="repo-note">${c.upstream ? `This Erga's source repository is a fork of ${upstreamName}'s, stored in a <a href="https://developers.cloudflare.com/artifacts/" target="_blank" rel="noopener">Cloudflare Artifact</a>: it can have commits of its own, and Update brings ${upstreamName}'s in.` : `Erga's source repository is self-managed and stored in a <a href="https://developers.cloudflare.com/artifacts/" target="_blank" rel="noopener">Cloudflare Artifact</a>.`}</p>
  <div class="box conflict" id="conflict-box" hidden>
    <h2>Update from ${upstreamName} stopped: <span id="conflict-count"></span></h2>
    <p>The merge of <b id="conflict-version"></b> into staging conflicts in these files. Staging is unchanged. The merge, with Git's conflict markers, waits on the branch <code id="conflict-branch"></code>.</p>
    <ul id="conflict-files"></ul>
    <div class="ways">
      <div><h3>Your admin agent resolves it</h3><p>Ask it, on any admin page: <i>resolve the update from ${upstreamName}</i>. It reads each file on that branch, writes the resolution, and finishes the merge: staging deploys it.</p></div>
      <div><h3>Your own coding agent resolves it</h3><p>In a checkout, merge ${upstreamName}'s commit, resolve, and push to staging:</p><pre><code id="conflict-git"></code></pre></div>
    </div>
    <div class="buttons"><button class="pill" id="conflict-drop" type="button" title="Drops the waiting merge and its branch. Staging stays as it is.">Drop this merge</button><span class="hint" id="conflict-hint" role="status"></span></div>
  </div>
  <div class="repo-tools">
  <div class="box clone" id="clone">
    <h2>Clone and push</h2>
    <pre><code>git remote add erga ${esc(remote)}
git fetch erga
git push erga HEAD:staging</code></pre>
    <p>Password: an agent token from <a href="/settings">Settings</a> (admins only), any username. main only follows staging: merge here.</p>
  </div>
  <div class="box actions"><h2>Branches and releases</h2>
    <div class="head-actions"><button class="pill" id="mirror-pill" type="button" hidden>GitHub</button><button class="pill" id="release-pill" type="button" hidden title="Cut a release: a version tag on main's head. The newest release tag is stable, what other installs follow.">Cut release</button><div class="merge-row" id="merge-row" hidden><span class="count" id="ahead"></span><button class="new" id="merge" disabled>Merge staging into main</button></div></div>
    <p class="hint" id="merge-hint" role="status"></p>
    <div class="update-row" id="update-row" hidden><span class="count" id="upstream-count"></span><button class="new" id="update" disabled title="Brings ${upstreamName}'s newest release into staging: a fast-forward, or a merge commit. Production follows through Merge.">Update from ${upstreamName}</button></div>
    <p class="hint" id="update-hint" role="status"></p>
  </div>
  </div>
  <section class="card" aria-label="Commits">
    <div class="legend"><span class="up-only" id="legend-upstream" hidden><i class="dot upstream"></i>on ${upstreamName}, not here yet</span><span><i class="dot staging-only"></i>only on staging</span><span><i class="dot on-main"></i>on main too</span></div>
    <div class="grid" id="grid">
      <div class="head"></div>
      <div class="head" style="padding-left:6px">Commit</div><div class="head who-h"></div><div class="head sha-h"></div><div class="head time-h"></div>
      ${target("staging", "staging", TARGETS.staging.host)}${target("production", "production", TARGETS.production.host)}${target("control", "control", CONTROL.host)}
      <div class="none" id="loading">Loading…</div>
    </div>
  </section>
  </section>
  <dialog id="domain-dlg" aria-labelledby="domain-title">
    <h2 id="domain-title">Add a domain</h2>
    <p>A hostname on one of this account's Cloudflare zones, for <b id="domain-env"></b>. Cloudflare routes it to the environment's Worker and makes its DNS record and certificate (a minute or two).</p>
    <label>Hostname<input id="domain-host" autocomplete="off" spellcheck="false" placeholder="docs.example.com"></label>
    <div class="buttons"><span id="domain-status" role="status" aria-live="polite"></span><button type="button" id="domain-cancel">Cancel</button><button type="button" class="primary" id="domain-go">Add</button></div>
  </dialog>
  <dialog id="release-dlg" aria-labelledby="release-title">
    <h2 id="release-title">Cut a release</h2>
    <p>A release is a version tag on main's head: <code id="release-head"></code>. The newest release tag is <b>stable</b>, what other installs of Erga follow; they upgrade to it once its build is in the store. <code>git push erga vX.Y.Z</code> does the same.</p>
    <label>Version<input id="release-version" autocomplete="off" spellcheck="false"></label>
    <label>Notes (the tag's message; optional)<textarea id="release-notes" placeholder="What this release brings, in a few lines"></textarea></label>
    <div class="buttons"><span id="release-status" role="status" aria-live="polite"></span><button type="button" id="release-cancel">Cancel</button><button type="button" class="primary" id="release-go">Cut release</button></div>
  </dialog>
  <dialog id="deploy-log" aria-labelledby="log-title">
    <div class="top"><h2 id="log-title">Deploy log</h2><span class="meta" id="log-meta"></span><button class="pill rollback" type="button" id="log-rollback" hidden>Roll back</button><button class="pill close" type="button" id="log-close">Close</button></div>
    <pre id="log-lines"></pre>
  </dialog>
`;
}

const SOURCE_SCRIPT = `
(() => {
  // The admin pages are one page: what keeps running stops when another admin page is shown.
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
  const TARGETS = ["staging", "production", "control"];
  /** When staging is far ahead of main: how many of its newest commits show above the break, and how many of main's below it. */
  const GAP_TOP = 11, GAP_MAIN = 6;
  let view = null, deploys = null, busy = false, drawn = false;
  const drawnRows = new WeakMap();
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
  const WORD = { building: "building", deploying: "deploying", deployed: "deployed", failed: "failed", cancelled: "cancelled", "rolled-back": "rolled back" };
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

  /** A commit's release marks: its version tag (stable on the newest), and edge on the newest commit of main the store has; "yours" on a downstream's own commit. */
  function marks(sha, own) {
    const tags = (view.tags || []).filter((t) => t.commit == sha);
    const out = [];
    if (own) out.push('<span class="rel own" title="' + esc("This instance's own commit: not on " + upstreamName()) + '">yours</span>');
    for (const t of tags) {
      const stable = t.name == view.release;
      out.push('<span class="rel" title="' + esc("Release " + t.name + (t.tagger ? " · " + t.tagger : "") + (t.at ? " · " + new Date(t.at).toLocaleString() : "") + (t.message && t.message != "Release " + t.name ? "\\n" + t.message : "") + (stable ? "\\nstable: what other installs follow" : "")) + '">' + esc(t.name) + (stable ? '<span class="chan stable">stable</span>' : "") + "</span>");
    }
    if (channels && channels.edge && channels.edge.latest && sha.startsWith(channels.edge.latest) && !tags.length) out.push('<span class="rel edge-only" title="edge: the newest commit of main in the release store">edge</span>');
    return out.join("");
  }
  const upstreamName = () => String(view?.upstream?.origin || "erga.dev").replace(/^https?:\\/\\//, "").replace(/^ops\\./, "");
  function render() {
    if (!view) return;
    const staging = view.branches.find((b) => b.name == "staging"), main = view.branches.find((b) => b.name == "main");
    const up = view.upstream || null;
    // Staging far ahead of main: its head and the GAP_TOP - 1 commits before it, a break that counts the commits left out,
    // the commits just after main's head (afterMain), then main's head and the GAP_MAIN - 1 behind it, so the list shows
    // where production is. The break only when commits are left out; else staging's log, as always.
    const recent = staging?.commits ?? [], ahead = staging?.ahead ?? 0, after = staging?.afterMain ?? [];
    const only = recent.filter((x) => !x.inMain), top = only.slice(0, GAP_TOP);
    const hidden = Math.max(0, ahead - top.length - after.length);
    const ours = hidden && after.length ? [...top, ...after.map((x) => ({ ...x, inMain: false })), ...(main?.commits ?? []).slice(0, GAP_MAIN).map((x) => ({ ...x, inMain: true }))] : recent;
    // A downstream: upstream's commits it doesn't have first, as their own kind of row, then the line that counts them.
    const theirs = (up?.commits ?? []).map((x) => ({ ...x, upstream: true }));
    const commits = [...theirs, ...ours];
    document.getElementById("loading")?.remove();
    const groups = Object.fromEntries(TARGETS.map((n) => [n, byCommit(n)]));
    // One row per commit, kept: a new commit fades in at the top, the oldest goes at the bottom.
    const rows = new Map([...grid.querySelectorAll(".row")].map((r) => [r.dataset.sha, r]));
    const want = new Set(commits.map((x) => x.sha));
    for (const [sha, r] of rows) if (!want.has(sha)) r.remove();
    grid.querySelector(".none.empty")?.remove();
    grid.querySelector(".gap")?.remove();
    if (!commits.length) { grid.insertAdjacentHTML("beforeend", '<div class="none empty">No commits yet. Push one: git push erga HEAD:staging</div>'); }
    let prev = null;
    commits.forEach((x, i) => {
      let r = rows.get(x.sha);
      if (!r) { r = document.createElement("div"); r.dataset.sha = x.sha; }
      const kind = x.upstream ? "upstream" : x.inMain ? "on-main" : "staging-only";
      const next = commits[i + 1];
      r.className = "row " + kind;
      const above = i > 0, down = !!next || x.parents.length > 0, gapAfter = hidden && after.length && i == theirs.length + top.length - 1, lineAfter = x.upstream && i == theirs.length - 1;
      const where = x.upstream ? " · on " + upstreamName() + (up.version ? " (" + up.version + ")" : "") + ", not here yet" : x.inMain ? " · on main" : " · only on staging";
      const title = x.subject + "\\n" + x.sha.slice(0, 10) + " · " + x.author + " · " + new Date(x.at).toLocaleString() + where + (x.own ? " · this instance's own" : "");
      const tail = '<span class="who">' + esc(x.author) + '</span><code class="sha">' + x.sha.slice(0, 7) + '</code><time datetime="' + new Date(x.at).toISOString() + '">' + ago(x.at) + "</time>";
      const html =
        '<span class="rail ' + (above ? "up " : "") + (down ? "down " : "") + kind + '"><i class="dot ' + kind + '" title="' + (x.upstream ? "On " + esc(upstreamName()) + ", not merged here yet" : x.inMain ? "On main (and staging)" : "Only on staging") + '"></i></span>' +
        '<span class="subj" title="' + esc(title) + '"><span>' + esc(x.subject) + "</span>" + marks(x.sha, !!x.own) + (x.inMain || x.upstream ? "" : '<button class="here" type="button" data-merge="' + x.sha + '" title="Move main forward to this commit: production deploys it">Merge to here</button>') + "</span>" + tail +
        TARGETS.map((n) => '<span class="deps" data-target="' + n + '">' + (x.upstream ? "" : deployCell(n, x.sha, groups[n])) + "</span>").join("");
      // Only a row that changed is drawn again: a button with focus, or under the pointer, stays as it is.
      if (drawnRows.get(r) != html) { r.innerHTML = html; drawnRows.set(r, html); }
      grid.insertBefore(r, prev ? prev.nextSibling : document.getElementById("target-" + TARGETS[TARGETS.length - 1]).parentElement.nextSibling);
      prev = r;
      if (lineAfter) {
        const g = document.createElement("div");
        g.className = "gap upstream-line";
        g.innerHTML = '<span class="rail"></span><span class="gap-text" title="Above: ' + esc(upstreamName()) + "'s commits this instance does not have yet. Update from " + esc(upstreamName()) + ' brings them into staging.">' + esc(positionText(up)) + "</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
      if (gapAfter) {
        const g = document.createElement("div");
        g.className = "gap";
        const n = hidden.toLocaleString() + " more commit" + (hidden == 1 ? "" : "s");
        g.innerHTML = '<span class="rail"></span><span class="gap-text" title="' + n + ' only on staging, not shown. Below: the commit main is at, which production deploys.">… ' + n + " only on staging …</span>";
        grid.insertBefore(g, prev.nextSibling);
        prev = g;
      }
    });
    renderUpstream(up);
    drawn = true;
    const mergeBtn = document.getElementById("merge");
    // The Merge row is always there (it is how production deploys): disabled, and saying so, when main is at staging.
    // While a merge runs the button stays, disabled.
    document.getElementById("merge-row").hidden = !staging?.commit;
    document.getElementById("ahead").textContent = !staging?.commit ? "" : ahead ? ahead + " commit" + (ahead == 1 ? "" : "s") + " to merge" : "staging and production are the same";
    if (!busy) mergeBtn.disabled = !ahead;
    mergeBtn.title = ahead ? "Moves main to staging's head: production deploys it." : "Nothing to merge: main is at staging's head. Push to staging first.";
    // Cut release: when main has a commit; a downstream's releases are upstream's.
    const rp = document.getElementById("release-pill");
    if (rp) { rp.hidden = !main?.commit || !!up; rp.textContent = view.release ? "Cut release (" + view.release + " is stable)" : "Cut release"; }
    // The GitHub mirror, beside Merge. Its title has the URL and any error; a click opens its dialog.
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
  const conflictCount = (n) => (n == 1 ? "1 file conflicts" : n + " files conflict");
  /** "erga.dev: 12 commits (v0.15.0) that you do not have · 3 commits of your own". */
  function positionText(up) {
    const n = (k, w) => k + " commit" + (k == 1 ? "" : "s") + w;
    const behind = up.behind ? upstreamName() + ": " + n(up.behind, " (" + (up.version || up.channel) + ") that you do not have") : "up to date with " + upstreamName() + (up.version ? " " + up.version : "");
    return behind + " · " + (up.own ? n(up.own, " of your own") : "no commits of your own");
  }
  /** The Update row and the conflict box, from the view's upstream (a downstream only). */
  function renderUpstream(up) {
    const row = document.getElementById("update-row"), legend = document.getElementById("legend-upstream"), box = document.getElementById("conflict-box");
    row.hidden = !up; legend.hidden = !up; box.hidden = !up || !up.conflict;
    if (!up) return;
    const btn = document.getElementById("update"), count = document.getElementById("upstream-count");
    count.textContent = up.error ? upstreamName() + " did not answer: " + up.error : positionText(up);
    if (!updating) btn.disabled = !up.behind || !!up.conflict;
    btn.title = up.conflict ? "A merge is waiting on conflicts: resolve or drop it first." : up.behind ? "Brings " + upstreamName() + "'s " + (up.version || "newest") + " into staging: a fast-forward, or a merge commit. Production follows through Merge." : "Nothing to update: staging has everything " + upstreamName() + "'s " + up.channel + " channel has.";
    const c = up.conflict;
    if (!c) return;
    document.getElementById("conflict-count").textContent = conflictCount(c.files.length);
    document.getElementById("conflict-version").textContent = c.version;
    document.getElementById("conflict-branch").textContent = c.branch;
    document.getElementById("conflict-files").innerHTML = c.files.map((f) => "<li><code>" + esc(f.path) + "</code> <span class='soft'>(" + esc(f.kind) + ")</span></li>").join("");
    document.getElementById("conflict-git").textContent = ["git fetch erga erga-upstream/main", "git checkout -B update erga/staging", "git merge FETCH_HEAD   # resolve the conflicts, then commit", "git push erga HEAD:staging"].join("\\n");
  }
  let updating = false;
  const updateHint = document.getElementById("update-hint");
  document.getElementById("update").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    updating = true; btn.disabled = true; updateHint.className = "hint"; updateHint.textContent = "Updating from " + upstreamName() + "…";
    try {
      const r = await fetch("/api/source/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The update failed (HTTP " + r.status + ").");
      updateHint.textContent = body.result == "up-to-date" ? "Nothing to update: staging has everything."
        : body.result == "conflicts" ? "Stopped: " + conflictCount(body.conflict.files.length) + ". Staging is unchanged; see below."
        : (body.result == "fast-forward" ? "Fast-forwarded" : "Merged") + " " + body.version + " into staging (" + body.brought + " commit" + (body.brought == 1 ? "" : "s") + "): staging deploys it. Merge to production when it's good.";
      if (body.result == "conflicts") updateHint.className = "hint error";
    } catch (err) { updateHint.className = "hint error"; updateHint.textContent = err.message; }
    updating = false;
    await load();
  });
  document.getElementById("conflict-drop").addEventListener("click", async (e) => {
    const btn = e.currentTarget, hint = document.getElementById("conflict-hint");
    if (btn.dataset.armed != "1") { btn.dataset.armed = "1"; btn.textContent = "Click again to drop it"; setTimeout(() => { if (btn.dataset.armed == "1") { btn.dataset.armed = ""; btn.textContent = "Drop this merge"; } }, 8000); return; }
    btn.dataset.armed = ""; btn.textContent = "Drop this merge"; btn.disabled = true;
    const r = await fetch("/api/source/update/abandon", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    hint.textContent = !r || !r.ok ? (body.error || "Couldn't drop it.") : "";
    btn.disabled = false;
    await load();
  });

  // Each environment's domains (its Worker's custom domains), with Add and remove.
  let domains = null;
  async function loadDomains() {
    const r = await fetch("/api/domains", { headers: { Accept: "application/json" } }).catch(() => null);
    const body = r && r.ok ? await r.json().catch(() => null) : null;
    if (pageView.signal.aborted) return;
    domains = body && !body.error ? body : null;
    renderDomains();
  }
  function renderDomains() {
    for (const n of TARGETS) {
      const el = document.getElementById("domains-" + n);
      const list = domains && domains.targets && domains.targets[n];
      el.hidden = !list;
      if (!list) continue;
      el.innerHTML = list.map((d) => '<span class="dom' + (d.primary ? " primary" : "") + '" title="' + esc(d.hostname + (d.zone ? " · zone " + d.zone : "") + (d.primary ? " · the environment's own address" : "")) + '"><span>' + esc(d.hostname) + "</span>" + (d.primary ? "" : '<button type="button" data-remove="' + esc(d.hostname) + '" data-target="' + n + '" title="Remove this domain from ' + n + '" aria-label="Remove ' + esc(d.hostname) + '">×</button>') + "</span>").join("") +
        '<button class="add" type="button" data-add="' + n + '">+ Add domain</button>';
    }
  }
  const domDlg = document.getElementById("domain-dlg");
  document.getElementById("status").addEventListener("click", async (e) => {
    const add = e.target.closest("button[data-add]"), rm = e.target.closest("button[data-remove]");
    if (add) {
      domDlg.dataset.target = add.dataset.add;
      document.getElementById("domain-env").textContent = add.dataset.add;
      document.getElementById("domain-host").value = "";
      document.getElementById("domain-status").textContent = ""; document.getElementById("domain-status").className = "";
      document.getElementById("domain-go").disabled = false;
      if (!domDlg.open) domDlg.showModal();
      document.getElementById("domain-host").focus();
    }
    if (rm) {
      if (rm.dataset.armed != "1") { rm.dataset.armed = "1"; rm.textContent = "remove?"; rm.parentElement.style.borderColor = "var(--bad)"; setTimeout(() => { if (rm.dataset.armed == "1") { rm.dataset.armed = ""; rm.textContent = "×"; rm.parentElement.style.borderColor = ""; } }, 6000); return; }
      rm.disabled = true;
      const r = await fetch("/api/domains", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: rm.dataset.target, hostname: rm.dataset.remove }) }).catch(() => null);
      if (!r || !r.ok) { const body = r ? await r.json().catch(() => ({})) : {}; rm.disabled = false; rm.title = body.error || "Couldn't remove it."; rm.textContent = "!"; return; }
      await loadDomains();
    }
  });
  document.getElementById("domain-cancel").addEventListener("click", () => domDlg.close());
  document.getElementById("domain-go").addEventListener("click", async (e) => {
    const status = document.getElementById("domain-status"), hostname = document.getElementById("domain-host").value.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) { status.className = "error"; status.textContent = "A hostname looks like docs.example.com."; return; }
    e.currentTarget.disabled = true; status.className = ""; status.textContent = "Adding " + hostname + "…";
    try {
      const r = await fetch("/api/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: domDlg.dataset.target, hostname }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      status.textContent = "Added. Cloudflare makes its DNS record and certificate in a minute or two.";
      await loadDomains();
      setTimeout(() => domDlg.close(), 1200);
    } catch (err) { status.className = "error"; status.textContent = err.message; e.currentTarget.disabled = false; }
  });

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
    // Status: the control Worker's Cloudflare credential (an admin's OAuth grant), and each environment's state.
    const cred = deploys && deploys.credential, cf = document.getElementById("env-cloudflare");
    cf.className = "env cloudflare " + (!cred ? "" : cred.connected ? "deployed" : "failed");
    document.getElementById("cloudflare-state").textContent = !cred ? "unknown" : cred.connected ? "connected" + (cred.by ? " by " + cred.by : "") : "Nothing deploys: " + (cred.problem || "not connected.");
    for (const n of TARGETS) {
      const e = document.getElementById("env-" + n), t = targetOf(n);
      e.className = "env " + (t ? t.state : "");
      const what = !t ? "not set up" : { idle: "idle", building: "building", deploying: "deploying", deployed: "live", failed: "failed", cancelled: "cancelled" }[t.state] || t.state;
      e.querySelector(".st span").textContent = what + (t?.at ? " · " + ago(t.at) : "");
      e.querySelector(".st").title = t?.error || "";
      e.querySelector(".env-commit").textContent = t?.deployed ? t.deployed.slice(0, 7) : "";
      e.querySelector(".env-log").hidden = !t;
      // The environment's own address, as the deploys know it (a fork's are its own, not erga.dev's).
      if (t?.host) { const a = e.querySelector(".env-top .host"); a.textContent = t.host; a.href = "https://" + t.host; const h = document.querySelector("#target-" + n + " .host"); if (h) h.textContent = t.host; }
    }
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
      view = body; render();
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
    // Roll back: on the live deploy's log, when it has a restore point and nothing runs. Two clicks: the first arms it.
    const rb = document.getElementById("log-rollback"), restore = log.restore || null;
    const can = !!(log.live && restore && restore.versionId && !running(log.state) && !running(t?.state));
    if (can && rb.dataset.deploy != log.deployId) { rb.dataset.armed = ""; rb.textContent = "Roll back"; rb.disabled = false; }
    rb.hidden = !can;
    rb.dataset.target = name; rb.dataset.deploy = log.deployId || "";
    rb.dataset.to = can ? (restore.version ? "release " + restore.version : "version " + restore.versionId.slice(0, 8)) : "";
    rb.title = can ? "Puts back what " + (t?.host ?? name) + " ran before this deploy (" + rb.dataset.to + "), in seconds, with no build. The database keeps its schema." : "";
    if (lines.length > open.shown) { append(lines.slice(open.shown)); open.shown = lines.length; }
    if (first) pre.scrollTop = pre.scrollHeight;
  }
  document.getElementById("log-rollback").addEventListener("click", async (e) => {
    const rb = e.currentTarget;
    if (rb.dataset.armed != "1") {
      rb.dataset.armed = "1"; rb.textContent = "Click again to roll back to " + rb.dataset.to;
      setTimeout(() => { if (rb.dataset.armed == "1") { rb.dataset.armed = ""; rb.textContent = "Roll back"; } }, 8000);
      return;
    }
    rb.disabled = true; rb.textContent = "Rolling back…";
    const meta = document.getElementById("log-meta");
    try {
      const r = await fetch("/api/deploys/" + rb.dataset.target + "/rollback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "The rollback failed (HTTP " + r.status + ").");
      // The log follows the target's latest deploy now: the rollback's.
      if (open) open.pinned = false;
      rb.hidden = true; rb.dataset.armed = ""; rb.textContent = "Roll back"; rb.disabled = false;
      loadDeploys();
      refreshLog(false);
    } catch (err) {
      meta.innerHTML = '<span class="bad">' + esc(err.message) + "</span>";
      rb.dataset.armed = ""; rb.textContent = "Roll back"; rb.disabled = false;
    }
  });
  // Live lines come as events from the server running the deploy, passed on by the other server only while someone
  // listens there: while the deploy shown runs and no events arrive, ask for the log every two seconds.
  setInterval(() => {
    if (!open || !dlg.open) return;
    const t = targetOf(open.target);
    if (!(running(open.state) || (!open.pinned && running(t?.state)))) return;
    if (Date.now() - open.heard < 2500) return;
    refreshLog(false);
  }, 2000);
  for (const n of TARGETS) document.getElementById("target-" + n).addEventListener("click", () => openLog(n));
  for (const b of document.querySelectorAll(".env-log")) b.addEventListener("click", () => openLog(b.dataset.target));
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
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-merge]");
    if (b) return merge(b.dataset.merge);
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

  // The store's channels, for the marks on the log: edge's latest, and stable.
  let channels = null;
  async function loadReleases() {
    const r = await fetch("/api/releases", { headers: { Accept: "application/json" } }).catch(() => null);
    const body = r && r.ok ? await r.json().catch(() => null) : null;
    if (pageView.signal.aborted) return;
    channels = body && !body.error ? body : null;
    render();
  }
  // Cut release: the next version suggested, the notes as the tag's message.
  const relDlg = document.getElementById("release-dlg");
  function nextVersion(latest) { const m = latest && /^v(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(latest); return m ? "v" + m[1] + "." + m[2] + "." + (Number(m[3]) + 1) : "v0.1.0"; }
  document.getElementById("release-pill")?.addEventListener("click", () => {
    const main = view?.branches.find((b) => b.name == "main");
    document.getElementById("release-head").textContent = main?.commit ? main.commit.slice(0, 10) + " · " + (main.commits[0]?.subject ?? "") : "";
    document.getElementById("release-version").value = nextVersion(view?.release);
    document.getElementById("release-notes").value = "";
    document.getElementById("release-status").textContent = view?.release ? "The newest release is " + view.release + "." : "The first release.";
    document.getElementById("release-status").className = "";
    document.getElementById("release-go").disabled = false;
    if (!relDlg.open) relDlg.showModal();
  });
  document.getElementById("release-cancel").addEventListener("click", () => relDlg.close());
  document.getElementById("release-go").addEventListener("click", async (e) => {
    const status = document.getElementById("release-status");
    const version = document.getElementById("release-version").value.trim(), notes = document.getElementById("release-notes").value.trim();
    if (!/^v\\d+\\.\\d+\\.\\d+$/.test(version)) { status.className = "error"; status.textContent = "A version looks like v1.2.3."; return; }
    e.currentTarget.disabled = true; status.className = ""; status.textContent = "Cutting " + version + "…";
    try {
      const r = await fetch("/api/source/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, ...(notes ? { notes } : {}) }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "HTTP " + r.status);
      status.textContent = "Release " + body.tag + " cut at " + body.commit.slice(0, 10) + ". It goes on stable once its build is in the store.";
      await load(); loadReleases();
      setTimeout(() => relDlg.close(), 1500);
    } catch (err) { status.className = "error"; status.textContent = err.message; e.currentTarget.disabled = false; }
  });

  // Live: an event says what changed; a reconnect reloads everything. A stream the server answers with an error
  // (a server restarting into its new version) the browser closes for good: open it again.
  let heard = 0;
  function listen() {
    if (pageView.signal.aborted) return;
    const events = new EventSource("/api/events");
    pageView.onLeave(() => events.close());
    events.onopen = () => { load(); loadDeploys(); loadReleases(); loadDomains(); };
    events.onerror = () => { if (events.readyState == EventSource.CLOSED) setTimeout(listen, 3000); };
    events.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type == "source") { load(); loadDeploys(); } // a move starts a deploy, here or on another server
      if (ev.type == "deploys") { heard = Date.now(); loadDeploys(); }
      if (ev.type == "releases") loadReleases();
      if (ev.type == "domains") loadDomains();
      if (ev.type == "deploy-log" && open && ev.target == open.target) {
        if (ev.deployId == open.deployId) { open.heard = Date.now(); append(ev.lines || []); open.shown += (ev.lines || []).length; }
        else if (!open.pinned) { open.heard = Date.now(); refreshLog(false); }
      }
    };
  }
  listen();
  load(); loadDeploys(); loadReleases(); loadDomains();
  // Events don't tell everything: the other server's events can fail to come (no DEPLOY_HOOK_SECRET, or it doesn't
  // answer), and a server that deploys itself cuts the stream and can miss its last change. So while
  // a deploy shows running (or the status didn't load) and no event came lately, ask for the status every two seconds.
  setInterval(() => {
    if (asking || Date.now() - heard < 2500) return;
    if (!deploys || deploys.targets?.some((t) => running(t.state) || t.history?.some((r) => running(r.state)))) loadDeploys();
  }, 2000);
  // A downstream reads its position against upstream again now and then (upstream moves without an event here).
  setInterval(() => { if (view?.upstream) load(); else render(); renderTargets(); }, 30000);
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
 * A pane's stylesheet, scoped to the pane (`scope`, an id selector), so its rules (a .card, a .row, a .dep...)
 * never meet the layout's. A width query measures the pane, not the window
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
  /* The dashboard, beside the agent. */
  .panes { min-width: 0; display: flex; flex-direction: column; gap: 28px; }
  .pane { container-type: inline-size; min-width: 0; }
  .pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  .pane-head h2 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  .pane-head .sub { margin: 2px 0 0; font-size: 13px; }
  .pane-note { margin: -4px 0 10px; font-size: 13px; color: var(--soft); }
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

/** /admin/ops: the source and deploy dashboard (admins). */
export function adminSourcePage(c: SourcePageConfig): Response {
  if (!c.admin) return plainPage("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return (c.layout ?? adminResponse)({ session: c.session, title: "Ops", here: "ops", wide: true, style: PAGE_STYLE + scopeCss(SOURCE_STYLE, "#source-pane"), body: `
  <div class="panes">
    <section class="pane" id="source-pane" aria-label="Ops">${sourceMarkup(c)}</section>
  </div>
  ${c.ready ? mirrorDialog(c) : ""}
${c.ready ? `<script>${SOURCE_SCRIPT}</script>` : ""}` });
}
