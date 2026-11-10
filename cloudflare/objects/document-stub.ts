// A document's object, as the Worker (and the other objects) call it: its
// stub, whose calls go straight to DocumentObject's methods.
//
// Cloudflare moves a running Durable Object to new code only when the object
// restarts. An object that tabs keep busy can run the old code for minutes
// after a deploy. A method that a deploy adds, or whose arguments it changes,
// fails on such an object until it restarts (2026-10-19: "The RPC receiver
// does not implement the method view", 5 minutes of 500s on the documents
// open at the deploy).
//
// The one door (DocumentObject.call: document-door.ts) is the way out of that: one method takes the name of the
// request and its arguments, so a new request is no new method. Nothing calls it yet: the objects must run the code
// that has it first (one deploy), and only then do the callers use it (the next).

import type { DocumentObject } from "./document";
import type { Env } from "../env";
import type { Call } from "./document-door";

/** A document's object as its callers see it (Cloudflare's own stub type loses the shape of a union answer). */
export type DocumentHost = { [K in Call]: DocumentObject[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  fetch(request: Request): Promise<Response>;
};

/** The document `id`'s object. */
export const documentOf = (env: Pick<Env, "DOCUMENTS">, id: string): DocumentHost => env.DOCUMENTS.getByName(id) as unknown as DocumentHost;
