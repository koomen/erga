// Comments on a document: a person comments on a selection in the editor (the box, reply, resolve, undo, edit, a
// phone's sheet), asks their agent with @erga, which runs at once, and a person who "Can comment" comments from the viewer and can change
// no text. The page shows a comment's highlight as "{...}" in the visible snapshot: a CSS highlight, never in its HTML.
import { agentClosed, expect, journey, servers, test, until } from "../helpers/fixtures";
import { editor, openEditor, type Editor } from "../helpers/editor";
import { newToken } from "../helpers/new-token";
import { clickOn } from "../helpers/press";
import { runTool } from "../helpers/tools";
import { secondPage } from "../sync/room";
import {
  boxFocused,
  cards,
  clickBox,
  conversation,
  onScreen,
  selectText,
  signIn,
  slotOnScreen,
  theBox,
  threadsOf,
  unique,
} from "./comments";

const s = await servers.main();

const TEXT = "We go to Lisbon in May, before the crowds.";
/** The owner's thread, as its card shows it after each step. */
const ASKED = "T tester now June is cheaper? T tester now Or July.";

journey("comments in the editor", () => {
  let ed: Editor;
  /** The document's id, and the id of the thread on "Lisbon in May". */
  let id = "";
  let thread = "";
  /** The tab's size, before the phone's. */
  let wide = { width: 0, height: 0 };
  const cy = unique("cy");

  test("the new comment's box is Erga's, over its card: one line high, it grows as the text wraps; Esc closes it, and nothing is sent", async ({
    tab,
  }) => {
    // (Real time: "Resolved · Undo" stays for 6 s, and for 0.6 s at the tests' usual speed.)
    // A window of 1440 px, and a page with a column of 40rem: room for the rail beside it, at 100%.
    await tab.page.setViewportSize({ width: 1440, height: 900 });
    ed = await openEditor(tab, s, "column", { timescale: 1 }); // the one page load of this journey
    wide = tab.page.viewportSize()!;
    id = (await ed.eval<string>(`document.querySelector('meta[name="erga-base"]').content`)).replace(/^\/d\//, "");
    await ed.clickEnd("p");
    await ed.idle();
    await ed.type(TEXT);
    for (let i = 0; i < 20; i++) await ed.press("ArrowLeft");
    for (let i = 0; i < 13; i++) await ed.press("Shift+ArrowLeft");
    await ed.shows(`
      We go to [Lisbon in May], before the crowds.
    `);
    await ed.press("ControlOrMeta+Alt+m");
    await expect.poll(() => cards(ed)).toEqual(["T tester"]);
    // The box is the window's, not the page's (the page's scripts can't reach it), in the card's place for it.
    await boxFocused(ed, "Comment");
    expect(await ed.comments<number>(`C.querySelectorAll("textarea").length`)).toBe(0);
    await ed.type("Or five?");
    const one = (await theBox(ed))!;
    expect(one.value).toBe("Or five?");
    expect(await ed.frame<string>("document.querySelector('p').textContent")).not.toContain("five");
    expect(one.rect).toEqual(await slotOnScreen(ed));
    // One line, with the box's padding and border (5 + 5 + 2) and the text's own (3 + 3): no more.
    expect(one.lines.box - one.lines.line).toBeLessThanOrEqual(18);
    expect(Math.abs(one.lines.boxMid)).toBeLessThanOrEqual(1);
    expect(Math.abs(one.lines.goMid)).toBeLessThanOrEqual(1);
    // Text that wraps: the box grows a line at a time, and so does its place in the card.
    await tab.page.keyboard.insertText(" We could fly out on the Saturday instead, and come back on the Thursday after.");
    await until(async () => (await theBox(ed))!.lines.box >= one.lines.box + one.lines.line, 5_000, "the box grows by a line");
    await expect.poll(async () => (await slotOnScreen(ed)).height).toBe((await theBox(ed))!.rect.height);

    await ed.press("Escape");
    await expect.poll(() => cards(ed)).toEqual([]);
    expect(await theBox(ed)).toBeNull();
    expect(await threadsOf(s.root, id)).toEqual([]);
    await ed.shows(`
      We go to [Lisbon in May], before the crowds.
    `);
  });

  test("⌘⌥M on a selection, then Enter: the comment's card and its highlight show; a reply joins it", async () => {
    await ed.press("ControlOrMeta+Alt+m");
    await expect.poll(() => cards(ed)).toEqual(["T tester"]);
    await boxFocused(ed, "Comment");
    await ed.type("June is cheaper?");
    await ed.press("Enter");
    await expect.poll(() => cards(ed)).toEqual(["T tester now June is cheaper?"]);
    await ed.shows(`
      We go to [{Lisbon in May}], before the crowds.
    `);
    // A reply, in the thread's own box.
    await clickBox(ed, "Reply");
    await ed.type("Or July.");
    await ed.press("Enter");
    await expect.poll(() => cards(ed)).toEqual([ASKED]);
    // In the document's table, as the person wrote it.
    const [t] = await threadsOf(s.root, id);
    thread = t.id;
    expect(t.quote).toBe("Lisbon in May");
    expect(t.comments.map((c) => [c.by, c.text])).toEqual([
      ["tester", "June is cheaper?"],
      ["tester", "Or July."],
    ]);
  });

  test("✓ resolves the thread: it and its highlight go, and Undo brings them back", async () => {
    const pill = () => ed.comments<boolean>(`!C.getElementById("pill").hidden`);
    await ed.clickIn("erga-comments", "[data-act=resolve]");
    await expect.poll(() => cards(ed)).toEqual([]);
    await ed.shows(`
      We go to [Lisbon in May], before the crowds.
    `);
    expect(await pill()).toBe(true);
    await ed.clickIn("erga-comments", "#undo");
    await expect.poll(() => cards(ed)).toEqual([ASKED]);
    await ed.shows(`
      We go to [{Lisbon in May}], before the crowds.
    `);
    expect(await pill()).toBe(false);
  });

  test("the shell hides the comments and shows them again", async () => {
    await ed.toFrame({ type: "erga-comments", show: false });
    await expect.poll(() => cards(ed)).toEqual([]);
    await ed.shows(`
      We go to [Lisbon in May], before the crowds.
    `);
    await ed.toFrame({ type: "erga-comments", show: true });
    await expect.poll(() => cards(ed)).toEqual([ASKED]);
    await ed.shows(`
      We go to [{Lisbon in May}], before the crowds.
    `);
  });

  test("✎ edits one's own comment in its place: Enter saves at once, Esc cancels, a refusal keeps the box; others' have no ✎", async ({
    tab,
  }) => {
    // The server's answers to an edit wait for the test (or the test answers itself with an error).
    let release = () => {};
    let refuse = false;
    await tab.page.route("**/api/tools/comment", async (route) => {
      if (route.request().method() != "POST" || !route.request().postData()?.includes('"edit"')) return route.continue();
      // (The API's refusal as its body says it: a status of 4xx or 5xx would also put an error in the console.)
      if (refuse)
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false,"error":"The server is busy."}' });
      await new Promise<void>((r) => (release = r));
      await route.continue();
    });
    // A reply by another person (a commenter), and one by an agent with the person's token: they come in by themselves.
    expect((await runTool(s.root, "share_document", { document: id, login: cy, role: "commenter" })).error).toBeUndefined();
    const reply = (text: string, as: { cookie?: string; token?: string }) =>
      runTool(s.root, "comment", { document: id, action: "reply", thread, text }, as);
    expect((await reply("Me too.", { cookie: await signIn(s.root, cy) })).ok).toBe(true);
    expect((await reply("Noted.", { token: (await newToken(s.root, { label: "Edit test" })).token })).ok).toBe(true);
    // An agent's comment shows the agent: its name, then whose it is; a shared agent's picture is its label's letter.
    const others = `C ${cy} now Me too. E Edit test tester’s agent now Noted.`;
    await expect.poll(() => cards(ed)).toEqual([`${ASKED} ${others}`]);
    // Only the person's own two comments have a pencil.
    expect(await ed.comments<number>(`C.querySelectorAll("[data-act=edit]").length`)).toBe(2);
    const editBox = async () => {
      const b = await theBox(ed);
      return b?.label == "Edit your comment" ? b.value : null;
    };
    const pending = () => ed.comments<string[]>(`[...C.querySelectorAll(".msg.pending")].map((m) => m.textContent)`);

    // ✎: the text in a box in its place, the caret at its end. Enter: the new text shows at once, pending.
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await expect.poll(editBox).toEqual("June is cheaper?");
    await boxFocused(ed, "Edit your comment");
    for (let i = 0; i < 16; i++) await ed.press("Backspace");
    await ed.type("June, then.");
    await ed.press("Enter");
    await expect.poll(pending).toEqual(["June, then."]);
    expect(await editBox()).toBeNull();
    release();
    const edited = `T tester now · edited June, then. T tester now Or July. ${others}`;
    await expect.poll(() => cards(ed)).toEqual([edited]);
    await expect.poll(pending).toEqual([]);

    // Esc: as it was, and nothing is sent.
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await expect.poll(editBox).toEqual("June, then.");
    await boxFocused(ed, "Edit your comment");
    await ed.type(" Or August.");
    await ed.press("Escape");
    await expect.poll(() => cards(ed)).toEqual([edited]);
    expect(await editBox()).toBeNull();

    // Refused: the box stays open with the text it sent, and the reason above it.
    refuse = true;
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await expect.poll(editBox).toEqual("June, then.");
    await boxFocused(ed, "Edit your comment");
    await ed.type("!");
    await ed.press("Enter");
    await expect.poll(() => ed.comments<string | null>(`C.querySelector(".err")?.textContent ?? null`)).toEqual("The server is busy.");
    expect(await editBox()).toBe("June, then.!");
    await ed.press("Escape");
    await expect.poll(editBox).toEqual(null);
    await tab.page.unroute("**/api/tools/comment");

    // In the table: the new text, and when it was edited.
    const [c] = (await threadsOf(s.root, id))[0].comments;
    expect(c.text).toBe("June, then.");
    expect(c.edited_at).toBeTruthy();
  });

  test("a thread sits by the room on the screen: the rail beside the column, else its card under its text, at its own size", async ({
    tab,
  }) => {
    const page = tab.page;
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    const zoomLabel = () =>
      page.evaluate(() => {
        const b = document.getElementById("btn-zoom")!;
        return b.hidden ? null : b.textContent;
      });
    // 100%: 384 px are free beside the column. The card stands in the rail, 24 px from the column, at its text's top.
    let at = await onScreen(ed, thread);
    expect(at.card!.width).toBe(272);
    near(at.card!.left, at.column.right + 24);
    near(at.card!.top, at.text.top);
    // A click elsewhere closes the thread; the rail keeps its card.
    const elsewhere = await ed.charAt("p", 2);
    await ed.click(elsewhere.x, elsewhere.y);
    await expect.poll(async () => (await cards(ed))?.length).toBe(1);

    // 67%: too little room on the screen for the rail. Only the highlight shows; a click on it opens the card under
    // its text, at the same size on the screen.
    for (let i = 0; i < 4; i++) await ed.press("ControlOrMeta+Minus");
    await expect.poll(zoomLabel).toBe("67%");
    await expect.poll(() => cards(ed)).toEqual([]);
    const word = async () => {
      const t = (await onScreen(ed, thread)).text;
      return { x: t.left + 4, y: (t.top + t.bottom) / 2 };
    };
    let w = await word();
    await ed.click(w.x, w.y);
    await expect.poll(async () => (await cards(ed))?.length).toBe(1);
    const under = async () => {
      at = await onScreen(ed, thread);
      expect(at.card!.width).toBe(320);
      expect(at.card!.top).toBeGreaterThanOrEqual(at.text.bottom + 7);
      expect(at.card!.left).toBeGreaterThanOrEqual(at.place.left);
      expect(at.card!.right).toBeLessThanOrEqual(at.place.right);
    };
    await under();

    // 150%: the page is larger and cut at its sides; the card is the same, in the part of the page that shows.
    await ed.press("ControlOrMeta+0");
    for (let i = 0; i < 3; i++) await ed.press("ControlOrMeta+Equal");
    await expect.poll(zoomLabel).toBe("150%");
    await expect.poll(async () => (await onScreen(ed, thread)).card?.width).toBe(320);
    await under();

    // 100% with the agent's panel open: the page's place is narrower, and the card stays under its text.
    await ed.press("ControlOrMeta+0");
    await expect.poll(zoomLabel).toBe(null);
    await clickOn(page, "#agent-fab");
    await until(() => page.evaluate(() => document.body.classList.contains("agent-open")), 3000, "the agent's panel opens");
    await ed.frameAt();
    await expect.poll(async () => (await onScreen(ed, thread)).card?.width).toBe(320);
    await under();
    await clickOn(page, "#agent-close");
    await until(() => page.evaluate(() => !document.body.classList.contains("agent-open")), 3000, "the agent's panel closes");
    await ed.frameAt();
    await expect.poll(async () => (await onScreen(ed, thread)).card?.width).toBe(272);
  });

  test("a long thread scrolls in its card: the card stays in the window, with its box; every caret is under it", async ({ tab }) => {
    const long = "May is mild, and the trams are less full. ".repeat(8).trim();
    for (const by of ["Ana", "Ben", "Cy"])
      expect((await runTool(s.root, "comment", { document: id, action: "reply", thread, text: `${by}: ${long}` })).ok).toBe(true);
    await until(async () => (await cards(ed))?.some((c) => c.endsWith(`Cy: ${long}`)), 5000, "the long replies show");
    // What the person sees: the card at most 60% of the window high, its box in the window, and the newest reply in view.
    const seen = () =>
      ed.comments<{ card: number; box: number; last: boolean; place: number }>(`(() => {
        const card = C.querySelector(".card.th:not(.dim)"), box = card.querySelector(".slot").getBoundingClientRect();
        const scroll = card.querySelector(".msgs").getBoundingClientRect(), last = [...card.querySelectorAll(".msg")].at(-1).getBoundingClientRect();
        return { card: card.offsetHeight, box: box.bottom, last: last.bottom <= scroll.bottom + 1 && last.top >= scroll.top, place: innerHeight };
      })()`);
    const at = (await seen())!;
    expect(at.card).toBeLessThanOrEqual(Math.ceil(at.place * 0.6));
    expect(at.box).toBeLessThanOrEqual(at.place);
    expect(at.last).toBe(true);
    // The wheel over the card scrolls the thread, not the page.
    const msgs = await ed.comments<{ x: number; y: number }>(
      `(() => { const r = C.querySelector(".card.th:not(.dim) .msgs").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    const f = await ed.frameAt();
    const top = () => ed.comments<number>(`C.querySelector(".card.th:not(.dim) .msgs").scrollTop`);
    const was = (await top())!;
    await tab.page.mouse.move(f.x + msgs!.x, f.y + msgs!.y);
    await tab.page.mouse.wheel(0, -400);
    await until(async () => (await top())! < was, 3000, "the thread scrolls up");
    // The page's caret, in the text again: drawn under the cards, never over them.
    const word = await ed.charAt("p", 2);
    await ed.click(word.x, word.y);
    await ed.idle();
    const z = await ed.frame<number[]>(
      `[getComputedStyle(document.querySelector("erga-caret.on")).zIndex, getComputedStyle(document.querySelector("erga-comments").shadowRoot.querySelector(".card.th")).zIndex].map(Number)`
    );
    expect(z[0]).toBeLessThan(z[1]);
    // A second editor's caret, selection and name: under the cards too.
    const bo = unique("bo");
    expect((await runTool(s.root, "share_document", { document: id, login: bo, role: "editor" })).error).toBeUndefined();
    const other = await secondPage(tab, ed, bo);
    const spot = await other.charAt("p", 4);
    await other.click(spot.x, spot.y);
    await until(() => ed.frame<boolean>(`!!document.querySelector("erga-peers erga-peer")`), 5000, "the other editor's caret shows");
    const peers = await ed.frame<number>(`Number(getComputedStyle(document.querySelector("erga-peers")).zIndex)`);
    expect(peers).toBeLessThan(z[1]);
    await other.page.close();
  });

  test("on a phone, the Comment button opens a sheet at the bottom; a tap on a highlight opens its thread", async ({ tab }) => {
    await tab.page.setViewportSize({ width: 390, height: 760 });
    await ed.clickEnd("p");
    await ed.idle();
    await ed.press("ArrowLeft");
    for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
    await ed.clickIn("erga-controls", "[data-act=comment]");
    await boxFocused(ed, "Comment");
    expect((await theBox(ed))!.rect).toEqual(await slotOnScreen(ed));
    await ed.type("Or five?");
    await ed.press("Enter");
    await expect.poll(() => cards(ed)).toEqual(["T tester now Or five?"]);
    // The sheet: the window's width, at its bottom.
    const sheet = () =>
      ed.comments<number[]>(
        `(() => { const r = C.querySelector(".card.sheet").getBoundingClientRect(); return [r.left, innerWidth - r.right, innerHeight - r.bottom]; })()`
      );
    expect(await sheet()).toEqual([0, 0, 0]);
    // At most half the screen high, and its text shows over it.
    const half = await ed.comments<{ height: number; top: number; text: number }>(`(() => {
      const r = C.querySelector(".card.sheet").getBoundingClientRect(), t = [...CSS.highlights.get("erga-comment-on")][0].getBoundingClientRect();
      return { height: r.height, top: r.top, text: t.bottom };
    })()`);
    expect(half!.height).toBeLessThanOrEqual(380);
    expect(half!.text).toBeLessThanOrEqual(half!.top);
    await ed.shows(`
      We go to {Lisbon in May}, before the [{crowds}].
    `);
    // A tap elsewhere closes it; a tap on the highlight opens it again.
    const elsewhere = await ed.charAt("p", 2);
    await ed.click(elsewhere.x, elsewhere.y);
    await expect.poll(() => cards(ed)).toEqual([]);
    await ed.shows(`
      We| go to {Lisbon in May}, before the {crowds}.
    `);
    const word = await ed.charAt("p", 37);
    await ed.click(word.x, word.y);
    await expect.poll(() => cards(ed)).toEqual(["T tester now Or five?"]);
    expect(await sheet()).toEqual([0, 0, 0]);
  });

  test("@erga in a reply: no question; the thread shows the person's agent at work, then its reply as Erga, their agent; or why none", async ({
    tab,
  }) => {
    const page = tab.page;
    await page.setViewportSize(wide);
    const before = (await conversation(s.root)).items.length;
    // The scripted model's steps ride in the comment, as a person's words would. (Its first waits: "working" shows.)
    const steps = [
      { tool: "edit", args: { op: "comment", action: "reply", thread, text: "Yes: May has fewer people." }, delay: 500 },
      { text: "Replied." },
    ];
    const asked = `@erga what does May mean here? @script ${JSON.stringify(steps)}`;
    // A click on the thread's highlight opens it, with its box for a reply.
    const word = await ed.charAt("p", TEXT.indexOf("Lisbon") + 2);
    await ed.click(word.x, word.y);
    await clickBox(ed, "Reply");
    await page.keyboard.insertText(asked);
    await ed.press("Enter");
    const card = async () => (await cards(ed))?.find((c) => c.includes("June, then.")) ?? "";
    // The box went with the person's session: the agent starts at once, and the thread says so.
    await until(
      async () => (await card()).endsWith(`${asked} Erga tester’s agent working`),
      5_000,
      "the thread shows the agent at work",
      card
    );
    await until(
      async () => (await card()).endsWith(`${asked} Erga tester’s agent now Yes: May has fewer people.`),
      10_000,
      "the agent's reply shows",
      card
    );
    // No question: the agent's panel never asked.
    expect(await page.evaluate(() => document.getElementById("agent-ask")?.hidden ?? true)).toBe(true);
    // Its picture is Erga's mark on black, never the person's letter or colour.
    expect(
      await ed.comments<string[]>(
        `[...C.querySelectorAll('.card.th[data-thread="${thread}"] .who .a')].slice(-1).map((a) => [getComputedStyle(a).backgroundColor, a.querySelector("svg.erga-mark") ? "mark" : a.textContent].join(" "))`
      )
    ).toEqual(["rgb(28, 28, 31) mark"]);
    expect((await threadsOf(s.root, id)).find((t) => t.id == thread)!.comments.slice(-2)).toMatchObject([
      { by: "tester", text: asked },
      { by: "tester", via: "their agent", text: "Yes: May has fewer people." },
    ]);
    // It ran in the person's own conversation, as their message.
    const said = (await conversation(s.root)).items.slice(before).filter((i) => i.kind == "user");
    expect(said.map((i) => i.text)).toEqual([expect.stringMatching(/^In a comment on ".*": @erga what does May mean here\?/)]);

    // A turn that ends with no reply in the thread: "working" goes, and the thread says why.
    const silent = `@erga and June? @script ${JSON.stringify([{ text: "I looked.", delay: 300 }])}`;
    await clickBox(ed, "Reply");
    await page.keyboard.insertText(silent);
    await ed.press("Enter");
    await until(async () => (await card()).endsWith(`${silent} Erga tester’s agent working`), 5_000, "the agent at work", card);
    await until(
      async () => (await card()).endsWith(`${silent} Erga tester’s agent Its turn ended with no reply here.`),
      10_000,
      "the thread says why there's no reply",
      card
    );
  });
});

journey("comments in the viewer", () => {
  let ed: Editor;
  let id = "";
  let address = "";
  /** The tab's requests for a key to the comments. */
  const keys: string[] = [];
  const ada = unique("ada");

  test("a viewer gets no comments: no button and no threads", async ({ tab }) => {
    const made = await runTool<{ id: string; address: string }>(s.root, "create_document", {
      title: unique("Trip "),
      files: { "index.html": `<!doctype html>\n<html>\n<body>\n<h1>Trip</h1>\n<p>${TEXT}</p>\n</body>\n</html>\n` },
    });
    expect(made.error).toBeUndefined();
    id = made.result!.id;
    address = s.root + made.result!.address;
    expect((await runTool(s.root, "share_document", { document: id, login: ada, role: "viewer" })).error).toBeUndefined();
    // The owner's own comment, on the heading.
    expect(
      (await runTool(s.root, "comment", { document: id, action: "add", page: "index.html", quote: "Trip", text: "A better title?" })).error
    ).toBeUndefined();
    const page = tab.page;
    tab.strict = true;
    // A page with comments asks for a key to them as it starts (client/inline/viewer-comment.ts).
    page.on("request", (r) => void (r.url().includes("/api/key") && keys.push(r.url())));
    // (Someone signed in has their agent in the viewer: its pane stays closed here, so the comments have their room.)
    await agentClosed(page);
    await page.goto(`${address}?user=${ada}`);
    await page.locator("#frame").waitFor();
    await page.waitForLoadState("load");
    const frame = page.frames().find((x) => x != page.mainFrame())!;
    await frame.waitForLoadState("load");
    expect(await frame.evaluate<string>("document.querySelector('h1').textContent")).toBe("Trip");
    expect(keys).toEqual([]);
    expect(await frame.evaluate<boolean>("!!document.querySelector('erga-comments') || !!window.ergaFrame")).toBe(false);
    expect(await page.locator(".erga-edit-button").count()).toBe(0);
  });

  test("a commenter sees the owner's comment, selects text, presses Comment, and sends a comment", async ({ tab }) => {
    const page = tab.page;
    expect((await runTool(s.root, "share_document", { document: id, login: ada, role: "commenter" })).error).toBeUndefined();
    await page.reload();
    ed = editor(page, { address, dir: "", file: "" });
    await until(() => ed.frame<boolean>("!!window.ergaFrame?.page"), 10_000, "the comments are up");
    expect(keys.length).toBeGreaterThan(0);
    // (The page shows each change in place from now on: the viewer's own reload stops.)
    await until(() => page.evaluate(() => document.body.classList.contains("erga-commenting")), 5000, "the viewer hears of the comments");
    // No pencil, and nothing on the page is editable.
    expect(await page.locator(".erga-edit-button").count()).toBe(0);
    expect(await ed.frame<boolean>("document.body.isContentEditable")).toBe(false);
    // The owner's thread shows its highlight; with no room for the rail beside the page's text, a click on the
    // highlight opens its card.
    await until(() => ed.frame<boolean>(`CSS.highlights.has("erga-comment")`), 5000, "the owner's highlight shows");
    expect(await cards(ed)).toEqual([]);
    const title = await ed.charAt("h1", 1);
    await ed.click(title.x, title.y);
    await expect.poll(() => cards(ed)).toEqual(["T tester now A better title?"]);
    // The card is over the next line; a click beside the heading closes it.
    const beside = await ed.rectOf("h1", 0.9);
    await ed.click(beside.x, beside.y);
    await expect.poll(() => cards(ed)).toEqual([]);

    // She selects "Lisbon in May" with the mouse.
    await selectText(ed, "p", TEXT.indexOf("Lisbon"), TEXT.indexOf(", before"));
    await expect.poll(() => ed.frame<string>("String(getSelection())")).toEqual("Lisbon in May");
    // The Comment button shows at the selection; a click opens the box, and Enter sends.
    await ed.clickIn("erga-comments", "#cbtn");
    await boxFocused(ed, "Comment");
    await page.keyboard.type("June is cheaper?");
    await page.keyboard.press("Enter");
    await until(async () => (await cards(ed))?.some((c) => c.includes("June is cheaper?")), 5000, "her comment shows");
    // (The card shows before the server has the comment: the server's list is read until it has it.)
    await expect
      .poll(async () => (await threadsOf(s.root, id)).map((t) => [t.quote, t.comments[0].by, t.comments[0].text]).sort())
      .toEqual(
        [
          ["Lisbon in May", ada, "June is cheaper?"],
          ["Trip", "tester", "A better title?"],
        ].sort()
      );
  });

  test("no key that a commenter presses changes the text", async () => {
    const end = await ed.charAt("p", TEXT.indexOf(", before"));
    await ed.click(end.x + 4, end.y);
    await ed.page.keyboard.type("xyz");
    await ed.page.keyboard.press("Backspace");
    expect(await ed.textOf("p")).toBe(TEXT);
    expect(await (await fetch(`${s.root}/d/${id}/doc/index.html`)).text()).toContain(`<p>${TEXT}</p>`);
  });

  test("@erga from a commenter: their agent takes the thread and replies in it, and its edit of the text is refused", async () => {
    const mine = (await threadsOf(s.root, id)).find((t) => t.quote == "Lisbon in May")!.id;
    const steps = [
      { tool: "edit", args: { op: "write", files: { "index.html": "<h1>Gone</h1>" } } },
      { tool: "edit", args: { op: "comment", action: "reply", thread: mine, text: "I can't edit it, only comment." } },
      { text: "Done." },
    ];
    // In person, with her session (not from a page, with its key): her agent starts at once.
    const cookie = await signIn(s.root, ada);
    const text = `@erga fix the title @script ${JSON.stringify(steps)}`;
    const asked = await runTool<{ agent: unknown }>(s.root, "comment", { document: id, action: "reply", thread: mine, text }, { cookie });
    expect(asked.result?.agent).toEqual({ working: true });
    // Its reply comes to her open page by itself: in her thread's card, which a click on its highlight opens.
    const lisbon = await ed.charAt("p", TEXT.indexOf("Lisbon") + 2);
    await ed.click(lisbon.x, lisbon.y);
    await until(
      async () => (await cards(ed))?.some((c) => c.includes(`Erga ${ada}’s agent now I can't edit it, only comment.`)),
      10_000,
      "her agent's reply shows"
    );
    const comments = (await threadsOf(s.root, id)).find((t) => t.id == mine)!.comments;
    expect(comments.at(-1)).toMatchObject({ by: ada, via: "their agent", text: "I can't edit it, only comment." });
    const log = await conversation(s.root, cookie);
    expect(log.items.filter((i) => i.kind == "tool").map((i) => i.status)).toEqual(["error", "done"]);
    expect(await (await fetch(`${s.root}/d/${id}/doc/index.html`)).text()).toContain(`<p>${TEXT}</p>`);
    expect(await ed.textOf("h1")).toBe("Trip");
  });
});
