// The deploy targets' status on staging (tests/deploys.ts, "the status"): GET /api/deploys and /api/deploys/version.
import { expect, servers, test } from "../fixtures";
import type { Target } from "./staging";

await servers.staging();

test("GET /api/deploys has production and staging, as the contract has them; staging is this server's", async () => {
  const s = await servers.staging();
  const r = await fetch(`${s.root}/api/deploys`);
  expect(r.status).toBe(200);
  const { targets } = await r.json() as { targets: Target[] };
  expect(targets.map((t) => t.name)).toEqual(["production", "staging"]);
  const [prod, stag] = targets;
  expect([prod.host, prod.branch, !!prod.self]).toEqual(["erga.dev", "main", false]);
  expect([stag.host, stag.branch, stag.self]).toEqual(["staging.erga.dev", "staging", true]);
  for (const k of ["name", "host", "branch", "state", "commit", "at", "error", "log"]) expect(k in stag, `a target has ${k}`).toBe(true);
  expect(((await (await fetch(`${s.root}/api/deploys/version`)).json()) as { target: string }).target).toBe("staging");
});
