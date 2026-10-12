// What the app needs from where it runs (`Platform`), and who is asking
// (`Session`). cloudflare/platform.ts builds the Platform from the Worker's
// bindings; the unit tests build one in memory. The app's code takes a
// Platform and web Requests, and never a Cloudflare binding.

import type { AuthOps } from "./auth.ts";
import { type Directory, type Role, type Route, type Who } from "./directory.ts";
import type { SiteOps } from "./site-publish.ts";
import type { AgentToken, Tokens } from "./tokens.ts";
import type { PublishRequest, PublishResult, RestoreResult, VersionsState } from "../document/versions.ts";
import { VIA } from "../shared/attribution.ts";

/** Who's signed in. */
export interface Session {
  login: string;
  name: string;
  /** A test person, signed in with a test token minted by `by` (hosted only). */
  test?: { by: string };
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
  /** Signed in with a document token: this one document (its id), and no other. */
  onlyDoc?: string;
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
}

/** What the front door needs from the platform it runs on. */
export interface Platform {
  /** Who's asking, if anyone is signed in (in local development, someone always is). */
  sessionOf(request: Request): Promise<Session | null>;
  /** The templates' text files, by template then path ("doc" → { "index.html": "..." }): assets/templates/doc is a blank document. */
  templates: Record<string, Record<string, string>>;
  /**
   * The repo's landing project (assets/landing/, built into the Worker), which the
   * server makes the front page by itself when landing_document is unset or
   * names a document that's gone (seedLanding): its text files by path, whose
   * document it becomes (locally DEV_LOGIN, else the deploy's first bootstrap
   * admin), and who else may edit it (the other bootstrap admins). No owner
   * (no ADMINS, no DEV_LOGIN): nobody to make it for, and / is a plain start page.
   */
  landing?: { files: Record<string, string | Uint8Array>; owner: string | null; editors: string[] };
  /** The editor's page, served at each document's address. */
  editor(request: Request): Promise<Response>;
  /**
   * Local development: /new may name the document (?id=) and shorten its
   * unedited time (?unedited=<ms>). Files open from disk through the
   * dev server's /__erga/open.
   */
  dev(url: URL): boolean;
  /**
   * Where documents' pages run (see pagesOrigin): "erga-pages.dev", or
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
   * A server for Erga's admins alone (staging: deploy/targets.json `adminsOnly`; cloudflare/admins-only.ts guards every
   * request). Its pages tokens name the admin they were made for, so its pages origin can check them again.
   */
  adminsOnly?: boolean;
  /** Every document's address, title and permissions; the server's users and settings. */
  directory: Directory;
  /** Agent tokens. */
  tokens: Tokens;
  /** How people sign in: this server's and the other deploy target's GitHub app, as `origin`'s server. */
  auth?(origin: string): AuthOps;
  /** Documents' sites on their person's Cloudflare account, as `origin`'s server, where the platform has them. */
  sites?(origin: string): SiteOps;

  /** A test token for the test suite, minted by `login` (shown on /tokens), where the platform makes them. */
  testToken?(login: string): Promise<{ token: string; expires: Date }>;
  docs: {
    /**
     * Makes the host of a document already in the directory, from a
     * template's files; false if it already has one. Unless someone edits
     * it, it goes at `expires`.
     */
    create(doc: Route, files: Record<string, string | Uint8Array>, index: string, opts: { test?: boolean; expires: number | null; modified?: number }): Promise<boolean>;
    /**
     * Files arriving whole into an existing document (a publish): written,
     * and merged into its room as edits; `remove` deletes files; `by`: who, as a version records it (byLine).
     */
    publish(doc: Route, files: Record<string, string | Uint8Array>, remove: string[], by?: string): Promise<{ written: string[]; removed: string[]; refused: { path: string; why: string }[] }>;
    /** Every file a document holds. */
    paths(doc: Route): Promise<string[]>;
    /** A document's page, or null if it has no host. */
    index(doc: Route): Promise<string | null>;
    /** A document's files as they are now, and its page: what a copy starts from. Null if it has no host. */
    snapshot(doc: Route, opts?: { published?: boolean }): Promise<{ index: string; files: Record<string, string | Uint8Array> } | null>;
    /** A document's versions, the current one and the published one; null if it has no host. */
    versions(doc: Route, opts: { before?: string | null; limit?: number }): Promise<VersionsState | null>;
    /** Sets what a document's viewers see: "latest", or one version ("manual"). The caller checks the person may edit. */
    setPublished(doc: Route, req: PublishRequest): Promise<PublishResult>;
    /** Brings a version back as a new current version, by `by`. The caller checks the person may edit. */
    restore(doc: Route, ref: string, by: string, path?: string | null): Promise<RestoreResult>;
    exists(doc: Route): Promise<boolean>;
    /** Deletes a document (its host takes it out of the directory too); false if it had no host. */
    delete(doc: Route): Promise<boolean>;
    /** `owner`'s documents, most recently changed first. */
    list(owner: string): Promise<Listed[]>;
    /** Hands a request to the document's host, its path already the one inside the document. */
    fetch(doc: Route, request: Request): Promise<Response>;
  };
}

/** What a role lets someone do inside a document, as its host is told (x-erga-access). */
export const accessOf = (role: Role | null): "edit" | "view" | null =>
  role == "owner" || role == "editor" ? "edit" : role == "viewer" ? "view" : null;

/** Who a session is, to the directory's `may`. */
export const whoOf = (session: Session): Who => ({
  login: session.login.toLowerCase(), test: !!session.test, ...(session.test ? { by: session.test.by.toLowerCase() } : {}),
  ...(session.admin && !session.test ? { admin: true } : {}), ...(session.onlyDoc != null ? { onlyDoc: session.onlyDoc } : {}),
  // An agent with their token acts for them: what it does is theirs, via it.
  ...(session.agent ? { via: VIA.token(session.agent.label) } : {}),
});

/**
 * The platform with agent tokens: a request carrying one ("Authorization:
 * Bearer erga_...") is signed in as the person it stands for, within its
 * scope, as long as they may still sign in, whatever cookie it
 * has: admin power only with the admin scope, one document only with the
 * document scope. A bearer token that isn't a good one (revoked, expired)
 * signs in nobody.
 */
export function withTokens(platform: Platform, url: URL): Platform {
  return {
    ...platform,
    async sessionOf(request) {
      const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      if (!bearer) return platform.sessionOf(request);
      const users = platform.directory.users;
      const token = await platform.tokens.verify(bearer).catch(() => null);
      if (!token) return null;
      // A test person's token opens only test documents, while whoever minted their test token may sign in.
      const session: Session = {
        login: token.login, name: token.name, agent: token, ...(token.testBy ? { test: { by: token.testBy } } : {}),
        // Admin power only with the admin scope (Users.isAdmin still decides); a document token, its one document.
        ...(token.scope == "admin" && !token.testBy ? { admin: true } : {}), ...(token.scope == "document" ? { onlyDoc: token.docId ?? "-" } : {}),
      };
      if (token.testBy) return (await users.allowed(token.testBy)) ? session : null;
      return platform.dev(url) || (await users.allowed(token.login)) ? session : null;
    },
  };
}
