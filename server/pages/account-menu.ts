// Who you are, in the upper right of every page erga.dev serves: your
// avatar (your picture, shared/avatars.ts, or your initial on your colour if
// you have none or it doesn't load), which opens a small menu (your name, Go to… with its key ⌘K, Documents, Settings,
// Admin settings for admins, Send feedback, Sign out); or, signed out, a person in a circle whose
// menu has only Sign in (to the sign-in page, coming back to the same page).
//
// The Worker adds it to each of the site's HTML pages (`withAccount`,
// server/app.ts), so every page has it without each building it. The
// editor shows it itself, as the last of its own controls (client/shell/main.ts,
// the avatar at the far right), and says so with `OWN_ACCOUNT`. A document's
// pages origin never gets it: nothing of the person belongs there.

import { link, safeNext } from "./chrome.ts";
import { esc } from "../../shared/html.ts";
import { inlineScript, inlineStyle } from "./inline.ts";
import type { Session } from "../platform.ts";
import { colorFor } from "../../document/content.ts";

/** Where a page's header (pageBars, server/pages/bars.ts) wants the corner: at the right of its buttons' bar. */
export const ACCOUNT_SLOT = "<!--erga-account-->";

/** A response header: this page shows the account itself (the editor), so leave it be. */
export const OWN_ACCOUNT = "x-erga-own-account";

/** Who the corner shows: the signed-in person, or nobody. */
export interface Account {
  login: string;
  name: string;
  admin: boolean;
  /** Their picture (shared/avatars.ts); absent: none, so their initial shows. */
  avatar?: string;
  /** The ?user= a local tab carries, kept on the menu's links. */
  session: Session;
}

export const accountOf = (session: Session | null, admin: boolean): Account | null =>
  !session || session.agent
    ? null
    : {
        login: session.login,
        name: session.name,
        admin,
        session,
        ...(session.avatar ? { avatar: session.avatar } : {}),
  };

const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9.25" r="3.25"/><path d="M5.75 19c.9-3.1 3.3-4.75 6.25-4.75s5.35 1.65 6.25 4.75"/></svg>`;

/** Where signing in from `here` (a path and query on this site) starts, and comes back to. */
export const signInUrl = (here: string) => `/auth/sign-in?next=${encodeURIComponent(safeNext(here.startsWith("/auth/") ? "/" : here))}`;

/** The corner: markup, its style and the few lines that open and close the menu. */
export function accountHtml(account: Account | null, here: string): string {
  return `${accountMarkup(account, here)}${ACCOUNT_STYLE}${ACCOUNT_SCRIPT}`;
}

/** The corner's markup alone (the homepage puts it in a shadow root of its own, with ACCOUNT_STYLE: server/home/render.ts). */
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
<a href="#go" class="erga-account-go">Go to…<kbd>⌘K</kbd></a>
<a href="${esc(link("/docs", s))}">Documents</a>
<a href="#settings">Settings</a>
${account.admin ? `<a href="${esc(link("/admin", s))}">Admin settings</a>` : ""}
<a href="#feedback">Send feedback</a>
<a href="/auth/logout">Sign out</a>
</div>
</div>`;
}

/**
 * A page with the corner added, unless it shows it itself. Pages are small,
 * so it's read whole: in the page's header (ACCOUNT_SLOT), else before </body>
 * if there is one, else </html>, else at the end.
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
  // In the page's header if it has one (ACCOUNT_SLOT), else at its end.
  const slot = html.indexOf(ACCOUNT_SLOT);
  const at = slot >= 0 ? slot : html.lastIndexOf("</body>") >= 0 ? html.lastIndexOf("</body>") : html.lastIndexOf("</html>");
  const body = at >= 0 ? html.slice(0, at) + corner + html.slice(slot >= 0 ? at + ACCOUNT_SLOT.length : at) : html + corner;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** The corner's look (client/inline/account.css): its own colours, since pages differ. */
export const ACCOUNT_STYLE = `<style>${inlineStyle("account")}</style>`;

/** The menu's open and close (client/inline/account-menu.ts), after the corner and its style. */
const ACCOUNT_SCRIPT = inlineScript("account-menu");
