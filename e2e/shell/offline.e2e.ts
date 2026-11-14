// Offline editing, on one page. The connection goes while you edit: you type on, reload, type more; back online, every
// edit reaches the server, merged with what changed there. Then sign-out: it deletes what this browser kept, in the
// app's origin and in each document's pages origin, and a tab that is still open keeps nothing more.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { DISK_MS, F, openEditor, type Editor } from "../helpers/editor";
import { expect, journey, servers, test, until, type Tab } from "../helpers/fixtures";
import { idOf, runTool } from "../helpers/tools";
import { soon } from "./shell";

const s = await servers.main();

const NOTE = "Edits not saved yet";

/** What an origin keeps for offline, as a frame of it sees it: the worker's copy, the replicas, Erga's worker. */
const KEPT = `(async () => ({
  copy: (await caches.keys()).includes("erga-offline-v1"),
  replicas: (await indexedDB.databases()).some((d) => d.name == "erga-replicas"),
  worker: (await navigator.serviceWorker.getRegistrations()).some((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith("/erga-sw.js")),
}))()`;
const ALL = { copy: true, replicas: true, worker: true };
const NONE = { copy: false, replicas: false, worker: false };

/** Every socket a page of the tab opens, in each frame: to close them as a lost connection does. */
const watchSockets = (page: Page) =>
  page.addInitScript(() => {
    const sockets: WebSocket[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    } as typeof WebSocket;
  });

/** The connection goes: the browser offline, and every open socket closed (in the tab and the page's frame). */
async function goOffline(ed: Editor) {
  await ed.page.context().setOffline(true);
  // (Until none opens again: a socket that reconnects in the moment before the browser is offline gets closed too.)
  await until(
    async () => {
      for (const f of ed.page.frames()) await f.evaluate(`(window.__sockets ?? []).forEach((s) => s.close())`).catch(() => {});
      return !(await ed.eval<boolean>(`ergaPage.collab.connected`));
    },
    10_000,
    "the tab's socket closed"
  );
}

/** The workers of the tab's origin and the page's are in, and have what the pages loaded before they were theirs. */
async function workersIn(ed: Editor) {
  const active = `navigator.serviceWorker.getRegistration("/").then((r) => !!r?.active)`;
  await until(() => ed.frame<boolean>(active), 10_000, "the page's worker");
  await until(() => ed.eval<boolean>(active), 10_000, "the shell's worker");
  const kept = `caches.open("erga-offline-v1").then((c) => c.match(location.href.replace(/[?#].*$/, "") + "?edit=&erga-page=")).then((r) => !!r)`;
  await until(() => ed.eval<boolean>(kept), 10_000, "the shell's page in the copy");
}

/**
 * Takes the connection's own errors out, offline (a request or a socket that fails): the tab keeps any other. And the
 * refused worker's script (the step that registers a document's file): the browser reports it a second time at
 * times, late, now that the page's frame has a process of its own.
 */
function withoutOffline(tab: Tab) {
  const left = tab.errors.filter(
    (e) =>
      !/^console\.error: (Failed to load resource|WebSocket connection to '[^']*' failed)\b.*net::ERR_(INTERNET_DISCONNECTED|FAILED)\b/.test(
        e
      ) && !/^console\.error: Failed to load resource: the server responded with a status of 403\b/.test(e)
  );
  tab.errors.splice(0, tab.errors.length, ...left);
}

/** The note for edits that are not on the server yet: the alerts' one line (libs/text/ui/unsaved.ts raises it); null: none. */
const note = (ed: Editor) =>
  ed
    .alerts()
    .then((a) => (a.view == "line" ? a.head : null))
    .catch(() => null);

journey("offline, and back; then sign-out", () => {
  let ed: Editor, other: Editor;
  /** The first document's pages origin. */
  let origin: string;

  test("online, an edit saves at once, with no note", async ({ tab }) => {
    await watchSockets(tab.page);
    ed = await openEditor(tab, s, "multi");
    await workersIn(ed);
    await ed.clickEnd("main p");
    await ed.type(" Milk.");
    await until(() => ed.disk().includes(" Milk.</p>"), DISK_MS, "the first edit on disk");
    expect(await note(ed)).toBeNull();
  });

  test("the pages origin has Erga's worker only, never a document's file of its name or any other worker", async ({ tab }) => {
    // A file of the worker's name in the document.
    const file = join(ed.dir, "erga-sw.js");
    writeFileSync(file, `self.addEventListener("fetch", (e) => e.respondWith(new Response("owned")));`);
    origin = await ed.frame<string>(`location.origin`);
    await until(() => ed.frame<boolean>(`fetch("erga-sw.js", { cache: "no-store" }).then((r) => r.ok)`), 10_000, "the document's own file");
    // At the origin's root: Erga's script, never the document's file.
    const root = await ed.frame<string>(`fetch("/erga-sw.js", { cache: "no-store" }).then((r) => r.text())`);
    expect(root).toContain("erga-offline-v1");
    expect(root).not.toContain("owned");
    // The document's file is only a file, at its own address; as a worker it's refused, and so is any other.
    expect(await ed.frame<string>(`fetch("erga-sw.js", { cache: "no-store" }).then((r) => r.text())`)).toContain("owned");
    expect(
      await ed.frame<number>(`fetch("erga-sw.js", { cache: "no-store", headers: { "Service-Worker": "script" } }).then((r) => r.status)`)
    ).toBe(403);
    expect(await ed.frame<string>(`navigator.serviceWorker.register("erga-sw.js").then(() => "registered", (e) => e.name)`)).not.toBe(
      "registered"
    );
    expect(await ed.frame<string[]>(`navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => r.scope))`)).toEqual([
      `${origin}/`,
    ]);
    expect(readFileSync(file, "utf8")).toContain("owned");
    // (The refused worker's script, as the browser reports it: on purpose.)
    await until(() => tab.errors.some((e) => /\b403\b/.test(e)), 5000, "the browser reports the refused worker");
    tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/\b403\b/.test(e)));
  });

  test("offline: type on, see the note, reload, type more; nothing reaches the server", async ({ tab }) => {
    await goOffline(ed);
    // Offline with no edit: still no note.
    await ed.settle();
    expect(await note(ed)).toBeNull();
    await ed.type(" Eggs.");
    await soon(() => note(ed), 10_000).toBe(NOTE);
    // A click on the line opens the card, which says more; Escape gives the line back: it stops nothing.
    await ed.page.click("#alerts .alerts-pill");
    expect((await ed.alerts()).alerts).toEqual([
      { title: NOTE, count: "", detail: "Connection · Erga saves them when the connection is back.", rows: [], buttons: [] },
    ]);
    await ed.press("Escape");
    await soon(() => note(ed)).toBe(NOTE);
    // Meanwhile someone else changes the title (on disk: the room takes it in).
    ed.write(ed.disk().replace("<h1>Field guide</h1>", "<h1>Field guide, second edition</h1>"));

    await ed.page.reload();
    // The shell is up, and the editor on the page, from what this browser kept.
    await until(() => ed.eval<boolean>(`!!window.ergaPage`).catch(() => false), 10_000, "the shell, from the browser's copy");
    await until(
      () => ed.frame<boolean>(`!!window.ergaFrame?.page && ${F}.querySelectorAll("[data-erga-text]").length > 0`),
      10_000,
      "the editor on the page, offline"
    );
    await soon(() => ed.textOf("main p"), 10_000).toContain("Milk. Eggs.");
    // The page's own stylesheet came from the copy too.
    expect(await ed.frame<string>(`getComputedStyle(${F}.body).maxWidth`)).not.toBe("none");
    await soon(() => note(ed), 10_000).toBe(NOTE);
    await ed.clickEnd("main p");
    await ed.type(" Bread.");
    await soon(() => ed.textOf("main p")).toContain("Milk. Eggs. Bread.");
    expect(ed.disk(), "nothing reached the server while offline").not.toContain("Eggs.");
    expect(await ed.textOf("h1"), "nor the server's change this tab").toBe("Field guide");
    // Offline, a request or a socket fails at any time, and the browser logs it. The next step, online, takes these out
    // of the tab's errors, and fails for any other error of this step.
    tab.strict = false;
  });

  test("back online: every edit reaches the server, with the change made there, each once; the note goes", async ({ tab }) => {
    await ed.page.context().setOffline(false);
    await until(
      () => {
        const d = ed.disk();
        return d.includes("<h1>Field guide, second edition</h1>") && d.includes(" Milk. Eggs. Bread.</p>");
      },
      DISK_MS,
      "both edits on disk",
      () => ed.disk()
    );
    await soon(() => ed.textOf("h1"), 10_000).toBe("Field guide, second edition");
    await soon(() => note(ed), 10_000).toBeNull();
    for (const once of ["Milk.", "Eggs.", "Bread.", "second edition"])
      expect(ed.disk().split(once).length, `${once} is not doubled`).toBe(2);
    withoutOffline(tab);
    tab.strict = true;
  });

  // Before, the tab that stayed open kept its copy and its replica again as soon as it typed.
  test("sign-out in another tab: this tab types on, and keeps nothing more in either origin", async ({ tab }) => {
    await soon(() => ed.frame(KEPT)).toEqual(ALL);
    await soon(() => ed.eval(KEPT)).toEqual(ALL);
    // Tab B signs out.
    const b = await tab.page.context().newPage();
    await b.goto(`${new URL(ed.address).origin}/auth/logout`);
    await until(
      () => b.evaluate(() => location.pathname == "/" && document.readyState == "complete").catch(() => false),
      10_000,
      "tab B signed out"
    );
    await b.close();
    await soon(async () => ({ app: await ed.eval(KEPT), pages: await ed.frame(KEPT) })).toEqual({ app: NONE, pages: NONE });

    // Tab A types: the edit reaches the room, and nothing goes into this browser's storage again.
    await ed.clickEnd("main p");
    await ed.type(" Jam.");
    await until(() => ed.disk().includes(" Milk. Eggs. Bread. Jam.</p>"), DISK_MS, "the edit on disk");
    await until(async () => (await ed.source()).includes("Jam."), 10_000, "the shell's replica has the edit");
    expect({ app: await ed.eval(KEPT), pages: await ed.frame(KEPT) }, "each origin keeps nothing").toEqual({ app: NONE, pages: NONE });
    withoutOffline(tab);
    // This tab is signed out: the server refuses what its shell asks for (401), at any time from now, and the browser
    // logs each refusal. The next step, signed in again, takes them out, and fails for any other error of this step.
    tab.strict = false;
  });

  test("signed in again, on another document: the browser keeps again; that document's copy and replica are its own", async ({ tab }) => {
    // (With no cookie, the dev server signs a request in.)
    await tab.page.context().clearCookies();
    other = await openEditor(tab, s, "page");
    tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/status of 401 \(Unauthorized\)/.test(e)));
    await workersIn(other);
    await other.clickEnd("h1");
    await other.type("!");
    await soon(() => other.frame(KEPT)).toEqual(ALL);
    await soon(() => other.eval(KEPT)).toEqual(ALL);
    const here = await other.frame<{ origin: string; urls: string[]; rooms: string[] }>(`(async () => {
      const c = await caches.open("erga-offline-v1");
      const urls = (await c.keys()).map((r) => r.url);
      const db = await new Promise((r) => { const o = indexedDB.open("erga-replicas"); o.onsuccess = () => r(o.result); });
      const rooms = await new Promise((r) => { const q = db.transaction("rooms").objectStore("rooms").getAllKeys(); q.onsuccess = () => r(q.result); });
      return { origin: location.origin, urls, rooms };
    })()`);
    expect(here.origin).not.toBe(origin);
    expect(here.urls.filter((u) => u.startsWith(here.origin)).length, "its own page is in its copy").toBeGreaterThan(0);
    expect(
      here.urls.filter((u) => u.startsWith(origin)),
      "nothing of the first document's"
    ).toEqual([]);
    expect(here.rooms.length, "one document's replica").toBe(1);
  });

  test("the document is deleted while it is open in the editor: the note says so, and its sockets are closed for good", async ({ tab }) => {
    expect((await runTool(s.root, "delete_document", { document: await idOf(other.address) })).status).toBe(200);
    await soon(() => other.eval<string | null>(`document.querySelector(".erga-live-note")?.textContent ?? null`), 10_000).toBe(
      "This document was deleted."
    );
    // The shell's connection has ended (shared/socket-phase.ts: it never comes back by itself), and every room socket of the page is closed.
    await soon(() => other.eval<string>(`ergaPage.collab.status`)).toBe("gone");
    await soon(() =>
      other.frame<number[]>(`(window.__sockets ?? []).filter((w) => w.url.includes("/api/room")).map((w) => w.readyState)`)
    ).toEqual([3]);
    // What the page still asks of the deleted document, the server refuses (404), at any time from now, and the browser
    // logs it. The last step looks at the tab's errors itself, and fails for any other one.
    tab.strict = false;
  });

  test("sign-out deletes every offline copy in this browser: the app's origin's and the document's pages origin's", async ({ tab }) => {
    const pages = await other.frame<string>(`location.origin`);
    expect({ app: await other.eval(KEPT), pages: await other.frame(KEPT) }, "before, each origin keeps its copy").toEqual({
      app: ALL,
      pages: ALL,
    });
    // Sign out, from the account menu's link.
    await other.eval(`location.assign("/auth/logout")`);
    await until(
      () => other.page.evaluate(() => location.pathname == "/" && document.readyState == "complete").catch(() => false),
      10_000,
      "signed out, on the homepage"
    );
    await soon(() => other.eval(KEPT)).toEqual(NONE);
    // The pages origin, in a frame of this page as the editor's was.
    await other.eval(
      `new Promise((r) => { const f = document.createElement("iframe"); f.id = "probe"; f.src = ${JSON.stringify(`${pages}/erga-sw.js`)}; f.onload = r; document.body.append(f); })`
    );
    const probe = other.page.frames().find((f) => f.url().startsWith(pages))!;
    await soon(() => probe.evaluate(KEPT)).toEqual(NONE);
    expect(tab.errors.filter((e) => !/status of 404|WebSocket connection to .* failed/.test(e))).toEqual([]);
  });
});
