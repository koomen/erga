// The agent plugins as files, by plugin ("claude-code", "antigravity") and path: each plugin's own folder
// (bridge/plugins/<plugin>/), erga-agent.js (bridge/core/cli.ts as one script, for Bun) and bin/erga-agent, the
// script that runs it (bridge/plugins/erga-agent.sh), which names its server as SERVER_MARK. The client build puts
// them in the static assets (plugins.json); each instance serves them, with its own address for the mark
// (server/pages/plugin.ts). bridge/build.ts writes them in dist/plugins/ for a session on this machine.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLUGINS = join(ROOT, "bridge/plugins");

export async function pluginFiles(): Promise<Record<string, Record<string, string>>> {
  const built = await Bun.build({ entrypoints: [join(ROOT, "bridge/core/cli.ts")], target: "bun", minify: true });
  if (!built.success) throw new AggregateError(built.logs, "building erga-agent failed");
  const agent = await built.outputs[0].text();
  const launcher = readFileSync(join(PLUGINS, "erga-agent.sh"), "utf8");
  const out: Record<string, Record<string, string>> = {};
  for (const plugin of ["claude-code", "antigravity"]) {
    const files: Record<string, string> = { "erga-agent.js": agent, "bin/erga-agent": launcher };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(join(PLUGINS, plugin), p)] = readFileSync(p, "utf8");
      }
    };
    walk(join(PLUGINS, plugin));
    out[plugin] = files;
  }
  return out;
}
