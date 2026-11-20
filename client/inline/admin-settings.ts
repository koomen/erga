// The script of the admin pages' setting rows (server/admin/settings.ts: each page has those of what it governs): each
// setting saves by itself, with no Save button
// (client/common/autosave.ts): a switch or a choice as soon as it changes, a typed value when the typing pauses or the
// focus leaves its field; a radio (the Sign-in page's usernames) as soon as another option is chosen. The save mark left
// of the buttons' bar says how far it is. The server checks each value: a refused one stays in its field, with the
// server's reason under it and the mark's red x, until it changes.

import { runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { autosave } from "../common/autosave";
import { changed as changedRow, liveList, refresh } from "../common/live-rows";
import times from "./times";
import { esc } from "../../shared/html";

export interface SettingsConfig {
  /** A users setting's chip, for the login LOGIN (server/admin/settings.ts, chip). */
  chip: string;
}

export default function adminSettings(c: SettingsConfig): void {
  const chipHtml = c.chip;
  const mark = saveMark();
  /** A setting that is a radio (data-control="radio"): the option chosen saves at once. */
  function wireRadio(li: HTMLElement) {
    const live = li.dataset.live!,
      options = [...li.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    const chosen = () => options.find((o) => o.checked)?.value ?? "";
    mark.set(live, "saved");
    const auto = autosave({
      mark,
      key: live,
      label: li.querySelector(".key")!.textContent!.trim(),
      row: li,
      read: chosen,
      saved: chosen(),
      save: (value) => runTool("set_setting", { key: li.dataset.key!, value }),
      // (The row as the server has it now comes again: who set it, and each option's state.)
      ended(why) {
        say(document.querySelector(`[data-live="${CSS.escape(live)}"] .hint`) ?? li.querySelector(".hint")!, why ?? "", !!why);
        if (!why) void changedRow(live);
      },
    });
    for (const o of options) o.addEventListener("change", () => auto.changed(true));
  }
  /** A setting's row: its control, which saves by itself, and Reset. */
  function wire(li: HTMLElement) {
    if (li.dataset.control == "radio") return wireRadio(li);
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      mode = li.querySelector<HTMLSelectElement>("select.mode"),
      reset = li.querySelector(".reset"),
      hint = li.querySelector(".hint")!,
      key = li.dataset.key!,
      live = li.dataset.live!,
      label = li.querySelector(".key")!.textContent!.trim();
    // (The row as the server has it now: what an older row of this key was saving, or failed to save, counts no more.)
    mark.set(live, "saved");
    if (input.disabled) return;
    const instant = li.dataset.control == "switch" || li.dataset.control == "choice";
    const state = () => (mode ? mode.value + ":" : "") + (input.type == "checkbox" ? input.checked : input.value);
    const asJson = () => {
      const kind = input.dataset.kind,
        v = input.value.trim();
      if (mode && mode.value == "never") return "null";
      if (kind == "switch") return String(input.checked);
      if (kind == "switch-text") return JSON.stringify(input.checked ? "on" : "off");
      return kind == "number" || kind == "number-or-never"
        ? v == ""
          ? ""
          : String(Number(v))
        : kind == "string"
          ? JSON.stringify(input.value)
          : v;
    };
    /** The row's hint: this one's, or the one of the row that took its place meanwhile (live-rows: a change heard). */
    const hintNow = () => (li.isConnected ? hint : (document.querySelector(`[data-live="${CSS.escape(live)}"] .hint`) ?? hint));
    const shown = () => {
      if (input.type == "checkbox") li.querySelector(".state")!.textContent = input.checked ? "On" : "Off";
    };
    /** How the last save ended: the reason under the field, or none; saved, the row as the server has it now. */
    const ended = (why: string | null) => {
      say(hintNow(), why ?? "", !!why);
      input.toggleAttribute("aria-invalid", !!why);
      // (A row with the focus in its field waits until the focus leaves it: the person types on.)
      if (!why) void changedRow(live);
    };
    const auto = autosave({
      mark,
      key: live,
      label,
      row: li,
      read: state,
      saved: state(),
      // (A number's field that is empty, or out of its range, for a moment: it waits for the focus to leave.)
      ready: () => form.checkValidity(),
      async save() {
        let value: unknown;
        try {
          value = JSON.parse(asJson());
        } catch {
          throw new Error(
            input.type == "number" ? "Type a number." : 'Type a value as JSON (a number, true or false, "text" in quotes...).'
          );
        }
        await runTool("set_setting", { key, value });
      },
      ended,
    });
    const dirty = () => {
      shown();
      auto.changed(instant);
    };
    input.addEventListener("input", dirty);
    // (The focus left the field, or Enter in it; a users setting's chips changed: at once.)
    input.addEventListener("change", () => auto.changed(true));
    input.addEventListener("blur", () => auto.changed(true));
    // A users setting: a chip for each user; picking one from the box adds it, × takes it out.
    const pick = li.querySelector<HTMLInputElement>("input.pick");
    if (pick) {
      const chips = li.querySelector(".chips")!;
      const logins = () => [...chips.querySelectorAll<HTMLElement>(".chip")].map((c) => c.dataset.login!);
      const changed = () => {
        input.value = JSON.stringify(logins());
        input.dispatchEvent(new Event("change"));
      };
      const add = () => {
        const login = pick.value.trim().replace(/^@/, "").toLowerCase();
        if (!login) return false;
        if (!logins().includes(login)) {
          chips.insertAdjacentHTML("beforeend", chipHtml.replaceAll("LOGIN", esc(login)));
          changed();
        }
        pick.value = "";
        return true;
      };
      // A login picked from the list is added at once; a typed one on Enter.
      pick.addEventListener("input", (e) => {
        const t = (e as InputEvent).inputType;
        if (t == "insertReplacementText" || !t) add();
      });
      pick.addEventListener("keydown", (e) => {
        if (e.key == "Enter") {
          e.preventDefault();
          add();
        }
      });
      chips.addEventListener("click", (e) => {
        const x = (e.target as Element).closest(".unpick");
        if (x) {
          x.closest(".chip")!.remove();
          changed();
        }
      });
      form.addEventListener("submit", () => add(), { capture: true });
    }
    // "Never" hides the number; "After" shows it again, ready to type.
    mode?.addEventListener("change", () => {
      const amount = li.querySelector<HTMLElement>(".amount")!;
      amount.hidden = mode.value == "never";
      input.required = !amount.hidden;
      if (!amount.hidden) input.focus();
      auto.changed(true);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      auto.changed(true);
    });
    const toDefault = async () => {
      mark.set(live, "saving");
      try {
        await runTool("set_setting", { key, reset: true });
        mark.set(live, "saved");
        ended(null);
        void refresh(live);
      } catch (err) {
        const why = (err as Error).message;
        say(hintNow(), why, true);
        mark.set(live, "error", { title: `${label} not reset`, detail: why }, toDefault);
      }
    };
    reset?.addEventListener("click", toDefault);
  }
  // Each list of setting rows on the page (server/admin/settings.ts, settingsList). Changes made elsewhere (another
  // admin, an agent) show here as they're made; a setting being typed in waits (client/common/live-rows.ts).
  for (const list of document.querySelectorAll<HTMLElement>("ol[data-settings]")) {
    for (const li of list.querySelectorAll<HTMLElement>(":scope > li.setting")) wire(li);
    liveList(list, { wire: (row) => (row.matches(".setting") && wire(row), times()) }, window.ergaView?.signal);
  }
}
