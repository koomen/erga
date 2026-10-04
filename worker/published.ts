// The homepage's view of a document's published version (worker/home.ts),
// behind two functions, so it's one place to change when versions arrive
// (task #33: its onPublished and publishedFiles hooks).
//
// Until then a document's published version is its current files: they
// "change" whenever the document is edited, which the document's host
// reports (worker/doc-host.ts calls `publishedChanged` as it brings its
// directory row up to date, at most every couple of seconds), and the version
// has no number (null).

import type { Env } from "./env";

/** A document's published version: its page, its files and the version's number (null until versions exist). */
export interface Published { index: string; files: Record<string, string | Uint8Array>; version: number | null }

/** The published version of a document (its current files, for now); null if there's no such document. */
export async function publishedFiles(env: Env, docId: string): Promise<Published | null> {
  const snap = await env.DOCS.getByName(docId).snapshot();
  return snap && { index: snap.index, files: snap.files, version: null };
}

/**
 * A document's published version changed: if it's the homepage, the
 * homepage's next deploy is scheduled (worker/home.ts, debounced).
 */
export async function publishedChanged(env: Env, docId: string): Promise<void> {
  await env.HOME.getByName("home").changed(docId);
}
