// The users, a section of the Access page (/admin/access; client/inline/admin-users.ts makes its changes).

import { type Identity, type Person, ROLE_LABEL, type User, USER_ROLES, type UserRole } from "../directory/index.ts";
import { ICON } from "../pages/index.ts";
import { dateTag, esc } from "../../shared/html.ts";
import { providerName, SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { avatarHtml } from "./parts.ts";

/** A role's select: the three roles. */
function roleSelect(now: UserRole, label: string, fixed = ""): string {
  return `<select class="role" aria-label="Role for ${esc(label)}"${fixed ? ` disabled title="${esc(fixed)}"` : ""}>${USER_ROLES.map((r) => `<option value="${r}"${r == now ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>`;
}

/** A user's own role: admin, or their own access. None: an account that came in through a group or Anyone, which has no row here. */
const ownRole = (u: User): UserRole | null => (u.role == "admin" ? "admin" : u.access);
/** What Remove does, on its button. */
const REMOVE_TIP = "Remove: their groups decide their access";

/**
 * What a user signs in with: their provider's account, the handle only where it isn't the login. One with no identity
 * (a bootstrap admin's, or one from before identities) signs in by its login, where a provider here has logins.
 */
const accountOf = (u: User, ids: Identity[], providers: readonly string[]) =>
  (ids.length
    ? ids
    : providers
        .filter((p) => SIGN_IN_PROVIDERS[p]?.handle == "login")
        .slice(0, 1)
        .map((provider) => ({ provider, handle: u.login }))
  )
    .map((i) => `${providerName(i.provider)}${i.handle && i.handle.toLowerCase() != u.login ? ` ${i.handle}` : ""}`)
    .join(", ");

/** What the Add user form's field asks for, by the provider's kind of handle. */
const handlePlaceholder = (provider: string) =>
  SIGN_IN_PROVIDERS[provider]?.handle == "login" ? `a ${providerName(provider)} login` : "someone@example.com";

/** Never seen: a dash in the column. */
const NEVER = `<time class="seen never" title="Never signed in">—</time>`;

function userRow(u: User, role: UserRole, ids: Identity[], session: Session, lastAdmin: boolean, providers: readonly string[]): string {
  const me = u.login == session.login.toLowerCase();
  const joined = u.created ? ` · Joined ${dateTag(u.created, "joined")}` : "";
  const seen = u.lastSeen != null ? dateTag(u.lastSeen, "seen") : NEVER;
  const added = u.bootstrap ? "Admin by the dev server" : u.addedBy ? `Added by ${byLine(u.addedBy, u.addedVia)}` : "";
  // The same reason keeps them from being removed.
  const fixed = u.bootstrap
    ? "The dev server's own admin (DEV_LOGIN)"
    : lastAdmin
      ? `${me ? "You're" : "The"} last admin: make someone else an admin first`
      : "";
  return `  <li data-login="${esc(u.login)}" data-live="user:${esc(u.login)}" data-sort="${esc(u.login)}">
    <div class="who">${avatarHtml(u.login, u.avatar)}<span class="name"><span class="title">${esc(u.login)}</span>${u.name && u.name.toLowerCase() != u.login ? `<span class="note">${esc(u.name)}</span>` : ""}${me ? `<span class="badge">you</span>` : ""}</span><span class="added"${u.bootstrap ? ` title="DEV_LOGIN"` : ""}>${esc([accountOf(u, ids, providers), added].filter(Boolean).join(" · "))}${joined}</span></div>
    ${seen}
    ${roleSelect(role, u.login, fixed)}
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${esc(fixed || REMOVE_TIP)}"${fixed ? " disabled" : ""}>${ICON.delete}</button>
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
    <button type="button" class="act remove" aria-label="Remove ${esc(label)}" title="${REMOVE_TIP}">${ICON.delete}</button>
  </li>`;
}

/**
 * The users, on the Access page (/admin/access): every account with a role of its own and everyone waiting for their
 * first sign-in, each with one role; add one, remove one (client/inline/admin-users.ts). An account that came in
 * through a group or through Anyone has no row.
 */
export async function usersSection(platform: Platform, session: Session): Promise<string> {
  const who = whoOf(session),
    dir = platform.directory;
  const [users, people, ids] = await Promise.all([dir.users.list(who), dir.people.list(who), dir.identities.byLogin()]);
  const admins = users.filter((u) => u.role == "admin");
  return `<section class="users-section" aria-labelledby="users-head">
    <h3 class="sub-head" id="users-head">Users</h3>
    <p class="lede">Grant access to specific users</p>
    <form class="add-user">
      <select name="provider" aria-label="Provider">${dir.providers.map((p) => `<option value="${esc(p)}" data-placeholder="${esc(handlePlaceholder(p))}">${esc(providerName(p))}</option>`).join("")}</select>
      <input class="input" name="handle" placeholder="${esc(handlePlaceholder(dir.providers[0] ?? ""))}" aria-label="The account's login or email" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" required>
      <select name="role" aria-label="Role">${USER_ROLES.map((r) => `<option value="${r}"${r == "write" ? " selected" : ""}>${esc(ROLE_LABEL[r])}</option>`).join("")}</select>
      <button class="new">Add user</button>
    </form>
    <p class="hint" id="users-hint" role="status"></p>
    <div class="labels" aria-hidden="true"><span>User</span><span class="t seen">Last seen</span><span>Role</span><span></span></div>
    <ol class="rows users" data-live-kind="user person" data-live-view="users" data-live-order="asc" data-live-at="${Date.now()}">
${users.flatMap((u) => (ownRole(u) ? [userRow(u, ownRole(u)!, ids.get(u.login) ?? [], session, u.role == "admin" && admins.length == 1, dir.providers)] : [])).join("\n")}
${people.map(personRow).join("\n")}
    </ol>
  </section>`;
}

/** The users' rows on /admin/access that `keys` name ("user:<login>", "person:<id>"), as they are now, for an open page (server/news/). */
export const usersRows: LiveRows = async (platform, session, keys) => {
  const who = whoOf(session),
    dir = platform.directory;
  const [users, people, ids] = await Promise.all([dir.users.list(who), dir.people.list(who), dir.identities.byLogin()]);
  const admins = users.filter((u) => u.role == "admin");
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const u of users) {
    const role = ownRole(u);
    // (One with no role of its own keeps null: its row goes.)
    if (role && `user:${u.login}` in out)
      out[`user:${u.login}`] = {
        html: userRow(u, role, ids.get(u.login) ?? [], session, u.role == "admin" && admins.length == 1, dir.providers),
        sort: u.login,
      };
  }
  for (const p of people) if (`person:${p.id}` in out) out[`person:${p.id}`] = { html: personRow(p), sort: personSort(p) };
  return out;
};
