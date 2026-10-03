// The admin page: the server's settings (config.ts) and its users and
// admins (users.ts), for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
//   /admin                     the page
//   POST /admin/settings       key, and value (JSON) to set it, or reset=1 to put it back to its default
//   POST /admin/users          do=add (login, role), do=role (login, role) or do=remove (login)
//
// The POSTs answer JSON ({ entry } or { user } or { ok }, or { error } with
// the message the directory gave, for a person to act on) and come only from
// this site's pages. The directory checks who's asking itself (NotAllowed);
// this file only shows it. An agent token (Session.agent) never gets in, even
// an admin's. A setting the deploy locks is shown, read-only,
// and so is a bootstrap admin (ADMINS), who can't be demoted or removed here.

import { ConfigError, type ConfigEntry } from "./config.ts";
import { appPage, esc, ICON, link, page, type Platform, type Session, TIMES_SCRIPT, whoOf } from "./front.ts";
import { NotAllowed, type ServerRole, type User } from "./users.ts";

/** /admin and its POSTs. */
export async function adminDoor(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  if (!session && url.pathname == "/admin" && request.method == "GET") {
    return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent("/admin")}` } });
  }
  const who = session && whoOf(session);
  // Only the person themselves, in a browser: an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (await platform.directory.users.isAdmin(who));
  if (url.pathname == "/admin") {
    if (!admin || request.method != "GET") return notFound();
    return adminPage(platform, session!);
  }
  if (request.method != "POST") return notFound();
  if (!admin) return Response.json({ error: "Only an admin can do that." }, { status: session ? 403 : 401 });
  if (request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  try {
    if (url.pathname == "/admin/settings") {
      const key = field("key");
      if (form.get("reset")) return Response.json({ entry: await platform.directory.config.reset(who!, key) });
      let value: unknown;
      try { value = JSON.parse(field("value")); } catch { throw new ConfigError(`${key} needs a value as JSON (a number, true or false, "text" in quotes...).`); }
      return Response.json({ entry: await platform.directory.config.set(who!, key, value) });
    }
    const users = platform.directory.users, login = field("login"), role = field("role") as ServerRole;
    if (role && role != "user" && role != "admin") throw new NotAllowed(`"${role}" isn't a role: user or admin.`);
    switch (field("do")) {
      case "add": {
        if ((await users.get(login.trim()))?.created) throw new NotAllowed(`${login.trim().toLowerCase()} is already a user.`);
        return Response.json({ user: await users.add(who!, login, { role: role || "user" }) });
      }
      case "role": return Response.json({ user: await users.setRole(who!, login, role || "user") });
      case "remove": await users.remove(who!, login); return Response.json({ ok: true });
      default: return Response.json({ error: "do= add, role or remove" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof NotAllowed) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof ConfigError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);

/** How a setting's value is typed in: by the kind of its default. */
function valueInput(e: ConfigEntry): string {
  const locked = e.source == "locked";
  const attrs = `name="value" id="set-${esc(e.key)}" aria-label="${esc(e.key)}"${locked ? " disabled" : ""}`;
  if (typeof e.default == "boolean") {
    return `<select ${attrs} data-kind="boolean"><option value="true"${e.value === true ? " selected" : ""}>On</option><option value="false"${e.value === false ? " selected" : ""}>Off</option></select>`;
  }
  if (typeof e.default == "number") return `<input class="input" type="number" step="1" ${attrs} data-kind="number" value="${esc(String(e.value))}" required>`;
  if (typeof e.default == "string") return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}" autocomplete="off" spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" spellcheck="false">`;
}

const shown = (v: unknown) => (typeof v == "boolean" ? (v ? "on" : "off") : typeof v == "string" ? `“${v}”` : JSON.stringify(v));

function settingRow(e: ConfigEntry, session: Session): string {
  const when = e.updated != null ? `<time datetime="${new Date(e.updated).toISOString()}">${new Date(e.updated).toISOString().slice(0, 10)}</time>` : "";
  const meta = e.source == "locked" ? `<span class="badge" title="Set in the deploy's configuration: change it there and deploy">Locked by the deploy</span>`
    : e.source == "set" ? `<span>Set${e.updatedBy ? ` by ${esc(e.updatedBy)}` : ""} ${when}</span><span>· default ${esc(shown(e.default))}</span>`
    : `<span>Default</span>`;
  return `  <li class="setting" data-key="${esc(e.key)}">
    <div class="about">
      <label class="key" for="set-${esc(e.key)}">${esc(e.key)}</label>
      <p class="desc">${esc(e.description)}</p>
      <p class="meta">${meta}</p>
    </div>
    <form class="value" method="post" action="${esc(link("/admin/settings", session))}">
      <input type="hidden" name="key" value="${esc(e.key)}">
      ${valueInput(e)}
      ${e.source == "locked" ? "" : `<button class="pill save" disabled>Save</button>${e.source == "set" ? `<button type="button" class="pill reset" title="Back to ${esc(shown(e.default))}">Reset</button>` : ""}`}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

function userRow(u: User, session: Session): string {
  const me = u.login == session.login.toLowerCase();
  const seen = u.lastSeen != null ? `<time datetime="${new Date(u.lastSeen).toISOString()}">${new Date(u.lastSeen).toISOString().slice(0, 10)}</time>` : `<time class="never">never signed in</time>`;
  const fixed = u.bootstrap ? ` disabled title="An admin by the deploy (ADMINS): change it there"` : "";
  const added = u.bootstrap ? "Admin by the deploy (ADMINS)" : u.addedBy ? `Added by ${u.addedBy}` : "Signed in on their own";
  return `  <li data-login="${esc(u.login)}">
    <div class="doc"><span class="title">${esc(u.login)}</span>${u.name && u.name.toLowerCase() != u.login ? `<span class="note">${esc(u.name)}</span>` : ""}${me ? `<span class="badge">you</span>` : ""}${u.bootstrap ? `<span class="badge" title="${esc(added)}">deploy</span>` : ""}${seen}</div>
    <select class="role" aria-label="Role for ${esc(u.login)}" title="${esc(added)}"${fixed}><option value="user"${u.role == "user" ? " selected" : ""}>User</option><option value="admin"${u.role == "admin" ? " selected" : ""}>Admin</option></select>
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${u.bootstrap ? "An admin by the deploy (ADMINS): change it there" : "Remove: they can't sign in any more"}"${u.bootstrap ? " disabled" : ""}>${ICON.delete}</button>
  </li>`;
}

async function adminPage(platform: Platform, session: Session): Promise<Response> {
  const who = whoOf(session);
  const [settings, users] = await Promise.all([platform.directory.config.list(who), platform.directory.users.list(who)]);
  const admins = users.filter((u) => u.role == "admin").length;
  const style = `
  section { margin-bottom: 44px; }
  h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 4px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
  h2 small { font-size: 13px; font-weight: 400; color: var(--soft); }
  .lede { margin: 0 0 16px; font-size: 13.5px; color: var(--soft); }
  .back { font-size: 13px; color: var(--chrome); text-decoration: none; }
  .back:hover { color: var(--chrome-hover); }
  ol.rows > li.setting { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 14px 2px; }
  .setting .about { min-width: 0; }
  .setting .key { display: block; margin: 0; font-family: var(--font-mono); font-size: 13.5px; color: var(--fg-strong); }
  .setting .desc { margin: 2px 0 0; color: var(--fg); }
  .setting .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 0; font-size: 12.5px; color: var(--soft); }
  .setting .meta time { margin: 0; font-size: inherit; }
  .setting .value { display: flex; align-items: center; gap: 6px; }
  .setting .value .input { width: 7.5em; text-align: right; font-feature-settings: "tnum"; }
  .setting .value .input:not([type=number]) { width: 12em; text-align: left; }
  .setting .hint { grid-column: 1 / -1; margin: 0; }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }
  .add-user { display: flex; gap: 8px; margin: 0 0 14px; }
  .add-user .input { flex: 1; }
  #users-hint { margin: -6px 0 12px; }
  ol.rows > li .doc { cursor: default; }
  .never { font-style: italic; }
  .role { margin-left: 8px; }
  @media (max-width: 520px) { ol.rows > li.setting { grid-template-columns: 1fr; } .setting .value { justify-content: flex-end; } }
`;
  return new Response(appPage("Admin", style, `<main>
  <header>
    <h1>Admin</h1>
    <a class="back" href="${esc(link("/docs", session))}">‹ Documents</a>
  </header>
  <section aria-labelledby="settings-title">
    <h2 id="settings-title">Settings</h2>
    <p class="lede">The server's settings, the same for everyone. A setting the deploy locks can only be changed there.</p>
    <ol class="rows">
${settings.map((e) => settingRow(e, session)).join("\n")}
    </ol>
  </section>
  <section aria-labelledby="users-title">
    <h2 id="users-title">Users <small>${users.length} · ${admins} admin${admins == 1 ? "" : "s"}</small></h2>
    <p class="lede">Only the GitHub logins here can sign in. Admins can change the settings and who's here. Removing someone signs them out everywhere; their documents stay.</p>
    <form class="add-user" method="post" action="${esc(link("/admin/users", session))}">
      <input type="hidden" name="do" value="add">
      <input class="input" name="login" placeholder="A GitHub login" aria-label="GitHub login to add" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <select name="role" aria-label="Their role"><option value="user">User</option><option value="admin">Admin</option></select>
      <button class="new">Add</button>
    </form>
    <p class="hint" id="users-hint" role="status"></p>
    <ol class="rows users">
${users.map((u) => userRow(u, session)).join("\n")}
    </ol>
  </section>
  <footer><span>Signed in as ${esc(session.login)}</span><a href="${esc(link("/docs", session))}">Documents</a><a href="/auth/logout">Sign out</a></footer>
</main>
<script>
  ${TIMES_SCRIPT}
  const me = ${JSON.stringify(session.login.toLowerCase())};
  const usersAction = ${JSON.stringify(link("/admin/users", session))};
  async function post(action, fields) {
    const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  const say = (hint, text, error) => { hint.textContent = text; hint.classList.toggle("error", !!error); };

  // Settings: Save lights up once the value differs from what's saved; each is checked by the server, which says what's wrong.
  for (const li of document.querySelectorAll("li.setting")) {
    const form = li.querySelector("form"), input = form.elements.value, save = li.querySelector(".save"), reset = li.querySelector(".reset"), hint = li.querySelector(".hint");
    if (!save) continue;
    const was = input.value;
    const asJson = () => {
      const kind = input.dataset.kind, v = input.value.trim();
      return kind == "number" ? (v == "" ? "" : String(Number(v))) : kind == "boolean" ? v : kind == "string" ? JSON.stringify(input.value) : v;
    };
    const dirty = () => { save.disabled = input.value == was; say(hint, ""); };
    input.addEventListener("input", dirty);
    input.addEventListener("change", dirty);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Saving…");
      try { await post(form.action, { key: li.dataset.key, value: asJson() }); location.reload(); } catch (err) { say(hint, err.message, true); }
    });
    reset?.addEventListener("click", async () => {
      say(hint, "Saving…");
      try { await post(form.action, { key: li.dataset.key, reset: "1" }); location.reload(); } catch (err) { say(hint, err.message, true); }
    });
  }

  // Users: add, change a role, remove; the page reloads to show the list as it is now.
  const usersHint = document.getElementById("users-hint"), adder = document.querySelector("form.add-user");
  adder.addEventListener("submit", async (e) => {
    e.preventDefault();
    say(usersHint, "Adding…");
    try { await post(usersAction, { do: "add", login: adder.elements.login.value.trim().replace(/^@/, ""), role: adder.elements.role.value }); location.reload(); }
    catch (err) { say(usersHint, err.message, true); }
  });
  for (const li of document.querySelectorAll("ol.users > li")) {
    const login = li.dataset.login, role = li.querySelector("select.role"), remove = li.querySelector(".remove");
    const was = role.value;
    role.addEventListener("change", async () => {
      if (login == me && role.value == "user" && !confirm("Stop being an admin? You won't see this page any more.")) { role.value = was; return; }
      say(usersHint, "Saving…");
      try { await post(usersAction, { do: "role", login, role: role.value }); location.reload(); }
      catch (err) { role.value = was; say(usersHint, err.message, true); }
    });
    remove.addEventListener("click", async () => {
      if (!confirm(login == me ? "Remove yourself? You'll be signed out, and can't sign in again until an admin adds you." : "Remove " + login + "? They won't be able to sign in. Their documents stay.")) return;
      say(usersHint, "Removing…");
      try { await post(usersAction, { do: "remove", login }); location.reload(); }
      catch (err) { say(usersHint, err.message, true); }
    });
  }
</script>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
