#!/usr/bin/env bun
// Writes the agent plugins (bridge/plugin-files.ts) in dist/plugins/claude-code/ and dist/plugins/antigravity/, for a
// session on this machine while you work on the bridge. People install them from an instance instead
// (server/pages/plugin.ts). Usage: bun bridge/build.ts [--server <url>] (default: the local server).

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PLUGIN_SERVER_MARK } from "../shared/agent-plugin";
import { pluginFiles } from "./plugin-files";

const OUT = join(resolve(import.meta.dir, ".."), "dist/plugins");
const at = process.argv.indexOf("--server");
const server = new URL(at > 0 ? process.argv[at + 1] : "http://localhost:4400").origin;

rmSync(OUT, { recursive: true, force: true });
for (const [plugin, files] of Object.entries(await pluginFiles())) {
  for (const [path, body] of Object.entries(files)) {
    const file = join(OUT, plugin, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body.replaceAll(PLUGIN_SERVER_MARK, server));
    if (path.startsWith("bin/") || path.endsWith(".sh")) chmodSync(file, 0o755);
  }
}
console.log(`Wrote the plugins for ${server} in ${OUT}:`);
console.log(`  claude --plugin-dir ${join(OUT, "claude-code")}`);
console.log(`  agy plugin install ${join(OUT, "antigravity")}`);
