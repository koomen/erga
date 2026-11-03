// The Ops page's domains (client/inline/ops.ts): each environment's domains, + Add domain, and × to remove one. Add is
// a guide in its dialog: the server (set_domain) answers with the next step when the domain isn't ready (not on
// Cloudflare yet, name servers not moved yet, a DNS record of its own), and the dialog shows it in place, with what to
// do and Check again. Once added, it waits for the certificate (the view's `live`) and says when the name answers.

import { esc as escText } from "../../shared/html";
import { secondClick } from "../common/second-click";
import { runTool } from "../common/tools";

// The answers of the API are typed loosely (any): this page reads what the server sends and shows it.
type Json = any;

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => escText(String(s ?? ""));
const TARGETS = ["staging", "production", "control"];

/** The domains' part of the page; `every` runs a function now and then while the page is shown. */
export function opsDomains(every: (f: () => void, ms: number) => void, signal: AbortSignal) {
  let domains: Json = null;
  async function load() {
    const body = await runTool("deploys", { view: "domains" }).catch(() => null);
    if (signal.aborted) return;
    domains = body;
    render();
    watch();
  }
  const listOf = (n: string): Json[] | undefined => domains?.targets?.[n];
  function render() {
    for (const n of TARGETS) {
      const el = byId("domains-" + n);
      const list = listOf(n);
      el.hidden = !list;
      if (!list) continue;
      el.innerHTML =
        list
          .map((d) => {
            const waits = !d.primary && d.live === false;
            const title =
              d.hostname +
              (d.zone ? " · zone " + d.zone : "") +
              (d.primary ? " · the environment's own address" : "") +
              (waits ? " · waits for its certificate" : "");
            const remove = d.primary
              ? ""
              : '<button type="button" data-remove="' +
                esc(d.hostname) +
                '" data-target="' +
                n +
                '" title="Remove this domain from ' +
                n +
                '" aria-label="Remove ' +
                esc(d.hostname) +
                '">×</button>';
            return (
              '<span class="dom' +
              (d.primary ? " primary" : "") +
              (waits ? " waits" : "") +
              '" title="' +
              esc(title) +
              '"><span>' +
              esc(d.hostname) +
              (waits ? " · certificate…" : "") +
              "</span>" +
              remove +
              "</span>"
            );
          })
          .join("") +
        '<button class="add" type="button" data-add="' +
        n +
        '">+ Add domain</button>';
    }
  }

  // ---- the dialog: a hostname, then each step the server says, until the name answers.
  const dlg = byId<HTMLDialogElement>("domain-dlg");
  const host = byId<HTMLInputElement>("domain-host"),
    go = byId<HTMLButtonElement>("domain-go"),
    status = byId("domain-status"),
    step = byId("domain-step");
  /** What Go does now: add (check), add with replace, or nothing (it answers). */
  let mode: "add" | "replace" | "done" = "add";
  /** A name added, waiting for its certificate; and a step that Erga checks again by itself (name servers). */
  let waiting: { target: string; hostname: string } | null = null;
  let recheckAt = 0;
  const say = (text: string, error = false) => {
    status.textContent = text;
    status.className = error ? "error" : "";
  };
  function show(html: string, label: string, m: typeof mode) {
    step.innerHTML = html;
    step.hidden = !html;
    go.textContent = label;
    go.hidden = m == "done";
    mode = m;
  }
  function open(target: string) {
    dlg.dataset.target = target;
    byId("domain-env").textContent = target;
    host.value = "";
    host.disabled = false;
    waiting = null;
    recheckAt = 0;
    say("");
    show("", "Add", "add");
    go.disabled = false;
    if (!dlg.open) dlg.showModal();
    host.focus();
  }
  const copyable = (s: string) =>
    '<code class="copy-me">' + esc(s) + '</code><button type="button" class="copy" data-copy="' + esc(s) + '">Copy</button>';
  /** The step for what the domain still needs: the words, and what Go does next. */
  function needStep(n: Json) {
    recheckAt = 0;
    if (n.kind == "zone")
      return show(
        "<p><b>" +
          esc(n.domain) +
          " isn't in your Cloudflare account yet.</b></p><ol><li>Add it on Cloudflare: <a href='https://dash.cloudflare.com/" +
          esc(n.accountId) +
          "/add-site' target='_blank' rel='noopener'>Add " +
          esc(n.domain) +
          " ↗</a>. The free plan is enough.</li><li>Cloudflare then shows two name servers. Set them at the registrar where you bought " +
          esc(n.domain) +
          ".</li><li>Come back and click Check again.</li></ol><p class='muted'>No domain yet? <a href='https://dash.cloudflare.com/" +
          esc(n.accountId) +
          "/domains/register' target='_blank' rel='noopener'>Buy one on Cloudflare ↗</a>. It is in your account at once, with no name servers to move.</p>",
        "Check again",
        "add"
      );
    if (n.kind == "nameservers") {
      // Erga looks again each minute while the dialog is open: the move can take minutes, or hours.
      recheckAt = Date.now() + 60_000;
      return show(
        "<p><b>" +
          esc(n.domain) +
          " waits for its name servers.</b> At the registrar where you bought it, " +
          (n.current.length ? "replace " + n.current.map((s: string) => "<code>" + esc(s) + "</code>").join(" and ") + " with" : "set") +
          ":</p><p class='ns'>" +
          n.nameservers.map(copyable).join("<br>") +
          "</p><p class='muted'>Cloudflare sees the change in a few minutes, sometimes up to a day. Erga checks again each minute while this is open.</p>",
        "Check again",
        "add"
      );
    }
    return show(
      "<p><b>" +
        esc(n.hostname) +
        " already points somewhere else:</b> " +
        n.records.map((r: Json) => "<code>" + esc(r.type + " " + r.content) + "</code>").join(", ") +
        ".</p><p>Erga can replace this record. What it points to now stops answering at " +
        esc(n.hostname) +
        ".</p>",
      "Replace it",
      "replace"
    );
  }
  async function submit(replace: boolean) {
    const hostname = host.value.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname))
      return say("A hostname looks like docs.example.com.", true);
    go.disabled = true;
    say((replace ? "Replacing the record of " : "Checking ") + hostname + "…");
    try {
      const r = await runTool("set_domain", { action: "add", target: dlg.dataset.target, hostname, ...(replace ? { replace: true } : {}) });
      if (r.need) {
        say("");
        needStep(r.need);
      } else {
        domains = r;
        render();
        host.disabled = true;
        waiting = { target: dlg.dataset.target!, hostname };
        show("", "", "done");
        say("Added. Cloudflare makes its certificate: usually a minute or two.");
        watch();
      }
    } catch (err) {
      say((err as Error).message, true);
    }
    go.disabled = false;
  }
  /** The name added answers: say so, with the way there. */
  function watch() {
    if (!waiting || !dlg.open) return;
    const d = listOf(waiting.target)?.find((x) => x.hostname == waiting!.hostname);
    if (d?.live) {
      show("", "", "done");
      status.className = "";
      status.innerHTML =
        esc(waiting.hostname) + " answers. <a href='https://" + esc(waiting.hostname) + "' target='_blank' rel='noopener'>Open it ↗</a>";
      waiting = null;
    }
  }
  every(() => {
    if (!dlg.open) return;
    if (waiting) void load();
    else if (recheckAt && Date.now() >= recheckAt && !go.disabled) void submit(false);
  }, 3000);

  go.addEventListener("click", () => submit(mode == "replace"));
  host.addEventListener("keydown", (e) => {
    if (e.key == "Enter") void submit(false);
  });
  // A new name starts again from the first step.
  host.addEventListener("input", () => {
    if (mode != "done") show("", "Add", "add");
  });
  byId("domain-cancel").addEventListener("click", () => dlg.close());
  step.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-copy]");
    if (!b) return;
    void navigator.clipboard.writeText(b.dataset.copy!).then(() => {
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1200);
    });
  });
  byId("status").addEventListener("click", async (e) => {
    const at = e.target as Element;
    const add = at.closest<HTMLButtonElement>("button[data-add]"),
      rm = at.closest<HTMLButtonElement>("button[data-remove]");
    if (add) open(add.dataset.add!);
    if (!rm) return;
    if (!secondClick(rm, "remove?", "×", 6000, (on) => (rm.parentElement!.style.borderColor = on ? "var(--bad)" : ""))) return;
    rm.disabled = true;
    const failed = await runTool("set_domain", { action: "remove", target: rm.dataset.target, hostname: rm.dataset.remove }).then(
      () => null,
      (e: Error) => e.message
    );
    if (failed) {
      rm.disabled = false;
      rm.title = failed;
      rm.textContent = "!";
      return;
    }
    await load();
  });
  return { load };
}
