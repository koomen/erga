# Writing Erga documents

Rules for an agent creating or editing an Erga document so that people
can keep editing it by hand in the page editor. A document is a folder of
files (or, opened from disk, a single file). Pages are its `.html` files:
`index.html` is the home page, and every other page has its own
address (`blog/post.html` at `/<owner>/<slug>/blog/post`, `blog/index.html`
at `/<owner>/<slug>/blog`). Everything else (CSS, JS, images, fonts, data)
is shared assets, which any page may use. Users see pages; you see files.

## How the editor sees a page

The editor shows the page as it renders, and lets people type straight into
its text. It decides what is editable by parsing the source, not the
rendered page:

- A *unit* is an element whose content is text and inline elements only
  (`a`, `b`, `strong`, `em`, `i`, `code`, `span`, `mark`, `sub`, `sup`, `s`,
  `u`, `small`, `kbd`, `abbr`, `time`, `br`, ...). Units are what people type
  into: paragraphs, headings, list items, table cells, captions, blockquote
  paragraphs, `pre` blocks, and leaf `div`s.
- An element with block children (`div`, `section`, `article`, `ul`, ...) is
  a container: the editor walks into it and finds units inside.
- App logic is never editable: `script`, `style`, `template`, `svg`, `math`,
  `canvas`, `iframe`, `button`, form controls, media. Inside a unit, these
  stay working widgets.
- When the page loads, every unit's rendered text must match its source text
  exactly. A unit that doesn't match (a script changed it, or its markup is
  malformed) is locked, and clicking it explains why.

A page's text has edits of its own, the ones a person makes in the editor:
`document_api` lists them (type, replace, split, block kinds, styles, links,
lists, new blocks), and `call_edit` runs one. It checks the input against
the edit's JSON Schema first, and says what is wrong. Use them first for a change to
a page's text: they keep the HTML as a person's editing would. Edit the
source (`edit`, `write`) for what they can't do: layout, styles, scripts,
attributes, new elements of other kinds.

## Rules

1. **Write well-formed HTML.** Close every element you open, in order, and
   never leave a stray end tag. The browser silently repairs bad markup, the
   rendered text no longer lines up with the file, and the paragraph locks.
   Write explicit `</p>` and `</li>` even where HTML allows leaving them out.

2. **Keep prose in plain, semantic elements.** Use `h1`–`h6`, `p`, `ul`/`ol`/
   `li`, `blockquote`, `table`, `figure`/`figcaption`, `pre`/`code`, with
   inline `strong`, `em`, `code` and `a` for styling. Put text directly in a
   leaf element rather than mixing loose text and blocks in one container:
   `<div><p>One</p> loose text <p>Two</p></div>` leaves "loose text" uneditable.

3. **Style with CSS classes, not structure.** Add classes and stylesheets
   freely; they don't affect editing. Don't wrap words in extra block
   elements to position them, and don't put text in CSS (`content:` in
   `::before`/`::after`) that people would expect to edit.

4. **Mark what people shouldn't edit by hand with `data-erga-noedit`.** Put
   the attribute on any element whose text is generated, computed, or kept
   in step with something else (a total, a summary of data, a build stamp, a
   table a script fills in):

   ```html
   <p>Total: <span data-erga-noedit>42</span> items.</p>
   <section data-erga-noedit>
     <h2>Generated summary</h2>
     <p>Kept in step with data.json.</p>
   </section>
   ```

   The element and everything inside it are never editable on the page; the
   rest of the paragraph still is. Clicking it tells the person to ask the
   agent. The attribute has no effect on how the page looks or behaves.

   A `contenteditable` element of the page's own is text like any other: the
   editor saves what people type in it. For a scratch field the page keeps for
   itself (a note that is not saved, an input a script reads), add the mark:
   the page's own editing then works as written, and the editor never saves it.

   ```html
   <div contenteditable data-erga-noedit>Type a test sentence here.</div>
   ```

5. **Never let scripts rewrite manuscript text.** Text a script changes no
   longer matches the source, so its unit locks. Give a script its own
   target: an empty `div` or `span` (empty elements aren't units), an `svg`
   or `canvas`, or an element marked `data-erga-noedit`. Don't fill an empty
   `<p>` or heading from a script: those are units even while empty.

6. **Use relative URLs for the document's own files.** Write `style.css`,
   `images/chart.png`, `./data.json`, never `/style.css`. The editor serves
   the folder under its own path, and so may a published site. Link pages to
   each other the same way (`about.html`, `../index.html`, `blog/`): each page
   renders at its own file's path. Link other documents by their address
   (`/<owner>/<slug>`).

7. **Keep the page free of errors.** The editor announces script errors and
   files that fail to load (stylesheets, scripts, images) to whoever is
   editing. Check with `view_page` that a change leaves none behind.

8. **Give the page an explicit background colour** on `body` or `html`. The
   editor's floating controls take their colours from it, light or dark.

9. **Leave `data-erga*` alone.** Apart from `data-erga-noedit`, the editor owns
   every `data-erga` attribute and `erga-` element and class; never write them
   into a document.

10. **Let the editor pause a page that reacts to input.** If the page's script
    answers clicks, keys or scrolling on the page itself (slides that advance
    on click, a game, a canvas that grabs the mouse), people editing its text
    end up fighting it. Define `window.ergaPause`: the editor's pause button
    calls it with `true` when someone pauses the page to edit it, and `false`
    when they resume. While paused, ignore that input and stop anything that
    changes the page on its own (timers, autoplay); animation may keep
    running. Outside the editor nothing calls it, so the page works as usual.
    A page with `ergaPause` opens in the editor with the keys going to the
    page (a deck's arrows work at once); a click on text starts editing.

    ```js
    let paused = false;
    window.ergaPause = (p) => { paused = p; };
    addEventListener("click", () => { if (!paused) nextSlide(); });
    ```

    A page without it can't be paused, and the pause button says so. A page
    that doesn't react to input has nothing to pause and needs no
    `ergaPause`.

11. **Let a presentation tell Erga its steps.** A page that shows one step at
    a time (slides, a walkthrough, a story in parts) defines
    `window.ergaSteps`. Erga then shows back and forward buttons under the
    page, the step it is at ("3 / 12"), and a list of the steps that people
    can open beside it, viewing and editing alike. The ← and → keys step too,
    except while someone types in the page's text. A slide that builds up in
    parts has a step for each part ("3.2 / 12"). See "Presentations" below.

12. **Give a page its own edits.** A page can have its own API: the edits
    it offers beyond typing (add a card, delete a row, move a node of a
    tree), in a module of its own files. In the editor, the page's script
    draws buttons for them, and a click calls one with
    `window.ergaEditor.call`. Agents call the same edits with `call_edit`.
    Erga runs the module in a sandbox, makes its answer one change, one undo
    step, and refuses any that would break the page. Offer them when you
    make such a page, or when someone asks to make one editable. See "A
    page's own edits" below.

13. **Let a page with its own zoom take the editor's.** In the editor, the
    zoom keys (⌘+, ⌘−, ⌘0) zoom the whole page, 50% to 300%. A page that
    zooms itself (a canvas with a camera, a map) defines `window.ergaZoom`.
    Then the editor calls it instead, with the factor to zoom by (1.25 is a
    step closer, 0.8 a step back), or 0 to go back to the page's own first
    view, and leaves the page at 100%. Zoom around the middle of the window.
    If the page also takes ctrl and the wheel (a pinch) itself, call
    `preventDefault()` on it: the editor leaves that one to the page.

    ```js
    window.ergaZoom = (k) => { if (k > 0) zoomBy(k); else showStart(); };
    ```

14. **Keep a page's place in its address.** A page that shows one part at a
    time (a slide, a tab, a step) writes the part to its own `location.hash`
    and opens at the part the hash names. Erga keeps the hash in the tab's
    address, so a reload, the editor's own reload of the page, and a link
    all open at that part. It works the same outside Erga. Use
    `history.replaceState`, so each step adds no entry to the history.

    ```js
    function show(i) { /* show part i */ history.replaceState(null, "", "#" + (i + 1)); }
    show(location.hash.slice(1) - 1 || 0);
    ```

    A slide that builds up in parts names the part too: `#3.2` is the second
    part of slide 3, and `#3` its first.

## Decks (erga/slides)

For a slide deck, use Erga's slides library: the page imports it, and holds
one `<section class="slide">` for each slide, as children of `<body>`, with a
layout (`data-layout="title"`: a heading and a line, centred;
`data-layout="content"`: a heading and points).

```html
<script type="module" src="https://erga.dev/erga/slides/editor.js"></script>
<section class="slide" data-layout="title"><h1>Launch plan</h1><p>For the team</p></section>
<section class="slide" data-layout="content"><h2>Steps</h2><ul><li>Write the notes</li></ul></section>
```

The library shows one 16:9 slide at a time, scaled to the window, and gives
the page its steps (below): write no script for that. The page's own
`<style>` changes the look. In the editor, people type in the slides and
add, move or delete slides with the library's bar (⌘⇧Enter adds one).
`document_api` lists erga/slides' edits (`add_slide`, `delete_slide`,
`move_slide`, `set_layout`, and erga/text's for the text): use them.

## Presentations

A page is a presentation when `window.ergaSteps` is an object with these
members. A step is what people see at one moment: a slide, or one part of a
slide that builds up in parts. Steps are numbered from 0.

| Member | Required | What it does |
|---|---|---|
| `count()` | yes | Answers how many steps there are. |
| `current()` | yes | Answers the step shown now. |
| `go(i)` | yes | Shows step `i`. |
| `label(i)` | no | Answers a short name for step `i` (its title, say). Without it, the list says "Step 3". |
| `slide(i)` | no | Answers the slide that step `i` is on, numbered from 0, for a deck whose slides build up in parts: the steps of one slide answer the same number. Erga then numbers the steps by slide and part ("3.2" is the second part of slide 3), counts the slides ("3.2 / 12"), and draws a line between slides in the list. Without it, each step is a slide of its own ("5 / 12"). |
| `image(i, {width, height})` | no | Answers a small picture of step `i`, about `width` × `height` pixels: a `canvas`, a `Blob`, or an image's address (a `data:` URL, or one of the document's files). It may answer a Promise of one. Without it, or when it answers nothing, the list shows the step's number and label. |

Whenever the step changes (by the page's own controls, a timer, anything) or
the steps themselves change, the page tells Erga:
`dispatchEvent(new Event("ergastep"))`. Erga also checks a few times a
second, so a missed event only makes it slower to follow.

Rules:

- Erga handles ← and → (without modifier keys): don't handle them yourself,
  or call `preventDefault()` on the ones you do handle, so a key moves one
  step and not two.
- Erga steps with `go`: → and the forward button show the step after,
  ← and back the step before. Forward is off on the last step, back on the
  first.
- A slide that builds up in parts: give each part a step of its own, with
  its own picture, and say its slide with `slide(i)`. `go(i)` shows the
  slide with its parts up to step `i`, and `current()` answers the part
  shown. The hash names the part (`#3.2`, rule 14).
- Keep `count()`, `current()`, `label()` and `slide()` quick: Erga calls
  them often.
- Erga keeps the pictures `image()` draws until the document changes (an edit,
  a reload, other steps), so draw the step as it is, not from a cache of your
  own.
- `go(i)` must work while the page is paused (`ergaPause`, rule 10): people
  step through the page to edit each step. Pause stops your own input
  handlers and timers, not `go`.

A minimal presentation: each `section` is a step.

```html
<section><h1>One</h1></section>
<section><h1>Two</h1></section>
<section><h1>Three</h1></section>
<script>
  const steps = [...document.querySelectorAll("section")];
  let at = 0;
  function show(i) {
    at = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach((s, k) => (s.hidden = k != at));
    history.replaceState(null, "", "#" + (at + 1)); // the step, in the address (rule 14)
    dispatchEvent(new Event("ergastep"));
  }
  window.ergaSteps = {
    count: () => steps.length,
    current: () => at,
    go: show,
    label: (i) => steps[i].querySelector("h1").textContent,
    // Optional: a small picture of each step.
    image(i, { width, height }) {
      const c = document.createElement("canvas");
      c.width = width; c.height = height;
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, width, height);
      g.fillStyle = "#000"; g.font = `${height / 5}px sans-serif`;
      g.fillText(steps[i].querySelector("h1").textContent, width / 10, height / 2);
      return c;
    },
  };
  show(location.hash.slice(1) - 1 || 0);
</script>
```

To check a step, give `view_page` or `eval_in_page` the step (`step: "3.2"`),
and `frames: [300, 900]` to see a transition partway. They render a copy, so
the person's own view stays where it is.

`e2e/fixtures/steps/index.html` is a fuller example, and
`e2e/fixtures/builds/index.html` a deck whose slides build up in parts.

## A page's own edits

A page names its API module in its `<head>`:
`<meta name="erga-api" content="api.js">` (a path from the page). The
module's default export is the API:

```js
export default {
  name: "cards",
  description: "The page's cards.",
  edits: [
    { name: "add_card", description: "Adds a card at the end", input: { type: "object", properties: {} } },
    { name: "delete_card", description: "Deletes a card", input: { type: "object", properties: { n: { type: "integer", description: "1 is the first card" } }, required: ["n"] } },
  ],
  apply(html, edit, input) {
    if (edit == "add_card") return [{ op: "insert", into: ".cards", html: '<article class="card"><h3>New card</h3></article>' }];
    if (edit == "delete_card") return [{ op: "remove", el: `.cards > article:nth-child(${input.n})` }];
    return { refused: `no edit named ${edit}` };
  },
};
```

`apply` gets the page's HTML as written and the call's input, and answers a
list of operations, or `{ refused: why }`. Each operation names elements by
a CSS selector of the source as written (tags, `#id`, `.class`,
`[attr]`, `:nth-child()`, `>` and the other combinators), which must match
exactly one element:

| Operation | What it does |
|---|---|
| `{ op: "insert", html, after: sel }` | Puts new HTML after the element; or `before`, `into` (last in it), `prepend` (first in it). |
| `{ op: "remove", el: sel }` | Removes the element, with everything in it. |
| `{ op: "move", el: sel, after: sel }` | Moves the element; `before`, `into` and `prepend` too. |
| `{ op: "replace", el: sel, html }` | Puts new HTML in the place of the element. |
| `{ op: "attr", el: sel, name, value }` | Sets an attribute; `value: null` removes it. |

The module runs in a sandbox: no DOM, no network, nothing but its
arguments. It may not import other files. What Erga makes sure of, so the
page can't break itself:

- New HTML is well-formed (every tag closed), with no `<script>`, no `on…`
  attribute and no `data-erga` attribute. Erga indents it to match the code
  around it, so it can be written on one line.
- All the operations of one call refer to the source as it was before the
  call, and none may fall inside an element another removes or replaces.
- An id is unique in the page: new HTML from the page's buttons loses an id
  (or a link's `name`) that the page has already. Name elements by place or
  class, not by an id you copy.

In the editor, and only there, the page's `<html>` has the attribute
`data-erga-editing`, and `window.ergaEditor.editing` is `true`. Outside it,
the page shows as it always does, controls left out.
`ergaEditor.call(edit, input)` answers a Promise of `{ ok: true }` or
`{ ok: false, error }`. It works only right after the person clicks or
presses a key on the page: a page can't change itself as it loads, or on a
timer. When Erga refuses, it says why to the person and offers to ask the
agent to fix the page. Erga selects the new text, so people type over its
placeholder.

How to write the controls:

- Make every control a `<button>`. Erga never puts a caret in a button, and a
  click on one is the page's. Text in a `div` or `span` is text to edit.
- Draw the controls from the page's script, only when
  `document.documentElement.hasAttribute("data-erga-editing")` (and again
  on the window's `erga-editing` event), so the source holds only what
  readers see. Put them in elements of their own, never inside a paragraph
  or heading (rule 5).
- After an edit the page may render again, so draw the controls in a
  function you can run more than once, and run it on a `MutationObserver` as
  well as at the start. Handle clicks with one listener on `document`.

```html
<script>
  const draw = () => {
    if (!document.documentElement.hasAttribute("data-erga-editing")) return;
    document.querySelectorAll(".card:not(:has(> .ctl))").forEach((card) =>
      card.insertAdjacentHTML("beforeend", `<div class="ctl"><button class="del">Delete</button></div>`));
  };
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".ctl .del")?.closest(".card");
    if (card) ergaEditor.call("delete_card", { n: [...card.parentElement.children].indexOf(card) + 1 });
  });
  addEventListener("erga-editing", draw);
  draw();
  new MutationObserver(draw).observe(document.body, { childList: true, subtree: true });
</script>
```

`e2e/fixtures/page-api/` (`index.html` and `api.js`) is a fuller example.
