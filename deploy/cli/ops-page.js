// The ops page's script (deploy/cli/ops-view.ts puts it in the page): it draws the page again (GET /view) when the
// server says something changed (/api/events), when another primary or tab is chosen (the hash: #<primary>/<tab>),
// and each minute (the times). When a new job starts on another primary's instance, it switches to that primary.
// A job's log that was scrolled to its end stays at its end. The Setup tab's checklist (deploy/own/page.ts: /setup.js
// and /setup/panel) is made once and kept when the page draws again, so its forms keep what the person types. When the
// server stops, it says so; when it runs again, the page follows, and reloads if the server's script or styles changed.
// Merge opens a field for the commit's message under its branch. A commit row's cell shows a Deploy button in an instance's column on hover or focus, which asks a question
// first (the instance and the commit). Each starts its job (POST /api/merge, /api/deploy); the page stays on its tab,
// and the job line shows the job as it runs. An open field or question stays open, with what the person typed, when the
// page draws again, and so does a failed branch's list of tests.
(() => {
  const ops = document.getElementById("ops");
  const gone = document.getElementById("gone");
  const chosen = () => decodeURIComponent(location.hash.slice(1));
  const main = () => ops.querySelector(".main");
  let newest = main()?.dataset.newest ?? "";
  let asked = 0;
  /** After a draw: the old checklist stays in its place if it is the same setup's, else the new box gets one. */
  function settle(old) {
    const box = ops.querySelector(".setup[data-host]");
    if (box && old && old.dataset.host == box.dataset.host) return box.replaceWith(old);
    old?.ergaStop?.();
    if (!box) return;
    fetch("/setup/panel")
      .then((r) => r.text())
      .then((html) => {
        box.innerHTML = html;
        box.ergaStop = window.ergaSetup(box);
      });
  }
  /** What the person has open now: the merge field (its branch, text, caret, error), and the deploy question. */
  function opened() {
    const form = ops.querySelector(".f-merge:not([hidden])");
    const input = form?.querySelector("input");
    const ask = ops.querySelector("#deploy-confirm");
    return {
      branch: form?.dataset.branch,
      value: input?.value,
      focus: input && document.activeElement == input ? [input.selectionStart, input.selectionEnd] : null,
      err: form?.querySelector(".err").textContent,
      deploy: ask?.matches(":popover-open") ? { ...ask.dataset } : null,
      deployErr: ask?.querySelector(".err").textContent,
      fails: [...ops.querySelectorAll(".f-fails[open]")].map((d) => d.closest(".feature").dataset.branch),
    };
  }
  function reopen(o) {
    const form = o.branch && [...ops.querySelectorAll(".f-merge")].find((f) => f.dataset.branch == o.branch);
    if (form) {
      form.hidden = false;
      const input = form.querySelector("input");
      input.value = o.value;
      form.querySelector(".err").textContent = o.err;
      if (o.focus) {
        input.focus();
        input.setSelectionRange(...o.focus);
      }
    }
    if (o.deploy) question(o.deploy, o.deployErr);
    for (const d of ops.querySelectorAll(".f-fails")) d.open = o.fails.includes(d.closest(".feature").dataset.branch);
  }
  /** The deploy question for a row's button (its data: host, sha, ask, note). */
  function question(d, err = "") {
    const ask = ops.querySelector("#deploy-confirm");
    if (!ask) return;
    Object.assign(ask.dataset, d);
    ask.querySelector('[data-s="ask"]').textContent = d.ask;
    ask.querySelector('[data-s="note"]').textContent = d.note;
    ask.querySelector("[data-go]").textContent = `Deploy to ${d.host}`;
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
      const setup = ops.querySelector(".setup[data-host]");
      const open = opened();
      ops.innerHTML = html;
      settle(setup);
      reopen(open);
      const log = ops.querySelector(".log");
      if (log) log.scrollTop = atEnd || ops.querySelector(".logs")?.dataset.job != job ? log.scrollHeight : old.scrollTop;
      const m = main();
      if (m?.dataset.newest && m.dataset.newest != newest) {
        newest = m.dataset.newest;
        if (m.dataset.newestPrimary != m.dataset.primary) location.hash = `${m.dataset.newestPrimary}/${m.dataset.tab}`;
      }
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
  const hide = (form) => {
    form.hidden = true;
    form.querySelector(".err").textContent = "";
  };
  ops.addEventListener("click", (e) => {
    const merge = e.target.closest("[data-merge]");
    if (merge) {
      for (const f of ops.querySelectorAll(".f-merge")) hide(f);
      const form = [...ops.querySelectorAll(".f-merge")].find((f) => f.dataset.branch == merge.dataset.merge);
      form.hidden = false;
      form.querySelector("input").select();
      return;
    }
    if (e.target.closest("[data-cancel]")) return hide(e.target.closest(".f-merge"));
    const deploy = e.target.closest("[data-deploy]");
    if (deploy) {
      const { host, sha, ask, note } = deploy.dataset;
      return question({ host, sha, ask, note });
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      const ask = go.closest("#deploy-confirm");
      go.disabled = true;
      act("/api/deploy", { host: ask.dataset.host, sha: ask.dataset.sha }, ask.querySelector(".err")).then((ok) => {
        go.disabled = false;
        if (ok) ask.hidePopover();
      });
    }
  });
  ops.addEventListener("submit", (e) => {
    const form = e.target.closest(".f-merge");
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    const message = form.querySelector("input").value;
    act("/api/merge", { branch: form.dataset.branch, message }, form.querySelector(".err")).then((ok) => {
      button.disabled = false;
      if (ok) hide(form);
    });
  });
  ops.addEventListener("keydown", (e) => {
    const form = e.key == "Escape" && e.target.closest(".f-merge");
    if (form) hide(form);
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
  else settle(null);
})();
