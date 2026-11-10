// The "no access" page's button (server/documents/view.ts, refused): "Ask <owner> for access" runs the operation
// request_access, then says that the owner sees the request. An error shows in the same place, and the button works again.

import { runTool } from "../common/tools";

export default function askAccess(): void {
  const button = document.getElementById("ask-access") as HTMLButtonElement | null,
    note = document.getElementById("ask-note");
  if (!button || !note) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await runTool("request_access", { document: button.dataset.doc });
      button.textContent = "Asked";
      note.textContent = note.dataset.asked ?? "";
    } catch (e) {
      button.disabled = false;
      note.textContent = (e as Error).message;
    }
  });
}
