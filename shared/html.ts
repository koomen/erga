// Text and values put into HTML that the server, the editor or a script writes, and text read out of it. With them,
// the one escape for a regular expression.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escaper = (chars: RegExp) => (s: string) => s.replace(chars, (c) => ENTITIES[c]!);

/** Text as HTML: safe in an element's text and in an attribute's value, quoted either way. */
export const esc = escaper(/[&<>"']/g);
/** Text for a page's source, as an element's text: the quotes stay as typed. */
export const escapeHtmlText = escaper(/[&<>]/g);
/** A value for a page's source, or a model's prompt, in an attribute with double quotes: an apostrophe stays as typed. */
export const escapeAttr = escaper(/[&<>"]/g);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/**
 * Text with its character references decoded: the numbered ones, and the few named ones a title or a tag's value has
 * (&nbsp; as a plain space).
 */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] != "#") return NAMED[e.toLowerCase()] ?? m;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n <= 0x10ffff ? String.fromCodePoint(n) : m; // no character has a higher number: it stays as written
  });

/** Text as a regular expression that matches it exactly. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value as JSON, for inside a <script> element: no "<" in it can end the element. */
export const jsonInScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** A time as a <time> element that shows its UTC date ("2026-10-26"); TIMES_SCRIPT redoes it in the reader's zone. */
export const dateTag = (t: number, cls = "") =>
  `<time${cls ? ` class="${cls}"` : ""} datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>`;
