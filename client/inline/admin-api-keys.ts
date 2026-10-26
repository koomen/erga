// The API keys page's script (/admin/api-keys, server/admin/api-keys.ts): Save sets or replaces the key typed in, Clear
// removes it. The answer never holds the key; the page reloads to show what it is now.

import { post, reload, say } from "../common/admin-post";

export default function adminApiKeys(): void {
  for (const li of document.querySelectorAll<HTMLElement>("li.credential")) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      save = li.querySelector<HTMLButtonElement>(".save")!,
      clear = li.querySelector(".clear"),
      hint = li.querySelector(".hint")!;
    if (input.disabled) continue;
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
        reload();
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
        await post(form.action, { name: li.dataset.name!, clear: "1" });
        reload();
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
  }
}
