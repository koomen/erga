# Writing Erga documents

Rules for an agent creating or editing an Erga document so that people
can keep editing it by hand in the page editor. A document is a folder of
files (or, opened from disk, a single file). Pages are its `.html` (or `.md`)
files: `index.html` is the home page, and every other page has its own
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

5. **Never let scripts rewrite manuscript text.** Text a script changes no
   longer matches the source, so its unit locks. Give a script its own
   target: an empty `div` or `span` (empty elements aren't units), an `svg`
   or `canvas`, or an element marked `data-erga-noedit`. Don't fill an empty
   `<p>` or heading from a script: those are units even while empty.

6. **Use relative URLs for the document's own files.** Write `style.css`,
   `images/chart.png`, `./data.json`, never `/style.css`. The editor serves
   the folder under its own path, and so may a published site. Link pages to
   each other the same way (`about.html`, `../index.html`, `blog/`): each page
   renders at its own file's path.

7. **Keep the page free of errors.** The editor announces script errors and
   files that fail to load (stylesheets, scripts, images) to whoever is
   editing. Check with `view_page` that a change leaves none behind.

8. **Give the page an explicit background colour** on `body` or `html`. The
   editor's floating controls take their colours from it, light or dark.

9. **Leave `data-erga*` alone.** Apart from `data-erga-noedit`,
   `data-erga-list` and `data-erga-item` (rule 12), the editor owns every
   `data-erga` attribute and `erga-` element and class; never write them into
   a document.

10. **Let the editor pause a page that reacts to input.** If the page's script
    answers clicks, keys or scrolling on the page itself (slides that advance
    on click, a game, a canvas that grabs the mouse), people editing its text
    end up fighting it. Define `window.ergaPause`: the editor's pause button
    calls it with `true` when someone pauses the page to edit it, and `false`
    when they resume. While paused, ignore that input and stop anything that
    changes the page on its own (timers, autoplay); animation may keep
    running. Outside the editor nothing calls it, so the page works as usual.

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
    except while someone types in the page's text. See "Presentations" below.

12. **Make a list of like things an item list.** When a page holds things of
    one kind that people will add to, delete, reorder or nest (cards, rows of
    a plan, a tree of views, a list of people), mark the element that holds
    them with `data-erga-list` and give the page one `<template>` for a new
    item. Erga then shows controls on each item while someone edits the page
    (add, delete, move up and down, move in and out) and makes each change in
    the source for them. Offer it whenever you make such a page, or when
    someone asks to edit one "as a tree", "as cards" or the like. See "Item
    lists" below.

## Presentations

A page is a presentation when `window.ergaSteps` is an object with these
members. Steps are numbered from 0.

| Member | Required | What it does |
|---|---|---|
| `count()` | yes | Answers how many steps there are. |
| `current()` | yes | Answers the step shown now. |
| `go(i)` | yes | Shows step `i`. |
| `label(i)` | no | Answers a short name for step `i` (its title, say). Without it, the list says "Step 3". |
| `next()`, `back()` | no | Step forward or back, for a page whose steps go further than `go` (a slide that builds up in parts). Without them, Erga calls `go` with the step after or before. |
| `image(i, {width, height})` | no | Answers a small picture of step `i`, about `width` × `height` pixels: a `canvas`, a `Blob`, or an image's address (a `data:` URL, or one of the document's files). It may answer a Promise of one. Without it, or when it answers nothing, the list shows the step's number and label. |

Whenever the step changes (by the page's own controls, a timer, anything) or
the steps themselves change, the page tells Erga:
`dispatchEvent(new Event("ergastep"))`. Erga also checks a few times a
second, so a missed event only makes it slower to follow.

Rules:

- Erga handles ← and → (without modifier keys): don't handle them yourself,
  or call `preventDefault()` on the ones you do handle, so a key moves one
  step and not two.
- Keep `count()`, `current()` and `label()` quick: Erga calls them often.
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
  show(0);
</script>
```

`e2e/fixtures/steps/index.html` is a fuller example.

## Item lists

An item list is markup only: no script takes part, so it can't break the
page. Every change it makes moves whole elements, from open tag to close tag.

```html
<ul class="branch" data-erga-list="view">
  <li>
    <div class="card"><h3>Front page</h3><p class="url">/</p></div>
  </li>
  <li>
    <div class="card"><h3>Documents</h3><p class="url">/docs</p></div>
    <ul class="branch" data-erga-list="view">
      <li>
        <div class="card"><h3>New document</h3><p class="url">/new</p></div>
      </li>
    </ul>
  </li>
</ul>

<template data-erga-item="view">
  <li>
    <div class="card"><h3>New view</h3><p class="url">/path</p></div>
  </li>
</template>
```

- `data-erga-list="<kind>"` goes on the element whose children are the
  items. Every element child is an item (a `template`, `script` or `style`
  child isn't). The kind names what the items are ("view", "person", "row"):
  the add button says "+ Add view".
- `<template data-erga-item="<kind>">` holds exactly one new item, written
  like the others, with short placeholder text. Put it anywhere in the page,
  once for each kind. A new item's first text is selected, so people type
  over the placeholder.
- A tree is lists of the same kind nested in items. "Move in" puts an item in
  the list of its kind inside the item above it; if there's none, Erga makes
  one, a copy of the open tag of the list the item is in. "Move out" puts the
  item after the item its list is in. A nested list that loses its last item
  goes. So style nested lists by their place (`.branch .branch`), not by a
  class only the first level has.
- Keep each item's text in units (rule 2): people edit it in place, as any
  text. An item that's only inline text (`<li>Ana</li>`) works too.
- Keep the markup well-formed (rule 1): a list with an unclosed tag gets no
  controls, and Erga says why. So does a list kind without a template.
- Style the items as you like; the controls float over the page, and each
  list gets one row below it for its add button while someone edits.



- CommonMark with GitHub's extensions (tables, task lists, strikethrough).
  Headings, paragraphs, list items, quotes, table cells and fenced code are
  all editable.
- A raw HTML block is rendered as it is and is never editable, so it is the
  way to fence off generated or fixed content in Markdown. (Inline HTML
  inside a paragraph stays editable, and `data-erga-noedit` has no effect
  there.)
- Prefer Markdown syntax to inline HTML for styling (`**bold**`, `*italic*`,
  `` `code` ``, `[text](url)`), since that is what the editor writes back
  when someone styles text by hand.
