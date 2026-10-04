// /admin/deploys: Erga's own deploy targets (production and staging), live:
// each one's branch, state, commit, steps and log, and Redeploy for the one
// this server deploys. It reads GET /api/deploys, and again on every
// {type: "deploys"} event (/api/events). Admins only (worker/deploys.ts).

import { appPage, brand, esc, link, type Session } from "../front";

export function deploysPage(session: Session, self: string | null): string {
  const style = `
  .lede { margin: 0 0 22px; font-size: 13.5px; color: var(--soft); }
  .back { font-size: 13px; color: var(--chrome); text-decoration: none; }
  .back:hover { color: var(--chrome-hover); }
  .targets { display: grid; gap: 22px; }
  .target { border: 1px solid var(--rule); border-radius: 10px; padding: 16px 18px; }
  .target .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
  .target h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--fg-strong); }
  .target .host { font-size: 13px; color: var(--soft); }
  .target .host a { color: inherit; }
  .target .top .grow { flex: 1; }
  .state { padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .01em; }
  .state.idle { color: var(--soft); background: color-mix(in srgb, var(--chrome) 14%, transparent); }
  .state.building, .state.deploying { color: #1d4ed8; background: color-mix(in srgb, #3b82f6 16%, transparent); }
  .state.deployed { color: #15803d; background: color-mix(in srgb, #22c55e 16%, transparent); }
  .state.failed { color: #b91c1c; background: color-mix(in srgb, #ef4444 15%, transparent); }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 10px 0 0; font-size: 13px; color: var(--soft); }
  .facts b { font-weight: 500; color: var(--fg); }
  .mono { font-family: var(--font-mono); font-size: 12.5px; }
  .error { margin: 10px 0 0; font-size: 13px; color: #b91c1c; }
  ol.steps { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 3px; font-size: 13px; }
  ol.steps li { display: grid; grid-template-columns: 18px 1fr; gap: 8px; color: var(--soft); }
  ol.steps li.running, ol.steps li.done { color: var(--fg); }
  ol.steps li.failed { color: #b91c1c; }
  ol.steps li .detail { display: block; font-size: 12px; color: var(--soft); overflow-wrap: anywhere; }
  details { margin: 12px 0 0; }
  summary { cursor: pointer; font-size: 13px; color: var(--chrome); }
  pre.log { margin: 8px 0 0; max-height: 260px; overflow: auto; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--chrome) 8%, transparent); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .note { margin: 10px 0 0; font-size: 12.5px; color: var(--soft); }
`;
  return appPage("Deploys", style, `${brand(session)}<main>
  <header>
    <h1>Deploys</h1>
    <a class="back" href="${esc(link("/admin", session))}">‹ Admin</a>
  </header>
  <p class="lede">Each branch deploys itself when it moves: <b>staging</b> to staging.erga.dev, <b>main</b> to erga.dev. ${self ? `This server is <b>${esc(self)}</b>.` : "This server isn't one of the deploy targets."} Staging gets a fresh copy of production's data on every deploy.</p>
  <div class="targets" id="targets" aria-live="polite"><p class="note">Loading…</p></div>
</main>
<script>
  const ICONS = { pending: "○", running: "◐", done: "●", skipped: "–", failed: "✕" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const when = (ms) => ms ? new Date(ms).toLocaleString() : "never";
  const open = new Set();
  function render(targets) {
    const box = document.getElementById("targets");
    for (const d of box.querySelectorAll("details[open]")) open.add(d.dataset.name);
    for (const d of box.querySelectorAll("details:not([open])")) open.delete(d.dataset.name);
    box.innerHTML = targets.map((t) => \`<section class="target" data-name="\${esc(t.name)}">
      <div class="top"><h2>\${esc(t.name)}</h2><span class="host"><a href="https://\${esc(t.host)}">\${esc(t.host)}</a> · branch <span class="mono">\${esc(t.branch)}</span></span><span class="grow"></span>
        <span class="state \${esc(t.state)}" data-state="\${esc(t.state)}">\${esc(t.state)}</span>
        \${t.self || t.remote ? \`<button type="button" class="new redeploy" data-name="\${esc(t.name)}"\${t.state == "building" || t.state == "deploying" ? " disabled" : ""}>Redeploy</button>\` : ""}</div>
      <div class="facts">
        <span>Commit <b class="mono">\${esc(t.commit ? t.commit.slice(0, 12) : "none yet")}</b></span>
        <span>Live <b class="mono">\${esc(t.deployed ? t.deployed.slice(0, 12) : "—")}</b></span>
        <span>Since <b>\${esc(when(t.at))}</b></span>
        \${t.pending ? \`<span>Next <b class="mono">\${esc(t.pending.slice(0, 12))}</b></span>\` : ""}
      </div>
      \${t.error ? \`<p class="error">\${esc(t.error)}</p>\` : ""}
      \${(t.steps || []).length ? \`<ol class="steps">\${t.steps.map((s) => \`<li class="\${esc(s.status)}"><span aria-hidden="true">\${ICONS[s.status] || ""}</span><span>\${esc(s.title)}\${s.detail ? \`<span class="detail">\${esc(s.detail)}</span>\` : ""}</span></li>\`).join("")}</ol>\` : ""}
      \${(t.log || []).length ? \`<details data-name="\${esc(t.name)}"\${open.has(t.name) ? " open" : ""}><summary>Log (\${t.log.length} lines)</summary><pre class="log">\${esc(t.log.join("\\n"))}</pre></details>\` : ""}
      \${!t.self && !t.remote ? \`<p class="note">Deployed by its own server, \${esc(t.host)}.</p>\` : ""}
    </section>\`).join("");
    for (const pre of box.querySelectorAll("pre.log")) pre.scrollTop = pre.scrollHeight;
  }
  let loading = null;
  async function load() {
    if (loading) return loading;
    loading = fetch("/api/deploys", { headers: { Accept: "application/json" } }).then((r) => r.json()).then((b) => render(b.targets || [])).catch(() => {}).finally(() => { loading = null; });
    return loading;
  }
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("button.redeploy");
    if (!b) return;
    b.disabled = true;
    const r = await fetch("/api/deploys/" + encodeURIComponent(b.dataset.name), { method: "POST" }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { alert(body.error || "Couldn't reach the server: try again."); b.disabled = false; }
    load();
  });
  load();
  const events = new EventSource("/api/events");
  events.onmessage = (e) => { try { if (JSON.parse(e.data).type == "deploys") load(); } catch {} };
</script>`);
}
