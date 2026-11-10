// view_page's words beside its pictures: the size and
// mode the page rendered in, the fonts its text rendered in (a fallback says
// what the page asked for), what was still loading, its script errors, and
// where and when each picture was taken; and when a render takes its picture or runs its code. The render itself:
// e2e/full/page/view-*.e2e.ts.

import { describe, expect, test } from "bun:test";
import { describeView } from "../agents/document/page-tools";
import { renderTimes } from "../shared/agent-log";

const shot = (o: object) => ({ png: "x", width: 1100, height: 800, at: 600, ...o });

describe("describeView", () => {
  test("says the size, the mode and the fonts", () => {
    const text = describeView({
      shots: [shot({})],
      errors: [],
      viewport: { width: 1100, height: 800 },
      colorScheme: "dark",
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
    const text = describeView({
      shots: [shot({ width: 300, height: 40, selector: "h1" })],
      errors: ["boom"],
      pending: ["font Literata 400 normal"],
    });
    expect(text).toContain("Screenshot: 300×40px of h1.");
    expect(text).toContain("Still loading when the picture was taken: font Literata 400 normal.");
    expect(text).toContain("The page threw 1 error(s):\nboom");
    expect(text).not.toContain("Rendered");
  });

  test("names each picture's place and time, when there are several", () => {
    const text = describeView({
      shots: [shot({ width: 300, height: 40, selector: "h1" }), shot({ width: 500, height: 90, selector: "#chart" })],
      errors: [],
      page: "index.html",
    });
    expect(text).toContain("Screenshots (2) of index.html: h1, at 600 ms, 300×40px; #chart, at 600 ms, 500×90px.");
  });
});

describe("renderTimes", () => {
  test("code runs as soon as the page has loaded; a picture waits 600 ms, and a step 1 s", () => {
    expect([
      renderTimes({ evaluate: "1" }),
      renderTimes({}),
      renderTimes({ evaluate: "1", steps: ["2"] }),
      renderTimes({ steps: ["2"] }),
    ]).toEqual([[0], [600], [1000], [1000]]);
  });

  test("the times asked for stand, for code too", () => {
    expect([renderTimes({ evaluate: "1", atMs: 600 }), renderTimes({ evaluate: "1", frames: [0, 300] }), renderTimes({ atMs: 0 })]).toEqual(
      [[600], [0, 300], [0]]
    );
  });
});
