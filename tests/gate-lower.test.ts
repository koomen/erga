// The gate's CloudFront build changes syntax (gate/lower.ts): the runtime cloudfront-js-2.0 refuses spread,
// destructuring, default parameters, `?.`, `??`, `??=`, `for...of`, `catch {}` and an await inside a call's arguments.
// The change must keep what the code does: here the same code runs as written and as lowered, and both must do the
// same things in the same order. (tests/gate-mounts.test.ts runs the gate's own functions as built.)

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { lower, refused } from "../gate/lower.ts";

/** Code with each kind of syntax that the runtime refuses, where the order of the steps shows in `log`. */
const SAMPLE = `
const pause = async (log, x) => { log.push("await " + x); return x; };
const note = (log, x) => { log.push("call " + x); return x; };
const both = (a, b) => [a, b];
const twice = async (log, x) => both(x, await pause(log, x));
async function each(log, values, more = ["last"]) {
  const out = [];
  for (const v of [...values, ...more]) out.push(both(v, await pause(log, v)));
  return out;
}
async function early(log, on) {
  if (on) return (await pause(log, "early")) ?? "none";
  return "late";
}
export async function run(on) {
  const log = [];
  const out = [];
  // An await that runs only sometimes keeps its condition.
  out.push(on && (await pause(log, "and")));
  out.push(on || (await pause(log, "or")));
  out.push(on ? await pause(log, "then") : await pause(log, "else"));
  out.push(note(log, on ? null : 0) ?? (await pause(log, "nullish")));
  out.push(on && (!on || both(1, await pause(log, "deep"))));
  // What comes before an await in one statement stays before it.
  const a = note(log, "a"), b = both(a, await pause(log, a + "b"));
  out.push(b, (note(log, "first"), await pause(log, "second")));
  // An await in a branch with no braces stays in the branch.
  if (!on) out.push(both("branch", await pause(log, "in the branch")));
  else if (await pause(log, "else if")) out.push("else if");
  out.push(await early(log, on));
  out.push(await twice(log, "arrow"), await each(log, ["one", "two"]));
  const { x, ...others } = { x: 1, y: 2, z: 3 };
  const [head, ...tail] = [4, 5, 6];
  const none = undefined;
  let kept = on ? "kept" : null;
  kept ??= await pause(log, "assigned");
  try {
    out.push({ ...others, x }, both(head, tail), none?.deep, none?.(), kept);
    JSON.parse("{");
  } catch {
    out.push("caught");
  }
  return { out, log };
}`;

/** The module of `code`, loaded. */
async function load(code: string, name: string): Promise<{ run(on: boolean): Promise<unknown> }> {
  const file = join(mkdtempSync(join(realpathSync(tmpdir()), "erga-lower-")), `${name}.mjs`);
  writeFileSync(file, code);
  return import(file);
}

test("lowered code does the same things in the same order, and has none of the syntax that CloudFront refuses", async () => {
  // As the build does it (gate/build.ts): the bundle, minified, then lowered.
  const built = await Bun.build({ entrypoints: ["/sample.js"], files: { "/sample.js": SAMPLE }, minify: true, format: "esm" });
  const minified = await built.outputs[0].text();
  const lowered = lower(minified);
  expect(refused(SAMPLE).sort()).toEqual(
    [
      "??",
      "??=",
      "?.",
      "a default parameter",
      "an await inside an expression",
      "catch {}",
      "destructuring",
      "for...of",
      "rest",
      "spread",
    ].sort()
  );
  expect(refused(lowered)).toEqual([]);
  const [written, changed] = [await load(SAMPLE, "written"), await load(lowered, "lowered")];
  for (const on of [true, false]) {
    const want = (await written.run(on)) as { out: unknown[]; log: string[] };
    expect(want.log.length).toBeGreaterThan(8);
    expect(await changed.run(on)).toEqual(want);
  }
});

test("the build stops where it can't keep the order: a change before an await in one statement, an await in a loop's head", () => {
  expect(() => lower("export async function f(g, h) { let x; return g((x = 1), await h(x)); }")).toThrow(/write two statements/);
  expect(() => lower("export async function f(g, h) { let n = 0; return g(n++, await h(n)); }")).toThrow(/write two statements/);
  expect(() => lower("export async function f(g, h) { while (g(await h())) g(); }")).toThrow(/loop's head/);
  // A change after the await, or with it, is no problem.
  expect(refused(lower("export async function f(g, h) { let x; return g(await h(), (x = 1)); }"))).toEqual([]);
});

test("each kind of syntax that CloudFront refuses is named", () => {
  const kinds: [string, string][] = [
    ["f(...a)", "spread"],
    ["({ ...a })", "spread"],
    ["function f(...a) {}", "rest"],
    ["const { a } = b", "destructuring"],
    ["const [a] = b", "destructuring"],
    ["function f(a = 1) {}", "a default parameter"],
    ["a?.b", "?."],
    ["a?.()", "?."],
    ["a ?? b", "??"],
    ["a ??= b", "??="],
    ["a ||= b", "||="],
    ["for (const a of b);", "for...of"],
    ["try {} catch {}", "catch {}"],
    ["async function f() { g(await h()); }", "an await inside an expression"],
    ["async function f() { return (await h()).a; }", "an await inside an expression"],
    ["async function f() { for (let a = await h(); ; ); }", "an await inside an expression"],
  ];
  for (const [code, kind] of kinds) expect([code, refused(code)]).toEqual([code, [kind]]);
  // What the runtime takes: an await that is a statement, a declaration's value, a return's value or an assignment's.
  expect(refused("async function f(a) { await g(); const b = await g(); a = await g(); try {} catch (e) {} return await g(); }")).toEqual(
    []
  );
});
