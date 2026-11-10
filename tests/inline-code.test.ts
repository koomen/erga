// The scripts and styles the server's pages carry inline are built from client/inline/ into .build/inline-code.ts
// (client/build.ts), which git ignores: each test run builds it first (tests/helpers/build-inline.ts).
import { expect, test } from "bun:test";
import { SCRIPTS } from "../.build/inline-code.ts";

test("each inline script is a function", () => {
  expect(Object.keys(SCRIPTS)).toContain("account-menu");
  for (const [name, text] of Object.entries(SCRIPTS)) expect(typeof new Function(`return ${text}`)(), name).toBe("function");
});

test("git has no built inline code", () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "*inline-code.ts"], { cwd: `${import.meta.dir}/..` }).stdout.toString();
  expect(tracked).toBe("");
});
