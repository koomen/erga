// Erga's logo (logo/make.ts): the files it makes are portable (outlines, no
// font, no links, no <text>), and the pages that can't import logo/logo.ts
// (page.html, the repo's landing/) hold the wordmark and favicon it made last.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAVICON, WORDMARK } from "../logo/logo";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const pathOf = (svg: string) => svg.match(/ d="([^"]+)"/)?.[1];

test("the SVG files need no font and no other file", () => {
  for (const file of ["logo/erga.svg", "logo/erga-ink.svg", "logo/erga-light.svg", "logo/favicon.svg"]) {
    const svg = read(file);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[-\d ]+"/);
    expect(svg).not.toMatch(/<text|font-family|@font-face|href=|url\(/);
    expect(svg.match(/^<svg[^>]*>/)![0]).not.toMatch(/ (width|height)=/);
  }
  expect(read("logo/erga.svg")).toContain('fill="currentColor"');
});

test("the pages hold the wordmark logo/make.ts made last", () => {
  const word = pathOf(read("logo/erga.svg"));
  expect(word).toBeTruthy();
  expect(pathOf(WORDMARK)).toBe(word);
  expect(read("page.html")).toContain(WORDMARK);
  expect(pathOf(read("landing/index.html").match(/<svg [^>]*class="wordmark"[\s\S]*?<\/svg>/)?.[0] ?? "")).toBe(word);
});

test("the editor's page has the favicon", () => {
  expect(decodeURIComponent(FAVICON.replace(/^data:image\/svg\+xml,/, ""))).toBe(read("logo/favicon.svg").trim());
  expect(read("page.html")).toContain(`<link rel="icon" type="image/svg+xml" href="${FAVICON}">`);
});
