// The page's build (server/live.ts, pageBuild) is its code: an open page asks for it after a connection comes back, and
// reloads when it differs. A document's page must keep the same build while its owner edits it: its version and its
// title change with each edit, and an editor that reloaded itself after a dropped socket lost the person's place.

import { expect, test } from "bun:test";
import { pageBuild } from "../server/live.ts";
import { viewerPage } from "../server/pages/viewer.ts";
import type { Session } from "../server/platform.ts";

const build = (title: string, live: string) => {
  const { before, after } = viewerPage({
    title,
    head: {},
    file: "index.html",
    files: "https://abcd1234-ada.erga-pages.dev/t/tok/",
    docId: "abcd1234",
    pages: "https://abcd1234-ada.erga-pages.dev",
    meta: "",
    session: { user: "ada", login: "ada" } as unknown as Session,
    editable: true,
    agent: false,
    bars: true,
    editing: true,
    landing: false,
    clone: "",
    edit: "",
    corner: "",
    live,
    project: "/ada/plans",
  });
  return pageBuild(before + after);
};

test("a document's page keeps its build when its version and its title change", async () => {
  expect(await build("Plans", "l1")).toBe(await build("Plans for May", "l2"));
});
