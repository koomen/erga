// The layout every admin page shares (/admin, /admin/changes, /admin/users, /admin/ops,
// /admin/api-keys, /admin/auth): a breadcrumb in the upper left (Erga › Admin › the page),
// Share with agent in the header bar upper right (the editor's button and
// card: admin-share.js, built from client/admin/admin-share.ts), the admin's agent
// (agents/admin/agent.ts: its panel is admin-agent.js, built from
// client/admin/admin-agent.ts) in a column left of the page, and, on the left, a
// sidebar that links to Settings, API keys, Authentication, Access, Change log, Users and Ops.
//
// As in the editor, the user drags the agent by its head to the right of the
// page, and its inner edge to resize it (client/agent/layout.ts, mountPaneLayout;
// kept in this browser). It collapses to a round button in the lower corner
// on its side, as the editor's does (its own button, Esc in the panel, or
// ⌘J), and expands from it again;
// this browser remembers which (localStorage "erga:admin-agent"), set before
// it paints. Narrower than 1000px it covers the page while it's open, and
// starts collapsed. The sidebar
// collapses to a rail of icons and expands again, with an animation, and
// this browser remembers which (localStorage "erga:admin-sidebar"), set
// before the sidebar paints, so it doesn't jump. On a phone it is a row of
// links above the page.
//
// In the browser the admin pages are one page (admin-nav.js, built from
// client/admin/admin-nav.ts): a link to another admin page changes only <main>
// (and the title, the breadcrumb and the sidebar's mark), so the agent panel
// and its conversation stay. Each page is still made whole here, for a deep
// link or a reload. Every page has the same look: the one stylesheet,
// admin.css (client/styles/admin.css), and no style of its own.
//
// Only the page: who may see it is checked on the server, before any admin
// page is made (adminGate, below, in server/app.ts; and each page's own routes).

import * as Effect from "effect/Effect";
import { call, ctx, html, NO_STORE, plainJson, redirect } from "../http.ts";
import { appPage, asset, AGENT_ICON, inlineScript, link, pageBars, page, scriptTag } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import type { Platform, Session } from "../platform.ts";
import { MARK } from "../../assets/logo/logo.ts";
import { actingAdmin } from "../identity/index.ts";

export type AdminSection = "settings" | "keys" | "auth" | "access" | "changes" | "users" | "ops";

const SECTIONS: { key: AdminSection; label: string; path: string; icon: string }[] = [
  { key: "settings", label: "Settings", path: "/admin", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>` },
  { key: "keys", label: "API keys", path: "/admin/api-keys", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></svg>` },
  { key: "auth", label: "Authentication", path: "/admin/auth", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/><path d="M12 14.5v2"/></svg>` },
  { key: "access", label: "Access", path: "/admin/access", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l7 3v5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9v-5l7-3Z"/><path d="M9 12l2 2 4-4"/></svg>` },
  { key: "changes", label: "Change log", path: "/admin/changes", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v3.5h3.5"/><path d="M12 8v4.2l2.8 1.8"/></svg>` },
  { key: "users", label: "Users", path: "/admin/users", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4c1.4.8 2.3 2.4 2.5 4.6"/></svg>` },
  // Ops: the environments, the Cloudflare credential and Erga's repository. The control Worker's page: the app serves it in
  // place over the CONTROL binding (/install, its Cloudflare credential, is marked Ops too). With no control Worker, the
  // app says so on this page (cloudflare/index.ts).
  { key: "ops", label: "Ops", path: "/admin/ops", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="6" rx="2"/><rect x="3.5" y="13.5" width="17" height="6" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/></svg>` },
];

/** Each section's name and address, for the quick search (server/operations/pages.ts). */
export const ADMIN_PAGES = SECTIONS.map(({ label, path }) => ({ label, path }));

/** The sidebar: the toggle and a link for each section, each at the address `hrefOf` gives (another host's, for the control Worker). */
export function adminSidebar(here: AdminSection | undefined, hrefOf: (path: string) => string): string {
  const links = SECTIONS.map((s) => `<li><a href="${esc(hrefOf(s.path))}"${s.key == here ? ` aria-current="page"` : ""}>${s.icon}<span class="label">${s.label}</span></a></li>`).join("");
  return `<nav class="admin-side" id="admin-side" aria-label="Admin"><button type="button" class="side-toggle" id="side-toggle" aria-controls="admin-side" aria-expanded="true" aria-label="Collapse the sidebar">${TOGGLE_ICON}</button><ul>${links}</ul></nav>`;
}

const TOGGLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg>`;

export interface AdminLayout {
  session: Session;
  /** The page's own title, the last crumb. */
  title: string;
  /** Which sidebar link is this page. */
  here?: AdminSection;
  /** What goes in <main>. */
  body: string;
  /** The page uses the whole width (the Ops page); otherwise a column. */
  wide?: boolean;
}

/** The agent's panel: the editor's markup, with a button that collapses it. admin-agent.js runs it. */
const AGENT = `<div class="agent-dock" id="agent-dock"><aside class="admin-agent" id="agent" aria-label="Agent"><div class="agent-card">
    <div class="agent-head">
      <span class="title">Agent</span><span class="model" id="agent-model"></span>
      <button type="button" class="icon-btn" id="agent-reset" aria-label="New conversation" data-tip="New conversation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button type="button" class="icon-btn" id="agent-close" aria-label="Collapse (Esc)" data-tip="Collapse  Esc" aria-controls="agent">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5 10 14M10 14H5.5M10 14v4.5M19.5 4.5 14 10M14 10h4.5M14 10V5.5"/></svg>
      </button>
    </div>
    <div class="agent-log" id="agent-log" data-empty="Say what to change on the server. The agent reads and changes the settings and users, deploys staging and production, and reads the source for you: each change is in the change log under your name." aria-live="polite" tabindex="-1"></div>
    <button type="button" class="agent-jump" id="agent-jump" hidden>↓ Jump to latest</button>
    <p class="agent-hint" id="agent-hint" role="status" hidden></p>
    <form class="agent-compose" id="agent-form">
      <div class="agent-field" id="agent-field"><textarea id="agent-input" rows="1" placeholder="Ask the agent…" aria-label="Message the agent"></textarea></div>
      <button type="submit" class="agent-send" id="agent-send">Send</button>
    </form>
  </div></aside></div>
<button type="button" class="agent-fab admin-fab" id="agent-fab" aria-label="Open the agent (⌘J)" title="Agent  ⌘J" aria-expanded="true" aria-controls="agent">${MARK}</button>`;

/** The admin pages' one stylesheet (client/styles/admin.css and ops.css, built as admin.css): the same file on every admin page, the control Worker's too. */
export const adminStyleTag = () => `<link rel="stylesheet" id="erga-admin-style" href="${asset("admin.css")}">`;

/** The sidebar's remembered state, before it paints. */
export const SIDEBAR_EARLY_SCRIPT = inlineScript("admin-sidebar-early");
/** The first page's view (window.ergaView): what its scripts stop when it goes. Every page's scripts read it (the Ops page's too). */
export const VIEW_SCRIPT = inlineScript("admin-view");
/** The agent's side and width as this browser keeps them, on the workspace as it's parsed (in it: client/inline/admin-pane-early.ts). */
export const PANE_EARLY_SCRIPT = inlineScript("admin-pane-early");
const EARLY_SCRIPT = `${SIDEBAR_EARLY_SCRIPT}${VIEW_SCRIPT}${inlineScript("img-fallback")}${inlineScript("admin-agent-early")}`;

/** The agent's collapse and expand, and the buttons that act as the press starts (client/inline/admin-agent.ts). */
const AGENT_SCRIPT = inlineScript("admin-agent");
/** The sidebar's toggle (client/inline/admin-sidebar.ts). */
export const SIDEBAR_SCRIPT = inlineScript("admin-sidebar");

/** An admin page, whole: the header, the sidebar and the page's own body. */
export function adminLayout(o: AdminLayout): string {
  // Share with an agent among the quick actions: the editor's icon, the card from admin-share.js (a prompt with an admin token).
  const share = `<button type="button" class="erga-view-button" id="btn-share" aria-label="Share with an agent" data-tip="Share with an agent" aria-expanded="false" aria-controls="share">${AGENT_ICON}</button>`;
  const bars = pageBars(o.session, [{ label: "Admin", href: "/admin" }, { label: o.title }], { here: "h1", actions: share });
  const side = adminSidebar(o.here, (path) => link(path, o.session));
  return appPage(o.title, "", `${adminStyleTag()}${EARLY_SCRIPT}
${bars}
<div class="admin-body">
${side}
<div class="admin-work" id="workspace">${PANE_EARLY_SCRIPT}
${AGENT}
<main class="admin-main${o.wide ? " wide" : ""}" id="admin-panes">
${o.body}
</main>
</div>
</div>
${SIDEBAR_SCRIPT}
${AGENT_SCRIPT}
${scriptTag("admin-share.js")}
${scriptTag("admin-agent.js")}
${scriptTag("admin-nav.js")}`, false);
}

/** adminLayout as the answer of a route. */
export const adminPage = (o: AdminLayout, status = 200) => html(adminLayout(o), status, NO_STORE);

/** adminLayout as a web Response, for the control Worker's routes (control/), which make web Responses. */
export const adminResponse = (o: AdminLayout, status = 200) =>
  new Response(adminLayout(o), { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });

export const isAdminPath = (path: string) => path == "/admin" || path.startsWith("/admin/");

/**
 * Every /admin route, before its own routes: the server's admin role, checked
 * here on the server. Signed out, a page sends you to sign in; anyone who
 * isn't an admin gets "not found" for a page (they can't tell there is one)
 * and 401 or 403 for a POST. The role is the only thing that counts: no
 * other permission (deploy_page, who may use /deploy; a document's sharing;
 * an agent or test token) makes anyone an admin. Null lets an admin through;
 * each page's routes still check on their own, and asks for the unlock.
 */
export const adminGate = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const read = request.method == "GET" || request.method == "HEAD";
  const session = yield* call(() => platform.sessionOf(request));
  if (!session) {
    if (read) return redirect(`/auth/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 302, NO_STORE);
    return plainJson({ error: "Sign in as an admin first." }, 401);
  }
  const admin = !session.agent && (yield* call(() => actingAdmin(platform.directory.users, session)));
  if (admin) return null;
  if (read) return page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
  return plainJson({ error: "Only an admin can do that." }, 403);
});
