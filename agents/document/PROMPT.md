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
lists, new blocks), and `call_edit` runs one. Use them first for a change to
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

12. **Give a page custom edits.** A document can define its own custom
    edits: changes people make by more than typing (add a card, delete a
    row, move a node of a tree). In the editor, the page's script draws
    buttons for them, and a click sends the custom edit to the source through
    `window.ergaEditor.apply`. Erga makes it as one change, one undo step,
    and refuses any that would break the page. Offer custom edits when you
    make such a page, or when someone asks to make one editable. See "Custom
    edits" below.

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

## Custom edits

A document can define its own custom edits: the changes its page offers
beyond typing, each with its own control on the page, and each made to the
source by Erga. In the editor, and only there, a page has `window.ergaEditor` (before its
first script runs) and its `<html>` element has the attribute
`data-erga-editing`. Outside the editor neither exists, so the page shows as
it always does, controls and all left out.

| Member | What it does |
|---|---|
| `editing` | `true`. |
| `apply(edits)` | Makes a list of custom edits to the page's source, all of them or none. Answers a Promise of `{ ok: true }` or `{ ok: false, error }`, the error saying why. |

Each custom edit names elements of the page as the script sees them:

| Edit | What it does |
|---|---|
| `{ op: "insert", html, after: el }` | Puts new HTML after `el`; or `before: el`, `into: el` (last in it), `prepend: el` (first in it). |
| `{ op: "remove", el }` | Removes `el`, with everything in it. |
| `{ op: "move", el, after: other }` | Moves `el`; `before`, `into` and `prepend` too. |
| `{ op: "replace", el, html }` | Puts new HTML in the place of `el`. |
| `{ op: "attr", el, name, value }` | Sets an attribute of `el`; `value: null` removes it. |

What Erga makes sure of, so the page can't break itself:

- Every element named is in the source. One the script made isn't, and the
  custom edit is refused.
- New HTML is well-formed (every tag closed), with no `<script>`, no `on…`
  attribute and no `data-erga` attribute. Erga indents it to match the code
  around it, so it can be written on one line.
- All the custom edits in one call refer to the source as it was before the call,
  and none may fall inside an element another removes or replaces.
- Custom edits come only right after the person clicks or presses a key on the
  page: a page can't change itself as it loads, or on a timer.
- When Erga refuses, it says why to the person and offers to ask the agent
  to fix the page.

How to write the controls for custom edits:

- Make every control a `<button>`. Erga never puts a caret in a button, and a
  click on one is the page's. Style it (`cursor: pointer`) so it looks like
  one. Text in a `div` or `span` is text to edit, not a control.
- Draw the controls from the page's script, only when `window.ergaEditor`
  exists, so the source holds only what readers see. Put them in elements of
  their own (a `div` of buttons in a card, an `li` for an add button at the
  end of a list), never inside a paragraph or heading (rule 5).
- After a custom edit the page may render again, so draw the controls in a
  function you can run more than once, and run it on a `MutationObserver` as
  well as at the start. Handle clicks with one listener on `document`.
- Keep a new item's markup in a `<template>` and insert its `innerHTML`.
  Erga selects the new text, so people type over its placeholder.
- An id is unique in the page: if new HTML has an id (or a link's `name`)
  that the page has already, Erga leaves it out of the new element. A moved
  element keeps its id. Find elements by class, not by an id you copy.

A tree of views with custom edits:

```html
<ul class="tree">
  <li><div class="card"><h3>Front page</h3><p class="url">/</p></div></li>
  <li><div class="card"><h3>Settings</h3><p class="url">/settings</p></div></li>
</ul>
<template id="new-card">
  <li><div class="card"><h3>New view</h3><p class="url">/path</p></div></li>
</template>
<script>
  const editor = window.ergaEditor;
  if (editor) {
    const fresh = () => document.getElementById("new-card").innerHTML;
    const items = (ul) => [...ul.children].filter((li) => !li.classList.contains("add"));
    function draw() {
      for (const card of document.querySelectorAll(".card:not(:has(> .ctl))"))
        card.insertAdjacentHTML("beforeend", `<div class="ctl"><button class="up">↑</button><button class="del">Delete</button></div>`);
      for (const ul of document.querySelectorAll("ul.tree:not(:has(> li.add))"))
        ul.insertAdjacentHTML("beforeend", `<li class="add"><button class="new">+ New view</button></li>`);
    }
    document.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const li = b.closest("li"), list = items(li.parentElement), i = list.indexOf(li);
      if (b.matches(".new")) editor.apply([list.length ? { op: "insert", after: list.at(-1), html: fresh() } : { op: "insert", into: li.parentElement, html: fresh() }]);
      if (b.matches(".del")) editor.apply([{ op: "remove", el: li }]);
      if (b.matches(".up") && i > 0) editor.apply([{ op: "move", el: li, before: list[i - 1] }]);
    });
    draw();
    new MutationObserver(draw).observe(document.body, { childList: true, subtree: true });
  }
</script>
```

`e2e/fixtures/custom-edits/index.html` is a fuller example.
