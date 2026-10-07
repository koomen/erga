// Open pages across a redeploy (src/page/live.ts), for the tests in this folder:
// the editor (scrolled, a selection, the help card open, an agent draft with a file attached), the admin Factory
// page (a task's detail open, an agent draft) and Documents, each open in a tab when the test's own server restarts.
//
// Whether a page reloads is watched from outside: each page's live checks (GET /api/release, every 1.5 s here
// rather than every minute) are counted as they answer, and a page that finds a new release says so on its console
// before it waits for a quiet moment to reload ("erga: a new release"). One check runs at a time, so a page that has
// had two answers since a moment has finished the first check after it, and said what it found.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle, until, type Page, type Server, type Tab } from "../fixtures";
import { editor } from "../editor";

/** A long document (to scroll) in the server's scratch folder, linked: its file and address. */
export async function longDoc(server: Server) {
  const dir = join(server.scratch, "docs", `long-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const paras = Array.from({ length: 80 }, (_, i) => `<h2>Part ${i + 1}</h2>\n<p>Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again, so the page is long enough to scroll.</p>`).join("\n");
  const file = join(dir, "index.html");
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><title>Long</title></head><body><h1>A long page</h1>\n${paras}\n</body></html>\n`);
  return { dir, file, address: await server.open(dir), disk: () => readFileSync(file, "utf8") };
}

/** A tab, watched: its errors, its live checks answered, and what it said about a new release. */
export interface Watched {
  page: Page;
  errors: string[];
  /** Live checks answered (GET /api/release, 200) since the tab opened. */
  checks: number;
  /** How many times the page said it found a new release. */
  stale: number;
}

function watch(page: Page, errors: string[]): Watched {
  const w: Watched = { page, errors, checks: 0, stale: 0 };
  page.on("response", (r) => { if (new URL(r.url()).pathname == "/api/release" && r.status() == 200) w.checks++; });
  page.on("console", (m) => { if (m.text().startsWith("erga: a new release")) w.stale++; });
  return w;
}

/** Waits until every page has had `n` more live checks answered than it had at `since` (by checks each). */
export async function checked(pages: Watched[], since: number[], n: number, ms = 20_000) {
  await until(() => pages.every((p, i) => p.checks >= since[i] + n), ms, `${n} live checks on every page`);
}

/** The three pages, open in the test's browser context on `server`, with the state a reload must keep. */
export async function openPages(tab: Tab, server: Server) {
  const ctx = tab.page.context();
  // Each page's live checks every second and a half rather than every minute.
  await ctx.addInitScript(() => { (window as { __ergaLivePoll?: number }).__ergaLivePoll = 1500; });
  const doc = await longDoc(server);

  // The editor: scrolled, a selection, the help card open, a draft and a file for the agent.
  const edPage = tab.page;
  await edPage.setViewportSize({ width: 1200, height: 800 });
  const ed = editor(edPage, { address: doc.address, dir: doc.dir, file: doc.file });
  const edW = watch(edPage, tab.errors);
  await edPage.goto(`${doc.address}#edit`);
  /** The editor up: listening on its event channel, the page rendered. */
  const edReady = (ms = 10_000) => until(async () => await ed.eval<boolean>(`!!window.ergaPage && document.body.classList.contains("erga-listening")`) && await ed.frame<boolean>(`!!document.getElementById("page").contentDocument?.querySelector("[data-erga-id]")`), ms, "the editor is open");
  await edReady();
  await ed.frame(`document.getElementById("page").contentWindow.scrollTo(0, 1500)`);
  await ed.frame(`(() => { const p = ergaFrame.page, at = p.state.doc.toString().indexOf("Paragraph 20:"); p.dispatch({ selection: { anchor: at, head: at + 9 } }); p.focus(); return true; })()`);
  const selection = () => ed.eval<{ anchor: number; head: number }>(`(() => { const m = ergaPage.state.selection.main; return { anchor: m.anchor, head: m.head }; })()`);
  await until(async () => { const s = await selection(); return s.head - s.anchor == 9; }, 5000, "a selection in the page");
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = "Make the title bigger"; i.dispatchEvent(new Event("input", { bubbles: true }));
    const dt = new DataTransfer(); dt.items.add(new File(["some notes"], "notes.txt", { type: "text/plain" })); i.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  // The keyboard shortcuts card (⌘/).
  await ed.eval(`(() => { const mac = /Mac/.test(navigator.platform); window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: mac, ctrlKey: !mac, bubbles: true })); return true; })()`);
  await until(() => ed.eval<boolean>(`!document.getElementById("help").hidden`), 3000, "the help card is open");
  await until(() => ed.eval<boolean>(`document.querySelectorAll(".agent-attachments .file-chip").length == 1`), 5000, "a file attached to the agent's draft");
  await until(async () => (await ed.eval<number>(`ergaPage.page.scrollY`)) > 1400, 5000, "the page is scrolled");
  // The focus back in the page (the paste above took it to the agent's box).
  await ed.frame(`ergaFrame.page.focus(), true`);

  // The admin Factory page: a board of two tasks (answered here, so no VM runs), the second one's detail open, a draft for the agent.
  const faPage = await ctx.newPage();
  const faErrors: string[] = [];
  faPage.on("pageerror", (e) => faErrors.push(e.stack ?? e.message));
  faPage.on("console", (m) => { if (m.type() == "error") faErrors.push(`console.error: ${m.text()}`); });
  const fa = watch(faPage, faErrors);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const tasks = [1, 2].map((n) => ({ id: n, title: `Task number ${n}`, description: "The ask.", status: "working", branch: `task/${n}-x`, base: "0123456789abcdef", log: [{ at: ago(2), message: "working" }],
    screenshots: [], updatedAt: ago(2), createdAt: ago(30), url: null, error: null, vm: `vm-${n}`, startAfter: [], mergeAfter: [] }));
  await faPage.route((u) => u.pathname == "/api/factory" || u.pathname == "/api/factory/tasks", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(new URL(route.request().url()).pathname == "/api/factory/tasks" ? tasks : { enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } }),
  }));
  await faPage.setViewportSize({ width: 1400, height: 900 });
  await faPage.goto(`${server.root}/admin/factory`);
  await until(() => faPage.evaluate(`!!window.ergaBoard && document.querySelectorAll("#board .card").length == 2`), 10_000, "the Factory page shows its board");
  await faPage.evaluate(`window.ergaBoard.open(2), true`);
  await until(() => faPage.evaluate(`document.getElementById("dlg").open && window.ergaBoard.openTask() == 2`), 3000, "task 2's detail is open");
  await faPage.evaluate(`(() => { const i = document.getElementById("agent-input"); i.value = "What is task 2 doing?"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // Documents.
  const dlPage = await ctx.newPage();
  const dlErrors: string[] = [];
  dlPage.on("pageerror", (e) => dlErrors.push(e.stack ?? e.message));
  const dl = watch(dlPage, dlErrors);
  await dlPage.setViewportSize({ width: 1000, height: 700 });
  await dlPage.goto(`${server.root}/docs`);
  await until(() => dlPage.evaluate(`document.title.startsWith("Documents") && !!window.ergaLive`), 5000, "Documents is open, with live.js");

  const pages = { editor: edW, factory: fa, docs: dl };
  const all = Object.values(pages);
  // Each page's live checks have run once (they learn each file's build as they start).
  await checked(all, all.map(() => 0), 1);
  await settle(edPage);
  return {
    doc, ed, fa, dl, pages, all, edReady, selection,
    /** Marks every page: a reload clears the mark. */
    mark: async () => { for (const p of all) await p.page.evaluate(`window.__notReloaded = true`); },
    /** Which pages still have the mark. */
    kept: async () => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([k, p]) => [k, await p.page.evaluate(`!!window.__notReloaded`).catch(() => false) as boolean]))),
    /** Each page's checks so far, for `checked`. */
    counts: () => all.map((p) => p.checks),
  };
}
