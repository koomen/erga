// /admin/api-keys, the API keys page (client/inline/admin-api-keys.ts sets and clears them).

import type { CredentialEntry, DeploySecretEntry } from "../directory/index.ts";
import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { setAt } from "./parts.ts";
import { agentSettingRows } from "./settings.ts";

/**
 * An API key's row: its name, what uses it, whether it is set (its last four
 * characters, when and by whom) or what stands in for it, a box to paste a
 * new one, and Clear. The box is always empty: the page never has the key.
 */
export function credentialRow(c: CredentialEntry, session: Session, place: number): string {
  const id = `key-${c.name}`;
  const state = c.set
    ? `<span class="on">Set</span> · ends in <span class="last4">…${esc(c.last4 ?? "")}</span>${c.updated != null ? ` · updated ${esc(setAt(c.updated))}${c.updatedBy ? ` by ${esc(byLine(c.updatedBy, c.updatedVia))}` : ""}` : ""}`
    : c.fallback
      ? `Not set here. The server uses ${esc(c.env)} from the deploy.`
      : "Not set.";
  const cannot = !c.canStore
    ? ` <b>This server has no FACTORY_KEY, so it can't store a key.</b>`
    : c.unreadable
      ? ` <b class="unreadable">This server can't open it: it was encrypted with another server's FACTORY_KEY. Paste the key again.</b>`
      : "";
  return `  <li class="setting credential" data-live="apikey:${esc(c.name)}" data-sort="${place}" data-name="${esc(c.name)}" data-label="${esc(c.label)}" data-env="${esc(c.env)}"${c.fallback ? ` data-fallback="1"` : ""}>
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

/** A secret only the deploy sets: whether this server has it, what it is for, and why it isn't set here. */
function deploySecretRow(d: DeploySecretEntry): string {
  const state = d.set
    ? `<span class="on">Set</span> in the deploy`
    : d.standIn
      ? "Not set. The session secret stands in for it."
      : "Not set.";
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
export async function apiKeysPage(platform: Platform, session: Session) {
  const who = whoOf(session);
  const [credentials, deployed, agents] = await Promise.all([
    platform.directory.credentials.list(who),
    platform.directory.credentials.deployed(who),
    agentSettingRows(platform, session),
  ]);
  const rows = credentials.map((c, place) => credentialRow(c, session, place));
  return adminPage({
    session,
    title: "API keys",
    here: "keys",
    body: `
  <section aria-labelledby="keys-head" class="credentials">
    <h2 id="keys-head">API keys</h2>
    <p class="lede">The keys Erga uses to call other services. The server keeps each key encrypted and shows it to nobody, this page included: only whether it is set, its last four characters, and who set it when. Without a key here, the server uses the deploy's Worker secret of the same name, if it has one.</p>
    <ol class="rows" data-live-kind="apikey" data-live-view="api-keys" data-live-order="asc" data-live-at="${Date.now()}">
${rows.join("\n")}
    </ol>
  </section>
  <section aria-labelledby="agents-head" class="agent-keys">
    <h2 id="agents-head">Agents</h2>
    <p class="lede">The models in each person's agent: whose keys run them, and which of them a server key may run. A person's own key always runs every model of its provider.</p>
    <ol class="rows" data-live-kind="setting" data-live-view="agent-settings" data-live-order="asc" data-live-at="${Date.now()}">
${agents.map((r) => r.html).join("\n")}
    </ol>
  </section>
  <section aria-labelledby="deploy-head" class="deploy-secrets">
    <h2 id="deploy-head">Set in the deploy <small>read-only</small></h2>
    <p class="lede">These secrets are Worker secrets only. A wrong value here could lock every admin out, or break the other server, so this page doesn't change them. Set one with <span class="mono">bunx cf workers secrets update NAME</span>, or with <span class="mono">bun deploy/setup.ts</span>.</p>
    <ol class="rows">
${deployed.map(deploySecretRow).join("\n")}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-api-keys")}${inlineCall("admin-settings", { chip: "" })}</script>`,
  });
}

/** The rows of /admin/api-keys that `keys` name ("apikey:<name>"), as they are now, for an open page (server/news/). */
export const apiKeysRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  (await platform.directory.credentials.list(whoOf(session))).forEach((c, place) => {
    if (`apikey:${c.name}` in out) out[`apikey:${c.name}`] = { html: credentialRow(c, session, place), sort: place };
  });
  return out;
};
