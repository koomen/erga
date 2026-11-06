// Offline editing: the connection goes while you edit, and nothing changes but a quiet note. You type on, reload, type
// more; when the connection is back, every edit reaches the server, merged with what changed there meanwhile
// (libs/text/ui/collab.ts, `keep`; libs/text/ui/kept.ts; client/inline/offline-sw.ts; libs/text/ui/offline-page.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, servers, test, until, type Tab } from "../../helpers/fixtures";
import { DISK_MS, F, openEditor, type Editor } from "../../helpers/editor";

await servers.main();

const NOTE = "Offline. Your edits will sync when you reconnect.";

/** Every socket a page of the tab opens, in each frame: to close them as a lost connection does. */
async function watchSockets(tab: Tab) {
  await tab.page.addInitScript(() => {
    const sockets: WebSocket[] = ((window as any).__sockets = []);
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    } as typeof WebSocket;
  });
}

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

/** The connection's own errors, offline (a request or a socket that fails): the test's tab keeps any other. */
function withoutOffline(errors: string[]) {
  const left = errors.filter(
    (e) =>
      !/^console\.error: (Failed to load resource|WebSocket connection to '[^']*' failed)\b.*net::ERR_(INTERNET_DISCONNECTED|FAILED)\b/.test(
        e
      )
  );
  errors.splice(0, errors.length, ...left);
}

/** The note in the tab's corner, or null. */
const note = (ed: Editor) => ed.eval<string | null>(`document.querySelector(".erga-live-note")?.textContent ?? null`);

/** After a reload offline: the shell is up, and the editor on the page, from what this browser kept. */
async function editorBack(ed: Editor) {
  await until(() => ed.eval<boolean>(`!!window.ergaPage`).catch(() => false), 15_000, "the shell, from the browser's copy");
  await until(
    () => ed.frame<boolean>(`!!window.ergaFrame?.page && ${F}.querySelectorAll("[data-erga-text]").length > 0`),
    15_000,
    "the editor on the page, offline"
  );
}

test("offline: type on, see the note, reload, type more; back online, every edit reaches the server and the note goes", {
  timeout: 90_000,
}, async ({ tab }) => {
  await watchSockets(tab);
  const ed = await openEditor(tab, await servers.main(), "multi");
  await workersIn(ed);
  await ed.clickEnd("main p");
  await ed.type(" Milk.");
  await until(() => ed.disk().includes(" Milk.</p>"), DISK_MS, "the first edit on disk");

  await goOffline(ed);
  await ed.type(" Eggs.");
  await expect.poll(() => note(ed), { timeout: 10_000 }).toBe(NOTE);

  await ed.page.reload();
  await editorBack(ed);
  await expect.poll(() => ed.textOf("main p"), { timeout: 10_000 }).toContain("Milk. Eggs.");
  // The page's own stylesheet came from the copy too.
  expect(await ed.frame<string>(`getComputedStyle(${F}.body).maxWidth`)).not.toBe("none");
  await expect.poll(() => note(ed), { timeout: 10_000 }).toBe(NOTE);
  await ed.clickEnd("main p");
  await ed.type(" Bread.");
  expect(ed.disk(), "nothing reached the server while offline").not.toContain("Eggs.");

  await ed.page.context().setOffline(false);
  await until(
    () => ed.disk().includes(" Milk. Eggs. Bread.</p>"),
    DISK_MS,
    "every edit on disk, once",
    () => ed.disk()
  );
  await expect.poll(() => note(ed), { timeout: 15_000 }).toBeNull();
  expect(ed.disk().split("Milk.").length, "nothing doubled").toBe(2);
  withoutOffline(tab.errors);
});

test("offline while the server's text changes: both edits are in the result, each once", { timeout: 90_000 }, async ({ tab }) => {
  await watchSockets(tab);
  const ed = await openEditor(tab, await servers.main(), "multi");
  await workersIn(ed);
  await goOffline(ed);
  await ed.clickEnd("main p");
  await ed.type(" Typed offline.");
  // Meanwhile someone else changes the title (on disk: the room takes it in).
  writeFileSync(ed.file, ed.disk().replace("<h1>Field guide</h1>", "<h1>Field guide, second edition</h1>"));
  await ed.page.reload();
  await editorBack(ed);
  await expect.poll(() => ed.textOf("main p")).toContain("Typed offline.");
  await ed.clickEnd("main p");
  await ed.type(" More.");

  await ed.page.context().setOffline(false);
  await until(
    () => {
      const d = ed.disk();
      return d.includes("<h1>Field guide, second edition</h1>") && d.includes(" Typed offline. More.</p>");
    },
    DISK_MS,
    "both edits on disk",
    () => ed.disk()
  );
  await expect.poll(() => ed.textOf("h1"), { timeout: 10_000 }).toBe("Field guide, second edition");
  expect(ed.disk().split("second edition").length, "nothing doubled").toBe(2);
  expect(ed.disk().split("Typed offline.").length, "nothing doubled").toBe(2);
  withoutOffline(tab.errors);
});

test("the pages origin: Erga's worker only, never a document's file of its name or any other worker; each document's copy and replica are its own", async ({
  tab,
}) => {
  const s = await servers.main();
  const ed = await openEditor(tab, s, "multi");
  // A file of the worker's name in the document.
  const dir = join(ed.file, "..");
  writeFileSync(join(dir, "erga-sw.js"), `self.addEventListener("fetch", (e) => e.respondWith(new Response("owned")));`);
  await until(
    () => ed.frame<boolean>(`navigator.serviceWorker.getRegistration("/").then((r) => !!r?.active)`),
    10_000,
    "the page's worker"
  );
  const origin = await ed.frame<string>(`location.origin`);
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
  const scopes = await ed.frame<string[]>(`navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => r.scope))`);
  expect(scopes).toEqual([`${origin}/`]);

  // Another document's origin: its copy and its replica hold only its own.
  const other = await openEditor(tab, s, "page");
  await until(
    () => other.frame<boolean>(`navigator.serviceWorker.getRegistration("/").then((r) => !!r?.active)`),
    10_000,
    "the other page's worker"
  );
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
  expect(readFileSync(join(dir, "erga-sw.js"), "utf8")).toContain("owned");
  // (The refused worker's script, as the browser reports it: on purpose.)
  tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/\b403\b/.test(e)));
});

/** What an origin keeps for offline, as a frame of it sees it: the worker's copy, the replicas, Erga's worker. */
const KEPT = `(async () => ({
  copy: (await caches.keys()).includes("erga-offline-v1"),
  replicas: (await indexedDB.databases()).some((d) => d.name == "erga-replicas"),
  worker: (await navigator.serviceWorker.getRegistrations()).some((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL.endsWith("/erga-sw.js")),
}))()`;

test("sign-out deletes every offline copy in this browser: the app's origin's and the document's pages origin's", {
  timeout: 60_000,
}, async ({ tab }) => {
  const ed = await openEditor(tab, await servers.main(), "multi");
  await workersIn(ed);
  await ed.clickEnd("main p");
  await ed.type(" Milk.");
  const pages = await ed.frame<string>(`location.origin`);
  const all = { copy: true, replicas: true, worker: true };
  await expect.poll(() => ed.frame(KEPT)).toEqual(all);
  await expect.poll(() => ed.eval(KEPT)).toEqual(all);

  // Sign out, from the account menu's link.
  await ed.eval(`location.assign("/auth/logout")`);
  await until(
    () => ed.page.evaluate(() => location.pathname == "/" && document.readyState == "complete").catch(() => false),
    15_000,
    "signed out, on the homepage"
  );
  const none = { copy: false, replicas: false, worker: false };
  expect(await ed.eval(KEPT), "the app's origin").toEqual(none);
  // The pages origin, in a frame of this page as the editor's was.
  await ed.eval(
    `new Promise((r) => { const f = document.createElement("iframe"); f.id = "probe"; f.src = ${JSON.stringify(`${pages}/erga-sw.js`)}; f.onload = r; document.body.append(f); })`
  );
  const probe = ed.page.frames().find((f) => f.url().startsWith(pages))!;
  expect(await probe.evaluate(KEPT), "the pages origin").toEqual(none);
});
