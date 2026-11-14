// The alerts' card, at the bottom of the page's part of the window: it keeps the one state (client/common/alerts.ts
// decides it), draws it, runs its timers, and tells each alert's source of its buttons. Every alert of the editor shows
// here, together: a new one adds to the card, never a second card. The card never takes the focus: the caret stays in
// the text. What the page's editor raised is the page's text: it goes in as text, never as HTML.

import { ms } from "../../libs/text/ui/timescale";
import { FIX_ALL_REPORTED, FIX_REPORTED, pageReport } from "../../shared/page-report";
import * as A from "../common/alerts";
import { editorContext } from "./agent-context";
import { $, type Shell } from "./shell";

/** What hears an alert's buttons (and A.DISMISS, as the person closes it). */
type Hears = (action: string, row?: string) => void;

declare global {
  interface Window {
    /** The editor's alerts, for the agent's panel (client/agent/person-agent.ts): only in the editor. */
    ergaAlerts?: { raise(alert: A.Raise, hears?: Hears): void; end(key: string, title?: string): void };
  }
}

const SOURCE: Record<A.Source, string> = { page: "Page", editor: "Editor", upload: "Upload", agent: "Agent", connection: "Connection" };
const CHECK = `<svg viewBox="0 0 14 14"><path d="m2.5 7.5 3 3 6-7"/></svg>`;
const CHEVRON = `<svg class="chev" viewBox="0 0 12 12"><path d="m3 7.5 3-3 3 3"/></svg>`;
/** The alert that says why the agent can't be asked. */
const AGENT_OFF = "agent:off";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function button(className: string, label: string, action?: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  if (action) b.dataset.action = action;
  return b;
}
const shown = (p: number | null) => String(p == null ? 0 : Math.round(p * 1000) / 1000);

export function mountAlerts(shell: Shell) {
  const box = $("alerts");
  let state = A.initial;
  const hears = new Map<string, Hears>();

  function send(e: A.Event) {
    const [next, effects] = A.step(state, e);
    state = next;
    for (const f of effects) {
      if (f.t == "draw") draw();
      else if (f.t == "paint") paint(f.key, f.row);
      else if (f.t == "timer") window.setTimeout(() => send({ t: "timeout", key: f.key, what: f.what }), ms(f.ms));
      else if (f.t == "fix") askAgent(f.alerts);
      else if (!shell.page.act(f.key, f.action, f.row)) hears.get(f.key)?.(f.action, f.row);
    }
    for (const key of hears.keys()) if (!state.alerts.some((a) => a.key == key)) hears.delete(key);
  }

  /** Why the agent can't be asked now, or null. */
  const agentOff = () => (window.ergaAgentPanel ? window.ergaAgentPanel.off : "Connecting to the agent…");
  // The page editor's report goes to your agent as data, in the page note (shared/page-report.ts).
  function askAgent(alerts: A.Alert[]) {
    const agent = window.ergaAgentPanel!;
    if (alerts.length == 1 && alerts[0].draft) agent.draft(alerts[0].fix!.replace(/\s+/g, " ").slice(0, 200));
    else
      agent.ask(
        alerts.length == 1 ? FIX_REPORTED : FIX_ALL_REPORTED,
        `${editorContext(shell)}\n${alerts.map((a) => pageReport(a.fix!)).join("\n")}`
      );
  }
  /** A fix button: the agent is asked, or an alert says why it can't be. */
  function fix(event: A.Event) {
    const off = agentOff();
    if (off)
      send({ t: "raise", alert: { key: AGENT_OFF, kind: "error", source: "agent", title: "The agent can't be asked now", detail: off } });
    else send(event);
  }
  // The agent's state comes after the page can report a problem ("Connecting to the agent…" until then): the fix
  // buttons follow it (client/agent/person-agent.ts sends "erga:agent-state"), and the alert that says it's off goes.
  window.addEventListener("erga:agent-state", () => {
    if (!agentOff()) send({ t: "end", key: AGENT_OFF });
    draw();
  });

  // ---------------------------------------------------------------- drawing

  function actions(list: A.Action[], className: string): HTMLButtonElement[] {
    return list.map((a) => {
      const b = button(className + (a.primary ? " primary" : ""), a.label, a.id);
      if (a.label == "×") b.setAttribute("aria-label", "Cancel");
      return b;
    });
  }
  function rowOf(r: A.Row): HTMLElement {
    const li = el("li", "alert-row");
    li.dataset.row = r.id;
    li.dataset.state = r.state;
    const failed = r.state == "error";
    li.append(
      el("span", "name", r.title),
      el("span", "detail", failed ? "" : [r.by && `by ${r.by.name}`, r.detail].filter(Boolean).join(" · "))
    );
    const acts = actions(r.actions ?? [], "alert-row-action");
    if (failed) {
      const why = el("span", "why", r.detail ?? "It failed.");
      why.append(...acts);
      li.append(el("span", ""), why);
    } else {
      const side = el("span", "side");
      side.append(...acts);
      // (Running, and it can't tell how far: the bar moves.)
      const bar = el("span", `alert-bar${r.state == "running" && r.p == null ? " unknown" : ""}`);
      bar.style.setProperty("--p", shown(r.state == "done" ? 1 : (r.p ?? 0)));
      li.append(side, bar);
    }
    return li;
  }
  function mark(a: A.Alert): HTMLElement {
    if (a.done) {
      const m = el("i", "alert-mark done");
      m.innerHTML = CHECK;
      return m;
    }
    if (a.kind == "error") return el("i", "alert-mark");
    const p = A.progress(a),
      m = el("i", `alert-mark progress${p == null ? " unknown" : ""}`);
    m.style.setProperty("--p", shown(p));
    return m;
  }
  function alertOf(a: A.Alert): HTMLElement {
    const li = el("li", "alert");
    li.dataset.key = a.key;
    li.dataset.kind = a.kind;
    const text = el("div", "alert-text"),
      title = el("p", "alert-title", a.title);
    if (a.count > 1) title.append(el("span", "alert-count", `×${a.count}`));
    text.append(title, el("p", "alert-detail", [SOURCE[a.source], a.by && `by ${a.by.name}`, a.detail].filter(Boolean).join(" · ")));
    li.append(mark(a), text);
    const list = a.fix ? [{ id: A.FIX, label: a.fixLabel ?? "Fix with agent", primary: true }, ...a.actions] : a.actions;
    if (list.length) {
      const acts = el("div", `alert-actions${list.length > 1 ? " under" : ""}`);
      acts.append(...actions(list, "alert-action"));
      const off = agentOff(),
        fixBtn = acts.querySelector<HTMLElement>(`[data-action="${A.FIX}"]`);
      // aria-disabled, not disabled: a click still says why it can't.
      if (fixBtn && off) {
        fixBtn.setAttribute("aria-disabled", "true");
        fixBtn.title = off;
      }
      li.append(acts);
    }
    if (a.rows.length) {
      const rows = el("ul", "alert-rows");
      rows.append(...a.rows.map(rowOf));
      li.append(rows);
    }
    return li;
  }
  function draw() {
    const v = A.view(state),
      at = box.querySelector(".alerts-list")?.scrollTop ?? 0;
    box.dataset.view = v;
    box.textContent = "";
    if (v != "none") fill(v, at);
    // (The page's editor keeps its own notes over the card: how much of the window's bottom the card takes.)
    shell.page.setNotes(v == "none" ? 0 : Math.max(0, Math.round(innerHeight - box.getBoundingClientRect().top - 12)));
  }
  /** The line or the card, into the box; `at`: where the card's list was scrolled to. */
  function fill(v: "line" | "card", at: number) {
    const visible = state.alerts.filter(A.shows);
    if (v == "line") {
      // One line: what runs (a click opens the card), or what just ended.
      const a = visible[0],
        line = a.done ? el("div", "alerts-pill") : button("alerts-pill", "");
      if (a.done) line.setAttribute("role", "status");
      const seg = el("span", "alerts-seg");
      seg.append(mark(a), A.running(state));
      line.append(seg);
      if (!a.done) line.insertAdjacentHTML("beforeend", CHEVRON);
      box.append(line);
      return;
    }
    const card = el("section", "alerts-card");
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Alerts");
    const head = el("header", "alerts-head");
    head.append(el("h2", "", A.headline(state)));
    if (A.fixable(state).length > 1) {
      const all = button("alerts-all", "Fix all with agent");
      if (agentOff()) all.setAttribute("aria-disabled", "true");
      head.append(all);
    }
    const close = button("alerts-close", "×");
    close.title = "Close (Escape)";
    close.setAttribute("aria-label", "Close");
    head.append(close);
    const list = el("ul", "alerts-list");
    list.append(...visible.map(alertOf));
    card.append(head, list);
    box.append(card);
    list.scrollTop = at;
  }
  /** Only a row's bar and numbers, and its alert's ring: they can change many times a second. */
  function paint(key: string, id: string) {
    const a = state.alerts.find((x) => x.key == key),
      r = a?.rows.find((x) => x.id == id);
    if (!a || !r) return;
    const of = (list: NodeListOf<HTMLElement>, name: "key" | "row", value: string) => [...list].find((e) => e.dataset[name] == value);
    const li = of(box.querySelectorAll<HTMLElement>(".alert"), "key", key),
      row = li && of(li.querySelectorAll<HTMLElement>(".alert-row"), "row", id);
    (li ?? box).querySelector<HTMLElement>(".alert-mark.progress")?.style.setProperty("--p", shown(A.progress(a)));
    if (!row) return;
    row.querySelector<HTMLElement>(".alert-bar")?.style.setProperty("--p", shown(r.p ?? 0));
    row.querySelector(".detail")!.textContent = [r.by && `by ${r.by.name}`, r.detail].filter(Boolean).join(" · ");
  }

  // ---------------------------------------------------------------- the person's clicks

  // (The focus stays where it is: in the text.)
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    if (b.classList.contains("alerts-close")) send({ t: "close" });
    else if (b.classList.contains("alerts-pill")) send({ t: "open" });
    else if (b.classList.contains("alerts-all")) fix({ t: "fix-all" });
    else {
      const key = b.closest<HTMLElement>(".alert")?.dataset.key,
        row = b.closest<HTMLElement>(".alert-row")?.dataset.row,
        action = b.dataset.action;
      if (!key || !action) return;
      const event: A.Event = { t: "act", key, action, ...(row ? { row } : {}) };
      if (action == A.FIX) fix(event);
      else send(event);
    }
  });

  const api = {
    /** A new alert, or the same one again (its key): `hears` its buttons. */
    raise(alert: A.Raise, hear?: Hears) {
      if (hear) hears.set(alert.key, hear);
      send({ t: "raise", alert });
    },
    /** One row of it, new or changed. */
    row: (key: string, row: A.Row) => send({ t: "row", key, row }),
    /** Its source says that it is over. */
    end: (key: string, title?: string) => send({ t: "end", key, ...(title ? { title } : {}) }),
    /** What the page's editor raised, changed or ended (page-frame.ts read it). */
    fromPage: (event: Extract<A.Event, { t: "raise" | "row" | "end" }>) => send(event),
    /** Closes the card, if it's open (× or Escape): its errors are dismissed, and nothing that runs stops. False: no card. */
    close(): boolean {
      if (A.view(state) != "card") return false;
      send({ t: "close" });
      return true;
    },
    /** The page in the frame loaded again: what its editor raised is gone with it. */
    loaded: () => send({ t: "load" }),
    /** Another page: what was said of the last page was of it alone. */
    left: () => send({ t: "page" }),
  };
  window.ergaAlerts = { raise: api.raise, end: api.end };
  return api;
}

export type Alerts = ReturnType<typeof mountAlerts>;
