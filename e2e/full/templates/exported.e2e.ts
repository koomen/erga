// A presentation keeps working outside Erga: its template's files, opened on another site, import erga/steps from
// erga.dev (here the test's server answers for erga.dev), and the page's own code and erga/steps show the steps.
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { expect, servers, test } from "../../helpers/fixtures";
import { rawKey } from "./templates";

await servers.main();

const SITE = "https://exported.example/";

/** Opens a template's files at SITE, as a person opens an exported presentation; Erga's libraries come from the test's server. */
async function openExported(page: Page, template: string) {
  const s = await servers.main();
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  await page.route(/^https:\/\/erga\.dev\//, async (r) => {
    const res = await fetch(r.request().url().replace("https://erga.dev", s.root));
    await r.fulfill({
      status: res.status,
      contentType: res.headers.get("content-type") ?? "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
  await page.route(`${SITE}**`, (r) => {
    const file = new URL(r.request().url()).pathname.slice(1) || "index.html";
    const type = file.endsWith(".js") ? "text/javascript" : "text/html";
    try {
      return r.fulfill({ contentType: type, body: readFileSync(`assets/templates/${template}/${file}`) });
    } catch {
      return r.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto(`${SITE}index.html`);
}

/** The step bar (erga/steps' shadow root), as the page shows it. */
const bar = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector("erga-steps")?.shadowRoot,
      b = c?.querySelector<HTMLElement>(".bar");
    return {
      shown: !!b && !b.hidden && b.getClientRects().length > 0,
      at: b?.querySelector(".at")?.textContent ?? "",
      steps: [...(c?.querySelectorAll(".step .name span") ?? [])].map((e) => e.textContent),
    };
  });

test("the slides template, opened outside Erga: the bar shows the steps; → and the bar's buttons step; the list names the slides", async ({
  tab,
}) => {
  const page = tab.page;
  await openExported(page, "slides");
  await expect.poll(async () => (await bar(page)).at).toBe("1 / 2");
  expect((await bar(page)).shown).toBe(true);
  await page.mouse.click(5, 5);
  await rawKey(page, "ArrowRight");
  await expect.poll(async () => (await bar(page)).at).toBe("2 / 2");
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".slide")].map((s) => !s.hidden))).toEqual([false, true]);
  expect(new URL(page.url()).hash).toBe("#2");
  await page.evaluate(() => document.querySelector("erga-steps")!.shadowRoot!.querySelector<HTMLElement>(".back")!.click());
  await expect.poll(async () => (await bar(page)).at).toBe("1 / 2");
  await page.evaluate(() => document.querySelector("erga-steps")!.shadowRoot!.querySelector<HTMLElement>(".toggle")!.click());
  await expect.poll(async () => (await bar(page)).steps).toEqual(["Untitled presentation", "Second slide"]);
  // No editor outside Erga: the deck's bar for the slides stays hidden.
  expect(await page.evaluate(() => document.querySelector("slide-bar")?.shadowRoot?.querySelector<HTMLElement>(".bar")?.hidden)).toBe(true);
});

test("the canvas template, opened outside Erga: the bar shows its frames, and → moves the camera to the next one", async ({ tab }) => {
  const page = tab.page;
  await openExported(page, "canvas");
  await expect.poll(async () => (await bar(page)).at).toMatch(/^1 \/ \d+$/);
  const count = Number((await bar(page)).at.split(" / ")[1]);
  expect(count).toBeGreaterThan(1);
  await page.mouse.click(5, 5);
  await rawKey(page, "ArrowRight");
  await expect.poll(async () => (await bar(page)).at).toBe(`2 / ${count}`);
  expect(await page.evaluate(() => [...document.querySelectorAll(".frame")].findIndex((f) => f.classList.contains("current")))).toBe(1);
});
