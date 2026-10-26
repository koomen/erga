// The Ops page's look (/admin/ops, control/source/page.ts): the dashboard's panes, and the source pane's own rules,
// scoped to it. Part of the one stylesheet of the admin pages (server/admin/style.ts), which the build writes as
// admin.css (client/build.ts): no import here but plain strings, so the build can read it.

const SOURCE_STYLE = `
  :root { --on-main: #1f7a4d; --only-staging: #c26a00; --upstream: #2563eb; --bad: #c2410c; --row: 32px; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --on-main: #4cc38a; --only-staging: #f0a742; --upstream: #7aa7ff; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --on-main: #4cc38a; --only-staging: #f0a742; --upstream: #7aa7ff; --bad: #ff8a65; }
  .pane-head { justify-content: space-between; }
  /* Ops: Status (each environment, and the Cloudflare credential), then the Git repository. */
  .ops-section { margin: 0 0 40px; }
  #status-head { margin: 0 0 4px; }
  .ops-section h3 { margin: 14px 0 8px; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--soft); }
  .envs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .env { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 12px; }
  .env.cloudflare, .env.github { max-width: calc((100% - 24px) / 3); box-sizing: border-box; }
  .services { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .services .env.cloudflare, .services .env.github { max-width: none; }
  .env.github .st i.busy { background: transparent; border: 2px solid var(--only-staging); border-right-color: transparent; width: 6px; height: 6px; animation: spin .8s linear infinite; }
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
  .env-log { margin-left: auto; height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--fg-strong); font: 550 12px var(--font-text); white-space: nowrap; cursor: pointer; }
  .env-log:hover { background: color-mix(in srgb, var(--chrome) 10%, transparent); }
  .env-log[hidden] { display: none; }
  .env-retry { margin-left: auto; height: 22px; padding: 0 8px; border: 1px solid var(--bad); border-radius: 6px; background: var(--bg); color: var(--bad); font: 550 12px var(--font-text); cursor: pointer; }
  .env-retry + .env-log { margin-left: 0; }
  .env-retry[hidden], .cf-connect[hidden] { display: none; }
  .env-retry:hover { background: color-mix(in srgb, var(--bad) 10%, transparent); }
  .env.cloudflare .env-more, .env.github .env-more { gap: 8px; }
  .env.cloudflare .cf-connect, .env.github .cf-connect { height: 28px; }
  .env.cloudflare .cf-connect + .env-log, .env.github .cf-connect + .env-log, .env.github .env-log + .env-log { margin-left: 0; }
  .cf-why, .cf-note { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--soft); overflow-wrap: anywhere; }
  .cf-why { color: var(--fg); }
  .cf-note.bad { color: var(--bad); }
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
  #release-pill[hidden] { display: none; }
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

const PANES_STYLE = `
  /* The dashboard, beside the agent. */
  .panes { min-width: 0; display: flex; flex-direction: column; gap: 28px; }
  .pane { container-type: inline-size; min-width: 0; }
  .pane-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 10px; }
  /* Its headings look as every admin page's (server/admin/style.ts). */
  .pane-head h2 { margin: 0; }
  .pane-head .sub { margin: 2px 0 0; font-size: 13px; }
`;

/** The Ops page's rules: the panes, and the source pane's, scoped to #source-pane. */
export const OPS_STYLE = PANES_STYLE + scopeCss(SOURCE_STYLE, "#source-pane");
