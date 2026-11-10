/// <reference types="vite/client" />
// The repo's landing project (assets/landing/), as the Worker carries it. A module of its own, which the platform
// loads when the server makes the homepage (cloudflare/platform.ts): the Worker starts without it.

import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";

/**
 * The repo's landing project, the homepage the server makes for
 * itself: its text files as they are, and its fonts
 * and images as bytes (Vite inlines them as data: URLs, decoded here).
 */
export const LANDING: Record<string, string | Uint8Array> = {};
const landingFile = (path: string, file: string | Uint8Array) => {
  const rel = path.replace(/^\.\.\/assets\/landing\//, "");
  if (!rel.split("/").some((part) => part.startsWith("."))) LANDING[rel] = file;
};
// (Vite wants each glob written out.)
for (const [path, text] of Object.entries(
  import.meta.glob(["../assets/landing/**", "!../assets/landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
))
  landingFile(path, text);
for (const [path, url] of Object.entries(
  import.meta.glob("../assets/landing/**/*.{woff2,woff,ttf,otf,png,jpg,jpeg,gif,webp,avif,ico}", {
    query: "?inline",
    import: "default",
    eager: true,
  }) as Record<string, string>
)) {
  landingFile(path, Result.getOrThrow(Base64.decode(url.slice(url.indexOf(",") + 1))));
}
