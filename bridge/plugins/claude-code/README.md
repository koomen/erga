# Erga for Claude Code

The plugin connects a Claude Code session to an Erga document:

- `erga-agent open` (via `/erga:open`) makes a live copy of the document in `~/.erga/docs/`. Claude Code
  edits the files there, and each edit shows in the browser at once.
- The session has Erga's tools (`documents`, `read`, `edit`, `page`).
- The document's agent panel shows the session's turns. A prompt typed in the
  panel runs in a second Claude Code session, in the background.

## Install

Build the plugin (it holds the `erga-agent` binary):

    bun bridge/build.ts

For one session only:

    claude --plugin-dir dist/plugins/claude-code

To keep it:

    claude plugin marketplace add ./dist/plugins
    claude plugin install erga@erga

## Connect a session to a document

In Claude Code, give it the document:

    /erga:open https://<your Erga server>/<owner>/<slug>

The first time, Claude Code shows a link and a code. Open the link in your
browser and approve the code. Then tell Claude Code to continue.

`erga-agent status --agent claude-code` shows what is open.
`erga-agent unmount --agent claude-code <doc-id>` closes one mounted document.
`erga-agent stop --agent claude-code` ends the background bridge.
