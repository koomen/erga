// The API keys page's script (/admin/api-keys, server/admin/api-keys.ts): whose keys the agents use (the list at the top,
// the agent_keys setting: it saves as it changes, and the providers show only when the server provides keys); for each
// provider, Save sets or replaces the key typed in, Clear removes it (the answer never holds the key, and the row is
// drawn again), and its models' boxes save as they change (agent_models_off: every model not ticked, on every row).

import { post, runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";

export default function adminApiKeys(): void {
  /**
   * `li` as the page has it now: a live change can draw a row again while it saves (live-rows.ts keeps its status),
   * and the answer goes to the new one.
   */
  const now = (li: HTMLElement) => list.querySelector<HTMLElement>(`:scope > [data-live="${CSS.escape(li.dataset.live!)}"]`) ?? li;
  const hintOf = (li: HTMLElement) => now(li).querySelector(".hint")!;
  /** A key's row: Save, and Clear. */
  function wire(li: HTMLElement) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      save = li.querySelector<HTMLButtonElement>(".save")!,
      clear = li.querySelector(".clear");
    if (input.disabled) return;
    input.addEventListener("input", () => {
      save.disabled = !input.value.trim();
      say(hintOf(li), "");
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hintOf(li), "Saving…");
      try {
        await post(form.action, { name: li.dataset.name!, value: input.value });
        input.value = "";
        input.blur();
        refresh(li.dataset.live!);
      } catch (err) {
        say(hintOf(li), (err as Error).message, true);
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
      say(hintOf(li), "Clearing…");
      try {
        await runTool("clear_api_key", { name: li.dataset.name! });
        refresh(li.dataset.live!);
      } catch (err) {
        say(hintOf(li), (err as Error).message, true);
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
    const li = box.closest("li")!;
    const off = [...list.querySelectorAll<HTMLInputElement>(".models input[type=checkbox]")].filter((b) => !b.checked).map((b) => b.value);
    say(hintOf(li), "Saving…");
    // The box as the page has it after the answer: a row drawn again meanwhile shows the setting from before the save.
    const shown = () => now(li).querySelector<HTMLInputElement>(`.models input[value="${CSS.escape(box.value)}"]`) ?? box;
    const wanted = box.checked;
    try {
      await runTool("set_setting", { key: "agent_models_off", value: off });
      shown().checked = wanted;
      say(hintOf(li), "Saved.");
    } catch (err) {
      shown().checked = !wanted;
      say(hintOf(li), (err as Error).message, true);
    }
  });
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li.provider")) wire(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  liveList(list, { wire: (row) => (wire(row), times()) }, window.ergaView?.signal);
}
