// The tokens page's script (/tokens, /settings: server/identity/tokens-page.ts): times in the reader's own language and
// zone, a question before a revoke, and the document picker's scope.

import times from "./times";

export default function tokens(): void {
  times();
  for (const t of document.querySelectorAll<HTMLTimeElement>("time.day"))
    t.textContent = new Date(t.dateTime).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-confirm]"))
    f.addEventListener("submit", (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  for (const f of document.querySelectorAll<HTMLFormElement>("form[data-label]"))
    f.addEventListener("submit", (e) => {
      if (!confirm("Revoke “" + f.dataset.label + "”? Agents using it lose access at once.")) e.preventDefault();
    });
  // Picking a document picks the one-document scope.
  const pick = document.querySelector(".doc-pick"),
    one = document.querySelector<HTMLInputElement>("input[name=scope][value=document]");
  pick?.addEventListener("change", () => {
    if (one && !one.disabled) one.checked = true;
  });
}
