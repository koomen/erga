// A scratch document's Save (server/pages/scratch.ts), for its owner: an orange button at the start of the quick actions, in
// the viewer's bar and the editor's (its controls' template, and the controls if they are made already). Its tip says what
// it does (`tip`). A click keeps the document (save_document); saved, both buttons go, and the address bar takes the
// document's new address (the editor follows a rename by itself; the viewer doesn't). An error shows in the tip.

import { runTool } from "../common/tools";

export default function scratch(doc: string, tip: string): void {
  const make = () => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "erga-scratch-save", textContent: "Save" });
    b.dataset.tip = tip;
    b.setAttribute("aria-description", tip);
    return b;
  };
  const add = (root: ParentNode | null | undefined, bar: string) => root?.querySelector(`${bar} .quick-inner`)?.prepend(make());
  add(document, ".erga-view-buttons");
  add((document.getElementById("erga-shell") as HTMLTemplateElement | null)?.content, "#quick");
  add(document.getElementById("erga-editor"), "#quick");
  // (One listener for all: the editor's controls are made from the template later, and a copy has no listeners.)
  document.addEventListener("click", (e) => (e.target as Element | null)?.closest?.(".erga-scratch-save") && save());
  const all = () => [
    ...document.querySelectorAll<HTMLButtonElement>(".erga-scratch-save"),
    ...((document.getElementById("erga-shell") as HTMLTemplateElement | null)?.content.querySelectorAll<HTMLButtonElement>(
      ".erga-scratch-save"
    ) ?? []),
  ];
  const show = (text: string, failed: boolean) =>
    all().forEach((b) => {
      b.dataset.tip = text;
      b.classList.toggle("failed", failed);
    });
  let busy = false;
  async function save() {
    if (busy) return;
    busy = true;
    all().forEach((b) => {
      b.disabled = true;
      b.textContent = "Saving…";
    });
    const saved = await runTool<{ saved?: { address?: unknown } }>("save_document", { document: doc }).catch((e: Error) => e);
    busy = false;
    if (saved instanceof Error) {
      all().forEach((b) => {
        b.disabled = false;
        b.textContent = "Save";
      });
      show(saved.message, true);
      return;
    }
    all().forEach((b) => b.remove());
    const address = saved?.saved?.address;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="erga-address"]');
    if (typeof address == "string" && meta && !document.body.classList.contains("erga-editing")) {
      meta.content = address;
      const here = ergaPageAddress();
      if (location.pathname != here) history.replaceState(history.state, "", here + location.search + location.hash);
    }
  }
}
