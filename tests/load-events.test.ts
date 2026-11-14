// An element's load event never comes to the window: the browser stops it at the document, though the element's error
// event goes on to the window. A capture listener for "load" on the window waits for an image that loads, and never
// runs. That kept an uploaded image an empty box (client/inline/reader.ts took the box away at the image's load). So
// no code that runs in a page listens that way: it listens on the document.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIRS = ["client", "libs", "assets/templates"];

/** Every source file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return name == "node_modules" ? [] : sources(path);
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });
}

/** The capture listeners for "load" on the window in `text`: each call's first line. */
export function windowLoadCaptures(text: string): string[] {
  const found: string[] = [];
  // (A call with nothing before it, or on window, self or globalThis: the window's.)
  for (const m of text.matchAll(/(?<![.\w$])(?:(?:window|self|globalThis)\.)?addEventListener\(\s*["']load["']\s*,/g)) {
    // The call's arguments, to its closing parenthesis.
    let depth = 1,
      i = m.index + m[0].length;
    for (; i < text.length && depth; i++) depth += text[i] == "(" ? 1 : text[i] == ")" ? -1 : 0;
    const args = text.slice(m.index, i - 1);
    if (/,\s*true\s*$/.test(args) || /capture\s*:\s*true/.test(args.slice(args.lastIndexOf("{")))) found.push(m[0].replace(/\s+/g, " "));
  }
  return found;
}

test("the check finds a capture listener for load on the window, and no other listener", () => {
  expect(windowLoadCaptures(`addEventListener("load", sized, true);`)).toHaveLength(1);
  expect(windowLoadCaptures(`window.addEventListener(\n  "load",\n  (e) => {\n    go(e.target);\n  },\n  true\n);`)).toHaveLength(1);
  expect(windowLoadCaptures(`addEventListener("load", f, { capture: true, once: true });`)).toHaveLength(1);
  expect(
    windowLoadCaptures(
      `document.addEventListener("load", sized, true); addEventListener("load", start); img.addEventListener("load", f, { once: true });`
    )
  ).toEqual([]);
  expect(windowLoadCaptures(`addEventListener("error", sized, true);`)).toEqual([]);
});

test("no page code waits on the window for an element to load: the listener is on the document", () => {
  const wrong = DIRS.flatMap(sources).flatMap((path) =>
    windowLoadCaptures(readFileSync(join(ROOT, path), "utf8")).map((call) => `${path}: ${call}`)
  );
  expect(wrong).toEqual([]);
});
