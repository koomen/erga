// Comments in the editor (libs/text/ui/comments.ts), with real keys: ⌘⌥M on a selection, Enter sends, Esc closes; the
// thread's card with Reply and ✓; "Resolved · Undo"; the shell's word erga-comments hides and shows them. The page shows
// a comment's highlight as "{...}" in the visible snapshot: a CSS highlight over the text, never in the page's HTML.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";
import { runTool } from "../../helpers/tools";
import { newToken } from "../../helpers/new-token";
import { person } from "../versions/versions";

await servers.main();

/** The cards' text, one string for each card, as the page shows them. */
const cards = (ed: Editor) =>
  ed.comments<string[]>(`[...C.querySelectorAll(".card.th")].map((c) => c.innerText.replace(/\\s+/g, " ").trim())`);
const pill = (ed: Editor) => ed.comments<boolean>(`!C.getElementById("pill").hidden`);

test("comment on a selection with ⌘⌥M, reply, resolve, undo; Esc closes a new one; hidden and shown", async ({ tab }) => {
  const server = await servers.main();
  const ed = await openEditor(tab, server, "empty", { timescale: 1 });
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("We go to Lisbon in May, before the crowds.");
  for (let i = 0; i < 20; i++) await ed.press("ArrowLeft");
  for (let i = 0; i < 13; i++) await ed.press("Shift+ArrowLeft");
  await ed.shows(`
    We go to [Lisbon in May], before the crowds.
  `);

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
  await expect.poll(() => cards(ed)).toEqual(["T tester now June is cheaper? T tester now Or July."]);

  // In the document's table, as the person wrote it.
  const id = (await ed.eval<string>(`document.querySelector('meta[name="erga-base"]').content`)).replace(/^\/d\//, "");
  const read = await runTool(server.root, "comments", { document: id });
  const [thread] = (read.result as { threads: { quote: string; comments: { by: string; text: string }[] }[] }).threads;
  expect(thread.quote).toBe("Lisbon in May");
  expect(thread.comments.map((c) => [c.by, c.text])).toEqual([
    ["tester", "June is cheaper?"],
    ["tester", "Or July."],
  ]);

  // ✓: the thread and its highlight go, and "Resolved · Undo" offers it back.
  await ed.clickIn("erga-comments", "[data-act=resolve]");
  await expect.poll(() => cards(ed)).toEqual([]);
  await ed.shows(`
    We go to [Lisbon in May], before the crowds.
  `);
  expect(await pill(ed)).toBe(true);
  await ed.clickIn("erga-comments", "#undo");
  await expect.poll(() => cards(ed)).toEqual(["T tester now June is cheaper? T tester now Or July."]);
  await ed.shows(`
    We go to [{Lisbon in May}], before the crowds.
  `);
  expect(await pill(ed)).toBe(false);

  // Esc closes a new comment: nothing is sent.
  await ed.press("ArrowRight");
  for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowRight");
  await ed.press("ControlOrMeta+Alt+m");
  await expect.poll(() => cards(ed)).toHaveLength(2);
  await ed.type("Never mind");
  await ed.press("Escape");
  await expect.poll(() => cards(ed)).toHaveLength(1);
  expect(((await runTool(server.root, "comments", { document: id })).result as { threads: unknown[] }).threads).toHaveLength(1);

  // The shell's word: hidden, then shown again.
  await ed.toFrame({ type: "erga-comments", show: false });
  await expect.poll(() => cards(ed)).toEqual([]);
  await ed.shows(`
    We go to Lisbon in May[, befo]re the crowds.
  `);
  await ed.toFrame({ type: "erga-comments", show: true });
  await expect.poll(() => cards(ed)).toHaveLength(1);
  await ed.shows(`
    We go to {Lisbon in May}[, befo]re the crowds.
  `);
});

test("on a phone: the Comment button, a sheet at the bottom; a tap on a highlight opens its thread", async ({ tab }) => {
  await tab.page.setViewportSize({ width: 390, height: 760 });
  const ed = await openEditor(tab, await servers.main(), "empty");
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("Stay six nights in Lisbon.");
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
    Stay six nights in [{Lisbon}].
  `);
  // A tap elsewhere closes it; a tap on the highlight opens it again.
  const elsewhere = await ed.charAt("p", 2);
  await ed.click(elsewhere.x, elsewhere.y);
  await expect.poll(() => cards(ed)).toEqual([]);
  await ed.shows(`
    St|ay six nights in {Lisbon}.
  `);
  const word = await ed.charAt("p", 21);
  await ed.click(word.x, word.y);
  await expect.poll(() => cards(ed)).toEqual(["T tester now Or five?"]);
  expect(await sheet()).toEqual([0, 0, 0]);
});

/**
 * The new comment's box, as the page draws it: its height, its line's height, and how far from the line's middle the
 * box's middle and the send button's middle are (px). The text starts at the box's top, after its padding.
 */
const box = (ed: Editor) =>
  ed.comments<{ box: number; line: number; boxMid: number; goMid: number }>(`(() => {
    const box = C.querySelector(".card.draft .reply"), area = box.querySelector("textarea"), go = box.querySelector(".go");
    const s = getComputedStyle(area), lh = parseFloat(s.lineHeight);
    const b = box.getBoundingClientRect(), a = area.getBoundingClientRect(), g = go.getBoundingClientRect();
    const line = a.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop) + lh / 2;
    return { box: Math.round(b.height), line: Math.round(lh), boxMid: Math.round(b.top + b.height / 2 - line), goMid: Math.round(g.top + g.height / 2 - line) };
  })()`);

for (const [where, width] of [
  ["desktop", 1100],
  ["phone", 390],
] as const)
  test(`${where}: the comment box is one line high, its line and ↑ in its middle; it grows as the text wraps`, async ({ tab }) => {
    await tab.page.setViewportSize({ width, height: 760 });
    const ed = await openEditor(tab, await servers.main(), "empty");
    await ed.clickEnd("p");
    await ed.idle();
    await ed.type("Stay six nights in Lisbon.");
    await ed.press("ArrowLeft");
    for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
    await ed.press("ControlOrMeta+Alt+m");
    await ed.type("Or five?");
    const one = (await box(ed))!;
    // One line, with the box's padding and border (5 + 5 + 2) and the text's own (3 + 3): no more.
    expect(one.box - one.line).toBeLessThanOrEqual(18);
    expect(Math.abs(one.boxMid)).toBeLessThanOrEqual(1);
    expect(Math.abs(one.goMid)).toBeLessThanOrEqual(1);
    // Text that wraps: the box grows a line at a time.
    await ed.type(" We could fly out on the Saturday instead, and come back on the Thursday after.");
    await expect.poll(async () => (await box(ed))!.box).toBeGreaterThanOrEqual(one.box + one.line);
  });

/** The new comment's card, or a thread's: its pending text, whether its box waits, what's in the box, and its error. */
const shape = (ed: Editor, sel: string) =>
  ed.comments<{ pending: string[]; busy: boolean; box: string; error: string | null }>(`(() => {
    const c = C.querySelector(${JSON.stringify(sel)}), area = c.querySelector("textarea");
    return { pending: [...c.querySelectorAll(".msg.pending")].map((m) => m.textContent), busy: area.readOnly, box: area.value,
      error: c.querySelector(".err")?.textContent ?? null };
  })()`);

test("send shows the comment at once, pending, its box empty and waiting; the answer makes it normal; an error puts it back", async ({
  tab,
}) => {
  const ed = await openEditor(tab, await servers.main(), "empty");
  // The server's answers to the comment op wait for the test (or the test answers itself with an error).
  let release = () => {};
  let refuse = false;
  await tab.page.route("**/api/tools/comment?*", async (route) => {
    if (route.request().method() != "POST") return route.continue();
    // (The API's refusal as its body says it: a status of 4xx or 5xx would also put an error in the console.)
    if (refuse) return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false,"error":"The server is busy."}' });
    await new Promise<void>((r) => (release = r));
    await route.continue();
  });
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("Stay six nights in Lisbon.");
  await ed.press("ArrowLeft");
  for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
  await ed.press("ControlOrMeta+Alt+m");
  await ed.type("Or five?");
  await ed.press("Enter");
  // Before the server answers.
  await expect.poll(() => shape(ed, ".card.draft")).toEqual({ pending: ["Or five?"], busy: true, box: "", error: null });
  release();
  await expect.poll(() => cards(ed)).toEqual(["T tester now Or five?"]);
  expect((await shape(ed, ".card.th[data-thread]"))!.pending).toEqual([]);

  // A reply, the same.
  await ed.clickIn("erga-comments", ".card.th textarea");
  await ed.type("Or four.");
  await ed.press("Enter");
  await expect.poll(() => shape(ed, ".card.th[data-thread]")).toEqual({ pending: ["Or four."], busy: true, box: "", error: null });
  release();
  await expect.poll(() => cards(ed)).toEqual(["T tester now Or five? T tester now Or four."]);

  // Refused: the text is back in its box, the reason in the card.
  refuse = true;
  await ed.type("Or three.");
  await ed.press("Enter");
  await expect
    .poll(() => shape(ed, ".card.th[data-thread]"))
    .toEqual({ pending: [], busy: false, box: "Or three.", error: "The server is busy." });
});

test("edit one's own comment: ✎ opens it in its place, Enter saves at once (pending), Esc cancels; others' and agents' have no ✎", async ({
  tab,
}) => {
  const server = await servers.main();
  const ed = await openEditor(tab, server, "empty");
  let release = () => {};
  let refuse = false;
  await tab.page.route("**/api/tools/comment?*", async (route) => {
    if (route.request().method() != "POST" || !route.request().postData()?.includes('"edit"')) return route.continue();
    if (refuse) return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false,"error":"The server is busy."}' });
    await new Promise<void>((r) => (release = r));
    await route.continue();
  });
  await ed.clickEnd("p");
  await ed.idle();
  await ed.type("Stay six nights in Lisbon.");
  await ed.press("ArrowLeft");
  for (let i = 0; i < 6; i++) await ed.press("Shift+ArrowLeft");
  await ed.press("ControlOrMeta+Alt+m");
  await ed.type("June is cheaper?");
  await ed.press("Enter");
  await expect.poll(() => cards(ed)).toEqual(["T tester now June is cheaper?"]);

  // A reply by another person (a commenter), and one by the person's own agent (a token): they come in by themselves.
  const id = (await ed.eval<string>(`document.querySelector('meta[name="erga-base"]').content`)).replace(/^\/d\//, "");
  const thread = ((await runTool(server.root, "comments", { document: id })).result as { threads: { id: string }[] }).threads[0].id;
  const cy = await person(server, "cy");
  expect((await runTool(server.root, "share_document", { document: id, login: "cy", role: "commenter" })).error).toBeUndefined();
  expect(
    (await runTool(server.root, "comment", { document: id, action: "reply", thread, text: "Me too." }, { cookie: cy.cookie })).ok
  ).toBe(true);
  const token = (await newToken(server.root, { label: "Edit test" })).token;
  expect((await runTool(server.root, "comment", { document: id, action: "reply", thread, text: "Noted." }, { token })).ok).toBe(true);
  await expect
    .poll(() => cards(ed))
    .toEqual(["T tester now June is cheaper? C cy now Me too. T tester via a shared agent (Edit test) now Noted."]);
  const pencils = () => ed.comments<number>(`C.querySelectorAll("[data-act=edit]").length`);
  expect(await pencils()).toBe(1);
  const editBox = () => ed.comments<string | null>(`C.querySelector("[data-box=edit]")?.value ?? null`);
  const pending = () => ed.comments<string[]>(`[...C.querySelectorAll(".msg.pending")].map((m) => m.textContent)`);

  // ✎: the text in a box in its place, the caret at its end. Enter: the new text shows at once, pending.
  await ed.clickIn("erga-comments", "[data-act=edit]");
  await expect.poll(editBox).toBe("June is cheaper?");
  for (let i = 0; i < 16; i++) await ed.press("Backspace");
  await ed.type("June, then.");
  await ed.press("Enter");
  await expect.poll(pending).toEqual(["June, then."]);
  expect(await editBox()).toBeNull();
  release();
  await expect
    .poll(() => cards(ed))
    .toEqual(["T tester now · edited June, then. C cy now Me too. T tester via a shared agent (Edit test) now Noted."]);
  expect(await pending()).toEqual([]);

  // Esc: as it was, and nothing is sent.
  await ed.clickIn("erga-comments", "[data-act=edit]");
  await expect.poll(editBox).toBe("June, then.");
  await ed.type(" Or July.");
  await ed.press("Escape");
  await expect.poll(editBox).toBeNull();
  expect((await cards(ed))![0]).toContain("June, then. C cy");

  // Refused: the box stays open with the text it sent, and the reason above it.
  refuse = true;
  await ed.clickIn("erga-comments", "[data-act=edit]");
  await ed.type("!");
  await ed.press("Enter");
  await expect.poll(() => ed.comments<string | null>(`C.querySelector(".err")?.textContent ?? null`)).toBe("The server is busy.");
  expect(await editBox()).toBe("June, then.!");
  await ed.press("Escape");
  await expect.poll(editBox).toBeNull();

  // In the table: the new text, and when it was edited.
  const [c] = (
    (await runTool(server.root, "comments", { document: id })).result as { threads: { comments: { text: string; edited_at?: string }[] }[] }
  ).threads[0].comments;
  expect(c.text).toBe("June, then.");
  expect(c.edited_at).toBeTruthy();
});
