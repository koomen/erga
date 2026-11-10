// The viewer, live: a reader's open page shows each change as it's made (an agent's here, over the API), where they
// were scrolled to, with no reload of the viewer (client/inline/viewer-live.ts).
import type { Frame } from "playwright-core";
import { expect, test, until } from "../../helpers/fixtures";
import { person, servers, tools } from "../front/front";

await servers.script();

/** A long page: a heading, then numbered paragraphs, and `extra` at the end of the first. */
const page = (extra = "") =>
  `<!doctype html><title>Long read</title><h1>Long read</h1>${Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i + 1}.${i == 0 ? extra : ""}</p>`).join("")}`;

test("a reader scrolled down the page sees an agent's change as it's made, where they were", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  const agent = tools(p.base, await p.token("Live viewer agent"));
  expect((await agent.call("write", { document: id, path: "index.html", content: page() })).status).toBe(200);
  await p.share(id, "Ada", "viewer");
  const tabPage = tab.page;
  tab.strict = true;
  await tabPage.goto(`${p.base}${(await p.nameOf(id)).address}?user=Ada`);
  /** The document's page, in the viewer's frame (on its pages origin). */
  const frame = () =>
    until<Frame | null>(
      () => tabPage.frames().find((f) => f != tabPage.mainFrame() && f.url().includes("/t/")) ?? null,
      10_000,
      "the page's frame"
    );
  await until(
    async () => (await (await frame())!.evaluate<string>(`document.body?.innerText ?? ""`).catch(() => "")).includes("Paragraph 80."),
    10_000,
    "the page shows"
  );
  await tabPage.evaluate(`window.sameViewer = true`);
  await (await frame())!.evaluate(`scrollTo(0, 1200)`);
  // The viewer has heard where the reader is (the page tells it as it scrolls).
  await until(async () => Math.round(Number(await (await frame())!.evaluate(`scrollY`))) == 1200, 5_000, "scrolled");

  await agent.call("write", { document: id, path: "index.html", content: page(" Written by an agent.") });
  await expect
    .poll(async () => (await frame())!.evaluate<string>(`document.body?.innerText ?? ""`).catch(() => ""), { timeout: 10_000 })
    .toContain("Written by an agent.");
  await expect.poll(async () => Math.abs(Number(await (await frame())!.evaluate(`scrollY`).catch(() => 0)) - 1200)).toBeLessThan(4);
  expect(await tabPage.evaluate<boolean>(`window.sameViewer`)).toBe(true);
});

test("a reader who followed a link to another page sees an agent's change to that page, not the first page again", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  const agent = tools(p.base, await p.token("Live viewer agent"));
  expect((await agent.call("set_kind", { document: id, kind: "project" })).status).toBe(200);
  const second = (extra = "") => `<!doctype html><title>Second</title><h1>Second page</h1><p>The second page.${extra}</p>`;
  expect(
    (
      await agent.call("write", {
        document: id,
        path: "index.html",
        content: `<!doctype html><title>First</title><h1>First page</h1><p><a href="second.html">Second</a></p>`,
      })
    ).status
  ).toBe(200);
  expect((await agent.call("write", { document: id, path: "second.html", content: second() })).status).toBe(200);
  await p.share(id, "Ada", "viewer");
  const tabPage = tab.page;
  tab.strict = true;
  const address = (await p.nameOf(id)).address;
  await tabPage.goto(`${p.base}${address}?user=Ada`);
  const shown = () =>
    tabPage
      .frameLocator("#frame")
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
  await expect.poll(shown, { timeout: 10_000 }).toContain("First page");
  await tabPage.evaluate(`window.sameViewer = true`);
  await tabPage.frameLocator("#frame").getByRole("link", { name: "Second" }).click();
  await expect.poll(shown, { timeout: 10_000 }).toContain("Second page");
  await expect.poll(() => new URL(tabPage.url()).pathname).toBe(`${address}/second`);

  await agent.call("write", { document: id, path: "second.html", content: second(" Written by an agent.") });
  await expect.poll(shown, { timeout: 10_000 }).toContain("Written by an agent.");
  expect(await shown()).toContain("Second page");
  expect(new URL(tabPage.url()).pathname).toBe(`${address}/second`);
  expect(await tabPage.evaluate<boolean>(`window.sameViewer`)).toBe(true);
});

test("a reader's open page whose document is deleted says so, not that it reconnects", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "viewer");
  const tabPage = tab.page;
  // The viewer's sockets, through the test: the dev server doesn't pass on the close the document makes as it's deleted
  // (Document.destroy: 4404) to a watcher's socket, so the test closes it as the server does.
  const routes: { close(o: { code: number; reason: string }): Promise<void> }[] = [];
  await tabPage.routeWebSocket(/watch=view/, (ws) => {
    ws.connectToServer();
    routes.push(ws);
  });
  await tabPage.goto(`${p.base}${(await p.nameOf(id)).address}?user=Ada`);
  await until(async () => routes.length == 1, 10_000, "the viewer's socket");
  expect((await p.tool("delete_document", { document: id })).status).toBe(200);
  await routes[0].close({ code: 4404, reason: "document deleted" });
  const note = () => tabPage.evaluate<string | null>(`document.querySelector(".erga-live-note")?.textContent ?? null`);
  await expect.poll(note, { timeout: 10_000 }).toBe("This document was deleted.");
  // Longer than the first wait to reconnect (at most 0.625 s): no socket again.
  const at = Date.now();
  await until(async () => Date.now() > at + 1500, 5000, "a while");
  expect(routes.length, "no new socket").toBe(1);
  expect(await note()).toBe("This document was deleted.");
});

test("while an agent writes, a reader sees who in a pill at the top; then 'Updated now', and the pill goes", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  const agent = tools(p.base, await p.token("Claude Code (erga)"));
  expect((await agent.call("write", { document: id, path: "index.html", content: page() })).status).toBe(200);
  await p.share(id, "Ada", "viewer");
  const tabPage = tab.page;
  tab.strict = true;
  await tabPage.goto(`${p.base}${(await p.nameOf(id)).address}?user=Ada`);
  const pill = () =>
    tabPage.evaluate<string | null>(
      `(() => { const e = document.getElementById("erga-writer"); return e && !e.hidden ? e.textContent : null; })()`
    );
  await until(() => tabPage.evaluate<boolean>(`!!document.querySelector('meta[name="erga-ver"]')`), 10_000, "the viewer is up");
  // (Nothing while nobody writes: not for the version it hears as it opens.)
  await new Promise<void>((r) =>
    tabPage.evaluate(`new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))`).then(() => r())
  );
  expect(await pill()).toBeNull();
  await agent.call("write", { document: id, path: "index.html", content: page(" Written by an agent.") });
  await until(async () => (await pill()) == "Claude Code is writing…", 10_000, "the pill says who writes", pill);
  await tabPage.screenshot({ path: ".e2e/shots/writer-pill.png" });
  await until(async () => (await pill()) == "Updated now", 10_000, "then that the page is up to date", pill);
  await until(async () => (await pill()) == null, 10_000, "and it goes", pill);
});
