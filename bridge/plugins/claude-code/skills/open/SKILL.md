---
name: open
description: >-
  Open, create and edit Erga documents with live sync to the user's browser.
  Use when the user gives an Erga document URL or address (/owner/slug), or
  asks for a new Erga document.
argument-hint: "[document URL or /owner/slug]"
---

# Open or create an Erga document

The document: $ARGUMENTS

1. Call the `erga_open` tool of this plugin's `erga` MCP server:
   - An existing document: `erga_open({ document: "<URL or /owner/slug>" })`
   - A new document: `erga_open({ create: true, title: "<title>" })`. Pass `fromDir` to copy the files of a local folder into it.
   - When the answer has `needsAuth: true`, show the user its `verificationUriComplete` link and its `userCode`. The user approves in their own browser. Then call `erga_open` again. Never approve for the user.
2. The answer's `dir` (under `~/.erga/docs/`) is a live copy of the document. Read and edit its files there with your own file tools: each change shows in the user's browser at once. A file that is not text (an image, a PDF) uploads when you write it there. When `fromDir` copied files, tell the user that the copy is in `dir` and that their own folder is as it was.
3. Look at the page with the `page` tool of the same server (`view_page`, `page_log`). Use its other tools (`documents`, `read`, `edit`) for comments, versions, shares and documents that are not open here.
4. Tell the user what the connection does. While the document is open, its agent panel in the browser shows this session's turns: each prompt, each tool call and each final reply. A prompt that the user types in the panel runs in a second Claude Code session, in the background, in this folder: this session does not see it. `erga_unmount` ends both.
5. Keep the HTML well-formed: close every element, keep text in plain leaf elements (`p`, `h1`-`h6`, `li`, `td`), and leave `data-erga` attributes alone. People edit the same page by hand.
