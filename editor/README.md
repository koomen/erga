# Editor concept

An early look-and-feel concept for the human-facing editor in Scratchwork 2.0: a
full-page Markdown writing surface that stays out of the way. There's no
collaboration, sync or backend here. It sits outside the CI gate, like `notes/`.

## Run it

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

- `index.html`: page shell, the chrome, and a script that sets the theme before first paint
- `style.css`: theme colours, typography, editor and Markdown styling, chrome behaviour
- `src/`: the editor. `app.ts` is the page (formatting commands, autosave,
  chrome, preview); `state.ts`, `changes.ts`, `selection.ts`, `history.ts` and
  `text.ts` the model; `commands.ts` the keyboard commands; `view/` rendering,
  input and geometry; `markdown/` the parser, styling and list/quote commands
- `editor.js`: the built editor (`./build.sh`)
- `vendor/`: `entry.js`, `build.sh` and the built `vendor.js` (marked, DOMPurify)
- `tests/`: parity and unit tests (see above)
- `screenshots/`: side-by-side captures, CodeMirror version left, light and dark
