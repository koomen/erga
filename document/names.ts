// A document's name: its title and its address, /<owner>/<slug>. The title
// follows the page's first heading until someone sets it, and the slug the
// title (server/directory/ keeps them, and decides a rename). The document's
// host reads and changes its name through `Naming`, as one person.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DocName } from "./api.ts";
import { slugify } from "./pages.ts";

/** A rename that can't be done; the message says why, for a person or an agent to act on. */
export class NameError extends Schema.TaggedError<NameError>()("NameError", { message: Schema.String }) {}

export const UNTITLED = "Untitled";

/**
 * The homepage project (server/documents/landing.ts): every server has one, and nobody owns it. Its row's owner is
 * HOME_OWNER, which no account can be (a username starts with a letter or a digit). Its address is /_home, and
 * /_home/<page> for its other pages; every admin may edit it (server/directory/, homeLimit).
 */
export const HOME_OWNER = "-home";
export const HOME_SLUG = "home";
export const HOME_ADDRESS = "/_home";
export const HOME_TITLE = "Erga Homepage";

/** A document's address: /<owner>/<slug>, and /_home for the homepage project. */
export const addressOf = (d: { owner: string; slug: string }) => (d.owner == HOME_OWNER ? HOME_ADDRESS : `/${d.owner}/${d.slug}`);

/** What a name is made from: a document's row in the directory. */
export interface NamedRow {
  id: string;
  owner: string;
  title: string;
  slug: string;
  titleSet: boolean;
  slugSet: boolean;
}

export const nameOf = (d: NamedRow): DocName => ({
  id: d.id,
  owner: d.owner,
  title: d.title,
  slug: d.slug,
  address: addressOf(d),
  titleSet: d.titleSet,
  slugSet: d.slugSet,
});

/** What a document's host needs to show and change its name, as one person. */
export interface Naming {
  get(): Effect.Effect<DocName, NameError>;
  /** Fails with a NameError a person or agent can act on (taken, reserved, not allowed). */
  set(patch: { title?: string | null; slug?: string | null }): Effect.Effect<DocName, NameError>;
}

/** What naming asks the directory: a document's row, and the rename. */
export interface NamesDirectory {
  get(id: string): Promise<NamedRow | null>;
  rename(id: string, patch: { title?: string | null; slug?: string | null }, pageTitle: string | null): Promise<{ doc: NamedRow }>;
}

/**
 * A document's naming for its host: reads and renames go to the directory, with the page's own title for going back
 * to following it. Who may rename it, the app decides before it asks (rename_document, as the directory's `may`): the
 * host's person has no admin power, so the host can't decide it for the homepage project, which only admins edit.
 */
export function namingFor(dir: NamesDirectory, id: string, pageTitle: () => string | null): Naming {
  // The directory's failures (its own NameError, or a database's) as a NameError: what the person reads.
  const ask = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: f,
      catch: (e) => (e instanceof NameError ? e : new NameError({ message: e instanceof Error ? e.message : String(e) })),
    });
  const row = Effect.flatMap(
    ask(() => dir.get(id)),
    (doc) => (doc ? Effect.succeed(doc) : Effect.fail(new NameError({ message: "This document isn't in the directory." })))
  );
  return {
    get: () => Effect.map(row, nameOf),
    set: (patch) =>
      Effect.map(
        ask(() => dir.rename(id, patch, pageTitle())),
        (r) => nameOf(r.doc)
      ),
  };
}
