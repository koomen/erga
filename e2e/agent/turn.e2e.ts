// The person's agent in its panel. In the editor: a turn's edits show, to the other people too; the turn's line, See
// changes, Undo and Redo; files attached; a message that fails or waits; the pane across a reload. On the
// documents' list: the agent's delete waits for Approve; the day's token limit; a document's own thread; the panel
// from page to page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentClosed, expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { editor, F, openEditor, type Editor } from "../helpers/editor";
import { runTool } from "../helpers/tools";
import { agentOn, answered, answers, button, calls, edit, paneOpen, say, script, turnEnded, turnLine, watchCalls } from "./panel";

const s = await servers.main();
/**
 * A bare server, with no agent key and no scripted model: there the agent is off. tools.e2e.ts uses the same one (it
 * has no homepage yet): a worker that runs both files starts it one time.
 */
const off = await servers.of("agent-bare");

/** Logins of this file's own: each has their own agent and conversation. */
const ADA = "TurnAda",
  BO = "TurnBo",
  LISA = "TurnLisa",
  OTHER = "TurnOther";

journey("a turn of the agent in the editor", () => {
  let ada: Editor, page: Page;
  const heads = async (ed: Editor) => `${await ed.textOf("h1")} / ${await ed.textOf("h2")} / ${await ed.textOf("figcaption")}`;
  const input = () => ada.eval<string>(`document.getElementById("agent-input").value`);

  test("coming into the editor for the first time, the pane opens by itself", async ({ tab }) => {
    page = tab.page;
    ada = await openEditor(tab, s, "page", { agent: true, query: `?user=${ADA}` });
    await expect.poll(() => paneOpen(page)).toBe(true);
    await agentOn(page);
    expect(await turnLine(page)).toBeNull();
    expect(await button(page, "agent-redo")).toBe("off");
  });

  test("the agent panel is each person's own: the others see the agent's edit and its badge, and none of the conversation", async () => {
    const other = await page.context().newPage();
    const errors: string[] = [];
    other.on("pageerror", (e) => errors.push(e.stack ?? e.message));
    other.on("console", (m) => {
      if (m.type() == "error") errors.push(`console.error: ${m.text()}`);
    });
    await agentClosed(other);
    await other.goto(`${ada.address}?user=${BO}&edit`);
    const bo = editor(other, { address: ada.address, dir: ada.dir, file: ada.file });
    await bo.loaded();
    await page.bringToFront();

    // One turn: an edit, and a look at the page (the server's browser renders it).
    const seen = await watchCalls(page);
    await say(
      page,
      script("Check it", [
        edit("Typing never waits.", "Typing never waits, by agent."),
        { text: "Now a look.", tool: "page", args: { op: "view_page", selector: "h1" } },
        { text: "Looked." },
      ])
    );
    await answered(page, "Looked.", 13_000);
    expect((await answers(page)).at(-2), "what the agent says between its calls stays").toBe("Now a look.");
    // The turn's calls have one line: the look takes the edit's place. After the turn, only the picture stays.
    const lines = await seen();
    expect(Math.max(...lines.map((l) => l.length)), JSON.stringify(lines)).toBe(1);
    const order = lines.flat().filter((l, i, all) => l != all[i - 1]);
    expect(order.slice(0, 3)).toEqual(["Editing", "Edited", "Looking at the page"]);
    expect(await calls(page), "view_page answers a picture of the page").toEqual(["Looked at the page [picture]"]);
    await expect.poll(() => turnLine(page)).toBe("Done. 1 change in index.html. [See changes] [Undo the turn]");

    await expect.poll(() => bo.textOf("blockquote p")).toBe("Typing never waits, by agent.");
    expect(await bo.eval<number>(`document.querySelectorAll("#agent-log .msg-user, #agent-log .msg-assistant").length`)).toBe(0);
    await until(
      () =>
        bo.eval<boolean>(
          `[...document.querySelectorAll(":is(#people, #me) .agent-badge")].some((e) => e.dataset.tip.includes(${JSON.stringify(`${ADA}, via their agent`)}))`
        ),
      5000,
      "the agent's badge shows on Bo's page"
    );
    // The turn is over: the agent has no caret on Bo's page.
    const carets = () => bo.frame<string>(`[...${F}.querySelectorAll("erga-peer-name")].map((e) => e.textContent).join("|")`);
    await until(async () => !(await carets()).includes(`${ADA}’s agent`), 5000, "the agent's caret goes", carets);
    expect(errors, "Bo's page has no errors").toEqual([]);
    await other.close();
  });

  test("a turn of three edits ends with one line; See changes shows them; Undo the turn takes all three back", async () => {
    await say(
      page,
      script("Edit", [
        edit("<h1>Launch notes</h1>", "<h1>Field notes</h1>"),
        edit(">What changed<", ">Dawn<"),
        edit("Where the leads go.", "Noon."),
        { text: "Done." },
      ])
    );
    await until(async () => (await heads(ada)) == "Field notes / Dawn / Noon.", 10_000, "the agent's three changes");
    await expect.poll(() => turnLine(page)).toBe("Done. 3 changes in index.html. [See changes] [Undo the turn]");

    // The text before and after the turn: this turn's lines only, not the lines of the turn before.
    await page.click("#agent-turn button.see");
    const shown = () => ada.eval<string>(`document.querySelector("dialog.agent-changes[open] pre")?.innerText ?? ""`);
    await until(async () => /^\+\s*<h1>Field notes<\/h1>$/m.test(await shown()), 10_000, "the changes show", shown);
    const diff = await shown();
    expect(diff).toMatch(/^-\s*<h1>Launch notes<\/h1>$/m);
    expect(diff).toContain("Dawn");
    expect(diff).toContain("Noon.");
    expect(diff).not.toMatch(/^[+-].*by agent/m);
    await page.click("dialog.agent-changes[open] button.close");

    // One click takes back the three changes of this turn, and leaves the turn before it.
    await page.click("#agent-turn button.undo");
    await until(async () => (await heads(ada)) == "Launch notes / What changed / Where the leads go.", 10_000, "the turn is undone");
    expect(await ada.textOf("blockquote p")).toBe("Typing never waits, by agent.");
    await expect.poll(() => turnLine(page)).toBe("Took back 3 changes.");
    await expect.poll(() => button(page, "agent-undo")).toBe("Undo the agent's last change (1 to go)");
  });

  test("Redo puts back each change that Undo took back; a new change by the agent turns Redo off", async () => {
    const click = async (id: string, want: string, undo: string, redo: string) => {
      await page.click(`#${id}`);
      await until(
        async () => (await heads(ada)) == want,
        10_000,
        `after ${id}, the page shows ${want}`,
        () => heads(ada)
      );
      await expect.poll(() => button(page, "agent-undo"), { message: `after ${id}: Undo` }).toBe(undo);
      await expect.poll(() => button(page, "agent-redo"), { message: `after ${id}: Redo` }).toBe(redo);
    };
    const UNDO = (n: number) => `Undo the agent's last change (${n} to go)`,
      REDO = (n: number) => `Redo the agent's last undone change (${n} to go)`;
    await expect.poll(() => button(page, "agent-redo")).toBe(REDO(3));
    await click("agent-redo", "Field notes / What changed / Where the leads go.", UNDO(2), REDO(2));
    await click("agent-redo", "Field notes / Dawn / Where the leads go.", UNDO(3), REDO(1));
    await click("agent-redo", "Field notes / Dawn / Noon.", UNDO(4), "off");
    await click("agent-undo", "Field notes / Dawn / Where the leads go.", UNDO(3), REDO(1));

    // Undo, then a new change by the agent: nothing is left to redo.
    const sent = (await answers(page)).length;
    await say(page, script("Edit", [edit("Faster builds", "Faster tests"), { text: "Done." }]));
    await expect.poll(() => ada.textOf("li")).toBe("Faster tests");
    await expect.poll(() => button(page, "agent-redo"), { message: "a new change clears Redo" }).toBe("off");
    await expect.poll(() => button(page, "agent-undo")).toBe(UNDO(4));
    await turnEnded(page, sent);
  });

  /** The chips that are read and wait above the box, by their titles. */
  const chips = () =>
    ada.eval<string[]>(`[...document.querySelectorAll(".agent-attachments .file-chip:not(.reading)")].map((c) => c.title)`);
  const drag = (type: string, ...names: string[]) =>
    ada.eval(
      `document.getElementById("agent-log").dispatchEvent(new DragEvent(${JSON.stringify(type)}, { dataTransfer: __dt(...${JSON.stringify(names)}), bubbles: true, cancelable: true }))`
    );
  const lit = () => ada.eval<boolean>(`document.getElementById("agent").classList.contains("agent-drop")`);

  test("files dragged over the panel light it up; a dropped CSV waits as a chip; a PDF and a too-big file are refused, each a problem with why and a way on", async () => {
    // Files made in the tab: __dt(...names) holds them, as a drop, a paste or the file picker gives them.
    await ada.eval(`(async () => {
      const pic = async (w, h, colour) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = colour; g.fillRect(0, 0, w, h); g.fillStyle = "#fff"; g.font = "bold " + (h / 4) + "px sans-serif"; g.fillText("Hi", w / 8, h / 2); return new Promise((r) => c.toBlob(r, "image/png")); };
      window.__files = {
        shot: new File([await pic(1200, 800, "#3a6ff0")], "image.png", { type: "image/png" }),
        big: new File([await pic(3000, 2000, "#e0623a")], "wide.png", { type: "image/png" }),
        csv: new File(["city,people\\nOslo,709000\\nBergen,291000\\n"], "data.csv", { type: "text/csv" }),
        pdf: new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }),
        huge: new File(["x".repeat(300 * 1024)], "huge.json", { type: "application/json" }),
      };
      window.__dt = (...names) => { const dt = new DataTransfer(); for (const n of names) dt.items.add(window.__files[n]); return dt; };
      return true;
    })()`);
    await drag("dragenter", "csv");
    // (Chrome can send a dragleave as the pointer moves between the panel's parts: the drag goes on.)
    await drag("dragleave", "csv");
    await drag("dragover", "csv");
    expect(await lit()).toBe(true);
    // No more dragover (the files went elsewhere, with no dragleave here): the light goes out by itself.
    await expect.poll(lit).toBe(false);

    await drag("dragenter", "csv");
    await drag("drop", "csv", "pdf", "huge");
    await expect.poll(chips).toEqual(["data.csv (38 B)"]);
    expect(await lit()).toBe(false);
    // In the editor, each file that a message can't take is a problem in the card: why, and the way to give it to the
    // agent all the same, in the document's files (the journey of dropped files adds one: e2e/editor/steady.e2e.ts).
    const WAYS = ["Add it to the document for the agent", "Remove"];
    await expect
      .poll(async () => (await ada.alerts()).alerts.map((a) => [a.title, a.detail, a.buttons]))
      .toEqual([
        ["“huge.json” is not attached", "Agent · it is too large for a message.", WAYS],
        ["“report.pdf” is not attached", "Agent · a message takes images and text files only.", WAYS],
      ]);
    // Remove: the file is let go, and its problem with it.
    await ada.page.click('#alerts [data-action="remove"]');
    await ada.page.click('#alerts [data-action="remove"]');
    await expect.poll(async () => (await ada.alerts()).view).toBe("none");
  });

  const paste = (...names: string[]) =>
    ada.eval(
      `document.getElementById("agent-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: __dt(...${JSON.stringify(names)}), bubbles: true, cancelable: true }))`
    );
  /** A message that was sent, found by the start of its text: its attachments (a picture as whether it shows one, a file by its title). */
  const sentFiles = (starts: string) =>
    ada.eval<string[]>(
      `(() => { const m = [...document.querySelectorAll("#agent-log .msg-user")].find((m) => (m.firstChild?.textContent ?? "").startsWith(${JSON.stringify(starts)})); return [...m?.querySelectorAll(".file-chip") ?? []].map((c) => c.classList.contains("image") ? "img:" + !!c.querySelector("img")?.src.startsWith("data:image/") : c.title); })()`
    );
  const SENT = ["img:true", "data.csv (38 B)", "img:true"];

  test("the paperclip attaches a picked picture; its × takes it out; Send takes the files: the model gets pictures as images and a CSV as text", async () => {
    const pick = (...names: string[]) =>
      ada.eval(
        `(() => { const i = document.querySelector("#agent-form input[type=file]"); i.files = __dt(...${JSON.stringify(names)}).files; i.dispatchEvent(new Event("change")); return true; })()`
      );
    const out = () => ada.eval(`document.querySelector(".agent-attachments .file-chip button").click()`);
    expect(await ada.eval<string | null>(`document.querySelector("#agent-form > .agent-attach")?.getAttribute("aria-label")`)).toBe(
      "Attach files"
    );
    await pick("big");
    await expect.poll(chips).toHaveLength(2);
    expect((await chips())[1]).toMatch(/^wide\.png/);
    await out();
    await out();
    await expect.poll(chips).toEqual([]);

    // A pasted screenshot waits as a thumbnail, and Send is on with no text.
    await paste("shot");
    await expect.poll(chips).toHaveLength(1);
    expect((await chips())[0]).toMatch(/^Pasted image\.png/);
    expect(await ada.eval<boolean>(`!!document.querySelector(".agent-attachments .file-chip.image img[src^='data:image/jpeg']")`)).toBe(
      true
    );
    await expect.poll(() => ada.eval<string>(`document.getElementById("agent-send").getAttribute("aria-disabled")`)).toBe("false");

    // With a dropped CSV and a big picked picture: the model gets the two pictures as images, and the CSV as text.
    await drag("drop", "csv");
    await expect.poll(chips).toHaveLength(2);
    await pick("big");
    await expect.poll(chips).toHaveLength(3);
    const before = (await answers(page)).length;
    await say(page, script("What do these show?", [{ inputs: true }]));
    expect(await chips()).toEqual([]);
    expect(await ada.eval<boolean>(`document.querySelector(".agent-attachments").hidden`)).toBe(true);
    await turnEnded(page, before);
    expect(JSON.parse((await answers(page)).at(-1)!)).toEqual({ images: ["image/png", "image/png"], files: ["data.csv"] });
    expect(await sentFiles("What do these show?")).toEqual(SENT);
    // The transcript keeps small thumbnails. (The thread is the person's, kept by their agent: agents/person/sessions.ts.)
    const doc = await ada.eval<string>(`document.querySelector('meta[name="erga-doc"]').content`);
    const kept = (await (await fetch(`${s.root}/api/agent/conversation?doc=${doc}&user=${ADA}`)).json()) as {
      log: { items: { kind: string; files?: { thumb?: string }[] }[] };
    };
    const item = kept.log.items.find((i) => i.kind == "user" && i.files);
    expect(item?.files?.filter((f) => f.thumb).map((f) => f.thumb!.length < 60_000)).toEqual([true, true]);
  });

  test("an image sent to the agent is kept: the agent adds it to a document's files by its blob, as it was sent", async () => {
    await paste("shot");
    await expect.poll(chips).toHaveLength(1);
    // (Small enough to go as it is: the blob is the file's own sha-256.)
    const hash = await ada.eval<string>(
      `__files.shot.arrayBuffer().then((b) => crypto.subtle.digest("SHA-256", b)).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""))`
    );
    // (The fixture is a folder on disk, which takes only text: the picture goes into a document that Erga keeps.)
    const made = await runTool<{ address: string }>(s.root, "create_document", { title: "Pictures" }, { user: ADA });
    const address = made.result!.address;
    await say(
      page,
      script("Add it", [
        { tool: "edit", args: { op: "write", document: address, files: { "images/shot.png": { blob: hash } } } },
        { text: "Added." },
      ])
    );
    await answered(page, "Added.");
    expect(await chips()).toEqual([]);
    const size = await ada.eval<number>(`__files.shot.size`);
    const ls = await runTool<{ entries: { path: string; size?: number; mime?: string }[] }>(
      s.root,
      "ls",
      { document: address },
      { user: ADA }
    );
    expect(ls.result!.entries.find((e) => e.path == "images/shot.png")).toMatchObject({ size, mime: "image/png" });
  });

  test("a message that can't be sent says so, and can be tried again", async () => {
    // The host refuses the agent's endpoint for a moment, with an error that isn't a redeploy's (a message waits through that).
    await ada.eval(
      `window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).includes("/api/agent?") && o?.method == "POST" ? Promise.resolve(new Response(JSON.stringify({ reason: "the host is down" }), { status: 500 })) : window.__realFetch(u, o)`
    );
    const sent = (await answers(page)).length;
    await say(page, "hello there");
    const failed = page.locator("#agent-log .msg-user.failed");
    await expect.poll(() => failed.locator(".send-failed button").count()).toBe(1);
    expect(await failed.textContent()).toMatch(/Not sent/);
    await ada.eval(`window.fetch = window.__realFetch`);
    await failed.locator(".send-failed button").click();
    await until(
      () =>
        ada.eval<boolean>(
          `[...document.querySelectorAll("#agent-log .msg-user")].some((e) => e.textContent == "hello there" && !e.classList.contains("pending") && !e.classList.contains("failed"))`
        ),
      5000,
      "trying again sends it"
    );
    expect(await failed.count()).toBe(0);
    // The agent answers it: the turn ends before the next step sends a message.
    await turnEnded(page, sent);
  });

  test("a message sent shows the agent at work at once, before the server has it", async () => {
    const before = (await answers(page)).length;
    // The message to the agent waits on its way to the server.
    let held = 0,
      release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const API = /\/api\/agent(\?.*)?$/;
    await page.route(API, async (r) => {
      if (r.request().method() == "POST") {
        held++;
        await gate;
      }
      await r.continue();
    });
    await say(page, script("Hello", [{ text: "Hi." }]));
    await expect.poll(() => page.evaluate(() => document.getElementById("agent-fab")!.classList.contains("busy"))).toBe(true);
    await expect.poll(() => held).toBeGreaterThan(0);
    expect(await page.locator("#agent-log .msg-user.pending").count()).toBe(1);
    // The server gets it: the answer comes.
    release();
    await turnEnded(page, before);
    expect((await answers(page)).slice(before)).toEqual(["Hi."]);
    await page.unroute(API);
  });

  test("a new render of the page (its stylesheet changed) leaves the focus in the agent's box", async () => {
    await page.focus("#agent-input");
    const css = join(ada.dir, "style.css");
    writeFileSync(css, `${readFileSync(css, "utf8")}\nh1 { color: rgb(1, 2, 3); }\n`);
    await expect.poll(() => ada.frame<string>(`getComputedStyle(${F}.querySelector("h1")).color`)).toBe("rgb(1, 2, 3)");
    await ada.settle();
    expect(await ada.eval<string>(`document.activeElement.id`)).toBe("agent-input");
  });

  // The bug: after a mouse click on Collapse, the agent's circle showed hints of a blue focus ring.
  test("collapsing the agent with the mouse leaves no ring or selection on its circle; Tab still shows a ring", async () => {
    const ring = `(() => {
      const fab = document.getElementById("agent-fab"), s = getComputedStyle(fab), sel = getSelection();
      return {
        focused: document.activeElement == fab,
        outline: s.outlineStyle != "none" && parseFloat(s.outlineWidth) > 0,
        boxShadow: s.boxShadow != "none",
        selected: !!sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.containsNode(fab, true),
      };
    })()`;
    await ada.openAgent();
    await expect.poll(() => paneOpen(page)).toBe(true);
    // A real mouse click, once the panel stands still.
    await page.locator("#agent-close").click();
    await expect.poll(() => ada.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(false);
    // The circle again, the "e" in it.
    await expect.poll(() => ada.eval<string>(`getComputedStyle(document.getElementById("agent-fab")).opacity`)).toBe("1");
    expect(await ada.eval<Record<string, boolean>>(ring)).toEqual({ focused: true, outline: false, boxShadow: false, selected: false });
    // From the keyboard, the ring shows.
    await ada.press("Shift+Tab");
    await ada.press("Tab");
    expect(await ada.eval<Record<string, boolean>>(ring)).toMatchObject({ focused: true, outline: true });
  });

  test("an open pane is open after a reload from the first frame, with its unsent message; a collapsed pane and a cleared box stay so", async () => {
    // (The pane is collapsed, and the box is empty.)
    expect(await input()).toBe("");
    await ada.press("ControlOrMeta+j");
    await expect.poll(() => paneOpen(page)).toBe(true);
    await page.focus("#agent-input");
    await ada.type("half a thought");
    // Checked as soon as the new page's script has run.
    await ada.eval(`window.__beforeReload = true; location.reload()`);
    await expect.poll(() => ada.eval<boolean>(`!window.__beforeReload && !!window.ergaPage`).catch(() => false)).toBe(true);
    expect(await paneOpen(page)).toBe(true);
    await ada.loaded();
    expect(await input()).toBe("half a thought");
    // The messages sent before show their files as they did.
    await expect.poll(() => sentFiles("What do these show?")).toEqual(SENT);
    // Of the calls of the turns before, the conversation read again shows only the picture.
    expect(await calls(page)).toEqual(["Looked at the page [picture]"]);

    // Collapsed, and the box cleared: both stay so after the next reload.
    await ada.press("ControlOrMeta+j");
    await expect.poll(() => paneOpen(page)).toBe(false);
    await ada.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.reload();
    await ada.loaded();
    expect(await paneOpen(page)).toBe(false);
    expect(await ada.eval<string>(`document.getElementById("agent-fab").getAttribute("aria-expanded")`)).toBe("false");
    expect(await input()).toBe("");
  });
});

/** Open or closed, as each frame of a page showed the panel from the first one with it: each change, in order. */
const PANEL_FRAMES = `(() => {
  if (window.top != window) return;
  const seen = (window.__panelFrames = []);
  const look = () => {
    const a = document.getElementById("agent");
    const open = document.body?.classList.contains("agent-open");
    if (a && !a.hidden && seen[seen.length - 1] !== open) seen.push(open);
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
})()`;

/** At each page's first frame that shows the panel open: what its log shows, before the agent's own script loads the conversation. */
const FIRST_PAINT = `(() => {
  if (window.top != window) return;
  const look = () => {
    const l = document.getElementById("agent-log");
    if (!l || l.closest("#agent").hidden || !document.body.classList.contains("agent-open")) return requestAnimationFrame(look);
    window.__firstPaint = { n: l.children.length, top: l.scrollTop, model: document.getElementById("agent-model").textContent };
    // For a failure's message: whether the panel's own script had run by then, and whether the tab had a copy to draw.
    window.__firstPaintFacts = { script: !!window.ergaAgent, copy: (sessionStorage.getItem("erga:agent-panel") || "").length };
    window.__firstItem = l.firstElementChild;
  };
  requestAnimationFrame(look);
})()`;

journey("the agent on the documents' list", () => {
  let page: Page;
  /** (Not read where the runner only lists the steps: there is no server there.) */
  const docs = () => `${s.root}/documents?user=${LISA}`;
  let address = "";
  /** Whether Lisa still has the document. */
  const has = async () => (await runTool(s.root, "ls", { document: address }, { user: LISA })).ok;
  const question = () => page.locator("#agent-log .msg-tool.asking");
  const erase = (after: string, more: object = {}) =>
    script("Delete it", [{ tool: "documents", args: { op: "delete_document", document: address, ...more } }, { text: after }]);
  /** The call on the card: its lines, as the person reads them. */
  const call = () => question().locator(".call").innerText();
  let reads = 0;

  test("with the panel closed, the page reads the conversation one time", async ({ tab }) => {
    page = tab.page;
    tab.strict = true;
    let socket = false;
    page.on("websocket", (ws) => {
      if (/\/api\/agent\/events/.test(ws.url())) socket = true;
    });
    page.on("request", (r) => {
      if (r.url().includes("/api/agent/conversation")) reads++;
    });
    await agentClosed(page);
    await page.addInitScript(FIRST_PAINT);
    // The window's error events of this kind (Chromium keeps them from the page's errors; WebKit reports them).
    await page.addInitScript(() =>
      addEventListener("error", (e) => {
        const w = window as unknown as { loops?: number };
        if (String((e as ErrorEvent).message).startsWith("ResizeObserver loop")) w.loops = (w.loops ?? 0) + 1;
      })
    );
    await page.goto(docs());
    await until(
      () => page.evaluate(() => document.getElementById("agent-model")!.textContent == "script (test model)"),
      10_000,
      "the agent is on"
    );
    // Its socket is open, and nothing more is on its way.
    await until(() => socket, 10_000, "the agent's socket");
    await page.waitForLoadState("networkidle");
    expect(reads).toBe(1);
  });

  test("the agent's delete waits for Approve: Deny leaves the document, Approve deletes it, after a reload too", async () => {
    address = (await runTool<{ address: string }>(s.root, "create_document", { title: "Keep me" }, { user: LISA })).result!.address;
    await page.click("#agent-fab");
    await agentOn(page);
    // The panel's box takes its size with no error: no observer's call there changes a size that an observer watches.
    await settle(page);
    expect(await page.evaluate(() => (window as unknown as { loops?: number }).loops ?? 0)).toBe(0);

    // The card shows the sentence and the call itself, whole: a long argument is cut, and opens on a click. It is the
    // model's text: none of it is markup.
    const why = `<b>${"x".repeat(200)}</b> end`;
    await say(page, erase("Left alone.", { why }));
    await expect.poll(() => question().count(), { timeout: 10_000 }).toBe(1);
    expect(await question().locator(".detail").textContent()).toBe(`Delete ${address} for good`);
    expect(await call()).toBe(`documents delete_document\ndocument: ${address}\nwhy: ${why.slice(0, 160)}… Show all 211 characters`);
    await question().getByText("Show all 211 characters").click();
    expect(await call()).toBe(`documents delete_document\ndocument: ${address}\nwhy: Show less\n${why}`);
    // The run stopped at the call: nothing ran, and the panel does not say that the agent works.
    await expect.poll(() => page.locator("#agent-fab.busy").count()).toBe(0);
    expect(await has()).toBe(true);
    await question().getByRole("button", { name: "Deny" }).click();
    await answered(page, "Left alone.");
    expect(await page.locator("#agent-log .msg-tool.error .detail").textContent()).toBe("Not approved.");
    expect(await has()).toBe(true);

    await say(page, erase("Deleted."));
    await expect.poll(() => question().count(), { timeout: 10_000 }).toBe(1);
    // The question is there after a reload too, and its button still works.
    await page.goto(`${docs()}&again`);
    await expect.poll(() => question().count(), { timeout: 10_000 }).toBe(1);
    await question().getByRole("button", { name: "Approve" }).click();
    await answered(page, "Deleted.");
    expect(await question().count()).toBe(0);
    expect(await has()).toBe(false);
  });

  test("a message longer than the server keeps shows one time, not dimmed, when the agent has it", async () => {
    const [sent, got] = [await page.locator("#agent-log .msg-user").count(), (await answers(page)).length];
    await say(page, "x".repeat(20_001));
    await turnEnded(page, got);
    await expect.poll(() => page.locator("#agent-log .msg-user").count()).toBe(sent + 1);
    expect(await page.locator("#agent-log .msg-user.pending").count()).toBe(0);
  });

  test("at the day's token limit the agent stops and says why; under it, it answers", async () => {
    expect((await runTool(s.root, "set_setting", { key: "agent_daily_tokens", value: 4000 })).ok).toBe(true);
    try {
      await say(page, script("One", [{ text: "First.", tokens: 5000 }]));
      await answered(page, "First.");
      const got = (await answers(page)).length;
      await say(page, script("Two", [{ text: "Second." }]));
      await expect
        .poll(
          () =>
            page
              .locator("#agent-log .msg-error")
              .last()
              .textContent()
              .catch(() => ""),
          { timeout: 10_000 }
        )
        .toBe(
          "Your agent used 5,000 tokens on the server's keys today, and the limit for one day is 4,000. It works again after midnight UTC, or now with your own API key (Settings, Agent)."
        );
      expect((await answers(page)).length).toBe(got);
      await expect.poll(() => page.locator("#agent-fab.busy").count()).toBe(0);
    } finally {
      await runTool(s.root, "set_setting", { key: "agent_daily_tokens", reset: true });
    }
  });

  // Was: one conversation on every page ("when i'm in one document and talking to the assistant, and then I open
  // another document, ... I get a new agent thread, not a continuation of the previous one").
  test("each document has a thread of its own, and the list has one: a turn that runs as the person leaves answers in its own thread", async () => {
    const [a, b] = [await s.fixture("empty"), await s.fixture("empty")];
    const listed = await page.locator("#agent-log > *").count();
    const shown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#agent-log .msg-user, #agent-log .msg-assistant")].map((e) => e.textContent ?? "")
      );
    /** The page is open, and its panel has read its thread. */
    const open = async (address: string) => {
      await page.goto(address);
      await agentOn(page);
    };
    const [inA, slow] = [script("In A", [{ text: "Answer in A." }]), script("Slow, in A", [{ text: "Late answer in A.", delay: 700 }])];

    // Document A: nothing of the list's conversation.
    await open(`${a.address}?user=${LISA}`);
    expect(await shown()).toEqual([]);
    await say(page, inA);
    await answered(page, "Answer in A.");
    // A turn that is slow; the server has its message, and the person opens document B.
    await say(page, slow);
    await until(
      () => page.evaluate(() => document.querySelectorAll("#agent-log .msg-user:not(.pending)").length == 2),
      5000,
      "the server has the message"
    );
    const kept = `${s.root}/api/agent/conversation?doc=${await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="erga-doc"]')!.content)}&user=${LISA}`;
    await open(`${b.address}?user=${LISA}`);
    expect(await shown()).toEqual([]);
    // The turn ends in A's thread. B's panel shows nothing of it, and does not say that the agent works.
    await until(
      async () => ((await (await fetch(kept)).json()) as { log: { busy: boolean } }).log.busy == false,
      10_000,
      "the turn in A's thread ends"
    );
    await settle(page);
    expect(await shown()).toEqual([]);
    expect(await page.locator("#agent-fab.busy").count()).toBe(0);

    // Back in A: its thread, with the answer that came while the person was away. The list: its own.
    await open(`${a.address}?user=${LISA}`);
    expect(await shown()).toEqual([inA, "Answer in A.", slow, "Late answer in A."]);
    await open(docs());
    expect(await page.locator("#agent-log > *").count()).toBe(listed);
  });

  // Was: one value for every page ("whether the agent is expanded or collapsed should be remembered on a document by
  // document basis and also for the whole of the UI that is not a document e.g. the admin pages").
  test("the panel is open or closed as the person left it on each document, and as one on the pages outside a document, from the first frame", async () => {
    const [a, b] = [await s.fixture("empty"), await s.fixture("empty")];
    /** The page is open: the panel as each frame showed it since its first (one value: it never changed in view). */
    const at = async (address: string) => {
      await page.goto(address);
      await until(() => page.evaluate(() => (window as any).__panelFrames.length > 0), 5000, "the page shows the panel");
      await settle(page);
      return page.evaluate(() => (window as any).__panelFrames as boolean[]);
    };
    const toggle = async (key: string, to: boolean) => {
      await page.keyboard.press(key);
      await until(
        () => page.evaluate((to) => document.body.classList.contains("agent-open") == to, to),
        5000,
        `${key} ${to ? "opens" : "closes"} the panel`
      );
    };
    await page.addInitScript(PANEL_FRAMES);

    // Closed on the list. A document that the person never opened or closed it on takes that.
    await toggle("ControlOrMeta+j", false);
    // Opened on document A; opened on document B, and closed there with Esc, from its box.
    expect(await at(`${a.address}?user=${LISA}`), "a new document, as the list").toEqual([false]);
    await toggle("ControlOrMeta+j", true);
    expect(await at(`${b.address}?user=${LISA}`)).toEqual([false]);
    await toggle("ControlOrMeta+j", true);
    await until(() => page.evaluate(() => document.activeElement?.id == "agent-input"), 5000, "the agent's box has the keys");
    await toggle("Escape", false);
    // Opened on an admin page (the admin's: this browser keeps it, not the person).
    expect(await at(`${s.root}/admin/changes`), "an admin page, as the list").toEqual([false]);
    await toggle("ControlOrMeta+j", true);

    // Each as it was left: A open, B closed, another admin page and the list open.
    expect(await at(`${a.address}?user=${LISA}`), "document A").toEqual([true]);
    expect(await at(`${b.address}?user=${LISA}`), "document B").toEqual([false]);
    expect(await at(`${s.root}/admin/ops`), "another admin page").toEqual([true]);
    expect(await at(docs()), "the list").toEqual([true]);
    await agentOn(page);
  });

  // The bug: the panel loaded its conversation again, in view, at each page ("the agent shouldn't refresh its contents
  // visible every time i navigate from one page to the next").
  test("the panel shows the same conversation and scroll place from the next page of its thread's first paint; another person's panel starts empty", async () => {
    const log = () =>
      page.evaluate(() => {
        const l = document.getElementById("agent-log")!;
        return {
          n: l.children.length,
          top: l.scrollTop,
          max: l.scrollHeight - l.clientHeight,
          same: l.firstElementChild == (window as any).__firstItem,
        };
      });
    await settle(page);
    // Read back a little: the next page keeps that place too.
    const box = (await page.locator("#agent-log").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await until(
      async () => {
        const l = await log();
        return l.max - l.top > 200;
      },
      2000,
      "the wheel scrolls the log up",
      log
    );
    await settle(page);
    const before = await log();
    expect(before.n).toBeGreaterThan(6);

    // Each page reads the conversation as it starts, and again once its socket opens.
    for (const to of [`${s.root}/documents/archived?user=${LISA}`, docs()]) {
      reads = 0;
      await page.goto(to);
      await until(() => page.evaluate(() => !!(window as any).__firstPaint), 5000, "the next page paints");
      const first = await page.evaluate(() => (window as any).__firstPaint);
      expect(
        first,
        `${to}: the panel at the first paint ${JSON.stringify(await page.evaluate(() => (window as any).__firstPaintFacts))}`
      ).toEqual({
        n: before.n,
        top: before.top,
        model: "script (test model)",
      });
      // The page's agent loads the conversation (and its socket reads it again): nothing changes that a person sees.
      await until(() => reads >= 2, 5000, "the page and its socket read the conversation");
      await page.waitForLoadState("networkidle");
      await settle(page);
      // (The panel's height may differ by a few pixels from page to page: only its place counts.)
      const { max: _, ...now } = await log();
      expect(now, `${to}: the panel once loaded`).toEqual({ n: before.n, top: before.top, same: true });
    }

    // Another person in this tab (local development's ?user=) never sees the copy: their panel starts empty.
    expect(await page.evaluate(() => sessionStorage.getItem("erga:agent-panel")), "Lisa's copy").toContain("Left alone.");
    await page.goto(`${s.root}/documents?user=${OTHER}`);
    await until(() => page.evaluate(() => !!(window as any).__firstPaint), 5000, "the other person's page paints");
    expect(await page.evaluate(() => (window as any).__firstPaint.n), "the other person's panel at the first paint").toBe(0);

    // Sign-out deletes the tab's copy (the other person's now, kept as that page went).
    // (The mark goes with the page that the tab leaves: until then, that page is the one that answers.)
    await page.evaluate(() => {
      (window as any).__signedIn = true;
      location.assign("/auth/logout");
    });
    await until(
      () =>
        page
          .evaluate(() => !(window as any).__signedIn && !document.title.startsWith("Signing out") && document.readyState == "complete")
          .catch(() => false),
      10_000,
      "signed out"
    );
    expect(await page.evaluate(() => sessionStorage.getItem("erga:agent-panel")), "the panel's copy after sign-out").toBeNull();
  });
});

test("with no key, the panel says the agent is off and why, Send carries the same reason, and sending still explains", async ({ tab }) => {
  const ed = await openEditor(tab, off, "page");
  await ed.openAgent();
  const state = () =>
    ed.eval<{ hint: string; hidden: boolean; disabled: string | null; title: string }>(
      `(() => { const h = document.getElementById("agent-hint"), b = document.getElementById("agent-send"); return { hint: h.innerText, hidden: h.hidden, disabled: b.getAttribute("aria-disabled"), title: b.title }; })()`
    );
  await expect.poll(async () => (await state()).hidden).toBe(false);
  let st = await state();
  expect(st.hint).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
  expect(st.disabled).toBe("true");
  expect(st.title).toMatch(/agent is off.*ANTHROPIC_API_KEY/);
  await ed.type("hello");
  await ed.press("Enter");
  await ed.settle();
  st = await state();
  expect(st.hidden).toBe(false);
  expect(st.hint).toBe("To enable the agent, add an LLM provider key. Or connect your own agent.");
  expect(await ed.eval<string>(`document.getElementById("agent-input").value`)).toBe("hello");
});
