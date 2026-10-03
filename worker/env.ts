import type { DocHost } from "./doc-host";
import type { DocList } from "./doc-list";

/** The Worker's bindings (cloudflare.config.ts); secrets are set with `cf workers secrets update`. */
export interface Env {
  /** One Durable Object per document, named "<owner>/<id>". */
  DOCS: DurableObjectNamespace<DocHost>;
  /** Each person's list of their documents, named by their login (lowercase). */
  LISTS: DurableObjectNamespace<DocList>;
  /** The editor's own files (page.html as editor.html, page.js, style.css, fonts). */
  ASSETS: Fetcher;
  /** GitHub logins allowed to sign in, comma-separated. */
  ALLOWED_USERS: string;
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
