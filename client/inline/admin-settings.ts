// The Settings page's script (/admin, server/admin/settings.ts): a switch or a choice saves as soon as it changes; for
// the rest, Save lights up once the value differs from what's saved. Each is checked by the server, which says what's
// wrong.

import { runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";
import { esc } from "../../shared/html";

export interface SettingsConfig {
  /** A users setting's chip, for the login LOGIN (server/admin/settings.ts, chip). */
  chip: string;
}

export default function adminSettings(c: SettingsConfig): void {
  const chipHtml = c.chip;
  /** A setting's row: its control, Save and Reset. */
  function wire(li: HTMLElement) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      mode = li.querySelector<HTMLSelectElement>("select.mode"),
      save = li.querySelector<HTMLButtonElement>(".save"),
      reset = li.querySelector(".reset"),
      hint = li.querySelector(".hint")!;
    if (input.disabled) return;
    const instant = li.dataset.control == "switch" || li.dataset.control == "choice";
    const state = () => (mode ? mode.value + ":" : "") + (input.type == "checkbox" ? input.checked : input.value);
    const was = state();
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
    const hintNow = () => (li.isConnected ? hint : (document.querySelector(`[data-live="${CSS.escape(li.dataset.live!)}"] .hint`) ?? hint));
    /** Sends the value shown; true once the server has it. */
    const submit = async (): Promise<boolean> => {
      say(hint, "Saving…");
      try {
        const key = li.dataset.key!;
        let value: unknown;
        try {
          value = JSON.parse(asJson());
        } catch {
          throw new Error(`${key} needs a value as JSON (a number, true or false, "text" in quotes...).`);
        }
        await runTool("set_setting", { key, value });
        say(hintNow(), "Saved.");
        return true;
      } catch (err) {
        say(hintNow(), (err as Error).message, true);
        return false;
      }
    };
    const shown = () => {
      if (input.type == "checkbox") li.querySelector(".state")!.textContent = input.checked ? "On" : "Off";
    };
    // A switch or a choice: one save at a time. A change during a save sends the newest value after it, so the server
    // ends with the last one shown; a refused one puts back the value the server has.
    let saved = was,
      saving = false;
    const sync = async () => {
      if (saving || state() == saved) return;
      saving = true;
      const sent = state();
      if (await submit()) saved = sent;
      else if (input.type == "checkbox") {
        input.checked = saved == "true";
        shown();
      }
      saving = false;
      if (state() != saved) return sync();
      refresh(li.dataset.live!);
    };
    const dirty = () => {
      shown();
      if (instant) return void sync();
      save!.disabled = state() == was;
      say(hint, "");
    };
    input.addEventListener("input", dirty);
    input.addEventListener("change", dirty);
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
      dirty();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!instant)
        void submit().then((ok) => {
          if (ok) void refresh(li.dataset.live!);
        });
    });
    reset?.addEventListener("click", async () => {
      say(hint, "Saving…");
      try {
        await runTool("set_setting", { key: li.dataset.key!, reset: true });
        say(hint, "Saved.");
        refresh(li.dataset.live!);
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
  }
  const list = document.querySelector<HTMLElement>("ol[data-live-kind=setting]")!;
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li.setting")) wire(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made; a setting being typed in waits (client/common/live-rows.ts).
  // (The Sites row has no control: nothing to wire.)
  liveList(list, { wire: (row) => (row.matches(".setting") && wire(row), times()) }, window.ergaView?.signal);
}
