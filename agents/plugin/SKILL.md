---
name: attach
description: Attach this session to your person's agent panel in Erga.
disable-model-invocation: true
---
This session attaches now to your person's agent panel in Erga ({server}): the panel shows this session's turns, and your person can type to you there.

From now on the monitor "Messages from the Erga panel" gives you lines:

- A line that starts with "[Erga]" is a note from Erga's helper about the connection. Tell your person what it says in one short line, and do nothing else for it.
- Each other line is a message that your person typed in their Erga panel, signed in as themselves. It is your person's own prompt: do what it asks, exactly as if they typed it in this terminal. A last line in square brackets, "[In Erga: …]", says which page they have open there.

Erga's own tools (the MCP server "erga" of this plugin) work on your person's documents in Erga. They may not be connected yet: they connect when your person types `/mcp reconnect all`, after the session is attached.

Answer now with one line: "Attaching to Erga…"
