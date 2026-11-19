// The script of the Access page's users (/admin/access, server/admin/users.ts): add a user, change a role, remove one.
// Each change goes to the server, which checks it (admins only, and never the last admin), and the row shows it as it
// is now. A role saves as it changes, with no Save button (client/common/autosave.ts): the save mark left of the
// buttons' bar says how far it is; refused, the role stays as chosen, with the server's reason over the list.

import { runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { autosave } from "../common/autosave";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";

export interface UsersConfig {
  /** The signed-in admin's login, in lower case. */
  me: string;
}

export default function adminUsers(c: UsersConfig): void {
  const { me } = c;
  const mark = saveMark();
  const hint = document.getElementById("users-hint")!,
    addForm = document.querySelector<HTMLFormElement>("form.add-user")!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => addForm.elements.namedItem(name) as unknown as T;
  /** An operation on a user or a waiting person; their row shows it (theirs is `login` or `person` in args, else in the answer). */
  async function change(args: Record<string, unknown>, saying: string, undo?: () => void) {
    say(hint, saying);
    try {
      const answer = await runTool("set_user", args);
      if (answer.note) {
        say(hint, answer.note);
        undo?.();
      } else {
        say(hint, "");
        const login = args.login ?? answer.user?.login,
          person = args.person ?? answer.person?.person;
        refresh(...(login ? [`user:${login}`] : []), ...(person != null ? [`person:${person}`] : []));
        if (args.action == "add") field("handle").value = "";
      }
    } catch (err) {
      undo?.();
      say(hint, (err as Error).message, true);
    }
  }
  const provider = field<HTMLSelectElement>("provider");
  provider.addEventListener("change", () => {
    field("handle").placeholder = provider.selectedOptions[0]?.dataset.placeholder ?? "";
  });
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    change(
      { action: "add", provider: provider.value, handle: field("handle").value.trim(), role: field<HTMLSelectElement>("role").value },
      "Adding…"
    );
  });
  /** A user's or a waiting person's row: the role, Remove. */
  function wire(li: HTMLElement) {
    const login = li.dataset.login,
      person = li.dataset.person,
      role = li.querySelector<HTMLSelectElement>("select.role")!,
      remove = li.querySelector(".remove")!;
    const whom: Record<string, unknown> = login ? { login } : { person: Number(person) };
    const live = li.dataset.live!;
    mark.set(live, "saved");
    const auto = autosave({
      mark,
      key: live,
      label: role.getAttribute("aria-label") ?? "Role",
      row: li,
      read: () => role.value,
      saved: role.value,
      async save(value) {
        // (A note: the server left the role as it was, and says why.)
        const answer = await runTool("set_user", { action: "role", ...whom, role: value });
        if (answer.note) throw new Error(answer.note);
      },
      ended(why) {
        say(hint, why ?? "", !!why);
        role.toggleAttribute("aria-invalid", !!why);
        if (!why) void refresh(live);
      },
    });
    role.addEventListener("change", () => {
      if (login == me && auto.saved == "admin" && !confirm("Stop being an admin? You won't see the admin pages any more."))
        role.value = auto.saved;
      auto.changed(true);
    });
    remove.addEventListener("click", () => {
      if (
        !confirm(
          login == me
            ? "Remove yourself? You'll be signed out, and can't sign in again unless an admin adds you or a group lets you in."
            : "Remove " + (login || "this user") + "? They can't sign in unless a group lets them in. Their documents stay."
        )
      )
        return;
      change({ action: "remove", ...whom }, "Removing…");
    });
  }
  const list = document.querySelector<HTMLElement>("ol.users")!;
  for (const li of list.querySelectorAll<HTMLElement>(":scope > li")) wire(li);
  // Changes made elsewhere (another admin, an agent, someone's first sign-in) show here as they're made (client/common/live-rows.ts).
  liveList(list, { wire: (row) => (wire(row), times()) }, window.ergaView?.signal);
}
