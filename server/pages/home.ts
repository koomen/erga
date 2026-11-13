// The homepage in the server's code: what / shows on a domain that has no homepage. None is assigned (the
// landing_document setting names no document that is there: server/documents/landing.ts), or the homepage has a domain
// of its own (Platform's deploy.home), and this is the Erga domain. Erga's headline and one way in, Sign in. Someone
// signed in never sees it: / sends them to /docs.

import { html, NO_STORE } from "../http.ts";
import { pageFonts } from "./assets.ts";
import { pageBars } from "./bars.ts";
import { appPage } from "./chrome.ts";

/** The headline's typeface is the templates' (Instrument Sans: pages/assets.ts), from this server; the rest is the app's. */
const STYLE = `
.home { flex: 1; box-sizing: border-box; width: 100%; max-width: 1164px; margin: 0 auto; padding: 0 32px; }
.hero { text-align: center; padding: 122px 0 44px; }
.hero h1 { margin: 0 auto; max-width: 36ch; font: 600 52px/1.04 "Instrument Sans", var(--font-text); letter-spacing: -0.028em; color: var(--fg-strong); text-wrap: balance; }
.hero p { margin: 18px auto 0; max-width: 34em; font-size: 18px; line-height: 1.5; color: var(--soft); text-wrap: balance; }
.hero p.cta { display: flex; justify-content: center; margin-top: 30px; }
.cta .go { display: inline-flex; align-items: center; height: 44px; padding: 0 20px; border-radius: 12px; font: 600 15px/1 var(--font-text); text-decoration: none;
  background: var(--fg-strong); color: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 6px 18px -6px rgba(0, 0, 0, 0.3); transition: transform 160ms, opacity 200ms; }
.cta .go:hover { opacity: 0.88; }
.cta .go:active { transform: translateY(1px); }
.cta .go:focus-visible { outline: 2px solid var(--caret); outline-offset: 3px; }
@media (max-width: 640px) {
  .home { padding: 0 16px; }
  .hero { padding: 94px 0 28px; }
  .hero h1 { font-size: 38px; }
  .hero p { font-size: 16.5px; }
}`;

export const homePage = () =>
  html(
    appPage(
      "An AI document editor",
      pageFonts("") + STYLE,
      `${pageBars(null, [])}<div class="home"><section class="hero">
  <h1>Erga is an AI document editor for people who care about every word</h1>
  <p>Erga gives you the expressive power of a coding agent without forcing you to give up control over your text</p>
  <p class="cta"><a class="go" href="/auth/sign-in?next=%2Fdocs">Sign in</a></p>
</section></div>`
    ),
    200,
    NO_STORE
  );
