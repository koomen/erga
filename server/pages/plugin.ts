// Erga's plugin for a local agent, served by each instance, public and with no secret in it (shared/agent-plugin.ts
// has the commands that install it):
//
//   /plugin/marketplace.json   Claude Code's marketplace: one plugin, erga, from /plugin/claude-code.zip
//   /plugin/claude-code.zip    the plugin for Claude Code
//   /plugin/antigravity.zip    the plugin for Antigravity
//   /plugin/antigravity.sh     installs that one: agy installs only a folder (or a GitHub repository), so the script
//                              unzips it into a folder first, and puts erga-agent on the PATH, which its skill runs
//
// The files are the release's (plugins.json in the static assets: bridge/plugin-files.ts). Each zip says this
// instance's address where the launcher has PLUGIN_SERVER_MARK, so the plugin works with the instance it came from.
// The same release and address give the same zip: Claude Code names the plugin's version by the zip's hash, so a
// release is an update.

import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { PLUGIN_SERVER_MARK } from "../../shared/agent-plugin.ts";
import { zip } from "../../shared/zip.ts";
import { call, ctx, json, text } from "../http.ts";
import { asset } from "./assets.ts";

const NO_CACHE = { "Cache-Control": "no-cache" };

/** Claude Code's marketplace, with the plugin as a zip from here (a marketplace at an address gives no folder of its own). */
export const pluginMarketplace = Effect.map(ctx, ({ url }) =>
  json(
    {
      name: "erga",
      owner: { name: "Erga" },
      description: `Erga's plugin for Claude Code, from ${url.host}.`,
      plugins: [
        {
          name: "erga",
          description: "Edit Erga documents from Claude Code.",
          source: { source: "archive", url: `${url.origin}/plugin/claude-code.zip` },
        },
      ],
    },
    200,
    NO_CACHE
  )
);

/** The plugin for `agent` ("claude-code", "antigravity"), as a zip. */
export const pluginZip = (agent: string) =>
  Effect.gen(function* () {
    const { url, platform } = yield* ctx;
    const r = yield* call(() => platform.assets(new Request(new URL(asset("plugins.json"), url))));
    const files = r.ok ? ((yield* call(() => r.json())) as Record<string, Record<string, string>>)[agent] : undefined;
    if (!files) return text("This server's release has no agent plugin.", 404);
    const bytes = zip(
      Object.entries(files).map(([path, body]) => ({
        path,
        bytes: new TextEncoder().encode(body.replaceAll(PLUGIN_SERVER_MARK, url.origin)),
        mode: path.startsWith("bin/") || path.endsWith(".sh") ? 0o755 : 0o644,
      }))
    );
    return HttpServerResponse.uint8Array(bytes, {
      contentType: "application/zip",
      headers: { ...NO_CACHE, "Content-Disposition": `attachment; filename="erga-${agent}.zip"` },
    });
  });

/** The script that installs the plugin for Antigravity: `curl -fsSL <origin>/plugin/antigravity.sh | sh`. */
export const antigravityScript = Effect.map(ctx, ({ url }) =>
  HttpServerResponse.text(
    `#!/bin/sh
# Installs Erga's plugin for Antigravity from ${url.origin}.
set -eu
command -v agy >/dev/null 2>&1 || { echo "agy, Antigravity's command, isn't on the PATH: install Antigravity first." >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "${url.origin}/plugin/antigravity.zip" -o "$tmp/erga.zip"
unzip -q "$tmp/erga.zip" -d "$tmp/erga"
agy plugin uninstall erga >/dev/null 2>&1 || true
agy plugin install "$tmp/erga"
# The plugin's skill runs erga-agent: a command beside agy, which runs the installed plugin's.
plugin="$HOME/.gemini/config/plugins/erga/bin/erga-agent"
[ -f "$plugin" ] || { echo "agy installed the plugin, but not at $plugin: erga-agent isn't on the PATH." >&2; exit 1; }
bin="$(dirname "$(command -v agy)")"
[ -w "$bin" ] || { bin="$HOME/.local/bin"; mkdir -p "$bin"; }
printf '#!/bin/sh\\nexec sh "%s" "$@"\\n' "$plugin" > "$bin/erga-agent"
chmod 755 "$bin/erga-agent"
echo "Erga's plugin is installed for Antigravity, with erga-agent in $bin. Give Antigravity an Erga document's address to open it."
`,
    { contentType: "text/x-shellscript; charset=utf-8", headers: NO_CACHE }
  )
);
