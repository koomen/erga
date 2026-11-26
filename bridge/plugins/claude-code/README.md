# Erga for Claude Code

The plugin connects a Claude Code session to an Erga document:

- `erga-agent open` (via `/erga:open`) makes a live copy of the document in `~/.erga/docs/`. Claude Code
  edits the files there, and each edit shows in the browser at once.
- The session has Erga's tools (`documents`, `read`, `edit`, `page`).
- The document's agent panel shows the session's turns. A prompt typed in the
  panel runs in the same session, and the terminal shows it as hook feedback.
  When Claude Code asks for a permission, the panel shows a card: answer there
  or in the terminal.
- After the session's terminal closes, a prompt typed in the panel runs in a
  second Claude Code session, in the background.

## Install

Each Erga server serves the plugin. In a terminal:

    claude plugin marketplace add https://<your Erga server>/plugin/marketplace.json
    claude plugin install erga@erga

The plugin works with the server that it came from. It needs Bun or Node.js
on the computer. `claude plugin update erga@erga` gets the server's newest
release. Settings, in Erga, shows the same commands with your server's address.

To work on the plugin itself, write it from this checkout and start a session
with it: `bun bridge/build.ts --server <url>`, then
`claude --plugin-dir dist/plugins/claude-code`.

## Connect a session to a document

In Claude Code, give it the document:

    /erga:open https://<your Erga server>/<owner>/<slug>

The first time, Claude Code shows a link and a code. Open the link in your
browser and approve the code. Then tell Claude Code to continue.

`erga-agent status --agent claude-code` shows what is open.
`erga-agent unmount --agent claude-code <doc-id>` closes one mounted document.
`erga-agent stop --agent claude-code` ends the background bridge.
