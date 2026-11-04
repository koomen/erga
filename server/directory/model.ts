// The directory's words: a document's row and its address's parts, who asks (Who) and what they may do, a
// permission, and the shapes of an owner and an id. Directory (directory.ts) keeps them in the database.

import type { DocKind } from "../../document/pages.ts";
import type { Role } from "../../document/access.ts";
import { randomString } from "../../shared/bytes.ts";

/** What SQL a platform gives the directory (D1, bun:sqlite). Parameters are `?1`, `?2`... */
export interface Sql {
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  run(sql: string, ...params: Param[]): Promise<void>;
  /** Runs the statements in order, all or nothing. */
  batch(statements: Statement[]): Promise<void>;
}
export type Param = string | number | null;
export type Statement = [sql: string, ...params: Param[]];

export interface DocRow {
  id: string;
  /** The owner's login, lowercase. */
  owner: string;
  slug: string;
  title: string;
  /** Someone set the title: it no longer follows the page's first heading. */
  titleSet: boolean;
  /** Someone set the slug: it no longer follows the title. */
  slugSet: boolean;
  created: number;
  /** When a file last changed; null if never. */
  modified: number | null;
  /** When it goes if nobody edits it; null once someone has. */
  expires: number | null;
  test: boolean;
  /** A document (one page) or a project (pages); null if its row has none. */
  kind: DocKind | null;
}

/** A document or project an admin's search finds (Directory.search). */
export interface DocFound {
  id: string;
  title: string;
  /** The owner's login. */
  owner: string;
  /** Its canonical address, "/<owner>/<slug>". */
  address: string;
  /** A document (one page) or a project (pages); a document if its row has none. */
  kind: DocKind;
}

/** A role that can be given to someone (a document's owner is who made it, and stays so). */
export type Grant = "editor" | "viewer";
export type Action = "open" | "edit" | "rename" | "delete" | "share";
/** Someone asking to do something: a login (lowercase). */
export interface Who {
  login: string;
  /** Comes with admin power: a browser session, or an admin token. Set by the app. */
  admin?: boolean;
  /** A document token's document: they may touch this one document, and no other. */
  onlyDoc?: string;
  /** How they act, when not in person: through one of their agents. Recorded beside their login. */
  via?: string;
}
/** What making a document answers someone the write rule (/admin/users) leaves out. */
export const NO_WRITE =
  "Your access on this server is Can authenticate: you may open what is shared with you or public, but not make or edit documents. An admin can give you Can create and edit content on the Users page.";

/** What sharing with anyone with the link answers while the server doesn't let users share content publicly. */
export const NO_PUBLIC =
  "This server doesn't let users share content publicly, so this document can't be shared with anyone with the link. An admin can turn on \"Users can share content publicly\" on the Access page (/admin/access). Share it with people by their username instead.";

/** The login a permission for anyone with the link is under: anyone signed in, and, while the server lets users share content publicly, people who aren't signed in too (as viewers). */
export const ANYONE = "*";

/** A row some open pages show changed: its key ("doc:<id>"), and who may see it ("admins": every admin). server/news/ carries it. */
export interface News {
  key: string;
  to: readonly string[] | "admins";
}

/** One person's (or anyone's, "*") permission on a document. */
export interface Permission {
  login: string;
  role: Role;
  granted: number;
  grantedBy: string | null;
  /** How `grantedBy` shared it, when not in person: "their agent", "a shared agent (label)". */
  grantedVia?: string | null;
}

/**
 * Words that can't be slugs: the app's own first path segments (server/documents/routes.ts,
 * server/app.ts) and the document host's, so an
 * address never reads as one of those, and a few kept for later.
 */
export const RESERVED = new Set([
  "d",
  "docs",
  "new",
  "auth",
  "tokens",
  "api",
  "fonts",
  "doc",
  "t",
  "delete",
  "rename",
  "page.js",
  "frame.js",
  "style.css",
  "assets",
  "static",
  "settings",
  "admin",
  "login",
  "logout",
  "help",
  "about",
  "share",
  "members",
  // The homepage's pages with an address of their own (server/home/serve.ts, HOME_PAGES).
  "source",
]);

/** A new document's row. Its slug starts from `slug` (else its title), with -2, -3... if that's taken; `slugSet` fixes it there. */
export interface NewDoc {
  id: string;
  owner: string;
  title: string;
  slug?: string;
  titleSet?: boolean;
  slugSet?: boolean;
  created: number;
  modified?: number | null;
  expires?: number | null;
  test?: boolean;
  /** A role for anyone signed in who has the link, from the start (local development's documents on disk). */
  everyone?: Grant;
  /** A document (one page) or a project (pages); left for its object to decide as it opens, if not given. */
  kind?: DocKind;
}

/** Where a request's document is: enough to reach its host (named by its id) and decide who may. None of it ever changes. */
export interface Route {
  id: string;
  owner: string;
  test: boolean;
}

/** The shape of an owner (a GitHub login) and of a document's id (8 lowercase letters and digits). */
export const OWNER = /^[A-Za-z0-9-]{1,39}$/,
  ID = /^[a-z0-9]{8}$/;
/** Whether a segment could be an id. */
export const idShaped = (s: string) => ID.test(s);
export const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** A new document's id: 8 characters of ALPHABET. */
export const newDocId = () => randomString(8, ALPHABET);
