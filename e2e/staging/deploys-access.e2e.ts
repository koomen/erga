// Who may see and do what with staging's deploys (tests/deploys.ts, "who may", and /admin/deploys).
import { expect, servers, test } from "../fixtures";
import { signIn } from "./staging";

test.beforeAll(async () => { await servers.staging(); });

test("only admins read the status, the log and the events, or redeploy; server to server only with the secret", async () => {
  const s = await servers.staging();
  const bo = await signIn(s.root, "bo");
  const status = (path: string, init: RequestInit = {}) => fetch(`${s.root}${path}`, { redirect: "manual", ...init }).then((r) => r.status);
  expect(await status("/api/deploys", { headers: { Cookie: bo } })).toBe(403);
  expect(await status("/api/events", { headers: { Cookie: bo } })).toBe(403);
  expect(await status("/api/deploys/staging/log", { headers: { Cookie: bo } })).toBe(403);
  expect(await status("/api/deploys/staging", { method: "POST", headers: { Cookie: bo, Origin: s.root } })).toBe(403);
  expect(await status("/api/deploys/staging", { method: "POST", headers: { Origin: "https://elsewhere.example" } }), "an admin's redeploy from another site").toBe(403);
  expect(await status("/api/deploys/production", { method: "POST", headers: { Origin: s.root } }), "staging can't redeploy production").toBe(409);
  expect(await status("/api/deploys/staging/hook", { method: "POST", body: JSON.stringify({ branch: "staging", commit: "5e7a".padEnd(40, "0") }) }), "a push without the shared secret").toBe(404);
  expect(await status("/api/deploys/status"), "a status request without it").toBe(404);
  expect(await status("/api/snapshot/docs", { method: "POST", body: "{}" }), "no snapshot endpoints without SNAPSHOT_TOKEN").toBe(404);
});

test("/admin/deploys redirects to /admin/factory, the dashboard of source and deploys", async () => {
  const s = await servers.staging();
  const r = await fetch(`${s.root}/admin/deploys`, { redirect: "manual" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/admin/factory");
});
