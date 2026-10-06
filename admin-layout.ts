// The layout every admin page shares (/admin, /admin/changes, /admin/users, /admin/factory,
// /admin/keys): a breadcrumb in the upper left (Erga › Admin › the page),
// Share with agent in the header bar upper right (the editor's button and
// card: admin-share.js, built from src/page/admin-share.ts), the admin's agent
// (the factory's agent, factory/agent.ts: its panel is factory-agent.js, built
// from src/page/factory-agent.ts) in a column left of the page, and, on the
// left, a sidebar that links to Settings, Change log, Users and Factory.
//
// The agent collapses to a round button in the lower left, as the editor's
// does (its own button, Esc in the panel, or ⌘J), and expands from it again;
// this browser remembers which (localStorage "erga:admin-agent"), set before
// it paints. Narrower than 1000px it covers the page while it's open, and
// starts collapsed. The sidebar
// collapses to a rail of icons and expands again, with an animation, and
// this browser remembers which (localStorage "erga:admin-sidebar"), set
// before the sidebar paints, so it doesn't jump. On a phone it is a row of
// links above the page.
//
// Only the page: who may see it is checked on the server, before any admin
// page is made (adminGate, below, in worker/index.ts; and each page's own door).

import { appPage, esc, ICON, link, page, type Platform, type Session, whoOf } from "./front.ts";

export type AdminSection = "settings" | "changes" | "users" | "factory";

const SECTIONS: { key: AdminSection; label: string; path: string; icon: string }[] = [
  { key: "settings", label: "Settings", path: "/admin", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>` },
  { key: "changes", label: "Change log", path: "/admin/changes", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v3.5h3.5"/><path d="M12 8v4.2l2.8 1.8"/></svg>` },
  { key: "users", label: "Users", path: "/admin/users", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4c1.4.8 2.3 2.4 2.5 4.6"/></svg>` },
  { key: "factory", label: "Factory", path: "/admin/factory", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 20.5V10l5 3V10l5 3V10l5 3V4h2v16.5z"/><path d="M7 17h1.5M11 17h1.5M15 17h1.5"/></svg>` },
];

const TOGGLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg>`;

export interface AdminLayout {
  session: Session;
  /** The page's own title, the last crumb. */
  title: string;
  /** Which sidebar link is this page (none for /admin/keys). */
  here?: AdminSection;
  /** The page's own style, after the layout's. */
  style?: string;
  /** What goes in <main>. */
  body: string;
  /** The page uses the whole width (the factory's board); otherwise a column. */
  wide?: boolean;
}

/** The agent's panel: the editor's markup (page.html), with a button that collapses it. factory-agent.js runs it. */
const AGENT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z"/></svg>`;
const AGENT = `<aside class="admin-agent" id="agent" aria-label="Agent"><div class="agent-card">
    <div class="agent-head">
      <span class="title">Agent</span><span class="model" id="agent-model"></span>
      <button type="button" class="icon-btn" id="agent-reset" aria-label="New conversation" data-tip="New conversation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button type="button" class="icon-btn" id="agent-close" aria-label="Collapse (Esc)" data-tip="Collapse  Esc" aria-controls="agent">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5 10 14M10 14H5.5M10 14v4.5M19.5 4.5 14 10M14 10h4.5M14 10V5.5"/></svg>
      </button>
    </div>
    <div class="agent-log" id="agent-log" data-empty="Say what you want built, or what to change on the server. The agent queues factory tasks and follows them, and reads and changes the settings and users for you: each change is in the change log under your name. You merge." aria-live="polite" tabindex="-1"></div>
    <button type="button" class="agent-jump" id="agent-jump" hidden>↓ Jump to latest</button>
    <p class="agent-hint" id="agent-hint" role="status" hidden></p>
    <form class="agent-compose" id="agent-form">
      <div class="agent-field" id="agent-field"><textarea id="agent-input" rows="1" placeholder="Ask the agent…" aria-label="Message the agent"></textarea></div>
      <button type="submit" class="agent-send" id="agent-send">Send</button>
    </form>
  </div></aside>
<button type="button" class="agent-fab admin-fab" id="agent-fab" aria-label="Open the agent (⌘J)" title="Agent  ⌘J" aria-expanded="true" aria-controls="agent">${AGENT_ICON}</button>`;

export const LAYOUT_STYLE = `
  /* The header: the breadcrumb upper left, on the line of the account corner (account.ts) upper right; Share with agent left of it. */
  .crumbs { position: absolute; top: max(14px, env(safe-area-inset-top)); left: max(20px, env(safe-area-inset-left)); height: 30px; display: flex; align-items: center; gap: 0; margin: 0; }
  .crumbs .brand { position: static; }
  .crumbs a.here-link { color: var(--soft); text-decoration: none; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; }
  .crumbs a.here-link:hover { color: var(--fg-strong); }
  .crumbs > :not(.brand)::before { content: "›"; margin: 0 9px 0 10px; color: var(--chrome); opacity: 0.55; font-weight: 400; }
  .crumbs .here { display: flex; align-items: center; margin: 0; font-size: 13.5px; line-height: inherit; font-weight: 500; letter-spacing: normal; color: var(--fg); }
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
  /* Collapsed: a rail of icons, so the page (the factory's board) gets the width. */
  .side-closed .admin-side { width: 52px; padding-right: 4px; }
  .side-closed .admin-side .label { opacity: 0; }
  /* No animation as the page opens in the state it remembers: only when it's toggled. */
  :root:not(.side-ready) .admin-side, :root:not(.side-ready) .admin-side .label { transition: none; }
  @media (prefers-reduced-motion: reduce) { .admin-side, .admin-side .label { transition: none; } }
  /* The admin's agent: a column left of the page, as the editor's card. Collapsed, a round button in the lower left;
     expanding grows the card out of that corner (a clip-path from the button's circle), and the page slides over. */
  :root { --agent-w: 370px; --agent-fab: 44px; --agent-ms: 480ms; --agent-ease: cubic-bezier(0.45, 0, 0.15, 1); }
  .admin-agent { position: sticky; top: 12px; flex: none; width: var(--agent-w); margin-right: 20px; height: calc(100vh - 78px); height: calc(100dvh - 78px); min-height: 420px;
    filter: drop-shadow(0 12px 28px rgba(0, 0, 0, 0.09)) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.05));
    transition: width var(--agent-ms) var(--agent-ease), margin var(--agent-ms) var(--agent-ease), visibility 0s; }
  .admin-agent .agent-card { position: absolute; top: 0; bottom: 0; left: 0; width: var(--agent-w); display: flex; flex-direction: column; box-sizing: border-box;
    background: var(--bg); border: 1px solid var(--panel-border); border-radius: 18px; font: 14px/1.55 var(--font-text); color: var(--fg); overflow: hidden;
    clip-path: inset(0 0 0 0 round 18px); opacity: 1; transition: clip-path var(--agent-ms) var(--agent-ease), opacity 0s; }
  .admin-agent .agent-head .title { white-space: nowrap; }
  .admin-agent .agent-card > * { transition: opacity 280ms ease 200ms; }
  .agent-closed .admin-agent { width: 0; margin-right: 0; visibility: hidden; transition: width var(--agent-ms) var(--agent-ease), margin var(--agent-ms) var(--agent-ease), visibility 0s linear var(--agent-ms); }
  .agent-closed .admin-agent .agent-card { clip-path: inset(calc(100% - var(--agent-fab)) calc(100% - var(--agent-fab)) 0 0 round calc(var(--agent-fab) / 2)); opacity: 0;
    transition: clip-path var(--agent-ms) var(--agent-ease), opacity 180ms ease 200ms; }
  .agent-closed .admin-agent .agent-card > * { opacity: 0; transition: opacity 120ms ease; }
  .admin-fab { position: fixed; left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom)); z-index: 21;
    width: var(--agent-fab); height: var(--agent-fab); border-radius: 50%; border: 1px solid var(--panel-border); display: grid; place-items: center; padding: 0; cursor: pointer;
    background: var(--panel-bg, var(--bg)); color: var(--chrome-hover); box-shadow: var(--shadow, 0 6px 24px rgba(0, 0, 0, 0.1)); opacity: 0; pointer-events: none; transition: opacity 200ms ease, box-shadow 200ms ease; }
  .admin-fab:hover { box-shadow: 0 10px 34px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.06); }
  .admin-fab:focus-visible { outline: 2px solid var(--caret); outline-offset: 2px; }
  .admin-fab svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .admin-fab.busy::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--caret); animation: admin-agent-spin 0.9s linear infinite; }
  @keyframes admin-agent-spin { to { transform: rotate(360deg); } }
  .agent-closed .admin-fab { opacity: 1; pointer-events: auto; transition: opacity 200ms ease 220ms, box-shadow 200ms ease; }
  :root:not(.agent-ready) :is(.admin-agent, .admin-agent .agent-card, .admin-agent .agent-card > *, .admin-fab) { transition: none !important; }
  @media (prefers-reduced-motion: reduce) { :is(.admin-agent, .admin-agent .agent-card, .admin-agent .agent-card > *, .admin-fab) { transition: none !important; } }
  /* Narrower, it covers the page while it's open. */
  @media (max-width: 999.98px) {
    .admin-agent, .agent-closed .admin-agent { position: fixed; z-index: 22; top: max(56px, env(safe-area-inset-top)); bottom: max(12px, env(safe-area-inset-bottom)); left: max(12px, env(safe-area-inset-left));
      width: min(var(--agent-w), calc(100vw - 24px)); height: auto; min-height: 0; margin: 0; }
    .admin-agent .agent-card { width: 100%; }
  }
  main.admin-main { flex: 1; min-width: 0; max-width: 880px; margin: 0 auto; padding: 8px 24px 96px; }
  main.admin-main.wide { max-width: none; margin: 0; padding: 0 max(16px, env(safe-area-inset-right)) 24px 8px; }
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

/** Remembered state, before the sidebar paints; the toggle; and the animation only from then on. */
const EARLY_SCRIPT = `<script>try { if (localStorage.getItem("erga:admin-sidebar") == "closed") document.documentElement.classList.add("side-closed"); } catch {}
try { if (matchMedia("(max-width: 999.98px)").matches || localStorage.getItem("erga:admin-agent") == "closed") document.documentElement.classList.add("agent-closed"); } catch {}</script>`;

/** The agent's collapse and expand: its button, the round one, Esc in the panel, ⌘J; remembered on a wide window. */
const AGENT_SCRIPT = `<script>
(() => {
  const root = document.documentElement, pane = document.getElementById("agent"), fab = document.getElementById("agent-fab");
  const narrow = matchMedia("(max-width: 999.98px)");
  const sync = () => { const open = !root.classList.contains("agent-closed"); pane.inert = !open; fab.setAttribute("aria-expanded", String(open)); };
  const show = (open) => {
    root.classList.toggle("agent-closed", !open);
    if (!narrow.matches) try { localStorage.setItem("erga:admin-agent", open ? "open" : "closed"); } catch {}
    sync();
    if (open) window.dispatchEvent(new Event("erga:agent-shown"));
    else fab.focus();
  };
  window.ergaAgent = { show, open: () => !root.classList.contains("agent-closed") };
  document.getElementById("agent-close").addEventListener("click", () => show(false));
  fab.addEventListener("click", () => show(true));
  pane.addEventListener("keydown", (e) => { if (e.key == "Escape" && !e.defaultPrevented) { e.preventDefault(); show(false); } });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() == "j") { e.preventDefault(); show(root.classList.contains("agent-closed")); }
  });
  sync();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("agent-ready")));
})();
</script>`;
const SIDEBAR_SCRIPT = `<script>
(() => {
  const root = document.documentElement, toggle = document.getElementById("side-toggle");
  const sync = () => {
    const closed = root.classList.contains("side-closed");
    toggle.setAttribute("aria-expanded", String(!closed));
    toggle.setAttribute("aria-label", closed ? "Expand the sidebar" : "Collapse the sidebar");
    toggle.title = closed ? "Expand the sidebar" : "Collapse the sidebar";
    for (const a of document.querySelectorAll(".admin-side a")) a.title = closed ? a.textContent.trim() : "";
  };
  toggle.addEventListener("click", () => {
    root.classList.toggle("side-closed");
    try { localStorage.setItem("erga:admin-sidebar", root.classList.contains("side-closed") ? "closed" : "open"); } catch {}
    sync();
  });
  sync();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("side-ready")));
})();
</script>`;

/** An admin page, whole: the header, the sidebar and the page's own body. */
export function adminLayout(o: AdminLayout): string {
  const crumbs = `<nav class="crumbs" aria-label="Breadcrumbs"><a class="brand" href="${esc(link("/", o.session))}">Erga</a><a class="here-link" href="${esc(link("/admin", o.session))}">Admin</a><h1 class="here" aria-current="page">${esc(o.title)}</h1></nav>`;
  // Share with agent: the editor's icon button (page.html, .chrome-top), the card from admin-share.js.
  const bar = `<div class="chrome chrome-top" role="toolbar" aria-label="Controls"><button type="button" class="icon-btn" id="btn-share" aria-label="Share with an agent" data-tip="Share with an agent" aria-expanded="false" aria-controls="share">${ICON.agent}</button></div>`;
  const links = SECTIONS.map((s) => `<li><a href="${esc(link(s.path, o.session))}"${s.key == o.here ? ` aria-current="page"` : ""}>${s.icon}<span class="label">${s.label}</span></a></li>`).join("");
  const side = `<nav class="admin-side" id="admin-side" aria-label="Admin"><button type="button" class="side-toggle" id="side-toggle" aria-controls="admin-side" aria-expanded="true" aria-label="Collapse the sidebar">${TOGGLE_ICON}</button><ul>${links}</ul></nav>`;
  return appPage(o.title, LAYOUT_STYLE + (o.style ?? ""), `${EARLY_SCRIPT}
${crumbs}${bar}
<div class="admin-body">
${side}
${AGENT}
<main class="admin-main${o.wide ? " wide" : ""}">
${o.body}
</main>
</div>
${SIDEBAR_SCRIPT}
${AGENT_SCRIPT}
<script src="/admin-share.js" defer></script>
<script src="/factory-agent.js" defer></script>`, false);
}

/** adminLayout as a response. */
export const adminResponse = (o: AdminLayout, status = 200) => new Response(adminLayout(o), { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export const isAdminPath = (path: string) => path == "/admin" || path.startsWith("/admin/");

/**
 * Every /admin route, before its own door: the server's admin role, checked
 * here on the server. Signed out, a page sends you to sign in; anyone who
 * isn't an admin gets "not found" for a page (they can't tell there is one)
 * and 401 or 403 for a POST. The role is the only thing that counts: no
 * other permission (deploy_page, who may use /deploy; a document's sharing;
 * an agent or test token) makes anyone an admin. Null lets an admin through;
 * each door still checks on its own, and asks for the unlock.
 */
export async function adminGate(platform: Platform, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const read = request.method == "GET" || request.method == "HEAD";
  const session = await platform.sessionOf(request);
  if (!session) {
    if (read) return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname + url.search)}`, "Cache-Control": "no-store" } });
    return Response.json({ error: "Sign in as an admin first." }, { status: 401 });
  }
  const admin = !session.test && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  if (admin) return null;
  if (read) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return Response.json({ error: "Only an admin can do that." }, { status: 403 });
}
