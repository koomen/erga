// view_page's words beside its pictures: the size and
// mode the page rendered in, the fonts its text rendered in (a fallback says
// what the page asked for), what was still loading, its script errors, and
// where and when each picture was taken; and when a render takes its picture or runs its code. The render itself:
// e2e/agent/tools.e2e.ts.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { evaluateIn } from "../client/page-tools/evaluate";
import { describeView } from "../agents/document/page-tools";
import { renderTimes } from "../shared/view-page";
import { setup } from "./helpers/files-fixture";

const shot = (o: object) => ({ data: "x", type: "image/png" as const, width: 1100, height: 800, at: 600, ...o });

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

describe("eval_in_page's expression (client/page-tools/evaluate.ts), in bun's own globals as the page's window", () => {
  /** Runs `expression` as the render does, with what the function reads of a window: its classes, its timer, a document with no #nope. */
  async function evaluate(expression: string) {
    const g = globalThis as Record<string, unknown>;
    const lent = { window: globalThis, document: { querySelector: () => null } };
    const had = Object.fromEntries(Object.keys(lent).map((k) => [k, k in g]));
    for (const [k, v] of Object.entries(lent)) if (!had[k]) g[k] = v;
    // The page's classes that the result's JSON asks about (instanceof): none of these values is one.
    const W = Object.assign(Object.create(globalThis), {
      Element: class {},
      Node: class {},
      CSSStyleDeclaration: class {},
      FontFace: class {},
    });
    try {
      return await evaluateIn(W as Window, expression, 1000);
    } finally {
      for (const k of Object.keys(lent)) if (!had[k]) delete g[k];
    }
  }

  test("an expression that throws, or doesn't parse, says why; cycles, bigints and functions still make JSON", async () => {
    expect((await evaluate(`document.querySelector("#nope").width`)).error).toMatch(/The expression threw: TypeError/);
    expect((await evaluate(`1 +* 2`)).error).toMatch(/doesn't parse/);
    expect((await evaluate(`(() => { const a = { n: 1n, f() {}, u: undefined }; a.self = a; return a; })()`)).value).toBe(
      '{"n":"1n","f":"[function f]","u":null,"self":"[circular]"}'
    );
  });
});

test("an edit that doesn't apply, or a path that isn't a page: nothing renders, and the answer says why", async () => {
  const s = await setup();
  // The server's browser: none is needed, and none may be asked.
  const rendered: unknown[] = [];
  s.deps.render = async (job) => (rendered.push(job), { errors: [] });
  const deck = readFileSync(new URL("../e2e/fixtures/builds/index.html", import.meta.url), "utf8");
  await s.doc.publish({ "index.html": deck }, [], "ada");
  /** A tool's error, as an agent with a token gets it (the app sends the request from its own address). */
  const call = async (name: string, args: object) => {
    const r = await s.doc.handle(
      new Request(`https://erga.test/api/tools/${name}`, {
        method: "POST",
        body: JSON.stringify(args),
        headers: {
          "content-type": "application/json",
          "x-erga-person": JSON.stringify({ id: "ada", name: "Ada" }),
          "x-erga-who": JSON.stringify({ login: "ada" }),
          "x-erga-agent": "token-1",
        },
      })
    );
    return (await r.json()) as { ok: boolean; error?: string };
  };
  const fails = async (name: string, args: object) => {
    const body = await call(name, args);
    expect(body.ok).toBe(false);
    return body.error ?? "";
  };
  const BLUE = { oldText: '<p class="build">Blue.</p>', newText: '<p class="build">Purple, in the preview.</p>' };
  expect(await fails("view_page", { edits: [{ oldText: "Mauve.", newText: "x" }] })).toMatch(
    /^Nothing was rendered: oldText isn't in the current text of index\.html/
  );
  expect(await fails("view_page", { edits: [{ oldText: '<p class="build">', newText: "<p>" }] })).toMatch(
    /oldText matches more than once in index\.html/
  );
  expect(await fails("eval_in_page", { expression: "1", edits: [BLUE], path: "style.css" })).toMatch(
    /^Nothing was rendered: there's no page style\.css in this document/
  );
  expect(await fails("view_page", { path: "missing.html" })).toMatch(/there's no page missing\.html/);
  expect(rendered).toEqual([]);
  // (An edit that applies does reach the browser: the refusals above came before it.)
  await call("view_page", { edits: [BLUE] });
  expect(rendered.length).toBe(1);
});
