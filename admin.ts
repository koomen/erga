// The admin page: the server's settings (config.ts) and its users and
// admins (users.ts), for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
//   /admin                     the Settings page (GET /admin/settings redirects here)
//   /admin/changes             the Change log: the settings' versions, factory tasks added and merged, and production deploys, newest first; ?before=n for older ones
//   /admin/users               the Users page: their roles (admin, deploy) as switches, when they joined, add and remove
//   /admin/api-keys            the API keys page: every key Erga needs from the services it calls (GET /admin/credentials redirects here)
//   POST /admin/settings       key, and value (JSON; null for never) to set it, or reset=1 to put it back to its default
//   POST /admin/users          do=add (login, role), do=role (login, role), do=deploy (login, deploy: 1 or 0) or do=remove (login)
//   POST /admin/credentials    name (anthropic, openai, github_mirror, cloudflare_deploy), and value to set or replace its key, or clear=1 to remove it
//
// The API keys page (credentials.ts) shows whether each key is set, its
// last four characters, and who set it when; the Claude plan token, which
// the factory keeps (its own API); and, read-only, the secrets only the
// deploy sets. The page never gets a saved key back, nor does any answer here.
//
// Every page has the layout every admin page shares (admin-layout.ts): the
// breadcrumb, Share with agent, and the sidebar to Settings, API keys, Change log, Users and Factory.
//
// The POSTs answer JSON ({ entry } or { user } or { ok }, or { error } with
// the message the directory gave, for a person to act on) and come only from
// this site's pages. The directory checks who's asking itself (NotAllowed);
// this file only shows it. An agent token (Session.agent) never gets in, even
// an admin's. A setting the deploy locks is shown, read-only,
// and so is a bootstrap admin (ADMINS), who can't be demoted or removed here,
// and the last admin, who can't be demoted or removed at all (users.ts).

import { ConfigError, type ConfigEntry, type SettingChange, type Settings, type SettingsVersion } from "./config.ts";
import { esc, ICON, link, page, type Platform, type Session, TIMES_SCRIPT, whoOf } from "./front.ts";
import { adminResponse } from "./admin-layout.ts";
import { NotAllowed, type ServerRole, type User } from "./users.ts";
import { CredentialError, type CredentialEntry, type DeploySecretEntry } from "./credentials.ts";

/** /admin and its POSTs. */
export async function adminDoor(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const read = request.method == "GET" || request.method == "HEAD";
  if (!session && read) {
    return new Response(null, { status: 302, headers: { Location: `/auth/github?next=${encodeURIComponent(url.pathname)}` } });
  }
  const who = session && whoOf(session);
  // Only the person themselves, in a browser (which comes with admin power): an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (await platform.directory.users.actsAsAdmin(who));
  if (read) {
    if (!admin) return notFound();
    if (url.pathname == "/admin/settings") return new Response(null, { status: 302, headers: { Location: link("/admin", session!) } });
    if (url.pathname == "/admin/credentials") return new Response(null, { status: 302, headers: { Location: link("/admin/api-keys", session!) } });

    if (url.pathname == "/admin/changes") {
      const before = Number(url.searchParams.get("before"));
      return changesPage(platform, session!, Number.isInteger(before) && before > 0 ? before : undefined);
    }
    if (url.pathname == "/admin/api-keys") return apiKeysPage(platform, session!);
    return url.pathname == "/admin/users" ? usersPage(platform, session!) : settingsPage(platform, session!);
  }
  if (request.method != "POST") return notFound();
  if (!admin) return Response.json({ error: "Only an admin can do that." }, { status: session ? 403 : 401 });

  if (request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  try {
    if (url.pathname == "/admin/credentials") {
      const credentials = platform.directory.credentials, name = field("name");
      // The answer says what the page shows: never the key.
      return Response.json({ credential: form.get("clear") ? await credentials.clear(who!, name) : await credentials.set(who!, name, field("value")) });
    }
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
    if (e instanceof ConfigError || e instanceof CredentialError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);

/** A setting that names a document (Setting.kind), with the document it names now, if there is one. */
type Shown = ConfigEntry & { doc?: { address: string; title: string } | null };

/**
 * The control a setting's value is set with: by its kind, its choices, else
 * the kind of its default. A boolean, or a setting whose choices are "off"
 * and "on", is a switch; other choices are a select (with the value now
 * among them, if the parser took another). A document is typed by its
 * address (kept by id, which a rename never changes), empty for none. A list
 * of users is a picker: a chip for each, and a box to add one from the
 * server's users. A number that can also be never (null, e.g.
 * delete_docs_after_hours) gets a choice of "After [n] hours" or "Never" in
 * front of it.
 */
function valueInput(e: Shown, never: boolean): string {
  const locked = e.locked;
  const attrs = `name="value" id="set-${esc(e.key)}" aria-label="${esc(e.key)}"${locked ? " disabled" : ""}`;
  const control = controlOf(e);
  if (control == "switch") {
    const text = typeof e.default != "boolean", on = text ? e.value == "on" : e.value === true;
    return `<label class="switch"><input type="checkbox" role="switch" ${attrs} data-kind="${text ? "switch-text" : "switch"}"${on ? " checked" : ""}><span class="track" aria-hidden="true"></span><span class="state" aria-hidden="true">${on ? "On" : "Off"}</span></label>`;
  }
  if (control == "choice") {
    const choices = e.choices!.includes(String(e.value)) ? e.choices! : [...e.choices!, String(e.value)];
    return `<select ${attrs} data-kind="string">${choices.map((c) => `<option value="${esc(c)}"${c == e.value ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
  }
  if (control == "users") {
    const list = Array.isArray(e.value) ? (e.value as string[]) : [];
    return `<div class="picker">
        <ul class="chips" aria-label="${esc(e.key)}">${list.map((l) => chip(l, locked)).join("")}</ul>
        ${locked ? "" : `<input class="input pick" list="user-logins" placeholder="Add a user" aria-label="Add a user to ${esc(e.key)}" autocomplete="off" autocapitalize="off" spellcheck="false">`}
        <input type="hidden" ${attrs} data-kind="users" value="${esc(JSON.stringify(list))}">
      </div>`;
  }
  if (e.kind == "document") {
    const value = e.doc ? e.doc.address : e.value == null ? "" : String(e.value);
    return `<input class="input" ${attrs} data-kind="document" value="${esc(value)}" placeholder="/owner/slug" autocomplete="off" spellcheck="false">`;
  }
  if (never && typeof e.default == "number") {
    const off = e.value === null, unit = e.key.endsWith("_hours") ? "hours" : "";
    return `<select class="mode" name="mode" aria-label="${esc(e.key)}: after a time, or never"${locked ? " disabled" : ""}><option value="after"${off ? "" : " selected"}>After</option><option value="never"${off ? " selected" : ""}>Never</option></select>
      <span class="amount"${off ? " hidden" : ""}><input class="input" type="number" step="1" min="1" ${attrs} data-kind="number-or-never" value="${esc(String(off ? e.default : e.value))}"${off ? "" : " required"}>${unit ? ` <span class="unit">${unit}</span>` : ""}</span>`;
  }
  if (typeof e.default == "number") return `<input class="input" type="number" step="1" ${attrs} data-kind="number" value="${esc(String(e.value))}" required>`;
  if (typeof e.default == "string") return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}" autocomplete="off" spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" spellcheck="false">`;
}

/** How a setting is set: "switch" and "choice" save as soon as they change; the rest have Save. */
function controlOf(e: Shown): "switch" | "choice" | "users" | "typed" {
  if (e.kind == "users") return "users";
  if (typeof e.default == "boolean" || (e.choices?.length == 2 && e.choices.includes("off") && e.choices.includes("on"))) return "switch";
  if (e.choices?.length) return "choice";
  return "typed";
}

/** A user in a users setting's picker, with a button to take them out. */
const chip = (login: string, locked: boolean) => `<li class="chip" data-login="${esc(login)}">${esc(login)}${locked ? "" : `<button type="button" class="unpick" aria-label="Take out ${esc(login)}" title="Take out ${esc(login)}">${ICON.close}</button>`}</li>`;

const shown = (v: unknown, kind?: string) => (v === null ? (kind == "document" ? "none" : "never") : typeof v == "boolean" ? (v ? "on" : "off") : typeof v == "string" ? `“${v}”` : Array.isArray(v) && kind == "users" ? (v.length ? v.join(", ") : "nobody") : JSON.stringify(v));

/** When a setting was last set, as the admin page says it: "2026-10-05 14:03 UTC". */
const setAt = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function settingRow(e: Shown, session: Session, never: boolean): string {
  const def = `default ${shown(e.default, e.kind)}`;
  const control = controlOf(e);
  const meta = e.locked ? `<span class="badge" title="Locked by the deploy (server.config.ts or ERGA_SERVER_CONFIG) · ${esc(def)}">Locked</span>` : "";
  const doc = e.kind == "document" && e.value != null
    ? e.doc ? `<a class="open-doc" href="${esc(link(e.doc.address, session))}">${esc(e.doc.title)}</a>` : `<span class="gone" title="No such document now: the front page is the plain one">missing</span>`
    : "";
  // Under each setting: when it was last set, and by whom (its default on hover).
  const set = e.source == "set" && e.updated != null
    ? `<p class="set" title="${esc(def)}">Last set at ${esc(setAt(e.updated))}${e.updatedBy ? ` by ${esc(e.updatedBy)}` : ""}</p>`
    : "";
  // Save for what's typed in; Reset only where the control can't simply pick the default (a switch, a choice, an empty document can).
  const buttons = e.locked || control == "switch" || control == "choice" ? ""
    : `<button class="pill save" disabled>Save</button>${e.source == "set" && e.kind != "document" ? `<button type="button" class="pill reset" title="Back to ${esc(shown(e.default, e.kind))}">Reset</button>` : ""}`;
  return `  <li class="setting" data-key="${esc(e.key)}" data-control="${control}">
    <div class="about">
      <div class="head"><label class="key" for="set-${esc(e.key)}">${esc(e.key)}</label>${meta || doc ? `<span class="meta">${[meta, doc].filter(Boolean).join(`<span aria-hidden="true">·</span>`)}</span>` : ""}</div>
      <p class="desc">${esc(e.description)}</p>
      ${set}
    </div>
    <form class="value" method="post" action="${esc(link("/admin/settings", session))}">
      <input type="hidden" name="key" value="${esc(e.key)}">
      ${valueInput(e, never)}
      ${buttons}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

/**
 * An API key's row: its name, what uses it, whether it is set (its last four
 * characters, when and by whom) or what stands in for it, a box to paste a
 * new one, and Clear. The box is always empty: the page never has the key.
 */
export function credentialRow(c: CredentialEntry, session: Session): string {
  const id = `key-${c.name}`;
  const state = c.set
    ? `<span class="on">Set</span> · ends in <span class="last4">…${esc(c.last4 ?? "")}</span>${c.updated != null ? ` · updated ${esc(setAt(c.updated))}${c.updatedBy ? ` by ${esc(c.updatedBy)}` : ""}` : ""}`
    : c.fallback ? `Not set here. The server uses ${esc(c.env)} from the deploy.` : "Not set.";
  const cannot = !c.canStore ? ` <b>This server has no FACTORY_KEY, so it can't store a key.</b>` : "";
  return `  <li class="setting credential" data-name="${esc(c.name)}" data-label="${esc(c.label)}" data-env="${esc(c.env)}"${c.fallback ? ` data-fallback="1"` : ""}>
    <div class="about">
      <div class="head"><label class="key" for="${id}">${esc(c.label)}</label><span class="meta">${esc(c.env)}</span></div>
      <p class="desc">${esc(c.description)}</p>
      <p class="state-line">${state}${cannot}</p>
    </div>
    <form class="value" method="post" action="${esc(link("/admin/credentials", session))}">
      <input class="input secret" type="password" name="value" id="${id}" aria-label="${esc(c.label)}" placeholder="${c.set ? "Paste a new key" : "Paste the key"}" autocomplete="off" autocapitalize="off" spellcheck="false"${c.canStore ? "" : " disabled"}>
      <button class="pill save" disabled>${c.set ? "Replace" : "Save"}</button>${c.set ? `<button type="button" class="pill clear">Clear</button>` : ""}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

/** How many changes the change log lists on a page. */
const CHANGES = 50;

/** A change log line for something other than a setting: a factory task added or merged, main moved to production. */
function eventItem(c: SettingChange): string {
  const via = c.via ? ` <span class="via">via ${esc(c.via)}</span>` : "";
  const sha = (s: unknown) => `<code class="sha" title="${esc(String(s))}">${esc(String(s).slice(0, 7))}</code>`;
  if (c.task) {
    const what = c.task.event == "added" ? "added" : `merged into staging${c.task.commit ? ` as ${sha(c.task.commit)}` : ""}`;
    return `<li><span class="key">task #${c.task.id}</span> ${what}: <span class="title">${esc(c.task.title)}</span> <span class="badge">factory</span>${via}</li>`;
  }
  const r = c.release!;
  const commits = r.commits.map((x) => `<li>${sha(x.sha)} ${esc(x.subject)}</li>`).join("");
  const more = r.total > r.commits.length ? `<li class="more">and ${r.total - r.commits.length} older</li>` : "";
  const list = r.commits.length > 5
    ? `<details><summary>${r.total} commits</summary><ul class="commits">${commits}${more}</ul></details>`
    : `<ul class="commits">${commits}${more}</ul>`;
  return `<li><span class="key">main</span> ${c.from ? sha(c.from) : "none"} <span class="to" aria-label="to">→</span> ${sha(c.to)} <span class="badge">production</span>${via}${list}</li>`;
}

/**
 * One version of the settings in the change log: when, who, and each
 * setting's value from and to. `docs`: a document's address and title by id,
 * for a setting that names one.
 */
function changeRow(v: SettingsVersion, kinds: Record<string, string | undefined>, docs: Map<string, { address: string; title: string }>): string {
  const at = new Date(v.at).toISOString();
  const value = (key: string, x: unknown) => {
    const doc = kinds[key] == "document" && x != null ? docs.get(String(x)) : undefined;
    return `<span class="was">${esc(doc ? doc.address : shown(x, kinds[key]))}</span>`;
  };
  const what = v.changes.map((c) => c.task || c.release ? eventItem(c) : c.credential ? `<li><span class="key">${esc(c.key)}</span> key ${esc(c.credential)} <span class="badge">secret</span></li>` : `<li><span class="key">${esc(c.key)}</span> ${value(c.key, c.from)} <span class="to" aria-label="to">→</span> ${value(c.key, c.to)}${c.reset ? ` <span class="badge">reset</span>` : ""}</li>`).join("");
  return `  <li class="change" data-n="${v.n}">
    <div class="when"><time datetime="${at}">${at.slice(0, 16).replace("T", " ")} UTC</time><span class="by">${esc(v.by)}</span></div>
    <ul class="what">${what}</ul>
  </li>`;
}

const PAGE_STYLE = `
  section { margin-bottom: 44px; }
  h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
  h2 small { font-size: 13px; font-weight: 400; color: var(--soft); }
  .lede { margin: 0 0 16px; font-size: 13.5px; color: var(--soft); }
  ol.rows > li .doc { cursor: default; }
`;

const POST_SCRIPT = `
  async function post(action, fields) {
    const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  const say = (hint, text, error) => { hint.textContent = text; hint.classList.toggle("error", !!error); };
  // The page again, as the server has it now: in place, so the agent panel carries on (src/page/admin-nav.ts).
  const reload = () => window.ergaAdmin ? window.ergaAdmin.reload() : location.reload();
`;

/** The style of a setting's row (its key, description and control), on Settings and API keys. */
const SETTING_STYLE = PAGE_STYLE + `
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
  .setting .set { margin: 3px 0 0; font-size: 12px; color: var(--chrome); }
  .setting .hint { grid-column: 1 / -1; margin: 0; }
  .switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--soft); user-select: none; }
  .switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
  .switch .track { position: relative; flex: none; width: 34px; height: 20px; border-radius: 999px; background: color-mix(in srgb, var(--chrome) 45%, transparent); transition: background-color 150ms ease; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 150ms ease; }
  .switch input:checked + .track { background: var(--fg-strong); }
  .switch input:checked + .track::after { transform: translateX(14px); }
  .switch input:focus-visible + .track { outline: 2px solid var(--caret); outline-offset: 2px; }
  .switch .state { min-width: 2em; }
  .switch:has(input:disabled) { cursor: default; opacity: 0.6; }
  .setting .value select { min-width: 9em; height: 34px; }
  .picker { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; max-width: 26em; }
  .chips { display: contents; list-style: none; margin: 0; padding: 0; }
  .chip { display: inline-flex; align-items: center; gap: 2px; height: 26px; padding: 0 4px 0 10px; border-radius: 999px; font-size: 13px; color: var(--fg-strong); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .chip:not(:has(button)) { padding-right: 10px; }
  .unpick { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--chrome); cursor: pointer; }
  .unpick:hover { color: var(--chrome-hover); background: color-mix(in srgb, var(--chrome) 18%, transparent); }
  .unpick svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .setting .value .input.pick { width: 9em; }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }
  @media (max-width: 520px) { ol.rows > li.setting { grid-template-columns: 1fr; } .setting .value { justify-content: flex-end; } }
  .setting .state-line { margin: 3px 0 0; font-size: 12px; color: var(--chrome); }
  .setting .state-line .on { color: var(--fg-strong); font-weight: 600; }
  .setting .state-line .last4 { font-family: var(--font-mono); font-size: 11.5px; color: var(--fg); }
  .setting .value .input.secret { width: 15em; font-family: var(--font-mono); font-size: 12.5px; }
  .setting .value [hidden] { display: none; }
`;

/** /admin: the server's settings. */
async function settingsPage(platform: Platform, session: Session): Promise<Response> {
  const who = whoOf(session);
  const [entries, users] = await Promise.all([platform.directory.config.list(who), platform.directory.users.list(who)]);
  // A setting naming a document shows it by its address now, linked.
  const settings: Shown[] = await Promise.all(entries.map(async (e) => {
    if (e.kind != "document" || e.value == null) return e;
    const doc = await platform.directory.find(String(e.value));
    return { ...e, doc: doc && { address: `/${doc.owner}/${doc.slug}`, title: doc.title } };
  }));
  // Whether a setting takes null (never) as well as its kind of value.
  const takesNever = (key: string) => { try { return (platform.directory.config.settings as Settings)[key]?.parse(null) === null; } catch { return false; } };
  const style = SETTING_STYLE;
  return adminResponse({ session, title: "Settings", here: "settings", style, body: `
  <section aria-labelledby="settings-head">
    <h2 id="settings-head">Settings</h2>
    <ol class="rows">
${settings.map((e) => settingRow(e, session, takesNever(e.key))).join("\n")}
    </ol>
    <datalist id="user-logins">${users.map((u) => `<option value="${esc(u.login)}">`).join("")}</datalist>
  </section>
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}
  // Settings: a switch or a choice saves as soon as it changes; for the rest, Save lights up once the value differs from what's saved.
  // Each is checked by the server, which says what's wrong.
  const chipHtml = ${JSON.stringify(chip("LOGIN", false))};
  for (const li of document.querySelectorAll("li.setting")) {
    const form = li.querySelector("form"), input = form.elements.value, mode = li.querySelector("select.mode"), save = li.querySelector(".save"), reset = li.querySelector(".reset"), hint = li.querySelector(".hint");
    if (input.disabled) continue;
    const instant = li.dataset.control == "switch" || li.dataset.control == "choice";
    const state = () => (mode ? mode.value + ":" : "") + (input.type == "checkbox" ? input.checked : input.value);
    const was = state();
    const asJson = () => {
      const kind = input.dataset.kind, v = input.value.trim();
      if (mode && mode.value == "never") return "null";
      if (kind == "switch") return String(input.checked);
      if (kind == "switch-text") return JSON.stringify(input.checked ? "on" : "off");
      return kind == "number" || kind == "number-or-never" ? (v == "" ? "" : String(Number(v))) : kind == "string" ? JSON.stringify(input.value) : kind == "document" ? (v == "" ? "null" : JSON.stringify(v)) : v;
    };
    const submit = async () => {
      say(hint, "Saving\u2026");
      try { await post(form.action, { key: li.dataset.key, value: asJson() }); reload(); }
      catch (err) {
        say(hint, err.message, true);
        if (input.type == "checkbox") { input.checked = !input.checked; li.querySelector(".state").textContent = input.checked ? "On" : "Off"; }
      }
    };
    const dirty = () => {
      if (input.type == "checkbox") li.querySelector(".state").textContent = input.checked ? "On" : "Off";
      if (instant) { if (state() != was) submit(); return; }
      save.disabled = state() == was; say(hint, "");
    };
    input.addEventListener("input", dirty);
    input.addEventListener("change", dirty);
    // A users setting: a chip for each user; picking one from the box adds it, \u00D7 takes it out.
    const pick = li.querySelector("input.pick");
    if (pick) {
      const chips = li.querySelector(".chips");
      const logins = () => [...chips.querySelectorAll(".chip")].map((c) => c.dataset.login);
      const changed = () => { input.value = JSON.stringify(logins()); input.dispatchEvent(new Event("change")); };
      const add = () => {
        const login = pick.value.trim().replace(/^@/, "").toLowerCase();
        if (!login) return false;
        if (!logins().includes(login)) { chips.insertAdjacentHTML("beforeend", chipHtml.replaceAll("LOGIN", login.replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";"))); changed(); }
        pick.value = "";
        return true;
      };
      // A login picked from the list is added at once; a typed one on Enter.
      pick.addEventListener("input", (e) => { if (e.inputType == "insertReplacementText" || !e.inputType) add(); });
      pick.addEventListener("keydown", (e) => { if (e.key == "Enter") { e.preventDefault(); add(); } });
      chips.addEventListener("click", (e) => { const x = e.target.closest(".unpick"); if (x) { x.closest(".chip").remove(); changed(); } });
      form.addEventListener("submit", () => add(), { capture: true });
    }
    // "Never" hides the number; "After" shows it again, ready to type.
    mode?.addEventListener("change", () => {
      const amount = li.querySelector(".amount");
      amount.hidden = mode.value == "never";
      input.required = !amount.hidden;
      if (!amount.hidden) input.focus();
      dirty();
    });
    form.addEventListener("submit", (e) => { e.preventDefault(); if (!instant) submit(); });
    reset?.addEventListener("click", async () => {
      say(hint, "Saving\u2026");
      try { await post(form.action, { key: li.dataset.key, reset: "1" }); reload(); } catch (err) { say(hint, err.message, true); }
    });
  }
</script>` });
}

/**
 * The Claude plan token's row: the factory keeps it (worker/factory.ts, its
 * own encrypted table), so the page asks the factory's API whether there is
 * one, and sets or clears it there (PUT and DELETE /api/factory/claude).
 */
const CLAUDE_ROW = `  <li class="setting credential" data-name="claude" data-label="Claude plan token" data-api="/api/factory/claude">
    <div class="about">
      <div class="head"><label class="key" for="key-claude">Claude plan token</label><span class="meta">CLAUDE_CODE_OAUTH_TOKEN</span></div>
      <p class="desc">The factory's VMs run Claude Code on a Pro or Max plan with it. <span class="mono">claude setup-token</span> prints one (sk-ant-oat\u2026), good for a year.</p>
      <p class="state-line">Checking\u2026</p>
    </div>
    <form class="value" method="post" action="/api/factory/claude">
      <input class="input secret" type="password" name="value" id="key-claude" aria-label="Claude plan token" placeholder="Paste the token" autocomplete="off" autocapitalize="off" spellcheck="false" disabled>
      <button class="pill save" disabled>Save</button><button type="button" class="pill clear" hidden>Clear</button>
    </form>
    <p class="hint" role="status"></p>
  </li>`;

/** A secret only the deploy sets: whether this server has it, what it is for, and why it isn't set here. */
function deploySecretRow(d: DeploySecretEntry): string {
  const state = d.set ? `<span class="on">Set</span> in the deploy` : d.standIn ? "Not set. The session secret stands in for it." : "Not set.";
  return `  <li class="setting deploy-secret" data-env="${esc(d.env)}">
    <div class="about">
      <div class="head"><span class="key">${esc(d.env)}</span><span class="meta">${esc(d.service)}</span></div>
      <p class="desc">${esc(d.description)}</p>
      <p class="state-line">${state} \u00B7 ${esc(d.why)}</p>
    </div>
  </li>`;
}

/**
 * /admin/api-keys: every key and secret Erga needs from the services it
 * calls. The keys an admin sets here (credentials.ts, and the factory's
 * Claude plan token), each with whether it is set, its last four
 * characters, and who set it when; then the secrets only the deploy sets,
 * read-only. The page never has a key.
 */
async function apiKeysPage(platform: Platform, session: Session): Promise<Response> {
  const who = whoOf(session);
  const [credentials, deployed] = await Promise.all([platform.directory.credentials.list(who), platform.directory.credentials.deployed(who)]);
  // The Claude plan token goes after the Anthropic and OpenAI keys, with the other AI keys.
  const rows = credentials.map((c) => credentialRow(c, session));
  rows.splice(2, 0, CLAUDE_ROW);
  return adminResponse({ session, title: "API keys", here: "keys", style: SETTING_STYLE, body: `
  <section aria-labelledby="keys-head" class="credentials">
    <h2 id="keys-head">API keys</h2>
    <p class="lede">The keys Erga uses to call other services. The server keeps each key encrypted and shows it to nobody, this page included: only whether it is set, its last four characters, and who set it when. Without a key here, the server uses the deploy's Worker secret of the same name, if it has one.</p>
    <ol class="rows">
${rows.join("\n")}
    </ol>
  </section>
  <section aria-labelledby="deploy-head" class="deploy-secrets">
    <h2 id="deploy-head">Set in the deploy <small>read-only</small></h2>
    <p class="lede">These secrets are Worker secrets only. A wrong value here could lock every admin out, or break the other server, so this page doesn't change them. Set one with <span class="mono">bunx cf workers secrets update NAME</span>, or with <span class="mono">bun deploy/setup.ts</span> (docs/secrets.md). The factory's VMs run on Cloudflare Containers, through the Worker's own binding: they need no key.</p>
    <ol class="rows">
${deployed.map(deploySecretRow).join("\n")}
    </ol>
  </section>
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}
  // The Claude plan token: the factory's API says whether there is one, and sets or clears it.
  const claude = document.querySelector('li.credential[data-name="claude"]');
  const claudeApi = async (method, body) => {
    const r = await fetch(claude.dataset.api, { method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) }).catch(() => null);
    const out = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(out.error || "Couldn't reach the factory: try again.");
    return out;
  };
  const showClaude = (c) => {
    const input = claude.querySelector("input"), save = claude.querySelector(".save"), clear = claude.querySelector(".clear");
    claude.querySelector(".state-line").innerHTML = c.signedIn
      ? '<span class="on">Set</span>' + (c.at ? " \u00B7 updated " + new Date(c.at).toISOString().slice(0, 10) + (c.by ? " by " + c.by.replace(/[&<>"]/g, "") : "") : "")
      : "Not set. The factory's VMs run a scripted stand-in." + (c.canStore ? "" : " <b>This server has no FACTORY_KEY, so it can't store a token.</b>");
    input.disabled = !c.canStore;
    input.placeholder = c.signedIn ? "Paste a new token" : "Paste the token";
    save.textContent = c.signedIn ? "Replace" : "Save";
    clear.hidden = !c.signedIn;
  };
  claudeApi("GET").then(showClaude, (err) => { claude.querySelector(".state-line").textContent = "Unknown: " + err.message; });
  {
    const input = claude.querySelector("input"), save = claude.querySelector(".save"), hint = claude.querySelector(".hint");
    input.addEventListener("input", () => { save.disabled = !input.value.trim(); say(hint, ""); });
    claude.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Saving\u2026");
      try { showClaude(await claudeApi("PUT", { token: input.value })); input.value = ""; save.disabled = true; say(hint, "Saved."); } catch (err) { say(hint, err.message, true); }
    });
    claude.querySelector(".clear").addEventListener("click", async () => {
      if (!confirm("Clear the Claude plan token? The factory's VMs run a scripted stand-in until someone sets one again.")) return;
      say(hint, "Clearing\u2026");
      try { showClaude(await claudeApi("DELETE")); say(hint, "Cleared."); } catch (err) { say(hint, err.message, true); }
    });
  }
  // API keys: Save sets or replaces the key typed in, Clear removes it. The answer never holds the key; the page reloads to show what it is now.
  for (const li of document.querySelectorAll("li.credential:not([data-name=claude])")) {
    const form = li.querySelector("form"), input = form.elements.value, save = li.querySelector(".save"), clear = li.querySelector(".clear"), hint = li.querySelector(".hint");
    if (input.disabled) continue;
    input.addEventListener("input", () => { save.disabled = !input.value.trim(); say(hint, ""); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Saving\u2026");
      try { await post(form.action, { name: li.dataset.name, value: input.value }); input.value = ""; reload(); } catch (err) { say(hint, err.message, true); }
    });
    clear?.addEventListener("click", async () => {
      if (!confirm("Clear the " + li.dataset.label + "? " + (li.dataset.fallback ? "The server goes back to the deploy's " + li.dataset.env + "." : "What uses it stops until someone sets a key again."))) return;
      say(hint, "Clearing\u2026");
      try { await post(form.action, { name: li.dataset.name, clear: "1" }); reload(); } catch (err) { say(hint, err.message, true); }
    });
  }
</script>` });
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
    ${roleSwitch(u, "deploy", u.mayDeploy, u.role == "admin" ? "An admin: admins may always deploy" : "")}
    <button type="button" class="act remove" aria-label="Remove ${esc(u.login)}" title="${esc(fixedAdmin || "Remove: they can't sign in any more")}"${fixedAdmin ? " disabled" : ""}>${ICON.delete}</button>
  </li>`;
}

/** /admin/users: every user, when they joined and last came, and their roles as switches; add one, remove one. */
async function usersPage(platform: Platform, session: Session): Promise<Response> {
  const users = await platform.directory.users.list(whoOf(session));
  const admins = users.filter((u) => u.role == "admin");
  const deployers = users.filter((u) => u.mayDeploy).length;
  const deployPage = await platform.directory.config.get("deploy_page");
  const deployNote = deployPage == "admins" ? "Admins and users with the deploy role may use /deploy."
    : deployPage == "users" ? "Now anyone signed in may use /deploy (deploy_page is users): the deploy role matters only when deploy_page is admins."
    : "/deploy is off now (deploy_page is off): the deploy role matters only when deploy_page is admins.";
  const style = PAGE_STYLE + `
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
  return adminResponse({ session, title: "Users", here: "users", style, body: `
  <section aria-label="Users">
    <p class="lede">Only these GitHub logins can sign in: <span id="users-count">${users.length} user${users.length == 1 ? "" : "s"} · ${admins.length} admin${admins.length == 1 ? "" : "s"} · ${deployers} with deploy</span>. Admins may change the server's settings and its users. ${esc(deployNote)}</p>
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
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}
  const me = ${JSON.stringify(session.login.toLowerCase())};
  const action = ${JSON.stringify(link("/admin/users", session))};
  const hint = document.getElementById("users-hint"), adder = document.querySelector("form.add-user");
  // Each change goes to the server, which checks it (admins only, and never the last admin); the page reloads to show the list as it is now.
  async function change(fields, saying, undo) {
    say(hint, saying);
    try { await post(action, fields); reload(); } catch (err) { undo?.(); say(hint, err.message, true); }
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
</script>` });
}

/** /admin/changes: the change log, every change to the settings, factory task added or merged, and production deploy, newest first (`before`: only those older than version n). */
async function changesPage(platform: Platform, session: Session, before?: number): Promise<Response> {
  const who = whoOf(session), config = platform.directory.config;
  const history = await config.history(who, { before, limit: CHANGES });
  // A setting that names a document shows it by its address now, as /admin does.
  const kinds: Record<string, string | undefined> = Object.fromEntries(Object.entries(config.settings as Settings).map(([k, s]) => [k, s.kind]));
  const ids = new Set(history.versions.flatMap((v) => v.changes.filter((c) => kinds[c.key] == "document").flatMap((c) => [c.from, c.to])).filter((x) => x != null).map(String));
  const docs = new Map((await Promise.all([...ids].map(async (id) => {
    const doc = await platform.directory.find(id);
    return doc ? [[id, { address: `/${doc.owner}/${doc.slug}`, title: doc.title }] as const] : [];
  }))).flat());
  const last = history.versions.at(-1);
  const older = last && last.n > 1 && history.versions.length == CHANGES;
  const style = `
  .lede { margin: 0 0 16px; font-size: 13.5px; color: var(--soft); }
  .changes { list-style: none; margin: 0; padding: 0; }
  .changes > li.change { display: grid; grid-template-columns: 11em 1fr; gap: 2px 16px; padding: 7px 2px; border-top: 1px solid var(--rule); font-size: 13px; }
  .changes .when { display: flex; flex-direction: column; color: var(--soft); }
  .changes .when time { margin: 0; font-size: inherit; color: var(--fg); }
  .changes .what { list-style: none; margin: 0; padding: 0; min-width: 0; overflow-wrap: anywhere; }
  .changes .key { font-family: var(--font-mono); font-size: 12.5px; color: var(--fg-strong); margin-right: 4px; }
  .changes .was { font-feature-settings: "tnum"; }
  .changes .to { color: var(--soft); margin: 0 3px; }
  .changes .badge { margin: 0 0 0 4px; }
  .changes .sha { font-family: var(--font-mono); font-size: 12px; }
  .changes .title { color: var(--fg-strong); }
  .changes .via { margin-left: 6px; font-size: 12px; color: var(--soft); }
  .changes .commits { list-style: none; margin: 4px 0 2px; padding: 0 0 0 12px; border-left: 2px solid var(--rule); font-size: 12.5px; }
  .changes .commits li { padding: 1px 0; }
  .changes .commits .more, .changes details summary { color: var(--soft); cursor: default; }
  .changes details { margin-top: 4px; font-size: 12.5px; }
  .changes-empty, .changes-more { margin: 6px 2px 0; font-size: 13px; color: var(--soft); }
  @media (max-width: 520px) { .changes > li.change { grid-template-columns: 1fr; } .changes .when { flex-direction: row; gap: 8px; } }
`;
  return adminResponse({ session, title: "Change log", here: "changes", style, body: `
  <p class="lede">Every change to the server's settings, every factory task added or merged into staging, and every production deploy (main moved forward to staging), newest first: when, who, and what changed.${history.total ? ` ${history.total} change${history.total == 1 ? "" : "s"}.` : ""}</p>
  ${history.versions.length ? `<ol class="changes">
${history.versions.map((v) => changeRow(v, kinds, docs)).join("\n")}
  </ol>` : `<p class="changes-empty">${before ? "No older changes." : "Nothing has changed yet."}</p>`}
  ${before || older ? `<p class="changes-more">${before ? `<a href="${esc(link("/admin/changes", session))}">Newest</a>` : ""}${before && older ? " · " : ""}${older ? `<a href="${esc(link(`/admin/changes?before=${last!.n}`, session))}">Older changes</a>` : ""}</p>` : ""}
<script>
  ${TIMES_SCRIPT}
</script>` });
}
