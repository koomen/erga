// The published-version picker's rows (src/page/versions.ts): always the
// published version, the latest ten, and the few just before the published
// one, with a row for each run of versions in between.

import { expect, test } from "bun:test";
import { nearNeed, pickerRows, type Row, type Version } from "../src/page/versions";

const v = (n: number): Version => ({ id: `id${n}`, n, at: new Date(0).toISOString(), authors: ["a"], description: `v${n}` });
const range = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, i) => v(hi - i));
/** The picker as loadVersions builds it: the latest ten, current and published, then what nearNeed asks for. */
function picker(total: number, pub: number): string {
  const loaded = new Map<number, Version>();
  for (const x of [...range(total, Math.max(1, total - 9)), v(total), v(pub)]) loaded.set(x.n, x);
  const need = nearNeed(loaded, v(pub));
  if (need) {
    const from = Number(need.before.slice(2));
    for (const x of range(from - 1, Math.max(1, from - need.limit))) loaded.set(x.n, x);
  }
  expect(nearNeed(loaded, v(pub))).toBeNull();
  return pickerRows(loaded, total).map((r: Row) => (r.kind == "version" ? String(r.v.n) : `…${r.count}`)).join(" ");
}

test("published is the current version", () => {
  expect(picker(47, 47)).toBe("47 46 45 44 43 42 41 40 39 38 …37");
});
test("published is one older", () => {
  expect(picker(47, 46)).toBe("47 46 45 44 43 42 41 40 39 38 …37");
});
test("published at the bottom of the latest ten: the few before it join them", () => {
  expect(picker(47, 38)).toBe("47 46 45 44 43 42 41 40 39 38 37 36 35 …34");
});
test("published far back, many versions: an ellipsis between, and the older ones below", () => {
  expect(picker(47, 12)).toBe("47 46 45 44 43 42 41 40 39 38 …25 12 11 10 9 …8");
});
test("published just below the latest ten: no gap", () => {
  expect(picker(47, 37)).toBe("47 46 45 44 43 42 41 40 39 38 37 36 35 34 …33");
});
test("published near the first version: nothing older", () => {
  expect(picker(47, 2)).toBe("47 46 45 44 43 42 41 40 39 38 …35 2 1");
});
test("fewer than ten versions in all", () => {
  expect(picker(6, 6)).toBe("6 5 4 3 2 1");
  expect(picker(6, 2)).toBe("6 5 4 3 2 1");
  expect(picker(1, 1)).toBe("1");
});
test("loading a gap's versions closes it", () => {
  const loaded = new Map<number, Version>();
  for (const x of [...range(30, 21), ...range(5, 3)]) loaded.set(x.n, x);
  expect(pickerRows(loaded, 30).filter((r) => r.kind == "more").map((r) => r.kind == "more" && [r.count, r.before, r.older])).toEqual([[15, "id21", false], [2, "id3", true]]);
  for (const x of range(20, 6)) loaded.set(x.n, x);
  expect(pickerRows(loaded, 30).filter((r) => r.kind == "more").length).toBe(1);
});
