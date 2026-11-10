// Live pages, the page's side (server/news/ has the design). A list on the page says which rows it shows
// (data-live-kind="doc", or "user person" for two kinds), which page's rows they are (data-live-view="docs"), their
// order (data-live-order: "asc", else the highest first) and when the server made it (data-live-at); each row says its
// key (data-live="doc:<id>") and its place (data-sort: a number, or text). One socket for the page (/api/news) hears
// which of its person's rows changed, whoever changed them; the page then asks for those rows only (/api/news/rows),
// and puts each in, in its place, replaces it, or takes it out. Nothing else on the page moves: focus, scroll, an open
// menu or a half-typed field elsewhere stay as they are, and a row whose field has the focus waits until it hasn't.
//
// A hidden tab waits until it shows. A dropped socket comes back by itself and says the last version it heard, so it
// hears what changed meanwhile. One ask at a time, so a later answer is never older than one before it. The socket's
// phase (news-phase.ts) owns its reconnect timer: once the last list stops, no socket opens.
//
// Trap: a live list gets new rows after the page loaded, and a changed row is a new element. Attach a row's listeners
// in its `wire(row)`, never in a loop over the rows at load: a row that comes later would have none.

import { backoff, live } from "../live/client";
import { newsStep, type NewsEvent, type NewsPhase } from "./news-phase";
import { PING, PONG } from "../../shared/room-socket";

type Row = { html: string; sort: number | string } | null;

export interface LiveList {
  /** Runs for each row as it comes in (the page's listeners). */
  wire(row: HTMLElement): void;
  /** After rows changed (a count, an empty state). */
  changed?(): void;
  /** Before a row goes (what belongs to it elsewhere). */
  removing?(row: HTMLElement): void;
}

const lists = new Map<HTMLElement, LiveList>();
const pending = new Set<string>();
/** The rows the page's own change asked for (refresh): they come in even where its field has the focus. */
const own = new Set<string>();
let since = 0,
  socket: WebSocket | null = null,
  phase: NewsPhase = { at: "stopped" },
  retry: ReturnType<typeof setTimeout> | undefined,
  heard = 0;

/** An event of the socket's: its new phase, and what that asks for. */
function go(e: NewsEvent): void {
  const next = newsStep(phase, e);
  phase = next.phase;
  if (phase.at != "backoff") clearTimeout(retry);
  for (const f of next.effects) {
    if (f.do == "connect") connect();
    else if (f.do == "up") {
      socket?.send(JSON.stringify({ since }));
      live((l) => l.connection("news", "up"));
    } else if (f.do == "down") live((l) => l.connection("news", "down"));
    else if (f.do == "retry") retry = setTimeout(() => go({ type: "timer" }), backoff(f.tries));
    else {
      const ws = socket;
      socket = null;
      ws?.close();
      live((l) => l.connection("news", null));
    }
  }
}

/** The page's ?user= (local development: who is signed in), for its asks. */
const user = () => new URLSearchParams(location.search).get("user");

/** Keeps `el`'s rows live, until `signal` aborts (an admin page the shell leaves: window.ergaView). */
export function liveList(el: HTMLElement, o: LiveList, signal?: AbortSignal): void {
  lists.set(el, o);
  // A little before the page was made, as the server's clock goes: a change in between is heard twice, never missed.
  since = Math.max(since, Number(el.dataset.liveAt || 0) - 5000);
  signal?.addEventListener("abort", () => {
    lists.delete(el);
    if (!lists.size) stop?.();
  });
  if (lists.size > 1) return;
  go({ type: "start" });
  // An idle socket can die without a close: a ping now and then, and one with no answer for a while is closed.
  const ping = setInterval(() => {
    if (!socket || socket.readyState != WebSocket.OPEN) return;
    if (Date.now() - heard > 75_000) return socket.close();
    socket.send(PING);
  }, 30_000);
  const shown = () => {
    if (!document.hidden) ask();
  };
  document.addEventListener("visibilitychange", shown);
  stop = () => {
    stop = null;
    clearInterval(ping);
    document.removeEventListener("visibilitychange", shown);
    go({ type: "stop" });
  };
}

let stop: (() => void) | null = null;

function connect() {
  const u = user();
  const ws = new WebSocket(
    `${location.protocol == "https:" ? "wss" : "ws"}://${location.host}/api/news${u ? `?user=${encodeURIComponent(u)}` : ""}`
  );
  socket = ws;
  heard = Date.now();
  ws.onopen = () => {
    if (socket == ws) go({ type: "opened" });
  };
  ws.onmessage = (e) => {
    heard = Date.now();
    if (e.data == PONG) return;
    let said: { changed?: { key: string; v: number }[]; reset?: boolean };
    try {
      said = JSON.parse(String(e.data));
    } catch {
      return;
    }
    // Away longer than the server keeps: the page as it is now.
    if (said.reset) return location.reload();
    for (const c of said.changed ?? []) {
      since = Math.max(since, c.v);
      if (listOf(c.key)) pending.add(c.key);
    }
    ask();
  };
  ws.onclose = () => {
    if (socket != ws) return;
    socket = null;
    go({ type: "closed" });
  };
}

/**
 * The page's own change: these rows as they are now, asked for at once (not waiting for the socket, nor needing it).
 * Settles once they're in. Each comes in even where its field has the focus: the field holds what was just saved (a
 * document chosen in a picker, with the focus still in its box), and the focus goes to the same field in the new row.
 */
export function refresh(...keys: string[]): Promise<void> {
  for (const k of keys)
    if (listOf(k)) {
      pending.add(k);
      own.add(k);
    }
  return ask();
}

/** Whether `el` shows rows of `key`'s kind. */
const shows = (el: HTMLElement, key: string) => (el.dataset.liveKind ?? "").split(" ").includes(key.slice(0, key.indexOf(":")));

/** The list that shows rows of `key`'s kind, if any. */
const listOf = (key: string) => [...lists.keys()].find((el) => shows(el, key));

let running: Promise<void> | null = null,
  again = false;

/** Asks for the rows that changed, one ask at a time (a change meanwhile: once more after it); a hidden tab waits until it shows. */
function ask(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await askOnce();
    } while (again && pending.size && !document.hidden);
  })().finally(() => {
    running = null;
  });
  return running;
}

async function askOnce(): Promise<void> {
  if (!pending.size || document.hidden) return;
  const keys = [...pending];
  pending.clear();
  for (const [el, o] of lists) {
    const mine = keys.filter((k) => shows(el, k));
    if (!mine.length) continue;
    const q = new URLSearchParams({ view: el.dataset.liveView!, keys: mine.join(",") });
    if (user()) q.set("user", user()!);
    const r = await fetch(`/api/news/rows?${q}`, { headers: { Accept: "application/json" } }).catch(() => null);
    if (!r?.ok) {
      // Asked again with the next change, or after the socket comes back.
      mine.forEach((k) => pending.add(k));
      continue;
    }
    const { rows } = (await r.json()) as { rows: Record<string, Row> };
    for (const [key, row] of Object.entries(rows)) if (!put(el, o, key, row)) pending.add(key);
    o.changed?.();
  }
  // A failed ask, or a row someone is typing in: again in a while.
  if (pending.size) setTimeout(ask, 1000);
}

/** The row's status lines (role="status": "Saved.", an error), as they are: a row replaced keeps what they say. */
const statuses = (row: Element) => [...row.querySelectorAll<HTMLElement>('[role="status"]')];

/** A row, with what follows it until the next row (a project's pages beneath it). */
const group = (row: Element) => {
  const out = [row];
  for (let n = row.nextElementSibling; n && !(n as HTMLElement).dataset.live; n = n.nextElementSibling) out.push(n);
  return out;
};

/** Whether a row has the focus in a field: someone is typing there, and its new state waits. */
const typing = (row: Element) => {
  const a = document.activeElement;
  return (
    !!a &&
    row.contains(a) &&
    (a.matches("textarea, select, [contenteditable]") ||
      (a.matches("input") && !/^(checkbox|radio|button|submit)$/.test((a as HTMLInputElement).type)))
  );
};

/** Whether row `r` comes before a row with sort `s` in `el`'s order. */
const ahead = (el: HTMLElement, r: HTMLElement, s: number | string) => {
  const a = r.dataset.sort ?? "";
  const c = typeof s == "number" && a != "" && !Number.isNaN(Number(a)) ? Number(a) - s : a.localeCompare(String(s));
  return el.dataset.liveOrder == "asc" ? c < 0 : c > 0;
};

/**
 * Puts `key`'s row in `el` as it is now, in its place; null takes it out. False: not now (someone is typing in it, and
 * it isn't the page's own change).
 */
function put(el: HTMLElement, o: LiveList, key: string, row: Row): boolean {
  const old = el.querySelector<HTMLElement>(`:scope > [data-live="${CSS.escape(key)}"]`);
  if (old && typing(old) && !own.has(key)) return false;
  own.delete(key);
  if (!row) {
    if (old) {
      o.removing?.(old);
      old.remove();
    }
    return true;
  }
  const t = document.createElement("template");
  t.innerHTML = row.html.trim();
  const fresh = t.content.firstElementChild as HTMLElement | null;
  if (!fresh) return true;
  // The focus stays where it was: on the same control of the new row.
  const focusables = (r: Element) => [...r.querySelectorAll<HTMLElement>("a, button, input, select, textarea")];
  const at = old ? focusables(old).indexOf(document.activeElement as HTMLElement) : -1;
  const moving = old ? group(old).slice(1) : [];
  const said = old ? statuses(old) : [];
  statuses(fresh).forEach((s, i) => {
    const was = said[i];
    if (was?.textContent && !s.textContent) {
      s.textContent = was.textContent;
      s.className = was.className;
    }
  });
  if (old) old.replaceWith(fresh);
  // Its place, in the list's order: before the first row it comes ahead of; else after the last row.
  const others = [...el.querySelectorAll<HTMLElement>(":scope > [data-live]")].filter((r) => r != fresh);
  const next = others.find((r) => !ahead(el, r, row.sort));
  const prev = next ? next.previousElementSibling : others.length ? group(others[others.length - 1]).at(-1)! : null;
  if (next) {
    if (fresh.nextElementSibling != next || moving.length) el.insertBefore(fresh, next);
  } else if (prev) {
    if (prev != fresh) prev.after(fresh);
  } else if (!old) el.append(fresh);
  fresh.after(...moving);
  el.hidden = false;
  o.wire(fresh);
  if (at >= 0) focusables(fresh)[at]?.focus({ preventScroll: true });
  return true;
}
