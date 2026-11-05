// /admin/api-keys, the API keys page (client/inline/admin-api-keys.ts): whose keys the agents use (the agent_keys
// setting), and, when the server provides them, one row for each provider: its key (set, replace, clear) and, once the
// server has one, the provider's models it runs (the agent_models_off setting holds the ones not ticked). Then the
// secrets only the deploy sets, folded away.

import type { CredentialEntry, DeploySecretEntry } from "../directory/index.ts";
import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { setAt } from "./parts.ts";
import { MODELS, type ModelChoice } from "../../shared/models.ts";

/** The providers' models, by provider. */
const modelsOf = (name: string) => (Object.keys(MODELS) as ModelChoice[]).filter((m) => MODELS[m].provider == name);

/**
 * A provider's row: its name and the key's state; a box to paste a key (always empty: the page never has the key),
 * Save, Clear; and, once the server has a key for it (stored, or the deploy's), its models, each ticked if available.
 */
export function credentialRow(c: CredentialEntry, session: Session, place: number, off: readonly string[]): string {
  const id = `key-${c.name}`;
  const has = (c.set && !c.unreadable) || (!c.set && c.fallback);
  const state = c.unreadable
    ? `<span class="bad">Saved, but this server can't open it. Paste it again.</span>`
    : c.set
      ? `<span class="on">Key saved</span> · <code>…${esc(c.last4 ?? "")}</code>${c.updated != null ? ` · ${esc(setAt(c.updated))}${c.updatedBy ? ` by ${esc(byLine(c.updatedBy, c.updatedVia))}` : ""}` : ""}`
      : c.fallback
        ? `<span class="on">Using the deploy's</span> <code>${esc(c.env)}</code>`
        : "No key";
  const models = has
    ? `<div class="models" role="group" aria-label="${esc(c.service)} models available"><span class="label">Models</span>${modelsOf(c.name)
        .map((m) => `<label><input type="checkbox" value="${esc(m)}"${off.includes(m) ? "" : " checked"}> ${esc(MODELS[m].label)}</label>`)
        .join("")}</div>`
    : "";
  return `  <li class="provider" data-live="apikey:${esc(c.name)}" data-sort="${place}" data-name="${esc(c.name)}" data-label="${esc(c.label)}" data-env="${esc(c.env)}"${c.fallback ? ` data-fallback="1"` : ""}>
    <div class="about"><label class="key" for="${id}">${esc(c.service)}</label><p class="state">${state}</p></div>
    <form class="value" method="post" action="${esc(link("/admin/credentials", session))}">
      <input class="input secret" type="password" name="value" id="${id}" aria-label="${esc(c.label)}" placeholder="${c.set ? "Paste a new key" : "Paste the key"}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false"${c.canStore ? "" : ` disabled title="This server has no FACTORY_KEY, so it can't store a key."`}>
      <button class="pill save" disabled>${c.set ? "Replace" : "Save"}</button>${c.set ? `<button type="button" class="pill clear">Clear</button>` : ""}
    </form>
    ${models}
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

/** /admin/api-keys. The page never has a key. */
export async function apiKeysPage(platform: Platform, session: Session) {
  const who = whoOf(session);
  const [credentials, deployed, mode, off] = await Promise.all([
    platform.directory.credentials.list(who),
    platform.directory.credentials.deployed(who),
    platform.directory.config.get("agent_keys"),
    platform.directory.config.get("agent_models_off"),
  ]);
  const own = mode == "own";
  return adminPage({
    session,
    title: "API keys",
    here: "keys",
    lede: "The keys the agents use to call the model providers.",
    body: `
  <section aria-labelledby="page-head" class="credentials">
    <ol class="rows settings">
      <li class="setting">
        <div class="about"><label class="key" for="agent-keys" title="agent_keys">Whose keys the agents use</label><p class="desc">A person's own key always wins for its provider.</p></div>
        <div class="value"><select id="agent-keys" class="keys-mode">
          <option value="server"${own ? "" : " selected"}>Server will provide keys</option>
          <option value="own"${own ? " selected" : ""}>Users provide their own keys</option>
        </select></div>
        <p class="hint" id="keys-mode-hint" role="status"></p>
      </li>
    </ol>
    <p class="empty own-note"${own ? "" : " hidden"}>Each person adds their own keys in their Settings.</p>
    <ol class="rows providers" data-live-kind="apikey" data-live-view="api-keys" data-live-order="asc" data-live-at="${Date.now()}"${own ? " hidden" : ""}>
${credentials.map((c, place) => credentialRow(c, session, place, off)).join("\n")}
    </ol>
  </section>
  <section class="deploy-secrets" aria-labelledby="deploy-head">
    <h3 class="sub-head" id="deploy-head">Set by the deploy</h3>
    <p class="lede">Worker secrets. Only a deploy changes them.</p>
    <ol class="rows">
${deployed.map(deploySecretRow).join("\n")}
    </ol>
  </section>
<script>${TIMES_SCRIPT}${inlineCall("admin-api-keys")}</script>`,
  });
}

/** The rows of /admin/api-keys that `keys` name ("apikey:<name>"), as they are now, for an open page (server/news/). */
export const apiKeysRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  const off = await platform.directory.config.get("agent_models_off");
  (await platform.directory.credentials.list(whoOf(session))).forEach((c, place) => {
    if (`apikey:${c.name}` in out) out[`apikey:${c.name}`] = { html: credentialRow(c, session, place, off), sort: place };
  });
  return out;
};
