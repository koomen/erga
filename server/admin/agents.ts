// /admin/agents, the Agents and models page (client/inline/admin-agents.ts): everything that governs the models this
// server runs. The users' agents: whose keys they use (the agent_keys setting); when the server provides them, one row
// for each provider: its key (set, replace, remove: the page shows only its last 4 characters) and, once the server
// has one, the provider's models it runs (the agent_models_off setting holds the ones not ticked); and the daily token
// limit for each user. Then the Document LLM API, which runs on the same keys: its switch and, while it is on, whether
// viewers who aren't signed in may call it, its daily spend limit, the most tokens for an answer, and the models a document's author may choose (a box
// for each model that is ticked above; the document_llm_models_off setting holds the ones not ticked); and its use this month (./page-llm.ts). The setting rows
// are ./settings.ts's, saved by client/inline/admin-settings.ts.

import type { CredentialEntry } from "../directory/index.ts";
import { inlineCall, link, TIMES_SCRIPT } from "../pages/index.ts";
import { esc } from "../../shared/html.ts";
import { type LiveRow, type LiveRows, type Platform, type Session, whoOf } from "../platform.ts";
import { byLine } from "../../shared/attribution.ts";
import { adminPage } from "./layout.ts";
import { setAt } from "./parts.ts";
import { pageLlmSection, pageLlmUsage } from "./page-llm.ts";
import { chip, PAGE_SETTINGS, settingLiveRows, settingsSection } from "./settings.ts";
import { MODELS, type ModelChoice } from "../../shared/models.ts";

/** The providers' models, by provider. */
const modelsOf = (name: string) => (Object.keys(MODELS) as ModelChoice[]).filter((m) => MODELS[m].provider == name);

/**
 * A provider's row: its name and the key's state. A key that is set shows as its last 4 characters ("•••• abcd": the
 * page never has the key), with Replace, which opens the box to paste another, and Remove. With no key, the box to
 * paste one shows at once. A pasted key saves by itself (client/inline/admin-agents.ts). Once the server has a key
 * (stored, or the deploy's), its models, each ticked if available.
 */
export function credentialRow(c: CredentialEntry, session: Session, place: number, off: readonly string[]): string {
  const id = `key-${c.name}`;
  const has = (c.set && !c.unreadable) || (!c.set && c.fallback);
  const state = c.unreadable
    ? `<span class="bad">Saved, but this server can't open it. Paste it again.</span>`
    : c.set
      ? `${c.updated != null ? `Set ${esc(setAt(c.updated))}${c.updatedBy ? ` by ${esc(byLine(c.updatedBy, c.updatedVia))}` : ""}` : "Set"}`
      : c.fallback
        ? `<span class="on">Using the deploy's</span> <code>${esc(c.env)}</code>`
        : "No key";
  const models = has
    ? `<div class="models" role="group" aria-label="${esc(c.service)} models available"><span class="label">Models</span>${modelsOf(c.name)
        .map((m) => `<label><input type="checkbox" value="${esc(m)}"${off.includes(m) ? "" : " checked"}> ${esc(MODELS[m].label)}</label>`)
        .join("")}</div>`
    : "";
  // A key that the server can open: its last 4 characters, and the box closed until Replace.
  const shown = c.set && !c.unreadable;
  const now = shown
    ? `<span class="secret-now"><code class="masked" aria-label="The key ends in ${esc(c.last4 ?? "")}">•••• ${esc(c.last4 ?? "")}</code><button type="button" class="pill replace" aria-controls="${id}">Replace</button><button type="button" class="pill clear">Remove</button></span>`
    : c.set
      ? `<button type="button" class="pill clear">Remove</button>`
      : "";
  return `  <li class="provider" data-live="apikey:${esc(c.name)}" data-sort="${place}" data-name="${esc(c.name)}" data-label="${esc(c.label)}" data-env="${esc(c.env)}"${c.fallback ? ` data-fallback="1"` : ""}>
    <div class="about"><label class="key" for="${id}">${esc(c.service)}</label><p class="state">${state}</p></div>
    <form class="value" method="post" action="${esc(link("/admin/credentials", session))}">
      ${now}
      <input class="input secret" type="password" name="value" id="${id}" aria-label="${esc(c.label)}" placeholder="${c.set ? "Paste the new key" : "Paste the key"}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false"${c.canStore ? "" : ` disabled title="This server has no SECRETS_KEY, so it can't store a key."`}${shown ? " hidden" : ""}>
    </form>
    ${models}
    <p class="hint" role="status"></p>
  </li>`;
}

/** The Document LLM API's models' row, as live pages know it: its setting. */
const LLM_MODELS = "setting:document_llm_models_off";

/**
 * The Document LLM API's models: a box for each model that is ticked on the providers' rows above (a provider with a
 * key, and the model on for the agents), in that order, ticked if a document's author may choose it. A save keeps the
 * others as they are (data-off: client/inline/admin-agents.ts).
 */
function llmModelsRow(credentials: CredentialEntry[], agentsOff: readonly string[], off: readonly string[]): string {
  const keyed = credentials.filter((c) => (c.set && !c.unreadable) || (!c.set && c.fallback)).map((c) => c.name);
  const models = (Object.keys(MODELS) as ModelChoice[]).filter((m) => keyed.includes(MODELS[m].provider) && !agentsOff.includes(m));
  const boxes = models.length
    ? `<div class="models" role="group" aria-label="Document LLM API models available">${models
        .map((m) => `<label><input type="checkbox" value="${esc(m)}"${off.includes(m) ? "" : " checked"}> ${esc(MODELS[m].label)}</label>`)
        .join("")}</div>`
    : `<p class="state">No model yet: set a provider's key above, and tick a model there.</p>`;
  return `  <li class="setting llm-models" data-live="${LLM_MODELS}" data-sort="0" data-off="${esc(off.join(" "))}">
    <div class="about"><span class="key" title="document_llm_models_off">Models</span><p class="desc">The models that a document's author can choose, of the ones ticked above.</p></div>
    ${boxes}
    <p class="hint" role="status"></p>
  </li>`;
}

/** /admin/agents. The page never has a key. */
export async function agentsPage(platform: Platform, session: Session) {
  const who = whoOf(session);
  const { config } = platform.directory;
  const credentials = await platform.directory.credentials.list(who);
  const [limit, llmApi, llmApiOn, use, mode, off, llmOff] = await Promise.all([
    config
      .get("agent_keys")
      .then((keys) => settingsSection(platform, session, PAGE_SETTINGS.agents, "agents", { more: "server-only", hidden: keys == "own" })),
    settingsSection(platform, session, PAGE_SETTINGS.llmApi, "agents-llm"),
    settingsSection(platform, session, PAGE_SETTINGS.llmApiOn, "agents-llm-on"),
    pageLlmUsage(platform.directory),
    config.get("agent_keys"),
    config.get("agent_models_off"),
    config.get("document_llm_models_off"),
  ]);
  const own = mode == "own";
  return adminPage({
    session,
    title: "Agents and models",
    here: "agents",
    body: `
  <section aria-labelledby="page-head" class="credentials">
    <ol class="rows settings">
      <li class="setting">
        <div class="about"><label class="key" for="agent-keys" title="agent_keys">Whose keys the agents use</label><p class="desc">A user's own key always wins for its provider.</p></div>
        <div class="value"><select id="agent-keys" class="keys-mode">
          <option value="server"${own ? "" : " selected"}>Server will provide keys</option>
          <option value="own"${own ? " selected" : ""}>Users provide their own keys</option>
        </select></div>
        <p class="hint" id="keys-mode-hint" role="status"></p>
      </li>
    </ol>
    <p class="empty own-note"${own ? "" : " hidden"}>Each user adds their own keys in their Settings.</p>
    <ol class="rows providers" data-off="${esc(off.join(" "))}" data-live-kind="apikey" data-live-view="agents" data-live-order="asc" data-live-at="${Date.now()}"${own ? " hidden" : ""}>
${credentials.map((c, place) => credentialRow(c, session, place, off)).join("\n")}
    </ol>
    ${limit}
  </section>
  <section class="llm-api" aria-labelledby="llm-api-head">
    <h3 class="sub-head" id="llm-api-head">Document LLM API</h3>
    <p class="lede">An LLM API that users can expose to their documents.</p>
    ${llmApi}
    <div class="llm-api-on">
    <p class="empty llm-own-note"${own ? "" : " hidden"}>The API runs on the server's keys: no call runs while users provide their own keys.</p>
    ${llmApiOn}
    <ol class="rows llm-models-list" data-live-kind="setting" data-live-view="agents-llm-models" data-live-order="asc" data-live-at="${Date.now()}">
${llmModelsRow(credentials, off, llmOff)}
    </ol>
    </div>
  </section>${pageLlmSection(use, session)}
<script>${TIMES_SCRIPT}${inlineCall("admin-agents")}${inlineCall("admin-settings", { chip: chip("LOGIN", false) })}</script>`,
  });
}

/** The rows of /admin/agents that `keys` name ("apikey:<name>", "setting:<key>"), as they are now, for an open page (server/news/). */
export const agentsRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  Object.assign(out, await settingLiveRows(platform, session, keys, PAGE_SETTINGS.agents));
  const off = await platform.directory.config.get("agent_models_off");
  (await platform.directory.credentials.list(whoOf(session))).forEach((c, place) => {
    if (`apikey:${c.name}` in out) out[`apikey:${c.name}`] = { html: credentialRow(c, session, place, off), sort: place };
  });
  return out;
};

/** The rows of one of the page's other lists of settings (the Document LLM API's), each in a view of its own: every list shows setting rows. */
const llmRows =
  (of: readonly string[]) =>
  async (platform: Platform, session: Session, keys: string[]): Promise<Record<string, LiveRow>> => ({
    ...Object.fromEntries(keys.map((k) => [k, null])),
    ...(await settingLiveRows(platform, session, keys, of)),
  });
export const agentsLlmRows: LiveRows = llmRows(PAGE_SETTINGS.llmApi);
export const agentsLlmOnRows: LiveRows = llmRows(PAGE_SETTINGS.llmApiOn);
/**
 * The models' row, in a list and a view of its own, as the server's keys, the agents' models and the setting are now:
 * the page's own script saves it and keeps it live (client/inline/admin-agents.ts), since a key's change, or a box
 * above, changes it too.
 */
export const agentsLlmModelsRows: LiveRows = async (platform, session, keys) => {
  const out: Record<string, LiveRow> = Object.fromEntries(keys.map((k) => [k, null]));
  if (!keys.includes(LLM_MODELS)) return out;
  const [credentials, agentsOff, off] = await Promise.all([
    platform.directory.credentials.list(whoOf(session)),
    platform.directory.config.get("agent_models_off"),
    platform.directory.config.get("document_llm_models_off"),
  ]);
  return { ...out, [LLM_MODELS]: { html: llmModelsRow(credentials, agentsOff, off), sort: 0 } };
};
