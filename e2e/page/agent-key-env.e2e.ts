// Where the local agent's key comes from (dev/agent-key.ts): a server of its own for each case (tests/page.ts, "Agent off").
import { expect, test } from "../fixtures";

// Each test starts a dev server of its own (a few seconds; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test("the environment's key turns the agent on past a placeholder in .dev.vars, and nothing is written back", OWN_SERVER, async ({ tab }) => {
  const s = await tab.own({ env: { ANTHROPIC_API_KEY: "xxxxxx" }, processEnv: { ANTHROPIC_API_KEY: "sk-ant-test-from-the-environment" } });
  const { address } = await s.fixture("page");
  const info = await (await fetch(`${address}/api/agent`)).json() as { enabled: boolean };
  expect(info.enabled).toBe(true);
});
