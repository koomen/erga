// Files dropped or pasted on the page in the editor go into the document's files, at its top: an image in images/, which
// goes in centred, a paragraph of its own, before or after the paragraph it was dropped on (while it's dragged, a gap
// with a faint image shows where), another file in files/, as a link to it where it was dropped. After a reload too, and from a page in a folder. The browser opens none of them. A file
// that can't be added says why, there on the page. (A document the server keeps, as on a deployment: one on disk takes
// only text files.)
import { expect, servers, settle, test, until, type Server, type Tab } from "../../helpers/fixtures";
import { editor, F, type Editor } from "../../helpers/editor";
import { idOf, runTool } from "../../helpers/tools";

await servers.main();

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch notes</title></head>
<body>
  <h1>Launch notes</h1>
  <p class="lede">Build <em>cool</em> things and ship them.</p>
  <p class="empty"><br></p>
  <p class="tail">We came down before the rain.</p>
</body>
</html>
`;

/**
 * A new document of DEV_LOGIN's with PAGE and `files`, open in the editor in the test's tab at `page` (an address under
 * it; a page in a folder makes it a project).
 */
async function open(tab: Tab, server: Server, files: Record<string, string> = {}, page = "") {
  tab.strict = false; // (The browser logs a refused upload as an error.)
  const at = (await fetch(`${server.root}/new${page ? "?kind=project" : ""}`, { redirect: "manual" })).headers
    .get("location")!
    .replace(/[?&]edit$/, "");
  const address = new URL(at, server.root).pathname;
  const id = await idOf(`${server.root}${address}`);
  for (const [path, body] of Object.entries({ "index.html": PAGE, ...files }))
    expect((await fetch(`${server.root}/d/${id}/api/files/${path}`, { method: "PUT", body })).status).toBe(200);
  await tab.page.goto(`${server.root}${address}${page ? `/${page}` : ""}?edit`);
  const ed = editor(tab.page, { address: `${server.root}${address}`, dir: "", file: "" });
  await ed.loaded();
  await settle(tab.page);
  return {
    ed,
    files: async () =>
      ((await runTool(server.root, "ls", { document: id })).result as { entries: { path: string; type: string }[] }).entries
        .filter((e) => e.type != "folder")
        .map((e) => e.path),
  };
}

type Made = { name: string; type: string; png?: boolean };
/** Makes the files in the page's frame, in a DataTransfer (`dt`). */
const make = (files: Made[]) => `
    const png = () => { const c = document.createElement("canvas"); c.width = 40; c.height = 30; const g = c.getContext("2d"); g.fillStyle = "#3a6ff0"; g.fillRect(0, 0, 40, 30); return new Promise((r) => c.toBlob(r, "image/png")); };
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.png ? await png() : "some notes"], f.name, { type: f.type }));`;

/**
 * The editor takes a drop: it's on the page, which isn't loading again (an edit the editor can't patch in makes the page
 * afresh, a moment after it shows in the text). A person can't drop sooner.
 */
const ready = (ed: Editor) =>
  until(
    () => ed.frame<boolean>(`!!window.ergaFrame?.page && !ergaFrame.reloading && !ergaFrame.page.rendering`),
    10_000,
    "the editor takes a drop"
  );

/**
 * Drops files made in the page's frame at boundary `i` of the first text of `selector` (0: before its first character; an
 * element with no text: at its start), in the middle of its line, or near the top or bottom of the element (`half`):
 * a dragover, then the drop. Returns whether the page stopped the browser's own drop (which would open the file) both
 * times, and whether the dragover showed where the drop goes.
 */
const drop = async (ed: Editor, selector: string, i: number, files: Made[], half?: "top" | "bottom") => {
  await ready(ed);
  return ed.frame<{ stopped: boolean; shown: boolean }>(`(async () => {${make(files)}
    const el = ${F}.querySelector(${JSON.stringify(selector)}), t = ${F}.createTreeWalker(el, 4).nextNode();
    const rg = ${F}.createRange(), first = ${i} == 0;
    if (t) { rg.setStart(t, first ? 0 : ${i} - 1); rg.setEnd(t, first ? 1 : ${i}); } else rg.selectNodeContents(el);
    const r = t ? rg.getBoundingClientRect() : el.getBoundingClientRect(), x = first ? r.left + 1 : r.right - 1, box = el.getBoundingClientRect();
    const y = ${JSON.stringify(half ?? "")} == "top" ? box.top + 3 : ${JSON.stringify(half ?? "")} == "bottom" ? box.bottom - 3 : r.top + r.height / 2, at = ${F}.elementFromPoint(x, y);
    const over = new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(over);
    const shown = !!${F}.querySelector("erga-drop-caret, erga-drop-image");
    const dropped = new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(dropped);
    return { stopped: over.defaultPrevented && dropped.defaultPrevented, shown };
  })()`);
};

/** Pastes files made in the page's frame (a clipboard with files only, as a screenshot is) where the caret is. */
const paste = async (ed: Editor, files: Made[]) => {
  await ready(ed);
  return ed.frame(`(async () => {${make(files)}
    ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
};

/** The images on the page: their src as written, and whether each has loaded. */
const images = (ed: Editor) =>
  ed.frame<{ src: string; alt: string; loaded: boolean }[]>(
    `[...${F}.querySelectorAll("body img")].map((i) => ({ src: i.getAttribute("src"), alt: i.alt, loaded: i.complete && i.naturalWidth > 0 }))`
  );

/**
 * How long a drop or paste may take to go in: an upload, and, if the page loads again meanwhile (an edit the editor
 * can't patch in), the wait for the room to have its edits and the page that comes. Seconds when every test runs at once.
 */
const UPLOAD = { timeout: 15_000 };

const IMG = (path: string) => `<img src="${path}" alt="${path.slice(path.lastIndexOf("/") + 1)}">`;
/** An image dropped between blocks: centred, a paragraph of its own. */
const CENTRED = (path: string) =>
  `<p style="text-align: center"><img style="max-width: 100%; height: auto" src="${path}" alt="${path.slice(path.lastIndexOf("/") + 1)}"></p>`;

test("images dropped on the lower half of a paragraph go after it, in order, centred, each a paragraph of its own, into images/, after a reload too", async ({
  tab,
}) => {
  // A file of that name is there already: the new one gets the next name.
  const { ed, files } = await open(tab, await servers.main(), { "images/dot.png": "old" });
  const loaded = await ed.frame<number>(`performance.timeOrigin`);
  const two = [
    { name: "dot.png", type: "image/png", png: true },
    { name: "two.png", type: "image/png", png: true },
  ];
  expect(await drop(ed, "p.lede", 6, two, "bottom")).toEqual({ stopped: true, shown: true });
  const want = [
    { src: "images/dot-2.png", alt: "dot-2.png", loaded: true },
    { src: "images/two.png", alt: "two.png", loaded: true },
  ];
  await expect.poll(() => images(ed), UPLOAD).toEqual(want);
  expect(await ed.frame<boolean>(`!${F}.querySelector("erga-drop-caret, erga-drop-note, erga-drop-image")`)).toBe(true);
  expect(await ed.source()).toContain(
    `ship them.</p>\n  ${CENTRED("images/dot-2.png")}\n  ${CENTRED("images/two.png")}\n  <p class="empty">`
  );
  expect(await files()).toEqual(expect.arrayContaining(["images/dot.png", "images/dot-2.png", "images/two.png"]));
  // The page didn't load again for the new files (the shell makes it afresh for a stylesheet or a script that changes).
  await new Promise((r) => setTimeout(r, 500));
  expect(await ed.frame<number>(`performance.timeOrigin`)).toBe(loaded);

  await ed.page.reload();
  await ed.loaded();
  await expect.poll(() => images(ed), UPLOAD).toEqual(want);
});

test("an image dropped on the upper half of a paragraph goes before it, wherever in the line; on an empty line, it fills it", async ({
  tab,
}) => {
  const { ed } = await open(tab, await servers.main());
  const png = (name: string) => [{ name, type: "image/png", png: true }];
  await drop(ed, "p.lede", 4, png("start.png"), "top");
  await expect.poll(() => ed.source(), UPLOAD).toContain(`${CENTRED("images/start.png")}\n  <p class="lede">Build`);
  await drop(ed, "p.tail", 3, png("end.png"), "bottom");
  await expect.poll(() => ed.source(), UPLOAD).toContain(`before the rain.</p>\n  ${CENTRED("images/end.png")}\n</body>`);
  await drop(ed, "p.empty", 0, png("empty.png"));
  await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="empty">${IMG("images/empty.png")}</p>`);
  await expect.poll(async () => (await images(ed)).map((i) => i.loaded), UPLOAD).toEqual([true, true, true]);
});

test("a dropped file that isn't an image goes into files/, as a link to it with its name", async ({ tab }) => {
  const { ed, files } = await open(tab, await servers.main());
  expect(await drop(ed, "p.lede", 6, [{ name: "notes.txt", type: "text/plain" }])).toEqual({ stopped: true, shown: true });
  await expect.poll(() => ed.source(), UPLOAD).toContain(`<p class="lede">Build <a href="files/notes.txt">notes.txt</a><em>cool</em>`);
  expect(await files()).toEqual(expect.arrayContaining(["files/notes.txt"]));
  // The link opens the file.
  expect(await ed.frame<string>(`fetch(${F}.querySelector('a[href="files/notes.txt"]').href).then((r) => r.text())`)).toBe("some notes");
});

test("while images are dragged over the text, a gap opens before or after the paragraph under the pointer, with a faint image in it, centred; it closes when they leave", async ({
  tab,
}) => {
  const { ed } = await open(tab, await servers.main());
  await ready(ed);
  const seen = await ed.frame<{
    moved: number;
    ghostAbove: boolean;
    centred: boolean;
    frames: number;
    after: boolean;
    closed: boolean;
    back: number;
  }>(`(async () => {${make([{ name: "a.png", type: "image/png", png: true }])}
    const lede = ${F}.querySelector("p.lede"), tail = ${F}.querySelector("p.tail");
    const over = (el, y) => { const r = el.getBoundingClientRect(), x = r.left + 20; el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true })); };
    const top0 = lede.getBoundingClientRect().top;
    over(lede, lede.getBoundingClientRect().top + 3);
    const g = ${F}.querySelector("erga-drop-image"), gr = g.getBoundingClientRect(), lr = lede.getBoundingClientRect();
    const moved = lr.top - top0, ghostAbove = gr.bottom <= lr.top, centred = Math.abs((gr.left + gr.right) / 2 - (lr.left + lr.right) / 2) < 2;
    const frames = g.querySelectorAll("span").length;
    over(tail, tail.getBoundingClientRect().bottom - 3);
    const after = ${F}.querySelector("erga-drop-image").getBoundingClientRect().top >= tail.getBoundingClientRect().bottom;
    ${F}.body.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { moved, ghostAbove, centred, frames, after, closed: !${F}.querySelector("erga-drop-image"), back: lede.getBoundingClientRect().top - top0 };
  })()`);
  expect(seen.moved).toBeGreaterThanOrEqual(120);
  expect(seen).toMatchObject({ ghostAbove: true, centred: true, frames: 1, after: true, closed: true, back: 0 });
});

test("a pasted screenshot goes in at the caret", async ({ tab }) => {
  const { ed, files } = await open(tab, await servers.main());
  const at = await ed.charAt("p.lede", 3);
  await ed.click(at.x, at.y);
  await paste(ed, [{ name: "image.png", type: "image/png", png: true }]);
  await expect.poll(() => images(ed), UPLOAD).toEqual([{ src: "images/image.png", alt: "image.png", loaded: true }]);
  expect(await ed.source()).toMatch(/<p class="lede">Bu[a-z]*<img src="images\/image.png" alt="image.png">[a-z]* <em>/);
  expect(await files()).toEqual(expect.arrayContaining(["images/image.png"]));
});

test("from a page in a folder, the image is in the document's images/, and its src reaches it", async ({ tab }) => {
  const { ed, files } = await open(tab, await servers.main(), { "blog/post.html": PAGE }, "blog/post");
  await drop(ed, "p.lede", 6, [{ name: "dot.png", type: "image/png", png: true }]);
  await expect.poll(() => images(ed), UPLOAD).toEqual([{ src: "../images/dot.png", alt: "dot.png", loaded: true }]);
  expect(await files()).toEqual(expect.arrayContaining(["images/dot.png"]));
});

test("a file that can't be added says why where it was dropped, and nothing goes into the text", async ({ tab }) => {
  // A folder has the image's name: the server refuses the file.
  const { ed } = await open(tab, await servers.main(), { "images/clash.png/a.txt": "x" });
  const before = await ed.source();
  expect((await drop(ed, "h1", 3, [{ name: "clash.png", type: "image/png", png: true }])).stopped).toBe(true);
  await expect
    .poll(() => ed.frame<string>(`${F}.querySelector("erga-drop-note")?.textContent ?? ""`))
    .toMatch(/^Couldn't add clash\.png: There's a folder at images\/clash\.png/);
  // Near the drop: just under the heading's text.
  const near = await ed.frame<boolean>(
    `(() => { const n = ${F}.querySelector("erga-drop-note").getBoundingClientRect(), h = ${F}.querySelector("h1").getBoundingClientRect(); return n.top >= h.top && n.top <= h.bottom + 20; })()`
  );
  expect(near).toBe(true);
  expect(await ed.source()).toBe(before);
});
