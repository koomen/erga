// The Access page's script (/admin/access, server/admin/access.ts): whether users can share content publicly, and the
// group rules: add one, change its access, remove one.

import { runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";

export default function adminAccess(): void {
  const publicHint = document.getElementById("public-hint")!;
  /** The switch for sharing publicly (its row comes again when it changes elsewhere). */
  const wirePublic = (publicBox: HTMLInputElement) =>
    publicBox.addEventListener("change", async () => {
    if (
      publicBox.checked &&
      !confirm(
        "Let users share content publicly? Documents already shared with anyone with the link will open for people who aren't signed in too."
      )
    ) {
      publicBox.checked = false;
      return;
    }
    const state = publicBox.closest("li")?.querySelector(".state");
    if (state) state.textContent = publicBox.checked ? "On" : "Off";
    say(publicHint, "Saving…");
    try {
      await runTool("set_access", { action: "public", on: publicBox.checked });
      say(publicHint, "Saved.");
    } catch (err) {
      publicBox.checked = !publicBox.checked;
      if (state) state.textContent = publicBox.checked ? "On" : "Off";
      say(publicHint, (err as Error).message, true);
    }
  });
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
    const select = li.querySelector<HTMLSelectElement>("select.access")!;
    let was = select.value;
    select.addEventListener("change", async () => {
      say(rulesHint, "Saving…");
      try {
        await runTool("set_access", { action: "change", id: Number(li.dataset.id), access: select.value });
        was = select.value;
        say(rulesHint, "Saved.");
      } catch (err) {
        select.value = was;
        say(rulesHint, (err as Error).message, true);
      }
    });
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
  wirePublic(document.getElementById("public-sharing") as HTMLInputElement);
  // Changes made elsewhere (another admin, an agent) show here as they're made (client/common/live-rows.ts).
  const signal = window.ergaView?.signal;
  liveList(rules, { wire }, signal);
  liveList(
    document.querySelector<HTMLElement>("section.public-sharing ol")!,
    { wire: (row) => wirePublic(row.querySelector("input")!) },
    signal
  );
}
