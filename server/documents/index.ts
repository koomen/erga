// The app for documents: a document's address resolved and its access checked, the
// request passed on to the document; the pages origin and its tokens; new documents, the
// list, delete and share; the homepage's document. The rest of the app imports documents
// through this file.

export { forwarded, documentRoutes } from "./routes.ts";
export { forgetDecisions } from "./view.ts";
export { landingDocument } from "./landing.ts";
export { makeDoc, startingFiles } from "./make.ts";
export { isPagesSite, pagesHost, pagesOrigin, pagesToken, readPagesClaims, readPagesToken } from "./pages-origin.ts";
