// Where the local agent's key comes from: a server of its own for each case ("Agent off").
import { expect, servers, test } from "../../fixtures";

// A server of this file's own, with its key.
const own = () => servers.of("agent-key-placeholder", { env: { ANTHROPIC_API_KEY: "xxxxxx" } });
await own();

test("a placeholder alone is no key: the agent is off, saying how to set one", async () => {
  const s = await own();
  const { address } = await s.fixture("page");
  const off = await (await fetch(`${address}/api/agent`)).json() as { enabled: boolean; reason?: string };
  expect(off.enabled).toBe(false);
  expect(off.reason ?? "").toMatch(/ANTHROPIC_API_KEY is not set.*export/);
});
