// /admin, the Settings page: each of the server's settings, with the control it's set with (client/inline/admin-settings.ts
// saves it).

import { ACCESS_SETTINGS, AGENT_SETTINGS, type ConfigEntry, type Settings } from "../directory/index.ts";
import { MODELS, PROVIDER_LABEL, type ModelChoice } from "../../shared/models.ts";
import { ICON, inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { setAt, shown } from "./parts.ts";
import { addressOf } from "../../document/names.ts";

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
    const text = typeof e.default != "boolean",
      on = text ? e.value == "on" : e.value === true;
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
  if (control == "models") {
    // The short list, a box for each model: ticked, a server key runs it. The value is the list of those not ticked.
    const off = Array.isArray(e.value) ? (e.value as string[]) : [];
    const boxes = (Object.keys(MODELS) as ModelChoice[]).map(
      (m) =>
        `<label class="model-pick"><input type="checkbox" value="${esc(m)}"${off.includes(m) ? "" : " checked"}${locked ? " disabled" : ""}> ${esc(MODELS[m].label)} <small>${esc(PROVIDER_LABEL[MODELS[m].provider])}</small></label>`
    );
    return `<div class="models">${boxes.join("")}</div><input type="hidden" ${attrs} data-kind="json" value="${esc(JSON.stringify(off))}">`;
  }
  if (e.kind == "document") {
    // Find as you type: any of the server's documents and projects, by title, owner or address (the operation search_documents);
    // choosing one saves it. The value is its address, kept by id.
    const value = e.doc ? e.doc.address : e.value == null ? "" : String(e.value);
    return `<div class="doc-pick">
        <input class="input find" id="find-${esc(e.key)}" type="search" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="found-${esc(e.key)}" placeholder="Find a document or project" autocomplete="off" autocapitalize="off" spellcheck="false"${locked ? " disabled" : ""}>
        <ul class="found" id="found-${esc(e.key)}" role="listbox" aria-label="Documents and projects" hidden></ul>
        <input type="hidden" ${attrs} data-kind="document" value="${esc(value)}">
      </div>`;
  }
  if (never && typeof e.default == "number") {
    const off = e.value === null,
      unit = e.key.endsWith("_hours") ? "hours" : "";
    return `<select class="mode" name="mode" aria-label="${esc(e.key)}: after a time, or never"${locked ? " disabled" : ""}><option value="after"${off ? "" : " selected"}>After</option><option value="never"${off ? " selected" : ""}>Never</option></select>
      <span class="amount"${off ? " hidden" : ""}><input class="input" type="number" step="1" min="1" ${attrs} data-kind="number-or-never" value="${esc(String(off ? e.default : e.value))}"${off ? "" : " required"}>${unit ? ` <span class="unit">${unit}</span>` : ""}</span>`;
  }
  if (typeof e.default == "number")
    return `<input class="input" type="number" step="1" ${attrs} data-kind="number" value="${esc(String(e.value))}" required>`;
  if (typeof e.default == "string")
    return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}" autocomplete="off" spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" spellcheck="false">`;
}

/** How a setting is set: "switch", "choice" and "document" save as soon as they change; the rest have Save. */
function controlOf(e: Shown): "switch" | "choice" | "users" | "models" | "document" | "typed" {
  if (e.kind == "users") return "users";
  if (e.kind == "models") return "models";
  if (e.kind == "document") return "document";
  if (typeof e.default == "boolean" || (e.choices?.length == 2 && e.choices.includes("off") && e.choices.includes("on"))) return "switch";
  if (e.choices?.length) return "choice";
  return "typed";
}

/** A user in a users setting's picker, with a button to take them out. */
const chip = (login: string, locked: boolean) =>
  `<li class="chip" data-login="${esc(login)}">${esc(login)}${locked ? "" : `<button type="button" class="unpick" aria-label="Take out ${esc(login)}" title="Take out ${esc(login)}">${ICON.close}</button>`}</li>`;

export function settingRow(e: Shown, session: Session, never: boolean, place: number): string {
  const def = `default ${shown(e.default, e.kind)}`;
  const control = controlOf(e);
  const meta = e.locked
    ? `<span class="badge" title="Locked by the deploy (deploy/locked-settings.ts or ERGA_SERVER_CONFIG) · ${esc(def)}">Locked</span>`
    : "";
  const doc =
    e.kind == "document" && e.value != null
      ? e.doc
        ? `<a class="open-doc" href="${esc(link(e.doc.address, session))}">${esc(e.doc.title)}</a>`
        : `<span class="gone" title="No such document now: the homepage is the plain one">missing</span>`
      : "";
  // Under each setting: when it was last set, and by whom (its default on hover).
  const set =
    e.source == "set" && e.updated != null
      ? `<p class="set" title="${esc(def)}">Last set at ${esc(setAt(e.updated))}${e.updatedBy ? ` by ${esc(byLine(e.updatedBy, e.updatedVia))}` : ""}</p>`
      : "";
  // Save for what's typed in (a document saves as it's chosen); Reset where the control can't simply pick the default (a switch, a choice can).
  const buttons =
    e.locked || control == "switch" || control == "choice" || control == "models"
      ? ""
      : `${control == "document" ? "" : `<button class="pill save" disabled>Save</button>`}${e.source == "set" ? `<button type="button" class="pill reset" title="Back to ${esc(e.kind == "document" ? "the repo's demo page" : shown(e.default, e.kind))}">Reset</button>` : ""}`;
  return `  <li class="setting" data-key="${esc(e.key)}" data-control="${control}" data-live="setting:${esc(e.key)}" data-sort="${place}">
    <div class="about">
      <div class="head"><label class="key${e.label ? " named" : ""}" for="${control == "document" ? "find-" : "set-"}${esc(e.key)}"${e.label ? ` title="${esc(e.key)}"` : ""}>${esc(e.label ?? e.key)}</label>${meta || doc ? `<span class="meta">${[meta, doc].filter(Boolean).join(`<span aria-hidden="true">·</span>`)}</span>` : ""}</div>
      <p class="desc">${esc(e.description)}</p>
      ${set}
    </div>
    <form class="value">
      <input type="hidden" name="key" value="${esc(e.key)}">
      ${valueInput(e, never)}
      ${buttons}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

/** The settings /admin shows, in its order, each with what its row needs: the document it names; whether it takes never. */
async function shownSettings(
  platform: Platform,
  session: Session,
  fresh = false,
  pick = (key: string) => !ACCESS_SETTINGS.includes(key) && !AGENT_SETTINGS.includes(key)
) {
  if (fresh) platform.directory.config.forget();
  const entries = await platform.directory.config.list(whoOf(session));
  // A setting naming a document shows it by its address now, linked.
  // The Access page's settings are set there, and the agents' on the API keys page.
  const settings: Shown[] = await Promise.all(
    entries
      .filter((e) => pick(e.key))
      .map(async (e) => {
        if (e.kind != "document" || e.value == null) return e;
        const doc = await platform.directory.find(String(e.value));
        return { ...e, doc: doc && { address: addressOf(doc), title: doc.title } };
      })
  );
  // Whether a setting takes null (never) as well as its kind of value.
  const takesNever = (key: string) => {
    try {
      return (platform.directory.config.settings as Settings)[key]?.parse(null) === null;
    } catch {
      return false;
    }
  };
  return settings.map((e, place) => ({ key: e.key, html: settingRow(e, session, takesNever(e.key), place), place }));
}

/** /admin: the server's settings. */
export async function settingsPage(platform: Platform, session: Session) {
  const [rows, users] = await Promise.all([shownSettings(platform, session), platform.directory.users.list(whoOf(session))]);
  return adminPage({
    session,
    title: "Settings",
    here: "settings",
    body: `
  <section aria-labelledby="settings-head">
    <h2 id="settings-head">Settings</h2>
    <ol class="rows" data-live-kind="setting" data-live-view="settings" data-live-order="asc" data-live-at="${Date.now()}">
${rows.map((r) => r.html).join("\n")}
    </ol>
    <datalist id="user-logins">${users.map((u) => `<option value="${esc(u.login)}">`).join("")}</datalist>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/** The rows of /admin that `keys` name ("setting:<key>"), as they are now, for an open page (server/news/). */
export const settingsRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of await shownSettings(platform, session, true))
    if (`setting:${r.key}` in out) out[`setting:${r.key}`] = { html: r.html, sort: r.place };
  return out;
};

/** The agents' settings (whose keys they use, the models off for server keys), as rows of /admin/api-keys. */
export const agentSettingRows = async (platform: Platform, session: Session, fresh = false) =>
  shownSettings(platform, session, fresh, (key) => AGENT_SETTINGS.includes(key));

/** The rows of /admin/api-keys' agents' settings that `keys` name ("setting:<key>"), as they are now, for an open page. */
export const agentSettingsRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of await agentSettingRows(platform, session, true))
    if (`setting:${r.key}` in out) out[`setting:${r.key}`] = { html: r.html, sort: r.place };
  return out;
};
