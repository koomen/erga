// The admin pages' setting rows: each setting with the control it's set with (client/inline/admin-settings.ts saves it
// as it changes: there is no Save button, and the save mark left of the buttons' bar says how far it is). Each setting
// is on the page of what it governs (PAGE_SETTINGS): sign-in, documents, agents and models, feedback; public sharing is
// the Access page's own switch. A page lists its settings with settingsSection, follows them with settingLiveRows, and
// shows the secrets that only the deploy sets for it with deploySection.

import type { ConfigEntry, DeploySecretEntry, Settings } from "../directory/index.ts";
import { ICON } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { setAt, shown } from "./parts.ts";

/**
 * Where each setting is set: the page of what it governs, and the list on it. Every setting is in one list, or has a
 * control of its own on its page (OWN): tests/settings.test.ts holds this, so a new setting gets a place.
 */
export const PAGE_SETTINGS = {
  /** Sign-in: how long a sign-in lasts (after the row of how a new account gets its username: ./auth.ts, usernamesRow). */
  auth: ["sign_in_days"],
  /** Documents: new documents, and the files' limits. */
  documents: ["delete_docs_after_hours", "max_file_mb", "max_project_gb"],
  /** Agents and models: the agents on the server's keys, then the Document LLM API: its switch, and what shows while it's on. */
  agents: ["agent_daily_tokens", "agents"],
  llmApi: ["document_llm_api"],
  llmApiOn: ["document_llm_guests", "document_llm_daily_usd", "document_llm_max_tokens"],
  feedback: ["feedback"],
} as const;
/** Settings with a control of their own: the Access page's menu and switch, the Sign-in page's radio, and the Agents and models page's choice and models' boxes. */
export const OWN = ["anyone_access", "public_sharing", "usernames", "agent_keys", "agent_models_off", "document_llm_models_off"] as const;

/**
 * The control a setting's value is set with: by its kind, its choices, else
 * the kind of its default. A boolean, or a setting whose choices are "off"
 * and "on", is a switch; other choices are a select (with the value now
 * among them, if the parser took another). A list
 * of users is a picker: a chip for each, and a box to add one from the
 * server's users. A number that can also be null gets a choice in front
 * of it: "After [n] hours" or "Never" (delete_docs_after_hours), else
 * "At most [n]" or "No limit" (agent_daily_tokens).
 */
function valueInput(e: ConfigEntry, never: boolean): string {
  const locked = e.locked;
  const attrs = `name="value" id="set-${esc(e.key)}" aria-label="${esc(e.label ?? e.key)}"${locked ? " disabled" : ""}`;
  const unit = unitOf(e.key);
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
        ${locked ? "" : `<input class="input pick" list="user-logins" placeholder="Add a user" aria-label="Add a user to ${esc(e.key)}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false">`}
        <input type="hidden" ${attrs} data-kind="users" value="${esc(JSON.stringify(list))}">
      </div>`;
  }
  if (never && typeof e.default == "number") {
    const off = e.value === null;
    // A time (hours) is "After" or "Never"; another amount (a limit) is "At most" or "No limit".
    const [some, none] = unit == "hours" ? ["After", "Never"] : ["At most", "No limit"];
    return `<select class="mode" name="mode" aria-label="${esc(e.label ?? e.key)}: ${some.toLowerCase()}, or ${none.toLowerCase()}"${locked ? " disabled" : ""}><option value="after"${off ? "" : " selected"}>${some}</option><option value="never"${off ? " selected" : ""}>${none}</option></select>
      <span class="amount"${off ? " hidden" : ""}><input class="input" type="number" step="1" min="1" ${attrs} data-kind="number-or-never" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore value="${esc(String(off ? e.default : e.value))}"${off ? "" : " required"}>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
  }
  if (typeof e.default == "number")
    return `<span class="amount"><input class="input" type="number" step="${unit == "US$" ? "0.01" : "1"}" min="0" ${attrs} data-kind="number" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore value="${esc(String(e.value))}" required>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
  if (typeof e.default == "string")
    return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}"${e.placeholder ? ` placeholder="${esc(e.placeholder)}"` : ""} autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore spellcheck="false">`;
}

/** The unit of a number setting, from the end of its key: "_hours", "_days", "_mb", "_gb", "_tokens". */
const unitOf = (key: string) =>
  ({ hours: "hours", days: "days", mb: "MB", gb: "GB", usd: "US$", tokens: "tokens" })[key.slice(key.lastIndexOf("_") + 1)] ?? "";

/** How a setting is set: "switch" and "choice" save as soon as they change; the rest when the typing pauses, or the focus leaves. */
function controlOf(e: ConfigEntry): "switch" | "choice" | "users" | "typed" {
  if (e.kind == "users") return "users";
  if (typeof e.default == "boolean" || (e.choices?.length == 2 && e.choices.includes("off") && e.choices.includes("on"))) return "switch";
  if (e.choices?.length) return "choice";
  return "typed";
}

/** A user in a users setting's picker, with a button to take them out. */
export const chip = (login: string, locked: boolean) =>
  `<li class="chip" data-login="${esc(login)}">${esc(login)}${locked ? "" : `<button type="button" class="unpick" aria-label="Take out ${esc(login)}" title="Take out ${esc(login)}">${ICON.close}</button>`}</li>`;

/** "Locked", on a setting that the deploy fixes; else nothing. */
export const lockedBadge = (e: ConfigEntry) =>
  e.locked
    ? `<span class="meta"><span class="badge" title="Fixed by the deploy · default ${esc(shown(e.default))}">Locked</span></span>`
    : "";

/** Under a setting that was set: when, and by whom (its default on hover); `reset`: more in that line. */
export const setLine = (e: ConfigEntry, reset = "") =>
  e.source == "set"
    ? `<p class="set"><span title="default ${esc(shown(e.default))}">${e.updated != null ? `Set ${esc(setAt(e.updated))}${e.updatedBy ? ` by ${esc(byLine(e.updatedBy, e.updatedVia))}` : ""}` : "Set"}</span>${reset}</p>`
    : "";

export function settingRow(e: ConfigEntry, never: boolean, place: number): string {
  const control = controlOf(e);
  // Reset where the control can't simply pick the default (a switch, a choice can): in the line that says who set it.
  const reset =
    e.source == "set" && !e.locked && control != "switch" && control != "choice"
      ? ` · <button type="button" class="reset" title="Back to ${esc(shown(e.default))}">Reset</button>`
      : "";
  return `  <li class="setting" data-key="${esc(e.key)}" data-control="${control}" data-live="setting:${esc(e.key)}" data-sort="${place}">
    <div class="about">
      <div class="head"><label class="key" for="set-${esc(e.key)}" title="${esc(e.key)}">${esc(e.label ?? e.key)}</label>${lockedBadge(e)}</div>
      ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ""}
      ${setLine(e, reset)}
    </div>
    <form class="value">
      <input type="hidden" name="key" value="${esc(e.key)}">
      ${valueInput(e, never)}
    </form>
    <p class="hint" role="status"></p>
  </li>`;
}

/** A secret only the deploy sets: whether this server has it, and what it is for. */
function deploySecretRow(d: DeploySecretEntry): string {
  const state = d.set
    ? `<span class="badge ok">Set</span>`
    : `<span class="badge"${d.standIn ? ` title="The session secret stands in"` : ""}>Not set</span>`;
  return `  <li class="deploy-secret" data-env="${esc(d.env)}"><div class="about"><code class="key">${esc(d.env)}</code><p class="desc">${esc(d.description)}</p></div>${state}</li>`;
}

/**
 * "Set by the deploy", on a page: the secrets of `envs` that only the deploy sets, each with whether this server has
 * it. The page never has a value.
 */
export const deploySection = (deployed: DeploySecretEntry[], envs: readonly string[]) => `
  <section class="deploy-secrets" aria-label="Set by the deploy">
    <h3 class="sub-head">Set by the deploy</h3>
    <ol class="rows">
${deployed
  .filter((d) => envs.includes(d.env))
  .map(deploySecretRow)
  .join("\n")}
    </ol>
  </section>`;

/** Whether a setting takes null (never, or no limit) as well as its kind of value. */
function takesNever(platform: Platform, key: string): boolean {
  try {
    return (platform.directory.config.settings as Settings)[key]?.parse(null) === null;
  } catch {
    return false;
  }
}

/** The rows of the settings `keys` name, in that order, each in the control its kind needs. */
export async function settingRows(platform: Platform, session: Session, keys: readonly string[], fresh = false) {
  if (fresh) platform.directory.config.forget();
  const all = await platform.directory.config.list(whoOf(session));
  return keys.flatMap((key, i) => {
    const e = all.find((x) => x.key == key);
    return e ? [{ key: `setting:${e.key}`, html: settingRow(e, takesNever(platform, e.key), i), place: i }] : [];
  });
}

/**
 * A list of setting rows on a page, which follows the server: `view` names the page's rows (server/news/routes.ts), and
 * client/inline/admin-settings.ts saves each row as it changes (data-settings).
 */
const settingsList = (rows: { html: string }[], view: string, o: { more?: string; hidden?: boolean; first?: string } = {}) =>
  `<ol class="rows settings${o.more ? ` ${o.more}` : ""}" data-settings data-live-kind="setting" data-live-view="${view}" data-live-order="asc" data-live-at="${Date.now()}"${o.hidden ? " hidden" : ""}>
${[...(o.first ? [o.first] : []), ...rows.map((r) => r.html)].join("\n")}
    </ol>`;

/**
 * A page's list of the settings `keys`, as settingsList makes it; with the server's users for the box of a users
 * setting's picker, where the list has one. `first`: a row of the page's own, before them.
 */
export async function settingsSection(
  platform: Platform,
  session: Session,
  keys: readonly string[],
  view: string,
  o: { more?: string; hidden?: boolean; first?: string } = {}
): Promise<string> {
  const rows = await settingRows(platform, session, keys);
  const users = rows.some((r) => r.html.includes('class="picker"')) ? await platform.directory.users.list(whoOf(session)) : [];
  return `${settingsList(rows, view, o)}${users.length ? `\n    <datalist id="user-logins">${users.map((u) => `<option value="${esc(u.login)}">`).join("")}</datalist>` : ""}`;
}

/** The rows of `keys` ("setting:<key>") among the settings `of` a page, as they are now, for an open page (server/news/). */
export async function settingLiveRows(platform: Platform, session: Session, keys: string[], of: readonly string[]) {
  const out: Record<string, LiveRow> = {};
  if (!keys.some((k) => of.includes(k.slice("setting:".length)))) return out;
  for (const r of await settingRows(platform, session, of, true)) if (keys.includes(r.key)) out[r.key] = { html: r.html, sort: r.place };
  return out;
}
