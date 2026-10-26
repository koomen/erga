// Text and values put into HTML that the server or a script writes.

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text as HTML: safe in an element's text and in an attribute's value, quoted either way. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** A value as JSON, for inside a <script> element: no "<" in it can end the element. */
export const jsonInScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/** A time as a <time> element that shows its UTC date ("2026-10-26"); TIMES_SCRIPT redoes it in the reader's zone. */
export const dateTag = (t: number, cls = "") => `<time${cls ? ` class="${cls}"` : ""} datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>`;
