// What every answer of the app tells a browser about how it may use it
// (handle, server/app.ts, puts it on each one, after the route table):
//
//   - HSTS, on every HTTPS answer (not on this machine's): HTTPS only, for a
//     year, on every subdomain too (all of erga.dev's are HTTPS; .dev is on the
//     browsers' HTTPS-only list anyway);
//   - on the site's own origin, no frame but its own: frame-ancestors 'self',
//     and X-Frame-Options for the browsers before it. The editor frames its
//     own files (a PDF in the viewer), never another site's page this one;
//   - on the site's own pages, a Content-Security-Policy: no plugins
//     (object-src) and no <base> to another site, so a script that got in
//     can't load code or send forms elsewhere by that;
//   - and on the app's pages (`scripts`), only the scripts the server wrote
//     in: each <script> gets this answer's nonce, and what they load
//     themselves runs too ('strict-dynamic'). So text that got into a page
//     as HTML can't run as a script: no inline handler (onclick=...), no
//     javascript: link, no eval. A script that a page's script makes takes
//     the page's nonce (scriptNonce, in the browser).
//
// An answer that has a policy of its own keeps it, with the frame rule added
// if it lacks one: a document's own HTML here (its files at /d/<id>/..., in a
// sandbox; the homepage and its files) is its authors' code, not the site's.
// A document's pages origin is apart: its pages say themselves which viewer
// may frame them (pages-origin.ts), and their scripts are their authors'.

import * as Base64 from "effect/encoding/Base64";
import { randomBytes } from "../shared/bytes.ts";
import { isLocal } from "../shared/http.ts";

/** HTTPS only, for a year, here and on every subdomain. */
export const HSTS = "max-age=31536000; includeSubDomains";

/** The policy every page of the site's own gets. */
export const PAGE_POLICY = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

/** The policy of everything else on the site's own origin. */
export const FRAME_POLICY = "frame-ancestors 'self'";

/** The script rule of a page whose every <script> has the nonce. */
export const scriptPolicy = (nonce: string) => `script-src 'nonce-${nonce}' 'strict-dynamic'`;

/** Whose answer: the site's own origin's, or a document's pages origin's. */
export type Kind = "site" | "pages";

/** The answer with the headers above, and with `scripts`, the script rule on a page. A WebSocket's (101) goes as it is. */
export function withSecurity(response: Response, url: URL, kind: Kind, scripts = false): Response {
  if (response.status == 101) return response;
  const headers = new Headers(response.headers);
  if (url.protocol == "https:" && !isLocal(url)) headers.set("Strict-Transport-Security", HSTS);
  // (A 304's headers replace those the browser kept with the page: its policy, with the nonce in the page, stays.)
  if (kind == "site" && response.status != 304) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    const own = headers.get("content-security-policy");
    // Its own policy, and the frame rule as a second one if it has none (a browser keeps to both).
    if (own != null) {
      if (!/\bframe-ancestors\b/.test(own)) headers.append("Content-Security-Policy", FRAME_POLICY);
    } else if (!/^text\/html\b/i.test(headers.get("content-type") ?? "")) headers.set("Content-Security-Policy", FRAME_POLICY);
    else if (!scripts || !response.body) headers.set("Content-Security-Policy", PAGE_POLICY);
    else {
      const nonce = Base64.encode(randomBytes(16));
      headers.set("Content-Security-Policy", `${PAGE_POLICY}; ${scriptPolicy(nonce)}`);
      const page = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      return new HTMLRewriter()
        .on("script", {
          element: (el) => {
            el.setAttribute("nonce", nonce);
          },
        })
        .transform(page);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
