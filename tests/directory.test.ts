// The document directory (directory.ts) on an in-memory SQLite database,
// with the same migrations D1 gets: slugs, history, following, and who may.

import { expect, test } from "bun:test";
import { openDirectory } from "../directory-sqlite";
import { NameError, slugify } from "../directory";

const fresh = () => openDirectory(":memory:").directory;
const doc = (id: string, title: string, extra = {}) => ({ id, owner: "Ada", title, doName: id, created: 1, expires: 100, ...extra });

test("slugify", () => {
  expect(slugify("Field & notes, 2026")).toBe("field-notes-2026");
  expect(slugify("Crème brûlée’s recipe")).toBe("creme-brulees-recipe");
  expect(slugify("  ---  ")).toBe("");
  const long = slugify("word ".repeat(30));
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long.endsWith("-")).toBe(false);
});

test("slugs are unique per owner, follow the title, and leave history behind", async () => {
  const dir = fresh();
  expect((await dir.add(doc("aaaaaaaa", "Plan"))).doc.slug).toBe("plan");
  expect((await dir.add(doc("bbbbbbbb", "Plan"))).doc.slug).toBe("plan-2");
  // Another owner may have the same slug.
  expect((await dir.add({ ...doc("cccccccc", "Plan"), owner: "bo" })).doc.slug).toBe("plan");
  // Adding again changes nothing.
  expect((await dir.add(doc("aaaaaaaa", "Other"))).added).toBe(false);

  const r = await dir.edited("aaaaaaaa", { modified: 5, pageTitle: "Launch plan" });
  expect(r?.renamed).toBe(true);
  expect(r?.doc).toMatchObject({ title: "Launch plan", slug: "launch-plan", modified: 5, expires: null });
  expect((await dir.locate("ada", "plan"))?.via).toBe("history");
  expect((await dir.locate("ADA", "aaaaaaaa"))?.via).toBe("id");
  expect((await dir.locate("ada", "launch-plan"))?.via).toBe("slug");

  // A set title stops following; a set slug stays when the title changes.
  await dir.rename("aaaaaaaa", { title: "Mine" }, "Launch plan");
  expect((await dir.edited("aaaaaaaa", { modified: 6, pageTitle: "Heading" }))?.doc.title).toBe("Mine");
  await dir.rename("aaaaaaaa", { slug: "keep" }, null);
  expect((await dir.rename("aaaaaaaa", { title: "Changed" }, null)).doc.slug).toBe("keep");
  // Explicit: taken and reserved are refused; an old slug (history) can be taken over.
  await expect(dir.rename("bbbbbbbb", { slug: "keep" }, null)).rejects.toBeInstanceOf(NameError);
  await expect(dir.rename("bbbbbbbb", { slug: "docs" }, null)).rejects.toBeInstanceOf(NameError);
  expect((await dir.rename("bbbbbbbb", { slug: "launch-plan" }, null)).doc.slug).toBe("launch-plan");
  expect((await dir.locate("ada", "launch-plan"))?.doc.id).toBe("bbbbbbbb");
  // Empty goes back to following.
  expect((await dir.rename("aaaaaaaa", { title: "", slug: "" }, "From heading")).doc).toMatchObject({ title: "From heading", slug: "from-heading", titleSet: false, slugSet: false });
  // An automatic slug never takes another document's id.
  expect((await dir.add(doc("dddddddd", "aaaaaaaa"))).doc.slug).toBe("aaaaaaaa-2");
});

test("the list, removal and who may", async () => {
  const dir = fresh();
  await dir.add(doc("aaaaaaaa", "One"));
  await dir.add(doc("tttttttt", "Test", { test: true }));
  expect((await dir.list("ada")).map((d) => d.id)).toEqual(["aaaaaaaa"]);
  const one = (await dir.get("aaaaaaaa"))!;
  expect(await dir.may({ login: "ada" }, "delete", one)).toBe(true);
  expect(await dir.may({ login: "bo" }, "delete", one)).toBe(false);
  expect(await dir.may({ login: "bo" }, "rename", one)).toBe(true);
  expect(await dir.may({ login: "test-ada", test: true }, "open", one)).toBe(false);
  expect(await dir.may(null, "open", one)).toBe(false);
  await dir.remove("aaaaaaaa");
  expect(await dir.get("aaaaaaaa")).toBeNull();
  expect(await dir.list("ada")).toEqual([]);
});
