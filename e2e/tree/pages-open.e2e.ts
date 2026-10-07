// The editor's pages dropdown opens with its rows the first time it's clicked (tests/pages-open.ts, without its timing: pages-open.bench.e2e.ts).
import { expect, servers, test } from "../fixtures";
import { multi } from "./tree";
import { open, up } from "./pages";

await servers.main();

test("the first click on the title, with no hover first, opens it with its rows", async ({ tab }) => {
  tab.strict = true;
  const doc = await multi(await servers.main());
  await up(tab.page, doc.base);
  expect(typeof await open(tab.page, 0)).toBe("number");
});

test("after the pointer rests on the title, the first click opens it with its rows", async ({ tab }) => {
  tab.strict = true;
  const doc = await multi(await servers.main());
  await up(tab.page, doc.base);
  expect(typeof await open(tab.page, 150)).toBe("number");
});

test("on the next page of the same tab, the first click opens it with its rows", async ({ tab }) => {
  tab.strict = true;
  const doc = await multi(await servers.main());
  await up(tab.page, doc.base);
  await up(tab.page, `${doc.base}/about`);
  expect(typeof await open(tab.page, 0)).toBe("number");
});
