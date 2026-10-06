// The layout every admin page shares (/admin, /admin/changes, /admin/users, /admin/factory,
// /admin/keys): a breadcrumb in the upper left (Erga › Admin › the page),
// Share with agent in the header bar upper right (the editor's button and
// card: admin-share.js, built from src/page/admin-share.ts), and, on the
// left, a sidebar that links to Settings, Change log, Users and Factory. The sidebar
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
  /** Share with agent in the header bar (off only where admin access is still locked, /admin/keys). */
  share?: boolean;
}

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
const EARLY_SCRIPT = `<script>try { if (localStorage.getItem("erga:admin-sidebar") == "closed") document.documentElement.classList.add("side-closed"); } catch {}</script>`;
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
  const bar = o.share === false ? "" : `<div class="chrome chrome-top" role="toolbar" aria-label="Controls"><button type="button" class="icon-btn" id="btn-share" aria-label="Share with an agent" data-tip="Share with an agent" aria-expanded="false" aria-controls="share">${ICON.agent}</button></div>`;
  const links = SECTIONS.map((s) => `<li><a href="${esc(link(s.path, o.session))}"${s.key == o.here ? ` aria-current="page"` : ""}>${s.icon}<span class="label">${s.label}</span></a></li>`).join("");
  const side = `<nav class="admin-side" id="admin-side" aria-label="Admin"><button type="button" class="side-toggle" id="side-toggle" aria-controls="admin-side" aria-expanded="true" aria-label="Collapse the sidebar">${TOGGLE_ICON}</button><ul>${links}</ul></nav>`;
  return appPage(o.title, LAYOUT_STYLE + (o.style ?? ""), `${EARLY_SCRIPT}
${crumbs}${bar}
<div class="admin-body">
${side}
<main class="admin-main${o.wide ? " wide" : ""}">
${o.body}
</main>
</div>
${SIDEBAR_SCRIPT}
${o.share === false ? "" : `<script src="/admin-share.js" defer></script>`}`, false);
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
