// The editor's Share button never goes away: only the owner can share, and for anyone else who edits (an admin on the
// homepage project, which has no owner; an editor of someone's document) it stays in its place, off, with a tip that
// says why. It doesn't show, then go, nor change its look, at any moment: the first frame, the editor's start, after.
import { expect, servers, test, until, type Page } from "../../helpers/fixtures";
import { clickOn, inPage, newDoc, unique } from "../access/access";
import { fresh, resetLanding } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

/**
 * From before the page's first frame to now, each state #btn-share had, as the person sees it: whether it showed (in
 * the page, not hidden) and how strong its icon was. Every change in the page writes one down.
 */
async function watchShare(page: Page) {
  await page.addInitScript(() => {
    if (window.top != window) return;
    const seen: string[] = ((window as any).__share = []);
    const note = () => {
      const b = document.getElementById("btn-share");
      if (!b) return;
      const svg = b.querySelector("svg");
      const state = `${b.hidden || !b.isConnected ? "gone" : "there"} ${svg ? getComputedStyle(svg).opacity : "?"}`;
      if (seen[seen.length - 1] != state) seen.push(state);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true });
  });
}
const states = (page: Page) => page.evaluate(() => (window as any).__share as string[]);

/** Opens `at` in the editor and waits until its controls are out and its page is in: the access check is back. */
async function openEditing(page: Page, at: string) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await watchShare(page);
  await page.goto(at);
  await until(
    () =>
      page.evaluate(
        () => document.body.classList.contains("erga-editor-ready") && document.getElementById("edit-group")!.classList.contains("settled")
      ),
    10_000,
    "the editor is ready, its own actions out"
  );
  await until(
    async () => (await inPage<boolean>(page, "!!window.ergaFrame?.page")).includes(true),
    10_000,
    "the editor's half is in the page"
  );
}

/** The Share button as the page shows it now. */
const share = (page: Page) =>
  page.evaluate(() => {
    const b = document.getElementById("btn-share")!,
      r = b.getBoundingClientRect();
    return {
      shown: !b.hidden && r.width > 0,
      off: b.getAttribute("aria-disabled") == "true",
      tip: b.dataset.tip,
      card: !document.getElementById("sharing")!.hidden,
    };
  });

/** Not the owner: the button shows from the start, off, and a click opens nothing. */
async function offForThem(page: Page) {
  expect(await share(page)).toEqual({ shown: true, off: true, tip: "Only the owner can share", card: false });
  await clickOn(page, "#btn-share");
  expect((await share(page)).card).toBe(false);
  // Every state it had: there and dimmed, from its first frame; never gone, never full strength.
  expect(await states(page)).toEqual(["there 0.4"]);
}

test("an admin on the homepage project (/_home?edit), which has no owner, sees Share off, all the time", async ({ tab }) => {
  const server = await servers.short();
  await fresh(server);
  await openEditing(tab.page, `${server.root}/_home?edit`);
  await offForThem(tab.page);
});

test("an editor of someone's document sees Share off, all the time; the owner's is on and opens the card", async ({ tab }) => {
  const root = (await servers.short()).root;
  const { at, id } = await newDoc(root);
  const editor = unique("editor");
  const r = await fetch(`${root}/api/tools/share_document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify({ document: id, login: editor, role: "editor" }),
  });
  expect(r.status).toBe(200);
  await openEditing(tab.page, `${root}${at}&user=${editor}`);
  await offForThem(tab.page);

  // The owner, in a new page: on, the editor's tip, and it opens who has the document.
  const owner = await tab.page.context().newPage();
  await openEditing(owner, root + at);
  expect(await share(owner)).toEqual({ shown: true, off: false, tip: "Share", card: false });
  expect(await states(owner)).toEqual(["there 1"]);
  await clickOn(owner, "#btn-share");
  await expect.poll(async () => (await share(owner)).card).toBe(true);
  await owner.close();
});

test("a reader of a document has no editor, so no Share button at any moment", async ({ tab }) => {
  const root = (await servers.short()).root;
  const { at, id } = await newDoc(root);
  const reader = unique("reader");
  const r = await fetch(`${root}/api/tools/share_document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify({ document: id, login: reader, role: "viewer" }),
  });
  expect(r.status).toBe(200);
  const page = tab.page;
  await watchShare(page);
  await page.goto(`${root}${at.replace(/[?&]edit=?$/, "")}?user=${reader}`);
  await page.locator("#frame").waitFor();
  await page.locator(".erga-view-buttons .erga-agent-share").waitFor();
  expect(await states(page)).toEqual([]);
  expect(await page.evaluate(() => !document.getElementById("btn-share") && !document.querySelector(".erga-edit-button"))).toBe(true);
});
