// The admin agent reading Erga's own source in the Worker (worker/factory.ts, worker/source-host.ts, the pretend
// Artifacts with a read token), on the scripted model, from the panel on /admin/factory (tests/admin-agent-source.ts).
import { expect, servers, test } from "../fixtures";
import { fresh, panel, stagingFromHere } from "./admin";

test.beforeAll(async () => { stagingFromHere(await servers.script()); });

test("list_source, read_source, search_source and source_log answer from staging; a file that isn't there is an error that says so", async ({ tab }) => {
  const s = await servers.script();
  await fresh(s);
  const p = panel(tab.page, s);
  await p.open();
  const tools = await p.say("Where are your source tools defined?", [
    { tool: "source_log", args: { limit: 5 } },
    { tool: "list_source", args: { path: "factory" } },
    { tool: "search_source", args: { query: "export function sourceTools", glob: "*.ts" } },
    { tool: "read_source", args: { path: "factory/agent.ts", from: 1, to: 20 } },
    { tool: "read_source", args: { path: "no/such/file.ts" } },
  ], "factory/agent.ts defines the source tools (sourceTools). They read staging, read-only.");
  expect(tools.map((t) => `${t.name} ${t.status}`)).toEqual(["source_log done", "list_source done", "search_source done", "read_source done", "read_source error"]);
  expect(tools[4].detail).toContain("There's no file no/such/file.ts");
});
