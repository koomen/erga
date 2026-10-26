// A document's name: its title and its address, /<owner>/<slug>. The title
// follows the page's first heading until someone sets it, and the slug the
// title (server/directory/ keeps them, and decides a rename). The document's
// host reads and changes its name through `Naming`, as one person.

import type { DocName } from "./api.ts";
import { slugify } from "./pages.ts";

/** A rename that can't be done; the message says why, for a person or an agent to act on. */
export class NameError extends Error {}

export const UNTITLED = "Untitled";

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
  address: `/${d.owner}/${d.slug}`,
  titleSet: d.titleSet,
  slugSet: d.slugSet,
});

/** What a document's host needs to show and change its name, as one person. */
export interface Naming {
  get(): Promise<DocName>;
  /** Throws a NameError a person or agent can act on (taken, reserved, not allowed). */
  set(patch: { title?: string | null; slug?: string | null }): Promise<DocName>;
}

/** What naming asks the directory: a document's row, whether someone may rename it, and the rename. */
export interface NamesDirectory<Who> {
  get(id: string): Promise<(NamedRow & { test: boolean }) | null>;
  may(who: Who, action: "rename", doc: { id: string; owner: string; test: boolean }): Promise<boolean>;
  rename(id: string, patch: { title?: string | null; slug?: string | null }, pageTitle: string | null): Promise<{ doc: NamedRow }>;
}

/**
 * A document's naming for its host: reads and renames go to the directory,
 * as `who` (whom `may` must allow), with the page's own title for going back
 * to following it.
 */
export function namingFor<Who>(dir: NamesDirectory<Who>, id: string, pageTitle: () => string | null) {
  return (who: Who): Naming => ({
    async get() {
      const doc = await dir.get(id);
      if (!doc) throw new NameError("This document isn't in the directory.");
      return nameOf(doc);
    },
    async set(patch) {
      const doc = await dir.get(id);
      if (!doc) throw new NameError("This document isn't in the directory.");
      if (!(await dir.may(who, "rename", doc))) throw new NameError("You can't rename this document.");
      return nameOf((await dir.rename(id, patch, pageTitle())).doc);
    },
  });
}
