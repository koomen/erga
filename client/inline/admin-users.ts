// The Users page's script (/admin/users, server/admin/users.ts): add a user, change a role or the deploy role, remove one.
// Each change goes to the server, which checks it (admins only, and never the last admin); the page reloads to show the
// list as it is now.

import { runTool, say } from "../common/admin-post";
import { liveList, refresh } from "../common/live-rows";
import times from "./times";

export interface UsersConfig {
  /** The signed-in admin's login, in lower case. */
  me: string;
}

export default function adminUsers(c: UsersConfig): void {
  const { me } = c;
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
    field("handle").placeholder = provider.value == "github" ? "a GitHub login" : "someone@gmail.com";
  });
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    change(
      { action: "add", provider: provider.value, handle: field("handle").value.trim(), role: field<HTMLSelectElement>("role").value },
      "Adding…"
    );
  });
  /** A user's or a waiting person's row: the role, the deploy role, Remove. */
  function wire(li: HTMLElement) {
    const login = li.dataset.login,
      person = li.dataset.person,
      role = li.querySelector<HTMLSelectElement>("select.role")!,
      deploy = li.querySelector<HTMLInputElement>("input.deploy"),
      remove = li.querySelector(".remove")!;
    const whom: Record<string, unknown> = login ? { login } : { person: Number(person) };
    let was = role.value;
    role.addEventListener("change", () => {
      const undo = () => {
        role.value = was;
      };
      if (login == me && was == "admin" && !confirm("Stop being an admin? You won't see the admin pages any more.")) return undo();
      change({ action: "role", ...whom, role: role.value }, "Saving…", undo);
    });
    deploy?.addEventListener("change", () =>
      change({ action: "deploy", login: login!, deploy: deploy.checked }, "Saving…", () => {
        deploy.checked = !deploy.checked;
      })
    );
    remove.addEventListener("click", () => {
      if (
        !confirm(
          login == me
            ? "Remove yourself? You'll be signed out, and can't sign in again unless an admin adds you or a group lets you in."
            : "Remove " + (login || "this person") + "? They can't sign in unless a group lets them in. Their documents stay."
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
