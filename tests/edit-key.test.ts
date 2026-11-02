// The edit key (server/documents/edit-key.ts): it names its person and one document, holds for KEY_SECONDS, and no
// other token (a pages token) passes as one.
import { expect, test } from "bun:test";
import { editKey, KEY_SECONDS, keyWho, readEditKey } from "../server/documents/edit-key.ts";
import { pagesToken } from "../server/documents/index.ts";

const ada = { login: "Ada", name: "Ada L.", avatar: "a1" };

test("an edit key names its person for one document, and only for a while", async () => {
  const now = Date.UTC(2026, 10, 1);
  const { key, expires } = await editKey("s", "Koomen", "abcd2345", ada, now);
  expect(expires).toBe(now + KEY_SECONDS * 1000);
  expect(await readEditKey("s", key, "koomen", "abcd2345", now)).toEqual({ login: "ada", name: "Ada L.", avatar: "a1" });
  // Another document, another secret, too late, or changed: no one.
  expect(await readEditKey("s", key, "koomen", "abcd2346", now)).toBeNull();
  expect(await readEditKey("t", key, "koomen", "abcd2345", now)).toBeNull();
  expect(await readEditKey("s", key, "koomen", "abcd2345", expires)).toBeNull();
  expect(
    await readEditKey(
      "s",
      key.replace(/^./, (c) => (c == "e" ? "f" : "e")),
      "koomen",
      "abcd2345",
      now
    )
  ).toBeNull();
  // A pages token for the same document is not a key.
  expect(
    await readEditKey("s", await pagesToken("s", "koomen", "abcd2345", "https://erga.dev", now, { edit: true }), "koomen", "abcd2345", now)
  ).toBeNull();
});

test("a key's person has this one document, and admin power only if their session had it; a test person stays one", async () => {
  expect(keyWho({ login: "ada", name: "Ada" }, "abcd2345")).toEqual({ login: "ada", test: false, onlyDoc: "abcd2345" });
  const admin = await readEditKey(
    "s",
    (await editKey("s", "koomen", "abcd2345", { login: "koomen", name: "P", admin: true })).key,
    "koomen",
    "abcd2345"
  );
  expect(keyWho(admin!, "abcd2345")).toEqual({ login: "koomen", test: false, admin: true, onlyDoc: "abcd2345" });
  // (A test person never has it.)
  const test = await readEditKey(
    "s",
    (await editKey("s", "koomen", "abcd2345", { login: "t-2", name: "T", testBy: "koomen", admin: true })).key,
    "koomen",
    "abcd2345"
  );
  expect(test?.admin).toBeUndefined();
  const { key } = await editKey("s", "koomen", "abcd2345", { login: "t-1", name: "T", testBy: "Koomen" });
  const person = await readEditKey("s", key, "koomen", "abcd2345");
  expect(person).toEqual({ login: "t-1", name: "T", testBy: "koomen" });
  expect(keyWho(person!, "abcd2345")).toEqual({ login: "t-1", test: true, by: "koomen", onlyDoc: "abcd2345" });
});
