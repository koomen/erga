import type { DocHost } from "./doc-host";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named by its id. */
  DOCS: DurableObjectNamespace<DocHost>;
  /** The server's database: users, settings and the directory of documents (directory.ts, users.ts, config.ts; migrations/). */
  DB: D1Database;
  /** The editor's own files (page.html as editor.html, page.js, style.css, fonts). */
  ASSETS: Fetcher;
  /**
   * The bootstrap admins, GitHub logins, comma-separated: always admins and
   * always allowed to sign in (users.ts). Everyone else who may sign in is a
   * row in the users table, added by an admin.
   */
  ADMINS: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Signs session cookies. */
  SESSION_SECRET: string;
  ANTHROPIC_API_KEY: string;
  /** Local development only: sign in as this login without GitHub (honoured only on localhost). */
  DEV_LOGIN?: string;
  /** "script" for the test suite's scripted agent; unset on erga.dev. */
  ERGA_AGENT_MODEL?: string;
  /** Local development only: what the dev server (dev/plugin.ts) proves itself with to link files on disk. */
  ERGA_LINK_SECRET?: string;
  /** Local development only: how long after an edit the room writes it (tests shorten it). */
  ERGA_WRITE_DELAY_MS?: string;
}
