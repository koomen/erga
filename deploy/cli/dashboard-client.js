// The dashboard page's script (deploy/cli/dashboard-page.ts serves it inline): it reads the page again (GET /view) when the
// server says (X-Erga-Poll: 5 seconds during a deploy, else 30), also while a dialog is open; it opens a run's log (GET /api/log); and its buttons start `bun erga` commands
// (POST /api/action, with this run's token), whose output it shows live in the log's dialog (GET /api/job).
(() => {
  const token = document.querySelector('meta[name="erga-token"]').content;
  const $ = (id) => document.getElementById(id);
  const live = $("live");
  const logDlg = $("deploy-log");
  const lines = $("log-lines");
  const meta = $("log-meta");
  const rollback = $("log-rollback");
  const ROLLS = ["staging", "production"];
  let job = null;

  const api = (path, body) =>
    fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "X-Erga-Token": token } : { "X-Erga-Token": token },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      const j = await r.json().catch(() => ({ error: r.statusText }));
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j;
    });

  // The dialogs are outside #live, so it changes also while one is open (the log of a merge, say). Only a button in
  // #live that waits for its second click keeps it as it is.
  const armed = () => !!live.querySelector("[data-armed]");
  let timer = 0;
  async function refresh(fresh) {
    clearTimeout(timer);
    let next = 30000;
    try {
      const r = await fetch("/view" + (fresh ? "?fresh=1" : ""));
      if (!r.ok) throw new Error(r.statusText);
      next = Number(r.headers.get("X-Erga-Poll")) || next;
      const html = await r.text();
      if (!armed() || fresh) live.innerHTML = html;
    } catch {
      const st = document.querySelector("#status-head");
      if (st) st.textContent = "Status: the dashboard command stopped";
    }
    clearTimeout(timer);
    timer = setTimeout(() => refresh(false), next);
  }
  if ($("repo")) timer = setTimeout(() => refresh(false), 5000);
  else refresh(false);

  // Two clicks: the first arms the button and says what the second does.
  function secondClick(b, armed) {
    if (b.dataset.armed) return true;
    b.dataset.armed = "1";
    b.dataset.was = b.textContent;
    b.textContent = armed;
    setTimeout(() => {
      if (!b.dataset.armed) return;
      delete b.dataset.armed;
      b.textContent = b.dataset.was;
    }, 4000);
    return false;
  }

  /** Shows a run's log, or a job's output, in the log's dialog. */
  function openLog(title, server) {
    $("log-title").textContent = title;
    meta.textContent = "";
    lines.textContent = "";
    rollback.hidden = !ROLLS.includes(server);
    rollback.dataset.server = server || "";
    delete rollback.dataset.armed;
    rollback.textContent = "Roll back";
    if (!logDlg.open) logDlg.showModal();
  }
  async function showRun(id, server) {
    job = null;
    openLog((server || "Run") + " · run " + id, server);
    meta.textContent = "reading the log…";
    try {
      const r = await api("/api/log?run=" + encodeURIComponent(id));
      meta.innerHTML = "";
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.state;
      meta.append(a);
      lines.textContent = r.log || "No log yet.";
      lines.scrollTop = lines.scrollHeight;
    } catch (e) {
      meta.innerHTML = '<span class="bad"></span>';
      meta.firstChild.textContent = e.message;
    }
  }

  /** Starts an action, and follows its output until it ends. */
  async function start(body, title, server) {
    let r;
    try {
      r = await api("/api/action", body);
    } catch (e) {
      openLog(title, server);
      meta.innerHTML = '<span class="bad"></span>';
      meta.firstChild.textContent = e.message;
      return;
    }
    openLog(title, server);
    rollback.hidden = true;
    follow(r.job);
  }
  // The job the dialog shows: its output comes in while it runs, also when the dialog is closed. A run's log shown
  // instead stops the showing, not the job.
  async function follow(id) {
    job = id;
    let from = 0;
    meta.textContent = "running…";
    for (;;) {
      let r;
      try {
        r = await api("/api/job?id=" + id + "&from=" + from);
      } catch (e) {
        if (job == id) meta.textContent = e.message;
        return;
      }
      if (job == id && r.lines.length) {
        const end = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 8;
        lines.append(r.lines.join("\n") + "\n");
        if (end) lines.scrollTop = lines.scrollHeight;
      }
      from += r.lines.length;
      if (r.done) {
        if (job == id) meta.innerHTML = r.ok ? '<span class="live-on">done</span>' : '<span class="bad">failed</span>';
        refresh(true);
        return;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  // A job that runs already (the page was loaded again while it ran): show it.
  api("/api/job").then(
    (r) => {
      if (r.id && !r.done) {
        openLog(r.title);
        follow(r.id);
      }
    },
    () => {}
  );

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button, a");
    if (!b) return;
    if (b.hasAttribute("data-close")) return b.closest("dialog").close();
    if (b.id == "clone-copy")
      return navigator.clipboard.writeText(b.dataset.copy).then(
        () => (b.textContent = "Copied"),
        () => (b.textContent = "Copy failed")
      );
    if (b.dataset.log) return showRun(b.dataset.log, b.dataset.server);
    const act = b.dataset.act;
    if (!act) return;
    if (act == "check") return refresh(true);
    if (act == "merge-open") {
      $("feature-name").textContent = b.dataset.branch;
      $("feature-message").value = b.dataset.message || "";
      $("feature-go").dataset.branch = b.dataset.branch;
      return $("feature-dlg").showModal();
    }
    if (act == "release-open") {
      $("release-head").textContent = b.dataset.head;
      $("release-version").value = b.dataset.version;
      return $("release-dlg").showModal();
    }
    if (act == "delete") {
      if (!secondClick(b, "Click again to delete")) return;
      delete b.dataset.armed;
      return start({ action: "delete", branch: b.dataset.branch }, "Delete " + b.dataset.branch);
    }
    if (act == "rerun") {
      if (!secondClick(b, "Click again")) return;
      delete b.dataset.armed;
      return start({ action: "rerun", run: b.dataset.run }, "Retry run " + b.dataset.run);
    }
  });

  $("feature-go").addEventListener("click", () => {
    const branch = $("feature-go").dataset.branch;
    const message = $("feature-message").value.trim();
    $("feature-dlg").close();
    start({ action: "merge", branch, message }, "bun erga merge " + branch, "staging");
  });
  $("release-go").addEventListener("click", () => {
    const version = $("release-version").value.trim();
    $("release-dlg").close();
    start({ action: "release", version }, "bun erga release " + version);
  });
  rollback.addEventListener("click", () => {
    const server = rollback.dataset.server;
    if (!secondClick(rollback, "Click again to roll back " + server)) return;
    delete rollback.dataset.armed;
    start({ action: "rollback", server }, "bun erga rollback " + server, server);
  });
})();
