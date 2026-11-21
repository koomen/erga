// Erga's plugin for Claude Code, which this server makes and hosts: with it, a person attaches a session to their agent
// panel (`/erga:attach`; agents/link.ts is the server's side). Each Erga server has its own plugin, with its own
// address in it:
//
//   GET /agents/marketplace.json   the marketplace that names the plugin: /plugin marketplace add <this address>
//   GET /agents/erga.zip           the plugin, as one zip: /plugin install erga@erga
//
// The plugin has a skill (attach), hooks that give the session's events to the helper, a monitor that holds the link
// and brings the panel's messages in, Erga's MCP server with the helper's token, and the helper itself (helper/, a
// native program for each of four platforms). The helper's files come from the server's static files (helper/build.ts
// puts them in .build/helper/, with their sizes and CRCs): a server that has none makes the plugin without them, and
// its launcher says so.
//
// Both addresses answer anyone: Claude Code fetches them with no sign-in, and nothing in them is secret.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { call, ctx, fromWeb, json, type Route } from "../server/http.ts";
import { routeFor, type RouteRow } from "../shared/routes.ts";
import skill from "./plugin/SKILL.md" with { type: "text" };

/** The monitor's description: the helper knows a message of the panel's by it (helper/src/map.rs, MONITOR). */
const MONITOR = "Messages from the Erga panel";
/** The session's events that the helper hears; a permission prompt may wait as long as Claude Code lets a hook wait. */
const HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "MessageDisplay",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

/** The launcher: the helper for this computer's system, of the four in the plugin. */
const LAUNCHER = `#!/bin/sh
# Erga's helper for this computer: the plugin has one file for each system.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) p=darwin-arm64 ;;
  Darwin-x86_64) p=darwin-x64 ;;
  Linux-aarch64 | Linux-arm64) p=linux-arm64 ;;
  Linux-x86_64) p=linux-x64 ;;
  *) p=none ;;
esac
here="$(dirname "$0")"
if [ -f "$here/erga-$p" ]; then
  [ -x "$here/erga-$p" ] || chmod +x "$here/erga-$p"
  exec "$here/erga-$p" "$@"
fi
# No helper for this system: a hook says nothing, the monitor says why, and the MCP header has no token.
case "$1" in
  link) echo "[Erga] This session is not attached: this Erga has no helper for this computer ($(uname -s) $(uname -m))." ;;
  header) echo '{"Authorization":"Bearer not-signed-in"}' ;;
esac
exit 0
`;

/** The plugin's text files for the server at `server` (its origin), by their path in the plugin. */
export function pluginText(server: string, version: string): Record<string, string> {
  // (Through sh: a zip's reader may drop the file's right to run.)
  const erga = 'sh "${CLAUDE_PLUGIN_ROOT}/bin/erga"';
  const hook = (event: string) => [
    { hooks: [{ type: "command", command: `${erga} hook`, timeout: event == "PermissionRequest" ? 600 : 10 }] },
  ];
  const files = {
    ".claude-plugin/plugin.json": {
      name: "erga",
      version,
      description: `Attach a session to your agent panel in Erga (${new URL(server).host})`,
      author: { name: "Erga" },
    },
    "hooks/hooks.json": { hooks: Object.fromEntries([...HOOKS, "PermissionRequest"].map((e) => [e, hook(e)])) },
    "monitors/monitors.json": [
      { name: "panel", command: `${erga} link --server ${server}`, description: MONITOR, when: "on-skill-invoke:erga:attach" },
    ],
    ".mcp.json": { mcpServers: { erga: { type: "http", url: `${server}/mcp`, headersHelper: `${erga} header --server ${server}` } } },
  };
  return {
    ...Object.fromEntries(Object.entries(files).map(([path, value]) => [path, `${JSON.stringify(value, null, 2)}\n`])),
    "skills/attach/SKILL.md": skill.replaceAll("{server}", server),
    "bin/erga": LAUNCHER,
  };
}

/** The marketplace that names the plugin, for `/plugin marketplace add`. */
export const marketplace = (server: string, version: string) => ({
  name: "erga",
  owner: { name: "Erga" },
  plugins: [
    {
      name: "erga",
      description: `Attach a Claude Code session to your agent panel in Erga (${new URL(server).host})`,
      version,
      source: { source: "archive", url: `${server}/agents/erga.zip` },
    },
  ],
});

// ---------------------------------------------------------------- a zip

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A file of a zip; `crc`: its CRC-32, when it is known already (a large file); `run`: a program. */
export interface ZipFile {
  path: string;
  bytes: Uint8Array;
  crc?: number;
  run?: boolean;
}

/**
 * A zip of the files, each stored as it is (no compression: the helper's files are most of it, and the answer is
 * compressed on its way). The same files give the same bytes: every file has the date 1980-01-01.
 */
export function zip(files: ZipFile[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = f.crc ?? crc32(f.bytes);
    /** The fields that the file's two headers share: version 2.0, no flags, stored, time, date, CRC, sizes, name. */
    const shared = (v: DataView, o: number) => {
      v.setUint16(o, 20, true);
      v.setUint16(o + 8, 0x21, true);
      v.setUint32(o + 10, crc, true);
      v.setUint32(o + 14, f.bytes.length, true);
      v.setUint32(o + 18, f.bytes.length, true);
      v.setUint16(o + 22, name.length, true);
    };
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    shared(lv, 4);
    local.set(name, 30);
    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    // Made on Unix: the file's mode is in the high half of the outside attributes.
    ev.setUint16(4, (3 << 8) | 20, true);
    shared(ev, 6);
    ev.setUint32(38, ((f.run ? 0o100755 : 0o100644) << 16) >>> 0, true);
    ev.setUint32(42, at, true);
    entry.set(name, 46);
    parts.push(local, f.bytes);
    central.push(entry);
    at += local.length + f.bytes.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, size, true);
  v.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let o = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- the routes

/** The helper's files that the server's build has (helper/build.ts): each one's name, size, CRC-32 and SHA-256. */
const Index = Schema.Struct({
  files: Schema.Array(Schema.Struct({ name: Schema.String, size: Schema.Finite, crc32: Schema.Finite, sha256: Schema.String })),
});
const decodeIndex = Schema.decodeUnknownOption(Schema.fromJsonString(Index));

/** The helper's files, from the server's static files; none where the build made none. */
const helpers = Effect.gen(function* () {
  const { url, platform } = yield* ctx;
  const read = (path: string) =>
    call(() =>
      platform.assets(new Request(new URL(path, url))).then(
        (r) => (r.ok ? r.arrayBuffer() : null),
        () => null
      )
    );
  const text = yield* read("/helper/index.json");
  const index = text ? decodeIndex(new TextDecoder().decode(text)) : null;
  return index?._tag == "Some" ? { files: index.value.files, read } : { files: [], read };
});

/** The plugin's version: other files, another version (Claude Code takes an update only then). */
const versionOf = (files: readonly { sha256: string }[], server: string) => {
  const text = Object.values(pluginText(server, "")).join("\n") + files.map((f) => f.sha256).join("");
  return `1.0.${crc32(new TextEncoder().encode(text))}`;
};

const marketplaceRoute: Route = Effect.gen(function* () {
  const { url } = yield* ctx;
  const { files } = yield* helpers;
  return json(marketplace(url.origin, versionOf(files, url.origin)), 200, { "Cache-Control": "no-store" });
});

const zipRoute: Route = Effect.gen(function* () {
  const { url } = yield* ctx;
  const { files, read } = yield* helpers;
  const enc = new TextEncoder();
  const text = Object.entries(pluginText(url.origin, versionOf(files, url.origin))).map(
    ([path, body]): ZipFile => ({ path, bytes: enc.encode(body), run: path == "bin/erga" })
  );
  const programs: ZipFile[] = [];
  for (const f of files) {
    const bytes = yield* read(`/helper/${f.name}`);
    if (bytes?.byteLength == f.size) programs.push({ path: `bin/${f.name}`, bytes: new Uint8Array(bytes), crc: f.crc32, run: true });
  }
  const headers = {
    "Content-Type": "application/zip",
    "Cache-Control": "no-store",
    "Content-Disposition": 'attachment; filename="erga.zip"',
  };
  return fromWeb(new Response(zip([...text, ...programs]), { headers }));
});

const PLUGIN = "Claude Code's own fetch of Erga's plugin: a person installs it there, one time";

/** The plugin's routes. */
export const ROUTES: readonly RouteRow<Route>[] = [
  {
    method: "GET",
    path: "/agents/marketplace.json",
    run: marketplaceRoute,
    action: "The marketplace that names Erga's plugin for Claude Code",
    domain: "none",
    exempt: PLUGIN,
  },
  { method: "GET", path: "/agents/erga.zip", run: zipRoute, action: "Erga's plugin for Claude Code", domain: "none", exempt: PLUGIN },
];

export const isPluginPath = (path: string) => path.startsWith("/agents/");

export const pluginRoutes: Route = Effect.gen(function* () {
  const { request, url } = yield* ctx;
  const found = routeFor(ROUTES, request.method == "HEAD" ? "GET" : request.method, url.pathname);
  return found ? yield* found.route.run : json({ error: "Not found" }, 404);
});
