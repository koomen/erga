// The layout every admin page shares (/admin, /admin/changes, /admin/users, /admin/access,
// /admin/api-keys, /admin/auth): the bars of every page (server/pages/bars.ts: Erga › Admin › the page upper
// left; upper right the quick actions, with Share with an agent, whose menu is admin-share.js, built from
// client/admin/admin-share.ts), the person's agent in the lower left (server/pages/agent.ts, as on every page),
// and, on the left, a sidebar that links to Settings, API keys, Authentication, Access, Change log and Users.
//
// The sidebar collapses to a rail of icons and expands again, with an animation, and this browser remembers which
// (localStorage "erga:admin-sidebar"), set before the sidebar paints, so it doesn't jump. On a phone it is a row of
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
import { actingAdmin } from "../identity/index.ts";

export type AdminSection = "settings" | "keys" | "auth" | "access" | "changes" | "users";

const SECTIONS: { key: AdminSection; label: string; path: string; icon: string }[] = [
  { key: "settings", label: "Settings", path: "/admin", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>` },
  { key: "keys", label: "API keys", path: "/admin/api-keys", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></svg>` },
  { key: "auth", label: "Authentication", path: "/admin/auth", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/><path d="M12 14.5v2"/></svg>` },
  { key: "access", label: "Access", path: "/admin/access", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l7 3v5c0 4.3-3 7.7-7 9-4-1.3-7-4.7-7-9v-5l7-3Z"/><path d="M9 12l2 2 4-4"/></svg>` },
  { key: "changes", label: "Change log", path: "/admin/changes", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4.5v3.5h3.5"/><path d="M12 8v4.2l2.8 1.8"/></svg>` },
  { key: "users", label: "Users", path: "/admin/users", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9.5" cy="8.5" r="3.5"/><path d="M3.5 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4c1.4.8 2.3 2.4 2.5 4.6"/></svg>` },
];

/** Each section's name and address, for the quick search (server/operations/pages.ts). */
export const ADMIN_PAGES = SECTIONS.map(({ label, path }) => ({ label, path }));

/** The sidebar: the toggle and a link for each section, each at the address `hrefOf` gives. */
function adminSidebar(here: AdminSection | undefined, hrefOf: (path: string) => string): string {
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
  /** The page uses the whole width (the change log); otherwise a column. */
  wide?: boolean;
}

/** The admin pages' one stylesheet (client/styles/admin.css, built as admin.css): the same file on every admin page. */
const adminStyleTag = () => `<link rel="stylesheet" id="erga-admin-style" href="${asset("admin.css")}">`;

/** The sidebar's remembered state, before it paints; the first page's view (window.ergaView: what its scripts stop when it goes). */
const EARLY_SCRIPT = `${inlineScript("admin-sidebar-early")}${inlineScript("admin-view")}${inlineScript("img-fallback")}`;
/** The sidebar's toggle (client/inline/admin-sidebar.ts). */
const SIDEBAR_SCRIPT = inlineScript("admin-sidebar");

/** An admin page, whole: the header, the sidebar and the page's own body. */
export function adminLayout(o: AdminLayout): string {
  // Share with an agent among the quick actions: the editor's icon, its menu from admin-share.js (client/common/agent-menu.ts, with Admin picked).
  const share = `<button type="button" class="erga-view-button" id="btn-share" aria-label="Share with an agent" data-tip="Share with an agent">${AGENT_ICON}</button>`;
  const bars = pageBars(o.session, [{ label: "Admin", href: "/admin" }, { label: o.title }], { here: "h1", share });
  const side = adminSidebar(o.here, (path) => link(path, o.session));
  return appPage(o.title, "", `${adminStyleTag()}${EARLY_SCRIPT}
${bars}
<div class="admin-body">
${side}
<main class="admin-main${o.wide ? " wide" : ""}" id="admin-panes">
${o.body}
</main>
</div>
${SIDEBAR_SCRIPT}
${scriptTag("admin-share.js")}
${scriptTag("admin-nav.js")}`, false);
}

/** adminLayout as the answer of a route. */
export const adminPage = (o: AdminLayout, status = 200) => html(adminLayout(o), status, NO_STORE);

export const isAdminPath = (path: string) => path == "/admin" || path.startsWith("/admin/");

/**
 * Every /admin route, before its own routes: the server's admin role, checked
 * here on the server. Signed out, a page sends you to sign in; anyone who
 * isn't an admin gets "not found" for a page (they can't tell there is one)
 * and 401 or 403 for a POST. The role is the only thing that counts: no
 * other permission (a document's sharing;
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
