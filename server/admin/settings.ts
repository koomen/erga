// /admin/settings, the Settings page: each of the server's settings, with the control it's set with
// (client/inline/admin-settings.ts saves it), the Sites row (the document published to each domain), under them pages'
// models today (./page-llm.ts), and last the secrets only the deploy sets. The agents' settings are on the Agents page
// (./agents.ts), which draws its setting rows with settingRow too.

import { ACCESS_SETTINGS, AGENT_SETTINGS, type ConfigEntry, type DeploySecretEntry, type Settings } from "../directory/index.ts";
import { ICON, inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { pageLlmSection, pageLlmUsage } from "./page-llm.ts";
import { setAt, shown } from "./parts.ts";
import { addressOf } from "../../document/model/names.ts";
import { domainName, ERGA, ergaName, sitesOf } from "../sites/index.ts";

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
      <span class="amount"${off ? " hidden" : ""}><input class="input" type="number" step="1" min="1" ${attrs} data-kind="number-or-never" value="${esc(String(off ? e.default : e.value))}"${off ? "" : " required"}>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
  }
  if (typeof e.default == "number")
    return `<span class="amount"><input class="input" type="number" step="${unit == "US$" ? "0.01" : "1"}" min="0" ${attrs} data-kind="number" value="${esc(String(e.value))}" required>${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
  if (typeof e.default == "string")
    return `<input class="input" ${attrs} data-kind="string" value="${esc(String(e.value))}"${e.placeholder ? ` placeholder="${esc(e.placeholder)}"` : ""} autocomplete="off" spellcheck="false">`;
  return `<input class="input mono" ${attrs} data-kind="json" value="${esc(JSON.stringify(e.value))}" autocomplete="off" spellcheck="false">`;
}

/** The unit of a number setting, from the end of its key: "_hours", "_mb", "_gb", "_tokens". */
const unitOf = (key: string) =>
  ({ hours: "hours", mb: "MB", gb: "GB", usd: "US$", tokens: "tokens" })[key.slice(key.lastIndexOf("_") + 1)] ?? "";

/** How a setting is set: "switch" and "choice" save as soon as they change; the rest have Save. */
function controlOf(e: ConfigEntry): "switch" | "choice" | "users" | "typed" {
  if (e.kind == "users") return "users";
  if (typeof e.default == "boolean" || (e.choices?.length == 2 && e.choices.includes("off") && e.choices.includes("on"))) return "switch";
  if (e.choices?.length) return "choice";
  return "typed";
}

/** A user in a users setting's picker, with a button to take them out. */
export const chip = (login: string, locked: boolean) =>
  `<li class="chip" data-login="${esc(login)}">${esc(login)}${locked ? "" : `<button type="button" class="unpick" aria-label="Take out ${esc(login)}" title="Take out ${esc(login)}">${ICON.close}</button>`}</li>`;

export function settingRow(e: ConfigEntry, never: boolean, place: number): string {
  const def = `default ${shown(e.default)}`;
  const control = controlOf(e);
  const meta = e.locked ? `<span class="badge" title="Fixed by the deploy · ${esc(def)}">Locked</span>` : "";
  // Reset where the control can't simply pick the default (a switch, a choice can): in the line that says who set it.
  const reset =
    e.source == "set" && !e.locked && control != "switch" && control != "choice"
      ? ` · <button type="button" class="reset" title="Back to ${esc(shown(e.default))}">Reset</button>`
      : "";
  // Under each setting: when it was last set, and by whom (its default on hover).
  const set =
    e.source == "set"
      ? `<p class="set"><span title="${esc(def)}">${e.updated != null ? `Set ${esc(setAt(e.updated))}${e.updatedBy ? ` by ${esc(byLine(e.updatedBy, e.updatedVia))}` : ""}` : "Set"}</span>${reset}</p>`
      : "";
  // Save for what's typed in.
  const buttons = e.locked || control == "switch" || control == "choice" ? "" : `<button class="pill save" disabled>Save</button>`;
  return `  <li class="setting" data-key="${esc(e.key)}" data-control="${control}" data-live="setting:${esc(e.key)}" data-sort="${place}">
    <div class="about">
      <div class="head"><label class="key" for="set-${esc(e.key)}" title="${esc(e.key)}">${esc(e.label ?? e.key)}</label>${meta ? `<span class="meta">${meta}</span>` : ""}</div>
      ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ""}
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

/** A secret only the deploy sets: whether this server has it, and what it is for. */
function deploySecretRow(d: DeploySecretEntry): string {
  const state = d.set
    ? `<span class="badge ok">Set</span>`
    : `<span class="badge"${d.standIn ? ` title="The session secret stands in"` : ""}>Not set</span>`;
  return `  <li class="deploy-secret" data-env="${esc(d.env)}"><div class="about"><code class="key">${esc(d.env)}</code><p class="desc">${esc(d.description)}</p></div>${state}</li>`;
}

/** The Sites row's key among the page's live rows. */
const SITES = "setting:sites";

/**
 * The Sites row: one line for each domain, with the document that has it (server/sites/). It only shows the links: a
 * person changes them in the document's settings ("Publish to"), which read the same state.
 */
async function sitesRow(platform: Platform, session: Session, origin: string, place: number): Promise<string> {
  const erga = ergaName(platform, origin);
  const sites = await sitesOf(platform);
  const lines = await Promise.all(
    sites.map(async ({ domain, status }) => {
      const doc = status.doc ? await platform.directory.get(status.doc) : null;
      const own = status.live && status.live.doc == status.doc ? status.live : null;
      const linked = doc
        ? `<a href="${esc(link(addressOf(doc), session))}">${esc(doc.title)}</a>`
        : `<span class="free">${status.doc ? "missing" : "Free"}</span>`;
      const state = !status.doc
        ? ""
        : own
          ? `<span class="dot on" aria-hidden="true"></span>Published${own.version != null ? ` v${own.version}` : ""}`
          : `<span class="dot" aria-hidden="true"></span>Not published`;
      return `<tr data-domain="${esc(domain == ERGA ? "erga" : domain)}"><td class="domain">${esc(domainName(domain, erga))}</td><td>${linked}</td><td class="state">${state}</td></tr>`;
    })
  );
  // The link made last: when, and by whom.
  const last = sites.filter((s) => s.status.linked).sort((a, b) => b.status.linked!.at - a.status.linked!.at)[0];
  const set = last
    ? `<p class="set">${esc(domainName(last.domain, erga))} set ${esc(setAt(last.status.linked!.at))}${last.status.linked!.by ? ` by ${esc(last.status.linked!.by)}` : ""}</p>`
    : "";
  return `  <li class="sites" data-live="${SITES}" data-sort="${place}">
    <p class="key">Sites</p>
    <p class="desc">The document published to each domain. To publish a document, use the document settings in the editor.</p>
    <table class="site-list"><tbody>${lines.join("")}</tbody></table>
    ${set}
  </li>`;
}

/** Whether a setting takes null (never, or no limit) as well as its kind of value. */
function takesNever(platform: Platform, key: string): boolean {
  try {
    return (platform.directory.config.settings as Settings)[key]?.parse(null) === null;
  } catch {
    return false;
  }
}

/** The rows of the settings that `pick` takes, in their order, each in the control its kind needs. */
export async function settingRows(platform: Platform, session: Session, pick: (key: string) => boolean, fresh = false) {
  if (fresh) platform.directory.config.forget();
  const settings = (await platform.directory.config.list(whoOf(session))).filter((e) => pick(e.key));
  return settings.map((e, i) => ({ key: `setting:${e.key}`, html: settingRow(e, takesNever(platform, e.key), i * 2), place: i * 2 }));
}

/** The rows /admin/settings shows, in its order: each setting, and the Sites row after delete_docs_after_hours. */
async function shownSettings(platform: Platform, session: Session, origin: string, fresh = false) {
  // The Access page's settings are set there, and the agents' on the Agents page.
  const rows = await settingRows(platform, session, (key) => !ACCESS_SETTINGS.includes(key) && !AGENT_SETTINGS.includes(key), fresh);
  const place =
    Math.max(
      0,
      rows.findIndex((r) => r.key == "setting:delete_docs_after_hours")
    ) *
      2 +
    1;
  return [...rows, { key: SITES, html: await sitesRow(platform, session, origin, place), place }].sort((a, b) => a.place - b.place);
}

/** /admin: the server's settings. */
export async function settingsPage(platform: Platform, session: Session, origin: string) {
  const [rows, users, use, deployed] = await Promise.all([
    shownSettings(platform, session, origin),
    platform.directory.users.list(whoOf(session)),
    pageLlmUsage(platform.directory),
    platform.directory.credentials.deployed(whoOf(session)),
  ]);
  return adminPage({
    session,
    title: "Settings",
    here: "settings",
    body: `
  <section aria-labelledby="page-head">
    <ol class="rows settings" data-live-kind="setting" data-live-view="settings" data-live-order="asc" data-live-at="${Date.now()}">
${rows.map((r) => r.html).join("\n")}
    </ol>
    <datalist id="user-logins">${users.map((u) => `<option value="${esc(u.login)}">`).join("")}</datalist>
  </section>${pageLlmSection(use, session)}
  <section class="deploy-secrets" aria-labelledby="deploy-head">
    <h3 class="sub-head" id="deploy-head">Set by the deploy</h3>
    <ol class="rows">
${deployed.map(deploySecretRow).join("\n")}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/** The rows of /admin/settings that `keys` name ("setting:<key>"), as they are now, for an open page (server/news/). */
export const settingsRows: LiveRows = async (platform, session, keys, origin) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  for (const r of await shownSettings(platform, session, origin, true)) if (r.key in out) out[r.key] = { html: r.html, sort: r.place };
  return out;
};

