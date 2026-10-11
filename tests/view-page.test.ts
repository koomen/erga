// view_page's words beside its picture: the size and
// mode the page rendered in, the fonts its text rendered in (a fallback says
// what the page asked for), what was still loading, and its script errors.
// The capture itself, in a browser: e2e/page/view-*.e2e.ts.

import { describe, expect, test } from "bun:test";
import { describeView } from "../agents/document";

describe("describeView", () => {
  test("says the size, the mode and the fonts", () => {
    const text = describeView({
      png: "x", width: 1100, height: 800, errors: [],
      viewport: { width: 1100, height: 800 }, colorScheme: "dark",
      fonts: [
        { family: "Literata", elements: 12, tags: ["p", "li"] },
        { family: "Helvetica Neue", wanted: "Instrument Sans", elements: 1, tags: ["h1"] },
      ],
    });
    expect(text).toContain("Screenshot: 1100×800px, top of the page.");
    expect(text).toContain("Rendered in a 1100×800px window, in dark mode.");
    expect(text).toContain("- Literata: 12 elements (p, li)");
    expect(text).toContain("- Helvetica Neue (the page asked for Instrument Sans, which didn't load or isn't installed): 1 element (h1)");
    expect(text).toContain("No script errors.");
  });

  test("says what was still loading, and the page's errors", () => {
    const text = describeView({ png: "x", width: 300, height: 40, errors: ["boom"], pending: ["font Literata 400 normal"] }, "h1");
    expect(text).toContain("Screenshot: 300×40px of h1.");
    expect(text).toContain("Still loading when the picture was taken: font Literata 400 normal.");
    expect(text).toContain("The page threw 1 error(s):\nboom");
    expect(text).not.toContain("Rendered");
  });
});
