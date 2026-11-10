// Erga's logo: the files it makes are portable (outlines, no
// font, no links, no <text>), and the pages that can't import assets/logo/logo.ts
// (client/editor.html, the repo's assets/landing/) hold the wordmark and favicon it made last.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAVICON, WORDMARK } from "../assets/logo/logo";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pathOf = (svg: string) => svg.match(/ d="([^"]+)"/)?.[1];

test("the SVG files need no font and no other file", () => {
  for (const file of ["assets/logo/erga.svg", "assets/logo/erga-ink.svg", "assets/logo/erga-light.svg", "assets/logo/favicon.svg"]) {
    const svg = read(file);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[-\d ]+"/);
    expect(svg).not.toMatch(/<text|font-family|@font-face|href=|url\(/);
    expect(svg.match(/^<svg[^>]*>/)![0]).not.toMatch(/ (width|height)=/);
  }
  expect(read("assets/logo/erga.svg")).toContain('fill="currentColor"');
});

test("the pages hold the wordmark assets/logo/make.ts made last", () => {
  const word = pathOf(read("assets/logo/erga.svg"));
  expect(word).toBeTruthy();
  expect(pathOf(WORDMARK)).toBe(word);
  expect(pathOf(read("assets/landing/index.html").match(/<svg [^>]*class="wordmark"[\s\S]*?<\/svg>/)?.[0] ?? "")).toBe(word);
});

test("the editor's page has the favicon", () => {
  expect(decodeURIComponent(FAVICON.replace(/^data:image\/svg\+xml,/, ""))).toBe(read("assets/logo/favicon.svg").trim());
  expect(read("client/editor.html")).toContain(`<link rel="icon" type="image/svg+xml" href="${FAVICON}">`);
});

test("the PNG logo (public at /logo.png) is a square of 512 px", () => {
  const png = readFileSync(join(root, "assets/logo/logo.png"));
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([512, 512]);
  expect(read("client/build.ts")).toContain(`place("logo.png", readFileSync(join(ROOT, "assets/logo/logo.png")))`);
});
