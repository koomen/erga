// Who you are, in the upper right of every page erga.dev serves: your
// avatar (your GitHub picture, or your initial on your colour if it doesn't
// load), which opens a small menu (your name, Documents, Settings, Deploy
// your own for those the deploy_page setting lets in, Admin settings for
// admins, Sign out); or, signed out, a person in a circle whose
// menu has only Sign in (with GitHub, coming back to the same page).
//
// The Worker adds it to each of the site's HTML pages (`withAccount`,
// cloudflare/index.ts), so every page has it without each building it. The
// editor shows it itself, as the last of its own controls (client/main.ts,
// the avatar at the far right), and says so with `OWN_ACCOUNT`. A document's
// pages origin never gets it: nothing of the person belongs there.

import { esc, link, safeNext, type Session } from "./routes.ts";
import { colorFor } from "../document/content.ts";

/** A response header: this page shows the account itself (the editor), so leave it be. */
export const OWN_ACCOUNT = "x-erga-own-account";

/** Who the corner shows: the signed-in person, or nobody. */
export interface Account {
  login: string;
  name: string;
  admin: boolean;
  /** May use /deploy (the deploy_page setting): not an admin right. */
  deploy?: boolean;
  /** Their GitHub picture (test people have none). */
  avatar?: string;
  /** The ?user= a local tab carries, kept on the menu's links. */
  session: Session;
}

export const accountOf = (session: Session | null, admin: boolean, deploy = false): Account | null =>
  !session || session.agent ? null : {
    login: session.login, name: session.name, admin, deploy, session,
    ...(session.test ? {} : { avatar: avatarUrl(session.login) }),
  };

/** A GitHub login's picture. */
export const avatarUrl = (login: string) => `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64`;

const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9.25" r="3.25"/><path d="M5.75 19c.9-3.1 3.3-4.75 6.25-4.75s5.35 1.65 6.25 4.75"/></svg>`;
const GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

/** Where signing in from `here` (a path and query on this site) starts, and comes back to. */
export const signInUrl = (here: string) => `/auth/github?next=${encodeURIComponent(safeNext(here.startsWith("/auth/") ? "/" : here))}`;

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
<a class="erga-account-github" href="${esc(signInUrl(here))}">${GITHUB}<span>Sign in</span></a>
</div>
</div>`;
  }
  const initial = (account.name.trim()[0] ?? account.login[0] ?? "?").toUpperCase();
  const s = account.session;
  return `<div class="erga-account" data-erga-account="in">
<button type="button" class="erga-account-btn" style="--c: ${colorFor(account.login.toLowerCase())}" aria-label="${esc(`You (${account.name})`)}" data-tip="${esc(account.name)}" aria-haspopup="true" aria-expanded="false" aria-controls="${id}">
<span aria-hidden="true">${esc(initial)}</span>${account.avatar ? `<img src="${esc(account.avatar)}" alt="" onerror="this.remove()">` : ""}
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
  .erga-account-btn img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
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
  .erga-account-menu .erga-account-github { justify-content: center; margin: 2px 4px 4px; padding: 8px 14px; font-weight: 600; color: #fff; background: #1f2328; border-radius: 999px; }
  .erga-account-menu .erga-account-github:hover, .erga-account-menu .erga-account-github:focus-visible { background: #32383f; }
  @media (prefers-color-scheme: dark) {
    .erga-account-menu .erga-account-github { color: #1f2328; background: #ececf1; }
    .erga-account-menu .erga-account-github:hover, .erga-account-menu .erga-account-github:focus-visible { background: #fff; }
  }
  .erga-account-github svg { width: 16px; height: 16px; }
  @media (pointer: coarse) { .erga-account-menu a { padding: 11px 12px; } }
</style>`;

const ACCOUNT_SCRIPT = `<script>(() => {
  const root = document.currentScript.previousElementSibling.previousElementSibling, btn = root.querySelector("button"), menu = root.querySelector(".erga-account-menu");
  const show = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", () => { show(menu.hidden); if (!menu.hidden) menu.querySelector("a")?.focus({ preventScroll: true }); });
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
