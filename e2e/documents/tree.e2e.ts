// A project's tree of pages: in the editor (the card under the title), a person opens it, moves in it with the keys,
// makes, renames, moves and deletes pages and folders, and the tree follows what an agent, another tab or the disk
// changes. On Documents and in the viewer the same tree shows, and a document becomes a project and back.
//
// The documents are DEV_LOGIN's, whose list on Documents holds every file's fixtures: the steps find their own rows
// by the document's id.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Route } from "playwright-core";
import { expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { newToken } from "../helpers/new-token";
import { idOf, runTool, treeOp } from "../helpers/tools";
import { listenNews, person } from "./people";
import {
  act,
  agentClosed,
  answered,
  changing,
  clickOn,
  edges,
  editorFocused,
  focused,
  js,
  lines,
  menuItem,
  menuItems,
  multi,
  openCard,
  paths,
  press,
  row,
  rows,
  treeEvents,
  treeUp,
  type,
  up,
  watchTree,
  type Doc,
} from "./tree-rows";

const s = await servers.main();

/** The fixture's tree as it reads on the screen, with the assets folder open. */
const WANT = ["Field guide index.html", "assets", "owl.svg", "blog", "fonts", "About us about.html", "Contact contact.html", "style.css"];

/** Holds each call of a tool from the page until `refuse` (the server says no) or `pass`. */
async function hold(page: Page, tool: string) {
  const held: Route[] = [];
  await page.route(`**/api/tools/${tool}*`, (r) => void held.push(r));
  const next = async () => {
    await expect.poll(() => held.length).toBeGreaterThan(0);
    return held.shift()!;
  };
  return {
    refuse: async (error: string) =>
      (await next()).fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error }) }),
    pass: async () => (await next()).continue(),
    end: () => page.unroute(`**/api/tools/${tool}*`),
  };
}
/** The refused calls of a step are errors in the console: those only. */
const onlyRefusals = (errors: string[], status: number) =>
  expect(
    errors.splice(0).filter((e) => !new RegExp(`Failed to load resource: the server responded with a status of ${status}`).test(e))
  ).toEqual([]);

journey("a project's tree in the editor", () => {
  let page: Page, doc: Doc;

  test("the first click on the title, with no hover first, opens the tree: index.html first by its title, marked as the page you're on, then folders, pages and other files", async ({
    tab,
  }) => {
    page = tab.page;
    tab.strict = true;
    doc = await multi(s);
    await agentClosed(page);
    await watchTree(page);
    await up(page, doc.base);
    expect(await js(page, `document.getElementById("pages").hidden`)).toBe(true);
    // As a keyboard or a touch clicks it: no pointer over it first. The tree's script may not be there yet.
    await page.evaluate(
      `(() => { const b = document.getElementById("doc-title"); b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); b.click(); })()`
    );
    await until(
      () => js(page, `!!document.querySelector("#pages:not([hidden]) .et-row[data-path]")`),
      5000,
      "the first click opens the tree with its rows"
    );
    const r = await rows(page);
    expect(r[0]).toEqual(["index.html", "Field guide", 1, true]);
    expect(r.slice(1).map((x) => [x[0], x[2]])).toEqual([
      ["assets", 1],
      ["blog", 1],
      ["fonts", 1],
      ["about.html", 1],
      ["contact.html", 1],
      ["style.css", 1],
    ]);
    expect(r.find((x) => x[0] == "about.html")?.[1]).toBe("About us");
    expect(await js(page, `document.getElementById("doc-title").getAttribute("aria-expanded")`)).toBe("true");
  });

  // The editor in the page takes the focus only as it starts (libs/text/ui/frame.ts): once it took it later, from the card.
  test("the tree, opened right after the shell gives the page the focus, keeps the focus, on the page you're on", async () => {
    await treeUp(page);
    // A click on the page closes the card, and the page has the focus: the editor as a person sees it ready.
    await page.frameLocator("#frame").locator("h1").click();
    await editorFocused(page);
    await expect.poll(() => js(page, `document.getElementById("pages").hidden`)).toBe(true);
    const frame = (await until(
      async () => {
        for (const f of page.frames()) if (await f.evaluate("!!window.ergaFrame?.page").catch(() => false)) return f;
        return null;
      },
      5000,
      "the editor's frame"
    )) as Frame;
    await page.evaluate(`(() => { ergaPage.page.focus(); document.getElementById("doc-title").click(); })()`);
    await expect.poll(() => page.evaluate(`!!document.activeElement?.closest("#pages")`)).toBe(true);
    expect((await frame.evaluate(`document.hasFocus()`)) as boolean).toBe(false);
    await expect.poll(() => focused(page)).toBe("index.html");
  });

  test("Escape closes the tree, the focus back on the title", async () => {
    await press(page, "Escape");
    await expect.poll(() => js(page, `document.getElementById("pages").hidden && document.activeElement.id == "doc-title"`)).toBe(true);
  });

  test("the editor shows every file, each page with its file's name; a folder opens by a click and by the keys, and ↓, Home and End move", async () => {
    await openCard(page);
    await clickOn(page, row("assets"));
    await expect.poll(() => lines(page, "#pages-tree")).toEqual(WANT);
    expect(await edges(page, "#pages-tree")).toBe(1);
    await clickOn(page, row("blog"));
    await expect
      .poll(async () => (await paths(page)).join())
      .toBe(
        "index.html,assets,assets/owl.svg,blog,blog/drafts,blog/index.html,blog/spring-migration.html,fonts,about.html,contact.html,style.css"
      );
    await press(page, "ArrowLeft");
    await expect.poll(() => paths(page)).not.toContain("blog/drafts");
    await press(page, "ArrowRight");
    await expect.poll(() => paths(page)).toContain("blog/drafts");
    await press(page, "ArrowRight");
    await expect.poll(() => focused(page)).toBe("blog/drafts");
    await press(page, "ArrowDown");
    await press(page, "ArrowDown");
    await expect.poll(() => focused(page)).toBe("blog/spring-migration.html");
    await press(page, "Home");
    await expect.poll(() => focused(page)).toBe("index.html");
    await press(page, "End");
    await expect.poll(() => focused(page)).toBe("style.css");
  });

  test("New folder asks for its name in place and makes it; its + menu's New page makes a page in it, named without .html, then .html on disk", async () => {
    await clickOn(page, ".et-foot .et-add:nth-child(2)");
    await expect.poll(() => focused(page)).toBe("input");
    await type(page, "notes");
    await changing(page, () => press(page, "Enter"));
    expect(await doc.tree()).toContain("notes");
    await expect.poll(() => focused(page)).toBe("notes");
    await act(page, "notes", "add");
    await menuItem(page, "New page");
    await type(page, "Ideas");
    // The name is typed without .html: it is a page, not a file.
    expect(await js(page, `document.activeElement.value`)).toBe("Ideas");
    await changing(page, () => press(page, "Enter"));
    expect(await doc.tree()).toContain("notes/ideas.html");
    // Inside the folder, which opened, by its name.
    await expect.poll(async () => (await rows(page)).some((x) => x[0] == "notes/ideas.html" && x[1] == "Ideas" && x[2] == 2)).toBe(true);
  });

  test("a taken name says so, in place, before it goes anywhere; Escape drops it", async () => {
    await clickOn(page, ".et-foot .et-add:nth-child(1)");
    await type(page, "about");
    await press(page, "Enter");
    await expect
      .poll(() => js(page, `document.querySelector(".et-msg.error")?.textContent ?? ""`))
      .toMatch(/already a page called “About”/);
    await press(page, "Escape");
    await expect.poll(() => js(page, `!!document.querySelector(".et-input")`)).toBe(false);
  });

  test("F2 renames a page in place: its readable name, no .html; Enter renames it on disk", async () => {
    await page.evaluate(`document.querySelector(${JSON.stringify(row("contact.html"))}).focus()`);
    await press(page, "F2");
    await expect.poll(() => js(page, `document.activeElement?.value`)).toBe("Contact");
    await page.evaluate(`document.activeElement.select()`);
    await type(page, "write-to-us");
    await changing(page, () => press(page, "Enter"), "moved");
    const t = await doc.tree();
    expect([t.includes("write-to-us.html"), t.includes("contact.html")]).toEqual([true, false]);
    await expect.poll(() => paths(page)).toContain("write-to-us.html");
  });

  test("a folder's name that the server refuses (a # in it): its words show in place, and nothing changes", async ({ tab }) => {
    await act(page, "notes", "more");
    await menuItem(page, "Rename folder");
    await page.evaluate(`document.activeElement.select()`);
    await type(page, "notes#1");
    await press(page, "Enter");
    await expect.poll(() => js(page, `document.querySelector(".et-msg.error")?.textContent ?? ""`)).toMatch(/can't contain/);
    await press(page, "Escape");
    expect(await doc.tree()).toContain("notes");
    onlyRefusals(tab.errors, 400);
  });

  test("a page's menu says page (never document); Move page to… moves it into a folder", async () => {
    await act(page, "write-to-us.html", "more");
    expect(await menuItems(page)).toEqual(["Open in a new tab", "Rename page", "Move page to…", "Delete page"]);
    const words = (await page.evaluate(
      `document.getElementById("pages").textContent + " " + [...document.querySelectorAll("#pages [aria-label], #pages [placeholder], #pages [title]")].map((e) => (e.getAttribute("aria-label") ?? "") + " " + (e.getAttribute("placeholder") ?? "") + " " + (e.getAttribute("title") ?? "")).join(" ")`
    )) as string;
    expect(words).toContain("New page");
    // Only index.html's row renames the document.
    expect(words.replace(/Rename this document, or change its address/g, "")).not.toMatch(/\bdocuments?\b/i);
    await menuItem(page, "Move page to…");
    await changing(page, () => menuItem(page, "notes"), "moved");
    expect(await doc.tree()).toContain("notes/write-to-us.html");
  });

  test("a page dropped on a folder moves there: the folder lights up under it, the page keeps its title, and a note warns that its relative links may break", async () => {
    const lit = await changing(
      page,
      () =>
        page.evaluate(`(() => {
        const from = document.querySelector('.et-row[data-path="about.html"]'), to = document.querySelector('.et-row[data-path="blog"]');
        const dt = new DataTransfer();
        from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
        const lit = to.classList.contains("drop");
        to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
        from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
        return lit;
      })()`),
      "moved"
    );
    expect(lit).toBe(true);
    expect(await doc.tree()).toContain("blog/about.html");
    await expect
      .poll(() => js(page, `document.querySelector(".et-banner.note")?.textContent ?? ""`))
      .toMatch(/Moved\. “About us” finds its styles, images and links by where it was/);
    await expect.poll(async () => (await rows(page)).some((x) => x[0] == "blog/about.html" && x[1] == "About us")).toBe(true);
  });

  test("a page that arrives on disk shows, by its title", async () => {
    await changing(page, async () => writeFileSync(join(doc.dir, "faq.html"), "<!doctype html><title>Questions</title><h1>Questions</h1>"));
    await until(
      async () => (await rows(page)).some((x) => x[0] == "faq.html" && x[1] == "Questions"),
      10_000,
      "a page that arrives on disk shows, by its title"
    );
  });

  test("over the API: new folders and pages (from the template), listed with their titles; each change is an event to the open editor, whose tree shows it", async () => {
    type Entry = { path: string; type: string; title?: string };
    const short = (entries: Entry[] = []) => entries.map((e) => `${e.path}${e.type == "folder" ? "/" : e.type == "file" ? "*" : ""}`);
    const op = async (o: Record<string, unknown>) => {
      const r = await treeOp(s.root, doc.id, o);
      return { status: r.status, entries: short((r.result as { entries?: Entry[] })?.entries) };
    };
    const read = await runTool<{ entries: Entry[]; canEdit: boolean }>(s.root, "ls", { document: doc.id });
    expect([read.status, read.result!.canEdit]).toEqual([200, true]);
    expect(short(read.result!.entries)).toEqual(expect.arrayContaining(["index.html", "style.css*", "notes/", "notes/ideas.html"]));
    expect(read.result!.entries.filter((e) => e.title).map((e) => `${e.path}: ${e.title}`)).toEqual(
      expect.arrayContaining(["index.html: Field guide", "faq.html: Questions"])
    );
    const before = (await treeEvents(page)).length;
    let r = await changing(page, () => op({ op: "new_folder", path: "news" }));
    expect(r.status).toBe(200);
    expect(r.entries).toContain("news/");
    expect((await changing(page, () => op({ op: "new_page", path: "news/index.html" }))).status).toBe(200);
    r = await changing(page, () => op({ op: "new_page", path: "news/post" }));
    expect(r.status).toBe(200);
    expect(r.entries).toEqual(expect.arrayContaining(["news/", "news/index.html", "news/post.html"]));
    await changing(page, () => op({ op: "new_page", path: "about.html" }));
    const template = await (await fetch(`${s.root}/d/${doc.id}/doc/about.html`)).text();
    expect(template).toContain("<h1>Untitled</h1>");
    expect(template).toContain("Start writing here.");
    expect((await treeEvents(page)).length - before).toBeGreaterThanOrEqual(4);
    await expect
      .poll(async () => (await rows(page)).filter((x) => x[0] == "news" || x[0] == "about.html").map((x) => x.slice(0, 2).join(": ")))
      .toEqual(["news: news", "about.html: About"]);
  });

  test("a deleted page's row goes at once; refused, it is back, and the tree says why", async ({ tab }) => {
    const rm = await hold(page, "rm");
    await act(page, "notes/ideas.html", "more");
    await menuItem(page, "Delete page");
    await expect.poll(() => paths(page, "#pages")).not.toContain("notes/ideas.html");
    await rm.refuse("Someone is editing that page.");
    await expect.poll(() => paths(page, "#pages")).toContain("notes/ideas.html");
    await expect.poll(() => js(page, `document.querySelector("#pages")?.textContent ?? ""`)).toContain("Someone is editing that page.");
    expect(await doc.tree()).toContain("notes/ideas.html");
    await rm.end();
    onlyRefusals(tab.errors, 409);
  });

  test("Delete page deletes it at once; Delete folder asks first, in its row; Escape keeps it; the Delete key and the confirm button delete it and what is in it", async () => {
    await act(page, "notes/ideas.html", "more");
    await changing(page, () => menuItem(page, "Delete page"), "deleted");
    expect(await doc.tree()).not.toContain("notes/ideas.html");
    await act(page, "notes", "more");
    await menuItem(page, "Delete folder");
    await expect
      .poll(() => js(page, `document.querySelector(".et-row.confirm")?.textContent ?? ""`))
      .toMatch(/Delete the folder “notes” and the page in it\?/);
    await press(page, "Escape");
    await expect.poll(() => js(page, `!!document.querySelector(".et-row.confirm")`)).toBe(false);
    expect(await doc.tree()).toContain("notes");
    await page.evaluate(`document.querySelector(${JSON.stringify(row("notes"))}).focus()`);
    await press(page, "Delete");
    await changing(page, () => clickOn(page, ".et-row.confirm .et-btn.danger"), "deleted");
    expect((await doc.tree()).some((x) => x.startsWith("notes"))).toBe(false);
  });

  test("a person added to Share shows at once; refused, they go again, and the card says why", async ({ tab }) => {
    const people = () =>
      js(page, `[...document.querySelectorAll("#sharing-list li")].map((li) => li.textContent.replace(/Can .*/, "").trim().slice(1))`);
    await press(page, "Escape");
    await clickOn(page, "#btn-share");
    await expect
      .poll(() => js(page, `!document.getElementById("sharing").hidden && document.getElementById("sharing-status").textContent == ""`))
      .toBe(true);
    const before = await people();
    const share = await hold(page, "share_document");
    await page.keyboard.type("grace");
    await page.keyboard.press("Enter");
    await expect.poll(people).toEqual([...before, "grace"]);
    await share.refuse("There's no user grace.");
    await expect.poll(people).toEqual(before);
    expect(await js(page, `document.getElementById("sharing-status").textContent`)).toBe("There's no user grace.");
    await share.end();
    await press(page, "Escape");
    onlyRefusals(tab.errors, 409);
  });

  test("a new title shows at once; refused, the old one is back, and the card says why with what was typed; saved again, it stays", async ({
    tab,
  }) => {
    const title = () => js(page, `document.getElementById("doc-title-text").textContent`);
    const naming = () =>
      js(
        page,
        `document.getElementById("naming").hidden ? null : [document.getElementById("naming-title").value, document.getElementById("naming-status").textContent]`
      );
    const was = await title();
    const rename = await hold(page, "rename_document");
    await openCard(page);
    await act(page, "index.html", "rename");
    await expect.poll(async () => (await naming()) != null).toBe(true);
    await page.keyboard.type("Field notes");
    await page.keyboard.press("Enter");
    // Before any answer: the title, and the card closed.
    await expect.poll(title).toBe("Field notes");
    expect(await naming()).toBeNull();
    await rename.refuse("That title is taken.");
    await expect.poll(title).toBe(was);
    await expect.poll(naming).toEqual(["Field notes", "That title is taken."]);
    // Saved again, and the server agrees: it stays.
    await page.keyboard.press("Enter");
    await expect.poll(title).toBe("Field notes");
    await rename.pass();
    await expect.poll(async () => (await doc.name()).title).toBe("Field notes");
    expect(await title()).toBe("Field notes");
    await rename.end();
    onlyRefusals(tab.errors, 409);
  });

  test("two tabs: a page made and moved in one shows in the other", async () => {
    await openCard(page);
    const p2 = await page.context().newPage();
    await agentClosed(p2);
    await watchTree(p2);
    await up(p2, doc.base);
    await treeUp(p2);
    await openCard(p2);
    await clickOn(p2, ".et-foot .et-add:nth-child(1)");
    await type(p2, "Field marks");
    await changing(p2, () => press(p2, "Enter"));
    expect(await doc.tree()).toContain("field-marks.html");
    await until(
      async () => (await rows(page)).some((x) => x[0] == "field-marks.html" && x[1] == "Field marks"),
      10_000,
      "the first tab shows it, live"
    );
    await act(p2, "field-marks.html", "more");
    await menuItem(p2, "Move page to…");
    await changing(p2, () => menuItem(p2, "blog"), "moved");
    await until(
      async () => {
        const p = await paths(page);
        return p.includes("blog/field-marks.html") && !p.includes("field-marks.html");
      },
      10_000,
      "a move in the second tab shows in the first"
    );
    await p2.close();
    await page.bringToFront();
  });

  test("an agent's new page, move and stylesheet show: pages by their titles", async () => {
    await changing(page, () => doc.agentTool("new", { path: "blog/owl-calls" }));
    await doc.agentTool("write", { path: "blog/owl-calls.html", content: "<!doctype html><title>Owl calls</title><h1>Owl calls</h1>" });
    await until(
      async () => (await rows(page)).some((x) => x[0] == "blog/owl-calls.html" && x[1] == "Owl calls"),
      10_000,
      "an agent's new page shows, by its title"
    );
    await changing(page, () => doc.agentTool("mv", { from: "faq.html", to: "blog/faq.html" }), "moved");
    await expect.poll(async () => (await paths(page)).filter((p) => p.endsWith("faq.html"))).toEqual(["blog/faq.html"]);
    // A stylesheet: a project's tree shows it too.
    await changing(page, () => doc.agentTool("write", { path: "blog/blog.css", content: "h1 { letter-spacing: 0.01em; }" }));
    await expect.poll(() => paths(page)).toContain("blog/blog.css");
  });

  test("?pages opens the tree at once; an agent moves the page you're on: the editor follows it to its new address, and the tree marks it there", async () => {
    // The page's editor asks the server for its own page as it starts: a move before the answer would be a 404 in the console.
    const asked = page.waitForResponse(
      (r) => r.request().resourceType() == "fetch" && new URL(r.url()).pathname.endsWith("/blog/owl-calls.html")
    );
    await up(page, `${doc.base}/blog/owl-calls`, "?pages");
    await until(
      async () => (await rows(page)).some((x) => x[0] == "blog/owl-calls.html" && x[3]),
      10_000,
      "the tree marks the page you're on, in its folder, which opened"
    );
    await asked;
    await doc.agentTool("mv", { from: "blog/owl-calls.html", to: "owl-calls.html" });
    const here = new URL(doc.base).pathname;
    await until(
      () => new URL(page.url()).pathname + new URL(page.url()).search == `${here}/owl-calls?edit`,
      10_000,
      "the editor follows its page to its new address"
    );
    await until(
      async () => (await rows(page).catch(() => [])).some((x) => x[0] == "owl-calls.html" && x[3]),
      10_000,
      "and the tree marks it there"
    );
  });

  test("on a phone the tree fits the screen", async () => {
    await page.setViewportSize({ width: 390, height: 760 });
    await up(page, doc.base);
    await treeUp(page);
    await editorFocused(page);
    // Near the left edge of what shows of the title: the breadcrumbs' bar keeps the title's end in sight, and its start may be cut off.
    const at = (await until(
      () =>
        page.evaluate(
          `(() => { const t = document.getElementById("doc-title"), r = t.getBoundingClientRect(), nav = document.getElementById("nav-docs").getBoundingClientRect(); const p = { x: Math.max(r.left, nav.left + 8) + 8, y: r.top + r.height / 2 }; return t.contains(document.elementFromPoint(p.x, p.y)) ? p : null; })()`
        ) as Promise<{ x: number; y: number } | null>,
      5000,
      "the title can be clicked"
    ))!;
    await page.mouse.click(at.x, at.y);
    await until(
      () => page.evaluate(`!document.getElementById("pages").hidden && document.querySelectorAll("#pages .et-row[data-path]").length >= 4`),
      5000,
      "the tree shows"
    );
    // It pops in: measured once it has stopped moving.
    await expect
      .poll(() =>
        js(
          page,
          `document.getAnimations().filter((a) => document.getElementById("pages").contains(a.effect?.target)).every((a) => a.playState != "running")`
        )
      )
      .toBe(true);
    expect(
      await js(
        page,
        `(() => { const r = document.getElementById("pages").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`
      )
    ).toBe(true);
  });
});

/** What a project's row on Documents shows: whether the chevron says open, is turned, and its pages show (and how). */
type Twist = { expanded: string | null; turned: boolean; shown: boolean; rows: number; text: string };
const twistOf = (page: Page, id: string) =>
  page.evaluate(`(() => {
  const b = document.querySelector('button.twist[data-id="${id}"]'), sub = document.getElementById("pages-${id}");
  return { expanded: b.getAttribute("aria-expanded"), turned: getComputedStyle(b.querySelector("svg")).transform != "none",
    shown: !!sub && sub.getClientRects().length > 0 && sub.offsetHeight > 0,
    rows: sub ? sub.querySelectorAll(".et-row[data-path]").length : 0, text: sub?.textContent ?? "" };
})()`) as Promise<Twist>;
const isOpen = (page: Page, id: string, ready: (s: Twist) => boolean) =>
  expect
    .poll(async () => {
      const s = await twistOf(page, id);
      return s.expanded == "true" && s.turned && s.shown && ready(s);
    })
    .toBe(true);
const isClosed = (page: Page, id: string) =>
  expect
    .poll(async () => {
      const s = await twistOf(page, id);
      return s.expanded == "false" && !s.turned && !s.shown;
    })
    .toBe(true);

journey("a project on Documents and in the viewer; a document becomes a project and back", () => {
  let page: Page, doc: Doc;
  /** A project with no other pages yet, and a document (one page): their ids; the document's address. */
  let none = "",
    plain = "",
    plainAt = "";
  /** What the list's socket hears. */
  let news: ReturnType<typeof listenNews>;
  const chevron = (id: string) => `button.twist[data-id="${id}"]`;
  const has = (selector: string) => page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
  const caret = (p = page) =>
    p.evaluate(`getComputedStyle(document.querySelector("#doc-title .nav-caret")).display != "none"`) as Promise<boolean>;
  const openSettings = async () => {
    await clickOn(page, "#btn-settings");
    await until(() => js(page, `document.getElementById("doc-settings")?.hidden === false`), 5000, "the settings open");
  };

  test("on Documents the chevron and the account button act on the press, not on its release, and only once; the keyboard still works", async ({
    tab,
  }) => {
    page = tab.page;
    tab.strict = true;
    doc = await multi(s);
    const made = async (query: string) => {
      const at = ((await fetch(`${s.root}/new${query}`, { redirect: "manual" })).headers.get("location") ?? "").replace(/[?&]edit=?$/, "");
      return { at, id: await idOf(`${s.root}${at}`) };
    };
    none = (await made("?template=page&kind=project")).id;
    ({ at: plainAt, id: plain } = await made("?template=page"));
    await page.setViewportSize({ width: 1100, height: 720 });
    await agentClosed(page);
    await watchTree(page);
    news = listenNews(page);
    await page.goto(`${s.root}/docs`);
    // The rows just made come in once more as the page opens: from here they stay.
    await news.caughtUp();
    // A document's row has no chevron.
    expect(await has(`a.doc[href*="${plainAt}"]`)).toBe(true);
    expect(await has(chevron(plain))).toBe(false);

    const expanded = () => js(page, `document.querySelector('${chevron(doc.id)}').getAttribute("aria-expanded")`);
    const box = (await page.locator(chevron(doc.id)).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await expanded(), "open on the press").toBe("true");
    await page.mouse.up();
    await settle(page);
    expect(await expanded(), "the release's click is dropped").toBe("true");
    await page.mouse.down();
    await page.mouse.up();
    expect(await expanded()).toBe("false");
    await page.focus(chevron(doc.id));
    await page.keyboard.press("Enter");
    expect(await expanded(), "Enter").toBe("true");
    await page.keyboard.press("Space");
    expect(await expanded(), "Space").toBe("false");

    // The account button: its menu opens on the press, and the focus goes to its first link (the press doesn't take it back).
    const acc = (await page.locator("[data-erga-account] button").boundingBox())!;
    await page.mouse.move(acc.x + acc.width / 2, acc.y + acc.height / 2);
    await page.mouse.down();
    expect(await js(page, `!document.querySelector(".erga-account-menu").hidden`)).toBe(true);
    await page.mouse.up();
    expect(await js(page, `!document.querySelector(".erga-account-menu").hidden`)).toBe(true);
    expect(await js(page, `document.activeElement == document.querySelector(".erga-account-menu a")`)).toBe(true);
    // A click elsewhere closes it.
    await page.mouse.click(10, 400);
    expect(await js(page, `document.querySelector(".erga-account-menu").hidden`)).toBe(true);
  });

  test("the chevron opens and closes a project's pages, twice, and shows which; a project with no other pages says so, with New page and New folder", async () => {
    for (const [id, ready] of [
      [doc.id, (t: Twist) => t.rows > 0],
      [none, (t: Twist) => /No other pages yet\./.test(t.text) && /New page/.test(t.text) && /New folder/.test(t.text)],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        await isClosed(page, id);
        await clickOn(page, chevron(id));
        await isOpen(page, id, ready);
        await clickOn(page, chevron(id));
      }
      await isClosed(page, id);
    }
  });

  test("what is open is kept for the tab across a reload, and still closes; the others stay closed", async () => {
    await clickOn(page, chevron(none));
    await isOpen(page, none, () => true);
    await page.reload();
    await news.caughtUp();
    await isOpen(page, none, (t) => /No other pages yet\./.test(t.text));
    await isClosed(page, doc.id);
    await clickOn(page, chevron(none));
    await isClosed(page, none);
  });

  test("Documents shows the project's tree as the editor does: every file, index.html first, each page with its file's name", async () => {
    await clickOn(page, chevron(doc.id));
    await until(() => has(`#pages-${doc.id} ${row("index.html")}`), 5000, "Documents shows the tree");
    await answered(page);
    await clickOn(page, `#pages-${doc.id} ${row("assets")}`);
    await expect.poll(() => lines(page, `#pages-${doc.id}`)).toEqual(WANT);
    expect(await edges(page, `#pages-${doc.id}`)).toBe(1);
  });

  // (Documents reads its open trees again when the tab comes back, and every 4 s. The step does not wait for the 4 s.)
  test("on Documents an agent's new page shows with no reload when the tab comes back, and goes when the agent deletes it", async () => {
    const sub = `#pages-${doc.id}`;
    const back = () => page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`);
    await page.evaluate(`window.sameLoad = true`);
    await doc.agentTool("new", { path: "colophon" });
    await back();
    await until(async () => (await paths(page, sub)).includes("colophon.html"), 5000, "an agent's new page shows on Documents");
    await doc.agentTool("rm", { path: "colophon.html" });
    await back();
    await until(async () => !(await paths(page, sub)).includes("colophon.html"), 5000, "it goes when the agent deletes it");
    expect(await js(page, `window.sameLoad === true`)).toBe(true);
  });

  test("on Documents: New folder, New page, rename and Move to… (always with the warning here: Documents can't read the page's links), and delete a folder", async () => {
    const sub = `#pages-${doc.id}`;
    // (Each change shows in the tree when its answer is read: `answered`.)
    await clickOn(page, `${sub} .et-foot .et-add:nth-child(2)`);
    await type(page, "archive");
    await press(page, "Enter");
    await answered(page);
    expect(await doc.tree()).toContain("archive");
    await clickOn(page, `${sub} .et-foot .et-add:nth-child(1)`);
    await type(page, "Old news");
    await press(page, "Enter");
    await answered(page);
    expect(await doc.tree()).toContain("old-news.html");
    await expect.poll(async () => (await rows(page, sub)).some((x) => x[0] == "old-news.html")).toBe(true);
    await act(page, "old-news.html", "more", sub);
    await menuItem(page, "Rename page");
    await page.evaluate(`document.activeElement.select()`);
    await type(page, "Older news");
    await press(page, "Enter");
    await answered(page);
    const t = await doc.tree();
    expect([t.includes("older-news.html"), t.includes("old-news.html")]).toEqual([true, false]);
    await expect.poll(async () => (await rows(page, sub)).some((x) => x[0] == "older-news.html")).toBe(true);
    await act(page, "older-news.html", "more", sub);
    await menuItem(page, "Move page to…");
    await menuItem(page, "archive");
    await answered(page);
    expect(await doc.tree()).toContain("archive/older-news.html");
    await expect
      .poll(() => js(page, `document.querySelector("${sub} .et-banner.note")?.textContent ?? ""`))
      .toMatch(/Moved\. .* finds its styles, images and links by where it was/);
    await act(page, "archive", "more", sub);
    await menuItem(page, "Delete folder");
    await clickOn(page, `${sub} .et-row.confirm .et-btn.danger`);
    await answered(page);
    expect((await doc.tree()).some((x) => x.startsWith("archive"))).toBe(false);
  });

  test("on Documents a page's row opens it in the editor, for an editor", async () => {
    await clickOn(page, `#pages-${doc.id} ${row("about.html")}`);
    await until(
      () => new URL(page.url()).pathname + new URL(page.url()).search == `${new URL(doc.base).pathname}/about?edit`,
      5000,
      "the tab goes to the page's editor"
    );
    await until(
      () => page.evaluate(`document.body.classList.contains("erga-editor-ready")`).catch(() => false),
      10_000,
      "the editor is up"
    );
  });

  test("the viewer's crumb shows the same tree; a stylesheet opens as itself, in a new tab", async () => {
    await page.goto(doc.base);
    await clickOn(page, ".erga-tree-btn");
    await until(() => has(`#erga-tree ${row("index.html")}`), 5000, "the viewer's crumb shows the tree");
    // (The folder opened on Documents stays open for the tab, in each tree.)
    await until(() => has(`#erga-tree ${row("assets")}[aria-expanded="true"]`), 5000, "the folder is open here too");
    await expect.poll(() => lines(page, "#erga-tree")).toEqual(WANT);
    expect(await edges(page, "#erga-tree")).toBe(1);
    await answered(page);
    const opened = page.context().waitForEvent("page");
    await clickOn(page, `#erga-tree ${row("style.css")} .et-name`);
    const css = await opened;
    await css.waitForLoadState();
    expect(new URL(css.url()).pathname).toMatch(/\/style\.css$/);
    expect((await css.evaluate("document.contentType")) as string).toBe("text/css");
    await css.close();
  });

  test("Document or Project in the settings: the title's caret follows the kind at once, in every tab, and after a change from elsewhere", async () => {
    /** A tree operation from outside the tabs, as an agent's. */
    const op = (o: Record<string, unknown>) => treeOp(s.root, plain, o);
    // The editor, and a second tab of it: a document's title has no caret, and opens its name.
    await up(page, `${s.root}${plainAt}`);
    await treeUp(page);
    await editorFocused(page);
    const other = await page.context().newPage();
    await up(other, `${s.root}${plainAt}`);
    await page.bringToFront();
    expect([await caret(), await caret(other)]).toEqual([false, false]);
    await clickOn(page, "#doc-title");
    await expect
      .poll(() => js(page, `[document.getElementById("naming").hidden, document.getElementById("pages").hidden]`))
      .toEqual([false, true]);
    await page.keyboard.press("Escape");

    // The settings: Document chosen, no homepage note, and nothing about "Make a project" in the pages.
    await openSettings();
    await until(() => has('#ds-kind [data-kind="document"][aria-checked="true"]:not([aria-disabled])'), 5000, "the settings show Document");
    expect(await js(page, `document.getElementById("ds-home").hidden`)).toBe(true);
    expect(await js(page, `document.querySelector('#ds-kind [data-kind="document"]').dataset.tip`)).toBe(
      "A document is one page, with its files beside it."
    );
    expect(await js(page, `[...document.querySelectorAll("#pages .et-add")].map((b) => b.textContent)`)).not.toContain("Make a project");

    // Project: the caret shows at once here, and in the other tab with no reload; the title opens the pages.
    await changing(page, () => clickOn(page, '#ds-kind [data-kind="project"]'), "kind");
    await until(() => has('#ds-kind [data-kind="project"][aria-checked="true"]'), 5000, "the settings show Project");
    await until(() => caret(), 2000, "the caret shows once the server says so");
    await until(() => caret(other), 5000, "the other tab's caret shows, with no reload");
    await other.close();
    await page.keyboard.press("Escape");
    await clickOn(page, "#doc-title");
    await expect
      .poll(() =>
        js(
          page,
          `!document.getElementById("pages").hidden && [...document.querySelectorAll("#pages .et-foot .et-add")].filter((b) => !b.hidden).map((b) => b.textContent).join()`
        )
      )
      .toBe("New page,New folder");
    await page.keyboard.press("Escape");

    // A second page (from elsewhere): Document can't be chosen, and its tip says why.
    expect((await changing(page, () => op({ op: "new_page", path: "about" }))).status).toBe(200);
    await openSettings();
    await until(
      () => js(page, `document.querySelector('#ds-kind [data-kind="document"]').getAttribute("aria-disabled") == "true"`),
      5000,
      "Document is off with two pages"
    );
    expect(await js(page, `document.querySelector('#ds-kind [data-kind="document"]').dataset.tip`)).toBe(
      "A document has one page. This project has 2: delete the others first."
    );

    // One page again: Document, and the caret goes at once.
    expect((await changing(page, () => op({ op: "delete", path: "about.html" }), "deleted")).status).toBe(200);
    await until(
      () => js(page, `!document.querySelector('#ds-kind [data-kind="document"]').hasAttribute("aria-disabled")`),
      5000,
      "Document is on again with one page"
    );
    await changing(page, () => clickOn(page, '#ds-kind [data-kind="document"]'), "kind");
    await until(async () => !(await caret()), 5000, "the caret goes");

    // From elsewhere (an agent's make_project): the caret comes back with no reload, and the open settings follow.
    expect((await changing(page, () => op({ op: "make_project" }), "kind")).status).toBe(200);
    await until(() => caret(), 5000, "the caret shows after a change from elsewhere");
    await until(() => has('#ds-kind [data-kind="project"][aria-checked="true"]'), 5000, "the open settings follow");
    await page.keyboard.press("Escape");
  });

  test("New, then Project: a project from the start, its caret shown, and its two pages in the tree", async () => {
    const from = await page.evaluate(() => location.pathname);
    await clickOn(page, "#btn-new");
    await until(() => js(page, `!document.querySelector(".erga-new-menu").hidden`), 5000, "the New menu opens");
    await clickOn(page, '.erga-new-menu a[data-template="project"]');
    await until(
      () => page.evaluate((f) => location.pathname != f && location.search == "?edit", from),
      10_000,
      "the new project opens in the editor"
    );
    await until(
      () => page.evaluate(() => document.body.classList.contains("erga-editor-ready") && !document.getElementById("doc-title")!.hidden),
      10_000,
      "the editor is up"
    );
    await until(() => caret(), 5000, "a project's caret shows");
    await clickOn(page, "#doc-title");
    await until(async () => [...(await paths(page, "#pages"))].sort().join() == "about.html,index.html", 5000, "both pages in the tree");
  });

  test("on Documents the document that became a project has its chevron, and says Project", async () => {
    await page.goto(`${s.root}/docs`);
    await until(() => has(chevron(plain)), 5000, "a project's row has its chevron");
    expect(await js(page, `document.querySelector('${chevron(plain)}').closest(".name").querySelector(".note.kind").textContent`)).toBe(
      "Project"
    );
  });
});

// (A project made over the API: one opened from disk, as the fixture, is everyone's to edit on a local server.)
test("editors change the tree, viewers only read it, strangers and other sites get nothing; a token works too", async () => {
  const made = await runTool<{ id: string }>(s.root, "create_document", {
    title: "Pages of the access check",
    kind: "project",
    files: { "index.html": "<h1>Home</h1>", "blog/post.html": "<h1>A post</h1>", "about.html": "<h1>About</h1>" },
  });
  const id = made.result!.id;
  const ada = await person(s);
  const read = (as: { cookie?: string; token?: string }) =>
    runTool<{ entries: { path: string }[]; canEdit: boolean }>(s.root, "ls", { document: id }, as);
  expect((await read(ada)).status).toBe(403);
  // (Locally, no cookie is DEV_LOGIN; a token that isn't one signs in nobody.)
  expect((await read({ token: "erga_nothing" })).status).toBe(401);
  expect((await runTool(s.root, "share_document", { document: id, login: ada.login, role: "viewer" })).ok).toBe(true);
  const viewing = await read(ada);
  expect([viewing.status, viewing.result!.canEdit]).toEqual([200, false]);
  expect(viewing.result!.entries.map((e) => e.path)).toContain("blog/post.html");
  const refused = await treeOp(s.root, id, { op: "new_page", path: "ada.html" }, { cookie: ada.cookie });
  expect(refused.status).toBe(403);
  expect(refused.error).toMatch(/can't edit/);
  // Another site's page, as the owner: refused.
  expect((await treeOp(s.root, id, { op: "new_page", path: "x.html" }, { origin: "https://elsewhere.example" })).status).toBe(403);
  const byToken = await read({ token: (await newToken(s.root, { label: "Access check" })).token });
  expect(byToken.ok).toBe(true);
  expect(byToken.result!.entries.map((e) => e.path)).toContain("about.html");
});
