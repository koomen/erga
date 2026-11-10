// Each person's agent panel (agents/person/sessions.ts) answers this site's own pages, with the person's cookie, and no
// other origin, not even to listen.

import { afterAll, expect, test } from "bun:test";
import { agentApi } from "../agents/person/sessions.ts";
import type { Platform } from "../server/platform.ts";
import { respond } from "../server/http.ts";

const agent = { agentState: async () => ({ enabled: true }), conversation: async () => ({ items: [] }) };
const platform = { sessionOf: async () => ({ login: "bob", name: "Bob" }), personAgent: () => agent } as unknown as Platform;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => respond(agentApi, r, platform) });
const site = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

test("this site's own pages use the panel, with no CORS: a request from the same origin, or with none", async () => {
  for (const headers of [{ Origin: site }, {}] as Record<string, string>[]) {
    const r = await fetch(`${site}/api/agent`, { headers });
    expect([r.status, r.headers.get("access-control-allow-origin")]).toEqual([200, null]);
    expect(await r.json()).toEqual({ enabled: true });
  }
});

test("no other origin: not to read, write or listen", async () => {
  for (const [path, method] of [
    ["/api/agent", "GET"],
    ["/api/agent", "OPTIONS"],
    ["/api/agent/conversation", "DELETE"],
    ["/api/agent/events", "GET"],
  ])
    expect((await fetch(`${site}${path}`, { method, headers: { Origin: "https://ops.example" } })).status, path).toBe(403);
});
