// What the app needs from where it runs (`Platform`), and who is asking
// (`Session`, which server/identity works out). cloudflare/platform.ts builds
// the Platform from the Worker's bindings; the unit tests build one in
// memory. The app's code takes a Platform and web Requests, and never a
// Cloudflare binding.

import type { AgentToken, AppValues, AuthStorage, Tokens } from "./identity/index.ts";
import type { TargetName } from "../deploy/targets.ts";
import type { HomeObject } from "./home/index.ts";
import type { SourceService } from "./source/index.ts";
import type { AdminAgentObject, DashboardDeploys } from "./admin/index.ts";
import type { AgentConfig } from "../agents/models.ts";
import { type Directory, type Role, type Route, type Who } from "./directory/index.ts";
import type { SiteOps } from "./sites/index.ts";
import type { RestoreResult, VersionsState } from "../document/versions.ts";
import type { ViewAnswer } from "../document/document.ts";
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
  /** Who's asking, if anyone: a signed-in person, or an agent with their token (server/identity/session.ts). */
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
  /** The app's own static files (the editor's page and scripts, their builds, the release): the answer for this request. */
  assets(request: Request): Promise<Response>;
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
   * A server for Erga's admins alone (staging: deploy/targets.json `adminsOnly`; server/identity/admins-only.ts guards every
   * request). Its pages tokens name the admin they were made for, so its pages origin can check them again.
   */
  adminsOnly?: boolean;
  /** Every document's address, title and permissions; the server's users and settings. */
  directory: Directory;
  /** Agent tokens. */
  tokens: Tokens;
  /** Which of Erga's own deploy targets this server is, and how it reaches the other one. */
  deploy: {
    /** "production", "staging", or null on any other server (one /deploy made, local development). */
    target: TargetName | null;
    /** The release this server runs (the commit), or null where no deploy named one. */
    version: string | null;
    /** The secret Erga's servers prove themselves to each other with (DEPLOY_HOOK_SECRET); "" when there's none. */
    hookSecret: string;
    /** The other target's server: https://<its host>, or local development's stand-in for it. */
    originOf(target: TargetName): string;
  };
  /** Sign-in's fixed values, from the deploy. */
  signIn: {
    /** The deploy's GitHub OAuth app (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET); the values an admin sets on /admin/auth win while set. */
    app: AppValues;
    /** GitHub's origin (the tests' stand-in for it; its API is api.github.com, or the stand-in's /api). */
    github: string;
    /** An install's server: erga.dev's control Worker, whose GitHub callback (the App's one) relays the sign-in here (server/source/github.ts); null elsewhere. */
    relay: string | null;
    /** Local development: the login signed in without GitHub; null elsewhere. */
    devLogin: string | null;
    /** What encrypts the secrets admins store (sign-in's secret, the API keys); null where the server can't keep them. */
    encryptionKey: string | null;
  };
  /** Erga's own repository (server/source), where this server hosts it; null where it doesn't. */
  source: SourceService | null;
  /** The deploys, as the admin agent's dashboard asks them: the pipeline's object (the control Worker's, over its binding, on erga.dev). */
  deploys: DashboardDeploys;
  /**
   * The control Worker (control/), where the repository, the Ops page and the deploys live, when it's apart from
   * this server: its address. The app sends admins there for those pages, and answers their routes with a redirect.
   * Absent in local development and on a server /deploy made, where this server hosts them itself.
   */
  control?: { url: string };
  /** The admins' agents (server/admin/agent.ts), one object per server. */
  adminAgent: AdminAgentObject;
  /** The agents' settings as they are now: the Anthropic key an admin stored, else the deploy's; or why there's none. Read at each turn. */
  agentSettings(): Promise<AgentConfig | { missing: string }>;
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
  /** Documents' sites on their person's Cloudflare account, as `origin`'s server, where the platform has them. */
  sites?(origin: string): SiteOps;
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
    snapshot(doc: Route): Promise<{ index: string; files: Record<string, string | Uint8Array> } | null>;
    /** A document's versions and the current one; null if it has no host. */
    versions(doc: Route, opts: { before?: string | null; limit?: number }): Promise<VersionsState | null>;
    /** Brings a version back as a new current version, by `by`. The caller checks the person may edit. */
    restore(doc: Route, ref: string, by: string, path?: string | null): Promise<RestoreResult>;
    exists(doc: Route): Promise<boolean>;
    /** Deletes a document (its host takes it out of the directory too); false if it had no host. */
    delete(doc: Route): Promise<boolean>;
    /** `owner`'s documents, most recently changed first. */
    list(owner: string): Promise<Listed[]>;
    /** Hands a request to the document's host, its path already the one inside the document. */
    fetch(doc: Route, request: Request): Promise<Response>;
    /**
     * A viewer's page, in one call to the document's host (document/document.ts, view): what `who` may do (`anyone`:
     * the front page), which file the address `page` is, the version viewers see, and the file's text unless the caller
     * has that version (`have`). Null if there's no such document. Asks the database nothing.
     */
    view(id: string, who: Who | null, opts: { page: string; anyone?: boolean; have?: string | null }): Promise<ViewAnswer | null>;
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
