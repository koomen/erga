---
name: open
description: >-
  Open, create and edit Erga documents with live Yjs sync and live terminal
  bridging (herdr-core / rex). Use when the user gives an Erga document URL or
  address (/owner/slug), or asks for a new Erga document.
argument-hint: "[document URL or /owner/slug]"
---

# Open or create an Erga document

The document: $ARGUMENTS

1. Run `erga-agent open` in Bash to mount the document and bind this terminal (or `--space` for the whole space):
   - Existing document: `"${CLAUDE_PLUGIN_ROOT}/bin/erga-agent" open "<URL or /owner/slug>"` (add `--space` to bind the whole Herdr/Rex space)
   - New document: `"${CLAUDE_PLUGIN_ROOT}/bin/erga-agent" open --create --title "<title>"` (pass `--from "<dir>"` to copy files from a local folder)
   - When the answer has `needsAuth: true`, show the user its `verificationUriComplete` link and `userCode`, then retry once they approve.
2. Edit files in the returned `dir` (`~/.erga/docs/...`) using your native file tools. Every change syncs live via Yjs CRDT, and binary assets upload automatically.
3. Use the `erga` MCP tools (`page`, `documents`, `read`, `edit`) for screenshots (`view_page`), console logs (`page_log`), comments, versions, and publishing.
4. Keep HTML well-formed: close every element, keep text in plain leaf elements (`p`, `h1`-`h6`, `li`, `td`), and leave `data-erga` attributes alone.
