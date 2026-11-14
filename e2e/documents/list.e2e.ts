// The documents page (/docs) and the archive (/docs/archived): a person makes, finds, archives and deletes documents,
// and the open list follows what an agent or another person changes, with no reload. Then the admin's side: / opens
// the list, ⌘K finds Erga's pages, the Home page button and the logo.
//
// The first journey is a fresh person's, so the list holds only its own rows. The second is DEV_LOGIN's (the admin),
// whose list holds every file's fixtures: it never counts rows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "playwright-core";
import { editor, type Editor } from "../helpers/editor";
import { ROOT } from "../helpers/env";
import { agentClosed, expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { listenNews, middle, pane, person, quietLogin, type Agent, type Person } from "./people";
import { clickOn } from "../helpers/press";

const s = await servers.main();

/** How long the documents of the lifetime check last when nobody edits them (?unedited=, local servers only). */
const UNEDITED_MS = 3000;

/** The count and each row's title, as the person sees them. */
const shown = (page: Page) =>
  page.evaluate<string>(
    `[document.getElementById("docs-count")].filter((c) => c.checkVisibility()).map((c) => c.innerText).concat([...document.querySelectorAll("ol.rows > li[data-live] .title")].filter((t) => t.checkVisibility()).map((t) => t.innerText)).join(" | ")`
  );
/** Each row's title, the left edge of its name and the row's height, in CSS px. */
const boxes = (page: Page) =>
  page.evaluate<{ title: string; left: number; height: number }[]>(
    `[...document.querySelectorAll("ol.rows > li[data-live]")].map((li) => ({ title: li.querySelector(".title").innerText, left: Math.round(li.querySelector(".title").getBoundingClientRect().left), height: Math.round(li.getBoundingClientRect().height) }))`
  );
/** How visible a row's button is (its opacity), by its label. */
const opacity = (page: Page, label: string) =>
  page.evaluate<string>(`getComputedStyle(document.querySelector('button[aria-label=${JSON.stringify(label)}]')).opacity`);
const rowOf = (title: string) => `li[data-live]:has(.title:text-is("${title}"))`;
/** Puts the mouse on a row, beside its name: the row's buttons show. */
async function hover(page: Page, title: string) {
  const box = (await until(() => page.locator(`${rowOf(title)} a.doc`).boundingBox(), 5000, `the row of ${title}`))!;
  await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 2 });
}
/** The page's own questions and warnings (confirm, alert): kept in the page, the question answered with `yes`. */
const dialogs = (page: Page, yes: boolean) =>
  page.evaluate((yes) => {
    const w = window as unknown as { said: string[] };
    w.said = [];
    window.confirm = (q) => (w.said.push(String(q)), yes);
    window.alert = (m) => void w.said.push(String(m));
  }, yes);
const said = (page: Page) => page.evaluate(() => (window as unknown as { said: string[] }).said);
/** Marks the page: a reload would lose the mark. */
const mark = (page: Page) => page.evaluate(`window.sameLoad = true`);
const sameLoad = (page: Page) => page.evaluate<boolean>(`window.sameLoad === true`);

journey("a person's documents", () => {
  let page: Page, p: Person, bo: Person, agent: Agent;
  /** The documents that the journey makes, by a short name: their ids. */
  const id: Record<string, string> = {};
  /** The project of the last steps: its address. */
  let project = "";
  let ed: Editor;
  /** The scratch document of the last steps: its address. */
  let scratch = "";
  /** The lifetime check's documents (made in the first step, read in the last), and the socket that holds one open. */
  let life: { gone: string; kept: string; open: string; socket: WebSocket };
  /** What the list's socket hears, and each ask for rows. */
  let news: ReturnType<typeof listenNews>;
  /** The page's calls of delete_document, held until the journey answers them. */
  const held: Route[] = [];
  const make = async (name: string, args: Record<string, unknown> = {}) => {
    const made = await agent<{ id: string; address: string }>("create_document", { title: name, ...args });
    expect(made.error).toBe("");
    id[name] = made.data.id;
    return made.data;
  };

  test("/new makes a blank document, a copy of the doc template, Untitled at /<you>/untitled; the list has it as unedited", async ({
    tab,
  }) => {
    page = tab.page;
    tab.strict = true;
    [p, bo] = await Promise.all([person(s, quietLogin()), person(s)]);
    agent = await p.agent();
    // The lifetime check's three documents, bo's: each goes UNEDITED_MS from now unless someone edits it. One gets an
    // edit, one an open socket (a tab), one nothing. The last step reads what became of them. Each document gets
    // what keeps it at once after it is made (the agent is ready before): on a busy machine, three documents made
    // first and kept after took longer than the documents' life.
    const boAgent = await bo.agent();
    const kept = await bo.make(`?unedited=${UNEDITED_MS}`);
    expect(
      (await boAgent("edit", { document: kept, path: "index.html", edits: [{ oldText: "<p>", newText: "<p>Bo was here. " }] })).error
    ).toBe("");
    const open = await bo.make(`?unedited=${UNEDITED_MS}`);
    const socket = new WebSocket(`${s.root.replace(/^http/, "ws")}/d/${open}/api/room/doc?user=${bo.login}`);
    await until(() => socket.readyState == WebSocket.OPEN, 5000, "the open document has a tab");
    const gone = await bo.make(`?unedited=${UNEDITED_MS}`);
    life = { gone, kept, open, socket };

    id.untitled = await p.make();
    expect(await p.nameOf(id.untitled)).toMatchObject({ title: "Untitled", slug: "untitled", titleSet: false, slugSet: false });
    expect(await (await p.get(`/${p.login}/untitled/doc/index.html`)).text()).toBe(
      readFileSync(join(ROOT, "assets/templates/doc/index.html"), "utf8")
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await agentClosed(page);
    news = listenNews(page);
    await page.goto(p.signIn());
    expect(await shown(page)).toBe("1 document | Untitled");
    expect(await page.getAttribute(`${rowOf("Untitled")} a.doc`, "href")).toBe(`/${p.login}/untitled?edit`);
    expect(await page.innerText(`${rowOf("Untitled")} .note`)).toMatch(/^Unedited/);
  });

  test("a document is deleted only from this site's pages; then its row goes from the open list, and its address is a 404", async () => {
    await mark(page);
    // The page's Delete is the operation delete_document; another site's Origin, or none, is refused.
    expect((await p.tool("delete_document", { document: id.untitled }, null)).status).toBe(403);
    expect((await p.tool("delete_document", { document: id.untitled }, "https://elsewhere.example")).status).toBe(403);
    expect(await shown(page)).toBe("1 document | Untitled");
    expect((await p.tool("delete_document", { document: id.untitled })).status).toBe(200);
    await expect.poll(() => shown(page)).toBe("");
    expect(await page.innerText("main")).toContain("No documents yet");
    expect(await p.exists(id.untitled)).toBe(false);
    expect((await p.get(`/${p.login}/untitled`)).status).toBe(404);
  });

  test("an agent makes and renames documents over the API, and someone shares one: the open list follows each, and the focus stays on its row", async () => {
    await make("Made by an agent");
    await expect.poll(() => shown(page)).toBe("1 document | Made by an agent");
    expect(await page.evaluate<boolean>(`document.querySelector("p.empty").checkVisibility()`)).toBe(false);
    await agent("rename_document", { document: id["Made by an agent"], title: "Minutes" });
    await expect.poll(() => shown(page)).toBe("1 document | Minutes");
    id.Minutes = id["Made by an agent"];

    // Someone else shares theirs: it comes in at its place, the latest edit first.
    id.theirs = await bo.make();
    await bo.share(id.theirs, p.login, "viewer");
    await expect.poll(() => shown(page)).toBe("2 documents | Untitled | Minutes");
    expect(await page.innerText(`li[data-live="doc:${id.theirs}"] .note`)).toBe(`${bo.login} · view only`);

    // The focus stays where it was while a row changes: on the same control of the new row.
    await page.focus(`li[data-live="doc:${id.Minutes}"] a.doc`);
    await agent("rename_document", { document: id.Minutes, title: "Old minutes" });
    await expect.poll(() => shown(page)).toBe("2 documents | Untitled | Old minutes");
    expect(await page.evaluate<string>(`document.activeElement.closest("li").dataset.live`)).toBe(`doc:${id.Minutes}`);

    await bo.share(id.theirs, p.login, "none");
    await expect.poll(() => shown(page)).toBe("1 document | Old minutes");
    expect(await sameLoad(page)).toBe(true);
  });

  // A rule for the search's no-match line (.none) also matched a document's empty chevron place (span.twist.none): it
  // moved the name 12 px right and made the row taller.
  test("a document's name lines up with a project's, and the rows have the same height", async () => {
    await make("A project", {
      kind: "project",
      files: { "index.html": "<h1>Home</h1>", "plans/roadmap.html": "<title>Road map</title><h1>Road map</h1>" },
    }).then((d) => (project = d.address));
    await make("Tax notes", { slug: "money-plan" });
    await make("Garden plan");
    await expect.poll(() => shown(page)).toBe("4 documents | Garden plan | Tax notes | A project | Old minutes");
    const r = await boxes(page);
    expect(new Set(r.map((x) => x.left)).size, JSON.stringify(r)).toBe(1);
    expect(new Set(r.map((x) => x.height)).size, JSON.stringify(r)).toBe(1);
    // A row is its name's line and 11 px above and below it.
    expect(r[0].height, JSON.stringify(r)).toBeLessThanOrEqual(46);
  });

  test("a hidden tab waits: changes made meanwhile come in when it shows, both rows in one ask", async () => {
    // All that the page asked for until now has its answer: from here, only what changes next.
    await news.caughtUp();
    const { heard, asks } = news;
    // The tab goes to the background (as the browser says it, to the page).
    await page.evaluate(
      `Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange"))`
    );
    await agent("rename_document", { document: id["Tax notes"], title: "Tax notes 2026" });
    await agent("rename_document", { document: id["Garden plan"], title: "Garden plan, spring" });
    await until(
      () => heard.some((t) => t.includes(`doc:${id["Tax notes"]}`)) && heard.some((t) => t.includes(`doc:${id["Garden plan"]}`)),
      5000,
      "the socket heard both changes"
    );
    expect(asks).toEqual([]);
    expect(await shown(page)).toBe("4 documents | Garden plan | Tax notes | A project | Old minutes");
    // Back in view: both rows as they are now, in one ask.
    await page.evaluate(
      `Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange"))`
    );
    await expect.poll(() => shown(page)).toBe("4 documents | Garden plan, spring | Tax notes 2026 | A project | Old minutes");
    expect(asks.length).toBe(1);
    expect(new URL(asks[0]).searchParams.get("keys")!.split(",").sort()).toEqual(
      [`doc:${id["Tax notes"]}`, `doc:${id["Garden plan"]}`].sort()
    );
  });

  test("Delete: the row leaves the screen and the count falls at once, before the server answers", async () => {
    await page.route("**/api/tools/delete_document*", (r) => void held.push(r));
    await dialogs(page, true);
    await hover(page, "Tax notes 2026");
    await clickOn(page, 'button[aria-label="Delete Tax notes 2026"]');
    await expect.poll(() => shown(page)).toBe("3 documents | Garden plan, spring | A project | Old minutes");
    await expect.poll(() => held.length).toBe(1);
  });

  test("Delete: refused, the row is back in its place, and the page says why", async ({ tab }) => {
    await held[0].fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Not now." }) });
    await expect.poll(() => shown(page)).toBe("4 documents | Garden plan, spring | Tax notes 2026 | A project | Old minutes");
    expect(await said(page)).toEqual(["Delete “Tax notes 2026”? This can't be undone.", "Not now."]);
    await page.unroute("**/api/tools/delete_document*");
    // The refused call is an error in the console: that one only.
    expect(tab.errors.splice(0).filter((e) => !/Failed to load resource: the server responded with a status of 409/.test(e))).toEqual([]);
  });

  test("typing in Find filters the rows by title and address, says when none match, and rows that come in obey it; Escape clears it", async () => {
    /** The count, each row that shows, and the line that says that none match. */
    const found = () =>
      page.evaluate<string>(
        `[document.getElementById("docs-count"), ...document.querySelectorAll("ol.rows > li[data-live] .title"), document.getElementById("docs-none")].filter((e) => e.checkVisibility()).map((e) => e.innerText).join(" | ")`
      );
    const all = "Garden plan, spring | Tax notes 2026 | A project | Old minutes";
    // The box is left of New and Scratch, on the same line.
    const box = page.locator("input.find");
    const [find, neu] = [await box.boundingBox(), await page.locator(".make-buttons > :nth-child(2)").boundingBox()];
    expect(find!.x + find!.width).toBeLessThan(neu!.x);
    expect(Math.abs(find!.y - neu!.y)).toBeLessThan(2);

    await box.click();
    await page.keyboard.type("ta");
    expect(await found()).toBe("1 of 4 documents | Tax notes 2026");
    // Every word must match, in any case.
    await page.keyboard.type(" Z");
    expect(await found()).toBe("0 of 4 documents | No documents match “ta Z”.");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    expect(await found()).toBe("1 of 4 documents | Tax notes 2026");
    // The address counts too: the slug, and the owner.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("money");
    expect(await found()).toBe("1 of 4 documents | Tax notes 2026");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(p.login.toUpperCase());
    expect(await found()).toBe(`4 of 4 documents | ${all}`);

    // Rows that come in obey the words: one that doesn't match stays hidden, one that does shows, and a new title
    // (which keeps the row's place) brings a row in or takes it out.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("garden");
    await make("Kitchen");
    await make("Garden shed");
    await expect.poll(found).toBe("2 of 6 documents | Garden shed | Garden plan, spring");
    await agent("rename_document", { document: id.Kitchen, title: "Garden gate" });
    await expect.poll(found).toBe("3 of 6 documents | Garden shed | Garden gate | Garden plan, spring");
    await agent("rename_document", { document: id["Garden shed"], title: "Shed notes" });
    await expect.poll(found).toBe("2 of 6 documents | Garden gate | Garden plan, spring");

    // Escape clears the words, and every row shows; a second Escape leaves the box.
    await page.keyboard.press("Escape");
    expect(await box.inputValue()).toBe("");
    expect(await found()).toBe(`6 documents | Shed notes | Garden gate | ${all}`);
    expect(await page.evaluate<boolean>(`document.activeElement.matches("input.find")`)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.evaluate<boolean>(`document.activeElement.matches("input.find")`)).toBe(false);
    // The two rows of this step go again.
    for (const d of [id.Kitchen, id["Garden shed"]]) await agent("delete_document", { document: d });
    await expect.poll(() => shown(page)).toBe(`4 documents | ${all}`);
  });

  test("Archive shows only while the mouse is over a row; it takes the row off the list, and the link after the heading opens the archive with it", async () => {
    await page.mouse.move(5, 5);
    await expect.poll(() => opacity(page, "Archive Tax notes 2026")).toBe("0");
    await hover(page, "Tax notes 2026");
    await expect.poll(() => opacity(page, "Archive Tax notes 2026")).toBe("1");
    expect(await opacity(page, "Archive Garden plan, spring")).toBe("0");
    await clickOn(page, 'button[aria-label="Archive Tax notes 2026"]');
    await expect.poll(() => shown(page)).toBe("3 documents | Garden plan, spring | A project | Old minutes");
    expect(await sameLoad(page)).toBe(true);

    await clickOn(page, "a.other-list");
    await page.waitForURL(/\/docs\/archived$/);
    expect(await page.innerText("h1")).toBe("Archived");
    expect(await shown(page)).toBe("1 document | Tax notes 2026");
  });

  test("in the archive too, a document's name lines up with a project's; the owner deletes one after a question; a shared one has Unarchive but no Delete", async () => {
    await mark(page);
    // Archived from elsewhere (the person's own operations): the open archive takes each row in.
    await bo.share(id.theirs, p.login, "viewer");
    for (const d of [id["A project"], id.theirs]) expect((await p.tool("archive_document", { document: d })).status).toBe(200);
    await expect
      .poll(async () => (await shown(page)).split(" | ").sort().join(" | "))
      .toBe("3 documents | A project | Tax notes 2026 | Untitled");
    const r = await boxes(page);
    expect(new Set(r.map((x) => x.left)).size, JSON.stringify(r)).toBe(1);
    expect(new Set(r.map((x) => x.height)).size, JSON.stringify(r)).toBe(1);
    expect(r[0].height, JSON.stringify(r)).toBeLessThanOrEqual(46);
    // The archive is each person's own: bo's list still has theirs.
    expect(await bo.docs()).toContain(`data-live="doc:${id.theirs}"`);
    expect(await page.locator(`${rowOf("Untitled")} button.delete`).count()).toBe(0);
    expect(await page.locator(`${rowOf("Untitled")} button[aria-label="Unarchive Untitled"]`).count()).toBe(1);

    await dialogs(page, false);
    await hover(page, "Tax notes 2026");
    await clickOn(page, 'button[aria-label="Delete Tax notes 2026"]');
    expect(await said(page)).toEqual(["Delete “Tax notes 2026”? This can't be undone."]);
    await settle(page);
    expect((await shown(page)).split(" | ")).toContain("Tax notes 2026");
    await dialogs(page, true);
    await clickOn(page, 'button[aria-label="Delete Tax notes 2026"]');
    await expect.poll(async () => (await shown(page)).split(" | ").sort().join(" | ")).toBe("2 documents | A project | Untitled");
    await expect.poll(() => p.exists(id["Tax notes"])).toBe(false);
  });

  test("Unarchive, which shows while the mouse is over a row, takes the row out of the archive", async () => {
    await hover(page, "A project");
    await expect.poll(() => opacity(page, "Unarchive A project")).toBe("1");
    await clickOn(page, 'button[aria-label="Unarchive A project"]');
    await expect.poll(() => shown(page)).toBe("1 document | Untitled");
    await hover(page, "Untitled");
    await clickOn(page, 'button[aria-label="Unarchive Untitled"]');
    await expect.poll(() => shown(page)).toBe("");
    expect(await page.innerText("p.empty")).toContain("No archived documents");
  });

  test("an agent's archive and unarchive move the rows of open tabs, with no reload; the link after the heading goes back to the list", async () => {
    const list = await page.context().newPage();
    await list.goto(`${s.root}/docs`);
    await mark(list);
    await expect
      .poll(async () => (await shown(list)).split(" | ").sort().join(" | "))
      .toBe("4 documents | A project | Garden plan, spring | Old minutes | Untitled");
    const doc = id.Minutes;
    expect((await agent("documents", { op: "archive_document", document: doc })).status).toBe(200);
    await expect
      .poll(async () => (await shown(list)).split(" | ").sort().join(" | "))
      .toBe("3 documents | A project | Garden plan, spring | Untitled");
    await page.bringToFront();
    await expect.poll(() => shown(page)).toBe("1 document | Old minutes");
    // The agent finds it in the archive, and not on the list. Its page still opens by its address.
    const listed = async (args = {}) =>
      (await p.tool<{ documents: { id: string }[] }>("list_documents", args)).result!.documents.map((d) => d.id);
    expect(await listed()).not.toContain(doc);
    expect(await listed({ archived: true })).toEqual([doc]);
    expect((await p.get(`/d/${doc}`)).status).toBeLessThan(400);

    expect((await agent("documents", { op: "unarchive_document", document: doc })).status).toBe(200);
    await expect.poll(() => shown(page)).toBe("");
    await list.bringToFront();
    await expect
      .poll(async () => (await shown(list)).split(" | ").sort().join(" | "))
      .toBe("4 documents | A project | Garden plan, spring | Old minutes | Untitled");
    expect([await sameLoad(page), await sameLoad(list)]).toEqual([true, true]);
    await list.close();
    await page.bringToFront();
    await clickOn(page, "a.other-list");
    await page.waitForURL(/\/docs$/);
    await expect
      .poll(async () => (await shown(page)).split(" | ").sort().join(" | "))
      .toBe("4 documents | A project | Garden plan, spring | Old minutes | Untitled");
  });

  test("in the viewer of a project, Go to… in the avatar's menu shows the key and opens the quick search, the project's pages first; ⌘K opens it from inside the page", async () => {
    await page.goto(`${s.root}${project}`);
    await clickOn(page, "[data-erga-account] button");
    expect(await page.evaluate(() => document.querySelector(".erga-account-go")?.textContent)).toBe(
      `Go to…${process.platform == "darwin" ? "⌘K" : "Ctrl K"}`
    );
    await clickOn(page, ".erga-account-go");
    await expect.poll(async () => (await pane(page))?.groups[0]).toBe("Pages of A project");
    expect(await page.evaluate(() => document.querySelector<HTMLElement>(".erga-account-menu")!.hidden), "the menu closed").toBe(true);
    expect((await pane(page))!.rows.slice(0, 2)).toEqual([`Home${project}`, `Road map${project}/plans/roadmap`]);
    await page.keyboard.press("Escape");
    await expect.poll(() => pane(page)).toBeNull();
    // From inside the page: its own frame passes the key on.
    await page.mouse.click(650, 500);
    await page.keyboard.press("ControlOrMeta+k");
    await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
    await page.keyboard.press("Escape");
    await expect.poll(() => pane(page)).toBeNull();
  });

  test("Back to Documents shows the list from the browser's copy, and the list follows a change made meanwhile", async () => {
    await agent("rename_document", { document: id.Minutes, title: "Minutes of May" });
    await page.goBack();
    await expect.poll(async () => (await shown(page)).split(" | ")).toContain("Minutes of May");
    // No answer from the server for the page: the browser kept it.
    expect(
      await page.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return [n.type, n.transferSize];
      })
    ).toEqual(["back_forward", 0]);
  });

  test("+ Scratch, whose tip says when a scratch document goes, makes one, off the list, with an orange Save first in its quick actions, whose tip says the same; Save keeps it, at the address of its heading", async () => {
    /** Puts the mouse on an element, once it has stopped moving (the editor's bar grows as the editor comes up). */
    const over = async (selector: string) => {
      let last = "";
      const at = await until(
        async () => {
          const now = await middle(page, selector);
          const still = JSON.stringify(now) == last;
          last = JSON.stringify(now);
          return still ? now : null;
        },
        5000,
        `${selector} is still`
      );
      await page.mouse.move(at!.x, at!.y, { steps: 2 });
    };
    /** An element's tip (its ::after): the words, whether it shows, and the look of its card. */
    const tipOf = (selector: string) =>
      page.locator(selector).evaluate((b) => {
        const s = getComputedStyle(b, "::after");
        return { text: s.content, shown: s.opacity, card: [s.backgroundColor, s.borderRadius, s.fontSize, s.boxShadow].join(" ") };
      });
    const deleted = '"Unsaved scratch docs are deleted in 24h"';
    // No line under the buttons: + Scratch says when a scratch document goes in its tip, on hover or focus.
    expect(await page.locator(".scratch-note").count()).toBe(0);
    expect(await page.getAttribute("a.pill.scratch", "aria-description")).toBe("Unsaved scratch docs are deleted in 24h");
    expect((await tipOf("a.pill.scratch")).shown).toBe("0");
    await over("a.pill.scratch");
    await expect.poll(async () => (await tipOf("a.pill.scratch")).shown).toBe("1");
    const made = await tipOf("a.pill.scratch");
    expect(made.text).toBe(deleted);
    await page.mouse.move(600, 500);
    await expect.poll(async () => (await tipOf("a.pill.scratch")).shown).toBe("0");
    await page.focus("a.pill.scratch");
    await expect.poll(async () => (await tipOf("a.pill.scratch")).shown).toBe("1");

    await clickOn(page, "a.pill.scratch");
    await page.waitForURL(new RegExp(`/${p.login}/[a-z0-9]{8}\\?edit$`));
    const doc = new URL(page.url()).pathname.split("/")[2];
    ed = editor(page, { address: `${s.root}/${p.login}/${doc}`, dir: "", file: "" });
    await ed.loaded();
    // No note over the page: Save is the first of the editor's quick actions, orange, and its tip shows on hover.
    expect(await page.locator("#erga-scratch").count()).toBe(0);
    const save = page.locator("#quick .erga-scratch-save");
    await expect.poll(() => save.isVisible()).toBe(true);
    expect(await save.innerText()).toBe("Save");
    expect(await page.locator("#quick .quick-inner > *:visible").first().getAttribute("class")).toBe("erga-scratch-save");
    expect(await save.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe("rgb(234, 88, 12)");
    expect((await tipOf("#quick .erga-scratch-save")).shown).toBe("0");
    await over("#quick .erga-scratch-save");
    await expect
      .poll(async () => {
        const tip = await tipOf("#quick .erga-scratch-save");
        return [tip.text, tip.shown, tip.card];
      })
      .toEqual([`"Save to your documents list. ${deleted.slice(1)}`, "1", made.card]);
    await page.mouse.move(600, 500);
    // Not on the person's list, nor their agent's.
    const listed = async () =>
      (await p.tool<{ documents: { id: string; title: string; expires?: string }[] }>("list_documents")).result!.documents.find(
        (d) => d.id == doc
      );
    expect(await p.docs()).not.toContain(doc);
    expect(await listed()).toBeUndefined();

    // A heading typed, then Save: the button goes, and the address follows the heading, still in the editor.
    await ed.idle();
    await ed.selectAllOf("h1");
    await ed.type("Groceries");
    await ed.shows(`
      # Groceries|

      Start writing here.
    `);
    await clickOn(page, "#quick .erga-scratch-save");
    await expect.poll(() => page.locator(".erga-scratch-save").count()).toBe(0);
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/${p.login}/groceries`);
    expect(new URL(page.url()).search).toBe("?edit");
    const kept = await listed();
    expect(kept).toMatchObject({ title: "Groceries" });
    expect(kept?.expires).toBeUndefined();
    // The logo goes back to the list, which has it now, at its address.
    await clickOn(page, "#nav-docs .erga-brand, .erga-crumbs .erga-brand");
    await page.waitForURL(/\/docs$/);
    expect(await page.getAttribute(`li[data-live="doc:${doc}"] a.doc`, "href")).toBe(`/${p.login}/groceries?edit`);
  });

  test("in the editor, ⌘K opens the quick search from inside the page, and ⌘⇧K is the link; Go to… in the editor's own menu opens the search too; typing and Enter open a page", async ({
    tab,
  }) => {
    // The row opens the project in its editor.
    await clickOn(page, `li[data-live="doc:${id["A project"]}"] a.doc`);
    await page.waitForURL(`${s.root}${project}?edit`);
    ed = editor(page, { address: `${s.root}${project}`, dir: "", file: "" });
    await ed.loaded();
    tab.strict = true;
    // The key goes from the page to the shell.
    const at = await ed.charAt("h1", 2);
    await ed.click(at.x, at.y);
    await ed.press("ControlOrMeta+k");
    await expect.poll(async () => (await pane(page))?.groups).toContain("Pages");
    await page.keyboard.press("Escape");
    await expect.poll(() => pane(page)).toBeNull();
    await ed.selectChars("h1", 4);
    await ed.press("ControlOrMeta+Shift+k");
    await expect.poll(() => ed.controls<boolean>(`!C.getElementById("fmt").hidden && !C.getElementById("link").hidden`)).toBe(true);
    expect(await pane(page)).toBeNull();
    await page.keyboard.press("Escape");
    // The key goes from the page to Erga's own window, which fades its controls: nothing else was open. (A press
    // before the key came there opened the menu, and the key closed it.)
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("chrome-hidden"))).toBe(true);
    // The editor's own avatar menu (#account).
    await clickOn(page, "#me .avatar");
    await clickOn(page, "#account-go");
    await expect.poll(async () => (await pane(page))?.groups).toEqual(expect.arrayContaining(["Pages of A project", "Documents"]));
    expect(await page.evaluate(() => document.getElementById("account")!.hidden), "the menu closed").toBe(true);
    await page.keyboard.type("road");
    await expect.poll(async () => (await pane(page))?.rows).toEqual([`Road map${project}/plans/roadmap`]);
    await page.keyboard.press("Enter");
    await page.waitForURL((u) => u.pathname == `${project}/plans/roadmap`);
  });

  test("in the editor, ⌘K finds a document made since it last opened, never a scratch one; Enter opens it", async () => {
    await clickOn(page, ".erga-edit-button");
    await page.waitForURL(`${s.root}${project}/plans/roadmap?edit`);
    await ed.loaded();
    const at = await ed.charAt("h1", 2);
    await ed.click(at.x, at.y);
    await ed.press("ControlOrMeta+k");
    await expect.poll(async () => (await pane(page))?.groups).toContain("Documents");
    await page.keyboard.press("Escape");
    await expect.poll(() => pane(page)).toBeNull();
    // Made while the editor is open: the next ⌘K reads the list again.
    const fresh = (await make("Zebra crossing notes")).address;
    scratch = (await make("Zebra scratch", { scratch: true })).address;
    await ed.press("ControlOrMeta+k");
    await page.keyboard.type("zebra");
    await expect.poll(async () => (await pane(page))?.rows).toEqual([`Zebra crossing notes${fresh}`]);
    // The editor keeps its text: none of the keys reached it.
    expect(await ed.source()).not.toContain("zebra");
    await page.keyboard.press("Enter");
    await page.waitForURL(`${s.root}${fresh}`);
  });

  test("viewed, a scratch document has Save first in the viewer's quick actions; the pencil's editor has it too, and Save there keeps it", async () => {
    await page.goto(`${s.root}${scratch}`);
    const view = page.locator(".erga-view-buttons .erga-scratch-save");
    await expect.poll(() => view.isVisible()).toBe(true);
    expect(await page.locator(".erga-view-buttons .quick-inner > *").first().getAttribute("class")).toBe("erga-scratch-save");
    await view.hover();
    await expect.poll(() => view.evaluate((b) => getComputedStyle(b, "::after").opacity)).toBe("1");
    expect(await p.docs()).not.toContain(`doc:${id["Zebra scratch"]}"`);

    await clickOn(page, ".erga-edit-button");
    await editor(page, { address: `${s.root}${scratch}`, dir: "", file: "" }).loaded();
    const save = page.locator("#quick .erga-scratch-save");
    await expect.poll(() => save.isVisible()).toBe(true);
    await clickOn(page, "#quick .erga-scratch-save");
    await expect.poll(() => page.locator(".erga-scratch-save").count()).toBe(0);
    await until(async () => (await p.docs()).includes(`doc:${id["Zebra scratch"]}"`), 5000, "the saved document is on the list");
  });

  test("the pencil goes back to the viewer, where the saved document has no Save", async () => {
    await clickOn(page, ".erga-edit-button");
    await expect.poll(() => page.getAttribute(".erga-edit-button", "aria-pressed")).toBe("false");
    expect(await page.locator(".erga-scratch-save").count()).toBe(0);
  });

  // (The editor's fast click and the corner's own both took the press once: the menu opened and closed at once.)
  test("after the editor, the viewer's avatar opens its menu", async () => {
    await clickOn(page, "[data-erga-account] button");
    expect(await page.evaluate(() => document.querySelector<HTMLElement>(".erga-account-menu")!.hidden)).toBe(false);
  });

  test("a document that nobody edits is deleted on time, and leaves the list; one that is edited stays; one that someone has open stays for now", async () => {
    try {
      await until(async () => !(await bo.exists(life.gone)), UNEDITED_MS + 6000, "the unedited document goes");
      // The open one's time was put off by an hour: its alarm has come.
      const expiresOf = async (doc: string) =>
        (await bo.tool<{ documents: { id: string; expires?: string }[] }>("list_documents")).result!.documents.find((d) => d.id == doc)
          ?.expires;
      await until(
        async () => Date.parse((await expiresOf(life.open)) ?? "0") - Date.now() > 30 * 60_000,
        5000,
        "the open document's time put off"
      );
      expect([await bo.exists(life.kept), await bo.exists(life.open)]).toEqual([true, true]);
      const list = await bo.docs();
      expect(list).not.toContain(`doc:${life.gone}"`);
      expect(list).toContain(`href="${(await bo.nameOf(life.kept)).address}?edit"`);
    } finally {
      life.socket.close();
    }
  });
});

journey("the admin: / opens the documents, ⌘K finds Erga's pages, the Home page button and the logo", () => {
  let page: Page;

  test("signed in, / opens /docs, whose last quick action is Home page", async ({ tab }) => {
    page = tab.page;
    tab.strict = true;
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${s.root}/`);
    expect(new URL(page.url()).pathname).toBe("/docs");
    // The Home page button is the last quick action, in the place where other pages have Documents.
    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".erga-view-buttons .quick-inner > *")].map((e) => e.getAttribute("aria-label") ?? e.className)
    );
    expect(order.at(-1)).toBe("Home page");
    expect(order).not.toContain("Documents");
    // The logo on /docs itself goes to /docs too.
    expect(await page.getAttribute(".erga-crumbs .erga-brand", "href")).toBe("/docs");
  });

  test("⌘K opens the quick search with Erga's pages and the admin ones; typing narrows it, ↓ and Enter open one, Escape closes it", async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect.poll(async () => (await pane(page))?.groups).toEqual(expect.arrayContaining(["Pages", "Admin"]));
    expect((await pane(page))!.rows).toEqual(expect.arrayContaining(["Settings#settings", "Users/admin/users"]));
    await page.keyboard.type("admin");
    await expect.poll(async () => (await pane(page))?.groups).toEqual(["Admin"]);
    await page.keyboard.type(" au");
    await expect.poll(async () => (await pane(page))?.rows).toEqual(["Authentication/admin/auth"]);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    // Every admin page again, the first one chosen.
    await expect.poll(async () => (await pane(page))?.rows.length).toBeGreaterThan(3);
    const all = (await pane(page))!;
    expect(all.rows.every((r) => r.includes("/admin"))).toBe(true);
    expect(all.picked).toBe(all.rows[0]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect((await pane(page))!.picked).toBe(all.rows[2]);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${s.root}${all.rows[2].slice(all.rows[2].indexOf("/admin"))}`);
    await page.keyboard.press("ControlOrMeta+k");
    await expect.poll(() => pane(page)).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect.poll(() => pane(page)).toBeNull();
  });

  test("the Home page button opens the homepage project, and the logo there goes back to the documents", async () => {
    await page.goBack();
    await page.waitForURL((u) => u.pathname == "/docs");
    await Promise.all([page.waitForURL((u) => u.pathname == "/_home"), page.click(".erga-home-button")]);
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".erga-crumbs .erga-here")?.textContent ?? ""))
      .toBe("Erga Homepage");
    await Promise.all([page.waitForURL((u) => u.pathname == "/docs"), page.click(".erga-crumbs .erga-brand")]);
  });

  test("signed out, / stays the homepage, and the logo of the homepage project goes to /", async () => {
    await page.goto(`${s.root}/auth/logout`);
    await page.goto(`${s.root}/`);
    expect(new URL(page.url()).pathname).toBe("/");
    // Signed out, /_home is the homepage project too, to view.
    await page.goto(`${s.root}/_home`);
    expect(new URL(page.url()).pathname).toBe("/_home");
    expect(await page.getAttribute(".erga-crumbs .erga-brand", "href")).toBe("/");
  });
});
