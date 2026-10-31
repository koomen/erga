// The tokens page's script (/tokens, /settings: server/identity/tokens-page.ts): times in the reader's own language and
// zone, a question before a revoke, the document picker's scope, and the tokens list, live.

import { liveList } from "../common/live-rows";
import { runTool } from "../common/tools";
import times from "./times";

export default function tokens(): void {
  /** Times in the reader's language and zone: "5 minutes ago", and an expiry's day. */
  const dates = () => {
    times();
    for (const t of document.querySelectorAll<HTMLTimeElement>("time.day"))
      t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };
  dates();
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-confirm]"))
    f.addEventListener("submit", (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  /** A token's Revoke: the operation revoke_token, as an agent's is; the row goes at once. */
  const wire = (row: HTMLElement) => {
    const f = row.querySelector<HTMLFormElement>("form[data-label]");
    f?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!confirm("Revoke “" + f.dataset.label + "”? Agents using it lose access at once.")) return;
      try {
        await runTool("revoke_token", { id: (f.elements.namedItem("id") as HTMLInputElement).value });
        row.remove();
        counted();
      } catch (err) {
        alert((err as Error).message);
      }
    });
  };
  /** The column labels and the empty list's words, as the rows are now. */
  const counted = () => {
    const n = list.querySelectorAll(":scope > li[data-live]").length;
    list.hidden = !n;
    document.querySelector<HTMLElement>(".labels")!.hidden = !n;
    document.querySelector<HTMLElement>("p.empty")!.hidden = !!n;
  };
  // Tokens made or revoked elsewhere (an agent, another tab) show here as they're made (client/common/live-rows.ts).
  const list = document.querySelector<HTMLElement>("ol.rows[data-live-kind]")!;
  for (const row of list.querySelectorAll<HTMLElement>(":scope > li[data-live]")) wire(row);
  liveList(list, { wire: (row) => (wire(row), dates()), changed: counted });
  // Picking a document picks the one-document scope.
  const pick = document.querySelector(".doc-pick"),
    one = document.querySelector<HTMLInputElement>("input[name=scope][value=document]");
  pick?.addEventListener("change", () => {
    if (one && !one.disabled) one.checked = true;
  });
}
