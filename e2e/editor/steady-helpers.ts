// Helpers of the steady journeys (steady.e2e.ts): the agent's box and its scripted run, and files dropped or pasted
// on a page of a document that the server keeps.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editor, F, type Editor } from "../helpers/editor";
import { agentClosed, expect, settle, until, type Server, type Tab } from "../helpers/fixtures";
import { idOf, runTool } from "../helpers/tools";

/** The agent's box: what it holds, whether the panel is open, and how many messages went. */
export const agentBox = (ed: Editor) =>
  ed.eval<{ text: string; open: boolean; sent: number }>(
    `({ text: document.getElementById("agent-input").value, open: document.body.classList.contains("agent-open"), sent: document.querySelectorAll(".msg-user").length })`
  );

/** A new conversation with the person's agent, as the panel's "New conversation" button starts one. */
export async function newConversation(server: Server) {
  const r = await fetch(`${server.root}/api/agent/conversation`, { method: "DELETE", headers: { Origin: server.root } });
  expect(r.ok, `a new conversation: ${r.status}`).toBe(true);
}

/**
 * The page's frame has stopped moving in the tab: it slides over as the agent's panel opens or closes, and a click
 * aimed while it moves lands on the panel.
 */
export const pageStill = async (ed: Editor) => {
  // (Two frames: a slide that a change of class starts has started.)
  await settle(ed.page);
  await until(
    () =>
      ed.eval<boolean>(
        `(() => { const f = document.getElementById("frame"); return !document.getAnimations().some((a) => a.playState == "running" && a.effect?.target?.contains(f)); })()`
      ),
    5000,
    "the page is still"
  );
};

/** Has the person's agent play `steps` (the scripted model, agents/models.ts): a message typed in its box, sent with Enter. */
export async function agentPlays(ed: Editor, steps: object[]) {
  await ed.page.focus("#agent-input");
  await ed.page.keyboard.insertText(`Edit @script ${JSON.stringify(steps)}`);
  await ed.page.keyboard.press("Enter");
}

/** The note on the page while someone holds the lock for source edits, or "". */
export const lockNote = (ed: Editor) => ed.frame<string>(`${F}.querySelector("erga-note")?.shadowRoot?.textContent ?? ""`);

const DROP_PAGE = `<!doctype html>
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
 * A new project of DEV_LOGIN's that the server keeps (as on a deployment: a document on disk takes only text files),
 * with DROP_PAGE as its page blog/post and `files`, open in the editor at that page, in the test's tab.
 */
export async function openDropPage(tab: Tab, server: Server, files: Record<string, string> = {}) {
  const at = (await fetch(`${server.root}/new?kind=project`, { redirect: "manual" })).headers.get("location")!.replace(/[?&]edit$/, "");
  const address = new URL(at, server.root).pathname;
  const id = await idOf(`${server.root}${address}`);
  for (const [path, body] of Object.entries({ "index.html": DROP_PAGE, "blog/post.html": DROP_PAGE, ...files }))
    expect((await fetch(`${server.root}/d/${id}/api/files/${path}`, { method: "PUT", body })).status).toBe(200);
  // Someone who keeps the agent pane closed, and the editor's check that the page shows its HTML (as openEditor).
  await agentClosed(tab.page);
  await tab.page.addInitScript(() => {
    if (window.top == window) (window as unknown as { __ergaCheck: boolean }).__ergaCheck = true;
  });
  tab.strict = true;
  await tab.page.goto(`${server.root}${address}/blog/post?edit`);
  const ed = editor(tab.page, { address: `${server.root}${address}`, dir: "", file: "" });
  await ed.loaded();
  await settle(tab.page);
  return {
    ed,
    id,
    /** The document's address on the server. */
    address,
    /** The document's files, by their paths. */
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

/** A PNG image, for a paste. */
export const png = (name: string): Made[] => [{ name, type: "image/png", png: true }];

/** A folder for the files a test drags, on this machine's disk. */
const DISK = mkdtempSync(join(tmpdir(), "erga-drop-"));
let made = 0;
/** A PNG of 200 by 150 px, one colour. */
const PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(200, 0);
  head.writeUInt32BE(150, 4);
  head.set([8, 2, 0, 0, 0], 8);
  // (Each row: no filter, then its pixels.)
  const rows = Buffer.concat(Array.from({ length: 150 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(600, 0x6f)])));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

/**
 * A file on disk to drag: `name` is a PNG of 200 by 150 px if it ends in .png (with bytes of its own after the image:
 * Erga sends no bytes it keeps already), else text of `bytes` or more, in a folder of its own, or in `folder`.
 */
export function onDisk(name: string, bytes = 10, folder?: string): string {
  const dir = folder ?? join(DISK, String(++made));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const own = `${Date.now()}-${Math.random()}`;
  if (name.endsWith(".png")) writeFileSync(path, Buffer.concat([PNG, Buffer.from(own)]));
  else writeFileSync(path, `some notes ${own} `.repeat(Math.ceil(bytes / (own.length + 12))));
  return path;
}
/** A folder on disk to drag, with `files` in it. */
export function folderOnDisk(name: string, files: string[]): string {
  const dir = join(DISK, String(++made), name);
  for (const f of files) onDisk(f, 10, dir);
  return dir;
}

/**
 * The editor takes a drop: it's on the page, which isn't loading again (an edit the editor can't patch in makes the
 * page afresh, a moment after it shows in the text). A person can't drop sooner.
 */
const takesDrop = (ed: Editor) =>
  until(
    () => ed.frame<boolean>(`!!window.ergaFrame?.page && !ergaFrame.reloading && !ergaFrame.page.rendering`),
    10_000,
    "the editor takes a drop"
  );

/**
 * A point of the page (its frame's coordinates): boundary `i` of the first text of `selector` (0: before its first
 * character; an element with no text: at its start), in the middle of its line, or near the top or bottom of the
 * element (`half`). The element comes into view, as for a person who drags there.
 */
const pointAt = (ed: Editor, selector: string, i: number, half?: "top" | "bottom") =>
  ed.frame<{ x: number; y: number }>(`(() => {
    const el = ${F}.querySelector(${JSON.stringify(selector)}), t = ${F}.createTreeWalker(el, 4).nextNode();
    el.scrollIntoView({ block: "center" });
    const rg = ${F}.createRange(), first = ${i} == 0;
    if (t) { rg.setStart(t, first ? 0 : ${i} - 1); rg.setEnd(t, first ? 1 : ${i}); } else rg.selectNodeContents(el);
    const r = t ? rg.getBoundingClientRect() : el.getBoundingClientRect(), x = first ? r.left + 1 : r.right - 1, box = el.getBoundingClientRect();
    return { x, y: ${JSON.stringify(half ?? "")} == "top" ? box.top + 3 : ${JSON.stringify(half ?? "")} == "bottom" ? box.bottom - 3 : r.top + r.height / 2 };
  })()`);

/** The sign that shows where dragged files will land: its parts, each with its text. */
export const dropSign = (ed: Editor) =>
  ed.frame<string[]>(
    `[...(${F}.querySelector("erga-drop")?.shadowRoot?.querySelectorAll(".c > *") ?? [])].map((e) => (e.className + " " + e.textContent).trim())`
  );

/**
 * Drags `files` (paths on this machine) from the computer over the page, as the browser does it (a real drag: the
 * browser itself makes the events, and tells the page only the files' kinds until the drop), to the point of `selector`
 * that `pointAt` names. Answers the sign the page shows there, and `drop`, which lets them go.
 */
export const drag = async (ed: Editor, selector: string, i: number, files: string[], half?: "top" | "bottom") => {
  await takesDrop(ed);
  const at = await pointAt(ed, selector, i, half);
  const frame = await ed.page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const cdp = await ed.page.context().newCDPSession(ed.page);
  const send = (type: "dragEnter" | "dragOver" | "drop") =>
    cdp.send("Input.dispatchDragEvent", { type, x: frame.x + at.x, y: frame.y + at.y, data: { items: [], files, dragOperationsMask: 1 } });
  await send("dragEnter");
  await send("dragOver");
  await send("dragOver");
  return {
    sign: await dropSign(ed),
    async drop() {
      await send("drop");
      await cdp.detach();
    },
  };
};
/** Drags the files to the point, and drops them. */
export const drop = async (ed: Editor, selector: string, i: number, files: string[], half?: "top" | "bottom") =>
  (await drag(ed, selector, i, files, half)).drop();

/** Pastes files made in the page's frame (a clipboard with files only, as a screenshot is) where the caret is. */
export const pasteFiles = async (ed: Editor, files: Made[]) => {
  await takesDrop(ed);
  return ed.frame(`(async () => {${make(files)}
    ${F}.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
};

/** The files on their way, as the page shows them on their elements: each placeholder and badge, with its text. */
export const pendingParts = (ed: Editor) =>
  ed.frame<string[]>(
    `[...(${F}.querySelector("erga-pending")?.shadowRoot?.querySelectorAll(".c > *:not([hidden])") ?? [])].map((e) => (e.className + " " + e.textContent).trim())`
  );
/** Clicks a button of a file's badge on the page (its action: "cancel", "remove", "raise", "retry"), scrolled into view. */
export const clickBadge = async (ed: Editor, action: string) => {
  const at = await ed.frame<{ x: number; y: number }>(
    `(() => { const b = ${F}.querySelector("erga-pending").shadowRoot.querySelector('[data-action="${action}"]'); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
  );
  const frame = await ed.page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await ed.page.mouse.click(frame.x + at.x, frame.y + at.y);
};

/** The images on the page: their src as written, whether each has loaded, and the size each has on the page. */
export const images = (ed: Editor) =>
  ed.frame<{ src: string; alt: string; loaded: boolean; size: string }[]>(
    `[...${F}.querySelectorAll("body img")].map((i) => ({ src: i.getAttribute("src"), alt: i.alt, loaded: i.complete && i.naturalWidth > 0, size: Math.round(i.getBoundingClientRect().width) + "x" + Math.round(i.getBoundingClientRect().height) }))`
  );

/**
 * How long a drop or paste may take to go in: an upload, and, if the page loads again meanwhile (an edit the editor
 * can't patch in), the wait for the room to have its edits and the page that comes.
 */
export const UPLOAD = { timeout: 10_000 };

/** An image in a line of text, as the source has it: no wider than the text, with its size (a dragged PNG's: onDisk). */
export const IMG = (path: string) =>
  `<img style="max-width: 100%; height: auto" src="${path}" width="200" height="150" alt="${path.slice(path.lastIndexOf("/") + 1)}">`;
/** An image dropped between blocks, as the source has it: centred, a paragraph of its own. */
export const CENTRED = (path: string) => `<p style="text-align: center">${IMG(path)}</p>`;
