// Live reload (tests/reload.ts): without --reload, no page gets the script.
import { expect, servers, test } from "../fixtures";

await servers.main();

test("without --reload, pages are left alone", async () => {
  const html = await (await fetch(`${(await servers.main()).root}/docs`, { headers: { "sec-fetch-dest": "document" } })).text();
  expect(html).toContain("<title>Documents");
  expect(html).not.toContain("erga live reload");
});
