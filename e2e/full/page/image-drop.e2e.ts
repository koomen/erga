// Image files dropped on the page in the editor: each goes into the document's files in images/ beside the page, and
// shows in the text where it was dropped, after a reload too. Other files go nowhere, and the browser opens none of
// them. An image that can't be added says why, there on the page. (A document the server keeps, as on a deployment:
// one on disk takes only text files.)
import { expect, servers, settle, test, type Server, type Tab } from "../../helpers/fixtures";
import { editor, F, type Editor } from "../../helpers/editor";

await servers.main();

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch notes</title></head>
<body>
  <h1>Launch notes</h1>
  <p class="lede">Build <em>cool</em> things and ship them.</p>
</body>
</html>
`;

/** A new document of DEV_LOGIN's with PAGE and `files`, open in the editor in the test's tab. */
async function open(tab: Tab, server: Server, files: Record<string, string> = {}) {
  tab.strict = false; // (The browser logs a refused upload as an error.)
  const at = (await fetch(`${server.root}/new`, { redirect: "manual" })).headers.get("location")!.replace(/[?&]edit$/, "");
  const address = new URL(at, server.root).pathname;
  const { id } = (await (await fetch(`${server.root}${address}/api/name`)).json()) as { id: string };
  for (const [path, body] of Object.entries({ "index.html": PAGE, ...files }))
    expect((await fetch(`${server.root}/d/${id}/api/files/${path}`, { method: "PUT", body })).status).toBe(200);
  await tab.page.goto(`${server.root}${address}?edit`);
  const ed = editor(tab.page, { address: `${server.root}${address}`, dir: "", file: "" });
  await ed.loaded();
  await settle(tab.page);
  return {
    ed,
    files: async () =>
      ((await (await fetch(`${server.root}/d/${id}/api/files`)).json()) as { files: { path: string }[] }).files.map((f) => f.path),
  };
}

/**
 * Drops files made in the page's frame just before character `i` of the first text of `selector`: a dragover, then the
 * drop. Returns whether the page stopped the browser's own drop (which would open the file) both times, and whether
 * the dragover showed where the drop goes.
 */
const drop = (ed: Editor, selector: string, i: number, files: { name: string; type: string; png?: boolean }[]) =>
  ed.frame<{ stopped: boolean; shown: boolean }>(`(async () => {
    const png = () => { const c = document.createElement("canvas"); c.width = 40; c.height = 30; const g = c.getContext("2d"); g.fillStyle = "#3a6ff0"; g.fillRect(0, 0, 40, 30); return new Promise((r) => c.toBlob(r, "image/png")); };
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(files)}) dt.items.add(new File([f.png ? await png() : "not an image"], f.name, { type: f.type }));
    const t = ${F}.createTreeWalker(${F}.querySelector(${JSON.stringify(selector)}), 4).nextNode();
    const rg = ${F}.createRange(); rg.setStart(t, ${i} - 1); rg.setEnd(t, ${i});
    const r = rg.getBoundingClientRect(), x = r.right - 1, y = r.top + r.height / 2, at = ${F}.elementFromPoint(x, y);
    const over = new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(over);
    const shown = !!${F}.querySelector("erga-drop-caret");
    const dropped = new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true });
    at.dispatchEvent(dropped);
    return { stopped: over.defaultPrevented && dropped.defaultPrevented, shown };
  })()`);

/** The images in the page's text: their src as written, and whether each has loaded. */
const images = (ed: Editor) =>
  ed.frame<{ src: string; alt: string; loaded: boolean }[]>(
    `[...${F}.querySelectorAll("body img")].map((i) => ({ src: i.getAttribute("src"), alt: i.alt, loaded: i.complete && i.naturalWidth > 0 }))`
  );

test("dropped images go into the document's files and show where they were dropped, after a reload too", async ({ tab }) => {
  // A file of that name is there already: the new one gets the next name.
  const { ed, files } = await open(tab, await servers.main(), { "images/dot.png": "old" });
  expect(
    await drop(ed, "p.lede", 6, [
      { name: "dot.png", type: "image/png", png: true },
      { name: "two.png", type: "image/png", png: true },
    ])
  ).toEqual({ stopped: true, shown: true });
  // After "Build ", in order.
  const want = [
    { src: "images/dot-2.png", alt: "dot-2.png", loaded: true },
    { src: "images/two.png", alt: "two.png", loaded: true },
  ];
  await expect.poll(() => images(ed)).toEqual(want);
  expect(await ed.frame<boolean>(`!${F}.querySelector("erga-drop-caret, erga-drop-note")`)).toBe(true);
  expect(await ed.source()).toContain(
    `<p class="lede">Build <img src="images/dot-2.png" alt="dot-2.png"><img src="images/two.png" alt="two.png"><em>cool</em>`
  );
  expect(await files()).toEqual(expect.arrayContaining(["images/dot.png", "images/dot-2.png", "images/two.png"]));

  await ed.page.reload();
  await ed.loaded();
  await expect.poll(() => images(ed)).toEqual(want);
});

test("a dropped file that isn't an image goes nowhere, and the browser doesn't open it", async ({ tab }) => {
  const { ed, files } = await open(tab, await servers.main());
  const before = await ed.source();
  expect(await drop(ed, "p.lede", 6, [{ name: "notes.txt", type: "text/plain" }])).toEqual({ stopped: true, shown: false });
  await ed.settle();
  expect(await ed.source()).toBe(before);
  expect(await files()).toEqual(["index.html"]);
  expect(await ed.frame<boolean>(`!${F}.querySelector("erga-drop-note")`)).toBe(true);
});

test("an image that can't be added says why where it was dropped, and nothing goes into the text", async ({ tab }) => {
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
