# Erga

When the user asks to edit an Erga document (a URL, `/<owner>/<slug>`, or document id) or create a new Erga document:

1. Connect this live session and mount the document first via `run_command` (so Erga's browser agent pane talks directly to **this** running Antigravity session without spawning a second background agent):
   - Existing document: `erga-agent open "<url or /owner/slug>"`
   - New document: `erga-agent open --create --title "<title>"` (pass `--from <dir>` to copy existing local HTML/assets into the new document's managed directory)
   - If you already called the MCP tool `erga_open`, run `erga-agent attach` via `run_command` so browser prompts route straight into this running session.
   - If `erga-agent open` or `erga_open` returns `needsAuth: true`, show the user the clickable `verificationUriComplete` URL and `userCode` so they can approve in any browser (local or remote), then run the command again once they confirm.
   - Every Erga document is mounted in its own managed directory under `~/.erga/docs/`. When copying files from a local project into a new Erga document, tell the user that the files were copied into that managed directory and their original folder is untouched.
2. Read and edit the document's source files directly in the returned local directory using your native file tools (`read_file`, `edit_file`, `write_file`, `run_command`). Every file change syncs live to Erga via Yjs with agent attribution.
3. Use the proxied Erga MCP tools (`page`, `documents`, `read`, `edit`, `settings`, `people`) for operations that local files cannot perform: rendering screenshots (`page` op `view_page`), reading browser console logs (`page_log`), interacting with the live page (`page_input`, `open_page`), calling page-specific edits (`call_edit`), comments, version history, publishing, and sharing.
4. Messages arriving with title `Erga browser panel` were typed directly by your user in Erga's browser pane — act on them just like prompts typed in this terminal.
5. Keep HTML well-formed (close every tag, keep text in plain leaf elements like `p`, `h1`-`h6`, `li`, `td`, leave `data-erga` attributes alone) so human editors can keep editing alongside you.
