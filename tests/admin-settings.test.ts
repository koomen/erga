// The admin page's controls for settings (admin.ts), against a stand-in
// directory: a setting that holds users (kind "users") is a picker, with a
// chip for each user and a box to add one from the server's users; the
// logins parser (config.ts) checks what it saves. Headless Chrome adds and
// takes out users, and the page saves the list as JSON.

import { afterAll, expect, test } from "bun:test";
import { adminDoor } from "../admin.ts";
import { ConfigError, logins, type ConfigEntry } from "../config.ts";
import type { Platform } from "../front.ts";
import { join } from "path";
import { Browser, SHOTS } from "./cdp";
import { until } from "./suite/harness";

test("logins: a list of GitHub logins, tidied; a bad one is refused, saying which", () => {
  expect(logins(["Alice", "@bob", "alice", " "])).toEqual(["alice", "bob"]);
  expect(logins("carol, dave  erin")).toEqual(["carol", "dave", "erin"]);
  expect(() => logins(["no spaces here"])).toThrow(ConfigError);
  expect(() => logins(["-x"])).toThrow(/"-x", which isn't a GitHub login/);
  expect(() => logins(42)).toThrow(/list of GitHub logins/);
});

// A server with one users setting, a switch and a choice, and three users.
const saved: { key: string; value: unknown }[] = [];
const entries: ConfigEntry[] = [
  { key: "deploy_users", description: "Who may deploy.", value: ["alice"], default: [], source: "set", locked: false, kind: "users", updated: Date.UTC(2026, 9, 5, 14, 3), updatedBy: "bob" },
  { key: "factory", description: "The factory.", value: "off", default: "off", source: "default", locked: false, choices: ["off", "on"], updated: null, updatedBy: null },
];
const users = ["alice", "bob", "carol"].map((login) => ({ login, name: login, role: login == "bob" ? "admin" : "user", created: 1, addedBy: null, lastSeen: null, bootstrap: false }));
const platform = {
  sessionOf: async () => ({ login: "bob", name: "bob" }),
  directory: {
    users: { isAdmin: async () => true, isUnlocked: async () => true, list: async () => users },
    config: {
      settings: {},
      list: async () => entries,
      get: async () => "off",
      set: async (_: unknown, key: string, value: unknown) => {
        saved.push({ key, value: logins(value) });
        return entries[0];
      },
    },
    find: async () => null,
  },
} as unknown as Platform;
// The page, and its stylesheet and fonts from the repo, so the screenshot looks as it does.
const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    if (path.startsWith("/admin")) return adminDoor(platform, r);
    const file = Bun.file(join(import.meta.dir, "..", path));
    return (path == "/style.css" || path.startsWith("/fonts/")) && !path.includes("..") && (await file.exists()) ? new Response(file) : new Response("", { status: 404 });
  },
});
const browser = await Browser.launch();
afterAll(() => { browser.close(); server.stop(true); });

test("a users setting is a picker: chips for its users, no typed list; the line says when and who set it", async () => {
  const html = await (await fetch(`http://localhost:${server.port}/admin`)).text();
  expect(html).toContain(`<li class="chip" data-login="alice">alice<button type="button" class="unpick"`);
  expect(html).toContain(`<datalist id="user-logins"><option value="alice"><option value="bob"><option value="carol"></datalist>`);
  expect(html).toContain(`Last set at 2026-10-05 14:03 UTC by bob`);
  expect(html).toMatch(/data-key="factory" data-control="switch"/);
  expect(html).not.toContain("factory-title");
});

test("in the browser: add a user, take one out, Save sends the list", async () => {
  const p = await browser.page(await browser.context());
  await p.open(`http://localhost:${server.port}/admin`, { width: 1000, height: 600 });
  await p.settle();
  const row = (expr: string) => p.eval<any>(`(() => { const li = document.querySelector('li.setting[data-key="deploy_users"]'); return ${expr}; })()`);
  expect(await row(`li.querySelector(".save").disabled`)).toBe(true);
  // Typed, then Enter; then picked from the list (an input event with no inputType).
  await row(`(() => { const pick = li.querySelector("input.pick"); pick.value = "Carol"; pick.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await row(`(() => { const pick = li.querySelector("input.pick"); pick.value = "bob"; pick.dispatchEvent(new Event("input")); })()`);
  expect(await row(`[...li.querySelectorAll(".chip")].map((c) => c.dataset.login).join(" ")`)).toBe("alice carol bob");
  await p.screenshot(join(SHOTS, "admin-picker.png"));
  await row(`li.querySelector('.chip[data-login="alice"] .unpick').click()`);
  expect(await row(`li.querySelector("[name=value]").value`)).toBe(`["carol","bob"]`);
  expect(await row(`li.querySelector(".save").disabled`)).toBe(false);
  await row(`li.querySelector(".save").click()`);
  await until(() => saved.length > 0, 5000, "the list is saved");
  expect(saved[0]).toEqual({ key: "deploy_users", value: ["carol", "bob"] });
  expect(p.errors).toEqual([]);
}, 30_000);
