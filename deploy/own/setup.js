// The Setup tab's script (deploy/own/page.ts serves it, and the checklist's markup at /setup/panel). The ops page's
// script (deploy/cli/ops-page.js) calls ergaSetup(box) once, when the tab shows a setup's box, and the result when the
// box goes. It reads the steps each 6 seconds and the chat each 2, and sends the person's forms.
window.ergaSetup = (root) => {
  const $ = (name) => root.querySelector(`[data-s="${name}"]`);
  const post = (u, b) =>
    fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // A command or an address in a step's text, up to a comma, a semicolon, a parenthesis or a sentence's end (a dot
  // that a space or the end follows: a host's dots stay in it).
  const code = (s) =>
    h(s).replace(/(bunx? [a-z](?:[^,;.)\s]|\s(?!\()|\.(?=[^\s.]))*|https?:\/\/(?:[^\s,;).]|\.(?=\S))+)/g, "<code>$1</code>");
  let filled = false;
  let folded = false;
  async function refresh(fresh) {
    if (!root.isConnected) return;
    const s = await fetch(`/setup/api/status${fresh ? "?fresh" : ""}`).then((r) => r.json());
    const done = s.steps.filter((x) => x.state == "done").length;
    $("sub").textContent = s.next
      ? `${done} of ${s.steps.length} steps done. Next: ${s.next.title} (${s.next.who == "person" ? "you" : "your agent"}).`
      : "Every step is done. Your Erga is up.";
    $("steps").innerHTML = s.steps
      .map((x) => {
        const now = s.next && s.next.id == x.id;
        return `<li class="s-step ${x.state}${now ? " now" : ""}"><span class="s-dot"></span><span class="s-t">${h(x.title)}</span><span class="s-who ${x.who}">${x.who == "person" ? "You" : "Agent"}</span><span class="s-d">${code(x.detail)}</span>${x.state != "done" && now ? `<span class="s-n">${code(x.next)}</span>` : ""}</li>`;
      })
      .join("");
    const a = s.answers;
    if (!filled) {
      filled = true;
      for (const [k, v] of Object.entries(a)) {
        const el = $("answers").querySelector(`[name="${k}"]`);
        if (el) el.value = Array.isArray(v) ? v.join(",") : v || (k == "staging" ? "no" : k == "pages" ? "shared" : "");
      }
    }
    const decided = s.steps.find((x) => x.id == "decide")?.state == "done";
    $("github").hidden = !decided;
    $("ghdone").hidden = !s.github;
    $("ghmake").hidden = !!s.github;
    if (decided && !folded) {
      folded = true;
      $("decide").open = false;
    }
    if (s.github)
      $("ghdone").innerHTML =
        `Your app: ${s.github.url ? `<a href="${h(s.github.url)}" target="_blank">${h(s.github.slug || s.github.clientId)}</a>` : h(s.github.clientId)}`;
    const g = decided && a.providers.includes("google");
    $("google").hidden = !g;
    if (g) {
      const hosts = [a.host, a.staging].filter(Boolean);
      $("gsteps").innerHTML =
        `<li>Open <a href="https://console.cloud.google.com/auth/clients/create" target="_blank">Google Cloud: Create OAuth client</a> (make a project first if it asks).</li><li>Application type: <b>Web application</b>. Name: Erga.</li><li>Authorized redirect URIs: ${hosts.map((x) => `<code>https://${h(x)}/auth/google/callback</code>`).join(" and ")}</li><li>Create, then type the Client ID and Client secret here.</li>` +
        (s.google ? `<li><b>Saved: ${h(s.google.clientId)}</b></li>` : "");
    }
  }
  async function chat() {
    if (!root.isConnected) return;
    const m = await fetch("/setup/api/messages").then((r) => r.json());
    const log = $("log");
    const end = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.innerHTML =
      m.map((x) => `<div class="s-msg ${x.from}">${h(x.text)}</div>`).join("") ||
      '<div class="s-msg agent">Your agent will write here too.</div>';
    if (end) log.scrollTop = log.scrollHeight;
  }
  $("answers").onsubmit = async (e) => {
    e.preventDefault();
    const r = await post("/setup/api/answers", Object.fromEntries(new FormData(e.target)));
    $("aprob").textContent = r.problems.join(" ");
    refresh(true);
  };
  $("gform").onsubmit = async (e) => {
    e.preventDefault();
    const r = await post("/setup/api/google", Object.fromEntries(new FormData(e.target)));
    $("gprob").textContent = r.problems.join(" ");
    if (!r.problems.length) e.target.reset();
    refresh(true);
  };
  $("say").onsubmit = async (e) => {
    e.preventDefault();
    const t = e.target.text.value.trim();
    if (!t) return;
    await post("/setup/api/messages", { text: t });
    e.target.reset();
    chat();
  };
  $("orgapp").onclick = (e) => {
    e.preventDefault();
    const o = prompt("The organization's GitHub login:");
    if (o) location.href = `/setup/github/new?org=${encodeURIComponent(o)}`;
  };
  refresh(true).catch(() => {});
  chat().catch(() => {});
  const timers = [setInterval(() => refresh().catch(() => {}), 6000), setInterval(() => chat().catch(() => {}), 2000)];
  return () => timers.forEach(clearInterval);
};
