# Erga plugin

Connects local `herdr-core` or `rex` terminals (single terminal or whole space) to Erga documents with live Yjs file sync, live browser terminal streaming, OSC 7501 status updates, and Erga MCP tools.

## Install

```sh
curl -fsSL https://erga.dev/plugin/install.sh | sh
```

Or build locally from the repo:

```sh
bun bridge/build.ts
claude --plugin-dir dist/plugins/claude-code
```

## Usage

- `erga-agent open <url>` — mount document and bind the current terminal.
- `erga-agent open --space <url>` — mount document and bind your entire Herdr space or Rex session.
- `erga-agent spaces` — list available spaces and live terminals.
- `erga-agent update` — check for and apply bridge updates from your pinned Erga origin.
- `erga-agent unmount <docId>` — close the Yjs mount and unbind the document.
