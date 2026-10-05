// The admin page: the server's settings (config.ts) and its users and
// admins (users.ts), for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
//   /admin                     the page: the settings, and links to the rest
//   /admin/users               the users: their roles (admin, deploy) as switches, when they joined, add and remove
//   POST /admin/settings       key, and value (JSON; null for never) to set it, or reset=1 to put it back to its default
//   POST /admin/users          do=add (login, role), do=role (login, role), do=deploy (login, deploy: 1 or 0) or do=remove (login)
//
// The POSTs answer JSON ({ entry } or { user } or { ok }, or { error } with
// the message the directory gave, for a person to act on) and come only from
// this site's pages. The directory checks who's asking itself (NotAllowed);
// this file only shows it. An agent token (Session.agent) never gets in, even
// an admin's. An admin must have unlocked admin access with their SSH key
// (admin-keys.ts): until then /admin sends them to /admin/keys to do it. A setting the deploy locks is shown, read-only,
// and so is a bootstrap admin (ADMINS), who can't be demoted or removed here,
// and the last admin, who can't be demoted or removed at all (users.ts).

import { ConfigError, type ConfigEntry, type Settings } from "./config.ts";
import { appPage, brand, esc, ICON, link, page, type Platform, type Session, TIMES_SCRIPT, whoOf } from "./front.ts";
import { LOCKED, NotAllowed, type ServerRole, type User } from "./users.ts";
import { unlockFirst } from "./admin-access.ts";

/** /admin and its POSTs. */
export async function adminDoor(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const isPage = (url.pathname == "/admin" || url.pathname == "/admin/users") && request.method == "GET";
  if (!session && isPage) {
    return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname)}` } });
  }
  const who = session && whoOf(session);
  // Only the person themselves, in a browser: an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (await platform.directory.users.isAdmin(who));
  // An admin who hasn't unlocked admin access with their SSH key (admin-keys.ts) unlocks it first.
  const unlocked = admin && (await platform.directory.users.isUnlocked(who!));
  if (url.pathname == "/admin" || isPage) {
    if (!admin || !isPage) return notFound();
    if (!unlocked) return unlockFirst(url.pathname, session!);
    return url.pathname == "/admin" ? adminPage(platform, session!) : usersPage(platform, session!);
  }
  if (request.method != "POST") return notFound();
  if (!admin) return Response.json({ error: "Only an admin can do that." }, { status: session ? 403 : 401 });
  if (!unlocked) return Response.json({ error: LOCKED, locked: true }, { status: 403 });
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
      case "deploy": {
        const deploy = field("deploy");
        if (deploy != "1" && deploy != "0") throw new NotAllowed("deploy= 1 to grant the deploy role, or 0 to revoke it.");
        return Response.json({ user: await users.setDeploy(who!, login, deploy == "1") });
      }
      case "remove": await users.remove(who!, login); return Response.json({ ok: true });
      default: return Response.json({ error: "do= add, role, deploy or remove" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof NotAllowed) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof ConfigError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);

/** A setting that names a document (Setting.kind), with the document it names now, if there is one. */
type Shown = ConfigEntry & { doc?: { address: string; title: string } | null };

/**
 * How a setting's value is typed in: by its kind, else the kind of its
 * default. A document is typed by its address (kept by id, which a rename
 * never changes), empty for none. A number that can also be never (null,
 * e.g. delete_docs_after_hours) gets a choice of "After [n] hours" or
 * "Never" in front of it.
 */
function valueInput(e: Shown, never: boolean): string {
  const locked = e.locked;
  const attrs = `name="value" id="set-${esc(e.key)}" aria-label="${esc(e.key)}"${locked ? " disabled" : ""}`;
  if (e.kind == "document") {
    const value = e.doc ? e.doc.address : e.value == null ? "" : String(e.value);
    return `<input class="input" ${attrs} data-kind="document" value="${esc(value)}" placeholder="/owner/slug" autocomplete="off" spellcheck="false">`;
  }
  if (never && typeof e.default == "number") {
    const off = e.value === null, unit = e.key.endsWith("_hours") ? "hours" : "";
    return `<select class="mode" name="mode" aria-label="${esc(e.key)}: after a time, or never"${locked ? " disabled" : ""}><option value="after"${off ? "" : " selected"}>After</option><option value="never"${off ? " selected" : ""}>Never</option></select>
      <span class="amount"${off ? " hidden" : ""}><input class="input" type="number" step="1" min="1" ${attrs} data-kind="number-or-never" value="${esc(String(off ? e.default : e.value))}"${off ? "" : " required"}>${unit ? ` <span class="unit">${unit}</span>` : ""}</span>`;
  }
  if (typeof e.default == "boolean") {
    return `<select ${attrs} data-kind="boolean"><option value="true"${e.value === true ? " selected" : ""}>On</option><option value="false"${e.value === false ? " selected" : ""}>Off</option></select>`;
  }
  if (typeof e.default == "number") return `<input class="input" type="number" step="1" ${attrs} data-kind="number" value="${esc(String(e.value))}" required>`;
  if (typeof e.default == "string") return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}" autocomplete="off" spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" spellcheck="false">`;
}

const shown = (v: unknown, kind?: string) => (v === null ? (kind == "document" ? "none" : "never") : typeof v == "boolean" ? (v ? "on" : "off") : typeof v == "string" ? `“${v}”` : JSON.stringify(v));

function settingRow(e: Shown, session: Session, never: boolean): string {
  const def = `default ${shown(e.default, e.kind)}`;
  const when = e.updated != null ? `Set ${new Date(e.updated).toISOString().slice(0, 16).replace("T", " ")} UTC · ` : "";
  const meta = e.locked ? `<span class="badge" title="Locked by the deploy (server.config.ts or ERGA_SERVER_CONFIG) · ${esc(def)}">Locked</span>`
    : e.source == "set" ? `<span title="${esc(when + def)}">set${e.updatedBy ? ` by ${esc(e.updatedBy)}` : ""}</span>`
    : "";
  const doc = e.kind == "document" && e.value != null
    ? e.doc ? `<a class="open-doc" href="${esc(link(e.doc.address, session))}">${esc(e.doc.title)}</a>` : `<span class="gone" title="No such document now: the front page is the plain one">missing</span>`
    : "";
  return `  <li class="setting" data-key="${esc(e.key)}">
    <div class="about">
      <div class="head"><label class="key" for="set-${esc(e.key)}">${esc(e.key)}</label>${meta || doc ? `<span class="meta">${[meta, doc].filter(Boolean).join(`<span aria-hidden="true">·</span>`)}</span>` : ""}</div>
      <p class="desc">${esc(e.description)}</p>
    </div>
    <form class="value" method="post" action="${esc(link("/admin/settings", session))}">
      <input type="hidden" name="key" value="${esc(e.key)}">
      ${valueInput(e, never)}
      ${e.locked ? "" : `<button class="pill save" disabled>Save</button>${e.source == "set" ? `<button type="button" class="pill reset" title="Back to ${esc(shown(e.default, e.kind))}">Reset</button>` : ""}`}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

/** The look both admin pages' sections share. */
const SECTION_STYLE = `
  section { margin-bottom: 44px; }
  h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
  h2 small { font-size: 13px; font-weight: 400; color: var(--soft); }
  .lede { margin: 0 0 16px; font-size: 13.5px; color: var(--soft); }
  .back { font-size: 13px; color: var(--chrome); text-decoration: none; }
  .back:hover { color: var(--chrome-hover); }`;

/** post(action, fields): a POST from the page, its JSON answer, or an error with the server's message; say(hint, text, error?) shows it. */
const POST_SCRIPT = `
  async function post(action, fields) {
    const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  const say = (hint, text, error) => { hint.textContent = text; hint.classList.toggle("error", !!error); };`;

async function adminPage(platform: Platform, session: Session): Promise<Response> {
  const who = whoOf(session);
  const [entries, users] = await Promise.all([platform.directory.config.list(who), platform.directory.users.list(who)]);
  // A setting naming a document shows it by its address now, linked.
  const settings: Shown[] = await Promise.all(entries.map(async (e) => {
    if (e.kind != "document" || e.value == null) return e;
    const doc = await platform.directory.find(String(e.value));
    return { ...e, doc: doc && { address: `/${doc.owner}/${doc.slug}`, title: doc.title } };
  }));
  const admins = users.filter((u) => u.role == "admin").length;
  // Whether a setting takes null (never) as well as its kind of value.
  const takesNever = (key: string) => { try { return (platform.directory.config.settings as Settings)[key]?.parse(null) === null; } catch { return false; } };
  const style = `${SECTION_STYLE}
  ol.rows > li.setting { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px 16px; padding: 10px 2px; }
  .setting .about { min-width: 0; }
  .setting .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .setting .key { margin: 0; font-family: var(--font-mono); font-size: 13.5px; color: var(--fg-strong); }
  .setting .desc { margin: 2px 0 0; font-size: 13px; color: var(--soft); }
  .setting .meta { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 5px; font-size: 12px; color: var(--soft); }
  .setting .meta .badge { margin: 0; }
  .setting .meta time { margin: 0; font-size: inherit; }
  .setting .meta a { color: inherit; }
  .setting .meta .gone { color: #c2410c; }
  .setting .value { display: flex; align-items: center; gap: 6px; }
  .setting .value .input { width: 7.5em; text-align: right; font-feature-settings: "tnum"; }
  .setting .value .input:not([type=number]) { width: 12em; text-align: left; }
  .setting .value .amount { display: flex; align-items: center; gap: 6px; }
  .setting .value .amount[hidden] { display: none; }
  .setting .value .unit { font-size: 13.5px; color: var(--soft); }
  .setting .hint { grid-column: 1 / -1; margin: 0; }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }
  @media (max-width: 520px) { ol.rows > li.setting { grid-template-columns: 1fr; } .setting .value { justify-content: flex-end; } }
`;
  const deployOn = (await platform.directory.config.get("deploy_page")) != "off";
  const factoryOn = (await platform.directory.config.get("factory")) == "on";
  return new Response(appPage("Admin", style, `${brand(session)}<main>
  <header>
    <h1>Admin</h1>
    <a class="back" href="${esc(link("/docs", session))}">‹ Documents</a>
  </header>
  <section aria-labelledby="settings-title">
    <h2 id="settings-title">Settings</h2>
    <ol class="rows">
${settings.map((e) => settingRow(e, session, takesNever(e.key))).join("\n")}
    </ol>
  </section>
  <section aria-labelledby="users-title">
    <h2 id="users-title">Users <small>${users.length} · ${admins} admin${admins == 1 ? "" : "s"}</small></h2>
    <p class="lede">Only the server's users can sign in. Who they are, when they joined, and their roles (admin, deploy): <a href="${esc(link("/admin/users", session))}">Users</a>.</p>
  </section>
  <section aria-labelledby="source-title">
    <h2 id="source-title">Source and deploys</h2>
    <p class="lede">Erga's own repository, hosted here, and its branches deploying themselves: staging to staging.erga.dev, main to erga.dev. Commits, merging, deploys and their logs, the GitHub mirror, and the factory's tasks and agent: <a href="${esc(link("/admin/source", session))}">Source</a>.</p>
  </section>
  ${deployOn ? `<section aria-labelledby="deploy-title">
    <h2 id="deploy-title">Deploy your own</h2>
    <p class="lede">Put a copy of this server on your own Cloudflare account, with you as its admin: <a href="${esc(link("/deploy", session))}">Deploy Erga</a>. Who may use it is the deploy_page setting.</p>
  </section>` : ""}
  ${factoryOn ? `<section aria-labelledby="factory-title">
    <h2 id="factory-title">Factory</h2>
    <p class="lede">Tasks that Claude Code does in VMs, each a branch merged into staging (experimental): <a href="${esc(link("/admin/source", session))}">Open the factory</a>. The factory setting turns it off.</p>
  </section>` : ""}
</main>
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}

  // Settings: Save lights up once the value differs from what's saved; each is checked by the server, which says what's wrong.
  for (const li of document.querySelectorAll("li.setting")) {
    const form = li.querySelector("form"), input = form.elements.value, mode = li.querySelector("select.mode"), save = li.querySelector(".save"), reset = li.querySelector(".reset"), hint = li.querySelector(".hint");
    if (!save) continue;
    const state = () => (mode ? mode.value + ":" : "") + input.value;
    const was = state();
    const asJson = () => {
      const kind = input.dataset.kind, v = input.value.trim();
      if (mode && mode.value == "never") return "null";
      return kind == "number" || kind == "number-or-never" ? (v == "" ? "" : String(Number(v))) : kind == "boolean" ? v : kind == "string" ? JSON.stringify(input.value) : kind == "document" ? (v == "" ? "null" : JSON.stringify(v)) : v;
    };
    const dirty = () => { save.disabled = state() == was; say(hint, ""); };
    input.addEventListener("input", dirty);
    input.addEventListener("change", dirty);
    // "Never" hides the number; "After" shows it again, ready to type.
    mode?.addEventListener("change", () => {
      const amount = li.querySelector(".amount");
      amount.hidden = mode.value == "never";
      input.required = !amount.hidden;
      if (!amount.hidden) input.focus();
      dirty();
    });
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
</script>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** A date as the page shows it before its script makes it relative (TIMES_SCRIPT). */
const when = (t: number, cls = "") => `<time${cls ? ` class="${cls}"` : ""} datetime="${new Date(t).toISOString()}">${new Date(t).toISOString().slice(0, 10)}</time>`;

/**
 * A role's switch: a checkbox (role="switch"), never typed text. Off, with
 * why in its title, where it can't change here: a bootstrap admin's admin
 * role, and the last admin's.
 */
function roleSwitch(u: User, role: "admin" | "deploy", on: boolean, fixed: string): string {
  const label = role == "admin" ? "Admin" : "Deploy";
  return `<label class="switch" title="${esc(fixed || (role == "admin" ? "Admin: may change the server's settings and users" : "Deploy: may use /deploy when deploy_page is admins"))}">
      <input type="checkbox" role="switch" class="${role}" aria-label="${label} role for ${esc(u.login)}"${on ? " checked" : ""}${fixed ? " disabled" : ""}><span class="track" aria-hidden="true"></span>
    </label>`;
}

function userRow(u: User, session: Session, lastAdmin: boolean): string {
  const me = u.login == session.login.toLowerCase();
  const joined = u.created ? when(u.created, "joined") : `<time class="joined never">not yet</time>`;
  const seen = u.lastSeen != null ? when(u.lastSeen, "seen") : `<time class="seen never">never</time>`;
  const added = u.bootstrap ? "Admin by the deploy (ADMINS)" : u.addedBy ? `Added by ${u.addedBy}` : "Signed in on their own";
  // The same reason keeps them from being removed.
  const fixedAdmin = u.bootstrap ? "An admin by the deploy (ADMINS): change it there"
    : lastAdmin ? `${me ? "You're" : "The"} last admin: make someone else an admin first` : "";
  return `  <li data-login="${esc(u.login)}">
    <div class="who"><span class="title">${esc(u.login)}</span>${u.name && u.name.toLowerCase() != u.login ? `<span class="note">${esc(u.name)}</span>` : ""}${me ? `<span class="badge">you</span>` : ""}<span class="added">${esc(added)}</span></div>
    ${joined}
    ${seen}
    ${roleSwitch(u, "admin", u.role == "admin", fixedAdmin)}
    ${roleSwitch(u, "deploy", u.deploy, "")}
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${esc(fixedAdmin || "Remove: they can't sign in any more")}"${fixedAdmin ? " disabled" : ""}>${ICON.delete}</button>
  </li>`;
}

/** /admin/users: every user, when they joined and last came, and their roles as switches; add one, remove one. */
async function usersPage(platform: Platform, session: Session): Promise<Response> {
  const users = await platform.directory.users.list(whoOf(session));
  const admins = users.filter((u) => u.role == "admin");
  const deployers = users.filter((u) => u.deploy).length;
  const deployPage = await platform.directory.config.get("deploy_page");
  const deployNote = deployPage == "admins" ? "Users with the deploy role may use /deploy, as admins may."
    : deployPage == "users" ? "Now anyone signed in may use /deploy (deploy_page is users): the deploy role matters only when deploy_page is admins."
    : "/deploy is off now (deploy_page is off): the deploy role matters only when deploy_page is admins.";
  const style = `${SECTION_STYLE}
  .add-user { display: flex; gap: 8px; margin: 0 0 14px; }
  .add-user .input { flex: 1; }
  #users-hint { margin: -6px 0 12px; }
  .labels, ol.users > li { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem 7.5rem 4.5rem 4.5rem 34px; align-items: center; column-gap: 12px; }
  .labels { padding: 0 4px 6px; font-size: 12px; color: var(--soft); }
  .labels .c, ol.users .switch { justify-self: center; }
  .labels .t, ol.users time { justify-self: start; margin: 0; }
  ol.users > li { padding: 10px 4px; }
  .who { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  .who .badge { align-self: center; }
  .who .added { flex-basis: 100%; font-size: 12px; color: var(--chrome); }
  .never { font-style: italic; }
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
  .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
  .switch .track { position: absolute; inset: 0; border-radius: 999px; background: color-mix(in srgb, var(--chrome) 35%, transparent); transition: background-color 150ms ease; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: transform 150ms ease; }
  .switch input:checked + .track { background: var(--fg-strong); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--caret); outline-offset: 2px; }
  .switch:has(input:disabled) { cursor: default; opacity: 0.45; }
  @media (max-width: 640px) { .labels .seen, ol.users time.seen { display: none; } .labels, ol.users > li { grid-template-columns: minmax(0, 1fr) 6.5rem 3.5rem 3.5rem 34px; } }
`;
  return new Response(appPage("Users", style, `${brand(session)}<main>
  <header>
    <div>
      <h1>Users</h1>
      <p class="sub" id="users-count">${users.length} · ${admins.length} admin${admins.length == 1 ? "" : "s"} · ${deployers} with deploy</p>
    </div>
    <a class="back" href="${esc(link("/admin", session))}">‹ Admin</a>
  </header>
  <section aria-label="Users">
    <p class="lede">Only these GitHub logins can sign in. Admins may change the server's settings and its users. ${esc(deployNote)}</p>
    <form class="add-user" method="post" action="${esc(link("/admin/users", session))}">
      <input type="hidden" name="do" value="add">
      <input class="input" name="login" placeholder="A GitHub login" aria-label="GitHub login to add" autocomplete="off" autocapitalize="off" spellcheck="false" required>
      <button class="new">Add</button>
    </form>
    <p class="hint" id="users-hint" role="status"></p>
    <div class="labels" aria-hidden="true"><span>User</span><span class="t">Joined</span><span class="t seen">Last seen</span><span class="c">Admin</span><span class="c">Deploy</span><span></span></div>
    <ol class="rows users">
${users.map((u) => userRow(u, session, u.role == "admin" && admins.length == 1)).join("\n")}
    </ol>
  </section>
</main>
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}
  const me = ${JSON.stringify(session.login.toLowerCase())};
  const action = ${JSON.stringify(link("/admin/users", session))};
  const hint = document.getElementById("users-hint"), adder = document.querySelector("form.add-user");
  // Each change goes to the server, which checks it (admins only, and never the last admin); the page reloads to show the list as it is now.
  async function change(fields, saying, undo) {
    say(hint, saying);
    try { await post(action, fields); location.reload(); } catch (err) { undo?.(); say(hint, err.message, true); }
  }
  adder.addEventListener("submit", (e) => {
    e.preventDefault();
    change({ do: "add", login: adder.elements.login.value.trim().replace(/^@/, "") }, "Adding…");
  });
  for (const li of document.querySelectorAll("ol.users > li")) {
    const login = li.dataset.login, admin = li.querySelector("input.admin"), deploy = li.querySelector("input.deploy"), remove = li.querySelector(".remove");
    admin.addEventListener("change", () => {
      const undo = () => { admin.checked = !admin.checked; };
      if (login == me && !admin.checked && !confirm("Stop being an admin? You won't see the admin pages any more.")) return undo();
      change({ do: "role", login, role: admin.checked ? "admin" : "user" }, "Saving…", undo);
    });
    deploy.addEventListener("change", () => change({ do: "deploy", login, deploy: deploy.checked ? "1" : "0" }, "Saving…", () => { deploy.checked = !deploy.checked; }));
    remove.addEventListener("click", () => {
      if (!confirm(login == me ? "Remove yourself? You'll be signed out, and can't sign in again until an admin adds you." : "Remove " + login + "? They won't be able to sign in. Their documents stay.")) return;
      change({ do: "remove", login }, "Removing…");
    });
  }
</script>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
