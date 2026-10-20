// The editor's own files as the client build writes them (client/build.ts):
// each one under ASSET_PREFIX with its content's hash in its name, so a
// browser keeps it for a year and never asks again, and a list of them
// (the manifest, .build/manifest.json) that the server reads to name them
// in the pages it makes (server/pages/assets.ts). Shared by the build, the
// server and the browser (client/live.ts compares a page's files with the
// server's by their names).

/** Where the hashed files are, on the app's origin: the only path the Worker doesn't run first for (cloudflare.config.ts). */
export const ASSET_PREFIX = "/_erga/";

/** What the build made: the server's only source for the files' addresses. */
export interface AssetManifest {
  /** Each file by its name ("page.js", "frame.js", "style.css", "editor.html", "inter.css"): its address ("/_erga/main-1a2b3c4d.js"). */
  files: Record<string, string>;
  /** A script's static imports, all of them (the chunks it needs before it runs), by the script's name: what to preload. */
  deps: Record<string, string[]>;
  /** Every script the frame (frame.js) may load, at once or later: the integrity map its host page gives the browser. */
  frame: string[];
  /** Each script's Subresource Integrity hash ("sha384-..."), by its address. */
  integrity: Record<string, string>;
  /** The app's typeface: its @font-face rules (the font files' addresses root-relative), to put in a page's own <style>. */
  fonts: { css: string; preload: string };
  /**
   * The editor's shell (client/editor.html), which the server puts into a document's page: its styles, and its controls'
   * HTML. Not in GET /api/release's copy (server/live.ts): only the app's own Worker makes those pages.
   */
  shell?: { style: string; body: string };
}

/** A hashed file's address without its hash and extension ("/_erga/main-1a2b3c4d.js" → "/_erga/main"): the same for every build of it. */
export const stemOf = (url: string) => url.replace(/-[a-z0-9]+\.[a-z0-9]+$/i, "");
