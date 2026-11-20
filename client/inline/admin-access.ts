// The Access page's script (/admin/access, server/admin/access.ts): the group rules (add one, change its access, remove
// one), and everyone else: Anyone's level, and whether users can share publicly. Each menu and the switch save as they
// change, with no Save button (client/common/autosave.ts): the save mark left of the buttons' bar says how far it is;
// refused, the value stays, with the server's reason under it.

import { runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { autosave } from "../common/autosave";
import { liveList, refresh } from "../common/live-rows";

export default function adminAccess(): void {
  const mark = saveMark();
  const publicHint = document.getElementById("public-hint")!;
  const everyone = document.querySelector<HTMLElement>("section.everyone ol")!;
  /**
   * Anyone's level (its row comes again when it changes elsewhere). With No access the server turns public sharing off
   * too: the switch shows it at once, and its row comes again from the server when the save ends.
   */
  const wireAnyone = (li: HTMLElement) => {
    const select = li.querySelector<HTMLSelectElement>("select")!;
    mark.set("access:anyone", "saved");
    const auto = autosave({
      mark,
      key: "access:anyone",
      label: "Access for anyone",
      row: li,
      read: () => select.value,
      saved: select.value,
      save: (value) => runTool("set_access", { action: "anyone", level: value }),
      ended(why) {
        say(publicHint, why ?? "", !!why);
        select.toggleAttribute("aria-invalid", !!why);
        void refresh("setting:public_sharing");
      },
    });
    select.addEventListener("change", () => {
      const box = everyone.querySelector<HTMLInputElement>("#public-sharing");
      if (box && select.value == "none") {
        box.checked = false;
        box.disabled = true;
        box.closest("li")!.classList.add("off");
        box.closest("li")!.querySelector(".state")!.textContent = "Off";
      }
      auto.changed(true);
    });
  };
  /** The switch for sharing publicly (its row comes again when it changes elsewhere). */
  const wirePublic = (li: HTMLElement) => {
    const publicBox = li.querySelector<HTMLInputElement>("input")!;
    const state = li.querySelector(".state");
    const shown = () => {
      if (state) state.textContent = publicBox.checked ? "On" : "Off";
    };
    mark.set("access:public", "saved");
    const auto = autosave({
      mark,
      key: "access:public",
      label: "Public sharing",
      row: li,
      read: () => String(publicBox.checked),
      saved: String(publicBox.checked),
      save: (value) => runTool("set_access", { action: "public", on: value == "true" }),
      ended(why) {
        say(publicHint, why ?? "", !!why);
        publicBox.toggleAttribute("aria-invalid", !!why);
      },
    });
    publicBox.addEventListener("change", () => {
      if (
        publicBox.checked &&
        auto.saved == "false" &&
        !confirm(
          "Let users share content publicly? Documents already shared with anyone with the link will open again, for people who aren't signed in too."
        )
      )
        publicBox.checked = false;
      shown();
      auto.changed(true);
    });
  };
  const rulesHint = document.getElementById("rules-hint")!,
    // There only where the server's sign-in gives groups.
    ruleForm = document.querySelector<HTMLFormElement>("form.add-rule");
  const field = (name: string) => ruleForm!.elements.namedItem(name) as HTMLInputElement;
  ruleForm?.querySelector<HTMLSelectElement>('select[name="kind"]')?.addEventListener("change", () => {
    const kind = field("kind") as unknown as HTMLSelectElement;
    field("value").placeholder = kind.selectedOptions[0]?.dataset.placeholder ?? "";
    field("value").setAttribute("list", "suggest-" + kind.value);
  });
  ruleForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(rulesHint, "Adding…");
    try {
      const rule = await runTool("set_access", {
        action: "add",
        kind: field("kind").value,
        value: field("value").value.trim(),
        access: field("access").value,
      });
      say(rulesHint, "");
      field("value").value = "";
      refresh(`rule:${rule.kind}:${rule.value}`);
    } catch (err) {
      say(rulesHint, (err as Error).message, true);
    }
  });
  /** A rule's row: its access, and Remove. */
  function wire(li: HTMLElement) {
    const select = li.querySelector<HTMLSelectElement>("select.access")!,
      live = li.dataset.live!;
    mark.set(live, "saved");
    const auto = autosave({
      mark,
      key: live,
      label: select.getAttribute("aria-label") ?? "Access",
      row: li,
      read: () => select.value,
      saved: select.value,
      save: (value) => runTool("set_access", { action: "change", id: Number(li.dataset.id), access: value }),
      ended(why) {
        say(rulesHint, why ?? "", !!why);
        select.toggleAttribute("aria-invalid", !!why);
      },
    });
    select.addEventListener("change", () => auto.changed(true));
    li.querySelector(".remove-rule")?.addEventListener("click", async () => {
      if (!confirm("Remove this rule? The people only it lets in can't sign in any more.")) return;
      try {
        await runTool("set_access", { action: "remove", id: Number(li.dataset.id) });
        refresh(li.dataset.live!);
      } catch (err) {
        say(rulesHint, (err as Error).message, true);
      }
    });
  }
  const rules = document.querySelector<HTMLElement>("ol.rules")!;
  for (const li of rules.querySelectorAll<HTMLElement>(":scope > li")) wire(li);
  /** A row of Everyone else: Anyone's menu, or the switch. */
  const wireSetting = (li: HTMLElement) => (li.querySelector("select") ? wireAnyone(li) : wirePublic(li));
  for (const li of everyone.querySelectorAll<HTMLElement>(":scope > [data-live]")) wireSetting(li);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  const signal = window.ergaView?.signal;
  liveList(rules, { wire }, signal);
  liveList(everyone, { wire: wireSetting }, signal);
}
