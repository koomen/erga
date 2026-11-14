// Settings: a dialog on every page of someone signed in (the agent's bundle loads it when it's first asked for,
// client/agent/person-agent.ts). The account menu's Settings opens it, and so does any link to "#settings" (an
// address with #settings opens it as the page loads). It holds, top to bottom:
//
//   - Agent: the person's own API keys, one row for each provider: whether it's set (its last four characters), a box
//     to paste a new one, Save, and Remove. Their key runs every model of its provider in their agent, and wins over
//     the server's. Save sends it to POST /api/agent/keys, never anywhere else; the list and Remove are the operations
//     whoami (its apiKeys) and revoke. The agent's panel hears "erga:agent-keys" and reads its models again.
//   - Tokens: the person's agent tokens (whoami's tokens), newest first: the first SHOWN, then "N more" and Show 10
//     more, which asks whoami for the next MORE. Each has Revoke (revoke). An expired token isn't listed (whoami). New
//     token makes one (POST /tokens/new), shown once, with the lines to give an agent.
//
// A key or a token is never in the page's address, its storage or the conversation. Its class names stay clear of the
// app pages' own (client/inline/app.css: header, .new, .empty): the dialog is on all of them.

import { asUser, runTool, WHOLE_LIST } from "../common/tools";
import { showCopied } from "../common/copied";
import { esc } from "../../shared/html";

interface Key {
  name: string;
  label: string;
  set: boolean;
  last4: string | null;
  updated: string | null;
  unreadable?: string;
}
interface Token {
  id: string;
  label: string;
  kind: string;
  scope: string;
  document?: string;
  expires: string | null;
  created: string;
  lastUsed: string | null;
}

const SCOPES: Record<string, string> = {
  document: "One document",
  documents: "All my documents",
  admin: "Admin",
  ops: "Ops (deploy facts)",
};
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Never";

let dialog: HTMLDialogElement | null = null;

/** Opens the dialog (made the first time), with each part read again. */
export function openSettings(): void {
  dialog ??= make();
  // A new token shows once: never again after the dialog closes.
  const made = dialog.querySelector<HTMLElement>(".made")!;
  made.hidden = true;
  made.textContent = "";
  if (!dialog.open) dialog.showModal();
  void Promise.all([keys(), tokens()]);
}

function make(): HTMLDialogElement {
  document.head.insertAdjacentHTML("beforeend", `<style>${STYLE}</style>`);
  const d = document.createElement("dialog");
  d.id = "erga-settings";
  d.setAttribute("aria-labelledby", "erga-settings-title");
  d.innerHTML = `<header><h2 id="erga-settings-title">Settings</h2><button type="button" class="close" aria-label="Close">✕</button></header>
<section class="keys" aria-labelledby="erga-settings-keys"><h3 id="erga-settings-keys">Agent</h3>
<p class="sub">Your own API keys, for your agent only. A saved key is never shown again.</p>
<ul class="rows"></ul></section>
<section class="tokens" aria-labelledby="erga-settings-tokens"><h3 id="erga-settings-tokens">Tokens</h3>
<p class="sub">A token lets an outside agent or script act as you.</p>
<div class="made" hidden></div><ul class="rows"></ul>
<p class="more" hidden><span></span> <button type="button" class="pill">Show 10 more</button></p>
<form class="make"><label>Name <input name="label" maxlength="80" placeholder="Claude Code on my laptop" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore></label>
<label>Scope <select name="scope"><option value="documents">All my documents</option><option value="document">One document</option></select></label>
<label class="doc" hidden>Document <select name="doc"></select></label>
<label>Expires <input type="date" name="expires" aria-label="Expiry date (optional)"></label>
<button class="pill">Make token</button><p class="hint" role="status"></p></form></section>`;
  document.body.append(d);
  d.querySelector(".close")!.addEventListener("click", () => d.close());
  // A click on the backdrop (the dialog itself, outside its content) closes it.
  d.addEventListener("click", (e) => {
    if (e.target == d) d.close();
  });
  const form = d.querySelector<HTMLFormElement>("form.make")!;
  const scope = form.elements.namedItem("scope") as HTMLSelectElement;
  scope.addEventListener("change", () => (d.querySelector<HTMLElement>("label.doc")!.hidden = scope.value != "document"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void makeToken(form);
  });
  d.querySelector("p.more button")!.addEventListener("click", () => void showMore());
  return d;
}

const $ = <T extends Element = HTMLElement>(sel: string) => dialog!.querySelector<T>(sel)!;

// ---------------------------------------------------------------- Agent: the person's own keys

async function keys() {
  const list = $("section.keys ul");
  const rows = await runTool<{ apiKeys: Key[] }>("whoami").then(
    (w) => w.apiKeys,
    (e: Error) => e
  );
  if (rows instanceof Error) {
    list.innerHTML = `<li class="error">${esc(rows.message)}</li>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (k) => `<li data-name="${esc(k.name)}"><div class="what"><b>${esc(k.label)}</b> <span class="state">${
        k.unreadable ? "Stored, but this server can't open it: paste it again." : k.set ? `Set · ends in …${esc(k.last4 ?? "")}` : "Not set"
      }</span></div>
<form><input type="password" name="value" aria-label="${esc(k.label)}" placeholder="${k.set ? "Paste a new key" : "Paste your key"}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" required><button class="pill">${k.set ? "Replace" : "Save"}</button>${k.set ? `<button type="button" class="pill remove">Remove</button>` : ""}</form>
<p class="hint" role="status"></p></li>`
    )
    .join("");
  for (const li of list.querySelectorAll<HTMLElement>("li[data-name]")) {
    const name = li.dataset.name!,
      hint = li.querySelector(".hint")!,
      form = li.querySelector("form")!;
    const said = (text: string, error = false) => {
      hint.textContent = text;
      hint.classList.toggle("error", error);
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const field = form.elements.namedItem("value") as HTMLInputElement;
      said("Saving…");
      const r = await fetch(asUser("/api/agent/keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value: field.value }),
      }).catch(() => null);
      const body = (r ? await r.json().catch(() => ({})) : {}) as { ok?: boolean; error?: string };
      field.value = "";
      if (!r?.ok || !body.ok) return said(body.error ?? "Couldn't reach the server: try again.", true);
      changed();
      await keys();
    });
    li.querySelector(".remove")?.addEventListener("click", async () => {
      said("Removing…");
      try {
        await runTool("revoke", { api_key: name });
        changed();
        await keys();
      } catch (err) {
        said((err as Error).message, true);
      }
    });
  }
}

/** The agent's panel reads its models again (client/agent/person-agent.ts). */
const changed = () => window.dispatchEvent(new Event("erga:agent-keys"));

// ---------------------------------------------------------------- Tokens

/** How many tokens show at first, and how many more each Show 10 more adds. */
const SHOWN = 5,
  MORE = 10;
type Mine = { adminPower?: boolean; tokens: Token[]; moreTokens: number };

/** The loads of the list so far. The rows of the last time stay while one runs: Show 10 more waits for its end. */
let loads = 0;
const moreButton = () => $<HTMLButtonElement>("section.tokens p.more button");

async function tokens() {
  const list = $("section.tokens ul.rows");
  const load = ++loads;
  moreButton().disabled = true;
  const [me, docs] = await Promise.all([
    runTool<Mine>("whoami", { limit: SHOWN }).catch((e: Error) => e),
    runTool<{ documents: { id: string; title: string; address: string }[] }>("list_documents", WHOLE_LIST).then(
      (l) => l.documents,
      () => []
    ),
  ]);
  // (A newer load draws the list.)
  if (load != loads) return;
  moreButton().disabled = false;
  const doc = $<HTMLSelectElement>("select[name=doc]");
  doc.innerHTML = docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (${esc(d.address)})</option>`).join("");
  const scope = $<HTMLSelectElement>("select[name=scope]");
  if (!(me instanceof Error) && me.adminPower && !scope.querySelector("option[value=admin]")) scope.append(new Option("Admin", "admin"));
  if (me instanceof Error) {
    list.innerHTML = `<li class="error">${esc(me.message)}</li>`;
    moreTokens(0);
    return;
  }
  list.innerHTML = me.tokens.length ? "" : `<li class="none">No tokens yet.</li>`;
  addTokens(me.tokens);
  moreTokens(me.moreTokens);
}

/** Show 10 more: the next tokens after the rows shown, from the server. */
async function showMore() {
  const button = moreButton(),
    load = loads;
  button.disabled = true;
  const shown = $("section.tokens ul.rows").querySelectorAll("li[data-id]").length;
  try {
    const me = await runTool<Mine>("whoami", { limit: MORE, offset: shown });
    // (The list loaded again meanwhile: these rows are after others than its rows.)
    if (load != loads) return;
    const first = addTokens(me.tokens);
    moreTokens(me.moreTokens);
    // The keyboard stays on the button, or goes to the first new row when there's no more.
    if (!me.moreTokens) first?.querySelector<HTMLElement>(".revoke")?.focus();
  } catch (err) {
    alert((err as Error).message);
  } finally {
    if (load == loads) button.disabled = false;
  }
}

/** "N more" under the list, with Show 10 more (Show N more for fewer); hidden when there are none. */
function moreTokens(n: number) {
  const p = $("section.tokens p.more");
  p.hidden = n <= 0;
  p.querySelector("span")!.textContent = `${n} more`;
  p.querySelector("button")!.textContent = `Show ${Math.min(n, MORE)} more`;
}

/** Rows for `rows` at the end of the list, each with Revoke; the first of them. */
function addTokens(rows: Token[]): HTMLElement | null {
  const list = $("section.tokens ul.rows");
  let first: HTMLElement | null = null;
  for (const t of rows) {
    list.insertAdjacentHTML(
      "beforeend",
      `<li data-id="${esc(t.id)}"><div class="what"><b>${esc(t.label)}</b> <span class="state">${esc(SCOPES[t.scope] ?? t.scope)}${t.kind == "share" ? " · Share button" : ""} · expires ${esc(day(t.expires))} · last used ${esc(day(t.lastUsed))}</span></div>
<button type="button" class="pill revoke">Revoke</button></li>`
    );
    const li = list.lastElementChild as HTMLElement;
    first ??= li;
    li.querySelector(".revoke")!.addEventListener("click", async () => {
      if (!confirm(`Revoke “${li.querySelector("b")!.textContent}”? Agents using it lose access at once.`)) return;
      try {
        await runTool("revoke", { token: li.dataset.id });
        li.remove();
        // The last row shown went: the next ones, or "No tokens yet".
        if (!list.querySelector("li[data-id]")) await tokens();
      } catch (err) {
        alert((err as Error).message);
      }
    });
  }
  return first;
}

async function makeToken(form: HTMLFormElement) {
  const hint = form.querySelector(".hint")!;
  const f = new FormData(form);
  hint.textContent = "Making it…";
  const r = await fetch(asUser("/tokens/new"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: f.get("label"),
      scope: f.get("scope"),
      ...(f.get("scope") == "document" ? { doc: f.get("doc") } : {}),
      expires: f.get("expires"),
    }),
  }).catch(() => null);
  const body = (r ? await r.json().catch(() => ({})) : {}) as { ok?: boolean; error?: string; token?: string; info?: Token };
  if (!r?.ok || !body.ok || !body.token || !body.info) {
    hint.textContent = body.error ?? "Couldn't reach the server: try again.";
    return;
  }
  hint.textContent = "";
  form.reset();
  const o = location.origin,
    t = body.token;
  const made = $("section.tokens .made");
  made.innerHTML = `<p><b>${esc(body.info.label)}</b>: ${esc(SCOPES[body.info.scope] ?? body.info.scope)}. Copy it now: it isn't shown again.</p>
<pre class="secret">${esc(t)}</pre><p>Add Erga to Claude Code:</p>
<pre>claude mcp add --transport http erga ${esc(o)}/mcp --header "Authorization: Bearer ${esc(t)}"</pre><p>Or tell another agent:</p>
<pre>Erga's MCP server is ${esc(o)}/mcp. Send my token as "Authorization: Bearer ${esc(t)}".</pre>
<button type="button" class="pill copy">Copy token</button>`;
  made.hidden = false;
  made.querySelector<HTMLElement>(".copy")!.addEventListener("click", (e) => {
    void navigator.clipboard.writeText(t).then(() => showCopied(e.currentTarget as HTMLElement));
  });
  await tokens();
}

const STYLE = `
#erga-settings { width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 0; border: 1px solid var(--panel-border);
  border-radius: 14px; background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font: 14px/1.45 var(--font-text); overflow: auto; }
#erga-settings [hidden] { display: none !important; }
#erga-settings::backdrop { background: rgba(0, 0, 0, 0.25); }
#erga-settings header { position: sticky; top: 0; margin: 0; gap: 12px; display: flex; align-items: center; justify-content: space-between; padding: 14px 20px;
  background: var(--bg); border-bottom: 1px solid var(--rule); }
#erga-settings h2 { margin: 0; font-size: 18px; color: var(--fg-strong); }
#erga-settings h3 { margin: 0 0 4px; font-size: 15px; color: var(--fg-strong); }
#erga-settings section { padding: 16px 20px; border-bottom: 1px solid var(--rule); }
#erga-settings section:last-child { border-bottom: 0; }
#erga-settings .sub { margin: 0 0 10px; color: var(--soft); }
#erga-settings .close { border: 0; background: none; color: var(--chrome); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
#erga-settings .close:hover { color: var(--chrome-hover); background: var(--code-bg); }
#erga-settings ul.rows { list-style: none; margin: 0; padding: 0; }
#erga-settings ul.rows > li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 0; border-top: 1px solid var(--rule); }
#erga-settings ul.rows > li:first-child { border-top: 0; }
#erga-settings .what { flex: 1 1 220px; min-width: 0; }
#erga-settings .state { display: block; color: var(--soft); font-size: 13px; }
#erga-settings form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#erga-settings input, #erga-settings select { font: inherit; padding: 5px 8px; border: 1px solid var(--panel-border); border-radius: 7px; background: var(--bg); color: var(--fg); }
#erga-settings .pill { font: inherit; height: auto; padding: 5px 12px; border: 1px solid var(--panel-border); border-radius: 999px; background: var(--code-bg); color: var(--fg); cursor: pointer; }
#erga-settings .pill:hover { border-color: var(--chrome); }
#erga-settings .hint { flex-basis: 100%; margin: 0; color: var(--soft); font-size: 13px; }
#erga-settings .hint:empty { display: none; }
#erga-settings .hint.error, #erga-settings li.error { color: #c0392b; }
#erga-settings p.more { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0; padding: 8px 0 0; border-top: 1px solid var(--rule);
  color: var(--soft); font-size: 13px; }
#erga-settings p.more span { flex: 1 1 auto; }
#erga-settings form.make { margin-top: 10px; }
#erga-settings form.make label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--soft); }
#erga-settings pre { margin: 6px 0; padding: 8px 10px; background: var(--code-bg); border-radius: 8px; font: 12.5px/1.45 var(--font-mono);
  white-space: pre-wrap; overflow-wrap: anywhere; }
#erga-settings .made { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--panel-border); border-radius: 10px; }
#erga-settings .made p { margin: 4px 0; }
`;
