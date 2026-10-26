// The Users page's script (/admin/users, server/admin/users.ts): add a user, change a role or the deploy role, remove one.
// Each change goes to the server, which checks it (admins only, and never the last admin); the page reloads to show the
// list as it is now.

import { post, reload, say } from "../common/admin-post";

export interface UsersConfig {
  /** The signed-in admin's login, in lower case. */
  me: string;
  /** Where the changes go: POST /admin/users. */
  action: string;
}

export default function adminUsers(c: UsersConfig): void {
  const { me, action } = c;
  const hint = document.getElementById("users-hint")!,
    addForm = document.querySelector<HTMLFormElement>("form.add-user")!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => addForm.elements.namedItem(name) as unknown as T;
  async function change(fields: Record<string, string>, saying: string, undo?: () => void) {
    say(hint, saying);
    try {
      const answer = await post(action, fields);
      if (answer.note) {
        say(hint, answer.note);
        undo?.();
      } else reload();
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
      { do: "add", provider: provider.value, handle: field("handle").value.trim(), role: field<HTMLSelectElement>("role").value },
      "Adding…"
    );
  });
  for (const li of document.querySelectorAll<HTMLElement>("ol.users > li")) {
    const login = li.dataset.login,
      person = li.dataset.person,
      role = li.querySelector<HTMLSelectElement>("select.role")!,
      deploy = li.querySelector<HTMLInputElement>("input.deploy"),
      remove = li.querySelector(".remove")!;
    const whom: Record<string, string> = login ? { login } : { person: person! };
    let was = role.value;
    role.addEventListener("change", () => {
      const undo = () => {
        role.value = was;
      };
      if (login == me && was == "admin" && !confirm("Stop being an admin? You won't see the admin pages any more.")) return undo();
      change({ do: "role", ...whom, role: role.value }, "Saving…", undo);
    });
    deploy?.addEventListener("change", () =>
      change({ do: "deploy", login: login!, deploy: deploy.checked ? "1" : "0" }, "Saving…", () => {
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
      change({ do: "remove", ...whom }, "Removing…");
    });
  }
}
