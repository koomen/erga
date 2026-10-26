// Where the local agent's key comes from: a server of its own for each case ("Agent off").
import { expect, servers, test } from "../../helpers/fixtures";

// A server of this file's own, with its key.
const own = () => servers.of("agent-key-env", { env: { ANTHROPIC_API_KEY: "xxxxxx" }, processEnv: { ANTHROPIC_API_KEY: "sk-ant-test-from-the-environment" } });
await own();

test("the environment's key turns the agent on past a placeholder in .dev.vars, and nothing is written back", async () => {
  const s = await own();
  const { address } = await s.fixture("page");
  const info = await (await fetch(`${address}/api/agent`)).json() as { enabled: boolean };
  expect(info.enabled).toBe(true);
});
