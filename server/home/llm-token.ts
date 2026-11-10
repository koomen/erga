// The page token: each HTML page of the homepage's project, as served (serve.ts), carries one for its window.ergaLLM
// (client/inline/home-llm.ts), and so does the viewer for someone signed out (server/documents/view.ts); a signed-out
// call to a page's model must send it (agents/page-llm.ts). It is the document's id, signed
// (server/signed.ts), good for an hour; a reload makes a new one. It stops a copy of the call on another site or in a script that never opens the
// page; a script that opens the page first gets one, and the per-IP limit is for that.

import * as Schema from "effect/Schema";
import { signed } from "../signed.ts";

/** How long a token is good. */
export const PAGE_TOKEN_MS = 3_600_000;

/** In the deployed homepage's page (renderHome): serve.ts puts each visitor's token in its place. */
export const TOKEN_SLOT = "erga:home-llm-token";

const Token = signed("home-llm", Schema.Struct({ doc: Schema.String }), PAGE_TOKEN_MS / 1000);

/** A token for document `doc`, made at `now`. */
export const pageToken = (secret: string, doc: string, now: number) => Token.seal(secret, { doc }, { now });

/** Whether `token` is good for document `doc` at `now`: signed here, for `doc`, and less than an hour old. */
export const tokenOk = async (secret: string, token: string | undefined, doc: string, now: number): Promise<boolean> =>
  (await Token.open(secret, token, now))?.doc == doc;
