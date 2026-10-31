// The API keys page's script (/admin/api-keys, server/admin/api-keys.ts): Save sets or replaces the key typed in, Clear
// removes it. The answer never holds the key; the page reloads to show what it is now.

import { post, runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";

export default function adminApiKeys(): void {
  /** A key's row: Save, and Clear. */
  function wire(li: HTMLElement) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      save = li.querySelector<HTMLButtonElement>(".save")!,
      clear = li.querySelector(".clear"),
      hint = li.querySelector(".hint")!;
    if (input.disabled) return;
    input.addEventListener("input", () => {
      save.disabled = !input.value.trim();
      say(hint, "");
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Saving…");
      try {
        await post(form.action, { name: li.dataset.name!, value: input.value });
        input.value = "";
        input.blur();
        refresh(li.dataset.live!);
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
    clear?.addEventListener("click", async () => {
      if (
        !confirm(
          "Clear the " +
            li.dataset.label +
            "? " +
            (li.dataset.fallback
              ? "The server goes back to the deploy's " + li.dataset.env + "."
              : "What uses it stops until someone sets a key again.")
        )
      )
        return;
      say(hint, "Clearing…");
      try {
        await runTool("clear_api_key", { name: li.dataset.name! });
        refresh(li.dataset.live!);
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
  }
  const list = document.querySelector<HTMLElement>("ol[data-live-kind]")!;
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li.credential")) wire(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  liveList(list, { wire: (row) => (wire(row), times()) }, window.ergaView?.signal);
}
