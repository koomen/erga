// The ops page's script (deploy/cli/ops-view.ts puts it in the page): it draws the page again (GET /view) when the
// server says something changed (/api/events), when another primary or tab is chosen (the hash: #<primary>/<tab>),
// and each minute (the times). When a new job starts on another primary's instance, it switches to that primary.
// A job's log that was scrolled to its end stays at its end. The Setup tab's checklist (deploy/own/page.ts: /setup.js
// and /setup/panel) is made once and kept when the page draws again, so its forms keep what the person types. When the
// server stops, it says so; when it runs again, the page follows.
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
  async function draw() {
    const n = ++asked;
    try {
      const r = await fetch(`/view?hash=${encodeURIComponent(chosen())}`);
      if (!r.ok) return;
      const html = await r.text();
      if (n != asked) return;
      const old = ops.querySelector(".log");
      const atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 8;
      const job = ops.querySelector(".logs")?.dataset.job;
      const setup = ops.querySelector(".setup[data-host]");
      ops.innerHTML = html;
      settle(setup);
      const log = ops.querySelector(".log");
      if (log) log.scrollTop = atEnd || ops.querySelector(".logs")?.dataset.job != job ? log.scrollHeight : old.scrollTop;
      const m = main();
      if (m?.dataset.newest && m.dataset.newest != newest) {
        newest = m.dataset.newest;
        if (m.dataset.newestPrimary != m.dataset.primary) location.hash = `${m.dataset.newestPrimary}/${m.dataset.tab}`;
      }
    } catch {}
  }
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
