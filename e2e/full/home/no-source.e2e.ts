// Erga serves no source of its own: /source, /api/repo and /git answer 404, as any unknown address does, even when
// the homepage has a page named source.html.
import { expect, servers, test } from "../../helpers/fixtures";
import { adminToken, front, get, home, publish, resetLanding, setLanding } from "./home";

await servers.short();
test.afterEach(async () => {
  await resetLanding(await servers.short());
});

test("/source, /api/repo and /git answer 404, as any unknown address does", async () => {
  const server = await servers.short();
  const files = {
    "index.html": "<!doctype html><title>Home</title><body><h1>Home with a source file</h1></body>",
    "source.html": "<!doctype html><title>Source</title><body><h1>The source page</h1></body>",
  };
  const { id } = await publish(server, await adminToken(server), files, { title: "Home with a source file" });
  expect((await setLanding(server, id)).error).toBeUndefined();
  expect((await home(server, id)).isHome).toBe(true);
  await expect.poll(async () => (await front(server)).html.includes("Home with a source file")).toBe(true);

  const status = async (path: string) => `${path}: ${(await get(server, path)).status}`;
  expect(await status("/no-such-address/x")).toBe("/no-such-address/x: 404");
  expect(await status("/api/no-such-address")).toBe("/api/no-such-address: 404");
  for (const path of [
    "/source",
    "/source/main/server/app.ts",
    "/api/repo",
    "/api/repo/tree/main/README.md",
    "/git",
    "/git/erga.git/info/refs",
  ])
    expect(await status(path)).toBe(`${path}: 404`);
});
