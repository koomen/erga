// The front door for documents: a document's address resolved and its access checked, the
// request passed on to the document; the pages origin and its tokens; new documents, the
// list, delete and share; the front page's document. The rest of the app imports documents
// through this file.

export { forwarded, frontDoor } from "./front-door.ts";
export { landingDocument } from "./landing.ts";
export { makeDoc, startingFiles } from "./make.ts";
export { isPagesSite, pagesHost, pagesOrigin, pagesToken, readPagesClaims, readPagesToken } from "./pages-origin.ts";
