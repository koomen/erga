// A page's problem in words (client/shell/problems.ts), from what the page's problem watch reports
// (client/inline/page-problems.ts): an error thrown in Erga's own code is not the page's problem.

import { expect, test } from "bun:test";
import { describeProblem, isOwnError } from "../client/shell/problems";

// The editor's own scripts are beside the module (in the app, both in /_erga/): one of its chunks.
const OWN = new URL("../client/shell/frame-1a2b3c.js", import.meta.url).href;
const ORIGIN = "https://abcd2345-ada.erga-pages.dev",
  BASE = "/t/token/";

test("an error in Erga's own code is not the page's problem: no message, no fix button", () => {
  // An error thrown in the editor's own script (its file is the editor's), as the desync threw.
  const desync = {
    kind: "script" as const,
    message: "Uncaught Applying change set to a document with the wrong length",
    file: OWN,
    line: 5,
    stack: `RangeError: Applying change set to a document with the wrong length\n    at B.apply (${OWN}:5:4109)`,
  };
  expect(isOwnError(desync)).toBe(true);
  expect(describeProblem(desync, BASE, ORIGIN)).toBeNull();
  // And a rejection with no file, whose stack starts in the editor's code.
  const rejection = {
    kind: "script" as const,
    message: "Unhandled promise rejection: an editor bug",
    file: "",
    line: 0,
    stack: `Error: an editor bug\n    at x (${OWN}:7:1)`,
  };
  expect(isOwnError(rejection)).toBe(true);
  expect(describeProblem(rejection, BASE, ORIGIN)).toBeNull();
  // A page's own error still shows: with the page's file, or with no file and a stack that starts in the page.
  const page = `${ORIGIN}${BASE}index.html`;
  const own = {
    kind: "script" as const,
    message: "Uncaught Error: the page's own error",
    file: page,
    line: 3,
    stack: `Error: the page's own error\n    at ${page}:3:9`,
  };
  expect(isOwnError(own)).toBe(false);
  expect(describeProblem(own, BASE, ORIGIN)).toEqual({
    key: "script:Uncaught Error: the page's own error",
    title: "The page's script hit an error",
    detail: "Uncaught Error: the page's own error (index.html, line 3)",
    fix: "The page's script throws an error in the browser: “Uncaught Error: the page's own error” (index.html, line 3). Find the cause and fix it.",
  });
  // The page's code called by the editor's: the first file of the stack is the page's, so it is the page's problem.
  const called = { ...own, file: "", stack: `Error: the page's own error\n    at render (${page}:3:9)\n    at run (${OWN}:7:1)` };
  expect(isOwnError(called)).toBe(false);
  expect(describeProblem(called, BASE, ORIGIN)?.detail).toMatch(/the page's own error/);
});
