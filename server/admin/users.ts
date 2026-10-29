// /admin/users, the Users page (client/inline/admin-users.ts makes its changes).

import { type Identity, type Person, ROLE_LABEL, type User, USER_ROLES, type UserRole } from "../directory/index.ts";
import { ICON, inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { avatarHtml } from "./parts.ts";

/** The deploy role's switch: a checkbox (role="switch"); off, with why in its title, for an admin (who may always deploy). */
function deploySwitch(u: User): string {
  const fixed = u.role == "admin" ? "An admin: admins may always deploy" : "";
  return `<label class="switch" title="${esc(fixed || "Deploy: may use /deploy when deploy_page is admins")}">
      <input type="checkbox" role="switch" class="deploy" aria-label="Deploy role for ${esc(u.login)}"${u.mayDeploy ? " checked" : ""}${fixed ? " disabled" : ""}><span class="track" aria-hidden="true"></span>
    </label>`;
}

/** A role's select: the three roles, and for an account "No role" (only the groups decide). */
function roleSelect(now: UserRole | "none", label: string, o: { none?: boolean; fixed?: string } = {}): string {
  const roles: (UserRole | "none")[] = o.none ? [...USER_ROLES, "none"] : [...USER_ROLES];
  return `<select class="role" aria-label="Role for ${esc(label)}"${o.fixed ? ` disabled title="${esc(o.fixed)}"` : ""}>${roles.map((r) => `<option value="${r}"${r == now ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>`;
}

/** What a user signs in with: their GitHub or Google account (a bootstrap admin's, or one from before: its GitHub login). */
const accountOf = (u: User, ids: Identity[]) =>
  (ids.length ? ids : [{ provider: "github", handle: u.login }])
    .map((i) => `${i.provider == "github" ? "GitHub" : "Google"} ${i.handle ?? u.login}`)
    .join(", ");

function userRow(u: User, ids: Identity[], session: Session, lastAdmin: boolean): string {
  const me = u.login == session.login.toLowerCase();
  const joined = u.created ? dateTag(u.created, "joined") : `<time class="joined never">not yet</time>`;
  const seen = u.lastSeen != null ? dateTag(u.lastSeen, "seen") : `<time class="seen never">never</time>`;
  const added = u.bootstrap
    ? "Admin by the deploy (ADMINS)"
    : u.addedBy
      ? `Added by ${byLine(u.addedBy, u.addedVia)}`
      : "Made their account at their first sign-in";
  // The same reason keeps them from being removed.
  const fixed = u.bootstrap
    ? "An admin by the deploy (ADMINS): change it there"
    : lastAdmin
      ? `${me ? "You're" : "The"} last admin: make someone else an admin first`
      : "";
  const role: UserRole | "none" = u.role == "admin" ? "admin" : (u.access ?? "none");
  return `  <li data-login="${esc(u.login)}">
    <div class="who">${avatarHtml(u.login, u.avatar)}<span class="title">${esc(u.login)}</span>${u.name && u.name.toLowerCase() != u.login ? `<span class="note">${esc(u.name)}</span>` : ""}${me ? `<span class="badge">you</span>` : ""}<span class="added">${esc(`${accountOf(u, ids)} · ${added}`)}</span></div>
    ${joined}
    ${seen}
    ${roleSelect(role, u.login, { none: true, fixed })}
    ${deploySwitch(u)}
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${esc(fixed || "Remove: they can't sign in any more, unless a group lets them in")}"${fixed ? " disabled" : ""}>${ICON.delete}</button>
  </li>`;
}

/** Someone an admin added who hasn't signed in yet: their provider account and its role. */
function personRow(p: Person): string {
  const label = `${p.provider == "github" ? "GitHub" : "Google"} ${p.handle}`;
  return `  <li data-person="${p.id}" class="waiting">
    <div class="who"><span class="title handle">${esc(p.handle)}</span><span class="added">${p.provider == "github" ? "GitHub" : "Google"} account · hasn't signed in yet · Added by ${esc(byLine(p.addedBy ?? "an admin", p.addedVia))}</span></div>
    <time class="joined never">not yet</time>
    <time class="seen never">never</time>
    ${roleSelect(p.role, label)}
    <span></span>
    <button type="button" class="act remove" aria-label="Remove ${esc(label)}" title="Remove: they can't sign in, unless a group lets them in">${ICON.delete}</button>
  </li>`;
}

/** /admin/users: every user and everyone waiting for their first sign-in, each with one role; add one, remove one. */
export async function usersPage(platform: Platform, session: Session) {
  const who = whoOf(session),
    dir = platform.directory;
  const [users, people, ids] = await Promise.all([dir.users.list(who), dir.people.list(who), dir.identities.byLogin()]);
  const admins = users.filter((u) => u.role == "admin");
  return adminPage({
    session,
    title: "Users",
    here: "users",
    body: `
  <section aria-label="Users">
    <h2>Users</h2>
    <form class="add-user" method="post" action="${esc(link("/admin/users", session))}">
      <select name="provider" aria-label="Provider"><option value="github">GitHub</option><option value="google">Google</option></select>
      <input class="input" name="handle" placeholder="a GitHub login" aria-label="The GitHub login or Google email" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <select name="role" aria-label="Role">${USER_ROLES.map((r) => `<option value="${r}"${r == "write" ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>
      <button class="new">Add user</button>
    </form>
    <p class="hint" id="users-hint" role="status"></p>
    <div class="labels" aria-hidden="true"><span>User</span><span class="t">Joined</span><span class="t seen">Last seen</span><span>Role</span><span class="c">Deploy</span><span></span></div>
    <ol class="rows users">
${users.map((u) => userRow(u, ids.get(u.login) ?? [], session, u.role == "admin" && admins.length == 1)).join("\n")}
${people.map(personRow).join("\n")}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-users", { me: session.login.toLowerCase(), action: link("/admin/users", session) })}</script>`,
  });
}
