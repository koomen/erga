// What stays open on staging without an admin (tests/staging-admins.ts, "what stays open"): each door checks its own
// credential.
import { expect, servers, test } from "../fixtures";
import { get, signedOut } from "./admins";
import { DEPLOY_MS, HOOK, settled, sha } from "./staging";

await servers.staging();

test("the version check answers anyone; the deploy hook and peer reads need the shared secret", { timeout: DEPLOY_MS + 15_000 }, async () => {
  const s = await servers.staging(), out = signedOut(s);
  let r = await get(s, "/api/deploys/version", { headers: { Cookie: out } });
  expect(r.status).toBe(200);
  expect(((await r.json()) as { target: string }).target).toBe("staging");
  await settled(s, "staging");
  r = await fetch(`${s.root}/api/deploys/staging/hook`, { method: "POST", headers: { Authorization: `Bearer ${HOOK}`, "Content-Type": "application/json", Cookie: out }, body: JSON.stringify({ branch: "staging", commit: sha() }) });
  expect(r.status, "the deploy hook, with its secret, signed out").toBe(200);
  // The deploy it started runs to its end before the next test.
  await settled(s, "staging", DEPLOY_MS);
  expect((await get(s, "/api/deploys/staging/hook", { method: "POST", body: "{}" })).status, "the hook without it: its own door says no").toBe(404);
  expect((await get(s, "/api/deploys/staging/log", { headers: { Authorization: `Bearer ${HOOK}` } })).status, "another of Erga's servers reads the log").toBe(200);
  expect((await get(s, "/api/gate", { headers: { Authorization: `Bearer ${HOOK}`, Cookie: out } })).status, "production reads staging's test runs").toBe(200);
  expect((await get(s, "/api/gate", { headers: { Cookie: out } })).status, "the test runs without it").not.toBe(200);
});

test("the snapshot endpoint, a factory VM's callback and its git token each reach their own door, which checks them", async () => {
  const s = await servers.staging();
  expect((await get(s, "/api/snapshot/docs", { method: "POST", body: "{}" })).status).toBe(404);
  let r = await get(s, "/api/factory/tasks/1/brief", { headers: { Authorization: `Bearer fct.1.9999999999.${"0".repeat(64)}` } });
  const body = (await r.json().catch(() => ({}))) as { error?: string; adminsOnly?: boolean };
  expect(r.status).toBe(403);
  expect(body.adminsOnly).toBeFalsy();
  expect(body.error).toMatch(/token/);
  r = await get(s, "/git/erga.git/info/refs?service=git-upload-pack", { headers: { Authorization: `Basic ${btoa(`x:fgt.e30.${"0".repeat(64)}`)}` } });
  expect(r.status).toBe(401);
  expect(await r.text()).toContain("factory token");
});
