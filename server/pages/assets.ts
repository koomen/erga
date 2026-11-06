// The editor's own files, as the pages the server makes name them. The client
// build (client/build.ts) names each file by its content's hash, under
// /_erga/, and lists them in .build/manifest.json (shared/assets.ts); the
// server reads that list before it answers (app.ts: loadAssets), and the
// pages take each file's address from here.
//
// Where a deploy named the release, the list is read once for the isolate:
// its files never change under it. In local development the client is built
// again under a running server, so it is read for each request.

import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { call, ctx, fromWeb } from "../http.ts";
import { ASSET_PREFIX, type AssetManifest } from "../../shared/assets.ts";
import type { Platform } from "../platform.ts";
import type { ReaderConfig } from "../../shared/page-html.ts";

let manifest: AssetManifest | null = null;
/** Read for the isolate, once (a deployed release). */
let settled = false;

/** The files' list, from now on (tests). */
export function useAssets(m: AssetManifest | null): void {
  manifest = m;
}

/** Reads the build's list of files (the Worker's static assets: manifest.json), if it hasn't for good already. */
export async function loadAssets(platform: Platform, url: URL): Promise<void> {
  if (settled) return;
  const r = await platform.assets(new Request(new URL("/manifest.json", url))).catch(() => null);
  const m = r?.ok ? await r.json().catch(() => null) as AssetManifest | null : (await r?.body?.cancel(), null);
  if (m?.files) useAssets(m);
  else if (!manifest) console.error("erga: the client isn't built (no manifest.json in the static assets): run bun run build");
  settled = !!m?.files && !!platform.deploy.version;
}

/** The list as read: GET /api/release gives it out. */
export const assetManifest = () => manifest;

/** A path of the hashed files. */
export const isAssetPath = (path: string) => path.startsWith(ASSET_PREFIX);

/** A file's address, by its name ("page.js", "style.css", "editor.html"...). */
export const asset = (name: string) => manifest?.files[name] ?? `${ASSET_PREFIX}${name}`;

/** A script's address and the chunks it imports first (to preload with it), by the script's name. */
export const assetScripts = (name: string) => [asset(name), ...(manifest?.deps[name] ?? [])];

/** A script, as a module (deferred, as modules are). */
export const scriptTag = (name: string) => `<script type="module" src="${asset(name)}"></script>`;

/**
 * The app's typeface (Inter) for a page: its @font-face rules in the page itself, so nothing waits for a stylesheet,
 * each with font-display: swap (the text shows at once in a system font). `preload`: the Latin face is fetched with the page.
 */
export function fontTags(preload = false): string {
  if (!manifest) return "";
  return `${preload ? `<link rel="preload" as="font" type="font/woff2" crossorigin href="${manifest.fonts.preload}">` : ""}<style id="erga-fonts">${manifest.fonts.css}</style>`;
}

/** The editor's shell (client/editor.html, as the build split it): its styles and its controls, for a document's page. */
export const editorShell = () => manifest?.shell ?? { style: "", body: "" };

/** The app's stylesheet. */
export const styleTag = () => `<link rel="stylesheet" href="${asset("style.css")}">`;

/**
 * Erga's editing libraries (libs/<name>/ui), each at one address, /erga/<name>/editor.js, which is always its newest
 * build: a page loads the library from there (Erga adds erga/text to a page that names none: pages/reader.ts). By the
 * library's name, its build's script.
 */
const LIBRARIES: Record<string, string> = { text: "frame.js", steps: "steps.js" };

/** The library a path names (/erga/<name>/editor.js), if Erga has one by that name. */
export const libraryOf = (path: string) => {
  const name = /^\/erga\/([a-z]+)\/editor\.js$/.exec(path)?.[1];
  return name && LIBRARIES[name] ? name : null;
};

/**
 * A library's address: one line that imports its newest build (its chunks are named by their content's hash, kept for
 * a year). Asked for again each time (no-cache): a page always loads the newest. Loadable from any document's origin.
 */
export const serveLibrary = (name: string) => {
  const file = manifest?.files[LIBRARIES[name]] ?? `${ASSET_PREFIX}${LIBRARIES[name]}`;
  const body = `import ${JSON.stringify(file)};\n`;
  return HttpServerResponse.text(body, {
    contentType: "text/javascript; charset=utf-8",
    headers: {
      "Cache-Control": "no-cache",
      ETag: `"${file.replace(/[^\w.-]/g, "")}"`,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

/**
 * The editor's half for a document's own page (pages/reader.ts), at the app's origin `shell`: its address, its chunks,
 * Erga's page tools (tools.js) and theirs, and the integrity of every script they may load, which an editor's page gives the browser (an import map), so a script
 * that isn't this build's doesn't run there.
 */
export function frameScripts(shell: string): NonNullable<ReaderConfig["editor"]> {
  const at = (u: string) => `${shell}${u}`;
  const m = manifest;
  const script = (name: string) => {
    const src = m?.files[name] ?? `${ASSET_PREFIX}${name}`;
    return { src: at(src), integrity: m?.integrity[src] ?? "", preload: (m?.deps[name] ?? []).map(at) };
  };
  // erga/text, at its one address (serveLibrary); its build and chunks, preloaded with it and pinned by the map.
  const text = script("frame.js");
  return {
    src: at("/erga/text/editor.js"),
    integrity: "",
    preload: [text.src, ...text.preload],
    map: Object.fromEntries((m?.frame ?? []).filter((u) => m?.integrity[u]).map((u) => [at(u), m!.integrity[u]])),
    tools: script("tools.js"),
  };
}

/**
 * A hashed file, as the Worker serves it (it runs first for every path: cloudflare.config.ts): kept for a year, loadable
 * from a document's own origin; a missing one never kept, whatever headers the static assets gave it (the build's _headers).
 */
export const serveAsset = Effect.gen(function* () {
  const { request, platform } = yield* ctx;
  const r = yield* call(() => platform.assets(request));
  return HttpServerResponse.setHeaders(
    fromWeb(r),
    r.ok || r.status == 304
      ? {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "X-Content-Type-Options": "nosniff",
        }
      : { "Cache-Control": "no-store" }
  );
});
