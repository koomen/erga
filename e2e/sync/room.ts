// A document's room, for the sync journeys (trimmed from the old multiplayer suite):
//
//   roomOf(address)   what the server stores and serves for the document's files, and its room's address
//   Person            a person with no browser (a Replica, e2e/helpers/room.ts), whom the others see in the room
//   crowd()           the people of one test: join() makes each one, leave() closes them all at the test's end
//   secondPage        the document in another page of the test's browser, for a second person
//
// Trap: a Person's edit is on its own replica at once, and in the room a moment later. A check of the room, of a tab
// or of another Person waits for it (until, converged).

import type { Author } from "../../document/content";
import { editor, TIMESCALE, type Editor } from "../helpers/editor";
import { agentClosed, until, type Tab } from "../helpers/fixtures";
import { Replica, roomUrl } from "../helpers/room";

export interface Room {
  /** The document's address (no ?edit): its API is under it. */
  base: string;
  /** The room's WebSocket address. */
  socket: string;
  /** What storage holds for a file, and its etag; null when it has no such file. */
  stored(path?: string): Promise<{ text: string; etag: string } | null>;
  /** What the server serves for a file to the page: the room's latest text. */
  served(path?: string): Promise<string | null>;
  /** An edit that arrives as a whole file (a publish), made from the stored version `ifMatch`. */
  push(text: string, ifMatch: string, path?: string): Promise<Response>;
}

const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function roomOf(address: string): Room {
  return {
    base: address,
    socket: roomUrl(address),
    async stored(path = "index.html") {
      const r = await fetch(`${address}/api/stored/${enc(path)}`);
      if (r.status == 404) return null;
      if (!r.ok) throw new Error(`stored ${path}: ${r.status}`);
      return { text: await r.text(), etag: (r.headers.get("etag") ?? "").replace(/"/g, "") };
    },
    async served(path = "index.html") {
      const r = await fetch(`${address}/doc/${enc(path)}`);
      return r.ok ? r.text() : null;
    },
    push: (text, ifMatch, path = "index.html") =>
      fetch(`${address}/api/stored/${enc(path)}`, { method: "PUT", body: text, headers: { "If-Match": `"${ifMatch}"` } }),
  };
}

/** A person of the sync journeys: shown to the others in the room, as a tab's person is. */
export class Person extends Replica {
  constructor(room: Room, name: string) {
    super(room.socket, name);
    this.present();
  }

  /** Inserts before the first `anchor` in the text. */
  insertBefore(anchor: string, s: string) {
    const i = this.str().indexOf(anchor);
    if (i < 0) throw new Error(`${this.name}: "${anchor}" is not in the text`);
    this.insert(i, s);
  }

  /** The names of the other people in the room, as this person's awareness has them. */
  others(): string[] {
    return [...this.socket.awareness.getStates()]
      .filter(([c, s]) => c != this.ydoc.clientID && s.user)
      .map(([, s]) => (s.user as Author).name);
  }

  /** Goes off the network. Its edits stay on its replica until it comes back. */
  offline() {
    this.socket.disconnect();
  }
  /** Comes back, in the background. */
  online() {
    this.socket.connect();
  }
  /** Waits until this person's text holds `s`: an edit of another person has arrived. */
  has(s: string, ms = 5000): Promise<void> {
    return new Promise((done, fail) => {
      const check = () => {
        if (!this.str().includes(s)) return;
        clearTimeout(limit);
        this.ydoc.off("update", check);
        done();
      };
      const limit = setTimeout(() => {
        this.ydoc.off("update", check);
        fail(new Error(`${this.name} did not get "${s}" within ${ms} ms`));
      }, ms);
      this.ydoc.on("update", check);
      check();
    });
  }
}

/** The people with no browser of one test. */
export function crowd() {
  const all: Person[] = [];
  return {
    /** A person joins the room: with the room's text, and its name on its edits, as a tab's. */
    join(room: Room, name: string): Promise<Person> {
      const p = new Person(room, name);
      all.push(p);
      return p.joined();
    },
    /** Everyone leaves (at the end of a test, also one that failed). */
    leave() {
      for (const p of all.splice(0)) p.leave();
    },
  };
}

/** Waits until all the people hold the same text, and returns it. */
export async function converged(ps: Person[], ms = 5000): Promise<string> {
  await until(
    () => ps.every((p) => p.str() == ps[0].str()),
    ms,
    "the people have the same text",
    () => ps.map((p) => ({ who: p.name, connected: p.connected, length: p.str().length }))
  );
  return ps[0].str();
}

/** Seeded random numbers (mulberry32): a failure names its seed, and ERGA_SEED=n plays the same run again. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  });
}
export const SEED = Number(process.env.ERGA_SEED) || Date.now() % 1_000_000;

/**
 * The document of `first` in another page of the same browser, in the editor, as `user` (none: the same person in a
 * second tab). Its errors count as the test's. The page closes with the test's browser.
 */
export async function secondPage(tab: Tab, first: Editor, user?: string): Promise<Editor> {
  const page = await tab.page.context().newPage();
  page.on("pageerror", (e) => tab.errors.push(e.stack ?? e.message));
  page.on("console", (m) => {
    if (m.type() == "error") tab.errors.push(`console.error: ${m.text()}`);
  });
  const size = tab.page.viewportSize();
  if (size) await page.setViewportSize(size);
  // As openEditor's page: fast timers, the check that the page shows its HTML, and the agent pane closed.
  await agentClosed(page);
  await page.addInitScript((timescale) => {
    if (window.top != window) return;
    (window as any).__ergaTimescale = timescale;
    (window as any).__ergaCheck = true;
  }, TIMESCALE);
  await page.goto(`${first.address}${user ? `?user=${encodeURIComponent(user)}&edit` : "?edit"}`);
  const ed = editor(page, { address: first.address, dir: first.dir, file: first.file });
  await ed.loaded();
  await ed.frame(`${ed.F}.fonts.ready.then(() => true)`);
  return ed;
}

/** The names on the other people's carets on a person's page, "|"-joined. */
export const peerNames = (ed: Editor) =>
  ed.frame<string>(`[...${ed.F}.querySelectorAll("erga-peer-name")].map((e) => e.textContent).join("|")`);
/** Whether another person's caret on the page sits in the element. */
export const peerCaretIn = (ed: Editor, selector: string) =>
  ed.frame<boolean>(
    `(() => { const w = ${ed.W}, r = ${ed.F}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [...${ed.F}.querySelectorAll("erga-peer")].some((c) => { const y = parseFloat(c.style.top) - w.scrollY; return y >= r.top - 2 && y < r.bottom; }); })()`
  );
