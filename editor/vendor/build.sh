#!/usr/bin/env bash
# Rebuilds vendor/vendor.js: a classic-script bundle of marked and DOMPurify
# (used only by the preview pane), exposed as window.Vendor. Runs in a
# throwaway temp dir so nothing is installed into the repo. Usage: ./vendor/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/entry.js" "$tmp/entry.js"
cd "$tmp"
echo '{"name":"editor-vendor","private":true}' > package.json
bun add --silent marked@18.0.14 dompurify@3.4.16
bun build entry.js --format iife --minify --outfile "$here/vendor.js" \
  --banner "/* Built by vendor/build.sh: marked (MIT), DOMPurify (Apache-2.0/MPL-2.0). */"
echo "built $here/vendor.js ($(wc -c < "$here/vendor.js" | tr -d " ") bytes)"
