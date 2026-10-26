// Erga's source page's script (/git, control/source/public.ts): times in the reader's own language and zone, and Copy
// for the clone command.

import times from "./times";

export default function source(): void {
  times();
  const copy = document.getElementById("copy");
  copy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("clone")!.textContent!);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    } catch {}
  });
}
