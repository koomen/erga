// A person who "Can comment" comments (client/inline/viewer-comment.ts): they open the document in the viewer, with no
// editor and no pencil; they select text with the mouse, and a "Comment" button shows at the selection. The comment's
// box and the threads are the editor's own (libs/text/ui/comments.ts). The keys they type never change the text.
import { expect, servers, test, until } from "../../helpers/fixtures";
import { editor } from "../../helpers/editor";
import { runTool } from "../../helpers/tools";
import { newDoc, unique } from "../access/access";

await servers.main();

const TEXT = "We go to Lisbon in May, before the crowds.";

test("a commenter selects text, presses Comment, and sends a comment; the owner's comment shows; no key changes the text", async ({
  tab,
}) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const address = (root + made.at).replace(/[?&]edit=?$/, "");
  const ada = unique("ada");
  const source = `<!doctype html>\n<html>\n<body>\n<h1>Trip</h1>\n<p>${TEXT}</p>\n</body>\n</html>\n`;
  expect((await fetch(`${root}/d/${made.id}/api/stored/index.html`, { method: "PUT", body: source })).ok).toBe(true);
  expect((await runTool(root, "share_document", { document: made.id, login: ada, role: "commenter" })).error).toBeUndefined();
  // The owner's own comment, on the heading.
  expect(
    (await runTool(root, "comment", { document: made.id, action: "add", page: "index.html", quote: "Trip", text: "A better title?" })).error
  ).toBeUndefined();

  await page.goto(`${address}?user=${ada}`);
  const ed = editor(page, { address, dir: "", file: "" });
  await until(() => ed.frame<boolean>("!!window.ergaFrame?.page"), 10_000, "the comments are up");
  // (The page shows each change in place from now on: the viewer's own reload stops.)
  await until(() => page.evaluate(() => document.body.classList.contains("erga-commenting")), 5000, "the viewer hears of the comments");
  // No pencil, and nothing on the page is editable.
  expect(await page.locator(".erga-edit-button").count()).toBe(0);
  expect(await ed.frame<boolean>("document.body.isContentEditable")).toBe(false);
  const cards = () => ed.comments<string[]>(`[...C.querySelectorAll(".card.th")].map((c) => c.innerText.replace(/\\s+/g, " ").trim())`);
  // The owner's thread shows, with its highlight.
  await expect.poll(async () => (await cards())?.length).toBe(1);
  expect((await cards())![0]).toContain("A better title?");
  expect(await ed.frame<boolean>(`CSS.highlights.has("erga-comment")`)).toBe(true);

  // She selects "Lisbon in May" with the mouse.
  const at = await ed.frame<{ x1: number; x2: number; y: number }>(`(() => {
    const t = document.querySelector("p").firstChild, r = document.createRange();
    r.setStart(t, ${TEXT.indexOf("Lisbon")}); r.setEnd(t, ${TEXT.indexOf(", before")});
    const b = r.getBoundingClientRect(); return { x1: b.left, x2: b.right, y: b.top + b.height / 2 };
  })()`);
  const f = await page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.mouse.move(f.x + at.x1, f.y + at.y);
  await page.mouse.down();
  await page.mouse.move(f.x + (at.x1 + at.x2) / 2, f.y + at.y, { steps: 4 });
  await page.mouse.move(f.x + at.x2, f.y + at.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => ed.frame<string>("String(getSelection())")).toBe("Lisbon in May");

  // The Comment button shows at the selection; a click opens the box, and Enter sends.
  await ed.clickIn("erga-comments", "#cbtn");
  await ed.clickIn("erga-comments", ".card.draft textarea");
  await page.keyboard.type("June is cheaper?");
  await page.keyboard.press("Enter");
  await until(async () => (await cards())?.some((c) => c.includes("June is cheaper?")), 5000, "her comment shows");
  const read = await runTool(root, "comments", { document: made.id });
  const threads = (read.result as { threads: { quote: string; comments: { by: string; text: string }[] }[] }).threads;
  expect(threads.map((t) => [t.quote, t.comments[0].by, t.comments[0].text]).sort()).toEqual(
    [
      ["Lisbon in May", ada, "June is cheaper?"],
      ["Trip", "tester", "A better title?"],
    ].sort()
  );

  // Keys on the page change nothing.
  await page.mouse.click(f.x + at.x2 + 4, f.y + at.y);
  await page.keyboard.type("xyz");
  await page.keyboard.press("Backspace");
  expect(await ed.frame<string>(`document.querySelector("p").textContent`)).toBe(TEXT);
  expect(await (await fetch(`${root}/d/${made.id}/doc/index.html`)).text()).toContain(`<p>${TEXT}</p>`);
});

test("a viewer gets no comments: no button and no threads", async ({ tab }) => {
  const page = tab.page;
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const address = (root + made.at).replace(/[?&]edit=?$/, "");
  const bo = unique("bo");
  expect((await runTool(root, "share_document", { document: made.id, login: bo, role: "viewer" })).error).toBeUndefined();
  await page.goto(`${address}?user=${bo}`);
  await page.locator("#frame").waitFor();
  await page.waitForLoadState("load");
  const frame = page.frames().find((x) => x != page.mainFrame())!;
  await frame.waitForLoadState("load");
  const has: boolean = await frame.evaluate("!!document.querySelector('erga-comments') || !!window.ergaFrame");
  expect(has).toBe(false);
});
