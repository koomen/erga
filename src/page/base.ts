/**
 * Where this document's host answers: "" when the editor is served at the
 * root (bun open.ts), "/koomen/abc123" on erga.dev. Every request the
 * editor makes, the WebSockets included, goes under it.
 */
export const BASE = location.pathname.replace(/\/+$/, "");
