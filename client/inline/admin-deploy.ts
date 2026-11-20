// The Deploy page's script (server/admin/deploy.ts). It draws the page's live part again (GET /admin/deploy/view) while the page
// is open and shown: each second while a job runs or an ask waits, else each 10 seconds (the server says which), and
// only when it changed. So a deploy that the deployer runs shows as it goes. A job's log that was scrolled to its end
// stays at its end, and an open question stays open.
//
// Deploy on a commit's row and Roll back on the live row ask a question first; then they are the operation deploy
// (POST /api/tools/deploy), as the Auto-deploy switch is. The deployer in the cloud starts an ask at its next look.
// (The ops page of a machine has the same view, with its own script: deploy/cli/ops-page.js.)

import { runTool, say } from "../common/admin-post";
import { saveMark } from "../common/admin-save";
import { asUser } from "../common/tools";

export default function adminDeploy(): void {
  const live = document.getElementById("deploy-live")!;
  const view = window.ergaView;
  const mark = saveMark();
  /** The live part's HTML as the server last gave it. */
  let last: string | null = null;
  let asked = 0;

  /** The question for a button (its data: host, sha, ask, note). The view has one. */
  function question(d: DOMStringMap, err = "") {
    const ask = live.querySelector<HTMLElement>(".confirm");
    if (!ask) return;
    // A Roll back has no commit: the question's last commit goes.
    delete ask.dataset.sha;
    Object.assign(ask.dataset, d);
    ask.querySelector('[data-s="ask"]')!.textContent = d.ask ?? "";
    ask.querySelector('[data-s="note"]')!.textContent = d.note ?? "";
    ask.querySelector("[data-go]")!.textContent = d.sha ? `Deploy to ${d.host}` : `Roll back ${d.host}`;
    ask.querySelector(".err")!.textContent = err;
    ask.showPopover();
  }

  async function draw() {
    const n = ++asked;
    try {
      await drawNow(n);
    } finally {
      if (n == asked) next();
    }
  }
  async function drawNow(n: number) {
    const r = await fetch(asUser(`/admin/deploy/view${location.search}`), { headers: { Accept: "application/json" } }).catch(() => null);
    const html = r?.ok ? ((await r.json().catch(() => null)) as { html?: string } | null)?.html : null;
    if (html == null || view.signal.aborted || n != asked || html == last) return;
    last = html;
    const old = live.querySelector(".log");
    const atEnd = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 8;
    const job = live.querySelector<HTMLElement>(".logs")?.dataset.job;
    const ask = live.querySelector<HTMLElement>(".confirm");
    const open = ask?.matches(":popover-open") ? { ...ask.dataset } : null;
    const err = ask?.querySelector(".err")?.textContent ?? "";
    const focus = document.activeElement?.id == "auto-deploy";
    live.innerHTML = html;
    if (open) question(open, err);
    if (focus) document.getElementById("auto-deploy")?.focus({ preventScroll: true });
    const log = live.querySelector(".log");
    if (log) log.scrollTop = atEnd || live.querySelector<HTMLElement>(".logs")?.dataset.job != job ? log.scrollHeight : old!.scrollTop;
  }

  live.addEventListener("click", (e) => {
    const at = e.target as Element;
    const button = at.closest<HTMLElement>("[data-deploy], [data-rollback]");
    if (button) {
      const { host, sha, ask, note } = button.dataset;
      return question({ host, ask, note, ...(sha ? { sha } : {}) });
    }
    const go = at.closest<HTMLButtonElement>("[data-go]");
    if (!go) return;
    const ask = go.closest<HTMLElement>(".confirm")!;
    const err = ask.querySelector(".err")!;
    err.textContent = "";
    go.disabled = true;
    runTool("deploy", ask.dataset.sha ? { action: "deploy", commit: ask.dataset.sha } : { action: "rollback" })
      .then(
        () => {
          ask.hidePopover();
          return draw();
        },
        (e: Error) => void (err.textContent = e.message)
      )
      .finally(() => (go.disabled = false));
  });

  // The Auto-deploy switch saves as it changes; one that the server refused goes back, and says why.
  live.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.id != "auto-deploy") return;
    const row = input.closest("li")!;
    const on = input.checked;
    row.querySelector(".state")!.textContent = on ? "On" : "Off";
    const save = () => {
      mark.set("auto-deploy", "saving");
      runTool("deploy", { action: "auto", on }).then(
        () => {
          mark.set("auto-deploy", "saved");
          say(row.querySelector(".hint")!, "");
          void draw();
        },
        (e: Error) => {
          input.checked = !on;
          row.querySelector(".state")!.textContent = on ? "Off" : "On";
          say(row.querySelector(".hint")!, e.message, true);
          mark.set("auto-deploy", "error", { title: "Auto-deploy not saved", detail: e.message }, save);
        }
      );
    };
    save();
  });

  // Draws again, at the pace that the server gave with the live part (each draw sets the next one's time: an ask
  // makes the pace fast at once); a hidden page waits until it shows.
  let timer = 0;
  function next() {
    clearTimeout(timer);
    if (view.signal.aborted) return;
    const wait = Number(live.querySelector<HTMLElement>("#ops")?.dataset.wait) || 10_000;
    timer = window.setTimeout(() => void (document.hidden ? next() : draw()), wait);
  }
  next();
  view.onLeave(() => clearTimeout(timer));
  document.addEventListener("visibilitychange", () => void (document.hidden || draw()), { signal: view.signal });
}
