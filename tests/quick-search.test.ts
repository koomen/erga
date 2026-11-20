// What the quick search (⌘K, client/common/quick-search.ts) may find of Erga's own pages: whoami's `pages`
// (server/operations/pages.ts), which the pane filters by what is typed (match). And what it shows before anything is
// typed (start).

import { afterAll, expect, test } from "bun:test";
import { match, start } from "../client/common/quick-search";
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
  expect(match(rows, "access")).toEqual([]);
  // An admin (the dev login) has them: "access" finds the Access page, where the users are.
  const admin = await rowsOf(s);
  expect([...new Set(admin.map((r) => r.group))]).toEqual(["Pages", "Admin"]);
  expect(match(admin, "access").map((r) => `${r.label}${r.path}`)).toEqual(["Access/admin/access"]);
});

test("before anything is typed: a few of the project's pages, the documents opened last but not the open one, Erga's pages", () => {
  const row = (group: string, label: string, id?: string) => ({ group, label, path: `/${label}`, ...(id ? { id } : {}) });
  const lists = {
    own: "abcdefg".split("").map((l) => row("Pages of P", `page-${l}`)),
    // As the list has them: the last edited first.
    docs: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => row("Documents", `doc-${n}`, `id${n}`)),
    site: [row("Pages", "Documents"), row("Pages", "Settings")],
  };
  // Opened last: 7, then 3 (the open one), then 5, then one that is gone from the list.
  const rows = start(lists, ["id7", "id3", "id5", "gone"], "id3");
  expect(rows.map((r) => `${r.group}: ${r.label}`)).toEqual([
    ...["a", "b", "c", "d", "e"].map((l) => `Pages of P: page-${l}`),
    ...[7, 5, 1, 2, 4].map((n) => `Recent documents: doc-${n}`),
    "Pages: Documents",
    "Pages: Settings",
  ]);
  // No visit kept (another browser): those edited last. The lists stay as they were.
  expect(
    start(lists, [])
      .slice(5, 10)
      .map((r) => r.label)
  ).toEqual(["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"]);
  expect(lists.docs.map((d) => d.group + d.id).join()).toBe([1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Documentsid${n}`).join());
});
