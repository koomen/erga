// /admin/users, the Users page (client/inline/admin-users.ts makes its changes).

import { type Identity, type Person, ROLE_LABEL, type User, USER_ROLES, type UserRole } from "../directory/index.ts";
import { ICON, inlineCall, TIMES_SCRIPT } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { avatarHtml } from "./parts.ts";

/** A role's select: the three roles, and for an account "No role" (only the groups decide). */
function roleSelect(now: UserRole | "none", label: string, o: { none?: boolean; fixed?: string } = {}): string {
  const roles: (UserRole | "none")[] = o.none ? [...USER_ROLES, "none"] : [...USER_ROLES];
  return `<select class="role" aria-label="Role for ${esc(label)}"${o.fixed ? ` disabled title="${esc(o.fixed)}"` : ""}>${roles.map((r) => `<option value="${r}"${r == now ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>`;
}

/** The provider's name. */
const providerName = (provider: string) => (provider == "github" ? "GitHub" : "Google");

/** What a user signs in with: their GitHub or Google account (a bootstrap admin's, or one from before: its GitHub login), the handle only where it isn't the login. */
const accountOf = (u: User, ids: Identity[]) =>
  (ids.length ? ids : [{ provider: "github", handle: u.login }])
    .map((i) => `${providerName(i.provider)}${i.handle && i.handle.toLowerCase() != u.login ? ` ${i.handle}` : ""}`)
    .join(", ");

/** Never seen: a dash in the column. */
const NEVER = `<time class="seen never" title="Never signed in">—</time>`;

function userRow(u: User, ids: Identity[], session: Session, lastAdmin: boolean): string {
  const me = u.login == session.login.toLowerCase();
  const joined = u.created ? ` · Joined ${dateTag(u.created, "joined")}` : "";
  const seen = u.lastSeen != null ? dateTag(u.lastSeen, "seen") : NEVER;
  const added = u.bootstrap ? "Admin by the deploy" : u.addedBy ? `Added by ${byLine(u.addedBy, u.addedVia)}` : "";
  // The same reason keeps them from being removed.
  const fixed = u.bootstrap
    ? "An admin by the deploy (ADMINS): change it there"
    : lastAdmin
      ? `${me ? "You're" : "The"} last admin: make someone else an admin first`
      : "";
  const role: UserRole | "none" = u.role == "admin" ? "admin" : (u.access ?? "none");
  return `  <li data-login="${esc(u.login)}" data-live="user:${esc(u.login)}" data-sort="${esc(u.login)}">
    <div class="who">${avatarHtml(u.login, u.avatar)}<span class="name"><span class="title">${esc(u.login)}</span>${u.name && u.name.toLowerCase() != u.login ? `<span class="note">${esc(u.name)}</span>` : ""}${me ? `<span class="badge">you</span>` : ""}</span><span class="added"${u.bootstrap ? ` title="ADMINS in the deploy"` : ""}>${esc([accountOf(u, ids), added].filter(Boolean).join(" · "))}${joined}</span></div>
    ${seen}
    ${roleSelect(role, u.login, { none: true, fixed })}
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${esc(fixed || "Remove: they can't sign in any more, unless a group lets them in")}"${fixed ? " disabled" : ""}>${ICON.delete}</button>
  </li>`;
}

/** A waiting person's place: after the users (the list's order: by login, then by provider and handle). */
const personSort = (p: Person) => `~${p.provider}:${p.handle}`;

/** Someone an admin added who hasn't signed in yet: their provider account and its role. */
function personRow(p: Person): string {
  const label = `${providerName(p.provider)} ${p.handle}`;
  return `  <li data-person="${p.id}" class="waiting" data-live="person:${p.id}" data-sort="${esc(personSort(p))}">
    <div class="who"><span class="avatar waiting" aria-hidden="true"></span><span class="name"><span class="title handle">${esc(p.handle)}</span><span class="badge">invited</span></span><span class="added">${providerName(p.provider)} · Added by ${esc(byLine(p.addedBy ?? "an admin", p.addedVia))}</span></div>
    ${NEVER}
    ${roleSelect(p.role, label)}
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
    lede: "Everyone who can sign in, and the role of each. Groups are on Access.",
    body: `
  <section aria-labelledby="page-head">
    <form class="add-user">
      <select name="provider" aria-label="Provider"><option value="github">GitHub</option><option value="google">Google</option></select>
      <input class="input" name="handle" placeholder="a GitHub login" aria-label="The GitHub login or Google email" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <select name="role" aria-label="Role">${USER_ROLES.map((r) => `<option value="${r}"${r == "write" ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>
      <button class="new">Add user</button>
    </form>
    <p class="hint" id="users-hint" role="status"></p>
    <div class="labels" aria-hidden="true"><span>User</span><span class="t seen">Last seen</span><span>Role</span><span></span></div>
    <ol class="rows users" data-live-kind="user person" data-live-view="users" data-live-order="asc" data-live-at="${Date.now()}">
${users.map((u) => userRow(u, ids.get(u.login) ?? [], session, u.role == "admin" && admins.length == 1)).join("\n")}
${people.map(personRow).join("\n")}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-users", { me: session.login.toLowerCase() })}</script>`,
  });
}

/** The rows of /admin/users that `keys` name ("user:<login>", "person:<id>"), as they are now, for an open page (server/news/). */
export const usersRows: LiveRows = async (platform, session, keys) => {
  const who = whoOf(session),
    dir = platform.directory;
  const [users, people, ids] = await Promise.all([dir.users.list(who), dir.people.list(who), dir.identities.byLogin()]);
  const admins = users.filter((u) => u.role == "admin");
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const u of users)
    if (`user:${u.login}` in out)
      out[`user:${u.login}`] = {
        html: userRow(u, ids.get(u.login) ?? [], session, u.role == "admin" && admins.length == 1),
        sort: u.login,
      };
  for (const p of people) if (`person:${p.id}` in out) out[`person:${p.id}`] = { html: personRow(p), sort: personSort(p) };
  return out;
};
