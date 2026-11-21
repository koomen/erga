// Erga's plugin for Claude Code (agents/plugin.ts): the marketplace that names it, and the zip that is the plugin. Its
// files name this server; the helper's files come from the server's static files, as the build left them; the zip
// opens with the system's own tool, and its programs may run.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, marketplace, pluginRoutes, pluginText, zip } from "../agents/plugin.ts";
import { respond } from "../server/http.ts";
import type { Platform } from "../server/platform.ts";

const dir = mkdtempSync(join(tmpdir(), "erga-plugin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVER = "https://erga.example.com";
/** A server whose static files have the helper for these systems (helper/build.ts's .build/helper/). */
function platform(helpers: Record<string, Uint8Array>): Platform {
  const files = Object.entries(helpers).map(([name, bytes]) => ({
    name,
    size: bytes.length,
    crc32: crc32(bytes),
    sha256: Bun.hash(bytes).toString(16),
  }));
  const assets = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path == "/helper/index.json" && files.length) return Response.json({ files });
    const bytes = helpers[path.replace("/helper/", "")];
    return bytes ? new Response(bytes as BodyInit) : new Response("", { status: 404 });
  };
  return { assets } as unknown as Platform;
}
const get = (path: string, p: Platform) => respond(pluginRoutes, new Request(`${SERVER}${path}`), p);
/** Opens a zip with the system's own tool: its folder. */
async function opened(response: Response, name: string): Promise<string> {
  const file = join(dir, `${name}.zip`),
    out = join(dir, name);
  writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  const r = Bun.spawnSync(["unzip", "-q", file, "-d", out]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return out;
}

test("a CRC-32 is the one that every zip tool computes", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

test("the plugin's files name this server: the monitor and the MCP server go there, and the hooks run the helper", () => {
  const files = pluginText(SERVER, "1.0.7");
  expect(Object.keys(files).sort()).toEqual([
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "bin/erga",
    "hooks/hooks.json",
    "monitors/monitors.json",
    "skills/attach/SKILL.md",
  ]);
  expect(JSON.parse(files[".claude-plugin/plugin.json"])).toMatchObject({ name: "erga", version: "1.0.7" });
  // The monitor starts with the skill (its name with the plugin's), and holds the link to this server.
  expect(JSON.parse(files["monitors/monitors.json"])).toEqual([
    {
      name: "panel",
      command: `sh "\${CLAUDE_PLUGIN_ROOT}/bin/erga" link --server ${SERVER}`,
      description: "Messages from the Erga panel",
      when: "on-skill-invoke:erga:attach",
    },
  ]);
  expect(JSON.parse(files[".mcp.json"])).toEqual({
    mcpServers: {
      erga: { type: "http", url: `${SERVER}/mcp`, headersHelper: `sh "\${CLAUDE_PLUGIN_ROOT}/bin/erga" header --server ${SERVER}` },
    },
  });
  const hooks = JSON.parse(files["hooks/hooks.json"]).hooks as Record<string, { hooks: { command: string; timeout: number }[] }[]>;
  for (const e of ["UserPromptSubmit", "MessageDisplay", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"])
    expect(hooks[e][0].hooks[0].command).toBe('sh "${CLAUDE_PLUGIN_ROOT}/bin/erga" hook');
  // A permission prompt may wait for the person's answer in the panel; no other hook holds the session.
  expect(hooks.PermissionRequest[0].hooks[0].timeout).toBe(600);
  expect(hooks.PreToolUse[0].hooks[0].timeout).toBe(10);
  expect(files["skills/attach/SKILL.md"]).toContain(`agent panel in Erga (${SERVER})`);
  expect(files["skills/attach/SKILL.md"]).not.toContain("{server}");
  // The monitor's description is the one that the helper knows a panel's message by.
  expect(readFileSync(new URL("../helper/src/map.rs", import.meta.url), "utf8")).toContain(
    'pub const MONITOR: &str = "Messages from the Erga panel";'
  );
});

test("the marketplace names the plugin's zip on this server; other helper files give another version", async () => {
  const one = platform({ "erga-darwin-arm64": new Uint8Array([1, 2, 3]) });
  const answer = await get("/agents/marketplace.json", one);
  expect(answer.status).toBe(200);
  const body = (await answer.json()) as ReturnType<typeof marketplace>;
  expect(body).toMatchObject({
    name: "erga",
    plugins: [{ name: "erga", source: { source: "archive", url: `${SERVER}/agents/erga.zip` } }],
  });
  expect(body.plugins[0].version).toMatch(/^1\.0\.\d+$/);
  const other = (await (
    await get("/agents/marketplace.json", platform({ "erga-darwin-arm64": new Uint8Array([9]) }))
  ).json()) as typeof body;
  expect(other.plugins[0].version).not.toBe(body.plugins[0].version);
  expect((await get("/agents/other", one)).status).toBe(404);
});

test("the zip is the plugin: its files open, the helper's files are whole, and the programs may run", async () => {
  const helper = crypto.getRandomValues(new Uint8Array(70_000));
  const p = platform({ "erga-darwin-arm64": helper, "erga-linux-x64": new Uint8Array([7, 7, 7]) });
  const answer = await get("/agents/erga.zip", p);
  expect([answer.status, answer.headers.get("content-type")]).toEqual([200, "application/zip"]);
  const out = await opened(answer, "with");
  const version = ((await (await get("/agents/marketplace.json", p)).json()) as ReturnType<typeof marketplace>).plugins[0].version;
  for (const [path, text] of Object.entries(pluginText(SERVER, version))) expect(readFileSync(join(out, path), "utf8")).toBe(text);
  expect(new Uint8Array(readFileSync(join(out, "bin/erga-darwin-arm64")))).toEqual(helper);
  const mode = (path: string) => (statSync(join(out, path)).mode & 0o777).toString(8);
  expect([mode("bin/erga"), mode("bin/erga-darwin-arm64"), mode("bin/erga-linux-x64"), mode("hooks/hooks.json")]).toEqual([
    "755",
    "755",
    "755",
    "644",
  ]);
  // The launcher runs the helper of this computer's system; where the plugin has none for it, it says so.
  writeFileSync(join(out, "bin/erga-darwin-arm64"), '#!/bin/sh\necho "the helper: $*"\n');
  writeFileSync(join(out, "bin/erga-darwin-x64"), '#!/bin/sh\necho "the helper: $*"\n');
  writeFileSync(join(out, "bin/erga-linux-arm64"), '#!/bin/sh\necho "the helper: $*"\n');
  writeFileSync(join(out, "bin/erga-linux-x64"), '#!/bin/sh\necho "the helper: $*"\n');
  expect(Bun.spawnSync(["sh", join(out, "bin/erga"), "hook", "x"]).stdout.toString()).toBe("the helper: hook x\n");

  // A server whose build made no helper: the plugin is whole all the same, and its launcher says what is missing.
  const bare = await opened(await get("/agents/erga.zip", platform({})), "bare");
  expect(Bun.spawnSync(["sh", join(bare, "bin/erga"), "hook"]).stdout.toString()).toBe("");
  expect(Bun.spawnSync(["sh", join(bare, "bin/erga"), "link"]).stdout.toString()).toMatch(
    /^\[Erga\] This session is not attached: this Erga has no helper for this computer/
  );
  expect(JSON.parse(Bun.spawnSync(["sh", join(bare, "bin/erga"), "header"]).stdout.toString())).toEqual({
    Authorization: "Bearer not-signed-in",
  });
});

test("the same files give the same zip, byte for byte", () => {
  const files = [
    { path: "a.txt", bytes: new TextEncoder().encode("one") },
    { path: "bin/b", bytes: new Uint8Array([0, 255]), run: true },
  ];
  expect(zip(files)).toEqual(zip(files));
});
