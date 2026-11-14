// Where a link on a document's page goes (docs: the Links plan). The page is in a frame on its pages origin, under a
// token (/t/<token>/), and the viewer around it is on Erga's origin (the shell). A link names a page of this document
// when it is under the token, or when it is the document's Erga address or under it (/<owner>/<slug>/<page>, on either
// origin): "page". Any other path on the pages origin is an Erga address too, written root-relative ("/docs"), and so is
// any link to the shell's origin: "erga", on Erga. Another site: "out". The viewer (client/inline/reader.ts), the
// editor (libs/text/ui/frame.ts), the copy (publicHref) and the link bar (libs/text/ui/controls.ts) read links
// with it.

import { pageUrl } from "../../document/pages";

/**
 * Where a page is: its origin, the path its document's files are under there (/t/<token>/), its own path in the
 * document, the shell's origin, and the document's public address (https://<host>/<owner>/<slug>), once the viewer
 * has said it (client/inline/reader.ts).
 */
export interface Place {
  origin: string;
  prefix: string;
  page: string;
  shell: string;
  address: string | null;
}

/** Where the page in `win` is, from the viewer's script's config; null outside a document's page. */
export function placeOf(win: Window, config: { shell: string; prefix: string; address?: string } | undefined): Place | null {
  const path = win.location.pathname;
  if (!config || !path.startsWith(config.prefix)) return null;
  const page = decode(path.slice(config.prefix.length)) ?? "";
  return { origin: win.location.origin, prefix: config.prefix, page: fileOf(page), shell: config.shell, address: config.address ?? null };
}

/**
 * page: a page of this document; `path` its path in the document as the link has it (decoded, "" for the first page),
 * `frame` its address in the frame, `public` its public address (null until the viewer has said it). Both keep the
 * link's query and hash.
 * file: another file of this document (a stylesheet, a picture): the browser follows it.
 * erga, out: an address on Erga, or on another site, to open as it is.
 * none: not a web address (mailto:, javascript:).
 */
export type LinkTarget =
  | { kind: "page"; path: string; frame: string; public: string | null }
  | { kind: "file" }
  | { kind: "erga" | "out"; url: string }
  | { kind: "none" };

export function linkTarget(url: URL, p: Place): LinkTarget {
  if (!/^https?:$/.test(url.protocol)) return { kind: "none" };
  const tail = url.search + url.hash;
  if (url.origin == p.origin && url.pathname.startsWith(p.prefix)) {
    const path = decode(url.pathname.slice(p.prefix.length));
    if (path == null) return { kind: "file" };
    return isPage(path) ? page(path, url.href, p, tail) : { kind: "file" };
  }
  if (url.origin != p.origin && url.origin != p.shell) return { kind: "out", url: url.href };
  // An Erga address, written on either origin: this document's page, or elsewhere on Erga.
  const home = p.address ? new URL(p.address).pathname.replace(/\/+$/, "") : null;
  if (home && (url.pathname == home || url.pathname.startsWith(home + "/"))) {
    const path = decode(url.pathname.slice(home.length + 1));
    if (path != null && isPage(path)) return page(path, p.origin + p.prefix + url.pathname.slice(home.length + 1) + tail, p, tail);
  }
  return { kind: "erga", url: p.shell + url.pathname + tail };
}

function page(path: string, frame: string, p: Place, tail: string): LinkTarget {
  return { kind: "page", path, frame, public: p.address ? pageUrl(p.address, fileOf(path)) + publicTail(tail) : null };
}

/** A query and hash for a page's public address: without the viewer's own parameters for the frame (?erga-edit, ?erga-keep=). */
function publicTail(tail: string): string {
  const at = tail.indexOf("#"),
    q = (at < 0 ? tail : tail.slice(0, at))
      .replace(/^\?/, "")
      .split("&")
      .filter((x) => x && !/^erga-/.test(x));
  return (q.length ? "?" + q.join("&") : "") + (at < 0 ? "" : tail.slice(at));
}

/** A page's address: an .html file, or no extension (about, blog/, the first page). */
const isPage = (path: string) => !/\.[^./]+$/.test(path) || /\.html$/i.test(path);

/** The file a page's address names: "" and "blog/" the folder's index.html, "about" about.html. */
const fileOf = (path: string) => (!path || path.endsWith("/") ? path + "index.html" : /\.[^./]+$/.test(path) ? path : path + ".html");

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * A link's address where a copy goes. The document's files have their address under a token, which opens the
 * document to whoever has it: a link to a page goes to its public address instead (a place in it, #id, too), an Erga
 * address written root-relative to the shell's origin, and a link to any other file of the document goes. Before the viewer has
 * said the address, a place in this page stays #id, and links to other pages go.
 */
export function publicHref(a: Element, p: Place | null): string | null {
  const own = a.getAttribute("href")?.trim() ?? "";
  if (!own) return null;
  let url: URL;
  try {
    url = new URL(own, a.ownerDocument.baseURI);
  } catch {
    return null;
  }
  if (!p) return own.startsWith("#") ? own : url.href;
  const t = linkTarget(url, p);
  if (t.kind == "page") return t.public ?? (fileOf(t.path) == p.page && url.hash ? url.hash : null);
  if (t.kind == "none") return own.startsWith("#") ? own : url.href;
  return t.kind == "file" ? null : t.url;
}
