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
  expect((await agent.call("make_project", { document: id })).status).toBe(200);
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
