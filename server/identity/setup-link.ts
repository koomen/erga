// The link that opens a new server's setup page (server/identity/setup.ts), which `bun erga setup` seals
// (deploy/own/cli.ts). Apart from the route, which makes pages, because `bun erga setup` must run in a new clone,
// before any build (Trap: a page's import reaches .build/, which git ignores; tests/imports.test.ts holds it).

import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";

/** How long the link opens the page. */
export const LINK_SECONDS = 30 * 60;

/** The link: nothing but this server's signature, its end, and `n`, which the server keeps when the link is used: it opens the page one time. */
export const SetupLink = signed("setup-link", Schema.Struct({ n: Schema.String }), LINK_SECONDS);

/** The link's address on `host`, sealed with the server's SESSION_SECRET. */
export const setupUrl = async (host: string, secret: string) =>
  `https://${host}/setup?t=${encodeURIComponent(await SetupLink.seal(secret, { n: crypto.randomUUID() }))}`;
