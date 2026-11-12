// People and their documents, for the documents journeys: a fresh person signed in by a cookie on the worker's server,
// the operations as their pages run them, and an agent's tools over a token.
//
// A fresh person's list starts empty, and only their own journey changes it. So a journey as a fresh person may
// expect exact rows. A journey as DEV_LOGIN ("tester") may not: all files of a worker link their fixtures as
// tester's documents (the trap in e2e/helpers/server.ts).

import { expect, settle, until, type Page, type Server } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { runTool, textOf } from "../helpers/tools";

export interface Name {
  id: string;
  owner: string;
  title: string;
  slug: string;
  address: string;
  titleSet: boolean;
  slugSet: boolean;
}

let people = 0;
/** A login that no one has used on any server yet. */
export const freshLogin = (prefix = "w") =>
  `${prefix}${Date.now().toString(36)}${(++people).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** A fresh login of the letters acefghjknq only: it holds none of the words that the Find step types (a row's address has the login). */
export const quietLogin = () => `w${String(Date.now() * 100 + ++people).replace(/\d/g, (d) => "acefghjknq"[+d])}`;

/** A person on server `s` (a fresh login unless given), signed in by a cookie, and what they do with their documents. */
export async function person(s: Server, login = freshLogin()) {
  const base = s.root;
  const r = await fetch(`${base}/auth/github?as=${login}&next=/docs`, { redirect: "manual" });
  const cookie = r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => /^erga_session(_\d+)?=/.test(c));
  if (!cookie) throw new Error(`signing in at ${base}: ${r.status}`);
  const get = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { Cookie: cookie, ...(init.headers as Record<string, string>) } });
  /** An operation as this person, as their pages run it (from the site's own origin, unless `origin` says otherwise). */
  const tool = <T = any>(name: string, args: Record<string, unknown> = {}, origin?: string | null) =>
    runTool<T>(base, name, args, { cookie, ...(origin !== undefined ? { origin } : {}) });
  const p = {
    login,
    cookie,
    base,
    get,
    tool,
    /** The address that signs the browser in as this person, and goes on to `next`. */
    signIn: (next = "/docs") => `${base}/auth/github?as=${login}&next=${encodeURIComponent(next)}`,
    /** The list (/docs) as the server sends it. */
    docs: async () => (await get("/docs")).text(),
    /** A document's title and address. */
    nameOf: async (id: string): Promise<Name> => (await tool<Name>("ls", { document: id })).result!,
    /** Makes a document with /new, which sends its maker to its editor at its address: the document's id. */
    async make(query = ""): Promise<string> {
      const made = await get(`/new${query}`);
      const at = made.headers.get("location") ?? "";
      expect(made.status, `/new${query}`).toBe(302);
      expect(at.startsWith(`/${login}/`), at).toBe(true);
      const name = ((await (await get(`${at.replace(/[?&]edit=?$/, "")}/api/doc`)).json()) as { docName: Name }).docName;
      expect(`${name.address}?edit`).toBe(at);
      return name.id;
    },
    /** Shares a document with someone; role "none" stops it. */
    async share(id: string, who: string, role: "editor" | "commenter" | "viewer" | "none") {
      expect((await tool("share_document", { document: id, login: who, role })).status).toBe(200);
    },
    exists: async (id: string) => [200, 302].includes((await get(`/d/${id}`)).status),
    /** An agent with a token of theirs (made as Settings makes one): each tool's status, and its answer as JSON. */
    async agent(label = "Documents journey") {
      const { token, error } = await newToken(base, { label, scope: "documents" }, cookie);
      expect(token, error).toBeTruthy();
      return async <T = any>(name: string, args: Record<string, unknown> = {}) => {
        const a = await runTool(base, name, args, { token });
        let data = null as T;
        try {
          data = JSON.parse(a.ok ? textOf(a.result) : "") as T;
        } catch {
          /* not JSON */
        }
        return { status: a.status, error: a.error ?? "", data };
      };
    },
  };
  // Their first request with the cookie gives them a user's row, as when they open their list.
  expect((await get("/docs")).ok).toBe(true);
  return p;
}
export type Person = Awaited<ReturnType<typeof person>>;
export type Agent = Awaited<ReturnType<Person["agent"]>>;

/** As someone who keeps the agent pane closed (it opens by itself in the editor otherwise, and takes the focus). */
export const agentClosed = (page: Page) =>
  page.addInitScript(() => {
    if (window.top != window) return;
    try {
      if (!sessionStorage.getItem("erga-test:agent-seeded")) {
        sessionStorage.setItem("erga-test:agent-seeded", "1");
        if (!localStorage.getItem("erga:settings:v1")) localStorage.setItem("erga:settings:v1", '{"agent":false}');
      }
    } catch {
      /* no storage */
    }
  });

/** The middle of the first element that matches `selector`, once it is on the page with nothing over it. */
export const middle = (page: Page, selector: string) =>
  until(
    () =>
      page.evaluate((s) => {
        const el = document.querySelector(s),
          r = el?.getBoundingClientRect();
        if (!el || !r?.width) return null;
        const x = r.x + r.width / 2,
          y = r.y + r.height / 2,
          top = document.elementFromPoint(x, y);
        return top && (el == top || el.contains(top)) ? { x, y } : null;
      }, selector),
    5000,
    `${selector} is on the page, with nothing over it`
  ) as Promise<{ x: number; y: number }>;

/** The quick search (⌘K) as a person sees it: its groups, its rows (label and address), the row chosen; null while it is closed. */
export const pane = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector<HTMLElement>(".erga-qs");
    if (!r || r.hidden) return null;
    return {
      groups: [...r.querySelectorAll(".erga-qs-group")].map((g) => g.textContent ?? ""),
      rows: [...r.querySelectorAll(".erga-qs-item")].map((i) => i.textContent ?? ""),
      picked: r.querySelector('[aria-selected="true"]')?.textContent ?? null,
    };
  });

/** What a list's socket hears and each ask for rows, from now on: call it before the page opens. */
export function listenNews(page: Page) {
  const heard: string[] = [],
    asks: string[] = [],
    /** The asks with no answer yet. */
    open = new Set<unknown>(),
    /** All of it with its time, for a failure's message. */
    log: string[] = [],
    t0 = Date.now(),
    say = (line: string) => log.push(`${Date.now() - t0} ${line}`),
    rows = (r: { url(): string }) => r.url().includes("/api/news/rows");
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/api/news")) return;
    // A new socket is a new page's (a reload), or the page's own again: what the page before heard and asked is over.
    // Trap: a reload ends the old page's ask with no answer. Counted as open, it never closes, and the list never
    // "catches up"; and the old page's first message is not the new page's.
    heard.length = asks.length = 0;
    open.clear();
    say("socket");
    ws.on("framereceived", (f) => {
      heard.push(String(f.payload));
      say(`heard ${String(f.payload).slice(0, 200)}`);
    });
  });
  page.on("request", (r) => {
    if (!rows(r)) return;
    asks.push(r.url());
    open.add(r);
    say(`ask ${r.url().slice(-60)}`);
  });
  const ended = (r: { url(): string }) => void (open.delete(r) && say("answered or ended"));
  page.on("requestfinished", ended).on("requestfailed", ended);
  return {
    heard,
    asks,
    /**
     * The list has heard its socket's first answer (what changed since a little before the page was made: the rows
     * just made, again), and every ask has its answer on the page: the rows stay until the next change. Then it
     * forgets what it heard. (An admin's socket hears of users and settings too: the list asks only for documents.)
     */
    async caughtUp() {
      await until(
        () => heard.length > 0 && (!heard[0].includes('"key":"doc:') || asks.length > 0) && !open.size,
        5000,
        "the list caught up",
        () => ({ at: Date.now() - t0, heard: heard.length, asks: asks.length, open: open.size, log: log.slice(-30) })
      );
      await settle(page);
      heard.length = asks.length = 0;
    },
  };
}
