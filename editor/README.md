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
⌘B and ⌘I toggle bold and italic, ⌘Z undoes, ⌘⇧P shows the source in a
CodeMirror view (same document state, same undo history), ⌘-click opens a link.

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
  CodeMirror's own Markdown commands. Typed Markdown syntax is escaped so it
  stays literal; ⌘B writes the marks.

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
- `src/page/`: the page editor, on CodeMirror 6: `manuscript.ts` (HTML source
  analysis), `markdown.ts` (Markdown rendering with source ranges),
  `editor.ts` (the editing surface), `main.ts` (shell, saving, source view)
- `package.json`: the pinned CodeMirror packages the page editor bundles
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
