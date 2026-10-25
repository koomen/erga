// The admin page: the server's settings and its users and
// admins, for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
//   /admin                     the Settings page (GET /admin/settings redirects here)
//   /admin/changes             the Change log: the settings' versions, factory tasks added and merged, and production deploys, newest first; ?before=n for older ones
//   /admin/users               the Users page: their roles (admin, deploy) as switches, when they joined, add and remove
//   /admin/api-keys            the API keys page: every key Erga needs from the services it calls (GET /admin/credentials redirects here)
//   /admin/auth                the Authentication page: how people sign in (GitHub), on this server and the other deploy target
//   GET /admin/auth/status     the same as JSON {here, other} (server/auth.ts, AuthStatus: never a secret), with live checks
//   POST /admin/auth           server (here or other), provider (github or google), and do=save (clientId, secret), do=discard (the values that wait for a test sign-in), do=clear (force=1: even if sign-in would stop) or do=providers (provider, on: 1 or 0)
//   POST /admin/settings       key, and value (JSON; null for never) to set it, or reset=1 to put it back to its default
//   POST /admin/users          do=add (login, role), do=role (login, role), do=deploy (login, deploy: 1 or 0) or do=remove (login)
//   POST /admin/credentials    name (anthropic, openai, github_mirror, cloudflare_deploy), and value to set or replace its key, or clear=1 to remove it
//   POST /admin/share          rotate=1 (optional): Share with agent's admin token, for an outside
//                              agent: { token, id, label, expires }; the same one until it's near its end (12 hours), or rotated
//
// The API keys page shows whether each key is set, its
// last four characters, and who set it when; and, read-only, the secrets only the
// deploy sets. The page never gets a saved key back, nor does any answer here.
//
// The Authentication page shows each
// server's GitHub OAuth app: its client ID (public), whether its secret is
// set (never the secret), the URLs GitHub needs, a live check, and how to
// make one. A client ID and secret pasted there win over the deploy's, after
// GitHub accepts them, and with the lockout rules server/auth.ts gives.
//
// Every page has the layout every admin page shares: the
// breadcrumb, Share with agent, and the sidebar to Settings, API keys, Authentication, Change log, Users and Ops.
//
// The POSTs answer JSON ({ entry } or { user } or { ok }, or { error } with
// the message the directory gave, for a person to act on) and come only from
// this site's pages. The directory checks who's asking itself (NotAllowed);
// this file only shows it. An agent token (Session.agent) never gets in, even
// an admin's. A setting the deploy locks is shown, read-only,
// and so is a bootstrap admin (ADMINS), who can't be demoted or removed here,
// and the last admin, who can't be demoted or removed at all.

import { type ConfigEntry, ConfigError, type CredentialEntry, CredentialError, type DeploySecretEntry, NotAllowed, type ServerRole, type SettingChange, type Settings, type SettingsVersion, type User } from "../directory/index.ts";
import { avatarUrl, esc, ICON, link, page, TIMES_SCRIPT } from "../pages/index.ts";
import { colorFor } from "../../document/content.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { byLine, SYSTEM, VIA } from "../../shared/attribution.ts";
import { adminResponse } from "./layout.ts";
import { authOps, AuthError, PROVIDERS, ScopeError, type AuthOps, type AuthStatus, type CheckState, type OtherStatus, type Provider } from "../identity/index.ts";

/** /admin and its POSTs. */
export async function adminDoor(platform: Platform, request: Request): Promise<Response> {
  const session = await platform.sessionOf(request);
  const url = new URL(request.url);
  const read = request.method == "GET" || request.method == "HEAD";
  if (!session && read) {
    return new Response(null, { status: 302, headers: { Location: `/auth/sign-in?next=${encodeURIComponent(url.pathname)}` } });
  }
  const who = session && whoOf(session);
  // Only the person themselves, in a browser (which comes with admin power): an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (await platform.directory.users.actsAsAdmin(who));
  if (read) {
    if (!admin || url.pathname == "/admin/share") return notFound();
    if (url.pathname == "/admin/settings") return new Response(null, { status: 302, headers: { Location: link("/admin", session!) } });
    if (url.pathname == "/admin/credentials") return new Response(null, { status: 302, headers: { Location: link("/admin/api-keys", session!) } });

    if (url.pathname == "/admin/changes") {
      const before = Number(url.searchParams.get("before"));
      return changesPage(platform, session!, Number.isInteger(before) && before > 0 ? before : undefined);
    }
    if (url.pathname == "/admin/api-keys") return apiKeysPage(platform, session!);
    if (url.pathname == "/admin/auth" || url.pathname == "/admin/auth/status") {
      const status = await authOps(platform, url.origin).status(who!);
      return url.pathname == "/admin/auth" ? authPage(session!, status) : Response.json(status, { headers: { "Cache-Control": "no-store" } });
    }
    return url.pathname == "/admin/users" ? usersPage(platform, session!) : settingsPage(platform, session!);
  }
  if (request.method != "POST") return notFound();
  if (!admin) return Response.json({ error: "Only an admin can do that." }, { status: session ? 403 : 401 });

  if (request.headers.get("origin") != url.origin) return Response.json({ error: "Forbidden" }, { status: 403 });
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "");
  try {
    // Share with agent: a person in a browser only (an agent never makes a token, whatever its scope; checked above too).
    if (url.pathname == "/admin/share") {
      if (session!.agent || session!.test) return Response.json({ error: "An agent can't make tokens." }, { status: 403 });
      const { token, info } = await platform.tokens.shareAdmin({ login: session!.login, name: session!.name }, field("rotate") == "1");
      return Response.json({ token, id: info.id, label: info.label, expires: info.expires }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname == "/admin/credentials") {
      const credentials = platform.directory.credentials, name = field("name");
      // The answer says what the page shows: never the key.
      return Response.json({ credential: form.get("clear") ? await credentials.clear(who!, name) : await credentials.set(who!, name, field("value")) });
    }
    if (url.pathname == "/admin/auth") {
      const auth = authOps(platform, url.origin);
      const server = field("server") == "other" ? "other" : "here";
      const provider: Provider = field("provider") == "google" ? "google" : "github";
      // The answers say what the page shows: never the secret.
      switch (field("do")) {
        case "save": return Response.json({ result: await auth.save(who!, server, { clientId: field("clientId"), secret: field("secret") }, provider) });
        case "discard": return Response.json({ result: await auth.discard(who!, server, provider) });
        case "clear": return Response.json({ result: await auth.clear(who!, server, field("force") == "1", provider) });
        case "providers": return Response.json({ providers: await auth.setProvider(who!, provider, field("on") == "1") });
        default: return Response.json({ error: "do= save, discard, clear or providers" }, { status: 400 });
      }
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
    if (e instanceof NotAllowed || e instanceof ScopeError) return Response.json({ error: e.message }, { status: 403 });
    if (e instanceof ConfigError || e instanceof CredentialError || e instanceof AuthError) return Response.json({ error: e.message }, { status: 400 });
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
  const meta = e.locked ? `<span class="badge" title="Locked by the deploy (deploy/locked-settings.ts or ERGA_SERVER_CONFIG) · ${esc(def)}">Locked</span>` : "";
  const doc = e.kind == "document" && e.value != null
    ? e.doc ? `<a class="open-doc" href="${esc(link(e.doc.address, session))}">${esc(e.doc.title)}</a>` : `<span class="gone" title="No such document now: the front page is the plain one">missing</span>`
    : "";
  // Under each setting: when it was last set, and by whom (its default on hover).
  const set = e.source == "set" && e.updated != null
    ? `<p class="set" title="${esc(def)}">Last set at ${esc(setAt(e.updated))}${e.updatedBy ? ` by ${esc(byLine(e.updatedBy, e.updatedVia))}` : ""}</p>`
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
    ? `<span class="on">Set</span> · ends in <span class="last4">…${esc(c.last4 ?? "")}</span>${c.updated != null ? ` · updated ${esc(setAt(c.updated))}${c.updatedBy ? ` by ${esc(byLine(c.updatedBy, c.updatedVia))}` : ""}` : ""}`
    : c.fallback ? `Not set here. The server uses ${esc(c.env)} from the deploy.` : "Not set.";
  const cannot = !c.canStore ? ` <b>This server has no FACTORY_KEY, so it can't store a key.</b>`
    : c.unreadable ? ` <b class="unreadable">This server can't open it: it was encrypted with another server's FACTORY_KEY. Paste the key again.</b>` : "";
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

/**
 * Who made a version, and how: the person's login, and, when they
 * acted through an agent or the factory, "via …" beside it. Never the agent alone.
 */
function byHtml(by: string, via?: string | null): string {
  const chip = via ? viaChip(via) : null;
  return `<span class="who">${avatarHtml(by)}<span class="by">${esc(byLine(by))}</span>${chip ? ` <span class="via" data-via="${esc(via!)}" title="${esc(chip.title)}">${esc(chip.text)}</span>` : ""}</span>`;
}

/** A person's GitHub picture, on their initial in their colour (shown if the picture doesn't load); the system has a dot. */
function avatarHtml(by: string): string {
  if (!by || by == SYSTEM) return `<span class="avatar system" aria-hidden="true">•</span>`;
  const login = by.toLowerCase();
  const pic = login.startsWith("test-") ? "" : `<img src="${esc(avatarUrl(login))}" alt="" loading="lazy" draggable="false" onerror="this.remove()">`;
  return `<span class="avatar" style="--c: ${colorFor(login)}" aria-hidden="true">${esc(login[0]?.toUpperCase() ?? "?")}${pic}</span>`;
}

/** A via as a short chip, with more on hover: "admin agent", "token" (its name on hover), "factory #12". */
function viaChip(via: string): { text: string; title: string } {
  if (via == VIA.agent) return { text: "editor agent", title: `via ${via}` };
  if (via == VIA.admin) return { text: "admin agent", title: `via ${via}` };
  const token = /^a shared agent \((.*)\)$/.exec(via);
  if (token) return { text: "token", title: token[1] };
  const task = /^the factory \(task #(\d+)\)$/.exec(via);
  return { text: task ? `factory #${task[1]}` : via, title: `via ${via}` };
}

/** A change log line for something other than a setting: a factory task added or merged, main moved to production, a user or a token changed. */
function eventItem(c: SettingChange): string {
  if (c.user) {
    const u = c.user;
    const what = u.event == "added" ? `added${u.role ? ` as ${esc(u.role)}` : ""}` : u.event == "removed" ? "removed"
      : u.event == "role" ? `made ${esc(u.role ?? "user")}` : `deploy role ${u.deploy ? "granted" : "revoked"}`;
    return `<li><span class="key">user</span> <span class="title">${esc(u.login)}</span> ${what}</li>`;
  }
  if (c.signIn) {
    const a = c.signIn, server = a.target ? `${esc(a.target)}'s` : "the";
    const name = a.provider == "google" ? "Google" : "GitHub";
    if (a.event == "on" || a.event == "off") return `<li><span class="key">sign-in</span> sign-in with ${name} turned ${a.event}</li>`;
    const what = a.event == "set" ? `in use: client ID <code>${esc(a.clientId ?? "")}</code>` : a.event == "pending" ? `client ID <code>${esc(a.clientId ?? "")}</code> waits for a test sign-in`
      : a.event == "tested" ? `client ID <code>${esc(a.clientId ?? "")}</code> in use after a test sign-in` : a.event == "discarded" ? `new values discarded` : "cleared: the deploy's values again";
    return `<li><span class="key">sign-in</span> ${server} ${name} app ${what}</li>`;
  }
  if (c.token) return `<li><span class="key">token</span> <span class="title">${esc(c.token.label)}</span> (${esc(c.token.of)}’s) revoked</li>`;
  const sha = (s: unknown) => `<code class="sha" title="${esc(String(s))}">${esc(String(s).slice(0, 7))}</code>`;
  if (c.task) {
    const what = c.task.event == "added" ? "added" : `merged into staging${c.task.commit ? ` as ${sha(c.task.commit)}` : ""}`;
    return `<li><span class="key">task #${c.task.id}</span> ${what}: <span class="title">${esc(c.task.title)}</span></li>`;
  }
  if (c.stagingOverride) return `<li><span class="key">staging</span> pushes allowed until ${esc(new Date(c.stagingOverride.until).toISOString().slice(11, 16))} UTC <span class="badge">staging rule overridden</span> <span class="title">${esc(c.stagingOverride.reason)}</span></li>`;
  const r = c.release!;
  const commits = r.commits.map((x) => `<li>${sha(x.sha)} ${esc(x.subject)}</li>`).join("");
  const more = r.total > r.commits.length ? `<li class="more">and ${r.total - r.commits.length} older</li>` : "";
  // Past the production gate (its tests hadn't passed): the admin's reason, and what the gate said.
  const override = r.override ? ` <span class="badge" title="${esc(r.override.gate)}">${c.key == "staging" ? "staging rule overridden" : "tests overridden"}</span> <span class="title">${esc(r.override.reason)}</span>` : "";
  // Folded, so the entry stays on its line: the commits open under it.
  const list = r.commits.length ? ` <details><summary>${r.total} commit${r.total == 1 ? "" : "s"}</summary><ul class="commits">${commits}${more}</ul></details>` : "";
  return `<li><span class="key">${c.key == "staging" ? "staging" : "main"}</span> ${c.from ? sha(c.from) : "none"} <span class="to" aria-label="to">→</span> ${sha(c.to)}${override}${list}</li>`;
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
  const what = v.changes.map((c) => c.task || c.release || c.stagingOverride || c.user || c.token || c.signIn ? eventItem(c) : c.credential ? `<li><span class="key">${esc(c.key)}</span> key ${esc(c.credential)}</li>` : `<li><span class="key">${esc(c.key)}</span> ${value(c.key, c.from)} <span class="to" aria-label="to">→</span> ${value(c.key, c.to)}${c.reset ? ` <span class="badge">reset</span>` : ""}</li>`).join("");
  return `  <li class="change" data-n="${v.n}">
    ${byHtml(v.by, v.via)}<ul class="what">${what}</ul><time datetime="${at}" title="${at.slice(0, 16).replace("T", " ")} UTC">${at.slice(0, 16).replace("T", " ")}</time>
  </li>`;
}


const POST_SCRIPT = `
  async function post(action, fields) {
    const r = await fetch(action, { method: "POST", body: new URLSearchParams(fields), headers: { Accept: "application/json" } }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) throw new Error(body.error || "Couldn't reach the server: try again.");
    return body;
  }
  const say = (hint, text, error) => { hint.textContent = text; hint.classList.toggle("error", !!error); };
  // The page again, as the server has it now: in place, so the agent panel carries on.
  const reload = () => window.ergaAdmin ? window.ergaAdmin.reload() : location.reload();
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
  return adminResponse({ session, title: "Settings", here: "settings", body: `
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
 * calls. The keys an admin sets here, each with whether it is set, its last four
 * characters, and who set it when; then the secrets only the deploy sets,
 * read-only. The page never has a key.
 */
async function apiKeysPage(platform: Platform, session: Session): Promise<Response> {
  const who = whoOf(session);
  const [credentials, deployed] = await Promise.all([platform.directory.credentials.list(who), platform.directory.credentials.deployed(who)]);
  const rows = credentials.map((c) => credentialRow(c, session));
  return adminResponse({ session, title: "API keys", here: "keys", body: `
  <section aria-labelledby="keys-head" class="credentials">
    <h2 id="keys-head">API keys</h2>
    <p class="lede">The keys Erga uses to call other services. The server keeps each key encrypted and shows it to nobody, this page included: only whether it is set, its last four characters, and who set it when. Without a key here, the server uses the deploy's Worker secret of the same name, if it has one.</p>
    <ol class="rows">
${rows.join("\n")}
    </ol>
  </section>
  <section aria-labelledby="deploy-head" class="deploy-secrets">
    <h2 id="deploy-head">Set in the deploy <small>read-only</small></h2>
    <p class="lede">These secrets are Worker secrets only. A wrong value here could lock every admin out, or break the other server, so this page doesn't change them. Set one with <span class="mono">bunx cf workers secrets update NAME</span>, or with <span class="mono">bun deploy/setup.ts</span>.</p>
    <ol class="rows">
${deployed.map(deploySecretRow).join("\n")}
    </ol>
  </section>
<script>
  ${TIMES_SCRIPT}
  ${POST_SCRIPT}
  // API keys: Save sets or replaces the key typed in, Clear removes it. The answer never holds the key; the page reloads to show what it is now.
  for (const li of document.querySelectorAll("li.credential")) {
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

// ------------------------------------------------------------ /admin/auth: how people sign in

const STATE_LABEL: Record<CheckState, string> = { working: "Working", misconfigured: "Misconfigured", not_set_up: "Not set up", unknown: "Unknown" };


const who_ = (by: string, via?: string | null) => esc(byLine(by, via));

/** One server's card: its state, its app's values, what waits for a test, how to make an app, and the form to set one. */
function serverCard(s: AuthStatus | OtherStatus, o: { server: "here" | "other"; label: string; editable: boolean; session: Session; here: AuthStatus; provider?: Provider; on?: boolean }): string {
  const host = new URL(s.origin).host;
  const provider: Provider = o.provider ?? "github", name = PROVIDERS[provider].label;
  const head = (state: CheckState | null, text: string) => `<header><h3>${esc(o.label)}<small>${esc(host)}</small></h3>${state ? `<span class="state ${state}">${esc(text)}</span>` : ""}</header>`;
  if ("error" in s) {
    return `<section class="server" data-server="${o.server}" data-state="unreachable">${head("unknown", "Can't reach it")}
      <p class="summary">This page can't read ${esc(host)}'s sign-in: ${esc(s.error)}</p>
      <p class="note">Its own Authentication page is at <a href="${esc(s.origin)}/admin/auth">${esc(s.origin)}/admin/auth</a>.</p></section>`;
  }
  const src = (from: "page" | "deploy") => from == "page" ? "set on /admin/auth" : "from the deploy";
  const copy = (text: string) => `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy ${esc(text)}">Copy</button>`;
  const setBy = s.page ? ` · ${who_(s.page.updatedBy, s.page.updatedVia)}, ${esc(setAt(s.page.updated))}` : "";
  const rows = `<dl>
      <dt>Client ID</dt><dd>${s.inUse.clientId ? `<code class="client-id">${esc(s.inUse.clientId)}</code><span class="src">${src(s.inUse.source)}${s.inUse.source == "page" ? setBy : ""}</span>` : `<span class="src">Not set</span>`}</dd>
      <dt>Client secret</dt><dd>${s.inUse.secretSet ? `Set<span class="src">${src(s.inUse.source)} · never shown</span>` : `<span class="src">Not set</span>`}</dd>
      <dt>Homepage URL</dt><dd><code>${esc(s.homepageUrl)}</code>${copy(s.homepageUrl)}</dd>
      <dt>Callback URL</dt><dd><code class="callback">${esc(s.callbackUrl)}</code>${copy(s.callbackUrl)}</dd>
    </dl>`;
  const deployNote = s.inUse.source == "page" ? `<p class="note">The deploy's values: ${s.deploy.clientId ? `client ID <code>${esc(s.deploy.clientId)}</code>` : "no client ID"}, ${s.deploy.secretSet ? "a secret" : "no secret"}. Clear goes back to them.</p>` : "";
  const devNote = s.dev ? `<p class="note">Local development: everyone signs in as the dev login, without ${name}, so this server doesn't use these values. A hosted server does.</p>` : "";
  // A real sign-in is what checks the callback URL: on this server a link, on the other a link to its own sign-in.
  const testUrl = `${o.server == "here" ? "" : s.origin}/auth/${provider}?app=pending&next=/admin/auth`;
  // A provider that's off: an admin's sign-in with the values in use checks them before anyone else uses them.
  const offTest = o.on === false && s.inUse.clientId && !s.pending ? `<p class="note">Sign-in with ${name} is off. <a class="pill test-off" href="${esc(link(`/auth/${provider}?app=test&next=/admin/auth`, o.session))}">Test sign-in</a> checks these values with your own sign-in; then turn ${name} on above.</p>` : "";
  const test = s.pending?.test && !s.pending.test.ok ? `<p class="failed">The last test sign-in failed, ${esc(setAt(s.pending.test.at))}: ${esc(s.pending.test.error ?? "")}</p>` : "";
  const pending = s.pending ? `<div class="pending">
      <p><b>New values wait for a test sign-in.</b> Client ID <code>${esc(s.pending.clientId)}</code>, set by ${who_(s.pending.updatedBy, s.pending.updatedVia)}, ${esc(setAt(s.pending.updated))}. ${s.pendingCheck ? esc(s.pendingCheck.summary) : ""} Sign-in keeps the values in use until an admin signs in with the new ones.</p>
      ${test}
      <div class="row">${o.server == "here" || s.target ? `<a class="pill test" href="${esc(o.server == "here" ? link(testUrl, o.session) : testUrl)}">Test sign-in${o.server == "here" ? "" : ` on ${esc(host)}`}</a>` : ""}${o.editable ? `<button type="button" class="pill discard">Discard</button>` : ""}</div>
    </div>` : "";
  const reasons = s.check.reasons.length && s.check.state != "working" ? `<ul class="reasons">${s.check.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
  const steps = s.setup ? `<details class="setup"${s.check.state == "not_set_up" ? " open" : ""}><summary>How to make ${s.check.state == "not_set_up" ? "its" : "a new"} ${name} OAuth ${provider == "google" ? "client" : "app"}</summary><ol class="steps">${s.setup.map((x) => `<li>${esc(x).replace(/https:\/\/(github\.com\/settings\/applications\/new|console\.cloud\.google\.com\/apis\/credentials)/, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)}</li>`).join("")}</ol></details>` : "";
  // Where the other server's values are set, when not here.
  const elsewhere = !o.editable && o.server == "other" ? `<p class="note">${esc(host)}'s sign-in is set on its own Authentication page: <a href="${esc(s.origin)}/admin/auth">${esc(s.origin)}/admin/auth</a>.</p>` : "";
  const cannot = !o.editable && o.server == "here" && !s.canStore ? `<p class="note">This server has no FACTORY_KEY to encrypt a secret with, so its values are set only in the deploy.</p>` : "";
  const form = o.editable ? `<form class="configure" method="post" action="${esc(link("/admin/auth", o.session))}">
      <p class="lede">${s.check.state == "working" ? `Paste another app's values to replace these. ${name} must accept them first, and they wait for a test sign-in before anyone else uses them.` : `Paste the app's values. ${name} must accept them first; then sign-in uses them at once.`}</p>
      <input type="hidden" name="server" value="${o.server}">
      <input type="hidden" name="provider" value="${provider}">
      <label>Client ID<input class="input" name="clientId" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${provider == "google" ? "1234…apps.googleusercontent.com" : "Ov23li…"}" required></label>
      <label>Client secret<input class="input" type="password" name="secret" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the secret" required></label>
      <div class="row"><button class="pill save">Save</button>${s.page ? `<button type="button" class="pill clear">Clear</button>` : ""}</div>
    </form>` : "";
  return `<section class="server" data-provider="${provider}" data-server="${o.server}" data-target="${esc(s.target ?? "")}" data-state="${s.check.state}">${head(s.check.state, STATE_LABEL[s.check.state])}
    <p class="summary">${esc(s.check.summary)}</p>${reasons}
    ${rows}${deployNote}${devNote}${offTest}${pending}${steps}${elsewhere}${cannot}${form}
    <p class="hint" role="status"></p>
  </section>`;
}

/** /admin/auth: how people sign in, on this server and on the other deploy target. */
function authPage(session: Session, status: Awaited<ReturnType<AuthOps["status"]>>): Response {
  const { here, other, google, providers } = status;
  const name = (t: string | null) => (t ? t[0].toUpperCase() + t.slice(1) : "This server");
  const otherCard = other ? serverCard(other, { server: "other", label: name(other.target), editable: !("error" in other) && other.takesFrom == here.target && other.canStore, session, here }) : "";
  return adminResponse({ session, title: "Authentication", here: "auth", body: `
  <section aria-labelledby="auth-head" class="auth">
    <h2 id="auth-head">Authentication</h2>
    <p class="lede">People sign in with GitHub, Google or both: choose which here. Each server needs an OAuth app of its own for each, with its own callback URL. The deploy sets each app; values pasted here win over the deploy's while they are set. The client secret is kept encrypted and shown to nobody. A change never signs out anyone who is signed in.</p>
    <section class="providers" aria-label="Sign-in providers">
      ${(["github", "google"] as const).map((p) => `<label class="switch provider" title="${esc(`Sign-in with ${PROVIDERS[p].label}`)}"><input type="checkbox" role="switch" data-provider="${p}" aria-label="Sign-in with ${PROVIDERS[p].label}"${providers[p] ? " checked" : ""}><span class="track" aria-hidden="true"></span><span>${PROVIDERS[p].label}</span></label>`).join("\n      ")}
      <p class="hint" id="providers-hint" role="status"></p>
    </section>
    <h3 class="provider-head">GitHub</h3>
    ${serverCard(here, { server: "here", label: here.target ? `${name(here.target)} (this server)` : "This server", editable: here.canStore, session, here, provider: "github", on: providers.github })}
    ${otherCard}
    <h3 class="provider-head">Google</h3>
    ${serverCard(google, { server: "here", label: google.target ? `${name(google.target)} (this server)` : "This server", editable: google.canStore, session, here, provider: "google", on: providers.google })}
  </section>
<script>
  ${POST_SCRIPT}
  const providersHint = document.getElementById("providers-hint");
  for (const box of document.querySelectorAll("section.providers input[data-provider]")) box.addEventListener("change", async () => {
    say(providersHint, "Saving\u2026");
    try { await post(${JSON.stringify(link("/admin/auth", session))}, { do: "providers", provider: box.dataset.provider, on: box.checked ? "1" : "0" }); reload(); }
    catch (err) { box.checked = !box.checked; say(providersHint, err.message, true); }
  });
  for (const card of document.querySelectorAll("section.server")) {
    const hint = card.querySelector(".hint"), server = card.dataset.server, provider = card.dataset.provider;
    for (const b of card.querySelectorAll("button.copy")) b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); } catch {}
    });
    const form = card.querySelector("form.configure");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      say(hint, "Checking the values\u2026");
      try {
        const { result } = await post(form.action, { do: "save", server, provider, clientId: form.elements.clientId.value, secret: form.elements.secret.value });
        form.reset();
        say(hint, result.message);
        setTimeout(reload, 1200);
      } catch (err) { say(hint, err.message, true); }
    });
    card.querySelector("button.discard")?.addEventListener("click", async () => {
      if (!confirm("Discard the new values? Sign-in keeps the values in use.")) return;
      try { await post(form.action, { do: "discard", server, provider }); reload(); } catch (err) { say(hint, err.message, true); }
    });
    card.querySelector("button.clear")?.addEventListener("click", async () => {
      if (!confirm("Clear the values set on this page? Sign-in goes back to the deploy's values.")) return;
      say(hint, "Clearing\u2026");
      try { await post(form.action, { do: "clear", server, provider }); reload(); }
      catch (err) {
        if (!/force/.test(err.message) || !confirm(err.message + "\\n\\nClear anyway?")) { say(hint, err.message, true); return; }
        try { await post(form.action, { do: "clear", server, provider, force: "1" }); reload(); } catch (err2) { say(hint, err2.message, true); }
      }
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
  const added = u.bootstrap ? "Admin by the deploy (ADMINS)" : u.addedBy ? `Added by ${byLine(u.addedBy, u.addedVia)}` : "Signed in on their own";
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
  return adminResponse({ session, title: "Users", here: "users", body: `
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
  return adminResponse({ session, title: "Change log", here: "changes", wide: true, body: `
  <p class="lede">A log of every change to the server's admin surface, including settings, users, keys, tokens, source, and deploys.${history.total ? ` ${history.total} change${history.total == 1 ? "" : "s"}.` : ""}</p>
  ${history.versions.length ? `<ol class="changes">
${history.versions.map((v) => changeRow(v, kinds, docs)).join("\n")}
  </ol>` : `<p class="changes-empty">${before ? "No older changes." : "Nothing has changed yet."}</p>`}
  ${before || older ? `<p class="changes-more">${before ? `<a href="${esc(link("/admin/changes", session))}">Newest</a>` : ""}${before && older ? " · " : ""}${older ? `<a href="${esc(link(`/admin/changes?before=${last!.n}`, session))}">Older changes</a>` : ""}</p>` : ""}
<script>
  ${TIMES_SCRIPT}
</script>` });
}
