// Settings: a dialog on every page of someone signed in (the agent's bundle loads it when it's first asked for,
// client/agent/person-agent.ts). The account menu's Settings opens it, and so does any link to "#settings" (an
// address with #settings opens it as the page loads). It holds, top to bottom:
//
//   - Agent: the person's own API keys, one row for each provider: whether it's set (its last four characters), a box
//     to paste a new one, Save, and Remove. Their key runs every model of its provider in their agent, and wins over
//     the server's. Save sends it to POST /api/agent/keys, never anywhere else; the list and Remove are the operations
//     list_my_api_keys and clear_my_api_key. The agent's panel hears "erga:agent-keys" and reads its models again.
//   - Tokens: the person's agent tokens (list_tokens) with Revoke (revoke_token); New token makes one (POST
//     /tokens/new), shown once, with the lines to give an agent.
//   - Test token: a token for running the test suite here, as test people (GET /tokens/test).
//
// A key or a token is never in the page's address, its storage or the conversation. Its class names stay clear of the
// app pages' own (client/inline/app.css: header, .new, .empty): the dialog is on all of them.

import { runTool } from "../common/tools";
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

const SCOPES: Record<string, string> = { document: "One document", documents: "All my documents", admin: "Admin" };
/** In local development the page's ?user= says who is signed in: the calls go as them too. */
const user = () => {
  const u = new URLSearchParams(location.search).get("user");
  return u ? `?user=${encodeURIComponent(u)}` : "";
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
  void Promise.all([keys(), tokens(), testToken()]);
}

function make(): HTMLDialogElement {
  document.head.insertAdjacentHTML("beforeend", `<style>${STYLE}</style>`);
  const d = document.createElement("dialog");
  d.id = "erga-settings";
  d.setAttribute("aria-labelledby", "erga-settings-title");
  d.innerHTML = `<header><h2 id="erga-settings-title">Settings</h2><button type="button" class="close" aria-label="Close">✕</button></header>
<section class="keys" aria-labelledby="erga-settings-keys"><h3 id="erga-settings-keys">Agent</h3>
<p class="sub">Your own API keys. Your key runs every model of its provider in your agent, and wins over the server's. Only your agent uses it. Erga keeps it encrypted and never shows it again.</p>
<ul class="rows"></ul></section>
<section class="tokens" aria-labelledby="erga-settings-tokens"><h3 id="erga-settings-tokens">Tokens</h3>
<p class="sub">A token lets an outside agent or a script (Claude Code, Codex, git) act as you, within its scope.</p>
<div class="made" hidden></div><ul class="rows"></ul>
<form class="make"><label>Name <input name="label" maxlength="80" placeholder="What it's for: Claude Code on my laptop" autocomplete="off"></label>
<label>Scope <select name="scope"><option value="documents">All my documents</option><option value="document">One document</option></select></label>
<label class="doc" hidden>Document <select name="doc"></select></label>
<label>Expires <input type="date" name="expires" aria-label="Expiry date (optional)"></label>
<button class="pill">Make token</button><p class="hint" role="status"></p></form></section>
<section class="test" aria-labelledby="erga-settings-test"><h3 id="erga-settings-test">Test token</h3>
<p class="sub">Runs the test suite here, as test people, on test documents only.</p><pre></pre></section>`;
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
  return d;
}

const $ = <T extends Element = HTMLElement>(sel: string) => dialog!.querySelector<T>(sel)!;

// ---------------------------------------------------------------- Agent: the person's own keys

async function keys() {
  const list = $("section.keys ul");
  const rows = await runTool<Key[]>("list_my_api_keys").catch((e: Error) => e);
  if (rows instanceof Error) {
    list.innerHTML = `<li class="error">${esc(rows.message)}</li>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (k) => `<li data-name="${esc(k.name)}"><div class="what"><b>${esc(k.label)}</b> <span class="state">${
        k.unreadable ? "Stored, but this server can't open it: paste it again." : k.set ? `Set · ends in …${esc(k.last4 ?? "")}` : "Not set"
      }</span></div>
<form><input type="password" name="value" aria-label="${esc(k.label)}" placeholder="${k.set ? "Paste a new key" : "Paste your key"}" autocomplete="off" autocapitalize="off" spellcheck="false" required><button class="pill">${k.set ? "Replace" : "Save"}</button>${k.set ? `<button type="button" class="pill remove">Remove</button>` : ""}</form>
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
      const r = await fetch(`/api/agent/keys${user()}`, {
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
        await runTool("clear_my_api_key", { name });
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

async function tokens() {
  const list = $("section.tokens ul.rows");
  const [rows, docs, me] = await Promise.all([
    runTool<Token[]>("list_tokens").catch((e: Error) => e),
    runTool<{ id: string; title: string; address: string }[]>("list_documents").catch(() => []),
    runTool<{ adminPower?: boolean }>("whoami").catch(() => ({ adminPower: false })),
  ]);
  const doc = $<HTMLSelectElement>("select[name=doc]");
  doc.innerHTML = docs.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (${esc(d.address)})</option>`).join("");
  const scope = $<HTMLSelectElement>("select[name=scope]");
  if (me.adminPower && !scope.querySelector("option[value=admin]")) scope.append(new Option("Admin", "admin"));
  if (rows instanceof Error) {
    list.innerHTML = `<li class="error">${esc(rows.message)}</li>`;
    return;
  }
  list.innerHTML = rows.length
    ? rows
        .map(
          (
            t
          ) => `<li data-id="${esc(t.id)}"><div class="what"><b>${esc(t.label)}</b> <span class="state">${esc(SCOPES[t.scope] ?? t.scope)}${t.kind == "share" ? " · Share button" : ""} · expires ${esc(day(t.expires))} · last used ${esc(day(t.lastUsed))}</span></div>
<button type="button" class="pill revoke">Revoke</button></li>`
        )
        .join("")
    : `<li class="none">No tokens yet.</li>`;
  for (const li of list.querySelectorAll<HTMLElement>("li[data-id]"))
    li.querySelector(".revoke")!.addEventListener("click", async () => {
      if (!confirm(`Revoke “${li.querySelector("b")!.textContent}”? Agents using it lose access at once.`)) return;
      try {
        await runTool("revoke_token", { id: li.dataset.id });
        li.remove();
      } catch (err) {
        alert((err as Error).message);
      }
    });
}

async function makeToken(form: HTMLFormElement) {
  const hint = form.querySelector(".hint")!;
  const f = new FormData(form);
  hint.textContent = "Making it…";
  const r = await fetch(`/tokens/new${user()}`, {
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
<pre class="secret">${esc(t)}</pre><p>Tell your agent:</p>
<pre>Erga's API is at ${esc(o)}: read ${esc(o)}/llms.txt first. My token is ${esc(t)}
(send it as "Authorization: Bearer &lt;token&gt;").</pre><p>Or add Erga to Claude Code:</p>
<pre>claude mcp add --transport http erga ${esc(o)}/mcp --header "Authorization: Bearer ${esc(t)}"</pre>
<button type="button" class="pill copy">Copy token</button>`;
  made.hidden = false;
  made.querySelector<HTMLElement>(".copy")!.addEventListener("click", (e) => {
    void navigator.clipboard.writeText(t).then(() => showCopied(e.currentTarget as HTMLElement));
  });
  await tokens();
}

async function testToken() {
  const pre = $("section.test pre");
  const r = await fetch(`/tokens/test${user()}`).catch(() => null);
  const body = (r?.ok ? await r.json().catch(() => null) : null) as { token: string; expires: string } | null;
  pre.textContent = body ? `ERGA_TEST_TOKEN=${body.token} bun run test:prod` : "Couldn't make one: try again.";
  $("section.test .sub").textContent =
    `Runs the test suite here, as test people, on test documents only. Until ${body ? day(body.expires) : "…"}.`;
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
#erga-settings form.make { margin-top: 10px; }
#erga-settings form.make label { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--soft); }
#erga-settings pre { margin: 6px 0; padding: 8px 10px; background: var(--code-bg); border-radius: 8px; font: 12.5px/1.45 var(--font-mono);
  white-space: pre-wrap; overflow-wrap: anywhere; }
#erga-settings .made { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--panel-border); border-radius: 10px; }
#erga-settings .made p { margin: 4px 0; }
`;
