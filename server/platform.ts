// What the app needs from where it runs (`Platform`), and who is asking
// (`Session`, which server/identity works out). cloudflare/platform.ts builds
// the Platform from the Worker's bindings; the unit tests build one in
// memory. The app's code takes a Platform and web Requests, and never a
// Cloudflare binding.

import type { AgentToken, AuthStorage, SignIn, Tokens } from "./identity/index.ts";
import type { HomeObject } from "./home/index.ts";
import { type Directory, type Route, type Who } from "./directory/index.ts";
import type { Role } from "../document/access.ts";
import type { RestoreResult, Version, VersionsState } from "../document/versions.ts";
import type { FileList, NameAnswer, TreeAnswer, TreeState } from "../document/host.ts";
import type { FileData } from "../document/document.ts";
import type { Published } from "../document/uploads.ts";
import type { Writer } from "../document/waits.ts";
import type { ViewAnswer } from "../document/view.ts";
import type { CommentAnswer, CommentCall } from "../document/comments.ts";
import type { DocKind, TreeOp } from "../document/pages.ts";
import { VIA } from "../shared/attribution.ts";

/** Who's signed in. */
export interface Session {
  login: string;
  name: string;
  /** In local development, the name a tab gave in ?user=, carried along in the links it follows. */
  as?: string;
  /** Signed in with an agent token: an agent acting as this person. */
  agent?: AgentToken;
  /**
   * Comes with admin power: a signed-in browser session does,
   * a token only with the admin scope (withTokens). Every admin-only call
   * needs it, and Users.isAdmin must say yes too (Users.mustAdmin).
   */
  admin?: boolean;
  /** Signed in with a document token or a view cookie: this one document (its id), and no other. */
  onlyDoc?: string;
  /**
   * The server's browser, rendering the document's page in the viewer for an agent (view_page: identity/session.ts,
   * viewCookie): the person on one document, with no admin power and no agent of theirs. It runs an agent's code
   * (eval_in_page), so what it does is an agent's (whoOf: `via`), and it makes no token (shareToken).
   */
  view?: boolean;
  /** Their picture (users.avatar, shared/avatars.ts), read with their row at each request; absent: none. */
  avatar?: string;
}

/** A document as its owner's list shows it. */
export interface Listed {
  id: string;
  owner: string;
  slug: string;
  title: string;
  titleSet: boolean;
  slugSet: boolean;
  created: number;
  /** When a file last changed (when it was made, if never). */
  modified: number;
  /** When it goes away if nobody edits it (only while it's never been edited). */
  expires?: number;
  /** In local development, a document that's a file or folder on disk: where it is. Deleting it leaves the files be. */
  path?: string;
  /** What the person whose list it is may do with it: their own document, or one shared with them. */
  role: Role;
  /** How many it's shared with besides its owner (anyone with the link counts as one). */
  shared?: number;
  /** A document (one page) or a project (pages); missing if its row has none. */
  kind?: DocKind;
}

/**
 * A row of a page as an open page fetches it after it changed (live pages: server/news/): its HTML, made by the page's
 * own row function, and its place (data-sort); null: the person no longer sees it.
 */
export type LiveRow = { html: string; sort: number | string } | null;

/** The rows `keys` name, as `session` sees them now (`origin`: the site's): what a page gives live pages for each list it keeps live. */
export type LiveRows = (platform: Platform, session: Session, keys: string[], origin: string) => Promise<Record<string, LiveRow>>;

/**
 * What the app needs from the platform it runs on. The layers above server/ add the parts that are theirs, each
 * where it is defined (a `declare module` of this file): agents/ adds `agentSettings`
 * (agents/models.ts) and `adminAgent`
 * (agents/person/sessions.ts). cloudflare/platform.ts builds the whole of it.
 */
export interface Platform {
  /** Who's asking, if anyone: a signed-in person, or an agent with their token (server/identity/session.ts). */
  sessionOf(request: Request): Promise<Session | null>;
  /** The templates' text files, by template then path ("doc" → { "index.html": "..." }): assets/templates/doc is a blank document. */
  templates: Record<string, Record<string, string>>;
  /**
   * The repo's landing project (assets/landing/, built into the Worker), which the deploy makes the homepage project
   * from when the server has none (server/documents/landing.ts, makeHome): its files by path (read only then: they are
   * large).
   */
  landing?: { files: () => Promise<Record<string, string | Uint8Array>> };
  /** The app's own static files (the editor's page and scripts, their builds, the release): the answer for this request. */
  assets(request: Request): Promise<Response>;
  /**
   * Local development: /new may name the document (?id=) and shorten its
   * unedited time (?unedited=<ms>). Files open from disk through the
   * dev server's /__erga/open.
   */
  dev(url: URL): boolean;
  /**
   * Where documents' pages run (see pagesOrigin): "example-pages.com", or
   * "localhost" for a request that came to this machine.
   */
  pagesDomain(url: URL): string;
  /**
   * One host every document's pages share, instead of an origin each under
   * pagesDomain: for a server with no wildcard domain (on workers.dev, which
   * has none; PAGES_HOST). Pages stay off the app's origin, but not off each
   * other's. Null or absent: an origin each.
   */
  pagesShared?(url: URL): string | null;
  /** Signs the tokens that open a document's files on its pages origin. */
  secret: string;
  /**
   * A server for its admins alone (a staging instance: the deploy names its primary, SNAPSHOT_FROM; server/identity/admins-only.ts guards every
   * request). Its pages tokens name the admin they were made for, so its pages origin can check them again.
   */
  adminsOnly?: boolean;
  /** Every document's address, title and permissions; the server's users and settings. */
  directory: Directory;
  /** Agent tokens. */
  tokens: Tokens;
  /** What this server runs, and where its deploy put it. */
  deploy: {
    /** The release this server runs (the commit), or null where no deploy named one. */
    version: string | null;
    /**
     * Where the pipeline deployed it: the Cloudflare account, the Worker, the database, the app's address and the pages'
     * (deploy/pipeline/account.ts, deployFacts), as JSON; null where no deploy said (local development). GET /api/ops
     * answers it, to an admin's ops token only.
     */
    facts: unknown;
    /** A staging instance's primary: the origin it copies documents and images from (SNAPSHOT_FROM), or null on any other server. */
    primary: string | null;
    /**
     * The homepage's own domain (the deploy facts' home: `bun erga deploy <host> --home <domain>` sets it), or null: the
     * homepage is on this server's own domain.
     */
    home: string | null;
    /** The app's own host in the deploy facts (app), or null: where the homepage's own domain sends a visitor to sign in. */
    app: string | null;
  };
  /** How people sign in: the mode and its values, from the deploy (server/identity/mode.ts), and what both modes read. */
  signIn: SignIn & {
    /** Local development: the login signed in without a provider; null elsewhere. */
    devLogin: string | null;
    /** What encrypts the secrets admins store (sign-in's secret, the API keys); null where the server can't keep them. */
    encryptionKey: string | null;
  };
  /** The news hub (server/news/): the open pages' sockets, which hear which of their rows changed. One object per server. */
  news: { fetch(request: Request): Promise<Response> };
  /** The homepage's deploys and its snapshot (server/home/deploys.ts), one object per server. */
  home: HomeObject;
  /** What runs at the edge, around a request. */
  edge: {
    /** The edge's cache, shared by the isolates of one place; null where there's none (workers.dev). */
    cache: { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean> } | null;
    /** Work that goes on after the response is sent. */
    background(work: Promise<unknown>): void;
    /** How often / asks the home object whether its snapshot is still current (0: every time; the tests). */
    homeRecheckMs: number;
  };
  /**
   * This server's own small storage, which a copy of production's data never
   * replaces (the sign-in values set on /admin/auth live here, not in the database).
   */
  own: AuthStorage;
  docs: {
    /**
     * Makes the host of a document already in the directory, from a
     * template's files; false if it already has one. Unless someone edits
     * it, it goes at `expires`; a scratch one goes then, edited or not.
     */
    create(
      doc: Route,
      files: Record<string, FileData>,
      index: string,
      opts: { test?: boolean; expires: number | null; modified?: number; kind?: DocKind; scratch?: boolean }
    ): Promise<boolean>;
    /** A scratch document saved: its host keeps it. False if it has no host. */
    keep(doc: Route): Promise<boolean>;
    /**
     * Files arriving whole into an existing document (a publish): written,
     * and merged into its room as edits; `remove` deletes files; `by`: who, as a version records it (byLine).
     * `writer`: who wrote, when their write may wait for a file's bytes (document/waits.ts).
     */
    publish(doc: Route, files: Record<string, FileData>, remove: string[], by?: string, writer?: Writer): Promise<Published>;
    /** Every file a document holds. */
    paths(doc: Route): Promise<string[]>;
    /** A document's page, or null if it has no host. */
    index(doc: Route): Promise<string | null>;
    /** A document's files as they are now (a blob as its ref), and its page: what a copy starts from. Null if it has no host. */
    snapshot(doc: Route): Promise<{ index: string; files: Record<string, FileData> } | null>;
    /** A document's versions and the current one; null if it has no host. */
    versions(doc: Route, opts: { before?: string | null; limit?: number }): Promise<VersionsState | null>;
    /** Brings a version back as a new current version, by `by`. The caller checks the person may edit. */
    restore(doc: Route, ref: string, by: string, path?: string | null): Promise<RestoreResult>;
    /** One version (by id or number) with its files' paths; null if there's none. */
    version(doc: Route, ref: string): Promise<(Version & { files: string[]; index: string }) | null>;
    /** One file of a version; null if there's no such version or file. */
    versionFile(doc: Route, ref: string, path: string): Promise<Uint8Array | null>;
    /** Its file tree (pages with titles, files, folders), its latest moves and its kind; null if it has no host. */
    tree(doc: Route): Promise<TreeState | null>;
    /** A tree operation: the tree after it, or why not. The caller checks the person may edit. */
    treeOp(doc: Route, op: TreeOp): Promise<TreeAnswer>;
    /** Every file (its kind, size, time) and folder; null if it has no host. */
    files(doc: Route): Promise<FileList | null>;
    /** Renames it as `person` (title and/or slug; "" or null goes back to following): its open tabs follow. The caller checks they may. */
    rename(doc: Route, person: { id: string; name: string }, patch: { title?: string | null; slug?: string | null }): Promise<NameAnswer>;
    /** Its comments: a list, or a change (document/comments.ts). The caller checks what the person may do. */
    comments(doc: Route, call: CommentCall): Promise<CommentAnswer>;
    /** Deletes a document (its host takes it out of the directory too); false if it had no host. */
    delete(doc: Route): Promise<boolean>;
    /** `owner`'s documents, most recently changed first; with `ids`, only those of them. */
    list(owner: string, o?: { ids?: readonly string[]; archived?: boolean }): Promise<Listed[]>;
    /** Hands a request to the document's host, its path already the one inside the document. */
    fetch(doc: Route, request: Request): Promise<Response>;
    /**
     * A viewer's page, in one call to the document's host (document/document.ts, view): what `who` may do (`anyone`:
     * the homepage), which file the address `page` is, the version viewers see, and the file's text unless the caller
     * has that version (`have`). Null if there's no such document. Asks the database nothing.
     */
    view(id: string, who: Who | null, opts: { page: string; anyone?: boolean }): Promise<ViewAnswer | null>;
  };
}

/**
 * A document's object doesn't know a request: it still runs the code from before a deploy (it moves to the new code
 * when it restarts, some minutes later). The request can go again then.
 */
export class DocumentBehind extends Error {
  readonly status = 503;
  constructor(readonly request: string) {
    super("This document still runs the code from before the last update. Try again in a minute.");
  }
}

/** Who a session is, to the directory's `may`. */
export const whoOf = (session: Session): Who => ({
  login: session.login.toLowerCase(),
  ...(session.admin ? { admin: true } : {}),
  ...(session.onlyDoc != null ? { onlyDoc: session.onlyDoc } : {}),
  // An agent with their token acts for them: what it does is theirs, via it.
  // The server's browser runs an agent's code: an agent's too.
  ...(session.agent ? { via: VIA.token(session.agent.label) } : session.view ? { via: VIA.view } : {}),
});
