---
name: erga
description: >-
  Open, create, and edit Erga documents locally via live Yjs sync while
  streaming directly with Erga's browser agent pane. Use when the user asks to
  edit an Erga document URL or create a new Erga document.
---

# Edit or Create an Erga Document

1. Call `erga_open`:
   - Existing document: `erga_open({ document: "<url or /owner/slug>" })`
   - New document: `erga_open({ create: true, title: "<title>" })` (pass `fromDir` to copy files from a local folder into the new document's managed directory)
   - If the user has not signed in yet, `erga_open` opens Erga's OAuth approval page in their browser.
2. Note the managed `dir` path returned by `erga_open` (`~/.erga/docs/...`). That folder is live-synced to the Erga document over Yjs. If files were copied from a local project folder, let the user know the synced copy lives in `dir` and their original folder is untouched.
3. Read and edit files directly in `dir` with native file and shell tools. Binary assets (images, PDFs) written into `dir` upload automatically.
4. Inspect how the page looks and behaves with Erga's `page` tool (`view_page`, `page_log`, `open_page`) when helpful.
5. The browser's embedded agent pane is connected to this session automatically; the user can continue the conversation from the browser or the terminal.
