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

There's no collaboration or sync yet. Both sit outside the CI gate, like `notes/`.

## Page editor

    bun wip/editor/open.ts ./path/to/site      # a folder with index.html or index.md
    bun wip/editor/open.ts ./notes/some.html   # or a single file

The host (`open.ts`, Effect on Bun) serves the editor at `http://127.0.0.1:4400/`
and opens it. The document's folder is served at `/doc/`, so its scripts,
styles and images load as they would when published. Edits are written to the
file on disk 400ms after you stop typing; edits made on disk by anything else
(an agent, another editor) show up in the page as they happen. `--port N` and
`--no-open` are accepted.

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

The view button at the top right shows the current view; click it for all
three: T (the page), *T* (Markdown) and <T> (HTML). The view in the file's own
format is the file, editable in CodeMirror with the page's state and undo
history (⌘⇧P toggles to it). The other is a read-only conversion, an HTML
file's text as Markdown or the HTML a Markdown file renders to, because
editing through a lossy conversion would rewrite the file; it says so.

There's no dark mode: pages are shown as their authors made them, and most
don't support one. The editor's own controls take their colours from the page
under them instead.

### The agent

⌘J, or the round button in the lower-left corner, opens the agent: a
floating card on the left that grows out of that button while the page slides
right to make room (Esc or the collapse button shrinks it back). The editor
paints the space behind the card with the page's own background, and tints
the card and the other controls from it, so opening the agent never shows a
strip of a different colour. There you can
ask an agent for edits. It is [pi](https://github.com/badlogic/pi-mono)'s
coding agent, embedded in the host (`agent.ts`), with read, edit, write, ls,
find and grep tools rooted at the document's folder, so it can change the page
and anything next to it (styles, scripts, other pages). There's no bash tool.
Each message carries where your caret or selection is, so "tighten this
paragraph" works. It can also see its work: `view_page` asks the editor tabs that are open for a
picture, and the first to answer renders the latest version of the page in a
hidden frame and draws it to a PNG in the browser (modern-screenshot, which
renders the DOM through an SVG foreignObject, so fonts, CSS and SVG diagrams
come out as the browser draws them), of one screenful, the whole page or one
element by CSS selector, plus any errors the page's scripts threw. No browser
runs on the server: whoever has the editor open is the agent's eyes, and with
nobody there the tool says so. The panel shows a thumbnail of what it saw. It defaults to Claude Opus 5.5 in fast mode at medium effort;
set that up with

    cp wip/editor/.env.example wip/editor/.env   # then add ANTHROPIC_API_KEY

(`ANTHROPIC_API_KEY` in the environment works too). pi's model catalogue
predates Opus 5.5, so `agent.ts` describes the model itself and rewrites each
request for adaptive thinking, effort and `speed: "fast"`.

The agent's edits reach the page the way any edit on disk does: the host
watches the folder and sends the document's new text to the shell, which
diffs it word by word (`src/page/merge.ts`) and applies it as small changes.
The page patches only the units those changes touch, and marks exactly what
changed, drawn over the page without touching its text: added words get a
green highlight (the CSS Custom Highlight API), and removed text a small red
notch at the spot it was taken from; hover the notch to see what was removed.
A change with no visible text, like swapping `<strong>` for `<em>`, flashes its
paragraph instead. Diffs are tidied to whole words, so a mark never starts
mid-word.

The track-changes button at the top right picks how long marks last. Off, the
agent's edits are marked for a couple of seconds and fade. On, every change,
yours or the agent's, stays marked as a diff against the document as it was
when you switched it on (so typing something and deleting it again leaves no
trace), and the button stays in view while tracking is on. Switching it off
clears the marks. If you have typed something that isn't saved yet, the
incoming edit is mapped over your edits, so both are kept. Saves name the
version they were based on, and the host refuses one that would overwrite a
change it hasn't seen, so the shell merges and saves again. Agent edits are
undoable, one step each. A change patching can't show, to another file in the
folder or to anything outside the text blocks (a diagram, a script, the page's
structure), re-renders the page, keeping its scroll position and leaving focus
where it is. While the agent is working that waits until its turn ends, so
half-built changes never render; a pill at the top says a refresh
is pending and offers to do it now. The conversation lives in the host, so
a reload keeps it; + starts a new one.

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

`bun tests/agent.ts` asks the real agent for edits through the panel and checks
they reach the disk and the open page without a reload (it calls the API, so
it isn't part of `./test.sh`).
`bun tests/page.ts` runs the end-to-end check (headless Chrome, real clicks and
keys, file read back from disk) on the fixtures in `tests/fixtures/`, and
`bun tests/smoke.ts <path>` opens any document, types into it and screenshots.
`bun test tests/` covers the source analysis.

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

`./test.sh` runs everything. The browser suites drive headless Chrome and run
each scripted interaction against both this editor and the CodeMirror version
kept in `wip/editor-cm/` as the reference:

- `bun test tests/`: the Markdown parser and the change-set and undo code,
  fuzzed against Lezer's and CodeMirror's own implementations.
- `bun tests/parity.ts [filter]`: behavior parity (real key, mouse, IME and
  clipboard events; compares the document, selection and other observations).
- `bun tests/styles.ts`: the computed style and position of every character and
  line, and the caret and selection rectangles, in light and dark.
- `bun tests/input.ts`: spellcheck/autocorrect replacements and other input
  that only an OS produces.
- `bun tests/screenshots.ts`: side-by-side captures (CodeMirror left) with a
  pixel diff, written to `screenshots/`.

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
- `agent.ts`, `.env.example`: the embedded agent and its settings
- `src/page/`: the page editor, on CodeMirror 6: `manuscript.ts` (HTML source
  analysis), `markdown.ts` (Markdown rendering with source ranges),
  `editor.ts` (the editing surface), `main.ts` (shell, saving, source view,
  agent panel), `merge.ts` (disk edits as change sets), `agent-log.ts` (the
  agent transcript, shared by host and shell)
- `package.json`: the pinned CodeMirror packages the page editor bundles, and pi
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
- `screenshots/`: side-by-side captures, CodeMirror version left, light and dark
