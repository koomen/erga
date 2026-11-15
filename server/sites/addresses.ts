// A published document is a site: its files say how it answers each address.
//
//   index.html            /
//   about.html            /about (and /about.html)
//   blog/index.html       /blog/ (/blog redirects there, so the page's relative links work)
//   img/a.png             /img/a.png
//   404.html              any address the site has nothing for (status 404)
//   _redirects            one rule a line: `/from /to [status]`; a `*` at the end of /from matches the rest,
//                         which :splat in /to repeats. The status is 301 (the default), 302, 303, 307 or 308.
//
// _redirects is the site's setting, never served. These functions only decide: serve.ts serves.

import * as Schema from "effect/Schema";

/** A rule of _redirects. */
const Redirect = Schema.Struct({ from: Schema.String, to: Schema.String, status: Schema.Number });
type Redirect = typeof Redirect.Type;

/** What a publish reads of the site's files (kept with the snapshot: publishing.ts). */
export const Addresses = Schema.Struct({ redirects: Schema.Array(Redirect) });
export type Addresses = typeof Addresses.Type;

export const REDIRECTS = "_redirects",
  NOT_FOUND = "404.html";
const STATUSES = new Set([301, 302, 303, 307, 308]);

/** The rules of _redirects (its text, or null). A line it can't read counts as not there. */
export function addressesOf(text: string | null): Addresses {
  const redirects: Redirect[] = [];
  for (const line of (text ?? "").split(/\r?\n/)) {
    const [from, to, code] = line.replace(/#.*/, "").trim().split(/\s+/);
    const status = code ? Number(code) : 301;
    if (from?.startsWith("/") && to && STATUSES.has(status)) redirects.push({ from, to, status });
  }
  return { redirects };
}

/** Where a rule of _redirects sends `path` (with the request's `search` when the rule has none), or null. */
export function redirectOf(site: Addresses, path: string, search: string): { to: string; status: number } | null {
  for (const r of site.redirects) {
    let to: string | null = null;
    if (r.from.endsWith("*")) {
      const stem = r.from.slice(0, -1);
      if (path.startsWith(stem)) to = r.to.replace(":splat", path.slice(stem.length));
    } else if (path == r.from || path == `${r.from}/`) to = r.to;
    if (to != null) return { to: to.includes("?") ? to : to + search, status: r.status };
  }
  return null;
}

/**
 * The file an address is, or the address to go to instead (a folder without its slash); null if the site has neither.
 * `has`: whether the site has a file.
 */
export function fileOf(has: (path: string) => boolean, path: string): { file: string } | { slash: string } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.split("/").some((p) => p == ".." || p == ".") || rel == REDIRECTS) return null;
  const at = (file: string) => (has(file) ? { file } : null);
  if (rel == "" || rel.endsWith("/")) return at(`${rel}index.html`);
  return at(rel) ?? at(`${rel}.html`) ?? (has(`${rel}/index.html`) ? { slash: `${path}/` } : null);
}
