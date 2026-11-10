// A document's object, as the Worker (and the other objects) call it: every call goes through the object's one door
// (DocumentObject.call: document-door.ts), by the request's name and its arguments.
//
// Cloudflare moves a running Durable Object to new code only when the object restarts. An object that tabs keep busy
// can run the old code for minutes after a deploy. A method that a deploy added failed on such an object until it
// restarted (2026-10-19: "The RPC receiver does not implement the method view", 5 minutes of 500s on the documents
// open at the deploy). Through the door, a new request is no new method: an object that runs the code from before the
// deploy answers that it doesn't know the request, and the caller gets DocumentBehind (server/platform.ts), which an
// operation answers as a 503 to try again (server/operations/operation.ts).
// Trap: a request whose ARGUMENTS change still reaches the old code with the new arguments. Add a new request instead.

import type { DocumentObject } from "./document";
import type { Env } from "../env";
import { callsThrough, type Call, type Door } from "./document-door";
import { DocumentBehind } from "../../server/platform.ts";

/** A document's object as its callers see it (Cloudflare's own stub type loses the shape of a union answer). */
export type DocumentHost = { [K in Call]: DocumentObject[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  fetch(request: Request): Promise<Response>;
};

/** The document `id`'s object: each of its calls goes through its door. */
export function documentOf(env: Pick<Env, "DOCUMENTS">, id: string): DocumentHost {
  const door = env.DOCUMENTS.getByName(id) as unknown as Door;
  return Object.assign(
    callsThrough(door, (op) => new DocumentBehind(op)),
    {
      fetch: (request: Request) => door.fetch(request),
    }
  ) as unknown as DocumentHost;
}
