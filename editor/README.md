# Editor concept

Two prototypes for the human-facing editor in Scratchwork 2.0:

- **The page editor** (`open.ts`, `page.html`, `src/page/`): opens any HTML or
  Markdown page from disk and lets you edit its text in place, on the rendered
  page, with the page's own styles and scripts running around it. Its document
  model, undo history, Markdown parser and source view are CodeMirror 6
  (pinned in `package.json`; `bun install` here before building). See [Page
  editor](#page-editor) below.
- **The Markdown editor** (`index.html`, `src/`): a full-page Markdown writing
  surface that stays out of the way, written from scratch after CodeMirror's
  design. It is kept as is; the page editor no longer depends on it.

The page editor is multiplayer: people and their agents edit one page
together (see [Together](#together)). Both sit outside the CI gate, like `notes/`.

## Page editor

    bun wip/editor/open.ts ./path/to/site      # a folder with index.html or index.md
    bun wip/editor/open.ts ./notes/some.html   # or a single file

The host (`open.ts`, Effect on Bun) serves the editor at `http://127.0.0.1:4400/`
and opens it. The document's folder is served at `/doc/`, so its scripts,
styles and images load as they would when published. Edits are written to the
file on disk 400ms after the last one; edits made on disk by anything else
(another editor, git) show up in the page as they happen. `--port N` and
`--no-open` are accepted. Open `http://127.0.0.1:4400/?user=Ada` in another
window to be a second person.

Click into any text and type. Enter makes a new paragraph or list item, Shift-Enter
a line break, Backspace at the start of a paragraph joins it to the one above,
⌘Z undoes, ⌘-click opens a link.

Selecting text brings up a small style bar (bold, italic, code, link); ⌘B, ⌘I,
⌘E and ⌘K do the same. A selection may cross inline elements and paragraphs:
each stretch of text gets the style, so the HTML stays well-formed, and taking
a style off part of an element splits it. Markdown works as you type:
closing `**bold**`, `*italic*`, `_italic_` or `` `code` `` turns the text into
that style and the marks disappear (real marks in a Markdown file, tags in an
HTML one); ⌘Z brings the literal characters back. At the start of a paragraph,
`# ` to `###### ` makes a heading (or changes a heading's level), `- ` or `* `
a bullet list, `1. ` a numbered list and `> ` a quote; Enter in an empty last
list item leaves the list. Whatever can't be styled
(a code block, text the page's script made) says why rather than doing nothing.

A document can fence off parts that shouldn't be edited by hand (generated
totals, a summary kept in step with data) with the `data-sw-noedit`
attribute: that element and everything in it stay out of the editor, and
clicking them says to ask the agent. [DOCUMENT_PROMPT.md](DOCUMENT_PROMPT.md)
collects the rules an agent follows to write documents that edit well.

The view button at the top right shows the current view; click it for all
three: T (the page), *T* (Markdown) and <T> (HTML). The view in the file's own
format is the file, editable in CodeMirror with the page's state and undo
history (⌘⇧P toggles to it). The other is a read-only conversion, an HTML
file's text as Markdown or the HTML a Markdown file renders to, because
editing through a lossy conversion would rewrite the file; it says so.

There's no dark mode: pages are shown as their authors made them, and most
don't support one. The editor's own controls take their colours from the page
under them instead.

### When the page is broken

Whenever the document is broken in a way you'd see, the editor says what's
wrong in a note at the bottom, in words worked out from the document itself
(the stray `</h2>`, the file that didn't load, the script error and its
line), with a **Fix with agent** button. The button opens the agent and
sends it a prompt naming the problem, where it is, and what to keep; it never
sends you to the HTML to fix it yourself. Today that covers: text that can't
be edited because its markup is malformed (clicking it explains), script
errors the page throws, and stylesheets, scripts or images that fail to load
(those are announced as they happen, one at a time). Notes like these stay
up at least five seconds, then until you next click or type. With the agent
off, the button is still there, disabled, and says why.

### Together

The host turns the folder into a *document room* (`room.ts`): one shared
[Yjs](https://yjs.dev) doc holding every text file in the folder (pages,
stylesheets, scripts) as a `Y.Text`, and every other file (images) as a
content hash. Each editor tab joins it over a WebSocket (`/api/room`, the
standard y-websocket protocol) and each person's agent joins it in process as
another peer (`joinLocal`), so the room can't tell a tab from an agent. While
the host runs, the room is the source of truth: it writes each changed file
back 400ms after its last edit, and merges edits that arrive as files (the
word diff and rebase in `src/page/merge.ts`, from the last version both sides
agreed on) as ordinary edits, attributed "on disk". `/doc/` serves text files
from the room, so a page always loads the latest shared version, even before
it's on disk. The room is platform-neutral (storage is a four-method
`FileStore`, connections are `send` callbacks) so it can move into a Durable
Object as is.

A person, locally, is a name: `?user=Ada` names a tab (remembered for that
tab), otherwise it's the name you chose last (click your avatar), or the first
name in your git config. Tabs with the same name are the same person.

- **Live edits.** Your keystrokes become Yjs transactions on the file's
  `Y.Text`; everyone else's come back as Y.Text events, are turned into
  CodeMirror changes and patched into the page in place, the same path agent
  edits took before (`PageEditor.applyExternal`). The source view is bound the
  same way. Offline, edits stay in the tab and merge when the host is back.
- **Carets.** Every person's caret and selection is drawn on the page (and in
  the source view) in their colour with their name, from Yjs relative
  positions on awareness, so it stays put while text around it changes.
  Agents publish a caret where they last edited, but it isn't drawn (one
  lingering on the page distracts); their avatar says what they're doing,
  and clicking it scrolls there.
- **Who's here.** Avatars at the top right: you (ringed), then the others.
  A person's agent, once it has done something, is a small ✦ badge on the
  lower right of their avatar, spinning while it works (an agent still
  working after its person left keeps their avatar, faded). Click someone, or
  their badge, to scroll to their caret or the agent's last edit.
- **Attribution.** Marks are drawn in their author's colour, and a removed
  text's notch says who removed it. With track changes on, the diff covers
  every author, each in their colour. Authorship comes from the Yjs client
  ids an edit carries (`src/room/doc.ts`: every participant writes who it is
  into the doc when it joins, and stamps edits that only delete).
- **Undo is yours.** ⌘Z undoes your own edits and never a collaborator's or an
  agent's (CodeMirror's history, mapped over everyone else's changes). The
  agent panel has its own button to undo your agent's last change.

The room keeps its Yjs state as well as the files (a cache file per
folder, saved with every write), so a restarted host picks up the same
history and open tabs reconnect and merge as if nothing happened. If that
state is lost, the room starts a new *epoch* from the files and refuses tabs
holding the old one (their history would merge with the new one and double
the document); such a tab says it's out of date and offers a reload.

`tests/suite/` tests all of this from the outside, the way a deployment
will be tested (see its README): `bun tests/suite/run.ts`.

`bun tests/multi-shot.ts` takes a picture (and prints where: a temp folder): Bo's
view of the page, tracking changes, with Ada's edit and caret in orange and
his own edit in teal.

### The agent

⌘J, or the round button in the lower-left corner, opens the agent: a
floating card on the left that grows out of that button while the page slides
right to make room (Esc or the collapse button shrinks it back). The editor
paints the space behind the card with the page's own background, and tints
the card and the other controls from it, so opening the agent never shows a
strip of a different colour. There you can
ask your agent for edits. Each person gets their own agent session in the host
(`agent.ts`), built on [pi](https://github.com/badlogic/pi-mono)'s agent core
(`@mariozechner/pi-agent-core` and `pi-ai`): its conversation is private to
that person and that document (all their tabs show it live; nobody else ever
sees it), it keeps running when the tab closes, and it edits through its own
replica of the shared doc, as a participant in the room called "Ada's agent".
Its tools (read, edit, write, ls, find, grep, view_page) are written against
a small workspace interface (`workspace.ts`), not the disk, so it can change
the page and anything next to it (styles, scripts, other pages) and could run
anywhere the interface does. There's no bash tool. `edit` finds its `oldText`
in the text *as it is right now*; if someone has changed that text since the
agent read it, the edit fails cleanly and the agent reads again. `write`
merges the agent's version with what others did since its read. Each tool
call is one transaction of minimal changes, so edits elsewhere survive and
one undo step takes the call back.
Each message carries where your caret or selection is, so "tighten this
paragraph" works. It can also see its work: `view_page` asks the editor tabs that are open for a
picture, and the first to answer renders the latest version of the page in a
hidden frame and draws it to a PNG in the browser (modern-screenshot, which
renders the DOM through an SVG foreignObject, so fonts, CSS and SVG diagrams
come out as the browser draws them), of one screenful, the whole page or one
element by CSS selector, plus any errors the page's scripts threw. It asks the
agent's own person's tabs, and the tab waits until it has every edit the agent
had made when it asked (a Yjs state vector). No browser runs on the server:
whoever has the editor open is the agent's eyes, and with none of their tabs
open the tool says so. The panel shows a thumbnail of what it saw. It defaults to Claude Opus 5.5 in fast mode at medium effort;
set that up with

    cp wip/editor/.env.example wip/editor/.env   # then add ANTHROPIC_API_KEY

(`ANTHROPIC_API_KEY` in the environment works too). pi's model catalogue
predates Opus 5.5, so `agent.ts` describes the model itself and rewrites each
request for adaptive thinking, effort and `speed: "fast"`.

The agent's edits reach the page the way anyone's do: as changes from the
room. The page patches only the units those changes touch, and marks exactly
what changed, drawn over the page without touching its text: added words get
a highlight in their author's colour (the CSS Custom Highlight API), and
removed text a small notch at the spot it was taken from; hover the notch to
see what was removed and by whom.
A change with no visible text, like swapping `<strong>` for `<em>`, flashes its
paragraph instead. Diffs are tidied to whole words, so a mark never starts
mid-word.

The track-changes button at the top right picks how long marks last. Off,
other people's and agents' edits are marked for a couple of seconds and fade.
On, every change, yours or anyone's, stays marked as a diff against the
document as it was when you switched it on (so typing something and deleting
it again leaves no trace), and the button stays in view while tracking is on.
Switching it off clears the marks. A change patching can't show, to another
file in the folder or to anything outside the text blocks (a diagram, a
script, the page's structure), re-renders the page, keeping its scroll
position and leaving focus where it is. While any agent in the room is
working that waits until its turn ends (its busy flag rides on awareness), so
half-built changes never render; a pill at the top says whose agent it's
waiting for and offers to refresh now. The conversation lives in the host, so
a reload keeps it; + starts a new one, and the undo arrow takes back the
agent's last change.

### How it works

The design is the one in `notes/scratchwork-2.0-editing.html`:

- **Manuscript vs app logic.** A deterministic parse of the source
  (`src/page/manuscript.ts` for HTML, `src/page/markdown.ts` for Markdown)
  finds the *units*: leaf blocks whose content is text and inline elements
  (headings, paragraphs, list items, cells, `pre`, divs of text...). Everything
  else, from scripts and SVG to buttons and widgets, is app logic: rendered
  non-editable so its JavaScript keeps working, and never touched.
- **Every text node maps to a source range.** Each unit records its DOM text
  nodes in order with their source offsets, including a map through character
  references (`&amp;`), CR LF and Markdown marks, so a caret on the page is a
  source offset and typing is the smallest character change to the file. Tags
  and attributes stay byte for byte. Ids (`data-sw-id`) exist only in the
  browser.
- **Two regimes.** The page renders in an iframe. Each unit is its own
  contenteditable host: click into one and it is an editor (caret, selection,
  typing), and the arrow keys carry the caret into the neighbouring unit so the
  page still reads as one document. Everything else is an ordinary web page:
  buttons, links and widgets work as they would anywhere, and clicking them
  places no caret. Every input event in a unit is cancelled and turned into a
  transaction on the source; the DOM is then patched: text nodes in place, a
  unit's inner HTML when its inline markup changed, sibling elements for a split
  or join, the whole page only as a last resort. IME composition is read back
  when it ends.
- **Verified, never guessed.** Before an edit, a unit's DOM text is compared
  with the source. An element the page's JS created or changed is simply not
  editable.
- **Markdown renders through CodeMirror's Lezer parser**, which gives every node
  a source position, so `**bold**` becomes `<strong>` whose text still maps to
  the characters between the marks. Enter and Backspace in lists and quotes use
  CodeMirror's own Markdown commands. A lone typed `*` or `_` is escaped so it
  stays literal, until it closes a Markdown shortcut.

### Tests

Fast on purpose, because iteration speed matters: test files run at the same
time, tests inside them run side by side (each with its own host, document
and tab), nothing waits a fixed time when it can wait for the thing itself,
and the editor's timers (how long notes stay up, how marks fade) run at a
fraction of real time under test (`window.__swTimescale`, `ms` in
`src/page/editor.ts`).

    ./test.sh          # page editor + multiplayer: ~14s
    ./test.sh md       # the Markdown editor (parity, styles, input): ~25s
    ./test.sh all      # both
    ./test.sh shots    # side-by-side pictures, written to a temp folder (not a test)

Each file also runs alone: `bun tests/page.ts` (~7s), `bun tests/suite/run.ts`
(~11s; `--suite`, `--grep` and `--seed` narrow it, `--long` for the big slow
version), `bun test tests/` (under a second).

`bun tests/agent.ts` asks the real agent for edits through the panel and checks
they reach the open page without a reload and then the disk, that the agent
shows up as a participant, and that its last change can be undone (it calls
the API, so it isn't part of `./test.sh`).
`bun tests/page.ts` runs the end-to-end check (headless Chrome, real clicks and
keys, file read back from disk) on the fixtures in `tests/fixtures/`, and
`bun tests/smoke.ts <path>` opens any document, types into it and screenshots.
`bun tests/suite/run.ts` is the multiplayer suite (tests/suite/README.md):
sync, presence, the agent (scripted, so free and repeatable), durability
across restarts and crashes, hostile clients, seeded fuzzing, latency, and
two people in real tabs; it runs unchanged against a deployment. `bun test tests/` covers the source analysis
and, in `tests/room.test.ts`, the room without a browser: convergence, write
back, merging edits from disk, the agent's exact-match edits and attribution.

## Markdown editor

Open `index.html` in a browser (a `file://` URL works). Or serve the folder:

    bunx serve wip/editor
    scratchwork dev wip/editor

Everything loads from this folder, with no network requests. The Inter web font
is self-hosted in `fonts/` (the variable woff2 files from Google Fonts, split by
script; the browser downloads only the scripts a page uses).

The editor is TypeScript in `src/`, bundled into `editor.js` (a classic script)
by `./build.sh`. The built file is kept in the folder so the page opens without
a build. `vendor/vendor.js` bundles marked and DOMPurify for the preview pane
only; `./vendor/build.sh` (or `./build.sh --vendor`) rebuilds it from pinned
versions in a temp dir, so nothing lands in the repo.

`./test.sh md` runs its tests (in parallel, across a few headless Chromes, each
with its own storage). The browser suites run each scripted interaction
against both this editor and the CodeMirror version kept in `wip/editor-cm/`
as the reference:

- `bun test tests/`: the Markdown parser and the change-set and undo code,
  fuzzed against Lezer's and CodeMirror's own implementations.
- `bun tests/parity.ts [filter]`: behavior parity (real key, mouse, IME and
  clipboard events; compares the document, selection and other observations).
- `bun tests/styles.ts`: the computed style and position of every character and
  line, and the caret and selection rectangles, in light and dark.
- `bun tests/input.ts`: spellcheck/autocorrect replacements and other input
  that only an OS produces.
- `bun tests/screenshots.ts` (`./test.sh shots`): side-by-side captures
  (CodeMirror left) with a pixel diff, written to a temp folder it prints; pictures to
  look at, not a pass/fail test, so not part of the default run.

## Design choices

- **A from-scratch editor, with the Markdown styled as you type.** It follows
  CodeMirror 6's design so it behaves exactly like the CodeMirror version this
  replaced: an immutable state (document, selection, undo history) changed by
  transactions made of change sets, which are also the format for undo and
  future collaboration (`src/state.ts`, `src/changes.ts`, `src/history.ts`).
  The view (`src/view/`) renders one `<div>` per line into a contenteditable
  element, cancels `beforeinput` events and applies them to the model, and
  lets the browser own the DOM only during IME composition, reading the text
  back afterwards. Cursor motion, deletion, list continuation and the other
  commands are ported from CodeMirror's, and the Markdown parser
  (`src/markdown/`) produces the same trees as Lezer's, so styling and the
  Enter/Backspace rules match. Headings grow, `**bold**` is bold, and the
  syntax characters stay but fade.
- **Typography.** Inter at 18px (16.5px on phones), line height 1.7, and a
  ~68-character column centred on the page. Bold and headings use weight 650.
  The Markdown marks are a light grey in both themes. Wrapped list items hang
  under their text, not under the bullet.
- **Caret and focus.** The editor is focused on load. The caret is a 2px blue
  bar that fades in and out instead of blinking hard, and it stays solid while
  you type. The caret and selection are drawn from the model (the browser's
  own are kept but hidden), which is what allows the 2px caret and soft blink,
  and keeps the selection visible while the link field has focus. The
  selection is a soft blue tint. The line you're writing never gets closer
  than 30% of the screen height to the bottom edge, and there's plenty of room
  below the last line. Clicking anywhere on the page puts you in
  the document.
- **Chrome that disappears.** There are three icon buttons at the top right
  (preview, theme, shortcuts) and a word count at the bottom right. They're
  visible on load. They fade out slowly (700ms) once you start typing, and come
  back quickly (200ms) after about 8px of deliberate mouse movement. Esc hides
  them straight away. On touch screens they stay visible but dimmed. Clicking
  the word count switches between words, characters and reading time. With a
  selection it shows "12 / 340 words".
- **Themes.** Light and dark follow the system setting until you toggle them.
  The choice is applied before first paint, so a reload never flashes the
  wrong theme. All colours are CSS variables in `style.css`.
- **Autosave.** Changes save to `localStorage` 400ms after you stop typing,
  and also when the tab is hidden or closed. The cursor and scroll position
  are saved too. There is no save button. ⌘S just confirms that the document
  is saved. If saving fails, a red notice appears and stays visible. Other tabs
  pick up edits (last write wins). The tab title follows the first line of the
  document.
- **Preview.** ⌘⇧P renders the document with marked and sanitizes it with
  DOMPurify. The preview uses the same column and type as the editor.
- **Format bar.** Selecting text brings up a small bar with bold, italic and
  link. It waits for a mouse drag to finish. The link button (or ⌘K with a
  selection) swaps the buttons for a URL field: Enter applies, Esc cancels, and
  an empty URL removes an existing link.
- **Links look like links.** `[label](url)` shows only the underlined label
  until the caret or selection goes inside it, then the Markdown comes back
  for editing. A caret at either edge keeps it folded, so the link you just
  made stays rendered. ⌘-click opens it.

Shortcuts: ⌘B bold, ⌘I italic (on bold text it makes bold italic), ⌘E inline code, ⌘K link, ⌘⌥1–3 heading
(⌘⌥0 removes it), ⌘⇧P preview, ⌘⇧L theme, ⌘/ list of shortcuts, Esc hide
controls or leave preview. Pasting a URL over selected text makes a link. On
Windows and Linux, use Ctrl in place of ⌘.

## Files

- `open.ts`, `page.html`, `page.js`: the page editor's host, shell and built script
- `room.ts`: the document room (shared Yjs doc, sync, write-back, disk merges)
- `agent.ts`, `workspace.ts`, `.env.example`: the per-person agent session, its
  tools over the shared doc, and its settings
- `src/room/doc.ts`: the shared doc's shape and helpers, used by host and shell
- `src/page/`: the page editor, on CodeMirror 6: `manuscript.ts` (HTML source
  analysis), `markdown.ts` (Markdown rendering with source ranges),
  `editor.ts` (the editing surface, marks and other people's carets),
  `main.ts` (shell, presence, source view, agent panel), `collab.ts` (the
  room connection and its binding to the editor), `merge.ts` (word diffs and
  rebasing as change sets), `agent-log.ts` (the agent transcript, shared by
  host and shell)
- `package.json`: the pinned CodeMirror and Yjs packages the page editor bundles, and pi
- `index.html`: page shell, the chrome, and a script that sets the theme before first paint
- `style.css`: theme colours, typography, editor and Markdown styling, chrome behaviour
- `src/`: the editor. `app.ts` is the page (formatting commands, autosave,
  chrome, preview); `state.ts`, `changes.ts`, `selection.ts`, `history.ts` and
  `text.ts` the model; `commands.ts` the keyboard commands; `view/` rendering,
  input and geometry; `markdown/` the parser, styling and list/quote commands
- `editor.js`: the built editor (`./build.sh`)
- `vendor/`: `entry.js`, `build.sh` and the built `vendor.js` (marked, DOMPurify)
- `tests/`: parity and unit tests (see above); `page.ts`, `smoke.ts` and
  `fixtures/` for the page editor
