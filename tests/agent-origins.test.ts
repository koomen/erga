// Each person's agent panel (agents/person/sessions.ts) answers this site's pages and the Ops pages (the control Worker's,
// platform.control), which embed the same panel: those, with the person's cookie, and no other origin, not even to listen.

import { afterAll, expect, test } from "bun:test";
import { agentApi } from "../agents/person/sessions.ts";
import type { Platform } from "../server/platform.ts";
import { respond } from "../server/http.ts";

const OPS = "https://ops.example";
const agent = { agentState: async () => ({ enabled: true }), conversation: async () => ({ items: [] }) };
const platformOf = (control: boolean) =>
  ({
    sessionOf: async () => ({ login: "bob", name: "Bob" }),
    personAgent: () => agent,
    ...(control ? { control: { url: `${OPS}/` } } : {}),
  }) as unknown as Platform;
const servers = [true, false].map((control) => Bun.serve({ port: 0, fetch: (r) => respond(agentApi, r, platformOf(control)) }));
const [withOps, alone] = servers.map((s) => `http://localhost:${s.port}`);
afterAll(() => servers.forEach((s) => s.stop(true)));

test("the Ops pages may use the panel: with the person's cookie, and the answers say so", async () => {
  const pre = await fetch(`${withOps}/api/agent`, { method: "OPTIONS", headers: { Origin: OPS, "Access-Control-Request-Method": "POST" } });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe(OPS);
  expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
  const r = await fetch(`${withOps}/api/agent`, { headers: { Origin: OPS } });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ enabled: true });
  expect(r.headers.get("access-control-allow-origin")).toBe(OPS);
  // This site's own pages, as before: no CORS needed.
  const own = await fetch(`${withOps}/api/agent`, { headers: { Origin: withOps } });
  expect([own.status, own.headers.get("access-control-allow-origin")]).toEqual([200, null]);
});

test("no other origin: not to read, write or listen; and no Ops origin where there is no control Worker", async () => {
  for (const [path, method] of [
    ["/api/agent", "GET"],
    ["/api/agent/conversation", "DELETE"],
    ["/api/agent/events", "GET"],
  ])
    expect((await fetch(`${withOps}${path}`, { method, headers: { Origin: "https://evil.example" } })).status, path).toBe(403);
  expect((await fetch(`${alone}/api/agent`, { headers: { Origin: OPS } })).status).toBe(403);
});
