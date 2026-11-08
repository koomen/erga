// Comments in the editor (libs/text/ui/comments.ts), with real keys: ⌘⌥M on a selection, Enter sends, Esc closes; the
// thread's card with Reply and ✓; "Resolved · Undo"; the shell's word erga-comments hides and shows them. The page shows
// a comment's highlight as "{...}" in the visible snapshot: a CSS highlight over the text, never in the page's HTML.
import { expect, servers, test } from "../../helpers/fixtures";
import { openEditor, type Editor } from "../../helpers/editor";
import { runTool } from "../../helpers/tools";

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
