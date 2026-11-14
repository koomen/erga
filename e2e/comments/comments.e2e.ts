// Comments on a document: a person comments on a selection in the editor (the box, reply, resolve, undo, edit, a
// phone's sheet), asks their agent with @erga, and a person who "Can comment" comments from the viewer and can change
// no text. The page shows a comment's highlight as "{...}" in the visible snapshot: a CSS highlight, never in its HTML.
import { expect, journey, servers, test, until } from "../helpers/fixtures";
import { editor, openEditor, type Editor } from "../helpers/editor";
import { newToken } from "../helpers/new-token";
import { clickOn } from "../helpers/press";
import { runTool } from "../helpers/tools";
import { cards, conversation, draftBox, selectText, signIn, threadsOf, unique } from "./comments";

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

  test("the new comment's box is one line high and grows as the text wraps; Esc closes it, and nothing is sent", async ({ tab }) => {
    // (Real time: "Resolved · Undo" stays for 6 s, and for 0.6 s at the tests' usual speed.)
    ed = await openEditor(tab, s, "empty", { timescale: 1 }); // the one page load of this journey
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
    await ed.type("Or five?");
    const one = (await draftBox(ed))!;
    // One line, with the box's padding and border (5 + 5 + 2) and the text's own (3 + 3): no more.
    expect(one.box - one.line).toBeLessThanOrEqual(18);
    expect(Math.abs(one.boxMid)).toBeLessThanOrEqual(1);
    expect(Math.abs(one.goMid)).toBeLessThanOrEqual(1);
    // Text that wraps: the box grows a line at a time.
    await tab.page.keyboard.insertText(" We could fly out on the Saturday instead, and come back on the Thursday after.");
    await until(async () => (await draftBox(ed))!.box >= one.box + one.line, 5_000, "the box grows by a line");

    await ed.press("Escape");
    await expect.poll(() => cards(ed)).toEqual([]);
    expect(await threadsOf(s.root, id)).toEqual([]);
    await ed.shows(`
      We go to [Lisbon in May], before the crowds.
    `);
  });

  test("⌘⌥M on a selection, then Enter: the comment's card and its highlight show; a reply joins it", async () => {
    await ed.press("ControlOrMeta+Alt+m");
    await expect.poll(() => cards(ed)).toEqual(["T tester"]);
    await ed.type("June is cheaper?");
    await ed.press("Enter");
    await expect.poll(() => cards(ed)).toEqual(["T tester now June is cheaper?"]);
    await ed.shows(`
      We go to [{Lisbon in May}], before the crowds.
    `);
    // A reply, in the thread's own box.
    await ed.clickIn("erga-comments", ".card.th textarea");
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
    await tab.page.route("**/api/tools/comment?*", async (route) => {
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
    const others = `C ${cy} now Me too. T tester via a shared agent (Edit test) now Noted.`;
    await expect.poll(() => cards(ed)).toEqual([`${ASKED} ${others}`]);
    // Only the person's own two comments have a pencil.
    expect(await ed.comments<number>(`C.querySelectorAll("[data-act=edit]").length`)).toBe(2);
    const editBox = () => ed.comments<string | null>(`C.querySelector("[data-box=edit]")?.value ?? null`);
    const pending = () => ed.comments<string[]>(`[...C.querySelectorAll(".msg.pending")].map((m) => m.textContent)`);

    // ✎: the text in a box in its place, the caret at its end. Enter: the new text shows at once, pending.
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await expect.poll(editBox).toEqual("June is cheaper?");
    for (let i = 0; i < 16; i++) await ed.press("Backspace");
    await ed.type("June, then.");
    await ed.press("Enter");
    await expect.poll(pending).toEqual(["June, then."]);
    expect(await editBox()).toBeNull();
    release();
    const edited = `T tester now · edited June, then. T tester now Or July. ${others}`;
    await expect.poll(() => cards(ed)).toEqual([edited]);
    expect(await pending()).toEqual([]);

    // Esc: as it was, and nothing is sent.
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await expect.poll(editBox).toEqual("June, then.");
    await ed.type(" Or August.");
    await ed.press("Escape");
    await expect.poll(editBox).toEqual(null);
    expect(await cards(ed)).toEqual([edited]);

    // Refused: the box stays open with the text it sent, and the reason above it.
    refuse = true;
    await ed.clickIn("erga-comments", "[data-act=edit]");
    await ed.type("!");
    await ed.press("Enter");
    await expect.poll(() => ed.comments<string | null>(`C.querySelector(".err")?.textContent ?? null`)).toEqual("The server is busy.");
    expect(await editBox()).toBe("June, then.!");
    await ed.press("Escape");
    await expect.poll(editBox).toEqual(null);
    await tab.page.unroute("**/api/tools/comment?*");

    // In the table: the new text, and when it was edited.
    const [c] = (await threadsOf(s.root, id))[0].comments;
    expect(c.text).toBe("June, then.");
    expect(c.edited_at).toBeTruthy();
  });

  test("on a phone, the Comment button opens a sheet at the bottom; a tap on a highlight opens its thread", async ({ tab }) => {
    await tab.page.setViewportSize({ width: 390, height: 760 });
    await ed.clickEnd("p");
    await ed.idle();
    await ed.press("ArrowLeft");
    for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
    await ed.clickIn("erga-controls", "[data-act=comment]");
    await ed.type("Or five?");
    await ed.press("Enter");
    await expect.poll(() => cards(ed)).toEqual(["T tester now Or five?"]);
    // The sheet: the window's width, at its bottom.
    const sheet = () =>
      ed.comments<number[]>(
        `(() => { const r = C.querySelector(".card.sheet").getBoundingClientRect(); return [r.left, innerWidth - r.right, innerHeight - r.bottom]; })()`
      );
    expect(await sheet()).toEqual([0, 0, 0]);
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

  test("@erga in a reply: the agent panel asks first, and Run gives the thread to the person's agent, which replies in it", async ({
    tab,
  }) => {
    const page = tab.page;
    await page.setViewportSize(wide);
    const before = (await conversation(s.root)).items.length;
    // The scripted model's steps ride in the comment, as a person's words would.
    const steps = [
      { tool: "edit", args: { op: "comment", action: "reply", thread, text: "Yes: May has fewer people." } },
      { text: "Replied." },
    ];
    const asked = `@erga check it @script ${JSON.stringify(steps)}`;
    // A click on the thread's highlight opens it, with its box for a reply.
    const word = await ed.charAt("p", TEXT.indexOf("Lisbon") + 2);
    await ed.click(word.x, word.y);
    await ed.clickIn("erga-comments", `.card.th[data-thread="${thread}"] .reply textarea`);
    await page.keyboard.insertText(asked);
    await ed.press("Enter");
    // A script in the page could write such a comment as the person: no agent starts, and their panel asks them.
    await expect
      .poll(() =>
        page.evaluate(() => (document.getElementById("agent-ask")!.hidden ? null : document.getElementById("agent-ask-text")!.textContent))
      )
      .toEqual(asked);
    expect((await conversation(s.root)).items.length).toBe(before);
    await clickOn(page, "#agent-ask-run");
    const card = async () => (await cards(ed))?.find((c) => c.includes("June, then.")) ?? "";
    await until(
      async () => (await card()).includes("T tester via their agent now Yes: May has fewer people."),
      10_000,
      "the agent's reply shows",
      async () => [
        await card(),
        await page.evaluate(`[window.__press?.said, window.__press?.on, document.getElementById("agent-ask").hidden]`),
      ]
    );
    expect((await threadsOf(s.root, id)).find((t) => t.id == thread)!.comments.at(-1)).toMatchObject({
      by: "tester",
      via: "their agent",
      text: "Yes: May has fewer people.",
    });
    // It ran in the person's own conversation, as their message.
    const said = (await conversation(s.root)).items.slice(before).filter((i) => i.kind == "user");
    expect(said.map((i) => i.text)).toEqual([expect.stringMatching(/^In a comment on ".*": @erga check it/)]);
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
    // The owner's thread shows, with its highlight.
    await expect.poll(() => cards(ed)).toEqual(["T tester now A better title?"]);
    expect(await ed.frame<boolean>(`CSS.highlights.has("erga-comment")`)).toBe(true);

    // She selects "Lisbon in May" with the mouse.
    await selectText(ed, "p", TEXT.indexOf("Lisbon"), TEXT.indexOf(", before"));
    await expect.poll(() => ed.frame<string>("String(getSelection())")).toEqual("Lisbon in May");
    // The Comment button shows at the selection; a click opens the box, and Enter sends.
    await ed.clickIn("erga-comments", "#cbtn");
    await ed.clickIn("erga-comments", ".card.draft textarea");
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
    const asked = await runTool<{ agent: string }>(s.root, "comment", { document: id, action: "reply", thread: mine, text }, { cookie });
    expect(asked.result?.agent).toMatch(/took the thread/);
    // Its reply comes to her open page by itself.
    await until(
      async () => (await cards(ed))?.some((c) => c.includes("via their agent now I can't edit it, only comment.")),
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
