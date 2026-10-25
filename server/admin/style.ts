// The one stylesheet of every admin page (server/admin/layout.ts: /admin, API keys, Authentication, the change log,
// Users, Ops and the Cloudflare page), and of the control Worker's pages in the same layout (control/routes.ts). The
// build writes it as admin.css, named by its hash (client/build.ts), and every admin page links the same file, so the
// browser keeps one copy, and a page shown in place (client/admin-nav.ts) needs no style of its own. A page can't add
// its own: one look, the same on every page. Here are only plain strings, so the build can read them.
//
// The look of a thing is the same wherever it is: a section's heading, a lede, a row, a setting's row, a switch, a
// state line, a card's title, and the colours for working, waiting and failed.

import { OPS_STYLE } from "../source/style.ts";

const LAYOUT_STYLE = `
  /* The header: the breadcrumbs upper left; Share with agent left of the account corner upper right. */
  /* The header bar: left of your avatar, as the editor's icons are; it scrolls with the page, as the avatar does. */
  .chrome-top { position: absolute; right: calc(max(16px, env(safe-area-inset-right)) + 38px); }
  /* The sidebar beside the page. */
  .admin-body { flex: 1; display: flex; align-items: flex-start; min-width: 0; padding: 62px 0 0 max(8px, env(safe-area-inset-left)); }
  .admin-side { position: sticky; top: 12px; flex: none; box-sizing: border-box; width: 196px; padding: 0 12px 0 4px; overflow: hidden;
    transition: width 240ms cubic-bezier(0.2, 0.7, 0.2, 1), padding 240ms cubic-bezier(0.2, 0.7, 0.2, 1); }
  .admin-side ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .admin-side a, .side-toggle { box-sizing: border-box; display: flex; align-items: center; gap: 11px; height: 34px; padding: 0 9px; border-radius: 8px; white-space: nowrap;
    color: var(--soft); text-decoration: none; font-size: 13.5px; font-weight: 500; transition: background-color 120ms ease, color 120ms ease; }
  .admin-side a:hover, .side-toggle:hover { color: var(--fg-strong); background: color-mix(in srgb, var(--chrome) 12%, transparent); }
  .admin-side a[aria-current="page"] { color: var(--fg-strong); background: color-mix(in srgb, var(--chrome) 16%, transparent); }
  .admin-side svg { flex: none; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .admin-side .label { transition: opacity 180ms ease; }
  .side-toggle { width: 36px; padding: 0 9px; border: 0; background: transparent; cursor: pointer; font: inherit; }
  :is(.admin-side a, .side-toggle):focus-visible { outline: 2px solid var(--caret); outline-offset: 1px; }
  /* Collapsed: a rail of icons, so the page gets the width. */
  .side-closed .admin-side { width: 52px; padding-right: 4px; }
  .side-closed .admin-side .label { opacity: 0; }
  /* No animation as the page opens in the state it remembers: only when it's toggled. */
  :root:not(.side-ready) .admin-side, :root:not(.side-ready) .admin-side .label { transition: none; }
  @media (prefers-reduced-motion: reduce) { .admin-side, .admin-side .label { transition: none; } }
  /* The admin's agent and the page: a grid of two, the agent on the left, as the editor's card, or on the right. As in the
     editor, the user drags the agent by its head to the other side, and its inner edge to resize it (client/layout.ts,
     mountPaneLayout, sets --agent-w and .agent-right; the grip and the ghost are style.css's). Collapsed, the agent is a
     round button in the lower corner on its side; expanding grows the card out of that corner (a clip-path from the
     button's circle), and the page slides over. */
  :root { --agent-fab: 44px; --agent-ms: 480ms; --agent-ease: cubic-bezier(0.45, 0, 0.15, 1); }
  .admin-work { --agent-w: 380px; flex: 1; min-width: 0; display: grid; grid-template-columns: var(--agent-w) minmax(0, 1fr); column-gap: 20px; align-items: start;
    transition: grid-template-columns var(--agent-ms) var(--agent-ease), column-gap var(--agent-ms) var(--agent-ease); }
  .admin-work.agent-right { grid-template-columns: minmax(0, 1fr) var(--agent-w); }
  .agent-closed .admin-work { grid-template-columns: 0px minmax(0, 1fr); column-gap: 0px; }
  .agent-closed .admin-work.agent-right { grid-template-columns: minmax(0, 1fr) 0px; }
  .agent-dock { grid-row: 1; grid-column: 1; position: sticky; top: 12px; height: calc(100vh - 78px); height: calc(100dvh - 78px); min-height: 420px; min-width: 0; }
  .admin-work > main { grid-row: 1; grid-column: 2; }
  .admin-work.agent-right .agent-dock { grid-column: 2; }
  .admin-work.agent-right > main { grid-column: 1; }
  .agent-dock.layout-dragged { position: fixed; z-index: 40; }
  .agent-dock.layout-dragged .agent-card { box-shadow: 0 24px 48px rgba(0, 0, 0, 0.2), 0 2px 6px rgba(0, 0, 0, 0.08); }
  .agent-dock .agent-head { cursor: grab; user-select: none; touch-action: none; }
  .agent-closed .agent-dock .agent-resize { display: none; }
  body.layout-resizing :is(.admin-work, .admin-work *), body.layout-dragging .admin-work { transition: none !important; }
  body.layout-resizing iframe, body.layout-dragging iframe { pointer-events: none; }
  .admin-agent { position: absolute; inset: 0; filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.09)) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.05)); transition: visibility 0s; }
  .admin-agent .agent-card { position: absolute; top: 0; bottom: 0; left: 0; width: var(--agent-w); display: flex; flex-direction: column; box-sizing: border-box;
    background: var(--bg); border: 1px solid var(--panel-border); border-radius: 18px; font: 14px/1.55 var(--font-text); color: var(--fg); overflow: hidden;
    clip-path: inset(0 0 0 0 round 18px); opacity: 1; transition: clip-path var(--agent-ms) var(--agent-ease), opacity 0s; }
  .agent-right .admin-agent .agent-card { left: auto; right: 0; }
  .admin-agent .agent-head .title { white-space: nowrap; }
  .admin-agent .agent-card > * { transition: opacity 280ms ease 200ms; }
  .agent-closed .admin-agent { visibility: hidden; transition: visibility 0s linear var(--agent-ms); }
  .agent-closed .admin-agent .agent-card { clip-path: inset(calc(100% - var(--agent-fab)) calc(100% - var(--agent-fab)) 0 0 round calc(var(--agent-fab) / 2)); opacity: 0;
    transition: clip-path var(--agent-ms) var(--agent-ease), opacity 180ms ease 200ms; }
  .agent-closed .agent-right .admin-agent .agent-card { clip-path: inset(calc(100% - var(--agent-fab)) 0 0 calc(100% - var(--agent-fab)) round calc(var(--agent-fab) / 2)); }
  .agent-closed .admin-agent .agent-card > * { opacity: 0; transition: opacity 120ms ease; }
  .admin-fab { position: fixed; left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 21;
    width: var(--agent-fab); height: var(--agent-fab); border-radius: 50%; border: 1px solid var(--panel-border); display: grid; place-items: center; padding: 0; cursor: pointer;
    background: var(--panel-bg, var(--bg)); color: var(--chrome-hover); box-shadow: var(--shadow, 0 6px 24px rgba(0, 0, 0, 0.1)); opacity: 0; pointer-events: none; transition: opacity 200ms ease, box-shadow 200ms ease; }
  .agent-right .admin-fab { left: auto; right: max(16px, env(safe-area-inset-right)); }
  .admin-fab:hover { box-shadow: 0 10px 34px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.06); }
  .admin-fab:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
  .admin-fab svg { width: 22px; height: 22px; }
  .admin-fab.busy::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--caret); animation: admin-agent-spin 0.9s linear infinite; }
  @keyframes admin-agent-spin { to { transform: rotate(360deg); } }
  .agent-closed .admin-fab { opacity: 1; pointer-events: auto; transition: opacity 200ms ease 220ms, box-shadow 200ms ease; }
  :root:not(.agent-ready) :is(.admin-work, .admin-agent, .admin-agent .agent-card, .admin-agent .agent-card > *, .admin-fab) { transition: none !important; }
  @media (prefers-reduced-motion: reduce) { :is(.admin-work, .admin-agent, .admin-agent .agent-card, .admin-agent .agent-card > *, .admin-fab) { transition: none !important; } }
  /* Narrower, it covers the page while it's open, from the lower left; no dragging or resizing. */
  @media (max-width: 999.98px) {
    .admin-work, .admin-work.agent-right { display: block; }
    .agent-dock, .agent-closed .agent-dock { position: fixed; z-index: 22; top: max(56px, env(safe-area-inset-top)); bottom: max(12px, env(safe-area-inset-bottom)); left: max(12px, env(safe-area-inset-left));
      width: min(380px, calc(100vw - 24px)); height: auto; min-height: 0; }
    .agent-dock .agent-head { cursor: auto; }
    .agent-dock .agent-resize { display: none; }
    .admin-agent .agent-card, .agent-right .admin-agent .agent-card { width: 100%; left: 0; right: auto; }
    .agent-closed .agent-right .admin-agent .agent-card { clip-path: inset(calc(100% - var(--agent-fab)) calc(100% - var(--agent-fab)) 0 0 round calc(var(--agent-fab) / 2)); }
    .agent-right .admin-fab { left: max(16px, env(safe-area-inset-left)); right: auto; }
  }
  main.admin-main { min-width: 0; max-width: 880px; margin: 0 auto; padding: 8px 24px 96px; }
  main.admin-main.wide { max-width: none; margin: 0; padding: 0 max(16px, env(safe-area-inset-right)) 24px 8px; }
  /* Room on the right, for the agent docked there; the wide page (the Ops page) has none of its own then. */
  @media (min-width: 1000px) { .admin-body { padding-right: max(16px, env(safe-area-inset-right)); } main.admin-main.wide { padding-right: 0; } }
  main.admin-main > header { margin-bottom: 24px; }
  /* A phone: the links in a row above the page, always with their labels. */
  @media (max-width: 720px) {
    .admin-body { flex-direction: column; align-items: stretch; padding: 58px 0 0; }
    .admin-side, .side-closed .admin-side { position: static; width: auto; padding: 0 12px 8px; }
    .admin-side ul { flex-direction: row; margin: 0; overflow-x: auto; }
    .side-closed .admin-side .label { opacity: 1; }
    .side-toggle { display: none; }
    main.admin-main, main.admin-main.wide { padding: 8px 16px 64px; }
  }
`;

/** The admin pages' own parts, after the layout. */
const PAGES_STYLE = `
  /* Working, waiting and failed: one colour each, on every page. */
  :root { --ok: #1f7a4d; --warn: #b45309; --bad: #c2410c; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ok: #4cc38a; --warn: #f0a742; --bad: #ff8a65; } }
  :root[data-theme="dark"] { --ok: #4cc38a; --warn: #f0a742; --bad: #ff8a65; }
  .hint.error { color: var(--bad); }

  /* A section, and its heading: the same on every page (the Ops page's Status and Git Repository, the Cloudflare page's too). */
  :where(main.admin-main > section) { margin-bottom: 40px; }
  :where(main.admin-main > section > h2, main.admin-main .pane-head h2, #status-head, .install > h2) { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px;
    font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--fg-strong); }
  :where(main.admin-main) h2 small { font-size: 13px; font-weight: 400; letter-spacing: normal; color: var(--soft); }
  /* The lines under a heading that say what the section is. */
  .lede { margin: 0 0 16px; font-size: 13.5px; color: var(--soft); }
  ol.rows > li .doc { cursor: default; }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }

  /* A setting's row (its key, description and control), on Settings and API keys. */
  ol.rows > li.setting { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 10px 4px; }
  .setting .about { min-width: 0; }
  .setting .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .setting .key { margin: 0; font-family: var(--font-mono); font-size: 13.5px; color: var(--fg-strong); }
  .setting .desc { margin: 2px 0 0; font-size: 13px; color: var(--soft); }
  .setting .meta { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 5px; font-size: 12px; color: var(--soft); }
  .setting .meta .badge { margin: 0; }
  .setting .meta time { margin: 0; font-size: inherit; }
  .setting .meta a { color: inherit; }
  .setting .meta .gone { color: var(--bad); }
  .setting .value { display: flex; align-items: center; gap: 6px; }
  .setting .value .input { width: 7.5em; text-align: right; font-feature-settings: "tnum"; }
  .setting .value .input:not([type=number]) { width: 12em; text-align: left; }
  .setting .value .amount { display: flex; align-items: center; gap: 6px; }
  .setting .value .amount[hidden] { display: none; }
  .setting .value .unit { font-size: 13.5px; color: var(--soft); }
  .setting .set { margin: 3px 0 0; font-size: 12px; color: var(--chrome); }
  .setting .hint { grid-column: 1 / -1; margin: 0; }
  .setting .value select { min-width: 9em; height: 34px; }
  .setting .value .input.pick { width: 9em; }
  .setting .value .input.secret { width: 15em; font-family: var(--font-mono); font-size: 12.5px; }
  .setting .value [hidden] { display: none; }
  @media (max-width: 520px) { ol.rows > li.setting { grid-template-columns: 1fr; } .setting .value { justify-content: flex-end; } }
  .picker { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; max-width: 26em; }
  .chips { display: contents; list-style: none; margin: 0; padding: 0; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 26px; padding: 0 4px 0 10px; border-radius: 999px; font-size: 13px; color: var(--fg-strong); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .chip:not(:has(button)) { padding-right: 10px; }
  .unpick { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--chrome); cursor: pointer; }
  .unpick:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 18%, transparent); }
  .unpick svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

  /* A switch (a setting, a user's role): the track, and On or Off beside it where the row says it. Blue when on, grey when
     off: the editor's colours (its switches and buttons, client/editor.html .fmt-switch), light or dark. */
  .switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--soft); user-select: none; }
  .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
  .switch .track { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; background: var(--rule); transition: background-color 150ms ease; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 150ms ease; }
  .switch input:checked + .track { background: var(--caret); }
  .switch input:checked + .track::after { transform: translateX(14px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--caret); outline-offset: 2px; }
  .switch .state { min-width: 2em; }
  .switch:has(input:disabled) { cursor: default; opacity: 0.5; }

  /* A state line: what a credential is now (an API key, the Cloudflare grant), the word that matters strong; a dot before it, where the page has one. */
  .state-line { margin: 3px 0 0; font-size: 13px; color: var(--soft); }
  .state-line :is(.on, b) { color: var(--fg-strong); font-weight: 600; }
  .state-line .last4 { font-family: var(--font-mono); font-size: 12px; color: var(--fg); }
  .state-line .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: var(--chrome); vertical-align: 1px; }
  .state-line.ok .dot { background: var(--ok); }
  .state-line.bad .dot { background: var(--bad); }

  /* Authentication: a card for each server. */
  section.provider { margin: 26px 0 0; }
  section.provider > header { display: flex; justify-content: flex-start; align-items: center; gap: 14px; margin: 0 0 10px; }
  .provider-head { margin: 0; font-size: 15px; font-weight: 600; color: var(--fg-strong); }
  section.provider > .provider-hint { margin: -4px 0 10px; }
  .server { margin: 0 0 22px; padding: 18px 20px 20px; border: 1px solid var(--rule); border-radius: 12px; }
  .server > header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin: 0 0 6px; }
  .server h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg-strong); }
  .server h3 small { margin-left: 6px; font-size: 13px; font-weight: 400; color: var(--soft); }
  .server .state { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
  .server .state::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .server .state.working { color: var(--ok); background: color-mix(in srgb, var(--ok) 13%, transparent); }
  .server .state.misconfigured { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
  .server .state.not_set_up { color: var(--warn); background: color-mix(in srgb, var(--warn) 13%, transparent); }
  .server .state.unknown { color: var(--soft); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .server .summary { margin: 0 0 12px; font-size: 13.5px; color: var(--fg); }
  .server .reasons { margin: -6px 0 12px; padding-left: 18px; font-size: 13px; color: var(--soft); }
  .server dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 18px; margin: 0 0 4px; font-size: 13.5px; }
  .server dt { color: var(--soft); }
  .server dd { margin: 0; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; color: var(--fg-strong); }
  .server dd code { font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
  .server dd .src { font-size: 12px; color: var(--soft); }
  .server .copy { height: 22px; padding: 0 8px; border: 1px solid var(--rule); border-radius: 6px; background: var(--bg); color: var(--soft); font: inherit; font-size: 11.5px; cursor: pointer; }
  .server .copy:hover { color: var(--fg-strong); }
  .server .note { margin: 12px 0 0; font-size: 13px; color: var(--soft); }
  .server .pending { margin: 14px 0 0; padding: 12px 14px; border-radius: 10px; background: color-mix(in srgb, var(--chrome) 9%, transparent); font-size: 13.5px; }
  .server .pending p { margin: 0 0 8px; }
  .server .pending .failed { color: var(--bad); }
  .server .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .server .row a.pill { text-decoration: none; }
  .server details { margin: 14px 0 0; font-size: 13.5px; }
  .server details > summary { cursor: pointer; color: var(--fg-strong); font-weight: 500; }
  .server ol.steps { margin: 8px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; color: var(--fg); }
  .server form.configure { margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end; }
  .server form.configure label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--soft); }
  .server form.configure .input { width: 100%; font-family: var(--font-mono); font-size: 12.5px; }
  .server form.configure .lede { grid-column: 1 / -1; margin: 0; }
  .server .hint { margin: 8px 0 0; font-size: 13px; color: var(--soft); }
  .server .hint.error { color: var(--bad); }
  @media (max-width: 640px) { .server form.configure { grid-template-columns: 1fr; } .server dl { grid-template-columns: 1fr; gap: 2px; } .server dd { margin-bottom: 6px; } }

  /* Users: add one, and a row for each, with its roles as switches. */
  .add-user { display: flex; gap: 8px; margin: 0 0 14px; }
  .add-user .input { flex: 1; }
  #users-hint { margin: -6px 0 12px; }
  .labels, ol.users > li { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem 7.5rem 4.5rem 4.5rem 34px; align-items: center; column-gap: 12px; }
  .labels { padding: 0 4px 6px; font-size: 12px; color: var(--soft); }
  .labels .c, ol.users .switch { justify-self: center; }
  .labels .t, ol.users time { justify-self: start; margin: 0; }
  ol.users > li { padding: 10px 4px; }
  ol.users .who { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  ol.users .who .badge { align-self: center; }
  ol.users .who .added { flex-basis: 100%; font-size: 12px; color: var(--chrome); }
  ol.users .never { font-style: italic; }
  @media (max-width: 640px) { .labels .seen, ol.users time.seen { display: none; } .labels, ol.users > li { grid-template-columns: minmax(0, 1fr) 6.5rem 3.5rem 3.5rem 34px; } }
  ol.rules { margin: 0 0 14px; }
  ol.rules > li { display: grid; grid-template-columns: minmax(0, 1fr) 15.5rem 34px; align-items: center; column-gap: 12px; padding: 10px 4px; }
  ol.rules .who { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  ol.rules .kind { font-size: 12.5px; color: var(--soft); }
  ol.rules select.access { justify-self: stretch; }
  @media (max-width: 640px) { ol.rules > li { grid-template-columns: minmax(0, 1fr) 34px; row-gap: 6px; } ol.rules select.access { grid-row: 2; } }
  .add-rule { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 8px; }
  .add-rule .input { flex: 1; min-width: 180px; }
  section.rules { margin-bottom: 30px; }
  section.public-sharing .switch { font-size: 14px; color: var(--fg-strong); }
  section.public-sharing .hint { margin: 8px 0 0; }

  /* The change log: one row each, across the page: who (their avatar, and how), what changed (each change on its own line, in full), when. */
  .changes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(180px, max-content) minmax(0, 1fr) max-content; column-gap: 24px; border-bottom: 1px solid var(--rule); }
  .changes > li.change { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: start; padding: 10px 4px; border-top: 1px solid var(--rule); font-size: 13.5px; line-height: 1.55; }
  .changes > li.change:hover { background: color-mix(in srgb, var(--chrome) 5%, transparent); }
  .changes > li.change > time { margin: 0; padding-top: 2px; font-size: 12.5px; color: var(--soft); font-feature-settings: "tnum"; white-space: nowrap; text-align: right; }
  .changes .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .changes .who .by { color: var(--fg-strong); font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .changes .who .via { flex: none; font-size: 11.5px; color: var(--soft); border: 1px solid var(--rule); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
  .changes .avatar { position: relative; flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; overflow: hidden;
    background: var(--c, var(--chrome)); color: #fff; font: 600 12.5px var(--font-text); }
  .changes .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .changes .avatar.system { background: color-mix(in srgb, var(--chrome) 25%, transparent); color: var(--soft); }
  .changes .what { list-style: none; margin: 0; padding: 4px 0 0; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .changes .what > li { overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    .changes { grid-template-columns: minmax(0, 1fr) max-content; }
    .changes .what { grid-column: 1 / -1; grid-row: 2; padding: 6px 0 0 38px; }
  }
  .changes .key { font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-strong); margin-right: 4px; }
  .changes .was { font-feature-settings: "tnum"; }
  .changes .to { color: var(--soft); margin: 0 3px; }
  .changes .badge { margin: 0 0 0 4px; }
  .changes .sha { font-family: var(--font-mono); font-size: 12px; }
  .changes .title { color: var(--fg-strong); }
  .changes .commits { list-style: none; margin: 4px 0 2px; padding: 0 0 0 12px; border-left: 2px solid var(--rule); font-size: 12.5px; }
  .changes .commits li { padding: 1px 0; }
  .changes .commits .more { color: var(--soft); }
  .changes details { display: inline; font-size: 12.5px; }
  .changes details summary { display: inline; color: var(--soft); cursor: pointer; }
  .changes-empty, .changes-more { margin: 6px 2px 0; font-size: 13px; color: var(--soft); }

  /* The Cloudflare page (/install, the control Worker's credential): its state, what the last consent said, one button, the details folded. */
  .install { max-width: 620px; }
  .install .back { margin: 0 0 10px; font-size: 13.5px; }
  .install .back a { color: var(--soft); text-decoration: none; }
  .install .back a:hover { color: var(--fg-strong); }
  .install .state-line { margin: 0 0 18px; }
  .install .msg { margin: 0 0 16px; padding: 10px 14px; border: 1px solid var(--rule); border-radius: 10px; font-size: 13.5px; line-height: 1.5; color: var(--fg); background: color-mix(in srgb, var(--chrome) 6%, transparent); }
  .install .msg.bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--rule)); color: var(--fg-strong); }
  .install .buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 28px; }
  .install details { font-size: 13.5px; color: var(--soft); }
  .install summary { width: max-content; cursor: pointer; color: var(--soft); border-radius: 6px; }
  .install summary:hover { color: var(--fg-strong); }
  .install summary:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
  .install dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 18px; margin: 14px 0 0; }
  .install dt { color: var(--soft); } .install dd { margin: 0; min-width: 0; color: var(--fg); }
  .install code { font-size: 12.5px; overflow-wrap: anywhere; }
  @media (max-width: 520px) { .install dl { grid-template-columns: 1fr; gap: 2px; } .install dt { margin-top: 8px; } }
`;

/** The control Worker's shell (control/routes.ts, controlLayout): the page beside the sidebar, without the agent's grid, a centred column or the whole width. */
const CONTROL_STYLE = `
  .admin-body > main.admin-main { flex: 1; }
  .admin-body > main.admin-main:not(.wide) { margin: 0 auto; }
  @media (max-width: 720px) { .admin-body > main.admin-main { padding-top: 12px; } }
`;

/** Every admin page's style: the layout, the pages' parts, the Ops page's and the control Worker's shell. The build's admin.css. */
export const ADMIN_STYLE = LAYOUT_STYLE + PAGES_STYLE + OPS_STYLE + CONTROL_STYLE;
