// The ops page's script (deploy/cli/ops-view.ts puts it in the page): it draws the page again (GET /view) when the
// server says something changed (/api/events), when another instance or tab is chosen (the hash: #<host>/<tab>),
// and each minute (the times).
// A job's log that was scrolled to its end stays at its end. When the server stops, it says so; when it runs again, the page follows, and reloads if the server's script or styles changed.
// A commit row's cell shows a Deploy button on hover or focus, and the live row a Roll back button; each asks a question
// first (the instance, and the commit). It starts its job (POST /api/deploy, /api/rollback); the page stays on its tab,
// and the job line shows the job as it runs. An open question stays open when the page draws again.
// The verify suite's buttons (#verify) go the same way: Run and Remove ask first (the question says the cost), Check
// again and Update (a kept setting's code again) ask nothing; each starts its command (POST /api/verify).
(() => {
  const ops = document.getElementById("ops");
  const gone = document.getElementById("gone");
  const chosen = () => decodeURIComponent(location.hash.slice(1));
  let asked = 0;
  /** What the person has open now: the deploy question. */
  function opened() {
    const ask = ops.querySelector(".confirm");
    return { deploy: ask?.matches(":popover-open") ? { ...ask.dataset } : null, deployErr: ask?.querySelector(".err").textContent };
  }
  function reopen(o) {
    if (o.deploy) question(o.deploy, o.deployErr);
  }
  /** The question for a button (its data: host, sha, ask, note; the verify suite's: verify, unit, go). The view has one. */
  function question(d, err = "") {
    const ask = ops.querySelector(".confirm");
    if (!ask) return;
    // A Roll back has no commit: the question's last commit goes.
    delete ask.dataset.sha;
    Object.assign(ask.dataset, d);
    ask.querySelector('[data-s="ask"]').textContent = d.ask;
    ask.querySelector('[data-s="note"]').textContent = d.note;
    ask.querySelector("[data-go]").textContent = d.go ?? (d.sha ? `Deploy to ${d.host}` : `Roll back ${d.host}`);
    ask.querySelector(".err").textContent = err;
    ask.showPopover();
  }
  async function draw() {
    const n = ++asked;
    try {
      const r = await fetch(`/view?hash=${encodeURIComponent(chosen())}`);
      if (!r.ok) return;
      // bun erga runs other code than this tab loaded (it ran again, after a pull): the tab takes the new script and styles.
      if (r.headers.get("x-ops-code") != document.querySelector('meta[name="ops-code"]')?.content) return location.reload();
      const html = await r.text();
      if (n != asked) return;
      const old = ops.querySelector(".log");
      const atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 8;
      const job = ops.querySelector(".logs")?.dataset.job;
      const open = opened();
      ops.innerHTML = html;
      reopen(open);
      const log = ops.querySelector(".log");
      if (log) log.scrollTop = atEnd || ops.querySelector(".logs")?.dataset.job != job ? log.scrollHeight : old.scrollTop;
    } catch {}
  }
  /** Starts a job; the page stays on its tab, and the job line shows the job. Else `err` says why. */
  async function act(path, body, err) {
    err.textContent = "";
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = await r.json().catch(() => ({}));
      if (!r.ok) {
        err.textContent = answer.error ?? `HTTP ${r.status}`;
        return false;
      }
      draw();
      return true;
    } catch {
      err.textContent = "bun erga does not answer.";
      return false;
    }
  }
  ops.addEventListener("click", (e) => {
    const deploy = e.target.closest("[data-deploy]");
    if (deploy) {
      const { host, sha, ask, note } = deploy.dataset;
      return question({ host, sha, ask, note });
    }
    const back = e.target.closest("[data-rollback]");
    if (back) {
      const { host, ask, note } = back.dataset;
      return question({ host, ask, note });
    }
    // (A button only: the open question holds the same data.)
    const suite = e.target.closest("button[data-verify]");
    if (suite) {
      const { verify, unit, ask, note, go } = suite.dataset;
      if (ask) return question({ verify, unit, ask, note, go });
      suite.disabled = true;
      const err = ops.querySelector("#verify-err");
      return act("/api/verify", { action: verify, unit }, err).then(() => (suite.disabled = false));
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      const ask = go.closest(".confirm");
      go.disabled = true;
      const { host, sha, verify, unit } = ask.dataset;
      const path = verify ? "/api/verify" : sha ? "/api/deploy" : "/api/rollback";
      act(path, verify ? { action: verify, unit } : sha ? { host, sha } : { host }, ask.querySelector(".err")).then((ok) => {
        go.disabled = false;
        if (ok) ask.hidePopover();
      });
    }
  });
  const events = new EventSource("/api/events");
  events.onmessage = draw;
  events.onopen = () => {
    if (!gone.hidden) draw();
    gone.hidden = true;
  };
  events.onerror = () => {
    gone.hidden = false;
  };
  addEventListener("hashchange", draw);
  setInterval(draw, 60_000);
  if (chosen()) draw();
})();
