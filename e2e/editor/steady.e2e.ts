// Keys are never lost, and the document is never corrupted: while the page renders again, with a browser extension's
// elements in the page, with parts that are the page's own, with edits on disk and an agent's edits, with dropped
// files, and with a broken page.
//
// Four journeys, each one page: a page with parts of its own (e2e/fixtures/steady), a deck that changes on disk
// and by an agent while the person types, a page that takes dropped files, and a broken page.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, journey, servers, test, until, type Tab } from "../helpers/fixtures";
import { DISK_MS, F, openEditor, type Editor } from "../helpers/editor";
import { runTool } from "../helpers/tools";
import {
  agentBox,
  agentPlays,
  CENTRED,
  clickBadge,
  newConversation,
  drag,
  drop,
  dropSign,
  folderOnDisk,
  images,
  IMG,
  lockNote,
  onDisk,
  openDropPage,
  pageStill,
  pasteFiles,
  pendingParts,
  png,
  UPLOAD,
} from "./steady-helpers";

const s = await servers.main();

journey("a page with parts of its own: keys go where the caret is", () => {
  let ed: Editor;

  // The page's own contenteditable box is text like any other. The editor did not save what a person typed in it.
  test("text typed in the page's own contenteditable box is still there after a reload", async ({ tab }) => {
    ed = await openEditor(tab, s, "steady"); // page load 1
    await ed.clickEnd("#own");
    await ed.type(" XY");
    await ed.source();
    await tab.page.reload(); // page load 2: the journey goes on in it
    await ed.loaded();
    expect(await ed.textOf("#own")).toBe("Own editable XY");
    await ed.settle();
  });

  // An extension (as Grammarly did) wraps some of a paragraph's text in its own <span>. The keys typed after it were lost.
  test("keys typed after an extension wraps a word in a <span> show in the paragraph", async () => {
    await ed.clickEnd("#last");
    await ed.type("12");
    await ed.frame(
      `(() => { const t = ${F}.getElementById("last").firstChild, r = ${F}.createRange(); r.setStart(t, 1); r.setEnd(t, 3); const s = ${F}.createElement("span"); s.className = "gr_ gr-alert"; r.surroundContents(s); return true; })()`
    );
    await ed.type("34");
    await until(
      async () => (await ed.textOf("#last")) == "Last paragraph.1234",
      3000,
      "the paragraph shows the keys",
      () => ed.textOf("#last")
    );
  });

  // An extension wraps a whole text node in its own <span>: the node is still the editor's, so the keys go into it.
  test("keys typed after an extension wraps a whole text node in a <span> go into that node", async () => {
    await ed.clickEnd("#last");
    await ed.frame(
      `(() => { const t = ${F}.getElementById("last").firstChild, s = ${F}.createElement("span"); s.className = "ext"; t.before(s); s.append(t); return true; })()`
    );
    await ed.type("56");
    await until(
      async () => (await ed.textOf("#last")) == "Last paragraph.123456",
      3000,
      "the paragraph shows the keys",
      () => ed.textOf("#last")
    );
    expect(await ed.frame<string>(`${F}.querySelector("#last .ext")?.textContent ?? ""`)).toBe("Last paragraph.123456");
  });

  // With a <div> that an extension added to the body, Tab loaded the page again, and the key typed while it loaded was
  // lost. A person types right after Tab and does not wait.
  test("a key right after Tab is kept when an extension has put a <div> in the page", async () => {
    await ed.press("Enter");
    await ed.type("- One");
    await ed.press("Enter");
    await ed.type("Two");
    await ed.frame(`(${F}.body.appendChild(${F}.createElement("div")), true)`);
    await ed.press("Tab");
    await ed.type("x");
    await ed.idle();
    await until(
      async () => (await ed.textOf("li li")) == "Twox",
      3000,
      "the nested item shows the key",
      () => ed.textOf("ul")
    );
  });

  test("text typed in the page's own contenteditable box marked data-erga-noedit shows, and the file does not change", async () => {
    const before = await ed.source();
    await ed.clickEnd("#scratch p");
    await ed.type(" XY");
    await expect.poll(() => ed.textOf("#scratch")).toBe("Scratch XY");
    expect((await ed.alerts()).view).toBe("none");
    await ed.settle();
    expect(await ed.source()).toBe(before);
    // The text around it still edits.
    await ed.clickEnd("#last");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("Last paragraph.123456!</p>");
  });

  test("Enter at the end of a block with an id: the new block has its class but not its id, and typing goes in it", async () => {
    await ed.clickEnd("#target");
    await ed.press("Enter");
    await ed.type("new");
    await expect.poll(() => ed.source()).toContain(`<p id="target" class="lead">A block with an id.</p>\n<p class="lead">new</p>`);
    expect(await ed.count("[id=target]")).toBe(1);
  });

  test("a change to the page's stylesheet reaches the page, and the page still edits", async () => {
    appendFileSync(join(ed.dir, "style.css"), "\nh1 { letter-spacing: 3px; }\n");
    await expect.poll(() => ed.frame<string>(`getComputedStyle(${F}.querySelector("h1")).letterSpacing`)).toBe("3px");
    // (The page is made afresh for a stylesheet that changes.)
    await ed.loaded();
    await ed.settle();
    await ed.clickEnd("h1");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("<h1>Page parts!</h1>");
  });

  test("clicking a no-edit part says why, typing there changes nothing, and the paragraph beside it still edits", async () => {
    const before = await ed.source();
    const r = await ed.rectOf(".fixed p", 0.3);
    await ed.click(r.x, r.y);
    await expect
      .poll(async () => (await ed.alerts()).alerts.map((a) => a.title))
      .toEqual(["This part of the page is marked as not editable by hand"]);
    await ed.type("xyz");
    await ed.settle();
    expect(await ed.source()).toBe(before);
    await ed.clickEnd(".free");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("items.!</p>");
  });

  test("a paragraph with a stray end tag: a second problem in the same card, with the agent's help; a click there again counts, typing changes nothing; the card stays while the person types elsewhere", async () => {
    const before = await ed.source();
    const r = await ed.rectOf(".typo p", 0.3);
    await ed.click(r.x, r.y);
    // The card has both problems now, the newest first: never a second card, and none waits behind another.
    await expect.poll(async () => (await ed.alerts()).head).toBe("2 problems");
    const [stray, fixed] = (await ed.alerts()).alerts;
    expect(stray).toEqual({
      title: "This paragraph can't be edited",
      count: "",
      detail: "Editor · its HTML has a stray </h2> that the browser ignores, so the page's text no longer lines up with the file.",
      rows: [],
      buttons: ["Fix with agent"],
    });
    expect(stray.detail).not.toMatch(/HTML view|⌘⇧P/);
    expect(fixed.title).toMatch(/not editable by hand/);
    // Typing into it changes nothing. A click on it again says so in the same block, with a count.
    await ed.type("xyz");
    await ed.click(r.x, r.y);
    await expect.poll(async () => (await ed.alerts()).alerts[0].count).toBe("×2");
    expect((await ed.alerts()).alerts.length).toBe(2);
    expect(await ed.source()).toBe(before);
    // The card never takes the focus, and stays up while the person works: the paragraph below it still edits.
    await ed.clickEnd("#last");
    await ed.type("?");
    await expect.poll(() => ed.source()).toContain("Last paragraph.123456!?</p>");
    expect((await ed.alerts()).head).toBe("2 problems");
  });

  test("a no-edit part's Fix with agent opens the agent's panel with the request ready to complete, sends nothing, and takes only its own alert off", async () => {
    // (A person has one conversation with their agent, in every document: a new one, so that this journey counts its own messages.)
    await newConversation(s);
    const r = await ed.rectOf(".count", 0.5);
    await ed.click(r.x, r.y);
    // The same problem as before (another no-edit part): its block counts.
    await expect.poll(async () => (await ed.alerts()).alerts.find((a) => /not editable by hand/.test(a.title))?.count).toBe("×2");
    await ed.page.click('#alerts .alert:has-text("not editable by hand") [data-action="fix"]');
    await expect.poll(() => agentBox(ed)).toEqual({ text: "Change the text “42” to: ", open: true, sent: 0 });
    expect(await ed.eval<boolean>(`document.activeElement == document.getElementById("agent-input")`)).toBe(true);
    expect((await ed.alerts()).alerts.map((a) => a.title)).toEqual(["This paragraph can't be edited"]);
  });

  test("text that the page's script changed: its Fix with agent asks the agent to make it editable by hand; Escape closes the card with what is left", async () => {
    // (The panel opened in the step before, and the page slides over beside it: a click waits for the page to be still.)
    await pageStill(ed);
    const r = await ed.rectOf("#now", 0.3);
    await ed.click(r.x, r.y);
    const changed = {
      title: "This paragraph can't be edited here",
      detail: "Editor · the page's script changed its text after the page loaded.",
    };
    await expect.poll(async () => (await ed.alerts()).alerts[0]).toMatchObject(changed);
    // Beside the agent's panel, not under it.
    const clear = await ed.eval<boolean>(
      `document.querySelector("#alerts .alerts-card").getBoundingClientRect().left >= document.getElementById("agent").getBoundingClientRect().right`
    );
    expect(clear).toBe(true);
    await ed.page.click('#alerts .alert:has-text("edited here") [data-action="fix"]');
    await expect.poll(async () => (await agentBox(ed)).sent).toBe(1);
    expect(await ed.eval<string>(`document.querySelector(".msg-user").textContent`)).toContain(
      "Fix the problem with this page that the editor reported"
    );
    // One problem is left, with its own button. Escape, in the text, dismisses it.
    expect((await ed.alerts()).head).toBe("1 problem");
    await ed.clickEnd("#last");
    await ed.press("Escape");
    await expect.poll(async () => (await ed.alerts()).view).toBe("none");
  });

  test("the agent stops on an error while its panel is closed: an alert says so, and its Show opens the panel", async () => {
    await agentPlays(ed, [{ error: "overloaded", delay: 300 }]);
    await ed.page.click("#agent-close");
    const stopped = {
      title: "Your agent stopped",
      count: "",
      detail: 'Agent · overloaded. Say "go on" to try again.',
      rows: [],
      buttons: ["Show"],
    };
    await expect.poll(async () => (await ed.alerts()).alerts).toEqual([stopped]);
    await ed.page.click('#alerts .alert [data-action="show"]');
    await expect.poll(() => ed.eval<boolean>(`document.body.classList.contains("agent-open")`)).toBe(true);
    expect((await ed.alerts()).view).toBe("none");
    expect(await ed.eval<string>(`document.querySelector("#agent-log .msg-error").textContent`)).toBe(
      'overloaded. Say "go on" to try again.'
    );
  });
});

journey("a deck that changes on disk and by an agent while the person types", () => {
  let ed: Editor;
  /** The text of the slide's paragraph (1 to 3): the page shows one slide, and holds all. */
  const para = (n: number) => ed.textOf(`.slide:nth-of-type(${n}) p`);
  const TITLE = ".current h1";
  /** Whether the agent is at work: its button says Stop. */
  const working = (ed: Editor) => ed.eval<boolean>(`document.getElementById("agent-send").classList.contains("stop")`);

  // Pete saw "Applying change set to a document with the wrong length" while he edited his deck: an edit from outside
  // that came while the page loaded again went to the new page twice.
  test("an edit on disk and keys while the page loads again: no error, and the file ends with the edit and every key", async ({ tab }) => {
    ed = await openEditor(tab, s, "deck"); // the journey's one page load
    await ed.press("Escape");
    await ed.press("ArrowRight");
    await ed.press("ArrowRight");
    await ed.clickEnd(TITLE);
    await ed.type(" one");
    await ed.idle();
    // The page loads slowly, as on a real network: the edit on disk comes while it loads.
    let release = () => {};
    let asked = false;
    const held = new Promise<void>((r) => (release = r));
    await tab.page.context().route(/[?&]erga-edit/, async (route) => {
      asked = true;
      await held;
      await route.continue();
    });
    // The page made afresh, as for a change the editor can't patch in: it loads again.
    await ed.frame(`ergaFrame.page.render()`);
    // (The old page has handed its state over, and asked for the new one: it stays until the new one comes.)
    await until(() => asked, 5000, "the page asks for the new page");
    ed.write(ed.disk().replace("The arrows move between slides.", "The arrows move between slides, and the disk edits."));
    await until(() => ed.eval<boolean>(`ergaPage.collab.current().includes("the disk edits")`), DISK_MS, "the shell has the edit on disk");
    // The person types on while the page loads.
    await ed.type(" two");
    // (From now on the page loads at once.)
    release();
    await ed.loaded();
    await tab.page.context().unrouteAll({ behavior: "wait" });
    await ed.type(" three");
    await ed.idle();
    await ed.shows(`
      # Third slide one two three|

      The last one.
    `);
    expect(tab.errors.filter((e) => /wrong length|RangeError/.test(e))).toEqual([]);
    await until(
      () => ed.disk().includes("Third slide one two three") && ed.disk().includes("the disk edits"),
      DISK_MS,
      "the file has both"
    );
    expect(await para(1), "the first slide has the edit on disk").toContain("the disk edits");
  });

  test("typing and a disk edit at once: both survive, unmarked; ⌘Z takes back the typing only, ⌘⇧Z brings it back", async () => {
    await ed.clickEnd(TITLE);
    await ed.type(" now");
    await ed.watchMarks();
    ed.write(ed.disk().replace("Space and Page Down go on too.", "Space and Page Down went on."));
    await until(
      async () => (await para(2)) == "Space and Page Down went on.",
      DISK_MS,
      "the disk's edit shows",
      async () => ({ second: await para(2), title: await ed.textOf(TITLE) })
    );
    expect(await ed.seenMarks()).toEqual([]);
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toMatch(/Page Down went on\.[\s\S]* now<\/h1>/);
    expect(await ed.textOf(TITLE)).toMatch(/ now$/);
    expect(await para(2)).toBe("Space and Page Down went on.");
    await ed.press("ControlOrMeta+z");
    await expect.poll(() => ed.textOf(TITLE)).not.toMatch(/ now$/);
    expect(await para(2)).toBe("Space and Page Down went on.");
    await ed.press("ControlOrMeta+Shift+z");
    await expect.poll(() => ed.textOf(TITLE)).toMatch(/ now$/);
  });

  test("a diagram added on disk shows up without a reload, and the page still edits", async () => {
    // (The file has the step before's last change: the edit below is the only one on disk.)
    await until(() => ed.disk().includes("three now</h1>"), DISK_MS, "the file has the title");
    const loaded = await ed.frame<number>(`performance.timeOrigin`);
    ed.write(
      ed
        .disk()
        .replace(
          "<h1>Third slide",
          `<svg id="diagram" width="80" height="20"><rect width="80" height="20" fill="#c00"/></svg><h1>Third slide`
        )
    );
    await expect.poll(() => ed.frame<boolean>(`!!${F}.getElementById("diagram")`), { timeout: DISK_MS }).toBe(true);
    await expect.poll(() => ed.count("[data-erga-text]")).toBeGreaterThanOrEqual(6);
    await ed.settle();
    await ed.clickEnd(TITLE);
    await ed.type("!");
    await expect.poll(() => ed.textOf(TITLE)).toBe("Third slide one two three now!");
    expect(await ed.frame<number>(`performance.timeOrigin`), "the page is the one that was there").toBe(loaded);
  });

  test("while an agent edits the source the page is read-only and says who; after its run, it edits again", async () => {
    await ed.openAgent();
    // The agent's run: one edit, then a long thought. The person stops it below.
    await agentPlays(ed, [
      {
        tool: "edit",
        args: { path: "index.html", edits: [{ oldText: "<h1>First slide</h1>", newText: "<h1>First slide</h1><h2>From the agent.</h2>" }] },
      },
      { text: "Done.", delay: 12_000 },
    ]);
    await expect.poll(() => lockNote(ed)).toMatch(/is editing this page's source/);
    // (The editor stays on the page, read-only: the agent's edits show as they land.)
    expect(await ed.frame<boolean>(`${F}.body.isContentEditable`)).toBe(false);
    await expect.poll(() => ed.count(".slide h2")).toBe(1);
    // Keys change nothing meanwhile.
    await pageStill(ed);
    const title = await ed.rectOf(TITLE);
    await ed.page.mouse.click(title.x, title.y);
    await ed.page.keyboard.type("X");
    expect(await ed.textOf(TITLE)).toBe("Third slide one two three now!");
    // The agent's run ends (the person stops it): the lock goes, and the page edits again, with no reload.
    await ed.page.click("#agent-send.stop");
    await until(async () => (await lockNote(ed)) == "", 10_000, "the lock goes");
    await ed.loaded();
    await ed.clickEnd(TITLE);
    await ed.type("?");
    await expect.poll(() => ed.disk(), { timeout: DISK_MS }).toContain("<h1>Third slide one two three now!?</h1>");
    expect(ed.disk()).toContain("<h2>From the agent.</h2>");
  });

  test("a page's own edit (call_edit) by the agent doesn't lock: the page stays editable while the agent works", async () => {
    await agentPlays(ed, [
      {
        tool: "edit",
        args: {
          op: "call_edit",
          path: "index.html",
          edit: "replace_text",
          input: { selector: ".slide:nth-of-type(2) h1", find: "Second", text: "Middle" },
        },
      },
      { text: "Done.", delay: 12_000 },
    ]);
    await expect.poll(() => ed.textOf(".slide:nth-of-type(2) h1")).toBe("Middle slide");
    // The agent still works (its button says Stop), and nothing is locked: the person types on.
    expect(await working(ed)).toBe(true);
    expect(await lockNote(ed)).toBe("");
    await ed.clickEnd(TITLE);
    await ed.type("!");
    await expect
      .poll(() => ed.disk(), { timeout: DISK_MS })
      .toMatch(/<h1>Middle slide<\/h1>[\s\S]*<h1>Third slide one two three now!\?!<\/h1>/);
    expect(await working(ed)).toBe(true);
    await ed.page.click("#agent-send.stop");
    await until(async () => !(await working(ed)), 10_000, "the agent stops");
  });

  test("the source view types HTML as code: a tag brings its closing tag, Enter indents, and names and comments have their colors; ⌘⇧P goes back to a page that edits", async () => {
    await ed.press("ControlOrMeta+Shift+p");
    await expect
      .poll(() => ed.eval<string | null>(`document.querySelector("#source .cm-content")?.getAttribute("contenteditable") ?? null`))
      .toBe("true");
    await ed.settle();
    // It shows the file, with the edits from the disk and from the agent.
    expect(await ed.source()).toMatch(/the disk edits[\s\S]*<h1>Third slide one two three now!\?!<\/h1>/);
    const end = async () => {
      const src = await ed.source();
      return src.slice(src.indexOf("</html>\n") + 8);
    };
    await ed.press("ControlOrMeta+End");
    await ed.type("<section>");
    await expect.poll(end).toBe("<section></section>");
    await ed.press("Enter");
    await ed.type("<p>hi");
    await expect.poll(end).toBe("<section>\n  <p>hi</p>\n</section>");
    await ed.press("End");
    await ed.press("Enter");
    await ed.type("<ul>");
    await ed.press("Enter");
    await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    \n  </ul>\n</section>");
    // "</" closes the innermost open element.
    await ed.type("<li>x");
    for (let i = 0; i < 5; i++) await ed.press("ArrowRight");
    for (let i = 0; i < 5; i++) await ed.press("Backspace");
    await ed.type("</");
    await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    <li>x</li>\n  </ul>\n</section>");
    await ed.press("ControlOrMeta+End");
    await ed.type("\n<!-- a note -->");
    await expect.poll(end).toBe("<section>\n  <p>hi</p>\n  <ul>\n    <li>x</li>\n  </ul>\n</section>\n<!-- a note -->");
    // The colors: a tag's brackets and a comment pale, names and values darker than the text, a comment in italics.
    const look = (text: string) =>
      ed.eval<string[]>(
        `(() => { const s = [...document.querySelectorAll("#source .cm-line span")].find((s) => s.textContent == ${JSON.stringify(text)}); const c = s && getComputedStyle(s); return c ? [c.color, c.fontStyle] : []; })()`
      );
    const text = await ed.eval<string>(`getComputedStyle(document.querySelector("#source .cm-content")).color`);
    const [bracket] = await look("<"),
      [name] = await look("html"),
      [value] = await look('"en"');
    expect(new Set([text, bracket, name]).size).toBe(3);
    expect(value).toBe(name);
    expect(await look("<!-- a note -->")).toEqual([bracket, "italic"]);

    // ⌘⇧P again: the page, with the new section, and it edits.
    await ed.press("ControlOrMeta+Shift+p");
    await expect
      .poll(
        async () =>
          !(await ed.eval<boolean>(`document.body.classList.contains("source")`)) &&
          (await ed.frame<boolean>(`!!${F}.querySelector("section li[data-erga-text]")`))
      )
      .toBe(true);
    // A click right away puts the caret where it lands: the editor doesn't move it back afterwards.
    await ed.clickEnd("section li");
    await ed.type("!");
    await expect.poll(() => ed.textOf("section li")).toBe("x!");
  });
});

journey("files dropped and pasted on a page in a folder", () => {
  let ed: Editor;
  let id: string;
  let address: string;
  let files: () => Promise<string[]>;
  let loaded: number;
  const LOADED = { loaded: true };
  /**
   * The browser logs an error for each file that an element asked for before its bytes were there (and for each write
   * the server refused): the only errors this page may have.
   */
  const expected = (tab: Tab) => tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !/Failed to load resource/.test(e)));
  /** Where the last paragraph is on the page: it moves when the text above it does. */
  const tail = () => ed.frame<number>(`Math.round(${F}.querySelector("p.tail").getBoundingClientRect().top + scrollY)`);
  /** Holds the bytes of the uploads back (the write that names them goes), until `go`. */
  const held = async () => {
    let go!: () => void;
    const wait = new Promise<void>((done) => (go = done));
    const going: Promise<void>[] = [];
    await ed.page.route(/\/api\/blobs\//, (r) => void going.push(wait.then(() => r.continue())));
    return async () => {
      go();
      await Promise.all(going);
      await ed.page.unroute(/\/api\/blobs\//);
    };
  };

  test("a dragged image shows a line between two blocks and moves no text; dropped, it is on the page at once at its final size, and nothing moves when its bytes come; another tab shows a box of its size meanwhile", async ({
    tab,
  }) => {
    // A folder has an image's name, and a file has another's: the steps below meet both.
    ({ ed, id, address, files } = await openDropPage(tab, s, { "images/clash.png/a.txt": "x", "images/dot.png": "old" })); // page load 1
    loaded = await ed.frame<number>(`performance.timeOrigin`);
    const go = await held();
    const before = await tail();
    const over = await drag(ed, "p.lede", 6, [onDisk("pin.png")], "bottom");
    // During the drag: where it lands and what it will be; the text stays where it is (before: a gap of 144 px opened).
    expect(over.sign).toEqual(["line", "chip Imageas wide as the text"]);
    expect(await tail()).toBe(before);
    await over.drop();
    // At the drop: the image, 200 by 150 px as its file is, with how far its bytes are on it. (Before: a small copy,
    // and the image only when the upload ended, which moved the text below it then.)
    const pin = { src: "../images/pin.png", alt: "pin.png", size: "200x150" };
    await expect.poll(() => images(ed), UPLOAD).toEqual([{ ...pin, loaded: false }]);
    await expect.poll(() => pendingParts(ed)).toEqual(["ph", expect.stringMatching(/^badge \d+%.*×$/)]);
    expect(await dropSign(ed)).toEqual([]);
    const moved = await tail();
    expect(moved).toBeGreaterThan(before + 150);
    expect(await ed.source()).toContain(`ship them.</p>\n  ${CENTRED("../images/pin.png")}\n  <p`);
    // Someone else with the document open: a box of the image's size, and whose file it is. No problem is said of it.
    const other = await tab.page.context().newPage(); // page load 2
    await other.goto(`${s.root}${address}/blog/post?edit`);
    // (A tab draws only while it is in front.)
    await other.bringToFront();
    const inOther = <T>(js: string) =>
      Promise.all(other.frames().map((f) => (f == other.mainFrame() ? null : f.evaluate<T>(js).catch(() => null)))).then(
        (all) => all.find((x) => x != null) ?? null
      );
    const there = () =>
      inOther<string[]>(
        `window.ergaFrame && [...(document.querySelector("erga-pending")?.shadowRoot?.querySelectorAll(".c > *:not([hidden])") ?? [])].map((x) => (x.className + " " + x.textContent).trim())`
      );
    await expect.poll(there, UPLOAD).toEqual(["ph wait", expect.stringMatching(/^badge plain 0%pin\.png · from \S/)]);
    const image = `window.ergaFrame && [...document.querySelectorAll("body img")].map((i) => [i.clientWidth, i.clientHeight, i.naturalWidth].join(" ")).join()`;
    expect(await inOther<string>(image)).toBe("200 150 0");
    expect(await other.evaluate(() => document.getElementById("alerts")!.dataset.view ?? "none")).toBe("none");
    await go();
    // The bytes are there: the image shows them, in both tabs, with no page loaded again; nothing moved.
    await expect.poll(() => images(ed), UPLOAD).toEqual([{ ...pin, ...LOADED }]);
    await expect.poll(() => pendingParts(ed)).toEqual([]);
    await expect.poll(there).toEqual([]);
    await expect.poll(() => inOther<string>(image)).toBe("200 150 200");
    await other.close();
    await tab.page.bringToFront();
    expect(await tail()).toBe(moved);
    expect(await files()).toEqual(expect.arrayContaining(["images/pin.png"]));
    expected(tab);
  });

  test("a dragged file that isn't an image shows a caret in the line, and goes into files/ as a link there with its name; a folder's files go in, each in the folder", async ({
    tab,
  }) => {
    const over = await drag(ed, "p.lede", 6, [onDisk("notes.txt")]);
    expect(over.sign).toEqual(["bar", "chip Link to the filein this line"]);
    await over.drop();
    await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="lede">Build <a href="../files/notes.txt">notes.txt</a><em>cool</em>`);
    // The link opens the file.
    await expect
      .poll(() => ed.frame<string>(`fetch(${F}.querySelector('a[href="../files/notes.txt"]').href).then((r) => r.text())`), UPLOAD)
      .toContain("some notes");
    // A folder (before: "the server didn't answer"): its image and its other file, in order, under its name.
    // (Not at the line's start: the agent's button is over the window's corner there, and takes no drop.)
    await drop(ed, "p.tail", 13, [folderOnDisk("brand", ["logo.png", "terms.txt"])]);
    await expect
      .poll(() => ed.source(), UPLOAD)
      .toContain(`<p class="tail">We came down ${IMG("../images/brand/logo.png")}<a href="../files/brand/terms.txt">terms.txt</a>before`);
    await expect.poll(files, UPLOAD).toEqual(expect.arrayContaining(["files/notes.txt", "images/brand/logo.png", "files/brand/terms.txt"]));
    expected(tab);
  });

  test("images go before or after the paragraph under the pointer, in order, each a paragraph of its own; on an empty line, into it; a name that is taken gets -2; an upload under a second shows no alert", async ({
    tab,
  }) => {
    await drop(ed, "p.lede", 4, [onDisk("start.png")], "top");
    await expect.poll(() => ed.source(), UPLOAD).toContain(`${CENTRED("../images/start.png")}\n  <p class="lede">Build`);
    await drop(ed, "p.empty", 0, [onDisk("empty.png")]);
    await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="empty">${IMG("../images/empty.png")}</p>`);
    // A file of that name is there already: the new one gets the next name.
    await drop(ed, "h1", 3, [onDisk("dot.png"), onDisk("two.png")], "bottom");
    await expect
      .poll(async () => (await images(ed)).filter((i) => /dot|two/.test(i.src)), UPLOAD)
      .toEqual([
        { src: "../images/dot-2.png", alt: "dot-2.png", size: "200x150", ...LOADED },
        { src: "../images/two.png", alt: "two.png", size: "200x150", ...LOADED },
      ]);
    expect((await ed.alerts()).view).toBe("none");
    expect(await ed.source()).toContain(`Launch notes</h1>\n  ${CENTRED("../images/dot-2.png")}\n  ${CENTRED("../images/two.png")}\n  <p`);
    expect(await files()).toEqual(expect.arrayContaining(["images/dot.png", "images/dot-2.png", "images/two.png", "images/empty.png"]));
    expected(tab);
  });

  test("a pasted screenshot goes in at the caret, no wider than the text", async ({ tab }) => {
    const at = await ed.charAt("p.lede", 3);
    await ed.click(at.x, at.y);
    await pasteFiles(ed, png("image.png"));
    await expect
      .poll(async () => (await images(ed)).find((i) => i.alt == "image.png"), UPLOAD)
      .toEqual({ src: "../images/image.png", alt: "image.png", size: "40x30", ...LOADED });
    expect(await ed.source()).toMatch(
      /<p class="lede">Bu[a-z]*<img style="max-width: 100%; height: auto" src="\.\.\/images\/image.png" width="40" height="30" alt="image.png">[a-z]* <a /
    );
    expected(tab);
  });

  test("a file over the limit is refused at the drop, before a byte goes, on the file and in the card; the page's own button only opens the card; the card's Raise the limit sends it", async ({
    tab,
  }) => {
    await runTool(s.root, "set_setting", { key: "max_file_mb", value: 1 });
    const sent: string[] = [];
    const watch = (r: { method(): string; url(): string }) => void (r.method() == "PUT" && sent.push(r.url()));
    ed.page.on("request", watch);
    await drop(ed, "p.tail", 13, [onDisk("film.mov", 1_200_000)]);
    const problem = {
      title: "“film.mov” is too large",
      count: "",
      detail: "Upload · it has 1.2 MB. The limit here is 1 MB.",
      rows: [],
      buttons: ["Raise the limit to 50 MB", "Remove"],
    };
    await expect.poll(async () => (await ed.alerts()).alerts).toEqual([problem]);
    await expect
      .poll(() => pendingParts(ed))
      .toEqual([
        "ph link error small",
        "badge error Too large. film.mov has 1.2 MB. The limit here is 1 MB.Raise the limit to 50 MBRemove",
      ]);
    expect(sent).toEqual([]);
    // Closed, the problem stays on the file. Its button there asks for the card: a page's script can't raise a limit.
    await ed.page.click("#alerts .alerts-close");
    expect((await ed.alerts()).view).toBe("none");
    await clickBadge(ed, "raise");
    await expect.poll(async () => (await ed.alerts()).alerts).toEqual([problem]);
    expect((await runTool(s.root, "settings")).result.settings.find((x: { key: string }) => x.key == "max_file_mb").value).toBe(1);
    await ed.page.click('#alerts [data-action="raise"]');
    await expect.poll(files, UPLOAD).toEqual(expect.arrayContaining(["files/film.mov"]));
    await expect.poll(() => pendingParts(ed)).toEqual([]);
    expect(sent.length).toBe(1);
    ed.page.off("request", watch);
    await runTool(s.root, "set_setting", { key: "max_file_mb", reset: true });
    expected(tab);
  });

  test("a file the server refuses says why on the file and in the card; Remove takes its element out of the text", async ({ tab }) => {
    // A folder has the image's name.
    const before = await ed.source();
    await drop(ed, "h1", 3, [onDisk("clash.png")], "top");
    const why = "There's a folder at images/clash.png: a file can't take its place.";
    await expect
      .poll(async () => (await ed.alerts()).alerts)
      .toEqual([{ title: "“clash.png” was not added", count: "", detail: `Upload · ${why}`, rows: [], buttons: ["Remove"] }]);
    await expect.poll(() => pendingParts(ed)).toEqual(["ph error", `badge error Not added. ${why}Remove`]);
    await ed.page.click('#alerts [data-action="remove"]');
    await expect.poll(() => ed.source()).toBe(before);
    await expect.poll(async () => [(await ed.alerts()).view, await pendingParts(ed)]).toEqual(["none", []]);
    // (The folder that has its name stays.)
    expect(await files()).toEqual(expect.arrayContaining(["images/clash.png/a.txt"]));
    expected(tab);
  });

  test("a slow upload shows as one line after a second, with what is left; × on the image stops it and takes the image out; so does Undo", async ({
    tab,
  }) => {
    // (The alerts' times, five times as fast: the quiet second.)
    await ed.eval(`window.__ergaTimescale = 0.2`);
    const before = await ed.source();
    const go = await held();
    await drop(ed, "p.tail", 13, [onDisk("slow.png")], "top");
    await expect.poll(async () => (await ed.alerts()).head).toBe("slow.png");
    await ed.page.click("#alerts .alerts-pill");
    expect((await ed.alerts()).alerts).toEqual([
      {
        title: "Uploading slow.png",
        count: "",
        detail: "Upload · by you",
        rows: [expect.stringMatching(/^running slow\.png: 1 KB/)],
        buttons: ["×"],
      },
    ]);
    await clickBadge(ed, "cancel");
    await expect.poll(() => ed.source()).toBe(before);
    await expect.poll(async () => [(await ed.alerts()).view, await pendingParts(ed)]).toEqual(["none", []]);
    // Undo, after another drop.
    await drop(ed, "p.tail", 13, [onDisk("undone.png")], "top");
    await expect.poll(() => ed.source()).toContain("images/undone.png");
    await ed.page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => ed.source()).toBe(before);
    await expect.poll(() => pendingParts(ed)).toEqual([]);
    await go();
    expect(await files()).not.toEqual(expect.arrayContaining(["images/slow.png"]));
    expect(await files()).not.toEqual(expect.arrayContaining(["images/undone.png"]));
    await ed.eval(`delete window.__ergaTimescale`);
    expected(tab);
  });

  test("an agent's file on its way: a box of its size on the page with the agent's name, and its line in the alerts; when its bytes come, the image shows them", async ({
    tab,
  }) => {
    const token = (
      (await (
        await fetch(`${s.root}${address}/api/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: s.root },
          body: "{}",
        })
      ).json()) as { token: string }
    ).token;
    const bytes = readFileSync(onDisk("chart.png"));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const agent = (name: string, args: Record<string, unknown>) => runTool(s.root, name, { document: id, ...args }, { token });
    expect((await agent("write", { files: { "images/chart.png": { blob: hash, size: bytes.length } } })).result.waiting).toEqual([
      "images/chart.png",
    ]);
    await agent("edit", {
      path: "blog/post.html",
      edits: [{ oldText: "<h1>Launch notes</h1>", newText: `<h1>Launch notes</h1>\n  ${CENTRED("../images/chart.png")}` }],
    });
    await expect.poll(() => pendingParts(ed), UPLOAD).toEqual(["ph wait", expect.stringMatching(/^badge plain 0%chart\.png · from /)]);
    await expect
      .poll(async () => (await images(ed)).find((i) => i.alt == "chart.png"))
      .toEqual({ src: "../images/chart.png", alt: "chart.png", size: "200x150", loaded: false });
    await expect.poll(async () => (await ed.alerts()).head).toBe("chart.png");
    await ed.page.click("#alerts .alerts-pill");
    expect((await ed.alerts()).alerts).toEqual([
      {
        title: "Uploading chart.png",
        count: "",
        detail: expect.stringMatching(/^Upload · by .*your agent$/),
        rows: ["waiting chart.png: 1 KB"],
        buttons: ["Cancel", "×"],
      },
    ]);
    expect((await fetch(`${s.root}/d/${id}/api/blobs/${hash}`, { method: "PUT", body: bytes })).status).toBe(200);
    await expect.poll(async () => (await images(ed)).find((i) => i.alt == "chart.png")?.loaded, UPLOAD).toBe(true);
    await expect.poll(() => pendingParts(ed)).toEqual([]);
    expected(tab);
  });

  test("the page did not load again for the new files; after a reload, every image is there", async ({ tab }) => {
    // (The shell makes the page afresh for a stylesheet or a script that changes, not for a file.)
    expect(await ed.frame<number>(`performance.timeOrigin`)).toBe(loaded);
    const before = await images(ed);
    expect(before.length).toBe(8);
    await ed.page.reload(); // page load 3
    await ed.loaded();
    await expect.poll(() => images(ed), UPLOAD).toEqual(before);
    expected(tab);
  });
});

journey("a broken page says what is wrong, all of it in one card", () => {
  let ed: Editor;
  const titles = async () => (await ed.alerts()).alerts.map((a) => a.title).sort();

  test("a broken page says what's wrong by itself: both problems in one card, each with a button to have the agent fix it, and one for all", async ({
    tab,
  }) => {
    // The page's script error is the point.
    ed = await openEditor(tab, s, "broken", { allowErrors: true }); // the journey's one page load
    await expect.poll(titles).toEqual(["The page's script hit an error", "The stylesheet “missing.css” didn't load"]);
    // The buttons are off ("Connecting to the agent…") until the agent's state comes, which can be after the page's problems.
    await expect.poll(async () => (await ed.alerts()).alerts.map((a) => a.buttons)).toEqual([["Fix with agent"], ["Fix with agent"]]);
    const shown = await ed.alerts();
    expect([shown.view, shown.head, shown.all]).toEqual(["card", "2 problems", true]);
    expect(shown.alerts.find((a) => /script/.test(a.title))!.detail).toMatch(
      /^Page · .*drawTheChart is not defined \(index\.html, line \d+\)$/
    );
  });

  test("Ctrl+S while the problems show: “Saved” shows over the card, in its own place, and the problems stay; typed text goes into the page", async () => {
    await ed.clickEnd("h1");
    await ed.press("ControlOrMeta+s");
    await expect.poll(async () => (await ed.toast()).shown).toBe(true);
    expect((await ed.toast()).text).toMatch(/^Saved/);
    const gap = await ed.eval<number>(
      `document.querySelector("#alerts .alerts-card").getBoundingClientRect().top - document.getElementById("toast").getBoundingClientRect().bottom`
    );
    expect(gap).toBeGreaterThanOrEqual(0);
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("<h1>Something is off here!</h1>");
    // The confirmation goes by itself; both problems are still there.
    await expect.poll(async () => (await ed.toast()).shown).toBe(false);
    expect((await ed.alerts()).head).toBe("2 problems");
  });

  test("one click on × closes both problems; neither comes back when the page loads again", async () => {
    await ed.page.click("#alerts .alerts-close");
    expect((await ed.alerts()).view).toBe("none");
    // The click left the caret in the text.
    await ed.type("?");
    await expect.poll(() => ed.source()).toContain("<h1>Something is off here!?</h1>");
    // The page made afresh: its script throws again, and its stylesheet fails again. Neither shows again.
    await ed.frame(`ergaFrame.page.render()`);
    await ed.loaded();
    await until(() => ed.frame<boolean>(`document.readyState == "complete"`), 5000, "the page has loaded, with its problems");
    await ed.settle();
    expect((await ed.alerts()).view).toBe("none");
  });
});
