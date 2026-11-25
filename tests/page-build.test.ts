// The page's build (server/live.ts, pageBuild) is its code: an open page asks for it after a connection comes back, and
// reloads when it differs. A document's page must keep the same build while its owner edits it: its version and its
// title change with each edit, and an editor that reloaded itself after a dropped socket lost the person's place.

import { expect, test } from "bun:test";
import { pageBuild } from "../server/live.ts";
import { viewerPage } from "../server/pages/viewer.ts";
import type { Session } from "../server/platform.ts";

const pageOf = (title: string, live: string, o: { editing: boolean; agent: boolean; many?: boolean }) => {
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
    editing: o.editing,
    clone: "",
    edit: "",
    corner: "",
    live,
    tree: { address: "/ada/plans", many: o.many ?? true },
  });
  return before + after;
};
const build = (title: string, live: string) => pageBuild(pageOf(title, live, { editing: true, agent: false }));

test("a document's page keeps its build when its version, its title and its number of pages change", async () => {
  expect(await build("Plans", "l1")).toBe(await build("Plans for May", "l2"));
  expect(await build("Plans", "l1")).toBe(await pageBuild(pageOf("Plans", "l1", { editing: true, agent: false, many: false })));
});

test("someone who may edit, reading: the document's frame starts before the editor's parts and the stylesheet", () => {
  // A stylesheet in the HTML holds back the scripts after it, the frame's start too: a script puts it in.
  const parts = (html: string) => [
    html.indexOf('<template id="erga-shell">') > html.indexOf('<iframe id="frame"'),
    /<link rel="stylesheet" href="[^"]*style/.test(html),
  ];
  expect(parts(pageOf("Plans", "l1", { editing: false, agent: true }))).toEqual([true, false]);
  expect(parts(pageOf("Plans", "l1", { editing: false, agent: false }))).toEqual([true, false]);
  // Opened with ?edit, the editor's parts come first: its first frame has them.
  expect(parts(pageOf("Plans", "l1", { editing: true, agent: true }))).toEqual([false, true]);
  expect(parts(pageOf("Plans", "l1", { editing: true, agent: false }))).toEqual([false, true]);
  // The bars' sheets come before the bars: the first paint of a slow page has them (no slide into place as they come).
  const page = pageOf("Plans", "l1", { editing: false, agent: true });
  expect(page.indexOf("--bars-height:") < page.indexOf('<div class="erga-view-buttons')).toBe(true);
  // The document's title meta is emitted once, in <head>.
  expect(pageOf("Plans", "l1", { editing: false, agent: true }).match(/name="erga-title"/g)).toHaveLength(1);
});
