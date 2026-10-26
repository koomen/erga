// The scripts and styles the server's pages carry inline are built from client/inline/ (client/build.ts) into a file
// the repository keeps (server/pages/inline-code.ts): it must be the build of those sources as they are now.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INLINE_OUT, inlineCode } from "../client/build.ts";
import { SCRIPTS } from "../server/pages/inline-code.ts";

test("server/pages/inline-code.ts is client/inline/ built as it is now (else: bun client/build.ts --inline)", async () => {
  expect(readFileSync(INLINE_OUT, "utf8")).toBe(await inlineCode());
});

test("each inline script is a function", () => {
  for (const [name, text] of Object.entries(SCRIPTS)) expect(typeof new Function(`return ${text}`)(), name).toBe("function");
});
