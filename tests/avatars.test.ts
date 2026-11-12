// A person's picture (shared/avatars.ts): GitHub's by the account's id, Google's from its claim, and nothing else.

import { expect, test } from "bun:test";
import { githubAvatar, googleAvatar, safeAvatar } from "../shared/avatars";

test("a GitHub account's picture is found by its numeric id, never by a login", () => {
  expect(githubAvatar(583231)).toBe("https://avatars.githubusercontent.com/u/583231?s=64");
  expect(githubAvatar("583231")).toBe("https://avatars.githubusercontent.com/u/583231?s=64");
  for (const bad of ["petekoomen", "", "0", "-1", "12a", "1/../2"]) expect(githubAvatar(bad)).toBeNull();
});

test("a Google account's picture is Google's, at the pages' size; with none, or another site's, there is none", () => {
  expect(googleAvatar("https://lh3.googleusercontent.com/a/ACg8ocK=s96-c")).toBe("https://lh3.googleusercontent.com/a/ACg8ocK=s64-c");
  expect(googleAvatar("https://lh3.googleusercontent.com/a/ACg8ocK")).toBe("https://lh3.googleusercontent.com/a/ACg8ocK=s64-c");
  for (const bad of [
    undefined,
    null,
    "",
    "not a url",
    "http://lh3.googleusercontent.com/a/x",
    "https://evil.example/a.png",
    "https://googleusercontent.com.evil.example/a",
    "https://lh3.googleusercontent.com:8443/a/x",
  ])
    expect(googleAvatar(bad)).toBeNull();
});

test("a page shows only GitHub's pictures by id and Google's", () => {
  expect(safeAvatar("https://avatars.githubusercontent.com/u/583231?s=64")).toBe("https://avatars.githubusercontent.com/u/583231?s=64");
  expect(safeAvatar("https://lh3.googleusercontent.com/a/x=s64-c")).toBe("https://lh3.googleusercontent.com/a/x=s64-c");
  // GitHub's picture by login (what every account showed before), and anything else: none.
  for (const bad of [
    "https://avatars.githubusercontent.com/petekoomen?s=64",
    "https://github.com/petekoomen.png",
    "https://evil.example/u/1",
    "javascript:alert(1)",
    "",
    undefined,
  ])
    expect(safeAvatar(bad)).toBeNull();
});
