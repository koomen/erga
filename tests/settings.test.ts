// The admin page's controls for settings, against a stand-in
// directory: a setting that holds users (kind "users") is a picker, with a
// chip for each user and a box to add one from the server's users; the
// logins parser checks what it saves. In the browser (adding and
// taking out users, Save): e2e/config/picker.e2e.ts.

import { afterAll, expect, test } from "bun:test";
import { adminDoor } from "../server/admin/pages.ts";
import { ConfigError, logins, type ConfigEntry } from "../server/settings.ts";
import type { Platform } from "../server/routes.ts";

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
    users: { isAdmin: async () => true, actsAsAdmin: async () => true, list: async () => users },
    config: {
      settings: {},
      list: async () => entries,
      get: async () => "off",
      set: async (_: unknown, key: string, value: unknown) => {
        saved.push({ key, value: logins(value) });
        return entries[0];
      },
    },
    credentials: { list: async () => [] },
    find: async () => null,
  },
} as unknown as Platform;
// The admin pages, on the stand-in.
const server = Bun.serve({
  port: 0,
  fetch: async (r) => {
    const path = new URL(r.url).pathname;
    return path == "/admin" || path.startsWith("/admin/") ? adminDoor(platform, r) : new Response("", { status: 404 });
  },
});
afterAll(() => server.stop(true));

test("a users setting is a picker: chips for its users, no typed list; the line says when and who set it", async () => {
  const html = await (await fetch(`http://localhost:${server.port}/admin`)).text();
  expect(html).toContain(`<li class="chip" data-login="alice">alice<button type="button" class="unpick"`);
  expect(html).toContain(`<datalist id="user-logins"><option value="alice"><option value="bob"><option value="carol"></datalist>`);
  expect(html).toContain(`Last set at 2026-10-05 14:03 UTC by bob`);
  expect(html).toMatch(/data-key="factory" data-control="switch"/);
  expect(html).not.toContain("factory-title");
});
