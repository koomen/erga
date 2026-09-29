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

`vendor/vendor.js` is a pre-built bundle of CodeMirror 6, marked and DOMPurify.
To rebuild it (for example, to bump versions), run `./vendor/build.sh`. It
installs the pinned packages into a temp dir, so nothing lands in the repo.

## Design choices

- **CodeMirror 6, with the Markdown styled as you type.** A plain textarea can't
  make headings bigger. A hand-rolled contenteditable is where caret, undo, IME
  and paste bugs live. CodeMirror gets all of those right, and its Markdown
  parser lets us style the text while keeping it plain Markdown. Headings grow,
  `**bold**` is bold, and the syntax characters stay but fade. It also brings
  list and quote continuation on Enter. It's bundled as a classic script so the
  page opens straight from disk. A CDN import map of about 20 CodeMirror
  packages would risk loading two copies of the same package.
- **Typography.** Inter at 18px (16.5px on phones), line height 1.7, and a
  ~68-character column centred on the page. Bold and headings use weight 650.
  The Markdown marks are a light grey in both themes. Wrapped list items hang
  under their text, not under the bullet.
- **Caret and focus.** The editor is focused on load. The caret is a 2px blue
  bar that fades in and out instead of blinking hard, and it stays solid while
  you type. The selection is a soft blue tint. The line you're writing never
  gets closer than 30% of the screen height to the bottom edge, and there's
  plenty of room below the last line. Clicking anywhere on the page puts you in
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
- `style.css`: theme colours, typography, Markdown styling, chrome behaviour
- `editor.js`: CodeMirror setup, Markdown line styling, commands, autosave, chrome, preview
- `vendor/`: `entry.js`, `build.sh` and the built `vendor.js`
- `screenshots/`: headless Chrome captures, light and dark
