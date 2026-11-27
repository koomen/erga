// Pure scoping decisions for live file refreshes in a multi-page document (client/viewer/live.ts,
// client/inline/reader.ts, libs/text/ui/frame.ts): decides whether a set of changed document paths affects the page
// currently open in a tab, or can be skipped without reloading.

/** Whether a document path is a page file (.html, .htm, .md) whose edits do not affect other open pages. */
export const isPageDoc = (path: string): boolean => /\.(html?|md)$/i.test(path);

/** Normalizes `<meta name="erga-page">` to a document-relative file path ("" means the root index.html). */
export const normalizePagePath = (raw: string | null | undefined): string => raw?.replace(/^\/+/, "") || "index.html";

/** What a viewer tab should do for a set of changed paths (`null`: unknown diff, e.g. reconnect or >100 files). */
export type ScopeAction = { action: "skip" } | { action: "reload" } | { action: "check"; paths: string[] };

/**
 * Decides how a viewer tab showing `currentPage` reacts to `paths` changed in the document:
 * - `null` (unknown diff): reload conservatively.
 * - `currentPage` itself changed: reload.
 * - Only other HTML/Markdown page files changed: skip (no reload, no writer pill).
 * - Non-page files (CSS, JS, images, data) changed: ask the iframe whether the open page uses any of them.
 */
export function scopeViewPaths(currentPage: string, paths: readonly string[] | null): ScopeAction {
  if (paths == null) return { action: "reload" };
  const page = normalizePagePath(currentPage);
  const assets: string[] = [];
  for (const p of paths) {
    if (isPageDoc(p)) {
      if (p == page) return { action: "reload" };
    } else assets.push(p);
  }
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

/** What a page should do for changed non-HTML assets, given the set of document files the page uses. */
export type AssetAction = { action: "skip" } | { action: "restyle"; paths: string[] } | { action: "reload" };

/**
 * Filters changed non-HTML paths to those actually used by the open page (unless the browser's resource timing
 * buffer overflowed, in which case all changed paths are conservatively treated as relevant).
 */
export function usedChangedPaths(changed: readonly string[], used: ReadonlySet<string>, overflow: boolean): AssetAction {
  const relevant = overflow ? [...changed] : changed.filter((p) => used.has(p));
  if (!relevant.length) return { action: "skip" };
  return relevant.every((p) => /\.css$/i.test(p)) ? { action: "restyle", paths: relevant } : { action: "reload" };
}
