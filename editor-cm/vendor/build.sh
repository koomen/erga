#!/usr/bin/env bash
# Rebuilds vendor/vendor.js: a single classic-script bundle of CodeMirror 6,
# marked and DOMPurify, exposed as window.Vendor. Runs in a throwaway temp dir so
# nothing is installed into the repo. Usage: ./vendor/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/entry.js" "$tmp/entry.js"
cd "$tmp"
echo '{"name":"editor-vendor","private":true}' > package.json
bun add --silent \
  @codemirror/state@6.7.6 @codemirror/view@6.43.13 @codemirror/commands@6.11.1 \
  @codemirror/language@6.12.4 @codemirror/lang-markdown@6.5.2 @lezer/highlight@1.2.5 \
  marked@18.0.14 dompurify@3.4.16
bun build entry.js --format iife --minify --outfile "$here/vendor.js" \
  --banner "/* Built by vendor/build.sh: CodeMirror 6 (MIT), marked (MIT), DOMPurify (Apache-2.0/MPL-2.0). */"
echo "built $here/vendor.js ($(wc -c < "$here/vendor.js" | tr -d " ") bytes)"
