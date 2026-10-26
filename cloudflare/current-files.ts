// A document as the homepage and its site deploy it: the document as it is
// now, with its current version. The document's object calls `homeChanged`
// each time it cuts a new version (after a burst of edits, an agent's turn,
// someone leaving).

import type { Env } from "./env";
import { documentOf } from "./objects/document-stub";

/** A document's files as they are now: its page, its files and its current version's number. */
export interface CurrentFiles { index: string; files: Record<string, string | Uint8Array>; version: number | null }

/** A document's files as they are now; null if there's no such document. */
export async function currentFiles(env: Env, docId: string): Promise<CurrentFiles | null> {
  const r = await documentOf(env, docId).currentFiles();
  return r && { index: r.index, files: Object.fromEntries(r.files), version: r.version.n };
}

/**
 * A document has a new version: if it's the homepage, the homepage's next
 * deploy is scheduled.
 */
export async function homeChanged(env: Env, docId: string): Promise<void> {
  await env.HOME.getByName("home").changed(docId);
}
