// Where the local agent's key comes from (dev/agent-key.ts): a server of its own for each case (tests/page.ts, "Agent off").
import { expect, test } from "../fixtures";

// Each test starts a dev server of its own (a few seconds; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("a placeholder alone is no key: the agent is off, saying how to set one", OWN_SERVER, async ({ tab }) => {
  const s = await tab.own({ env: { ANTHROPIC_API_KEY: "xxxxxx" } });
  const { address } = await s.fixture("page");
  const off = await (await fetch(`${address}/api/agent`)).json() as { enabled: boolean; reason?: string };
  expect(off.enabled).toBe(false);
  expect(off.reason ?? "").toMatch(/ANTHROPIC_API_KEY is not set.*export/);
});
