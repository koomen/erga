---
name: erga
description: >-
  Open, create, and edit Erga documents locally via live Yjs sync while
  streaming directly with Erga's browser agent pane. Use when the user asks to
  edit an Erga document URL or create a new Erga document.
---

# Edit or Create an Erga Document

1. Run `erga-agent open` via `run_command` so the live Yjs room mounts locally **and** Erga's browser pane attaches directly to this running Antigravity session (same process, model, context, and permissions):
   - Existing document: `erga-agent open "<url or /owner/slug>"`
   - New document: `erga-agent open --create --title "<title>"` (pass `--from <dir>` to copy files from a local folder into the new document's managed directory)
   - Unmount a document later: `erga-agent unmount "<docId>"` (check open mounts with `erga-agent status`)
   - If the user has not signed in yet, `erga-agent open` returns `needsAuth: true` with a `verificationUriComplete` URL and `userCode`. Show that URL and code to the user so they can approve in any browser (including on another device when remote), then run `erga-agent open` again once they confirm.
2. Note the managed `dir` path returned (`~/.erga/docs/...`). That folder is live-synced to the Erga document over Yjs. If files were copied from a local project folder, let the user know the synced copy lives in `dir` and their original folder is untouched.
3. Read and edit files directly in `dir` with native file and shell tools. Binary assets (images, PDFs) written into `dir` upload automatically.
4. Inspect how the page looks and behaves with Erga's `page` tool (`view_page`, `page_log`, `open_page`) when helpful.
5. The browser's embedded agent pane is connected directly to this live session; prompts typed in Erga arrive here as `Erga browser panel` messages, and your work streams back to the pane in real time.
