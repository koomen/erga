// Add a domain on the Ops page, as a guide in its dialog, against the pretend Cloudflare: a domain not in the account
// (the step that adds it on Cloudflare, or buys one), a domain whose name servers haven't moved (the two to set at the
// registrar), a name with a DNS record of its own (Replace it, only when asked), a workers.dev name (refused), and a
// name that goes on at once, then waits for its certificate and says when it answers.
import { expect, servers, test } from "../../helpers/fixtures";

const own = () => servers.of("ops-domains", { env: { ERGA_DEPLOY_MOCK: "1" } });
await own();
test("Add domain: each case says the next step in place, then the name answers", { timeout: 90_000 }, async ({ tab }) => {
  const server = await own(),
    { page } = tab;
  const text = (sel: string) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
  const add = async (hostname: string) => {
    await page.fill("#domain-host", hostname);
    await page.click("#domain-go");
  };
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${server.root}/admin/ops`);
  await expect.poll(() => text("#domains-production .dom.primary"), { timeout: 15_000 }).toBe("erga.dev");
  await page.click('#domains-production button[data-add="production"]');

  // Not on Cloudflare: add it there (or buy one), then Check again.
  await add("docs.example.org");
  await expect.poll(() => text("#domain-step"), { timeout: 10_000 }).toContain("example.org isn't in your Cloudflare account yet");
  expect(await page.getAttribute("#domain-step a", "href")).toMatch(/^https:\/\/dash\.cloudflare\.com\/[0-9a-f]{32}\/add-site$/);
  expect(await text("#domain-step")).toContain("Buy one on Cloudflare");
  expect(await text("#domain-go")).toBe("Check again");

  // On Cloudflare, but the registrar still names its own name servers: the two to set, with Copy.
  await add("erga-moving.dev");
  await expect.poll(() => text("#domain-step"), { timeout: 10_000 }).toContain("erga-moving.dev waits for its name servers");
  expect(await text("#domain-step")).toContain("replace ns1.registrar.example and ns2.registrar.example with");
  expect(await page.$$eval("#domain-step .ns code", (c) => c.map((x) => x.textContent))).toEqual([
    "ada.ns.cloudflare.com",
    "bob.ns.cloudflare.com",
  ]);

  // A workers.dev name comes with the Worker: refused, with why.
  await add("erga.erga.workers.dev");
  await expect.poll(() => text("#domain-status"), { timeout: 10_000 }).toContain("A workers.dev address comes with the Worker");

  // A name with a record of its own: nothing changes until Replace it.
  await add("blog.erga.dev");
  await expect.poll(() => text("#domain-step"), { timeout: 10_000 }).toContain("blog.erga.dev already points somewhere else");
  expect(await text("#domain-step")).toContain("A 192.0.2.10");
  expect(await text("#domains-production")).not.toContain("blog.erga.dev");
  expect(await text("#domain-go")).toBe("Replace it");
  await page.click("#domain-go");
  // Added: it waits for its certificate (the chip says so), then answers.
  await expect.poll(() => text("#domain-status"), { timeout: 10_000 }).toContain("Added");
  await expect.poll(() => text("#domains-production")).toContain("blog.erga.dev · certificate…");
  await expect.poll(() => text("#domain-status"), { timeout: 15_000 }).toBe("blog.erga.dev answers. Open it ↗");
  expect(await page.getAttribute("#domain-status a", "href")).toBe("https://blog.erga.dev");
  await expect.poll(() => text("#domains-production"), { timeout: 10_000 }).not.toContain("certificate…");
  await page.click("#domain-cancel");

  // A name with nothing in the way goes on at once.
  await page.click('#domains-production button[data-add="production"]');
  await add("docs.erga.dev");
  await expect.poll(() => text("#domain-status"), { timeout: 15_000 }).toBe("docs.erga.dev answers. Open it ↗");
  expect(await page.$$eval("#domains-production .dom > span", (s) => s.map((x) => x.textContent))).toEqual([
    "erga.dev",
    "blog.erga.dev",
    "docs.erga.dev",
  ]);
});
