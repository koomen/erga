# Erga

When the user asks to edit an Erga document (a URL, `/<owner>/<slug>`, or document id) or create a new Erga document:

1. Mount the document and connect this live terminal (or your whole Herdr/Rex space) via `erga-agent open`:
   - Existing document (single terminal): `erga-agent open "<url or /owner/slug>"`
   - Existing document (whole space): `erga-agent open --space "<url or /owner/slug>"`
   - New document: `erga-agent open --create --title "<title>"` (pass `--from <dir>` to copy existing local HTML/assets into the new document's managed directory)
   - Unmount a document: `erga-agent unmount "<docId>"` (check mounted documents with `erga-agent status` or list spaces with `erga-agent spaces`)
   - If `erga-agent open` returns `needsAuth: true`, show the user the clickable `verificationUriComplete` URL and `userCode` so they can approve in any browser, then run the command again once they confirm.
   - Every Erga document is mounted in its own managed directory under `~/.erga/docs/`. When copying files from a local project into a new Erga document, tell the user that the files were copied into that managed directory and their original folder is untouched.
2. Read and edit the document's source files directly in the returned local directory using your native file tools. Every file change syncs live to Erga via Yjs.
3. Use the proxied Erga MCP tools (`page`, `documents`, `read`, `edit`, `settings`, `people`) for operations that local files cannot perform: rendering screenshots (`page` op `view_page`), reading browser console logs (`page_log`), interacting with the live page (`page_input`, `open_page`), calling page-specific edits (`call_edit`), comments, version history, publishing, and sharing.
4. Keep HTML well-formed (close every tag, keep text in plain leaf elements like `p`, `h1`-`h6`, `li`, `td`, leave `data-erga` attributes alone) so human editors can keep editing alongside you.
