// The admin agent's sign-in tools with an admin token (tests/admin-auth.ts): the status of both servers, discarding,
// and a clear that asks for force first; no tool sets a secret.
import { expect, servers, test } from "../fixtures";
import { form, newApp, PROD_APP, reset, status, tools } from "./auth";

test.beforeAll(async () => { await servers.pair(); });

test("get_sign_in_status shows both servers, never a secret; clear_sign_in_app discards, and clears only with force when sign-in would stop", async () => {
  const p = await servers.pair(), P = p.prod.root, S = p.staging.root;
  await reset(p);
  const app = newApp();
  expect((await form(P, { do: "save", server: "other", clientId: app.clientId, secret: app.secret })).status).toBe(200);
  const t = await tools(P);
  const read = await t.call("get_sign_in_status");
  const out = read.content?.map((c) => c.text).join("") ?? "";
  const parsed = JSON.parse(out);
  expect(read.ok).toBe(true);
  expect([parsed.thisServer.state, parsed.otherServer.state, parsed.otherServer.clientIdFrom]).toEqual(["working", "working", "/admin/auth"]);
  expect(out).not.toContain(app.secret);
  expect(out).not.toContain(PROD_APP.secret);
  const pendingOnly = await t.call("clear_sign_in_app", { server: "other", what: "pending" });
  expect(pendingOnly.ok).toBe(true);
  expect(JSON.parse(pendingOnly.content![0].text).discarded).toBe(false);
  const clear = await t.call("clear_sign_in_app", { server: "other" });
  expect(clear.ok).toBe(false);
  expect(clear.error).toMatch(/force/);
  const forced = await t.call("clear_sign_in_app", { server: "other", force: true });
  expect(forced.ok).toBe(true);
  expect(JSON.parse(forced.content![0].text).cleared).toBe(true);
  expect((await status(S)).here.check.state).toBe("not_set_up");
  const list = (await (await fetch(`${P}/api/ext/tools`, { headers: { Authorization: `Bearer ${t.token}` } })).json()) as { tools?: { name: string }[] } | { name: string }[];
  const names = (Array.isArray(list) ? list : list.tools ?? []).map((x) => x.name);
  expect(names).toContain("get_sign_in_status");
  expect(names).toContain("clear_sign_in_app");
  expect(names.some((n) => /^(set|save)_sign_in/.test(n))).toBe(false);
});
