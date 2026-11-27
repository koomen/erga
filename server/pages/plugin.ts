// Local bridge distribution endpoints (/plugin/bridge.json, /plugin/bridge.js,
// /plugin/install.sh): serves the lightweight ~200 KB bundled bridge JS built by
// client/build.ts alongside each Erga release, plus a minimal POSIX installer
// that pins the install origin in ~/.erga/update.json and installs the 5-second
// crash-rollback launcher shim at ~/.erga/bin/erga-agent.

import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import { call, ctx, fromWeb, json, text, type Route } from "../http.ts";
import { assetManifest } from "./assets.ts";

/** GET /plugin/bridge.json: latest bridge bundle version, SHA-256, and minimum herdr-core version. */
export const serveBridgeManifest: Route = Effect.sync(() => {
  const b = assetManifest()?.bridge;
  if (!b) return json({ error: "Bridge bundle is not built on this server." }, 404);
  return HttpServerResponse.setHeaders(
    json({
      version: b.version,
      sha256: b.sha256,
      size: b.size,
      minHcVersion: b.minHcVersion,
      url: "/plugin/bridge.js",
      asset: b.file,
    }),
    { "Cache-Control": "no-cache" }
  );
});

/** GET /plugin/bridge.js: serves the current release's bundled bridge JavaScript file. */
export const serveBridgeBundle: Route = Effect.gen(function* () {
  const { url, platform } = yield* ctx;
  const b = assetManifest()?.bridge;
  if (!b) return text("Bridge bundle is not built on this server.", 404);
  const res = yield* call(() => platform.assets(new Request(new URL(b.file, url.origin))));
  if (!res.ok) return text("Bridge bundle asset missing.", 404);
  return HttpServerResponse.setHeaders(fromWeb(res), {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Erga-Bridge-Version": b.version,
    "X-Erga-Bridge-Sha256": b.sha256,
    "X-Content-Type-Options": "nosniff",
  });
});

/** GET /plugin/install.sh: POSIX installer bound to this Erga server's origin. */
export const serveBridgeInstaller: Route = Effect.gen(function* () {
  const { url } = yield* ctx;
  const origin = url.origin;
  const script = `#!/bin/sh
set -eu
ORIGIN=${JSON.stringify(origin)}
HOME_DIR="\${ERGA_HOME:-\$HOME/.erga}"
RT="\$HOME_DIR/runtime"
BIN_DIR="\$HOME_DIR/bin"
mkdir -p "\$RT/releases" "\$BIN_DIR"
chmod 700 "\$HOME_DIR"

printf '{"origin":"%s"}\\n' "\$ORIGIN" > "\$HOME_DIR/update.json"
chmod 600 "\$HOME_DIR/update.json"

MANIFEST=\$(curl -fsSL "\$ORIGIN/plugin/bridge.json")
VERSION=\$(printf '%s' "\$MANIFEST" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
SHA=\$(printf '%s' "\$MANIFEST" | sed -n 's/.*"sha256":"\\([^"]*\\)".*/\\1/p')
if [ -z "\$VERSION" ] || [ -z "\$SHA" ]; then
  echo "Could not parse bridge manifest from \$ORIGIN/plugin/bridge.json" >&2
  exit 1
fi

REL_DIR="\$RT/releases/\$VERSION"
mkdir -p "\$REL_DIR"
TMP="\$REL_DIR/bridge.js.tmp.\$\$"
curl -fsSL "\$ORIGIN/plugin/bridge.js" -o "\$TMP"
if command -v shasum >/dev/null 2>&1; then
  GOT=\$(shasum -a 256 "\$TMP" | awk '{print \$1}')
else
  GOT=\$(sha256sum "\$TMP" | awk '{print \$1}')
fi
if [ "\$GOT" != "\$SHA" ]; then
  rm -f "\$TMP"
  echo "SHA-256 mismatch: expected \$SHA, got \$GOT" >&2
  exit 1
fi
mv "\$TMP" "\$REL_DIR/bridge.js"
chmod 755 "\$REL_DIR/bridge.js"
ln -sfn "\$REL_DIR" "\$RT/current"

cat <<'SHIM' > "\$BIN_DIR/erga-agent"
#!/bin/sh
set -eu
HOME_DIR="\${ERGA_HOME:-\$HOME/.erga}"
RT="\$HOME_DIR/runtime"
CUR="\$RT/current"
PREV="\$RT/previous"
BUN_BIN="\${ERGA_BUN_BIN:-\$(command -v bun 2>/dev/null || echo "\$HOME/.bun/bin/bun")}"
if [ ! -x "\$BUN_BIN" ]; then
  echo "erga-agent requires Bun (https://bun.sh)" >&2
  exit 1
fi
START=\$(date +%s)
set +e
"\$BUN_BIN" "\$CUR/bridge.js" "\$@"
CODE=\$?
set -e
ELAPSED=\$(( \$(date +%s) - START ))
if [ "\$CODE" -ne 0 ] && [ "\$ELAPSED" -lt 5 ] && [ ! -f "\$CUR/.healthy" ] && [ -e "\$PREV/bridge.js" ]; then
  TARGET=\$(readlink "\$PREV" || echo "\$PREV")
  ln -sfn "\$TARGET" "\$CUR"
  exec "\$BUN_BIN" "\$CUR/bridge.js" "\$@"
fi
exit "\$CODE"
SHIM
chmod 755 "\$BIN_DIR/erga-agent"
echo "Installed erga-agent (\$VERSION) to \$BIN_DIR/erga-agent"
echo "Add \$BIN_DIR to your PATH if it is not already there."
`;
  return HttpServerResponse.setHeaders(text(script, 200), {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });
});
