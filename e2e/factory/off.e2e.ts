// The factory off (tests/factory.ts, 1).
import { expect, test } from "../fixtures";
import { board, factory, servers } from "./factory";

test.beforeAll(async () => { await servers.factory(); });

test("off by default: the board says so, adding a task is refused, and someone who isn't an admin gets a 404", async ({ tab }) => {
  const s = await servers.factory();
  expect(s.initial.enabled).toBe(false);
  const f = factory(s);
  expect((await f.setting("off")).ok).toBe(true);
  const b = await board(tab.page, s.root);
  expect(await b.eval<boolean>(`!document.getElementById("notice").hidden`)).toBe(true);
  expect((await f.api("/tasks", { json: { title: "x" } })).status).toBe(409);
  expect((await fetch(`${s.root}/admin/factory?user=bob`)).status).toBe(404);
});
