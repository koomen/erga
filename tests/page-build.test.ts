// The page's build (server/live.ts, pageBuild) is its code: an open page asks for it after a connection comes back, and
// reloads when it differs. A document's page must keep the same build while its owner edits it: its version and its
// title change with each edit, and an editor that reloaded itself after a dropped socket lost the person's place.

import { expect, test } from "bun:test";
import { pageBuild } from "../server/live.ts";
import { viewerPage } from "../server/pages/viewer.ts";
import type { Session } from "../server/platform.ts";

const pageOf = (title: string, live: string, o: { editing: boolean; agent: boolean }) => {
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
    agent: o.agent,
    bars: true,
    editing: o.editing,
    landing: false,
    clone: "",
    edit: "",
    corner: "",
    live,
    project: "/ada/plans",
  });
  return before + after;
};
const build = (title: string, live: string) => pageBuild(pageOf(title, live, { editing: true, agent: false }));

test("a document's page keeps its build when its version and its title change", async () => {
  expect(await build("Plans", "l1")).toBe(await build("Plans for May", "l2"));
});

test("someone who may edit, reading: the document's frame starts before the editor's parts and the stylesheet", () => {
  // A stylesheet in the HTML holds back the scripts after it, the frame's start too: a script puts it in.
  const parts = (html: string) => [
    html.indexOf('<template id="erga-shell">') > html.indexOf('<iframe id="frame"'),
    /<link rel="stylesheet" href="[^"]*style/.test(html),
  ];
  expect(parts(pageOf("Plans", "l1", { editing: false, agent: true }))).toEqual([true, false]);
  // Opened with ?edit, the editor's parts come first: its first frame has them.
  expect(parts(pageOf("Plans", "l1", { editing: true, agent: true }))).toEqual([false, true]);
});
