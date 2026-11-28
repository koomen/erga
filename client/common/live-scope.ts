// Pure scoping decisions for live file refreshes in a multi-page document (client/viewer/live.ts,
// client/inline/reader.ts, client/common/page-files.ts, libs/text/ui/frame.ts): decides whether a set of changed
// document paths affects the page currently open in a tab, or can be skipped without reloading.

/** Whether a document path is a page file (.html, .htm, .md) whose edits do not affect other open pages. */
export const isPageDoc = (path: string): boolean => /\.(html?|md)$/i.test(path);

/** Normalizes `<meta name="erga-page">` to a document-relative file path ("" means the root index.html). */
export const normalizePagePath = (raw: string | null | undefined): string => raw?.replace(/^\/+/, "") || "index.html";

/**
 * Whether a PerformanceResourceTiming `initiatorType` represents a static page dependency (script, stylesheet, image,
 * media, frame) rather than a runtime data request (`fetch`, `xmlhttprequest`, `beacon`) owned by page JavaScript.
 */
export function isStaticResourceInitiator(initiatorType: string | undefined | null): boolean {
  const t = (initiatorType ?? "").toLowerCase();
  return t != "fetch" && t != "xmlhttprequest" && t != "beacon";
}

/**
 * Computes the list of document paths whose content digest changed between `prev` and `next` (added, changed, or
 * removed). Returns `null` when either snapshot is unavailable, so callers fall back conservatively.
 */
export function diffDigests(
  prev: Readonly<Record<string, string>> | null | undefined,
  next: Readonly<Record<string, string>> | null | undefined
): string[] | null {
  if (!prev || !next) return null;
  const changed: string[] = [];
  for (const [p, d] of Object.entries(next)) if (prev[p] !== d) changed.push(p);
  for (const p of Object.keys(prev)) if (!(p in next)) changed.push(p);
  return changed;
}

/** What a viewer tab should do for a set of changed paths (`null`: unknown diff, e.g. reconnect without digests or >100 files). */
export type ScopeAction =
  | { action: "skip" }
  | { action: "reload" }
  | { action: "patch"; assets: string[] }
  | { action: "check"; paths: string[] };

/**
 * Decides how a viewer tab showing `currentPage` reacts to `paths` changed in the document:
 * - `null` (unknown diff): reload conservatively.
 * - `currentPage` itself changed: patch in place (and also check any accompanying non-HTML assets).
 * - Only other HTML/Markdown page files changed: skip (no reload, no writer pill).
 * - Non-page files (CSS, JS, images, data) changed: ask the iframe whether the open page uses any of them.
 */
export function scopeViewPaths(currentPage: string, paths: readonly string[] | null): ScopeAction {
  if (paths == null) return { action: "reload" };
  const page = normalizePagePath(currentPage);
  let pageChanged = false;
  const assets: string[] = [];
  for (const p of paths) {
    if (isPageDoc(p)) {
      if (p == page) pageChanged = true;
    } else assets.push(p);
  }
  if (pageChanged) return { action: "patch", assets };
  return assets.length ? { action: "check", paths: assets } : { action: "skip" };
}

/**
 * Extracts a document-relative file path from a resource URL `href` resolved against `baseHref` on `origin`.
 * Handles both unversioned (`/t/<token>/<path>`) and versioned (`/t/<token>/@<ver>/<path>`) prefixes.
 */
export function extractDocPath(href: string, origin: string, prefix: string, baseHref: string): string | null {
  try {
    const u = new URL(href, baseHref);
    const tokenPrefix = prefix.replace(/@[^/]+\/$/, "");
    if (u.origin != origin || !u.pathname.startsWith(tokenPrefix)) return null;
    const rest = u.pathname.slice(tokenPrefix.length).replace(/^@[^/]+\//, "");
    return rest ? decodeURIComponent(rest) : null;
  } catch {
    return null;
  }
}

/** Extracts candidate URLs from an HTML `srcset` attribute. */
export function parseSrcset(srcset: string): string[] {
  return srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/** What a page should do for changed non-HTML assets, given the set of static document files the page uses. */
export type AssetAction =
  | { action: "skip"; dataPaths?: string[] }
  | { action: "restyle"; paths: string[]; dataPaths?: string[] }
  | { action: "reload" };

/**
 * Filters changed non-HTML paths to those statically used by the open page (unless the browser's resource timing
 * buffer overflowed without an observer, in which case all changed paths are conservatively treated as relevant).
 * Runtime-fetched paths (e.g. `fetch("plans.json")`) are excluded from reloads and returned in `dataPaths` so the
 * page can receive a non-reloading `erga-files-changed` event.
 */
export function usedChangedPaths(
  changed: readonly string[],
  used: ReadonlySet<string>,
  overflow: boolean,
  fetched?: ReadonlySet<string>
): AssetAction {
  const relevant = overflow ? [...changed] : changed.filter((p) => used.has(p));
  const dataPaths = !overflow && fetched ? changed.filter((p) => !used.has(p) && fetched.has(p)) : [];
  if (!relevant.length) return dataPaths.length ? { action: "skip", dataPaths } : { action: "skip" };
  if (relevant.every((p) => /\.css$/i.test(p)))
    return dataPaths.length ? { action: "restyle", paths: relevant, dataPaths } : { action: "restyle", paths: relevant };
  return { action: "reload" };
}
