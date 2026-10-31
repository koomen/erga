// Live pages, the page's side (server/news/ has the design). A list on the page says which rows it shows
// (data-live-kind="doc", data-live-view="docs") and when the server made it (data-live-at); each row says its key
// (data-live="doc:<id>") and its place (data-sort, highest first). One socket for the page (/api/news) hears which
// of its person's rows changed, whoever changed them; the page then asks for those rows only (/api/news/rows), and
// puts each in, in its place, replaces it, or takes it out. Nothing else on the page moves: focus, scroll, an open
// menu or a half-typed field stay as they are.
//
// A hidden tab waits until it shows. A dropped socket comes back by itself and says the last version it heard, so it
// hears what changed meanwhile. One ask at a time, so a later answer is never older than one before it.

import { backoff, live } from "../live/client";
import { PING, PONG } from "../../shared/room-socket";

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
let since = 0,
  socket: WebSocket | null = null,
  tries = 0,
  asking = false,
  heard = 0;

/** The page's ?user= (local development: who is signed in), for its asks. */
const user = () => new URLSearchParams(location.search).get("user");

/** Keeps `el`'s rows live. */
export function liveList(el: HTMLElement, o: LiveList): void {
  lists.set(el, o);
  // A little before the page was made, as the server's clock goes: a change in between is heard twice, never missed.
  since = Math.max(since, Number(el.dataset.liveAt || 0) - 5000);
  if (lists.size > 1) return;
  connect();
  // An idle socket can die without a close: a ping now and then, and one with no answer for a while is closed.
  setInterval(() => {
    if (!socket || socket.readyState != WebSocket.OPEN) return;
    if (Date.now() - heard > 75_000) return socket.close();
    socket.send(PING);
  }, 30_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ask();
  });
}

function connect() {
  const u = user();
  const ws = new WebSocket(
    `${location.protocol == "https:" ? "wss" : "ws"}://${location.host}/api/news${u ? `?user=${encodeURIComponent(u)}` : ""}`
  );
  socket = ws;
  heard = Date.now();
  ws.onopen = () => {
    tries = 0;
    ws.send(JSON.stringify({ since }));
    live((l) => l.connection("news", true));
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
    live((l) => l.connection("news", false));
    setTimeout(connect, backoff(tries++));
  };
}

/** The list that shows rows of `key`'s kind, if any. */
const listOf = (key: string) => [...lists.keys()].find((el) => key.startsWith(`${el.dataset.liveKind}:`));

/** Asks for the rows that changed, one ask at a time; a hidden tab waits until it shows. */
async function ask(): Promise<void> {
  if (asking || !pending.size || document.hidden) return;
  asking = true;
  try {
    const keys = [...pending];
    pending.clear();
    for (const [el, o] of lists) {
      const mine = keys.filter((k) => k.startsWith(`${el.dataset.liveKind}:`));
      if (!mine.length) continue;
      const q = new URLSearchParams({ view: el.dataset.liveView!, keys: mine.join(",") });
      if (user()) q.set("user", user()!);
      const r = await fetch(`/api/news/rows?${q}`, { headers: { Accept: "application/json" } }).catch(() => null);
      if (!r?.ok) {
        // Asked again with the next change, or after the socket comes back.
        mine.forEach((k) => pending.add(k));
        continue;
      }
      const { rows } = (await r.json()) as { rows: Record<string, { html: string; sort: number } | null> };
      for (const [key, row] of Object.entries(rows)) put(el, o, key, row);
      o.changed?.();
    }
  } finally {
    asking = false;
  }
  if (pending.size) setTimeout(ask, 500);
}

/** A row, with what follows it until the next row (a project's pages beneath it). */
const group = (row: Element) => {
  const out = [row];
  for (let n = row.nextElementSibling; n && !(n as HTMLElement).dataset.live; n = n.nextElementSibling) out.push(n);
  return out;
};

/** Puts `key`'s row in `el` as it is now, in its place; null takes it out. */
function put(el: HTMLElement, o: LiveList, key: string, row: { html: string; sort: number } | null) {
  const old = el.querySelector<HTMLElement>(`:scope > [data-live="${CSS.escape(key)}"]`);
  if (!row) {
    if (old) {
      o.removing?.(old);
      old.remove();
    }
    return;
  }
  const t = document.createElement("template");
  t.innerHTML = row.html.trim();
  const fresh = t.content.firstElementChild as HTMLElement | null;
  if (!fresh) return;
  // The focus stays where it was: on the same control of the new row.
  const focusables = (r: Element) => [...r.querySelectorAll<HTMLElement>("a, button, input, select, textarea")];
  const at = old ? focusables(old).indexOf(document.activeElement as HTMLElement) : -1;
  const moving = old ? group(old).slice(1) : [];
  // Its place: before the first row with a lower sort (the latest edit first).
  const before =
    [...el.querySelectorAll<HTMLElement>(":scope > [data-live]")].find((r) => r != old && Number(r.dataset.sort) < row.sort) ?? null;
  if (old) old.replaceWith(fresh);
  el.insertBefore(fresh, before);
  fresh.after(...moving);
  o.wire(fresh);
  if (at >= 0) focusables(fresh)[at]?.focus({ preventScroll: true });
}
