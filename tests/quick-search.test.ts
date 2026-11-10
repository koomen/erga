// What the quick search (⌘K, client/common/quick-search.ts) may find of Erga's own pages: whoami's `pages`
// (server/operations/pages.ts), which the pane filters by what is typed (match).

import { afterAll, expect, test } from "bun:test";
import { match } from "../client/common/quick-search";
import { useAssets } from "../server/pages/index.ts";
import { runTool, server } from "./helpers/app";

afterAll(() => useAssets(null));

type Row = { group: string; label: string; path: string };
/** Erga's pages as the pane has them for the person `user` names: each with its address as its hint. */
const rowsOf = async (s: ReturnType<typeof server>, user?: string) =>
  ((await runTool<{ pages: Row[] }>(s, "whoami", {}, user ? { user } : {})).result?.pages ?? []).map((p) => ({ ...p, hint: p.path }));

test("for someone who isn't an admin, it has no admin pages", async () => {
  const s = server();
  const rows = await rowsOf(s, "Bo");
  const groups = [...new Set(rows.map((r) => r.group))];
  expect(groups).toContain("Pages");
  expect(groups).not.toContain("Admin");
  expect(rows.some((r) => r.path.includes("/admin"))).toBe(false);
  expect(match(rows, "users")).toEqual([]);
  // An admin (the dev login) has them: the same word finds the Users page.
  const admin = await rowsOf(s);
  expect([...new Set(admin.map((r) => r.group))]).toEqual(["Pages", "Admin"]);
  expect(match(admin, "users").map((r) => `${r.label}${r.path}`)).toEqual(["Users/admin/users"]);
});
