// The settings on /admin, unlocked: setting them, their controls, and the change log (admin.ts; tests/server-config.ts).
// Each test starts a server of its own: they count every change since the server started.
import { expect, test, until } from "../fixtures";
import { adminPage, plainCookie } from "./config";

// A server of its own (a few seconds to start; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("unlocked, an admin sets delete_docs_after_hours on /admin, and the line under it says when and who set it", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own();
  const { at } = await adminPage(tab.page, server);
  expect(await at<boolean>("delete_docs_after_hours", `!li.querySelector(".badge") && !li.querySelector("[name=value]").disabled`)).toBe(true);
  await at("delete_docs_after_hours", `(li.querySelector("[name=value]").value = "36", li.querySelector("[name=value]").dispatchEvent(new Event("input")), li.querySelector("form").requestSubmit(), true)`);
  await expect.poll(() => at("delete_docs_after_hours", `!!li && /^Last set at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC by tester$/.test(li.querySelector(".set")?.textContent) && li.querySelector("[name=value]").value == "36"`).catch(() => false)).toBe(true);
});

test("switches and selects for the factory's settings, which save as they change; no Reset where the control picks the default", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own();
  const { page, at, setting } = await adminPage(tab.page, server);
  expect(await at<boolean>("factory", `li.dataset.control == "switch" && !!li.querySelector("input[type=checkbox][role=switch]") && !li.querySelector("[name=value]").checked && !li.querySelector(".save")`)).toBe(true);
  expect(await at<boolean>("factory_fast", `li.querySelector("input[role=switch]").checked`)).toBe(true);
  expect(await at<string[]>("factory_model", `[...li.querySelectorAll("select[name=value] option")].map((o) => o.value)`)).toEqual(["opus", "sonnet", "haiku"]);
  expect(await at<string[]>("deploy_page", `[...li.querySelectorAll("select[name=value] option")].map((o) => o.value)`)).toEqual(["off", "admins", "users"]);
  expect(await page.evaluate(() => !document.getElementById("factory-title"))).toBe(true);
  await at("factory", `(li.querySelector("[name=value]").click(), true)`);
  // Each saves, and the page reloads with it.
  await expect.poll(() => at("factory", `!!li?.querySelector("[name=value]").checked && /by tester$/.test(li.querySelector(".set")?.textContent)`).catch(() => false)).toBe(true);
  await until(() => at("factory_model", `!!li?.querySelector("select")`).catch(() => false), 5_000, "the page is back");
  await at("factory_model", `(li.querySelector("select").value = "sonnet", li.querySelector("select").dispatchEvent(new Event("change")), true)`);
  await expect.poll(() => at("factory_model", `li?.querySelector("select").value == "sonnet" && /by tester$/.test(li.querySelector(".set")?.textContent)`).catch(() => false)).toBe(true);
  expect((await setting({ key: "landing_document", value: "null" })).status).toBe(200);
  // Set (so its Reset shows), for the one setting whose control doesn't pick its default.
  expect((await setting({ key: "delete_docs_after_hours", value: "36" })).status).toBe(200);
  await page.reload();
  await until(() => at("landing_document", `!!li?.querySelector(".set")`).catch(() => false), 5_000, "the page reloads");
  for (const key of ["factory", "factory_model", "factory_fast", "landing_document"]) expect({ key, reset: await at<boolean>(key, `!!li.querySelector(".reset")`) }).toEqual({ key, reset: false });
  expect(await at<boolean>("delete_docs_after_hours", `!!li.querySelector(".reset")`)).toBe(true);
});

test("/admin/changes lists the settings' changes, newest first, with when, who and what; only for admins", OWN_SERVER, async ({ tab }) => {
  const server = await tab.own();
  const { page, at, setting } = await adminPage(tab.page, server);
  for (const change of <Record<string, string>[]>[
    { key: "delete_docs_after_hours", value: "36" }, { key: "factory", value: '"on"' }, { key: "factory_model", value: '"sonnet"' },
    { key: "landing_document", value: "null" }, // none already: no change
    { key: "factory_fast", value: '"off"' }, { key: "delete_docs_after_hours", reset: "1" },
  ]) expect({ change, status: (await setting(change)).status }).toEqual({ change, status: 200 });
  await page.reload();
  await until(() => at("factory_fast", `!!li && !li.querySelector("[name=value]").checked`).catch(() => false), 5_000, "/admin shows the new value");
  expect(await page.evaluate(() => !document.querySelector("ol.changes, #changes"))).toBe(true);
  await page.goto(`${server.root}/admin/changes`);
  expect(await page.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Change log");
  const side = await page.evaluate(() => [...document.querySelectorAll(".admin-side a")].map((a) => a.textContent + " " + a.getAttribute("href") + (a.getAttribute("aria-current") ? " *" : "")));
  expect(side.slice(0, 4)).toEqual(["Settings /admin", "API keys /admin/api-keys", "Authentication /admin/auth", "Change log /admin/changes *"]);
  await expect.poll(() => page.evaluate(() => document.querySelectorAll("ol.changes > li.change").length)).toBe(5);
  const log = await page.evaluate(() => [...document.querySelectorAll("ol.changes > li.change")].map((li) => li.querySelector(".by")!.textContent + ": " + li.querySelector(".what")!.textContent!.replace(/\s+/g, " ").trim()));
  expect(log).toEqual(["tester: delete_docs_after_hours 36 → 24 reset", "tester: factory_fast “on” → “off”", "tester: factory_model “opus” → “sonnet”", "tester: factory “off” → “on”", "tester: delete_docs_after_hours 24 → 36"]);
  await expect.poll(() => page.evaluate(() => !!document.querySelector("ol.changes time[title]"))).toBe(true);
  const times = await page.evaluate(() => [...document.querySelectorAll("ol.changes time[datetime]")].map((t) => t.textContent + "|" + (t as HTMLElement).title));
  for (const t of times) { expect(t.startsWith("just now|")).toBe(true); expect(t.length).toBeGreaterThan(10); }
  const notAdmin = await fetch(`${server.root}/admin/changes`, { redirect: "manual", headers: { Cookie: await plainCookie(server) } });
  expect(notAdmin.status).toBe(404);
  expect(await notAdmin.text()).not.toContain("factory_model");
  const signedOut = await fetch(`${server.root}/admin/changes`, { redirect: "manual", headers: { Cookie: `erga_signed_out_${server.port}=1` } });
  expect(signedOut.status).toBe(302);
  expect(signedOut.headers.get("location")).toContain("next=%2Fadmin%2Fchanges");
});
