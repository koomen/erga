// Viewers and the agent (document/host.ts, ViewersAgent): its turns use the server's API key, so someone who may only
// view asks the document's agent only where its owner lets viewers ask (off unless turned on), and at most
// viewer_agent_turns times a day. The owner sees what each viewer used (GET /api/viewers-agent, the viewers_agent tool).

import { expect, test } from "bun:test";
import { setup } from "./files-fixture";

async function shared() {
  const s = await setup({ test: true });
  await s.doc.setPermissions([{ login: "ada", role: "owner" }, { login: "carl", role: "editor" }, { login: "bob", role: "viewer" }]);
  const as = (who: string, agent = false) => ({ "x-erga-person": JSON.stringify({ id: who, name: who }), "x-erga-who": JSON.stringify({ login: who }), ...(agent ? { "x-erga-agent": "token-1" } : {}) });
  const call = async (who: string, method: string, path: string, body?: unknown, agent = false) => {
    const r = await s.doc.handle(new Request(`http://doc${path}`, { method, headers: { "content-type": "application/json", ...as(who, agent) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const ask = (who: string) => call(who, "POST", "/api/agent", { text: "What does this page say?" });
  return { ...s, call, ask };
}

test("a viewer can't ask the agent until the owner lets viewers ask; editors always can; the panel says why", async () => {
  const { ask, call } = await shared();
  const refused = await ask("bob");
  expect(refused.status).toBe(503);
  expect(refused.body.reason).toContain("hasn't let viewers ask its agent");
  const state = await call("bob", "GET", "/api/agent");
  expect(state.body).toMatchObject({ enabled: false });
  expect(state.body.reason).toContain("hasn't let viewers ask");
  expect((await ask("carl")).status).toBe(200);
  // Only the owner sees or changes it.
  expect((await call("carl", "GET", "/api/viewers-agent")).status).toBe(403);
  expect((await call("carl", "POST", "/api/viewers-agent", { on: true })).status).toBe(403);
  const on = await call("ada", "POST", "/api/viewers-agent", { on: true });
  expect(on.body).toMatchObject({ on: true, limit: 20, viewers: [] });
  expect((await ask("bob")).status).toBe(200);
  expect((await call("bob", "GET", "/api/agent")).body.enabled).toBe(true);
});

test("each viewer has viewer_agent_turns a day; the owner sees each viewer's turns, over the API and the viewers_agent tool", async () => {
  const { ask, call, dir } = await shared();
  await call("ada", "POST", "/api/viewers-agent", { on: true });
  await dir.config.set({ login: "ada", admin: true }, "viewer_agent_turns", 2);
  expect((await ask("bob")).status).toBe(200);
  expect((await ask("bob")).status).toBe(200);
  const third = await ask("bob");
  expect(third.status).toBe(503);
  expect(third.body.reason).toContain("2 times today");
  const report = (await call("ada", "GET", "/api/viewers-agent")).body;
  expect(report).toMatchObject({ on: true, limit: 2, viewers: [{ login: "bob", today: 2, total: 2 }] });
  // The owner's agent reads and sets it; a viewer's agent has no such tool.
  const tool = await call("ada", "POST", "/api/ext/tools/viewers_agent", { on: false }, true);
  expect(tool.body.ok).toBe(true);
  expect(tool.body.content[0].text).toContain("Viewers may not ask the agent here.");
  expect(tool.body.content[0].text).toContain("bob: 2 today, 2 in all");
  expect((await call("bob", "POST", "/api/ext/tools/viewers_agent", {}, true)).body.ok).toBe(false);
  expect((await ask("bob")).body.reason).toContain("hasn't let viewers ask");
});
