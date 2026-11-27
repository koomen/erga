---
name: erga
description: >-
  Open, create, and edit Erga documents locally via live Yjs sync while
  attaching your herdr-core or rex terminal (or whole space) to Erga's browser
  pane. Use when the user asks to edit an Erga document URL or create a new Erga
  document.
---

# Edit or Create an Erga Document

1. Run `erga-agent open` so the live Yjs room mounts locally and Erga's browser pane attaches directly to your live terminal (or whole space):
   - Single terminal: `erga-agent open "<url or /owner/slug>"`
   - Whole space: `erga-agent open --space "<url or /owner/slug>"`
   - New document: `erga-agent open --create --title "<title>"` (pass `--from <dir>` to copy files from a local folder into the new document's managed directory)
   - Unmount later: `erga-agent unmount "<docId>"` (inspect mounts with `erga-agent status` or list spaces with `erga-agent spaces`)
   - If `erga-agent open` returns `needsAuth: true`, show the `verificationUriComplete` URL and `userCode` so the user can approve in any browser, then retry once they confirm.
2. Read and edit files directly in the returned `dir` (`~/.erga/docs/...`). Every change syncs live via Yjs CRDT, and binary assets upload automatically.
3. Use Erga's MCP tools (`page`, `documents`, `read`, `edit`, `settings`, `people`) for live screenshots (`view_page`), console logs (`page_log`), comments, versions, and publishing.
