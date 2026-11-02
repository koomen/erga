// The page's model (window.ergaLLM: client/common/page-llm.ts) on the homepage, which runs on this site itself
// (server/home/render.ts): it calls Erga directly, for the homepage's document `doc`. Someone signed in never sees /
// (it sends them to /docs), so signing in comes back to the homepage's project, /_home, where the page is in the viewer.

import { llmFetch, makeErgaLLM } from "../common/page-llm";

export default function homeLlm(doc: string): void {
  window.ergaLLM = makeErgaLLM((op) => llmFetch(doc, op, "/_home" + location.hash));
}
