// The viewer's post-frame behaviour on a document's page (server/pages/viewer.ts): one cached module for the bars,
// page navigation, the Document LLM API, the band and canvas, full screen, zoom, going into the editor, comments,
// the pages tree and live reloads.

import { isMac } from "../common/app-keys";
import { mountBars } from "../common/bars";
import { newDocPicker } from "../common/new-doc";
import { llmFetch, type LlmOp } from "../common/page-llm";
import { mountBand } from "./band";
import { mountComment, type Commenter } from "./comment";
import { mountEditBoot } from "./edit-boot";
import { mountFull } from "./full";
import { viewerLive } from "./live";
import { mountNav } from "./nav";
import { mountTree } from "./tree";
import { mountZoom } from "./zoom";

export interface ViewerConfig {
  edit?: { scripts: string[]; built: Record<string, string> };
  commenter?: Commenter;
  tree?: { script: string; address: string; query: string };
}

function mountViewerBars(): void {
  const toggle = mountBars(document, document.body);
  // The bar's menu is the editor's too (client/shell/sharing.ts).
  window.ergaAgentMenu = toggle.agentMenu;
  addEventListener("message", (e) => {
    if (ergaFrames.from(e) && e.data?.type == "erga-pointer" && e.data.tap === true) toggle(false);
  });
  // Print (⌘P; Ctrl+P off a Mac): the page in the frame prints itself, whole and without Erga's bars (reader.ts).
  addEventListener("keydown", (e) => {
    if (!(isMac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() != "p") return;
    e.preventDefault();
    ergaFrames.send({ type: "erga-print" });
  });
  addEventListener("blur", () => {
    if (!document.body.classList.contains("erga-editing")) toggle(false);
  });
}

function mountLlm(doc: string): void {
  // Signed out: the page's token, for a page whose owner lets all viewers call its model.
  const token = document.querySelector<HTMLMetaElement>('meta[name="erga-llm-token"]')?.content || undefined;
  addEventListener("message", async (e) => {
    if (!ergaFrames.from(e) || e.data?.type != "erga-llm" || typeof e.data.id != "number") return;
    const { id, op } = e.data as { id: number; op: unknown };
    if (op != "status" && op != "ask" && op != "sign-in") return;
    const answer = await llmFetch(doc, { ...e.data, op } as LlmOp, ergaPageAddress() + location.search + location.hash, token);
    ergaFrames.send({ type: "erga-llm-answer", id, answer });
  });
}

const el = document.getElementById("erga-viewer");
const config: ViewerConfig = el?.dataset.config ? JSON.parse(el.dataset.config) : {};
const docId = document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')?.content ?? "";

newDocPicker(document);
mountViewerBars();
mountNav();
mountLlm(docId);
mountBand();
mountFull();
mountZoom();
if (config.edit) mountEditBoot(config.edit.scripts, config.edit.built);
if (config.commenter) mountComment(`/d/${docId}`, config.commenter);
if (config.tree) mountTree(config.tree.script, docId, config.tree.address, config.tree.query);
if (document.querySelector('meta[name="erga-ver"]')) viewerLive(`/d/${docId}`);
// If the page in the frame was up before this module loaded, ask it to send its band, canvas, seat, head and zoom state again.
ergaFrames.send({ type: "erga-sync" });
