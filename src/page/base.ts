/**
 * Where this document's host answers: "/d/<id>", which the front door puts
 * in the editor's page (erga-base) and a rename never changes, on erga.dev
 * and locally alike. Every request the editor makes, the WebSockets
 * included, goes under it. (Without it, the page's own address.)
 */
export const BASE = (document.querySelector<HTMLMetaElement>('meta[name="erga-base"]')?.content || location.pathname).replace(/\/+$/, "");
