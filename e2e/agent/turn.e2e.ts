// The person's agent in its panel. In the editor: a turn's edits show, to the other people too; the turn's line, See
// changes, Undo and Redo; files attached; a message that fails or waits; voice; the pane across a reload. On the
// documents' list: the agent's delete waits for Approve; the day's token limit; the panel from page to page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, journey, servers, settle, test, until, type Page } from "../helpers/fixtures";
import { editor, F, openEditor, type Editor } from "../helpers/editor";
import { runTool } from "../helpers/tools";
import { agentOn, answered, answers, button, edit, paneOpen, say, script, turnEnded, turnLine } from "./panel";

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
    // A stand-in for the browser's speech recognition (the voice button shows only where there is one): each session in __recs.
    await page.addInitScript(() => {
      const w = window as any;
      if (w.top != w) return;
      w.__recs = [];
      w.SpeechRecognition = class extends EventTarget {
        running = false;
        onend?: () => void;
        start() {
          this.running = true;
          w.__recs.push(this);
        }
        stop() {
          this.abort();
        }
        abort() {
          if (!this.running) return;
          this.running = false;
          setTimeout(() => this.onend?.());
        }
      };
      w.__hear = (...rs: [string, boolean][]) =>
        w.__recs.at(-1).onresult({ results: rs.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
      // While __holdFiles is set, a text file is read only when the step says so (__read()): until then its chip says "Reading…".
      const text = File.prototype.text;
      let held: (() => void)[] = [];
      File.prototype.text = function () {
        return w.__holdFiles ? new Promise<void>((r) => held.push(r)).then(() => text.call(this)) : text.call(this);
      };
      w.__read = () => {
        for (const r of held) r();
        held = [];
      };
    });
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
    await other.addInitScript(() => {
      if (window.top == window) localStorage.setItem("erga:settings:v1", '{"agent":false}');
    });
    await other.goto(`${ada.address}?user=${BO}&edit`);
    const bo = editor(other, { address: ada.address, dir: ada.dir, file: ada.file });
    await bo.loaded();
    await page.bringToFront();

    // One turn: an edit, and a look at the page (the server's browser renders it).
    await say(
      page,
      script("Check it", [
        edit("Typing never waits.", "Typing never waits, by agent."),
        { tool: "page", args: { op: "view_page", selector: "h1" } },
        { text: "Looked." },
      ])
    );
    await answered(page, "Looked.", 13_000);
    const looked = await ada.eval<string[]>(
      `[...document.querySelectorAll("#agent-log .msg-tool")].map((e) => e.textContent + (e.querySelector("img.shot")?.naturalWidth > 0 ? " [picture]" : ""))`
    );
    expect(
      looked.some((t) => /Looked at the page.*\[picture\]/.test(t)),
      `view_page answers a picture of the page: ${looked.join(" | ")}`
    ).toBe(true);
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

  test("files dragged over the panel light it up; a dropped CSV waits as a chip; a PDF and a too-big file are refused, with why", async () => {
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
    const hint = await ada.eval<string>(
      `document.getElementById("agent-hint").hidden ? "" : document.getElementById("agent-hint").textContent`
    );
    expect(hint).toContain("“report.pdf” can't be attached: only images");
    expect(hint).toContain("“huge.json” is too big (300 KB): text files can be up to 256 KB");
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
    // The transcript keeps small thumbnails. (The conversation is the person's, kept by their agent: agents/person/sessions.ts.)
    const kept = (await (await fetch(`${s.root}/api/agent/conversation?user=${ADA}`)).json()) as {
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

  test("voice mode: words show as heard and each pause sends them; they wait for a file that is still read; leaving keeps the unsent words; collapsing stops listening", async () => {
    // Messages to the agent are caught here (__sent, with their files in __sentFiles), not sent.
    await ada.eval(
      `window.__sent = []; window.__sentFiles = []; window.__realFetch = window.fetch; window.fetch = (u, o) => { if (!(String(u).split("?")[0].endsWith("/api/agent") && o?.method == "POST")) return window.__realFetch(u, o); const m = JSON.parse(String(o.body)); __sent.push(m.text); __sentFiles.push(m.files.map((f) => f.name)); return Promise.resolve(new Response("{}")); }`
    );
    type Voice = { on: string | null; input: string; readOnly: boolean; send: string | null; title: string; sent: string[]; recs: number };
    // `before` runs in the same evaluation as the read: the pause timer is a tenth of real time here, shorter than a round trip on a busy machine.
    const st = (before = "") =>
      ada.eval<Voice>(
        `(() => { ${before}; const v = document.getElementById("agent-voice"), i = document.getElementById("agent-input"), b = document.getElementById("agent-send"); return { on: v.getAttribute("aria-pressed"), input: i.value, readOnly: i.readOnly, send: b.getAttribute("aria-disabled"), title: b.title, sent: [...__sent], recs: __recs.length }; })()`
      );
    const BLUE = `["make the title blue", true]`;
    expect(await ada.eval<boolean>(`!document.getElementById("agent-voice").hidden`)).toBe(true);
    await page.click("#agent-voice");
    let v = await st();
    expect(v).toMatchObject({ on: "true", recs: 1, readOnly: true, send: "true" });
    expect(v.title).toMatch(/Voice mode/);
    v = await st(`__hear(["make the title", false])`);
    expect(v).toMatchObject({ input: "make the title", sent: [] });
    // From here the pause that sends the words is a tenth of its time (the tests' timescale), so the step does not wait for it.
    // The panel's pause takes the timescale (it read another name before, so the pause was a whole second in the tests):
    // the timer that it sets is for a tenth of its second. Read from the timers set, so the check costs no time.
    await ada.eval(
      `window.__ergaTimescale = 0.1; window.__timers = []; window.__setTimeout = window.setTimeout; window.setTimeout = (f, ms, ...a) => (window.__timers.push(ms), window.__setTimeout(f, ms, ...a)); __hear(${BLUE})`
    );
    await expect.poll(async () => (await st()).sent.length).toBe(1);
    expect(await st()).toMatchObject({ sent: ["make the title blue"], input: "" });
    const timers = await ada.eval<number[]>(`(window.setTimeout = window.__setTimeout, window.__timers)`);
    expect([timers.includes(100), timers.includes(1000)], `the pause's timer, of ${timers.join(" ")}`).toEqual([true, false]);

    // The next words show alone. A pause sends them too, though they are not final yet; then a new session takes over.
    v = await st(`__hear(${BLUE}, [" and bigger", false])`);
    expect(v.input).toBe("and bigger");
    await expect.poll(async () => (await st()).sent).toEqual(["make the title blue", "and bigger"]);
    await expect.poll(async () => (await st()).recs).toBe(2);

    // A pause while an attached file is still read keeps the words: they go with the file once it is read.
    await ada.eval(
      `(() => { window.__holdFiles = true; const dt = new DataTransfer(); dt.items.add(new File(["a,b\\n1,2\\n"], "notes.csv", { type: "text/csv" })); document.getElementById("agent-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); })()`
    );
    await expect.poll(() => ada.eval<number>(`document.querySelectorAll(".agent-attachments .file-chip.reading").length`)).toBe(1);
    await ada.eval(`__hear(["what does this show", true])`);
    await expect.poll(() => ada.eval<string>(`document.getElementById("agent-hint").textContent`)).toMatch(/Reading the attached files/);
    expect(await st()).toMatchObject({ sent: ["make the title blue", "and bigger"], input: "what does this show" });
    await ada.eval(`window.__holdFiles = false; __read()`);
    await expect.poll(async () => (await st()).sent).toEqual(["make the title blue", "and bigger", "what does this show"]);
    expect(await ada.eval<string[][]>(`__sentFiles`)).toEqual([[], [], ["notes.csv"]]);

    // Leaving voice mode keeps what wasn't sent in the box, to edit.
    v = await st(`__hear(["what does this show", true], [" thanks", true]); document.getElementById("agent-voice").click()`);
    expect(v).toMatchObject({ on: "false", input: "thanks", readOnly: false });
    expect(v.sent).toHaveLength(3);
    // Collapsing the panel stops listening.
    await page.click("#agent-voice");
    await ada.press("ControlOrMeta+j");
    await expect.poll(async () => (await st()).on).toBe("false");
    expect(await ada.eval<boolean>(`!__recs.at(-1).running`)).toBe(true);
    expect(await paneOpen(page)).toBe(false);
    await ada.eval(`window.fetch = window.__realFetch`);
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
    // (The pane is collapsed. The box has "thanks", the words that voice mode left.)
    expect(await input()).toBe("thanks");
    await ada.press("ControlOrMeta+j");
    await expect.poll(() => paneOpen(page)).toBe(true);
    await page.focus("#agent-input");
    await ada.type(" for half a thought");
    // Checked as soon as the new page's script has run.
    await ada.eval(`window.__beforeReload = true; location.reload()`);
    await expect.poll(() => ada.eval<boolean>(`!window.__beforeReload && !!window.ergaPage`).catch(() => false)).toBe(true);
    expect(await paneOpen(page)).toBe(true);
    await ada.loaded();
    expect(await input()).toBe("thanks for half a thought");
    // The messages sent before show their files as they did.
    await expect.poll(() => sentFiles("What do these show?")).toEqual(SENT);

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
  const docs = () => `${s.root}/docs?user=${LISA}`;
  let address = "";
  /** Whether Lisa still has the document. */
  const has = async () => (await runTool(s.root, "ls", { document: address }, { user: LISA })).ok;
  const question = () => page.locator("#agent-log .msg-tool.asking");
  const erase = (after: string) =>
    script("Delete it", [{ tool: "documents", args: { op: "delete_document", document: address } }, { text: after }]);
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
    // Someone who keeps the panel closed: set one time, in the tab itself, so the tab can open it after.
    await page.addInitScript(() => {
      if (window.top != window || sessionStorage.getItem("erga-test:agent-seeded")) return;
      sessionStorage.setItem("erga-test:agent-seeded", "1");
      localStorage.setItem("erga:settings:v1", '{"agent":false}');
    });
    await page.addInitScript(FIRST_PAINT);
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

    await say(page, erase("Left alone."));
    await expect.poll(() => question().count(), { timeout: 10_000 }).toBe(1);
    expect(await question().locator(".detail").textContent()).toBe(`Delete the document ${address} for good`);
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

  // The bug: the panel loaded its conversation again, in view, at each page ("the agent shouldn't refresh its contents
  // visible every time i navigate from one page to the next").
  test("the panel shows the same conversation and scroll place from the next page's first paint; another person's panel starts empty", async () => {
    const a = await s.fixture("empty");
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
    for (const to of [`${a.address}?user=${LISA}`, docs()]) {
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
    await page.goto(`${s.root}/docs?user=${OTHER}`);
    await until(() => page.evaluate(() => !!(window as any).__firstPaint), 5000, "the other person's page paints");
    expect(await page.evaluate(() => (window as any).__firstPaint.n), "the other person's panel at the first paint").toBe(0);

    // Sign-out deletes the tab's copy (the other person's now, kept as that page went).
    await page.evaluate(() => location.assign("/auth/logout"));
    await until(
      () => page.evaluate(() => !document.title.startsWith("Signing out") && document.readyState == "complete").catch(() => false),
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
