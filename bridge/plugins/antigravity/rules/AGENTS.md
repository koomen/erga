# Erga

When the user asks to edit an Erga document (a URL, `/<owner>/<slug>`, or document id) or create a new Erga document:

1. Call `erga_open` first:
   - Existing document: `erga_open({ document: "<url or /owner/slug>" })`
   - New document from the current project: `erga_open({ create: true, title: "<title>" })` (pass `fromDir` if copying existing local HTML/assets into the new Erga document)
   - If `erga_open` (or another Erga tool) returns `needsAuth: true`, show the user the clickable `verificationUriComplete` URL and `userCode` so they can approve in any browser (local or remote), then call `erga_open` again once they confirm.
   - Every Erga document is mounted in its own managed directory under `~/.erga/docs/`. When copying files from a local project into a new Erga document, tell the user that the files were copied into that managed directory and their original folder is untouched.
2. `erga_open` mounts the document's live Yjs room into a local directory AND connects this Antigravity session to the document's browser agent pane.
3. Read and edit the document's source files directly in the returned local directory using your native file tools (`read_file`, `edit_file`, `write_file`, `run_command`). Every file change syncs live to Erga via Yjs with agent attribution.
4. Use the proxied Erga MCP tools (`page`, `documents`, `read`, `edit`, `settings`, `people`) for operations that local files cannot perform: rendering screenshots (`page` op `view_page`), reading browser console logs (`page_log`), interacting with the live page (`page_input`, `open_page`), calling page-specific edits (`call_edit`), comments, version history, publishing, and sharing.
5. Keep HTML well-formed (close every tag, keep text in plain leaf elements like `p`, `h1`-`h6`, `li`, `td`, leave `data-erga` attributes alone) so human editors can keep editing alongside you.
