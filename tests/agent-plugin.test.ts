// Erga's plugin for a local agent, as an instance serves it (server/pages/plugin.ts): Claude Code's marketplace names
// the zip at the instance's own address; each zip has the plugin's files, a launcher that runs, and the instance's
// address in place of the mark; the same release gives the same zip; and the Antigravity script is valid sh.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginFiles } from "../bridge/plugin-files.ts";
import { respond } from "../server/http.ts";
import { antigravityScript, pluginMarketplace, pluginZip, useAssets } from "../server/pages/index.ts";
import type { Platform } from "../server/platform.ts";
import { PLUGIN_SERVER_MARK } from "../shared/agent-plugin.ts";
import { MANIFEST } from "./helpers/app";

const FILES = await pluginFiles();
const AT = "/_erga/plugins-test.json";
const platform = {
  assets: async (r: Request) =>
    new URL(r.url).pathname == AT ? new Response(JSON.stringify(FILES)) : new Response("Not found", { status: 404 }),
} as unknown as Platform;
const DIR = mkdtempSync(join(tmpdir(), "erga-plugin-"));
useAssets({ ...MANIFEST, files: { ...MANIFEST.files, "plugins.json": AT } });
afterAll(() => {
  useAssets(null);
  rmSync(DIR, { recursive: true, force: true });
});

const unzip = (...args: string[]) => Bun.spawnSync(["unzip", ...args]).stdout.toString();

test("Claude Code's marketplace names the plugin's zip at the instance's own address", async () => {
  const r = await respond(pluginMarketplace, new Request("https://erga.example.com/plugin/marketplace.json"), platform);
  expect(await r.json()).toMatchObject({
    name: "erga",
    plugins: [{ name: "erga", source: { source: "archive", url: "https://erga.example.com/plugin/claude-code.zip" } }],
  });
});

test("each zip is its plugin, with a launcher that runs and the instance's address; the same release gives the same zip", async () => {
  for (const agent of ["claude-code", "antigravity"]) {
    const get = () => respond(pluginZip(agent), new Request(`https://erga.example.com/plugin/${agent}.zip`), platform);
    const bytes = new Uint8Array(await (await get()).arrayBuffer());
    expect(new Uint8Array(await (await get()).arrayBuffer())).toEqual(bytes);
    const file = join(DIR, `${agent}.zip`);
    writeFileSync(file, bytes);
    expect(Bun.spawnSync(["unzip", "-tq", file]).exitCode).toBe(0);
    expect(unzip("-Z1", file).trim().split("\n").sort()).toEqual(Object.keys(FILES[agent]).sort());
    expect(unzip("-Z", file, "bin/erga-agent")).toContain("-rwxr-xr-x");
    const launcher = unzip("-p", file, "bin/erga-agent");
    expect(launcher).toContain('ERGA_SERVER="${ERGA_SERVER:-https://erga.example.com}"');
    expect(launcher).not.toContain(PLUGIN_SERVER_MARK);
  }
  // The launcher runs erga-agent.js beside it, as the installed plugin does.
  Bun.spawnSync(["unzip", "-q", join(DIR, "claude-code.zip"), "-d", join(DIR, "cc")]);
  const help = Bun.spawnSync(["sh", join(DIR, "cc/bin/erga-agent"), "help"]);
  expect(help.stdout.toString()).toContain("erga-agent open");
  const missing = await respond(pluginZip("codex"), new Request("https://erga.example.com/plugin/codex.zip"), platform);
  expect(missing.status).toBe(404);
});

test("the Antigravity script installs the zip from the instance itself", async () => {
  const r = await respond(antigravityScript, new Request("https://erga.example.com/plugin/antigravity.sh"), platform);
  const script = await r.text();
  expect(script).toStartWith("#!/bin/sh\n");
  expect(script).toContain('curl -fsSL "https://erga.example.com/plugin/antigravity.zip"');
  expect(script).toContain('agy plugin install "$tmp/erga"');
  expect(Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0);
});
