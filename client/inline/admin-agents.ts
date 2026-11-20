// The Agents and models page's script (/admin/agents, server/admin/agents.ts): whose keys the agents use (the list at
// the top, the agent_keys setting: the providers show only when the server provides keys); for each provider, its key:
// a key that is set shows as its last 4 characters, with Replace, which opens the box to paste another, and Remove; a
// key pasted in the box sets or replaces the key (the answer never holds the key, and the row is drawn again); and its
// models' boxes (agent_models_off: every model not ticked, on every row; and the models that were off and have no box,
// their provider with no key: they stay off). Each saves by itself, with no Save
// button (client/common/autosave.ts), and the save mark left of the buttons' bar says how far it is: refused, the value
// stays, with the server's reason under it. The daily token limit's row is a setting row: admin-settings.ts saves it,
// and it shows only when the server provides keys.

import { post, runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { autosave } from "../common/autosave";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";

/** A key is longer than this: a shorter text in its box is saved only as the focus leaves it, never in a pause of the typing. */
const KEY_LENGTH = 20;
/** The models' boxes in the save mark: one setting, on every row. */
const MODELS = "setting:agent_models_off";

export default function adminAgents(): void {
  const mark = saveMark();
  /**
   * `li` as the page has it now: a live change can draw a row again while it saves (live-rows.ts keeps its status),
   * and the answer goes to the new one.
   */
  const now = (li: HTMLElement) => list.querySelector<HTMLElement>(`:scope > [data-live="${CSS.escape(li.dataset.live!)}"]`) ?? li;
  const hintOf = (li: HTMLElement) => now(li).querySelector(".hint")!;
  /** A key's row: Replace, its box, which saves a pasted key, and Remove. */
  function wire(li: HTMLElement) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      clear = li.querySelector(".clear"),
      shown = li.querySelector<HTMLElement>(".secret-now"),
      replace = li.querySelector<HTMLElement>(".replace"),
      live = li.dataset.live!,
      label = li.dataset.label!;
    // (The row as the server has it now: what an older row of this key was saving counts no more.)
    mark.set(live, "saved");
    if (input.disabled) return;
    const arm = () =>
      autosave({
        mark,
        key: live,
        label,
        row: li,
        read: () => input.value.trim(),
        saved: "",
        ready: () => input.value.trim().length >= KEY_LENGTH,
        save: (value) => post(form.action, { name: li.dataset.name!, value }),
        ended(why) {
          say(hintOf(li), why ?? "", !!why);
          input.toggleAttribute("aria-invalid", !!why);
          // (No key in the box: the person took it out again, and nothing was saved.)
          if (why || !input.value.trim()) return;
          // Saved: the page keeps no key. The box is empty again, and the row says which key the server has.
          auto.stop();
          input.value = "";
          input.blur();
          auto = arm();
          void refresh(live);
        },
      });
    let auto = arm();
    input.addEventListener("input", () => auto.changed(false));
    input.addEventListener("change", () => auto.changed(true));
    // Replace: the box in the place of the key's last characters. Left empty (the focus leaves it, or Escape), they
    // are back.
    const closed = () => {
      if (!shown || input.value.trim()) return;
      input.hidden = true;
      shown.hidden = false;
    };
    replace?.addEventListener("click", () => {
      shown!.hidden = true;
      input.hidden = false;
      input.focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key != "Escape" || !shown) return;
      input.value = "";
      auto.changed(true);
      closed();
      replace?.focus();
    });
    input.addEventListener("blur", () => {
      auto.changed(true);
      closed();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      auto.changed(true);
    });
    const remove = async () => {
      mark.set(live, "saving");
      try {
        await runTool("clear_api_key", { name: li.dataset.name! });
        say(hintOf(li), "");
        mark.set(live, "saved");
        void refresh(live);
      } catch (err) {
        const why = (err as Error).message;
        say(hintOf(li), why, true);
        mark.set(live, "error", { title: `${label} not removed`, detail: why }, remove);
      }
    };
    clear?.addEventListener("click", () => {
      if (
        confirm(
          "Remove the " +
            label +
            "? " +
            (li.dataset.fallback
              ? "The server goes back to the deploy's " + li.dataset.env + "."
              : "What uses it stops until someone sets a key again.")
        )
      )
        void remove();
    });
  }
  const list = document.querySelector<HTMLElement>("ol[data-live-kind=apikey]")!;
  // Whose keys: saved at once; the providers show only when the server provides them.
  const mode = document.getElementById("agent-keys") as HTMLSelectElement,
    modeHint = document.getElementById("keys-mode-hint")!;
  const keys = autosave({
    mark,
    key: "setting:agent_keys",
    label: "Whose keys the agents use",
    read: () => mode.value,
    saved: mode.value,
    save: (value) => runTool("set_setting", { key: "agent_keys", value }),
    ended(why) {
      say(modeHint, why ?? "", !!why);
      mode.toggleAttribute("aria-invalid", !!why);
      if (why) return;
      for (const el of [list, document.querySelector<HTMLElement>("ol.server-only")!]) el.hidden = mode.value == "own";
      document.querySelector<HTMLElement>(".own-note")!.hidden = mode.value != "own";
    },
  });
  mode.addEventListener("change", () => keys.changed(true));
  // A model's box: the setting is every model not ticked, on any row, and the ones off that have no box (data-off: the
  // setting as the page has it). Refused, the boxes keep the person's choice.
  list.addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.matches(".models input[type=checkbox]")) return;
    const li = box.closest("li")!;
    // The box as the page has it after the answer: a row drawn again meanwhile shows the setting from before the save.
    const shown = () => now(li).querySelector<HTMLInputElement>(`.models input[value="${CSS.escape(box.value)}"]`) ?? box;
    const wanted = box.checked;
    const save = async () => {
      shown().checked = wanted;
      const boxes = [...list.querySelectorAll<HTMLInputElement>(".models input[type=checkbox]")];
      const off = [
        ...(list.dataset.off ?? "").split(" ").filter((m) => m && !boxes.some((b) => b.value == m)),
        ...boxes.filter((b) => !b.checked).map((b) => b.value),
      ];
      mark.set(MODELS, "saving");
      try {
        await runTool("set_setting", { key: "agent_models_off", value: off });
        list.dataset.off = off.join(" ");
        shown().checked = wanted;
        say(hintOf(li), "");
        mark.set(MODELS, "saved");
      } catch (err) {
        const why = (err as Error).message;
        shown().checked = wanted;
        say(hintOf(li), why, true);
        mark.set(MODELS, "error", { title: "The models are not saved", detail: `${why} The boxes keep your choice.` }, save);
      }
    };
    void save();
  });
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li.provider")) wire(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  liveList(list, { wire: (row) => (wire(row), times()) }, window.ergaView?.signal);
}
