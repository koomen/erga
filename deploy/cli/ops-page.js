// The ops page's script (deploy/cli/ops-view.ts puts it in the page): it draws the page again (GET /view) when the
// server says something changed (/api/events), when another primary is chosen (the hash), and each minute (the times).
// When the server stops, it says so; when it runs again, the page follows.
(() => {
  const ops = document.getElementById("ops");
  const gone = document.getElementById("gone");
  const chosen = () => decodeURIComponent(location.hash.slice(1));
  let asked = 0;
  async function draw() {
    const n = ++asked;
    try {
      const r = await fetch(`/view?primary=${encodeURIComponent(chosen())}`);
      if (!r.ok) return;
      const html = await r.text();
      if (n == asked) ops.innerHTML = html;
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
})();
