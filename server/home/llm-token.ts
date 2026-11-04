// The homepage's page token: each HTML page of the homepage's project, as served (serve.ts), carries one for its
// window.ergaLLM (client/inline/home-llm.ts), and a signed-out call to the homepage's model must send it
// (agents/page-llm.ts). It is the document's id and the time it was made, signed with the server's secret, good for
// an hour; a reload makes a new one. It stops a copy of the call on another site or in a script that never opens the
// page; a script that opens the page first gets one, and the per-IP limit is for that.

import { sign, unsign } from "../identity/index.ts";

/** How long a token is good. */
export const PAGE_TOKEN_MS = 3_600_000;

/** In the deployed homepage's page (renderHome): serve.ts puts each visitor's token in its place. */
export const TOKEN_SLOT = "erga:home-llm-token";

/** A token for document `doc`, made at `now`. */
export const pageToken = (secret: string, doc: string, now: number) => sign(secret, `home-llm:${doc}:${now}`);

/** Whether `token` is good for document `doc` at `now`: signed here, for `doc`, and less than an hour old. */
export async function tokenOk(secret: string, token: string | undefined, doc: string, now: number): Promise<boolean> {
  const value = token ? await unsign(secret, token) : null;
  const [kind, id, at] = value?.split(":") ?? [];
  const made = Number(at);
  return kind == "home-llm" && id == doc && Number.isFinite(made) && made <= now + 60_000 && now - made < PAGE_TOKEN_MS;
}
