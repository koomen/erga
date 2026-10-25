// The scripts the server's pages carry inline are built from client/inline/ (client/build.ts) into a file the
// repository keeps (server/pages/inline-scripts.ts): it must be the build of those sources as they are now.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INLINE_OUT, inlineScripts } from "../client/build.ts";
import { INLINE } from "../server/pages/inline-scripts.ts";

test("server/pages/inline-scripts.ts is client/inline/ built as it is now (else: bun client/build.ts --inline)", async () => {
  expect(readFileSync(INLINE_OUT, "utf8")).toBe(await inlineScripts());
});

test("each inline script is a function", () => {
  for (const [name, text] of Object.entries(INLINE)) expect(typeof new Function(`return ${text}`)(), name).toBe("function");
});
