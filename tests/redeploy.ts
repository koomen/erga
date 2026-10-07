// Open pages across a redeploy (README, Redeploys and open pages), in headless
// Chrome: the editor (scrolled, a selection, the help card open, an agent
// draft with a file attached), the admin Factory page (a task's detail open,
// an agent draft) and Documents are open when the server restarts.
//
//   (a) It restarts with the same client files: no page reloads, each one
//       reconnects, nothing shows an error, and an edit typed in the editor
//       while the server was down reaches the server once it's back.
//   (b) It restarts with changed client files (page.js, factory-agent.js and
//       live.js, in a copy of .site: ERGA_SITE_DIR): every page reloads by
//       itself, and the editor's caret, scroll, card, draft and file, the
//       open task and the agent's draft on the Factory page are all back.
//
// Also: the server's side (GET /api/release, each page's build and the
// X-Erga-Check answer, nothing for a document's own HTML).
//
//   bun tests/redeploy.ts
// covers: src/page/live.ts src/page/live-client.ts src/page/restore.ts worker/live.ts src/page/collab.ts src/page/attach-ui.ts

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, ROOT, type Page } from "./cdp.ts";
import { startHost } from "./host.ts";

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail == null ? "" : ` (${typeof detail == "string" ? detail : JSON.stringify(detail)})`}`); if (!ok) failures++; };
const until = async (f: () => Promise<unknown> | unknown, ms: number) => { const t = Date.now(); for (;;) { try { if (await f()) return true; } catch { /* not yet */ } if (Date.now() - t > ms) return false; await Bun.sleep(50); } };

// A long document, to scroll; the client files in a copy, to change.
const scratch = mkdtempSync(join(tmpdir(), "erga-redeploy-"));
const doc = join(scratch, "doc"), site = join(scratch, "site");
cpSync(join(ROOT, ".site"), site, { recursive: true });
const paras = Array.from({ length: 80 }, (_, i) => `<h2>Part ${i + 1}</h2>\n<p>Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again, so the page is long enough to scroll.</p>`).join("\n");
cpSync(join(ROOT, "tests/fixtures/page"), doc, { recursive: true });
writeFileSync(join(doc, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Long</title></head><body><h1>A long page</h1>\n${paras}\n</body></html>\n`);
const disk = () => readFileSync(join(doc, "index.html"), "utf8");

const host = await startHost(doc, { processEnv: { ERGA_SITE_DIR: site } });
const browser = await Browser.launch();

// ------------------------------------------------------------------ the server's side

const release = await (await fetch(`${host.root}/api/release`)).json() as { files: Record<string, string>; version: string };
check(release.files["page.js"]?.length == 16 && release.files["live.js"] && release.files["editor.html"] && release.version, "GET /api/release: each client file's build, and the release", release);
const docsHtml = await (await fetch(`${host.root}/docs`)).text();
const build = /<meta name="erga-build" content="(\w+)">/.exec(docsHtml)?.[1];
check(build && docsHtml.includes('<script src="/live.js" defer></script>'), "a page of the site's own carries its build and live.js");
const asked = await fetch(`${host.root}/docs`, { headers: { "X-Erga-Check": "build" } });
check(asked.status == 204 && asked.headers.get("x-erga-build") == build, "asked with X-Erga-Check, a page answers its build alone", { status: asked.status, build: asked.headers.get("x-erga-build") });
const id = host.base.split("/").pop();
const own = await (await fetch(`${host.root}/d/${(await (await fetch(`${host.base}/api/doc`)).json() as { docName?: { id: string } }).docName?.id ?? id}/doc/index.html`)).text();
check(own.includes("A long page") && !own.includes("live.js") && !own.includes("erga-build"), "a document's own HTML gets nothing of the site's", own.slice(0, 200));

/** Each tab: a fresh context (its own storage), its live checks every second and a half rather than every minute. */
async function tab(): Promise<Page> {
  const p = await browser.page(await browser.context());
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__ergaLivePoll = 1500" });
  return p;
}

try {
  // ------------------------------------------------------------------ the pages, with state

  // The editor: scrolled, a selection, the help card open, a draft and a file for the agent.
  const ed = await tab();
  await ed.open(`${host.base}#edit`, { width: 1200, height: 800 });
  const edReady = () => until(async () => await ed.eval<boolean>(`!!window.ergaPage && document.body.classList.contains("erga-listening")`) && await ed.frame<boolean>(`!!document.getElementById("page").contentDocument?.querySelector("[data-erga-id]")`), 20_000);
  check(await edReady(), "the editor is open");
  await ed.frame(`document.getElementById("page").contentWindow.scrollTo(0, 1500)`);
  await ed.frame(`(() => { const p = ergaFrame.page, at = p.state.doc.toString().indexOf("Paragraph 20:"); p.dispatch({ selection: { anchor: at, head: at + 9 } }); p.focus(); return true; })()`);
  const sel = { anchor: 0, head: 0 };
  await until(async () => { Object.assign(sel, await ed.eval(`(() => { const m = ergaPage.state.selection.main; return { anchor: m.anchor, head: m.head }; })()`)); return sel.head - sel.anchor == 9; }, 5000);
  check(sel.head - sel.anchor == 9, "a selection in the page", sel);
  await ed.eval(`(() => { const i = document.getElementById("agent-input"); i.value = "Make the title bigger"; i.dispatchEvent(new Event("input", { bubbles: true }));
    const dt = new DataTransfer(); dt.items.add(new File(["some notes"], "notes.txt", { type: "text/plain" })); i.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  // The keyboard shortcuts card (⌘/).
  await ed.eval(`(() => { const mac = /Mac/.test(navigator.platform); window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: mac, ctrlKey: !mac, bubbles: true })); return true; })()`);
  check(await ed.eval<boolean>(`!document.getElementById("help").hidden`), "the help card is open");
  check(await until(() => ed.eval<boolean>(`document.querySelectorAll(".agent-attachments .file-chip").length == 1`), 5000), "a file attached to the agent's draft");
  await until(async () => (await ed.eval<number>(`ergaPage.page.scrollY`)) > 1400, 5000);
  const scrolled = await ed.eval<number>(`ergaPage.page.scrollY`);
  check(scrolled > 1400, "the page is scrolled", scrolled);
  // The focus back in the page (the paste above took it to the agent's box).
  await ed.frame(`ergaFrame.page.focus(), true`);

  // The admin Factory page: a board of two tasks (answered here, so no VM runs), the second one's detail open, a draft for the agent.
  const fa = await tab();
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const tasks = [1, 2].map((n) => ({ id: n, title: `Task number ${n}`, description: "The ask.", status: "working", branch: `task/${n}-x`, base: "0123456789abcdef", log: [{ at: ago(2), message: "working" }],
    screenshots: [], updatedAt: ago(2), createdAt: ago(30), url: null, error: null, vm: `vm-${n}`, startAfter: [], mergeAfter: [] }));
  await fa.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/factory*" }] });
  fa.onEvent("Fetch.requestPaused", ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    const reply = (body: string) => fa.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(body).toString("base64") }).catch(() => {});
    if (path == "/api/factory/tasks") reply(JSON.stringify(tasks));
    else if (path == "/api/factory") reply(JSON.stringify({ enabled: true, vms: { runner: "sim" }, claude: { signedIn: true, canStore: true } }));
    else fa.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await fa.open(`${host.root}/admin/factory`, { width: 1400, height: 900 });
  check(await until(() => fa.eval<boolean>(`!!window.ergaBoard && document.querySelectorAll("#board .card").length == 2`), 15_000), "the Factory page shows its board");
  await fa.eval(`window.ergaBoard.open(2), true`);
  check(await fa.eval<boolean>(`document.getElementById("dlg").open && window.ergaBoard.openTask() == 2`), "task 2's detail is open");
  await fa.eval(`(() => { const i = document.getElementById("agent-input"); i.value = "What is task 2 doing?"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // Documents.
  const dl = await tab();
  await dl.open(`${host.root}/docs`, { width: 1000, height: 700 });
  check(await dl.eval<boolean>(`document.title.startsWith("Documents") && !!window.ergaLive`), "Documents is open, with live.js");

  const pages = { editor: ed, factory: fa, docs: dl };
  const mark = async () => { for (const p of Object.values(pages)) await p.eval(`window.__notReloaded = true`); };
  const kept = async () => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([k, p]) => [k, await p.eval<boolean>(`!!window.__notReloaded`).catch(() => false)])));
  // Each page's live checks have run once (they learn each file's build as they start).
  await Bun.sleep(2000);
  await mark();

  // ------------------------------------------------------------------ (a) a restart, the same client files

  await host.stop();
  // Typed while the server is down: it waits in the tab.
  await ed.type(" Typed while down.");
  await host.start();
  check(await edReady(), "(a) the editor reconnects: its room and its event channel");
  check(await until(() => ed.eval<boolean>(`ergaPage.collab.provider.wsconnected && ergaPage.collab.provider.synced`), 20_000), "(a) the editor's room is synced again");
  check(await until(() => disk().includes("Typed while down."), 20_000), "(a) the edit made while the server was down reaches the server (and the file on disk)");
  check(await until(() => fa.eval<boolean>(`document.getElementById("live").textContent == "live"`), 20_000), "(a) the board's live updates are back");
  // Long enough for every page's checks to have run against the new server (and found nothing to reload for).
  await Bun.sleep(6000);
  const stayed = await kept();
  check(Object.values(stayed).every(Boolean), "(a) no page reloaded", stayed);
  check(await ed.eval<boolean>(`!document.getElementById("status").classList.contains("error")`), "(a) the editor shows no error");
  check(await until(async () => !(await Promise.all(Object.values(pages).map((p) => p.eval<boolean>(`!!document.querySelector(".erga-live-note")`)))).some(Boolean), 10_000), "(a) no page still says it's reconnecting");
  check(await fa.eval<boolean>(`document.getElementById("dlg").open && window.ergaBoard.openTask() == 2`), "(a) task 2's detail is still open");
  const selA = await ed.eval<{ anchor: number; head: number }>(`(() => { const m = ergaPage.state.selection.main; return { anchor: m.anchor, head: m.head }; })()`);
  check(await ed.eval<boolean>(`document.getElementById("agent-input").value == "Make the title bigger" && document.querySelectorAll(".agent-attachments .file-chip").length == 1`), "(a) the agent's draft and its file are as they were");

  // ------------------------------------------------------------------ (b) a restart, new client files

  // Back in the page, quiet, scrolled, the selection where it was after the typing.
  await ed.frame(`document.getElementById("page").contentWindow.scrollTo(0, 1500)`);
  await until(async () => Math.abs((await ed.eval<number>(`ergaPage.page.scrollY`)) - 1500) < 3, 5000);
  const scrollB = await ed.eval<number>(`ergaPage.page.scrollY`);
  await mark();
  await host.stop();
  // A new release of three client files: page.js (the editor), factory-agent.js (every admin page), live.js (every page).
  const files = JSON.parse(readFileSync(join(site, "build.json"), "utf8")) as Record<string, string>;
  for (const f of ["page.js", "factory-agent.js", "live.js"]) {
    const fresh = (files[f].slice(0, 8) + "feedbeef").slice(0, 16);
    writeFileSync(join(site, f), readFileSync(join(site, f), "utf8").replace(`["${f}"]="${files[f]}"`, `["${f}"]="${fresh}"`) + "\n/* the next release */\n");
    files[f] = fresh;
  }
  writeFileSync(join(site, "build.json"), JSON.stringify(files));
  await host.start();
  const reloaded = await until(async () => Object.values(await kept()).every((v) => !v), 40_000);
  check(reloaded, "(b) every page reloads by itself", await kept());
  check(await edReady(), "(b) the editor is back");
  check(await ed.eval<boolean>(`self.ergaBuilt["page.js"] == ${JSON.stringify(files["page.js"])}`), "(b) the editor runs the new page.js");
  const selB = await ed.eval<{ anchor: number; head: number }>(`(() => { const m = ergaPage.state.selection.main; return { anchor: m.anchor, head: m.head }; })()`);
  check(selB.anchor == selA.anchor && selB.head == selA.head, "(b) the editor's selection is back", { before: selA, after: selB });
  check(await until(async () => Math.abs((await ed.eval<number>(`ergaPage.page.scrollY`)) - scrollB) < 4, 8000), "(b) the page is scrolled where it was", { before: scrollB, after: await ed.eval<number>(`ergaPage.page.scrollY`) });
  check(await until(() => ed.eval<boolean>(`!document.getElementById("help").hidden`), 5000), "(b) the help card is open again");
  check(await until(() => ed.eval<boolean>(`document.getElementById("agent-input").value == "Make the title bigger" && document.querySelectorAll(".agent-attachments .file-chip").length == 1`), 5000), "(b) the agent's draft and its attached file are back");
  check(disk().includes("Typed while down."), "(b) the document kept every edit");
  check(await until(() => fa.eval<boolean>(`document.getElementById("dlg").open && window.ergaBoard?.openTask() == 2`), 15_000), "(b) task 2's detail is open again on the Factory page");
  check(await fa.eval<boolean>(`document.getElementById("agent-input").value == "What is task 2 doing?"`), "(b) the admin agent's draft is back");
  check(await dl.eval<boolean>(`document.title.startsWith("Documents")`), "(b) Documents is back");
  // And it settles: no second reload.
  await mark();
  await Bun.sleep(5000);
  const settled = await kept();
  check(Object.values(settled).every(Boolean), "(b) and stays (no reload loop)", settled);
  for (const [k, p] of Object.entries(pages)) check(p.errors.length == 0, `no errors in the ${k} page`, p.errors.slice(0, 5));
} finally {
  browser.close();
  await host.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passing");
process.exit(failures ? 1 : 0);
