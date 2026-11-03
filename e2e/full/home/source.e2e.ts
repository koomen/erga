// The homepage's page source.html at its own address: /source, and every path under it, for people to read and share.
import { expect, servers, test } from "../../helpers/fixtures";
import { adminToken, front, get, home, publish, resetLanding, setLanding } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

const files = {
  "index.html": "<!doctype html><title>Home</title><body><h1>Home with a source page</h1></body>",
  "source.html": `<!doctype html><title>Source</title><body><h1>The source page</h1><p id="at"></p>
<script>document.getElementById("at").textContent = location.pathname;</script></body>`,
};

test("/source and every path under it are the homepage's source.html, as it is; nothing else of the site's takes them", async ({ tab }) => {
  const server = await servers.short();
  const { id } = await publish(server, await adminToken(server), files, { title: "Home with a source page" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  expect((await home(server, id)).isHome).toBe(true);
  await expect
    .poll(async () => {
      const f = await front(server);
      return f.direct && f.html.includes("Home with a source page");
    })
    .toBe(true);

  for (const path of ["/source", "/source/", "/source/main", "/source/main/server/app.ts", "/source/staging/docs/self-host.md"]) {
    const r = await get(server, path);
    expect(`${path}: ${r.status}`).toBe(`${path}: 200`);
    const html = await r.text();
    expect(html).toContain("<h1>The source page</h1>");
    expect(html).not.toContain("live.js"); // the page as its authors wrote it
  }
  expect((await get(server, "/sources")).status).not.toBe(200);

  await tab.page.goto(`${server.root}/source/main/server/app.ts`);
  await expect.poll(() => tab.page.locator("#at").textContent()).toBe("/source/main/server/app.ts");
});
