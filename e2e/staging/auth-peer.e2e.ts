// The servers' peer route for sign-in (tests/admin-auth.ts, "the peer route"): not found on production without the
// shared secret, refused by staging's admins-only guard without it, the status with it (never a secret); production
// takes values from nobody.
import { expect, servers, test } from "../fixtures";
import { PROD_APP, reset } from "./auth";
import { HOOK } from "./staging";

test.beforeAll(async () => { await servers.pair(); });

test("the peer route: the status only with the shared secret, past staging's guard; production takes no values from another server", async () => {
  const p = await servers.pair(), P = p.prod.root, S = p.staging.root;
  await reset(p);
  const out = (port: number) => ({ Cookie: `erga_signed_out_${port}=1` });
  let r = await fetch(`${P}/api/sign-in/status`, { headers: out(p.prod.port) });
  expect(r.status).toBe(404);
  r = await fetch(`${S}/api/sign-in/status`, { headers: { ...out(p.staging.port), Authorization: "Bearer not-the-secret-0123456789abcdef" } });
  expect(r.status).toBe(403);
  expect(((await r.json()) as { adminsOnly?: boolean }).adminsOnly).toBe(true);
  r = await fetch(`${S}/api/sign-in/status`, { headers: { ...out(p.staging.port), Authorization: `Bearer ${HOOK}` } });
  expect(r.status).toBe(200);
  const theirs = ((await r.json()) as { status: any }).status;
  expect([theirs.target, theirs.check.state, theirs.inUse.clientId, theirs.takesFrom]).toEqual(["staging", "not_set_up", null, "production"]);
  r = await fetch(`${P}/api/sign-in/status`, { headers: { ...out(p.prod.port), Authorization: `Bearer ${HOOK}` } });
  const text = await r.text();
  expect(r.status).toBe(200);
  expect(JSON.parse(text).status.check.state).toBe("working");
  expect(text).not.toContain(PROD_APP.secret);
  r = await fetch(`${P}/api/sign-in/github`, { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ do: "clear", by: "mallory" }) });
  expect(r.status, "production takes no sign-in values from another server").toBe(403);
  r = await fetch(`${S}/api/sign-in/github`, { method: "POST", headers: { ...out(p.staging.port), "Content-Type": "application/json" }, body: JSON.stringify({ do: "clear" }) });
  expect(r.status, "staging: a change without the secret").toBe(403);
});
