// Erga's service worker (client/inline/offline-sw.ts), at /erga-sw.js on the app's origin and on a document's own
// pages origin: the editor's pages open with no connection. It's the only service worker a pages origin takes (server/app.ts):
// its address is outside the document's files (/t/<token>/...), so no file of a document can be it, or take its place.

import { HttpServerResponse } from "effect/http";
import { inlineCall, inlineFunction } from "./inline.ts";

export { CLEAR_PATH, WORKER_PATH } from "../../shared/offline.ts";

/** The worker's script: asked again on each visit (no-cache), so a new release's comes at once. */
export const serveWorker = () =>
  HttpServerResponse.text(`(${inlineFunction("offline-sw")})();\n`, {
    contentType: "text/javascript; charset=utf-8",
    headers: { "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
  });

/** The page that deletes a pages origin's offline copies, for sign-out (client/inline/offline-clear.ts). */
export const serveClear = () =>
  HttpServerResponse.text(`<!doctype html><meta charset="utf-8"><title>Erga</title><script>${inlineCall("offline-clear")}</script>`, {
    contentType: "text/html; charset=utf-8",
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
