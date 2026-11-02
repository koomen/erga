// The page's model (window.ergaLLM: client/common/page-llm.ts), for every document's page (server/pages/viewer.ts): the
// page in the frame asks by postMessage (client/inline/reader.ts), and this calls Erga with the visitor's session, for
// the document this page shows (meta erga-doc), never one the frame names. The frame gets the answer, never the session.
// Signing in leaves this page on the visitor's click only, and comes back to it.

import { llmFetch, type LlmOp } from "../common/page-llm";

export default function viewerLlm(): void {
  const doc = document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')?.content ?? "";
  addEventListener("message", async (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-llm" || typeof e.data.id != "number") return;
    const { id, op } = e.data as { id: number; op: unknown };
    if (op != "status" && op != "ask" && op != "sign-in") return;
    if (op == "sign-in") {
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
      if (activation?.isActive === false) return;
    }
    const answer = await llmFetch(doc, { ...e.data, op } as LlmOp, ergaPageAddress() + location.search + location.hash);
    ergaFrames.send({ type: "erga-llm-answer", id, answer });
  });
}
