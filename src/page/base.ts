/**
 * Where this document's host answers: its address, "/koomen/abc123" (on
 * erga.dev and locally alike). Every request the
 * editor makes, the WebSockets included, goes under it.
 */
export const BASE = location.pathname.replace(/\/+$/, "");
