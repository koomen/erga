// The Access page's script (/admin/access, server/admin/access.ts): whether users can share content publicly, and the
// group rules: add one, change its access, remove one.

import { post, reload, say } from "../common/admin-post";

export interface AccessConfig {
  /** Where the changes go: POST /admin/access. */
  action: string;
}

export default function adminAccess(c: AccessConfig): void {
  const { action } = c;
  const publicBox = document.getElementById("public-sharing") as HTMLInputElement,
    publicHint = document.getElementById("public-hint")!;
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
    say(publicHint, "Saving…");
    try {
      await post(action, { do: "public_sharing", on: publicBox.checked ? "1" : "0" });
      say(publicHint, "Saved.");
    } catch (err) {
      publicBox.checked = !publicBox.checked;
      say(publicHint, (err as Error).message, true);
    }
  });
  const rulesHint = document.getElementById("rules-hint")!,
    ruleForm = document.querySelector<HTMLFormElement>("form.add-rule")!;
  const field = (name: string) => ruleForm.elements.namedItem(name) as HTMLInputElement;
  const PLACEHOLDER: Record<string, string> = { workspace: "example.com", github_org: "my-org" };
  field("kind").addEventListener("change", () => {
    const kind = field("kind").value;
    field("value").placeholder = PLACEHOLDER[kind];
    field("value").setAttribute("list", "suggest-" + kind);
  });
  ruleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(rulesHint, "Adding…");
    try {
      await post(action, { do: "add_rule", kind: field("kind").value, value: field("value").value.trim(), access: field("access").value });
      reload();
    } catch (err) {
      say(rulesHint, (err as Error).message, true);
    }
  });
  for (const li of document.querySelectorAll<HTMLElement>("ol.rules > li")) {
    const select = li.querySelector<HTMLSelectElement>("select.access")!;
    let was = select.value;
    select.addEventListener("change", async () => {
      say(rulesHint, "Saving…");
      try {
        await post(action, { do: "change_rule", id: li.dataset.id!, access: select.value });
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
        await post(action, { do: "remove_rule", id: li.dataset.id! });
        reload();
      } catch (err) {
        say(rulesHint, (err as Error).message, true);
      }
    });
  }
}
