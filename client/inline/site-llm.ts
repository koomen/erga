// The page's model (window.ergaLLM: client/common/page-llm.ts) on a published site's pages, which run on the domain
// itself (server/sites/render.ts): it calls Erga directly, for the published document `doc`, with the page's `token`
// (server/sites/llm-token.ts), so a visitor signed out may call it too. On the Erga domain, signing in comes back to
// the document in the viewer (`address`): someone signed in never sees / (it sends them to /documents). On a custom
// domain, Erga's paths are under `base` ("/_erga"), and signing in comes back to the same page.

import { llmFetch, makeErgaLLM } from "../common/page-llm";

export default function siteLlm(doc: string, token: string, address: string, base = ""): void {
  const back = () => (base ? location.pathname + location.search : address) + location.hash;
  window.ergaLLM = makeErgaLLM((op) => llmFetch(doc, op, back(), token, base));
}
