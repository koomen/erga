// The start page: what Erga is, when there's no landing document and none can be made. And the front page: the Erga
// domain's / when the homepage has a domain of its own.

import { type Platform, type Session, whoOf } from "../platform.ts";
import { appPage, link } from "./chrome.ts";
import { pageBars } from "./bars.ts";
import { esc } from "../../shared/html.ts";
import { html, NO_STORE } from "../http.ts";
import { MARK, WORDMARK } from "../../assets/logo/logo.ts";
import { OWN_ACCOUNT } from "./account-menu.ts";

/** The homepage when there's no landing document and none can be made (seedLanding): what Erga is, and the way in. */
export async function startPage(platform: Platform, session: Session | null) {
  const admin = !!session && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  const signedIn = !!session;
  const actions = signedIn
    ? `<a class="new" href="${esc(link("/docs", session))}">Your documents</a><a class="pill" href="${esc(link("/new", session))}">New document</a>`
    : `<a class="new" href="/auth/sign-in?next=%2Fdocs">Sign in</a>`;
  const style = `
  .start { padding-top: 22vh; }
  .start p { margin: 0 0 22px; color: var(--soft); }
  .start .actions { display: flex; gap: 8px; }
  .start .pill { text-decoration: none; }
  .start .hint { margin-top: 28px; font-size: 13px; }
  .start code { font-family: var(--font-mono); font-size: 12.5px; }
  .start .hint a { color: inherit; }`;
  return html(
    appPage(
      "Erga",
      style,
      `${pageBars(session, [])}<main class="start">
  <header><h1>Erga</h1></header>
  <p>Pages you edit where they're rendered, together with your agents.</p>
  <div class="actions">${actions}</div>
  ${admin ? `<p class="hint">There's no homepage: the deploy locks <code>landing_document</code> to a document that isn't there, or the server has no admin yet to make the repo's demo page for. Choose one of your documents as <code>landing_document</code> on <a href="${esc(link("/admin/settings", session))}">the admin page</a>.</p>` : ""}
</main>`
    ),
    200,
    NO_STORE
  );
}

/**
 * The Erga domain's / when the homepage is on a domain of its own (Platform's deploy.home): Erga's brand and one way
 * in, Sign in. No link to the site, and nothing to set. Someone signed in never sees it: / sends them to /docs.
 */
export function frontPage() {
  const style = `
  body { min-height: 100dvh; display: grid; place-items: center; }
  .front { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 24px 16px 12vh; text-align: center; }
  .front .erga-mark { width: 64px; height: 64px; padding: 14px; box-sizing: border-box; border-radius: 16px; color: var(--fg-strong);
    background: var(--bg); box-shadow: 0 0 0 1px color-mix(in srgb, var(--fg-strong) 12%, transparent), 0 6px 20px rgba(0, 0, 0, 0.08); }
  .front h1 { margin: 0; color: var(--fg-strong); line-height: 0; }
  .front h1 .wordmark { width: 104px; height: auto; vertical-align: 0 !important; }
  .front .new { height: 40px; min-width: 160px; padding: 0 22px; border-radius: 999px; font-size: 15px; text-decoration: none; }`;
  return html(
    appPage(
      "Sign in",
      style,
      `<main class="front">${MARK}<h1>${WORDMARK}</h1><a class="new" href="/auth/sign-in?next=%2Fdocs">Sign in</a></main>`,
      false
    ),
    200,
    // Its Sign in is the account's only control here: no corner.
    { ...NO_STORE, [OWN_ACCOUNT]: "1" }
  );
}
