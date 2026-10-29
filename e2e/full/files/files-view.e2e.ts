// The files view (/<owner>/<slug>?files: server/pages/files.ts, client/pages/files.ts): every file of a document, any kind,
// stored as text or as a blob (document/blobs.ts); a drop adds files and says what it replaced; rows rename, move and
// delete (a folder asks once); the list follows changes made elsewhere, live.
import type { Page } from "playwright-core";
import { request } from "node:http";
import { expect, servers, test, until, type Server } from "../../helpers/fixtures";
import { runTool } from "../../helpers/tools";

/** A GET of a pages origin's address (<id>-<owner>.localhost, which this process can't look up): to this machine, with its Host. */
function viaHost(url: string): Promise<{ type: string; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: u.port, path: u.pathname + u.search, headers: { Host: u.host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("latin1") }));
    }).on("error", reject).end();
  });
}

await servers.main();

/** A blank document of DEV_LOGIN's (/new), with its address, id and a way to add files over HTTP. */
async function newDoc(server: Server) {
  const at = (await fetch(`${server.root}/new`, { redirect: "manual" })).headers.get("location")!.replace(/[?&]edit$/, "");
  const address = new URL(at, server.root).pathname;
  const { id } = (await (await fetch(`${server.root}${address}/api/name`)).json()) as { id: string };
  return {
    id, address, root: server.root,
    put: (path: string, body: Uint8Array | string) => fetch(`${server.root}/d/${id}/api/files/${path}`, { method: "PUT", body: body as BodyInit }),
    files: async () => ((await (await fetch(`${server.root}/d/${id}/api/files`)).json()) as { files: { path: string; kind: string; size: number }[] }).files,
    tree: (op: object) => fetch(`${server.root}/d/${id}/api/tree`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(op) }),
  };
}

/** A small PDF with one line of text. */
function pdf(line: string): Uint8Array {
  const content = `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A 1x1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const js = <T = unknown>(page: Page, code: string) => page.evaluate(code) as Promise<T>;
const rowPaths = (page: Page) => js<string[]>(page, `[...document.querySelectorAll(".row")].map((r) => r.dataset.path)`);
const status = (page: Page) => js<string>(page, `document.querySelector(".status").textContent`);

async function open(page: Page, doc: { root: string; address: string }) {
  await page.goto(`${doc.root}${doc.address}?files`);
  await until(() => js(page, `document.querySelector("main.files")?.getAttribute("aria-busy") == "false"`), 8000, "the files view lists the files");
}

/** Drops files onto the window as the browser would (their names and contents), into the folder under `target`, if any. */
async function drop(page: Page, files: { name: string; text: string; type?: string }[], target?: string) {
  await page.evaluate(([files, target]) => {
    const dt = new DataTransfer();
    for (const f of files as { name: string; text: string; type?: string }[]) dt.items.add(new File([f.text], f.name, { type: f.type ?? "application/octet-stream" }));
    const at = (target ? document.querySelector(`.row[data-path="${target}"]`) : null) ?? document.querySelector(".view-pane")!;
    for (const type of ["dragenter", "dragover", "drop"]) at.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [files, target ?? null] as const);
}

test("every file shows with its size; a PDF opens in the browser's viewer and an image as it is, both from the pages origin", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const doc = await newDoc(server);
  expect((await doc.put("receipts/goodwill.pdf", pdf("Charitable contribution receipt"))).status).toBe(200);
  expect((await doc.put("chart.png", PNG)).status).toBe(200);
  await open(page, doc);
  expect(await rowPaths(page)).toEqual(["receipts", "receipts/goodwill.pdf", "chart.png", "index.html"]);
  expect(await js<string>(page, `document.querySelector('.row[data-path="chart.png"] .size').textContent`)).toBe(`${PNG.length} B`);
  await page.click(`.row[data-path="receipts/goodwill.pdf"] .name`);
  const src = await until(() => js<string>(page, `document.querySelector(".view-body iframe")?.src ?? ""`), 5000, "the PDF opens in a frame");
  expect(new URL(src).hostname).toContain(`${doc.id}-`);
  const got = await viaHost(src);
  expect(got.type).toBe("application/pdf");
  expect(got.body).toContain("Charitable contribution receipt");
  await page.click(`.row[data-path="chart.png"] .name`);
  await until(() => js(page, `document.querySelector(".view-body img")?.naturalWidth == 1`), 5000, "the image shows");
});

test("a drop adds files to the folder under it; dropped again, the page says it replaced them", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const doc = await newDoc(server);
  await doc.put("notes/readme.md", "# Notes");
  await open(page, doc);
  await drop(page, [{ name: "a.csv", text: "x,y\n1,2\n" }, { name: "b.bin", text: "\u0001\u0002" }], "notes");
  await until(async () => (await status(page)) == "Added 2 files.", 8000, "the page says what it added");
  const files = await doc.files();
  expect(files.find((f) => f.path == "notes/a.csv")).toMatchObject({ kind: "text", size: 8 });
  expect(files.find((f) => f.path == "notes/b.bin")).toMatchObject({ kind: "file", size: 2 });
  await drop(page, [{ name: "a.csv", text: "x,y\n3,4\n" }, { name: "b.bin", text: "\u0003" }], "notes");
  await until(async () => (await status(page)).startsWith("Replaced 2 files"), 8000, "the page says it replaced them");
  expect(await (await fetch(`${server.root}/d/${doc.id}/doc/notes/a.csv`)).text()).toBe("x,y\n3,4\n");
});

test("rename in place, move by dragging onto a folder, delete a file at once and a folder after one question", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const doc = await newDoc(server);
  await doc.put("old.pdf", pdf("one"));
  await doc.put("archive/keep.txt", "kept");
  await open(page, doc);
  // Rename: the pencil, a new name, Enter.
  await page.click(`.row[data-path="old.pdf"] .rename`);
  await page.keyboard.press("Meta+A").catch(() => {});
  await page.evaluate(`document.activeElement.value = "new.pdf"`);
  await page.keyboard.press("Enter");
  await until(async () => (await doc.files()).some((f) => f.path == "new.pdf"), 5000, "the file is renamed");
  // Move: a row dragged onto a folder's row.
  await until(async () => (await rowPaths(page)).includes("new.pdf"), 5000, "the list shows the new name");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("application/x-erga-path", "new.pdf");
    const folder = document.querySelector('.row[data-path="archive"]')!;
    for (const type of ["dragenter", "dragover", "drop"]) folder.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await until(async () => (await doc.files()).some((f) => f.path == "archive/new.pdf"), 5000, "the file moves into the folder");
  // Delete a file: at once.
  await until(async () => (await rowPaths(page)).includes("archive/new.pdf"), 5000, "the list shows the move");
  await page.click(`.row[data-path="archive/new.pdf"] .delete`);
  await until(async () => !(await doc.files()).some((f) => f.path == "archive/new.pdf"), 5000, "the file is deleted");
  // Delete a folder: one question, in place.
  await until(async () => !(await rowPaths(page)).includes("archive/new.pdf"), 5000, "the list shows the delete");
  await page.click(`.row[data-path="archive"] .delete`);
  expect(await js<string>(page, `document.querySelector(".confirm span").textContent`)).toBe("Delete archive and the 1 file in it?");
  await page.click(`.confirm .danger`);
  await until(async () => !(await doc.files()).some((f) => f.path.startsWith("archive/")), 5000, "the folder is deleted");
});

test("the list follows what happens elsewhere: a file added, moved and deleted over the API shows at once", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const doc = await newDoc(server);
  await open(page, doc);
  await doc.put("live.pdf", pdf("live"));
  await until(async () => (await rowPaths(page)).includes("live.pdf"), 5000, "an upload elsewhere shows");
  await doc.tree({ op: "move", from: "live.pdf", to: "moved.pdf" });
  await until(async () => (await rowPaths(page)).includes("moved.pdf"), 5000, "a move elsewhere shows");
  await doc.tree({ op: "delete", path: "moved.pdf" });
  await until(async () => !(await rowPaths(page)).includes("moved.pdf"), 5000, "a delete elsewhere shows");
});

test("someone who may only view sees the files, and no way to change them", async ({ tab }) => {
  const page = tab.page;
  const server = await servers.main();
  const doc = await newDoc(server);
  await doc.put("a.pdf", pdf("a"));
  // Shared with anyone signed in, to view (the operation share_document, as its owner).
  await runTool(server.root, "share_document", { document: doc.id, login: "*", role: "viewer" });
  await page.goto(`${server.root}/auth/github?as=viewer${crypto.randomUUID().slice(0, 6)}&next=${encodeURIComponent(`${doc.address}?files`)}`);
  await until(() => js(page, `document.querySelector("main.files")?.getAttribute("aria-busy") == "false"`), 8000, "the viewer's files view lists the files");
  expect(await rowPaths(page)).toContain("a.pdf");
  expect(await js<number>(page, `document.querySelectorAll(".row .delete, .row .rename").length`)).toBe(0);
  const put = await page.evaluate(`fetch("/d/${doc.id}/api/files/x.txt", { method: "PUT", body: "x" }).then((r) => r.status)`);
  expect(put).toBe(403);
});
