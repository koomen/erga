// The guide an external agent reads first (GET /api/ext on a document): the document's tools, and how to call them.

import { agentName } from "../document/content";
import { DOCUMENT_RULES, FILES_PROMPT, PAGES_PROMPT } from "./prompt";
import type { ToolSpec } from "./tools";

/**
 * The guide an external agent reads first (GET /api/ext): how to call the
 * tools, what they are, and the same working rules the embedded agent follows.
 */
export function externalGuide(o: { docName: string; owner: string; base: string; tools: ToolSpec[] }): string {
  const origin = /^https?:\/\/[^/]+/.exec(o.base)?.[0] ?? "";
  const tools = o.tools.map((t) => `### ${t.name}\n\n${t.description}\n\nArguments (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(t.parameters, null, 2)}\n\`\`\``).join("\n\n");
  return `# Editing "${o.docName}" in Erga

${o.owner} has given you access to edit the document "${o.docName}" in Erga's page
editor, as their agent, ${agentName(o.owner)}.

${FILES_PROMPT} The tools below work on it: ls, find, grep, read, edit, write,
new_page, mkdir, mv and rm on its files, and list_pages for its pages as users see
them.

${PAGES_PROMPT}

## Calling the tools

Every request carries the token you were given:

    Authorization: Bearer <token>

Run a tool by POSTing its arguments as JSON:

    curl -s -X POST ${o.base}/api/ext/tools/read \\
      -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \\
      -d '{"path": "index.html"}'

The answer is JSON: \`{"ok": true, "content": [...]}\`, where each content item is
\`{"type": "text", "text": "..."}\` or \`{"type": "image", "mimeType": "image/png", "data": "<base64>"}\`.
A failure is \`{"ok": false, "error": "..."}\` with HTTP status 400 (bad call; the
error says what to fix), 401 (bad token) or 404 (no such tool).
\`GET ${o.base}/api/ext/tools\` lists the tools as JSON.

## How to work

- Your edits go straight into the shared document and show up in everyone's page
  as you make them, attributed to ${o.owner}, via you (your token's label names you). ${o.owner} can undo them one tool
  call at a time. Prefer small, targeted edits (edit) over rewriting whole files.
- People may be typing while you work. edit matches oldText against the text as it
  is at that moment; if it fails because the text changed, read the file again and
  retry. Read a file right before editing it (with read, not grep: search output
  cuts long lines, so text copied from it won't match), and keep edits scoped to
  what was asked.
- view_page shows you the page ${o.owner} has open, rendered in their browser (so it
  needs their editor open), at their window size and in their light or dark mode
  unless you pass others: a screenshot plus any script errors and the fonts its
  text rendered in. Use it to check visual work before you say it's done.
  evaluate_page runs a JavaScript expression in that same render and answers with
  its result as JSON, for what a picture can't measure, e.g.
  getComputedStyle(document.querySelector("h1")).fontFamily. It changes nothing
  in the document.
- page_console, page_network, page_events, page_inspect, page_click and page_key
  reach the live page: the page as it runs now in ${o.owner}'s open editor tab.
  page_console gives its errors and warnings (repeats collapse into one line),
  page_network its requests (status, type, byte ranges, how each was served),
  page_events who consumed each click or key, page_inspect its media's state,
  user activation and autoplay policy, or a read-only expression's result.
  page_click and page_key click and press keys there, through the editor's
  handlers. Use page_inspect, page_click and page_key only when the
  person you work for asks you to look into or act on that page.
- open_page switches ${o.owner}'s open editor (every tab they have open on this
  document) to another page; new_page with open: true makes one and opens it. If
  they have no editor open, nothing opens: the answer says so and gives the page's
  address, which you can pass on. Use it when asked to go to a page, or to show
  them one you made.
- get_title and set_title read and change the document's title (shown in the
  document list and the browser tab) and its address, /<owner>/<slug>. Until
  someone sets them, the title follows the page's first heading and the slug
  follows the title. Use set_title when asked to rename the document or change
  its address; old addresses keep redirecting, and the API address above never
  changes.
- The document keeps versions (a snapshot of every file after each burst of
  edits, and after each run of your calls). list_versions and read_version show
  them; diff_versions shows what changed between two of them, or since your last
  run of calls (by default), as a unified diff for each file; restore_version
  brings one back (or one file of it) as a new version. Only restore when asked.
  Viewers always see the document as it is now.
- Follow the rules below whenever you create or change a page, so people can keep
  editing it by hand.

## Beyond this document

The same token works for all of Erga, as ${o.owner}: listing their documents,
making new ones (publishing a folder of files as a site), renaming, sharing and
deleting them, these same tools on any document they may edit, and, if they're
an admin of the server, its settings and users. The guide is at
\`GET ${origin}/api/ext\` (send the token), and there's an MCP server at
\`${origin}/mcp\`. Use them only when asked.

## Tools

${tools}

${DOCUMENT_RULES.replace(/^(#+) /gm, "#$1 ")}
`;
}
