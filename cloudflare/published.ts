// The homepage's view of a document's published version,
// behind two functions, over the versions' hooks.
//
// A document's published version is, in "manual" mode, the version
// published; in "latest" mode, the document as it is now, which "changes"
// each time a new version is cut (after a burst of edits, an agent's turn,
// someone leaving). The document's host calls `publishedChanged` whenever it
// fires `firePublished`.

import { publishedFiles as versionsFiles } from "../server/versions";
import type { Env } from "./env";

/** A document's published version: its page, its files and the version's number. */
export interface Published { index: string; files: Record<string, string | Uint8Array>; version: number | null }

/** The published version of a document; null if there's no such document. */
export async function publishedFiles(env: Env, docId: string): Promise<Published | null> {
  const r = await versionsFiles(env, docId);
  return r && { index: r.index, files: Object.fromEntries(r.files), version: r.published.version.n };
}

/**
 * A document's published version changed: if it's the homepage, the
 * homepage's next deploy is scheduled.
 */
export async function publishedChanged(env: Env, docId: string): Promise<void> {
  await env.HOME.getByName("home").changed(docId);
}
