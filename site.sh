#!/usr/bin/env bash
# Gathers the editor's own files into .site/, the Worker's static assets:
# page.html (as editor.html: the Worker serves it under each document's
# address), page.js, style.css and the fonts.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
rm -rf .site && mkdir -p .site
cp page.html .site/editor.html
cp -r page.js style.css fonts .site/
