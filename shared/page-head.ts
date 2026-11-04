// A page's head: what every web page says about itself outside its text. Its title (the browser's tab, a search
// result, a link's preview), its description, its icon (the tab's) and the picture a link to it shows (og:image).
// They live in the page's own <head>, as any web page has them: the agent edits them there, and the page's
// details (client/pages/page-head.ts) and the set_head tool rewrite those tags. The viewer puts them on its own
// page too (server/pages/viewer.ts), since the page itself is in a frame, and the homepage serves the page's own.

import { esc } from "./html.ts";

export interface PageHead {
  title?: string;
  description?: string;
  /** The tab's icon: a file of the document (relative to the page) or a URL. */
  icon?: string;
  /** The picture a link to the page shows: a file of the document (relative to the page) or a URL. */
  image?: string;
}

export const HEAD_FIELDS = ["title", "description", "icon", "image"] as const;
export type HeadField = (typeof HEAD_FIELDS)[number];

/** Each field's tag: how it's found in the head, and written. */
const TAGS: Record<
  HeadField,
  { find: RegExp; is?: (attrs: Record<string, string>) => boolean; value?: string; write: (v: string) => string }
> = {
  title: { find: /<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi, write: (v) => `<title>${esc(v)}</title>` },
  description: {
    find: /<meta\b[^>]*>/gi,
    is: (a) => a.name?.toLowerCase() == "description",
    value: "content",
    write: (v) => `<meta name="description" content="${esc(v)}">`,
  },
  icon: {
    find: /<link\b[^>]*>/gi,
    is: (a) => (a.rel ?? "").toLowerCase().split(/\s+/).includes("icon"),
    value: "href",
    write: (v) => `<link rel="icon" href="${esc(v)}">`,
  },
  image: {
    find: /<meta\b[^>]*>/gi,
    is: (a) => a.property?.toLowerCase() == "og:image",
    value: "content",
    write: (v) => `<meta property="og:image" content="${esc(v)}">`,
  },
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] == "#"
      ? String.fromCodePoint(parseInt(/^#x/i.test(e) ? e.slice(2) : e.slice(1), /^#x/i.test(e) ? 16 : 10))
      : (ENTITIES[e.toLowerCase()] ?? m)
  );

/** A tag's attributes, by lower-case name, decoded. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // (The first match is the tag's name.)
  for (const m of [...tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].slice(1))
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** Where the head's tags are: from after <head> (or the start) to </head>, or <body>, or the end. */
function headRange(html: string): { from: number; to: number } {
  const open = /<head\b[^>]*>/i.exec(html);
  const from = open ? open.index + open[0].length : 0;
  const rest = html.slice(from);
  const end = rest.search(/<\/head\s*>|<body[\s>]/i);
  return { from, to: end < 0 ? html.length : from + end };
}

/** The field's tag in the head: where it is and its value; null if it has none. */
function find(html: string, field: HeadField): { at: number; end: number; value: string } | null {
  const { from, to } = headRange(html);
  const t = TAGS[field];
  for (const m of html.slice(from, to).matchAll(t.find)) {
    if (field == "title") return { at: from + m.index, end: from + m.index + m[0].length, value: decode(m[1].replace(/\s+/g, " ").trim()) };
    const attrs = attrsOf(m[0]);
    if (t.is!(attrs)) return { at: from + m.index, end: from + m.index + m[0].length, value: (attrs[t.value!] ?? "").trim() };
  }
  return null;
}

/** The page's head, as its tags say: only the fields it has, each trimmed (an empty one is left out). */
export function headOf(html: string): PageHead {
  const out: PageHead = {};
  for (const f of HEAD_FIELDS) {
    const v = find(html, f)?.value;
    if (v) out[f] = v;
  }
  return out;
}

/**
 * The page with its head changed: each field given is set ("" removes its tag), the others stay as they are. A new
 * tag goes after the head's last of these, else after its <meta charset>, else first in it, on its own line with the
 * head's indent. A page with no <head> gets one.
 */
export function withHead(html: string, changes: PageHead): string {
  for (const f of HEAD_FIELDS) {
    const v = changes[f];
    if (v == null) continue;
    const value = v.replace(/\s+/g, " ").trim();
    const had = find(html, f);
    if (had) {
      if (had.value == value && value) continue;
      if (value) html = html.slice(0, had.at) + TAGS[f].write(value) + html.slice(had.end);
      else {
        // The tag goes, with its line if it had one alone.
        const lineStart = html.lastIndexOf("\n", had.at - 1);
        const alone = /^[ \t]*$/.test(html.slice(lineStart + 1, had.at)) && /^[ \t]*(\r?\n|$)/.test(html.slice(had.end));
        html = alone
          ? html.slice(0, lineStart < 0 ? 0 : lineStart) + html.slice(had.end).replace(/^[ \t]*/, "")
          : html.slice(0, had.at) + html.slice(had.end);
      }
      continue;
    }
    if (!value) continue;
    html = insert(html, TAGS[f].write(value));
  }
  return html;
}

/** A tag put into the head, on a line of its own. */
function insert(html: string, tag: string): string {
  if (!/<head\b[^>]*>/i.test(html)) {
    // No head: one right after <html> (or the doctype, or at the very start).
    const at = /<html\b[^>]*>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
    const i = at ? at.index + at[0].length : 0;
    return `${html.slice(0, i)}${i ? "\n" : ""}<head>\n${tag}\n</head>${i ? "" : "\n"}${html.slice(i)}`;
  }
  const { from, to } = headRange(html);
  const head = html.slice(from, to);
  const indent = /\n([ \t]*)</.exec(head)?.[1] ?? "";
  // After the last of the fields' tags, else <meta charset>, else first.
  const last = HEAD_FIELDS.map((f) => find(html, f)?.end ?? -1).reduce((a, b) => Math.max(a, b), -1);
  const charset = /<meta\b[^>]*\bcharset\b[^>]*>/i.exec(head);
  const after = last >= 0 ? last : charset ? from + charset.index + charset[0].length : from;
  return `${html.slice(0, after)}\n${indent}${tag}${after == from && !head.startsWith("\n") ? "\n" : ""}${html.slice(after)}`;
}

/** The tab's title for a page: its own <title>, unless it has none (or a blank page's "Untitled"); else `fallback`. */
export const tabTitle = (head: PageHead, fallback: string) =>
  head.title && head.title.toLowerCase() != "untitled" ? head.title : fallback;

/**
 * A head's file or URL as an address the viewer's page can load: a URL (http, https; data: for a picture) as it is,
 * a path relative to the page `file` under `files` (the document's files, ending in "/"). Null if it's neither.
 */
export function headUrl(value: string, file: string, files: string): string | null {
  if (/^data:image\//i.test(value)) return value;
  let u: URL;
  try {
    u = new URL(value, `https://page.invalid/${file}`);
  } catch {
    return null;
  }
  if (u.host == "page.invalid") return files + u.pathname.slice(1) + u.search;
  return u.protocol == "https:" || u.protocol == "http:" ? u.href : null;
}
