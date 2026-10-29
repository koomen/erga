// The tokens page's script (/tokens, /settings: server/identity/tokens-page.ts): times in the reader's own language and
// zone, a question before a revoke, and the document picker's scope.

import { runTool } from "../common/tools";
import times from "./times";

export default function tokens(): void {
  times();
  for (const t of document.querySelectorAll<HTMLTimeElement>("time.day"))
    t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-confirm]"))
    f.addEventListener("submit", (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  // Revoke is the operation revoke_token, as an agent's is; the page follows.
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-label]"))
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!confirm("Revoke “" + f.dataset.label + "”? Agents using it lose access at once.")) return;
      try {
        await runTool("revoke_token", { id: (f.elements.namedItem("id") as HTMLInputElement).value });
        location.reload();
      } catch (err) {
        alert((err as Error).message);
      }
    });
  // Picking a document picks the one-document scope.
  const pick = document.querySelector(".doc-pick"),
    one = document.querySelector<HTMLInputElement>("input[name=scope][value=document]");
  pick?.addEventListener("change", () => {
    if (one && !one.disabled) one.checked = true;
  });
}
