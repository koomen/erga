#!/usr/bin/env bun
// The admin agent reading Erga's own source, in the real Worker (worker/factory.ts → SourceHost.read → the
// pretend Artifacts, with a read token), on the scripted test model, in a real browser on /admin/factory:
// list_source, read_source, search_source and source_log each answer from this clone's commit, pushed as
// staging; a file that isn't there is an error the agent can act on.
//
//   bun tests/admin-agent-source.ts            the checks
//   bun tests/admin-agent-source.ts --shots    and a screenshot, in tests/cdp.ts's SHOTS
// covers: factory/agent.ts worker/factory.ts worker/source-host.ts worker/artifacts.ts source/

import { mkdirSync } from "fs";
import { join } from "path";
import { ensureBare } from "../dev/git-server";
import { Browser, SHOTS } from "./cdp";
import { startHost } from "./host";
import { expect, until } from "./suite/harness";

const host = await startHost(null, { env: { ERGA_AGENT_MODEL: "script" } });
const browser = await Browser.launch();
const ok = (what: string) => console.log(`ok   ${what}`);

let failed = false;
try {
  // This clone's HEAD as staging and main, straight into the pretend Artifacts' repository (dev/git-server.ts).
  const bare = join(host.state, "artifacts", "erga", "erga.git");
  ensureBare(bare);
  const push = Bun.spawnSync(["git", "push", "-q", bare, "HEAD:refs/heads/staging", "HEAD:refs/heads/main"], { cwd: join(import.meta.dir, "..") });
  expect(push.exitCode == 0, "pushed this clone as staging", push.stderr.toString());
  const p = await browser.page(await browser.context());
  await p.open(`${host.root}/admin/factory`, { width: 1440, height: 900 });
  await until(() => p.eval<boolean>(`document.getElementById("agent-send").title == "Type a message to send it."`), 20_000, "the agent is on");
  await Bun.sleep(1000);
  const script = [
    { tool: "source_log", args: { limit: 5 } },
    { tool: "list_source", args: { path: "factory" } },
    { tool: "search_source", args: { query: "export function sourceTools", glob: "*.ts" } },
    { tool: "read_source", args: { path: "factory/agent.ts", from: 1, to: 20 } },
    { tool: "read_source", args: { path: "no/such/file.ts" } },
    { text: "factory/agent.ts defines the source tools (sourceTools). They read staging, read-only." },
  ];
  await p.eval(`(() => { const i = document.getElementById("agent-input"); i.value = ${JSON.stringify(`Where are your source tools defined? @script ${JSON.stringify(script)}`)}; i.dispatchEvent(new Event("input")); document.getElementById("agent-send").click(); })()`);
  const log = () => p.eval<string>(`document.getElementById("agent-log").textContent`);
  // The message holds the script, reply and all: the reply is the second time.
  await until(async () => (await log()).split("They read staging, read-only.").length == 3, 30_000, "the reply", log);
  const r = await p.eval<{ log: { items: { kind: string; name?: string; status?: string; path?: string; detail?: string }[] } }>(`fetch("/api/admin/agent/conversation").then((r) => r.json())`);
  const tools = r.log.items.filter((i) => i.kind == "tool");
  expect(tools.map((t) => `${t.name} ${t.status}`).join() == "source_log done,list_source done,search_source done,read_source done,read_source error", "each tool answered", tools);
  expect(tools[4].detail?.includes("There's no file no/such/file.ts"), "a missing file says so", tools[4]);
  ok("list_source, read_source, search_source and source_log answer from staging, in the Worker");
  if (process.argv.includes("--shots")) {
    mkdirSync(SHOTS, { recursive: true });
    const file = join(SHOTS, "admin-agent-source.png");
    await p.screenshot(file);
    console.log(`shot ${file}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  browser.close();
  await host.dispose();
}
process.exit(failed ? 1 : 0);
