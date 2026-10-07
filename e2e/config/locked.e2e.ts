// A setting the deploy fixes reaches the Worker and wins (server.config.ts → cloudflare.config.ts → worker/d1.ts; tests/server-config.ts).
import { expect, test } from "../fixtures";
import { adminPage, plainCookie } from "./config";

// A server of its own, started with the deploy's settings (a few seconds; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("delete_docs_after_hours locked to 3: /docs says so and a new document gets 3 hours; /admin shows it read-only, and refuses a change", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own({ env: { ERGA_SERVER_CONFIG: JSON.stringify({ delete_docs_after_hours: 3 }) } });
  const cookie = await plainCookie(server, "cfg");
  const get = (path: string) => fetch(server.root + path, { redirect: "manual", headers: { Cookie: cookie } });
  expect(await (await get("/docs")).text()).toContain("goes away after 3 hours");
  expect((await get("/new")).status).toBe(302);
  const listed = await (await get("/docs")).text();
  expect(listed).toMatch(/deleted in [23]h/);
  expect(listed).toContain("deleted 3 hours after");
  const { at, setting } = await adminPage(tab.page, server);
  expect(await at<string>("delete_docs_after_hours", `li.querySelector(".badge")?.textContent`)).toBe("Locked");
  expect(await at<unknown[]>("delete_docs_after_hours", `[li.querySelector("[name=value]").disabled, li.querySelector("[name=value]").value, !!li.querySelector(".save")]`)).toEqual([true, "3", false]);
  const refused = await setting({ key: "delete_docs_after_hours", value: "48" });
  expect(refused.status).toBe(403);
  expect((JSON.parse(refused.body) as { error: string }).error).toMatch(/fixed by the deploy.*stays 3/);
});

test("a deploy config the settings won't take stops the server from starting, saying why", OWN_SERVER, async ({ tab }) => {
  const why = await tab.own({ env: { ERGA_SERVER_CONFIG: JSON.stringify({ delete_docs_after_hours: "soon" }) }, startMs: 45_000 }).then(() => "it started", (e: Error) => e.message);
  expect(why).toMatch(/delete_docs_after_hours to "soon", but it must be a whole number/);
});
