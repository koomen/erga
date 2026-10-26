// Who you are, in the upper right of every page erga.dev serves: your
// avatar (your picture, shared/avatars.ts, or your initial on your colour if
// you have none or it doesn't load), which opens a small menu (your name, Documents, Settings, Deploy
// your own for those the deploy_page setting lets in, Admin settings for
// admins, Sign out); or, signed out, a person in a circle whose
// menu has only Sign in (to the sign-in page, coming back to the same page).
//
// The Worker adds it to each of the site's HTML pages (`withAccount`,
// server/app.ts), so every page has it without each building it. The
// editor shows it itself, as the last of its own controls (client/main.ts,
// the avatar at the far right), and says so with `OWN_ACCOUNT`. A document's
// pages origin never gets it: nothing of the person belongs there.

import { esc, link, safeNext } from "./chrome.ts";
import type { Session } from "../platform.ts";
import { colorFor } from "../../document/content.ts";
import { fastClickScript } from "../../shared/fast-click.ts";

/** A response header: this page shows the account itself (the editor), so leave it be. */
export const OWN_ACCOUNT = "x-erga-own-account";

/** Who the corner shows: the signed-in person, or nobody. */
export interface Account {
  login: string;
  name: string;
  admin: boolean;
  /** May use /deploy (the deploy_page setting): not an admin right. */
  deploy?: boolean;
  /** Their picture (shared/avatars.ts); absent: none, so their initial shows. */
  avatar?: string;
  /** The ?user= a local tab carries, kept on the menu's links. */
  session: Session;
}

export const accountOf = (session: Session | null, admin: boolean, deploy = false): Account | null =>
  !session || session.agent ? null : {
    login: session.login, name: session.name, admin, deploy, session,
        ...(!session.test && session.avatar ? { avatar: session.avatar } : {}),
  };

const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9.25" r="3.25"/><path d="M5.75 19c.9-3.1 3.3-4.75 6.25-4.75s5.35 1.65 6.25 4.75"/></svg>`;

/** Where signing in from `here` (a path and query on this site) starts, and comes back to. */
export const signInUrl = (here: string) => `/auth/sign-in?next=${encodeURIComponent(safeNext(here.startsWith("/auth/") ? "/" : here))}`;

/** The corner: markup, its style and the few lines that open and close the menu. */
export function accountHtml(account: Account | null, here: string): string {
  return `${accountMarkup(account, here)}${ACCOUNT_STYLE}${ACCOUNT_SCRIPT}`;
}

/** The corner's markup alone (the homepage puts it in a shadow root of its own, with ACCOUNT_STYLE: server/home.ts). */
export function accountMarkup(account: Account | null, here: string): string {
  const id = "erga-account-menu";
  if (!account) {
    return `<div class="erga-account" data-erga-account="out">
<button type="button" class="erga-account-btn erga-account-out" aria-label="Sign in" data-tip="Sign in" aria-haspopup="true" aria-expanded="false" aria-controls="${id}">${PERSON}</button>
<div class="erga-account-menu" id="${id}" hidden>
<a class="erga-account-sign-in" href="${esc(signInUrl(here))}">Sign in</a>
</div>
</div>`;
  }
  const initial = (account.name.trim()[0] ?? account.login[0] ?? "?").toUpperCase();
  const s = account.session;
  return `<div class="erga-account" data-erga-account="in">
<button type="button" class="erga-account-btn" style="--c: ${colorFor(account.login.toLowerCase())}" aria-label="${esc(`You (${account.name})`)}" data-tip="${esc(account.name)}" aria-haspopup="true" aria-expanded="false" aria-controls="${id}">
<span aria-hidden="true">${esc(initial)}</span>${account.avatar ? `<img src="${esc(account.avatar)}" alt="" draggable="false" referrerpolicy="no-referrer" data-erga-fallback>` : ""}
</button>
<div class="erga-account-menu" id="${id}" hidden>
<p class="erga-account-who"><b>${esc(account.name)}</b>${account.name.toLowerCase() != account.login.toLowerCase() ? `<span>${esc(account.login)}</span>` : ""}</p>
<a href="${esc(link("/docs", s))}">Documents</a>
<a href="${esc(link("/settings", s))}">Settings</a>
${account.deploy ? `<a href="${esc(link("/deploy", s))}">Deploy your own</a>` : ""}
${account.admin ? `<a href="${esc(link("/admin", s))}">Admin settings</a>` : ""}
<a href="/auth/logout">Sign out</a>
</div>
</div>`;
}

/**
 * A page with the corner added, unless it shows it itself. Pages are small,
 * so it's read whole: before </body> if there is one, else </html>, else
 * at the end.
 */
export async function withAccount(response: Response, account: () => Promise<Account | null>, here: string): Promise<Response> {
  if (response.headers.has(OWN_ACCOUNT)) {
    const headers = new Headers(response.headers);
    headers.delete(OWN_ACCOUNT);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  if (!/^text\/html\b/i.test(response.headers.get("content-type") ?? "") || !response.body || response.status == 101) return response;
  const html = await response.text();
  const corner = accountHtml(await account(), here);
  const at = html.lastIndexOf("</body>") >= 0 ? html.lastIndexOf("</body>") : html.lastIndexOf("</html>");
  const body = at >= 0 ? html.slice(0, at) + corner + html.slice(at) : html + corner;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Its own colours, since pages differ (client/style.css's, the small pages', the
// landing page's frame): quiet like the editor's controls, a card for the menu.
export const ACCOUNT_STYLE = `<style>
  .erga-account { --acc-bg: #fff; --acc-fg: #1c1c1f; --acc-soft: #6b6b73; --acc-chrome: #a1a1a9; --acc-ring: #e6e6ea; --acc-hover: rgba(161, 161, 169, .14);
    position: absolute; top: max(14px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right)); z-index: 1001;
    font: 400 14px/1.4 "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) {
    .erga-account { --acc-bg: #1f1f23; --acc-fg: #ececf1; --acc-soft: #8f8f99; --acc-chrome: #8a8a94; --acc-ring: #2f2f35; --acc-hover: rgba(161, 161, 169, .16); }
  }
  .erga-account-btn { position: relative; display: grid; place-items: center; width: 30px; height: 30px; margin: 0; padding: 0; border: 0; border-radius: 50%;
    cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1; color: #fff; background: var(--c, #8e8e96); box-shadow: 0 0 0 2px var(--acc-bg); }
  .erga-account-btn img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; -webkit-user-drag: none; }
  .erga-account-btn.erga-account-out { color: var(--acc-soft); background: var(--acc-bg); box-shadow: inset 0 0 0 1.5px var(--acc-chrome); }
  .erga-account-btn.erga-account-out:hover { color: var(--acc-fg); box-shadow: inset 0 0 0 1.5px var(--acc-soft); }
  .erga-account-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .erga-account-btn:focus-visible { outline: 2px solid #3b7cf0; outline-offset: 2px; }
  @media (pointer: coarse) { .erga-account-btn::after { content: ""; position: absolute; inset: -7px; } }
  /* Its tooltip, as every control's on the site: plain text, the moment the pointer is on it, just below the pointer and following it (the script below). */
  .erga-account-btn::before { content: attr(data-tip); position: absolute; left: var(--tip-x, 100%); top: var(--tip-y, calc(100% + 6px)); transform: translateX(-100%); white-space: pre; font-size: 12px; font-weight: 400; line-height: 1.3;
    letter-spacing: .01em; color: var(--acc-soft); opacity: 0; pointer-events: none; }
  @media (hover: hover) { .erga-account-btn:hover::before { opacity: 1; } }
  .erga-account-btn[aria-expanded="true"]::before { display: none; }
  .erga-account-menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 190px; max-width: calc(100vw - 32px); box-sizing: border-box; padding: 6px;
    color: var(--acc-fg); background: var(--acc-bg); border: 1px solid var(--acc-ring); border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, .12), 0 1px 2px rgba(0, 0, 0, .05); }
  .erga-account-menu[hidden] { display: none; }
  .erga-account-who { margin: 0; padding: 6px 10px 8px; color: var(--acc-soft); font-size: 13px; }
  .erga-account-who b { display: block; color: var(--acc-fg); font-weight: 600; font-size: 14px; }
  .erga-account-menu a { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; color: var(--acc-fg); text-decoration: none; font-size: 14px; white-space: nowrap; }
  .erga-account-menu a:hover, .erga-account-menu a:focus-visible { background: var(--acc-hover); outline: none; }
  /* Sign in: the editor's primary button (client/style.css, .share-primary). */
  .erga-account-menu .erga-account-sign-in { justify-content: center; margin: 2px; padding: 8px 14px; font-weight: 600; color: #fff; background: #3b7cf0; border-radius: 7px; }
  .erga-account-menu .erga-account-sign-in:hover, .erga-account-menu .erga-account-sign-in:focus-visible { background: #2f6ad8; }
  @media (pointer: coarse) { .erga-account-menu a { padding: 11px 12px; } }
</style>`;

/**
 * For an inline script: a picture marked data-erga-fallback in `root` (a document or a shadow root) that doesn't load
 * goes, and the initial under it shows. (Not an onerror attribute: the site's pages run no inline handler, server/security.ts.)
 */
export const imgFallbackScript = (root: string) => `((root) => {
  for (const img of root.querySelectorAll("img[data-erga-fallback]")) if (img.complete && !img.naturalWidth) img.remove();
  root.addEventListener("error", (e) => { if (e.target.matches?.("img[data-erga-fallback]")) e.target.remove(); }, true);
})(${root});`;

const ACCOUNT_SCRIPT = `<script>(() => {
  const root = document.currentScript.previousElementSibling.previousElementSibling, btn = root.querySelector("button"), menu = root.querySelector(".erga-account-menu");
  ${imgFallbackScript("root")}
  const show = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", () => { show(menu.hidden); if (!menu.hidden) menu.querySelector("a")?.focus({ preventScroll: true }); });
  // It opens as the press starts (shared/fast-click.ts).
  ${fastClickScript("root", ".erga-account-btn")}
  document.addEventListener("pointerdown", (e) => { if (!root.contains(e.target)) show(false); });
  document.addEventListener("keydown", (e) => { if (e.key == "Escape" && !menu.hidden) { show(false); btn.focus(); } });
  window.addEventListener("blur", () => show(false));
  // Every control's tooltip on the page (the editor's too) follows the pointer while it's on the control: where, for its CSS.
  document.addEventListener("pointermove", (e) => {
    const el = e.pointerType == "mouse" && e.target.closest?.("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Clear of the pointer's arrow, which reaches down and right of its tip.
    el.style.setProperty("--tip-x", e.clientX - r.left - 6 + "px");
    el.style.setProperty("--tip-y", e.clientY - r.top + 30 + "px");
  }, { passive: true });
})();</script>`;
