// Keys are never lost, and the document is never corrupted: while the page renders again, with a browser extension's
// elements in the page, with parts that are the page's own, with edits on disk and an agent's edits, with dropped
// files, and with a broken page.
//
// Four journeys, each one page: a page with parts of its own (e2e/fixtures/steady), a deck that changes on disk
// and by an agent while the person types, a page that takes dropped files, and a broken page.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { DISK_MS, F, openEditor, type Editor } from "../helpers/editor";
import {
  agentBox,
  agentPlays,
  CENTRED,
  newConversation,
  drop,
  images,
  IMG,
  lockNote,
  openDropPage,
  pageStill,
  pasteFiles,
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
    expect((await ed.toast()).shown).toBe(false);
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
    await expect.poll(async () => (await ed.toast()).shown && /not editable by hand/.test((await ed.toast()).text)).toBe(true);
    await ed.type("xyz");
    await ed.settle();
    expect(await ed.source()).toBe(before);
    await ed.clickEnd(".free");
    await ed.type("!");
    await expect.poll(() => ed.source()).toContain("items.!</p>");
  });

  test("a paragraph with a stray end tag: a click says why and offers the agent's help; typing changes nothing; a click elsewhere takes the note away", async () => {
    const before = await ed.source();
    const r = await ed.rectOf(".typo p", 0.3);
    await ed.click(r.x, r.y);
    await expect.poll(async () => (await ed.toast()).shown && /stray <\/h2>/.test((await ed.toast()).text)).toBe(true);
    expect((await ed.toast()).text).not.toMatch(/HTML view|⌘⇧P/);
    expect(await ed.eval<boolean>(`!!document.querySelector("#toast .toast-fix")`)).toBe(true);
    // Typing into it explains again, and changes nothing.
    await ed.type("xyz");
    await ed.settle();
    const t = await ed.toast();
    expect(t.shown).toBe(true);
    expect(t.text).toMatch(/stray/);
    expect(await ed.source()).toBe(before);
    // Clicked elsewhere until it goes: a click inside the note's minimum time leaves it up.
    const elsewhere = await ed.rectOf("h1", 0.5);
    await expect
      .poll(async () => {
        await ed.click(elsewhere.x, elsewhere.y);
        return (await ed.toast()).shown;
      })
      .toBe(false);
    // The paragraph below it still edits.
    await ed.clickEnd("#last");
    await ed.type("?");
    await expect.poll(() => ed.source()).toContain("Last paragraph.123456!?</p>");
  });

  test("a no-edit part's note has Fix with agent: it opens the agent's panel with the request ready to complete, and sends nothing", async () => {
    // (A person has one conversation with their agent, in every document: a new one, so that this journey counts its own messages.)
    await newConversation(s);
    const r = await ed.rectOf(".count", 0.5);
    await ed.click(r.x, r.y);
    await expect.poll(async () => (await ed.toast()).text).toMatch(/not editable by hand/);
    expect((await ed.toast()).shown).toBe(true);
    expect(await ed.eval<string>(`document.querySelector("#toast .toast-fix").textContent`)).toBe("Fix with agent");
    await ed.page.click("#toast .toast-fix");
    await expect.poll(() => agentBox(ed)).toEqual({ text: "Change the text “42” to: ", open: true, sent: 0 });
    expect(await ed.eval<boolean>(`document.activeElement == document.getElementById("agent-input")`)).toBe(true);
  });

  test("text that the page's script changed: its note has Fix with agent, which asks the agent to make it editable by hand", async () => {
    // (The panel opened in the step before, and the page slides over beside it: a click waits for the page to be still.)
    await pageStill(ed);
    const r = await ed.rectOf("#now", 0.3);
    await ed.click(r.x, r.y);
    await expect.poll(async () => (await ed.toast()).text).toMatch(/changed by the page's script after it loaded/);
    await ed.page.click("#toast .toast-fix");
    await expect.poll(async () => (await agentBox(ed)).sent).toBe(1);
    expect(await ed.eval<string>(`document.querySelector(".msg-user").textContent`)).toContain(
      "Fix the problem with this page that the editor reported"
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
  let files: () => Promise<string[]>;
  let loaded: number;
  const LOADED = { loaded: true };

  test("from a page in a folder, a dropped image is in the document's images/, and its src reaches it", async ({ tab }) => {
    // A folder has an image's name, and a file has another's: the steps below meet both.
    ({ ed, files } = await openDropPage(tab, s, { "images/clash.png/a.txt": "x", "images/dot.png": "old" })); // page load 1
    loaded = await ed.frame<number>(`performance.timeOrigin`);
    await drop(ed, "p.lede", 6, png("pin.png"));
    await expect.poll(() => images(ed), UPLOAD).toEqual([{ src: "../images/pin.png", alt: "pin.png", loaded: true }]);
    expect(await files()).toEqual(expect.arrayContaining(["images/pin.png"]));
  });

  test("a dropped file that isn't an image goes into files/, as a link to it with its name", async () => {
    expect(await drop(ed, "p.lede", 6, [{ name: "notes.txt", type: "text/plain" }])).toEqual({ stopped: true, shown: true });
    await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="lede">Build <a href="../files/notes.txt">notes.txt</a><em>cool</em>`);
    expect(await files()).toEqual(expect.arrayContaining(["files/notes.txt"]));
    // The link opens the file.
    expect(await ed.frame<string>(`fetch(${F}.querySelector('a[href="../files/notes.txt"]').href).then((r) => r.text())`)).toBe(
      "some notes"
    );
  });

  test("an image dropped on the upper half of a paragraph goes before it, wherever in the line; on an empty line, it fills it", async () => {
    await drop(ed, "p.lede", 4, png("start.png"), "top");
    await expect.poll(() => ed.source(), UPLOAD).toContain(`${CENTRED("../images/start.png")}\n  <p class="lede">Build`);
    await drop(ed, "p.tail", 3, png("end.png"), "bottom");
    await expect.poll(() => ed.source(), UPLOAD).toContain(`before the rain.</p>\n  ${CENTRED("../images/end.png")}\n</body>`);
    await drop(ed, "p.empty", 0, png("empty.png"));
    await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="empty">${IMG("../images/empty.png")}</p>`);
    await expect.poll(async () => (await images(ed)).every((i) => i.loaded) && (await images(ed)).length, UPLOAD).toBe(4);
  });

  test("images dropped on the lower half of a paragraph go after it, in order, centred, each a paragraph of its own, into images/", async () => {
    // A file of that name is there already: the new one gets the next name.
    expect(await drop(ed, "p.lede", 6, [...png("dot.png"), ...png("two.png")], "bottom")).toEqual({ stopped: true, shown: true });
    await expect
      .poll(async () => (await images(ed)).filter((i) => /dot|two/.test(i.src)), UPLOAD)
      .toEqual([
        { src: "../images/dot-2.png", alt: "dot-2.png", ...LOADED },
        { src: "../images/two.png", alt: "two.png", ...LOADED },
      ]);
    expect(await ed.frame<boolean>(`!${F}.querySelector("erga-drop-caret, erga-drop-note, erga-drop-image")`)).toBe(true);
    expect(await ed.source()).toContain(`ship them.</p>\n  ${CENTRED("../images/dot-2.png")}\n  ${CENTRED("../images/two.png")}\n  <p`);
    expect(await files()).toEqual(expect.arrayContaining(["images/dot.png", "images/dot-2.png", "images/two.png"]));
  });

  test("a pasted screenshot goes in at the caret", async () => {
    const at = await ed.charAt("p.lede", 3);
    await ed.click(at.x, at.y);
    await pasteFiles(ed, png("image.png"));
    await expect
      .poll(async () => (await images(ed)).find((i) => i.alt == "image.png"), UPLOAD)
      .toEqual({ src: "../images/image.png", alt: "image.png", ...LOADED });
    expect(await ed.source()).toMatch(/<p class="lede">Bu[a-z]*<img src="\.\.\/images\/image.png" alt="image.png">[a-z]* <a /);
    expect(await files()).toEqual(expect.arrayContaining(["images/image.png"]));
  });

  test("a file that can't be added says why where it was dropped, and nothing goes into the text", async ({ tab }) => {
    // A folder has the image's name: the server refuses the file.
    const before = await ed.source();
    expect((await drop(ed, "h1", 3, png("clash.png"))).stopped).toBe(true);
    await expect
      .poll(() => ed.frame<string>(`${F}.querySelector("erga-drop-note")?.textContent ?? ""`))
      .toMatch(/^Couldn't add clash\.png: There's a folder at images\/clash\.png/);
    // Near the drop: just under the heading's text.
    const near = await ed.frame<boolean>(
      `(() => { const n = ${F}.querySelector("erga-drop-note").getBoundingClientRect(), h = ${F}.querySelector("h1").getBoundingClientRect(); return n.top >= h.top && n.top <= h.bottom + 20; })()`
    );
    expect(near).toBe(true);
    expect(await ed.source()).toBe(before);
    // (The browser logs the refused upload as an error: the one error this page may have.)
    const refused = (e: string) => /Failed to load resource/.test(e);
    await until(() => tab.errors.some(refused), 3000, "the browser logs the refused upload");
    tab.errors.splice(0, tab.errors.length, ...tab.errors.filter((e) => !refused(e)));
  });

  test("the page did not load again for the new files; after a reload, every image is there", async () => {
    // (The shell makes the page afresh for a stylesheet or a script that changes, not for a file.)
    expect(await ed.frame<number>(`performance.timeOrigin`)).toBe(loaded);
    const before = await images(ed);
    expect(before.length).toBe(7);
    await ed.page.reload(); // page load 2
    await ed.loaded();
    await expect.poll(() => images(ed), UPLOAD).toEqual(before);
  });
});

type Problem = { text: string; shown: boolean; fix: boolean; fixDisabled: string | null; fixTitle: string };
/** The problem that the tab shows: its text, and its fix button. */
const problem = (ed: Editor) =>
  ed.eval<Problem>(
    `(() => { const t = document.getElementById("toast"), b = t.querySelector(".toast-fix"); return { text: t.querySelector(".toast-text")?.textContent ?? t.textContent, shown: t.classList.contains("show"), fix: !!b, fixDisabled: b?.getAttribute("aria-disabled") ?? null, fixTitle: b?.title ?? "" }; })()`
  );

journey("a broken page says what is wrong, one problem at a time", () => {
  let ed: Editor;
  let first: Problem;

  test("a broken page says what's wrong by itself, with a button to have the agent fix it", async ({ tab }) => {
    // The page's script error is the point.
    ed = await openEditor(tab, s, "broken", { allowErrors: true }); // the journey's one page load
    await expect.poll(async () => (await problem(ed)).shown).toBe(true);
    // The button says "Connecting to the agent…" until the agent's state comes, which can be after the page's problems.
    await expect.poll(async () => (await problem(ed)).fixTitle).toBe("");
    first = await problem(ed);
    expect(first.text).toMatch(/missing\.css|drawTheChart/);
    expect(first.fix).toBe(true);
    expect(first.fixDisabled).toBeNull();
  });

  test("a problem closes with its × button and with Escape; between them the two name the stylesheet and the script error; none comes back when the page loads again", async () => {
    await ed.eval(`document.querySelector("#toast .toast-close").click()`);
    await expect
      .poll(async () => {
        const t = await problem(ed);
        return t.shown && t.text != first.text;
      })
      .toBe(true);
    const second = await problem(ed);
    const both = `${first.text} ${second.text}`;
    expect(both).toMatch(/stylesheet “missing\.css”/);
    expect(both).toMatch(/drawTheChart is not defined/);
    // The caret in the text: Escape goes to the shell (the frame passes it on), which closes the problem first.
    await ed.clickEnd("h1");
    await ed.press("Escape");
    await expect.poll(async () => (await problem(ed)).shown).toBe(false);
    // The page made afresh: its script throws again, and its stylesheet fails again. Neither shows again.
    await ed.frame(`ergaFrame.page.render()`);
    await ed.loaded();
    // The new page's editor has taken its problems (client/inline/page-problems.ts), and the tab has heard them.
    await until(
      () => ed.frame<boolean>(`!!window.__ergaReport && document.readyState == "complete"`),
      5000,
      "the page reports its problems"
    );
    await ed.settle();
    expect((await problem(ed)).shown, both).toBe(false);
  });
});
