// The editor's own files, as the pages the server makes name them. The client
// build (client/build.ts) names each file by its content's hash, under
// /_erga/, and lists them in .build/manifest.json (shared/assets.ts); the
// server reads that list before it answers (app.ts: loadAssets), and the
// pages take each file's address from here.
//
// Where a deploy named the release, the list is read once for the isolate:
// its files never change under it. In local development the client is built
// again under a running server, so it is read for each request. The control
// Worker, which has no files of its own, reads the app's (control/index.ts:
// remoteAssets) and names them at the app's origin.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { call, ctx, fromWeb } from "../http.ts";
import { ASSET_PREFIX, type AssetManifest } from "../../shared/assets.ts";
import type { Platform } from "../platform.ts";

let manifest: AssetManifest | null = null;
/** The origin the files are at, for pages served elsewhere ("" on the app's own origin). */
let origin = "";
/** Read for the isolate, once (a deployed release). */
let settled = false;
/** The control Worker's copy: when it was read. */
let remoteAt = 0;

/** The files' list, from now on (tests; the control Worker), and where they are. */
export function useAssets(m: AssetManifest | null, at = ""): void {
  manifest = m;
  origin = at.replace(/\/+$/, "");
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

/** The control Worker: the app's list of files (its GET /api/release), read again after a minute, since the app deploys on its own. */
export async function remoteAssets(app: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (Date.now() - remoteAt < 60_000) return;
  remoteAt = Date.now();
  const r = await Effect.runPromise(
    Effect.tryPromise((signal) =>
      fetcher(`${app.replace(/\/+$/, "")}/api/release`, { headers: { Accept: "application/json" }, signal })
    ).pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.orElseSucceed(() => null)
    )
  );
  const m = r?.ok ? ((await r.json().catch(() => null)) as { assets?: AssetManifest } | null)?.assets : null;
  if (m?.files) useAssets(m, app);
}

/** The list as read: GET /api/release gives it out. */
export const assetManifest = () => manifest;

/** A path of the hashed files. */
export const isAssetPath = (path: string) => path.startsWith(ASSET_PREFIX);

/** A file's address, by its name ("page.js", "style.css", "editor.html"...). */
export const asset = (name: string) => origin + (manifest?.files[name] ?? `${ASSET_PREFIX}${name}`);

/** A script's address and the chunks it imports first (to preload with it), by the script's name. */
export const assetScripts = (name: string) => [asset(name), ...(manifest?.deps[name] ?? []).map((u) => origin + u)];

/** A script, as a module (deferred, as modules are). */
export const scriptTag = (name: string) => `<script type="module" src="${asset(name)}"></script>`;

/**
 * The app's typeface (Inter) for a page: its @font-face rules in the page itself, so nothing waits for a stylesheet,
 * each with font-display: swap (the text shows at once in a system font). `preload`: the Latin face is fetched with the page.
 */
export function fontTags(preload = false): string {
  if (!manifest) return "";
  const css = origin ? manifest.fonts.css.replaceAll(`url(${ASSET_PREFIX}`, `url(${origin}${ASSET_PREFIX}`) : manifest.fonts.css;
  return `${preload ? `<link rel="preload" as="font" type="font/woff2" crossorigin href="${origin}${manifest.fonts.preload}">` : ""}<style id="erga-fonts">${css}</style>`;
}

/** The editor's shell (client/editor.html, as the build split it): its styles and its controls, for a document's page. */
export const editorShell = () => manifest?.shell ?? { style: "", body: "" };

/** The app's stylesheet. */
export const styleTag = () => `<link rel="stylesheet" href="${asset("style.css")}">`;

/**
 * The editor's half for a document's own page (pages/reader.ts), at the app's origin `shell`: its address, its chunks,
 * and the integrity of every script it may load, which an editor's page gives the browser (an import map), so a script
 * that isn't this build's doesn't run there.
 */
export function frameScripts(shell: string): { src: string; integrity: string; preload: string[]; map: Record<string, string> } {
  const at = (u: string) => `${shell}${u}`;
  const m = manifest;
  const src = m?.files["frame.js"] ?? `${ASSET_PREFIX}frame.js`;
  return {
    src: at(src),
    integrity: m?.integrity[src] ?? "",
    preload: (m?.deps["frame.js"] ?? []).map(at),
    map: Object.fromEntries((m?.frame ?? []).filter((u) => m?.integrity[u]).map((u) => [at(u), m!.integrity[u]])),
  };
}

/**
 * A hashed file, as the Worker serves it when it runs first (local development; on Cloudflare the files are served
 * without it, with _headers'): kept for a year, loadable from a document's own origin; a missing one never kept.
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
