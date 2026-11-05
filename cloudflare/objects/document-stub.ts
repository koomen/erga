// A document's object, as the Worker (and the other objects) call it: its
// stub, whose calls go straight to DocumentObject's methods.
//
// Cloudflare moves a running Durable Object to new code only when the object
// restarts. An object that tabs keep busy can run the old code for minutes
// after a deploy. A method that a deploy adds, or whose arguments it changes,
// fails on such an object until it restarts (2026-10-19: "The RPC receiver
// does not implement the method view", 5 minutes of 500s on the documents
// open at the deploy).

import type { DocumentObject } from "./document";
import type { Env } from "../env";

/** The object's methods the Worker calls. */
type Call =
  | "create"
  | "keep"
  | "link"
  | "publish"
  | "paths"
  | "index"
  | "snapshot"
  | "delete"
  | "notify"
  | "diskPath"
  | "exportStorage"
  | "importStorage"
  | "wipeStorage"
  | "versionsState"
  | "restore"
  | "currentFiles"
  | "version"
  | "versionFile"
  | "tree"
  | "treeOp"
  | "fileList"
  | "rename"
  | "setPermissions"
  | "view";

/** A document's object as its callers see it (Cloudflare's own stub type loses the shape of a union answer). */
export type DocumentHost = { [K in Call]: DocumentObject[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never } & {
  fetch(request: Request): Promise<Response>;
};

/** The document `id`'s object. */
export const documentOf = (env: Pick<Env, "DOCUMENTS">, id: string): DocumentHost => env.DOCUMENTS.getByName(id) as unknown as DocumentHost;
