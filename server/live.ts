// Open pages across a redeploy, the server's side (the page's side is
// client/live/live.ts):
//
//   - GET /api/release: the address of each of the editor's files, as the client
//     build named them by their content's hash (client/build.ts, manifest.json),
//     and the release ({ files: { "page.js": "/_erga/main-<hash>.js", ... },
//     version, assets: the whole manifest, which the control Worker names the
//     files from });
//   - every HTML page of the site's own gets live.js, and a meta erga-build:
//     a digest of the page's inline scripts (and the scripts it names), so a
//     page can tell when the server now makes it with other code;
//   - a GET of a page with X-Erga-Check: build answers 204 with that digest
//     (X-Erga-Build), and no page.
//
// A document's pages origin never gets any of it.

import type { Platform } from "./platform.ts";
import { assetManifest, scriptTag } from "./pages/index.ts";
import { hex, sha256 } from "../shared/bytes.ts";

export const CHECK_HEADER = "x-erga-check";
export const BUILD_HEADER = "x-erga-build";

/** This isolate's start, made at its first request (a Worker may not make random numbers as it loads): the release where the deploy names none (local development: a restart is a new release). */
let boot = "";

/** GET /api/release: the files' addresses, and the release (the deploy's version, ERGA_VERSION). */
export function releaseApi(platform: Platform): Response {
  const assets = assetManifest();
  // (Without the editor's shell, the largest part, which only the app's own document pages put in: shared/assets.ts.)
  return Response.json({ files: assets?.files ?? {}, version: platform.deploy.version ?? `boot-${boot ||= crypto.randomUUID().slice(0, 8)}`, assets: assets && { ...assets, shell: undefined } }, { headers: { "Cache-Control": "no-store" } });
}

/** The digest of a page's code: its inline scripts and the scripts it loads, in order (not its text or data). */
export async function pageBuild(html: string): Promise<string> {
  let code = "";
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1];
    code += src ? `\u0000src:${src}` : `\u0000${m[2]}`;
  }
  return hex((await sha256(code)).slice(0, 8));
}

/** A page of the site's own, with live.js and its build; or, asked with X-Erga-Check, only its build. */
export async function withLive(response: Response, request: Request): Promise<Response> {
  if (response.status != 200 || !/^text\/html\b/i.test(response.headers.get("content-type") ?? "") || !response.body) return response;
  const html = await response.text();
  const build = await pageBuild(html);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set(BUILD_HEADER, build);
  if (request.headers.get(CHECK_HEADER) == "build") return new Response(null, { status: 204, headers });
  const tag = `<meta name="erga-build" content="${build}">${scriptTag("live.js")}`;
  const at = html.lastIndexOf("</body>") >= 0 ? html.lastIndexOf("</body>") : html.lastIndexOf("</html>");
  return new Response(at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag, { status: response.status, statusText: response.statusText, headers });
}
