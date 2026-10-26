// The Settings page's script (/admin, server/admin/settings.ts): a switch or a choice saves as soon as it changes; for
// the rest, Save lights up once the value differs from what's saved. Each is checked by the server, which says what's
// wrong.

import { post, reload, say } from "../common/admin-post";
import { esc } from "../../shared/html";

export interface SettingsConfig {
  /** A users setting's chip, for the login LOGIN (server/admin/settings.ts, chip). */
  chip: string;
}

/** A document or project the search found (GET /admin/documents). */
interface Found {
  title: string;
  address: string;
  owner: string;
  kind: string;
}

export default function adminSettings(c: SettingsConfig): void {
  const chipHtml = c.chip;
  for (const li of document.querySelectorAll<HTMLElement>("li.setting")) {
    const form = li.querySelector("form")!,
      input = form.elements.namedItem("value") as HTMLInputElement,
      mode = li.querySelector<HTMLSelectElement>("select.mode"),
      save = li.querySelector<HTMLButtonElement>(".save"),
      reset = li.querySelector(".reset"),
      hint = li.querySelector(".hint")!;
    if (input.disabled) continue;
    const instant = li.dataset.control == "switch" || li.dataset.control == "choice" || li.dataset.control == "document";
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
          : kind == "document"
            ? v == ""
              ? "null"
              : JSON.stringify(v)
            : v;
    };
    const submit = async () => {
      say(hint, "Saving…");
      try {
        await post(form.action, { key: li.dataset.key!, value: asJson() });
        reload();
      } catch (err) {
        say(hint, (err as Error).message, true);
        if (input.type == "checkbox") {
          input.checked = !input.checked;
          li.querySelector(".state")!.textContent = input.checked ? "On" : "Off";
        }
      }
    };
    const dirty = () => {
      if (input.type == "checkbox") li.querySelector(".state")!.textContent = input.checked ? "On" : "Off";
      if (instant) {
        if (state() != was) submit();
        return;
      }
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
    // A document setting: find as you type, among all the server's documents and projects; choosing one saves it.
    const find = li.querySelector<HTMLInputElement>("input.find");
    if (find) {
      const list = li.querySelector<HTMLElement>(".found")!;
      let found: Found[] = [],
        at = -1,
        asked = 0,
        timer: ReturnType<typeof setTimeout> | undefined;
      const open = (on: boolean) => {
        list.hidden = !on;
        find.setAttribute("aria-expanded", String(on));
        if (!on) {
          at = -1;
          find.removeAttribute("aria-activedescendant");
        }
      };
      const mark = (i: number) => {
        at = i;
        list.querySelectorAll("[role=option]").forEach((o, j) => o.setAttribute("aria-selected", String(j == i)));
        const o = list.children[i];
        if (o?.id) {
          find.setAttribute("aria-activedescendant", o.id);
          o.scrollIntoView({ block: "nearest" });
        }
      };
      const show = () => {
        list.innerHTML = found.length
          ? found
              .map(
                (d, i) =>
                  '<li role="option" id="' +
                  li.dataset.key +
                  "-opt-" +
                  i +
                  '" aria-selected="false" data-i="' +
                  i +
                  '">' +
                  '<span class="title">' +
                  esc(String(d.title || d.address)) +
                  '</span><span class="badge">' +
                  (d.kind == "project" ? "Project" : "Document") +
                  "</span>" +
                  '<span class="where">' +
                  esc(String(d.owner)) +
                  " · " +
                  esc(String(d.address)) +
                  "</span></li>"
              )
              .join("")
          : '<li class="none">Nothing matches.</li>';
        open(true);
      };
      const search = async () => {
        const n = ++asked,
          url = new URL(li.dataset.search!, location.href);
        url.searchParams.set("q", find.value);
        try {
          const r = await fetch(url, { headers: { Accept: "application/json" } });
          const body = await r.json();
          if (n != asked) return;
          if (!r.ok) throw new Error(body.error || "The search didn't work.");
          found = body.found;
          show();
        } catch (err) {
          if (n == asked) say(hint, (err as Error).message, true);
        }
      };
      const choose = (i: number) => {
        const d = found[i];
        if (!d) return;
        input.value = d.address;
        find.value = d.title || d.address;
        open(false);
        submit();
      };
      find.addEventListener("input", () => {
        say(hint, "");
        clearTimeout(timer);
        timer = setTimeout(search, 150);
      });
      find.addEventListener("focus", () => {
        if (list.hidden) search();
      });
      find.addEventListener("keydown", (e) => {
        if (e.key == "ArrowDown" || e.key == "ArrowUp") {
          e.preventDefault();
          if (list.hidden) {
            search();
            return;
          }
          if (found.length) mark((at + (e.key == "ArrowDown" ? 1 : found.length - 1)) % found.length);
        } else if (e.key == "Enter") {
          e.preventDefault();
          if (!list.hidden && at >= 0) choose(at);
        } else if (e.key == "Escape" && !list.hidden) {
          e.preventDefault();
          open(false);
        }
      });
      // mousedown, not click: the box keeps its focus, so it doesn't close first.
      list.addEventListener("mousedown", (e) => {
        const o = (e.target as Element).closest<HTMLElement>("[role=option]");
        if (o) {
          e.preventDefault();
          choose(Number(o.dataset.i));
        }
      });
      find.addEventListener("blur", () => open(false));
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
      if (!instant) submit();
    });
    reset?.addEventListener("click", async () => {
      say(hint, "Saving…");
      try {
        await post(form.action, { key: li.dataset.key!, reset: "1" });
        reload();
      } catch (err) {
        say(hint, (err as Error).message, true);
      }
    });
  }
}
