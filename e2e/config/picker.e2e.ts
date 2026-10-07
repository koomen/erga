// A setting that holds users (kind "users") is a picker on /admin (admin.ts; tests/admin-settings.test.ts, its browser
// part): a chip for each user and a box to add one from the server's users. No setting of the server's is a users
// list yet, so the page runs against a stand-in directory (as tests/admin-settings.test.ts's other checks do), served
// to the browser by a small HTTP server of the test's own; the logins parser (config.ts) checks what it saves.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adminDoor } from "../../admin";
import { logins, type ConfigEntry } from "../../config";
import type { Platform } from "../../front";
import { ROOT } from "../env";
import { expect, test, type Page } from "../fixtures";

/** The admin pages on a stand-in platform, with the repo's stylesheet and fonts: its address, what Save sent, and stop(). */
async function standIn() {
  const saved: { key: string; value: unknown }[] = [];
  const entries: ConfigEntry[] = [
    { key: "deploy_users", description: "Who may deploy.", value: ["alice"], default: [], source: "set", locked: false, kind: "users", updated: Date.UTC(2026, 9, 5, 14, 3), updatedBy: "bob" },
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
        set: async (_: unknown, key: string, value: unknown) => { saved.push({ key, value: logins(value) }); return entries[0]; },
      },
      credentials: { list: async () => [] },
      find: async () => null,
    },
  } as unknown as Platform;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let out: Response;
    if (url.pathname == "/admin" || url.pathname.startsWith("/admin/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = Object.entries(req.headers).flatMap(([k, v]) => v == null ? [] : [[k, String(v)] as [string, string]]);
      const body = req.method == "GET" || req.method == "HEAD" ? undefined : Buffer.concat(chunks);
      out = await adminDoor(platform, new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
    } else if ((url.pathname == "/style.css" || url.pathname.startsWith("/fonts/")) && !url.pathname.includes("..")) {
      out = await readFile(join(ROOT, url.pathname)).then((b) => new Response(b, { headers: { "Content-Type": url.pathname.endsWith(".css") ? "text/css" : "font/woff2" } }), () => new Response("", { status: 404 }));
    } else out = new Response("", { status: 404 });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { root: `http://127.0.0.1:${port}`, saved, stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const row = <T = unknown>(page: Page, expr: string) => page.evaluate(`(() => { const li = document.querySelector('li.setting[data-key="deploy_users"]'); return ${expr}; })()`) as Promise<T>;

test("in the browser: add a user typed with Enter, one picked from the list, take one out, and Save sends the list", async ({ tab }) => {
  const s = await standIn(), page = tab.page;
  try {
    await page.goto(`${s.root}/admin`);
    await expect.poll(() => row(page, `!!li?.querySelector("input.pick")`)).toBe(true);
    expect(await row<boolean>(page, `li.querySelector(".save").disabled`)).toBe(true);
    // Typed, then Enter; then picked from the list (an input event with no inputType).
    const pick = page.locator('li.setting[data-key="deploy_users"] input.pick');
    await pick.fill("Carol");
    await pick.press("Enter");
    await row(page, `(() => { const pick = li.querySelector("input.pick"); pick.value = "bob"; pick.dispatchEvent(new Event("input")); })()`);
    expect(await row<string>(page, `[...li.querySelectorAll(".chip")].map((c) => c.dataset.login).join(" ")`)).toBe("alice carol bob");
    await page.locator('li.setting[data-key="deploy_users"] .chip[data-login="alice"] .unpick').click();
    expect(await row<string>(page, `li.querySelector("[name=value]").value`)).toBe(`["carol","bob"]`);
    expect(await row<boolean>(page, `li.querySelector(".save").disabled`)).toBe(false);
    await page.locator('li.setting[data-key="deploy_users"] .save').click();
    await expect.poll(() => s.saved).toEqual([{ key: "deploy_users", value: ["carol", "bob"] }]);
    // The stand-in serves only the admin page, its stylesheet and fonts: the other files the page asks for are not found.
    expect(tab.errors.filter((e) => !e.startsWith("console.error: Failed to load resource: the server responded with a status of 404"))).toEqual([]);
  } finally {
    await s.stop();
  }
});
