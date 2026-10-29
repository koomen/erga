// The start page: what Erga is, when there's no landing document and none can be made.

import { type Platform, type Session, whoOf } from "../platform.ts";
import { appPage, crumbs, link } from "./chrome.ts";
import { esc } from "../../shared/html.ts";
import { html, NO_STORE } from "../http.ts";

/** The homepage when there's no landing document and none can be made (seedLanding): what Erga is, and the way in. */
export async function startPage(platform: Platform, session: Session | null) {
  const admin = !!session && !session.agent && (await platform.directory.users.isAdmin(whoOf(session)));
  const signedIn = session && !session.test;
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
      `${signedIn ? crumbs(session, []) : ""}<main class="start">
  <header><h1>Erga</h1></header>
  <p>Pages you edit where they're rendered, together with your agents.</p>
  <div class="actions">${actions}</div>
  ${admin ? `<p class="hint">There's no homepage: the deploy locks <code>landing_document</code> to a document that isn't there, or has no admins (<code>ADMINS</code>) to make the repo's demo page for. Choose one of your documents as <code>landing_document</code> on <a href="${esc(link("/admin", session))}">the admin page</a>.</p>` : ""}
</main>`
    ),
    200,
    NO_STORE
  );
}
