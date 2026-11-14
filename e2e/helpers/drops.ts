// Files dragged from the computer onto a document's page, as the browser does it: a real drag (the browser itself makes
// the events, and tells the page only the files' kinds until the drop), of files on this machine's disk.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Page } from "playwright-core";

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
 * Drags `files` (paths on this machine) over the document's page to a point of it (the page's frame's coordinates).
 * Answers `drop`, which lets them go there.
 */
export async function dragTo(page: Page, at: { x: number; y: number }, files: string[]) {
  const frame = await page.evaluate(() => {
    const r = document.getElementById("frame")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  return dragAt(page, { x: frame.x + at.x, y: frame.y + at.y }, files);
}

/** The same, to a point of the tab (the editor's own parts: the file tree, the agent's panel). */
export async function dragAt(page: Page, at: { x: number; y: number }, files: string[]) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "dragEnter" | "dragOver" | "drop") =>
    cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data: { items: [], files, dragOperationsMask: 1 } });
  await send("dragEnter");
  await send("dragOver");
  await send("dragOver");
  return {
    async drop() {
      await send("drop");
      await cdp.detach();
    },
  };
}

/** In the page's frame: the sign that shows where dragged files will land, each part with its text and its box. */
export const SIGN = `[...(document.querySelector("erga-drop")?.shadowRoot?.querySelectorAll(".c > *") ?? [])].map((e) => { const r = e.getBoundingClientRect(); return { part: (e.className + " " + e.textContent).trim(), box: [r.left, r.top, r.width, r.height].map(Math.round) }; })`;
