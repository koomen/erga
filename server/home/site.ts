// The homepage project is a site: its files say how it answers each address.
//
//   index.html            /
//   about.html            /about (and /about.html)
//   blog/index.html       /blog/ (/blog redirects there, so the page's relative links work)
//   img/a.png             /img/a.png
//   404.html              any address the site has nothing for (status 404)
//   _redirects            one rule a line: `/from /to [status]`; a `*` at the end of /from matches the rest,
//                         which :splat in /to repeats. The status is 301 (the default), 302, 303, 307 or 308.
//   site.json             {"bars": false}: no Erga bars on / for visitors (on the Erga domain)
//
// _redirects and site.json are the site's settings, never served. These functions only decide: serve.ts serves.

/** A rule of _redirects. */
export interface Redirect {
  from: string;
  to: string;
  status: number;
}

/** What a deploy reads of the site's settings (kept with the snapshot: deploys.ts). */
export interface Site {
  bars: boolean;
  redirects: Redirect[];
}

export const REDIRECTS = "_redirects",
  SITE_JSON = "site.json",
  NOT_FOUND = "404.html";
const SETTINGS = new Set([REDIRECTS, SITE_JSON]);
const STATUSES = new Set([301, 302, 303, 307, 308]);

/** The site's settings from its files (`read`: a file's text, or null). A line or a value it can't read counts as not there. */
export async function siteOf(read: (path: string) => Promise<string | null>): Promise<Site> {
  const redirects: Redirect[] = [];
  for (const line of ((await read(REDIRECTS)) ?? "").split(/\r?\n/)) {
    const [from, to, code] = line.replace(/#.*/, "").trim().split(/\s+/);
    const status = code ? Number(code) : 301;
    if (from?.startsWith("/") && to && STATUSES.has(status)) redirects.push({ from, to, status });
  }
  let bars = true;
  try {
    bars = (JSON.parse((await read(SITE_JSON)) ?? "{}") as { bars?: unknown }).bars !== false;
  } catch {
    /* not JSON: the default */
  }
  return { bars, redirects };
}

/** Where a rule of _redirects sends `path` (with the request's `search` when the rule has none), or null. */
export function redirectOf(site: Site, path: string, search: string): { to: string; status: number } | null {
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
  if (rel.split("/").some((p) => p == ".." || p == ".") || SETTINGS.has(rel)) return null;
  const at = (file: string) => (has(file) ? { file } : null);
  if (rel == "" || rel.endsWith("/")) return at(`${rel}index.html`);
  return at(rel) ?? at(`${rel}.html`) ?? (has(`${rel}/index.html`) ? { slash: `${path}/` } : null);
}
