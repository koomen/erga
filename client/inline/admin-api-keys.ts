// The API keys page's script (/admin/api-keys, server/admin/api-keys.ts): whose keys the agents use (the list at the top,
// the agent_keys setting: it saves as it changes, and the providers show only when the server provides keys); for each
// provider, Save sets or replaces the key typed in, Clear removes it (the answer never holds the key, and the row is
// drawn again), and its models' boxes save as they change (agent_models_off: every model not ticked, on every row).

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
  const list = document.querySelector<HTMLElement>("ol[data-live-kind=apikey]")!;
  // Whose keys: saved at once; the providers show only when the server provides them.
  const mode = document.getElementById("agent-keys") as HTMLSelectElement,
    modeHint = document.getElementById("keys-mode-hint")!;
  mode.addEventListener("change", async () => {
    say(modeHint, "Saving…");
    try {
      await runTool("set_setting", { key: "agent_keys", value: mode.value });
      say(modeHint, "");
      list.hidden = mode.value == "own";
      document.querySelector<HTMLElement>(".own-note")!.hidden = mode.value != "own";
    } catch (err) {
      say(modeHint, (err as Error).message, true);
      mode.value = mode.value == "own" ? "server" : "own";
    }
  });
  // A model's box: the setting is every model not ticked, on any row.
  list.addEventListener("change", async (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.matches(".models input[type=checkbox]")) return;
    const hint = box.closest("li")!.querySelector(".hint")!;
    const off = [...list.querySelectorAll<HTMLInputElement>(".models input[type=checkbox]")].filter((b) => !b.checked).map((b) => b.value);
    say(hint, "Saving…");
    try {
      await runTool("set_setting", { key: "agent_models_off", value: off });
      say(hint, "Saved.");
    } catch (err) {
      box.checked = !box.checked;
      say(hint, (err as Error).message, true);
    }
  });
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li.provider")) wire(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  liveList(list, { wire: (row) => (wire(row), times()) }, window.ergaView?.signal);
}
