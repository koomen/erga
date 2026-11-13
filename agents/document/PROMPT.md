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
`read` with op `document_api` lists them (type, replace, split, block kinds, styles, links,
lists, new blocks), and `edit` with op `call_edit` runs one. It checks the input against
the edit's JSON Schema first, and says what is wrong. Use them first for a change to
a page's text: they keep the HTML as a person's editing would. Edit the
source (`edit`, and `edit` op `write`) for what they can't do: layout, styles, scripts,
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
   editing. Check with `page` (op `view_page`) that a change leaves none behind.

8. **Give the page an explicit background colour** on `body` or `html`. The
   editor's floating controls take their colours from it, light or dark.

9. **Leave `data-erga*` alone.** Apart from `data-erga-noedit`, the editor owns
   every `data-erga` attribute and `erga-` element and class; never write them
   into a document.

10. **Give a page its own edits.** A page can have its own API: the edits
    it offers beyond typing (add a card, delete a row, move a node of a
    tree), in a module of its own files. In the editor, the page's script
    draws buttons for them, and a click calls one with
    `window.ergaEditor.call`. Agents call the same edits with `edit` op `call_edit`.
    Erga runs the module, makes its answer one change, one undo step, and
    refuses any that would break the page. An edit shows in the same frame
    as the click or drop, as a typed letter does: the script calls
    `ergaEditor.call` at once in the event's handler, and never changes the
    page itself to show the edit. Offer them when you make such a page, or
    when someone asks to make one editable. See "A page's own edits" below.

11. **Keep a page's place in its address.** A page that shows one part at a
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

## Presentations (erga/steps)

A presentation is a page with steps: it defines `window.ergaSteps` and
imports erga/steps, Erga's one presentation library. erga/steps draws the
steps in the page itself (back and forward buttons, the arrow keys, the list
of steps with each one drawn small) and answers `view_page`'s `step`. It works
in Erga and in a page opened outside Erga. The page's own code shows each
step. A page without `window.ergaSteps` and erga/steps has no steps.

For a deck, start from the `slides` template; for frames on one large
canvas, start from the `canvas` template. Each holds its own code, which
defines `window.ergaSteps`: the slides template's `slides.js` and `api.js`,
the canvas template's `canvas.js`. Keep that code, and change it when the
person asks for a deck or a canvas that works another way.

To make another page a presentation, import erga/steps in its `<head>` and
define the steps in its own script:

```html
<script type="module" src="https://erga.dev/erga/steps/editor.js"></script>
<script type="module">
  const parts = [...document.querySelectorAll("section.part")];
  let at = 0;
  function show(n) {
    at = n;
    parts.forEach((p, i) => (p.hidden = i != n));
    history.replaceState(null, "", "#" + (n + 1));
    dispatchEvent(new Event("ergastep"));
  }
  window.ergaSteps = {
    count: () => parts.length,
    current: () => at,
    go: show,
    label: (i) => parts[i].querySelector("h1, h2")?.textContent, // optional: the list's names
  };
  show(Math.max(0, (location.hash.slice(1) | 0) - 1));
</script>
```

`go(n)` shows step n (from 0). The page dispatches `ergastep` when its step
or its steps change. `image(i, { width, height })` can give a small picture
of step i (a canvas, a Blob or an image's address), and `slide(i)` the slide
of a step, for a slide that builds up in parts. Keep the step in the address
(rule 11).

A deck from the `slides` template holds one `<section class="slide">` for
each slide, as children of `<body>`, with a layout (`data-layout="title"`: a
heading and a line, centred; `data-layout="content"`: a heading and points).
In the editor, people type in the slides and add, move or delete slides with
the deck's bar (⌘⇧Enter adds one). Its edits are the page's own API
(`api.js`): `read` with op `document_api` lists them (`add_slide`, `delete_slide`,
`move_slide`, `set_layout`, and erga/text's for the text). Use them.

A canvas from the `canvas` template holds one `<div class="stage">` with one
`<div class="canvas">` in it, and on the canvas a `<section class="frame">`
for each step, placed by its `left` and `top`. Its heading names the step.
`canvas.js` moves the camera, and defines `window.ergaZoom`, so Erga's zoom
keys zoom the camera.

A page that defines `window.ergaInset` has the whole window: Erga's bars and
its agent's panel float over the page. Erga calls it with what they cover,
`{ top, right, bottom, left }` in px, at the start and at each change; the
page keeps what matters in the clear part (`canvas.js` centres the frame
there). The same values are `--erga-inset-top` (and `-right`, `-bottom`,
`-left`) on `<html>`. Only for a page that moves its own view: a page
without it never has anything under the bars.

To check a step, give `page` op `view_page` or `eval_in_page` the step (`step: "3"`),
and `frames: [300, 900]` to see a transition partway. To check several steps,
give `view_page` a list (`step: ["1", "2.2", "4"]`): one picture each, in one
call. They render a copy on the server, so the person's own view stays where it is.

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
    { name: "move_card", description: "Moves card n before card `before`, or to the end when before is 0", input: { type: "object", properties: { n: { type: "integer" }, before: { type: "integer" } }, required: ["n", "before"] } },
  ],
  apply(html, edit, input) {
    const card = (n) => `.cards > article:nth-child(${n})`;
    if (edit == "add_card") return [{ op: "insert", into: ".cards", html: '<article class="card"><h3>New card</h3></article>' }];
    if (edit == "delete_card") return [{ op: "remove", el: card(input.n) }];
    if (edit == "move_card") return [input.before ? { op: "move", el: card(input.n), before: card(input.before) } : { op: "move", el: card(input.n), into: ".cards" }];
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
| `{ op: "caret", el: sel }` | After the person's click, puts the caret at the end of the element's first text, where it is after the edit (`select: true` selects that text). One for each call. Without it, the caret goes to the change. |

For the person's clicks, Erga runs the module in the page and changes the
page in the same frame; for agents, in a sandbox. So write `apply` as a
quick, pure function of its arguments: no DOM, no network, no timers, and
no imports of other files. What Erga makes sure of, so the page can't break
itself:

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

**The rule: an edit shows in the frame of the click or drop, as a typed
letter does.** The page's script calls `ergaEditor.call` at once in that
event's handler, with no `await`, timer or animation before it. Just before
the call, it takes off only what it drew for the gesture (a drag's
`transform`, a class). It never moves, adds or removes the page's elements
itself to show the edit, and never waits for the call's answer to show
anything: Erga changes the page.

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
- To drag an element to a new place, move it with a `transform` while the
  pointer moves. On `pointerup`, take the transform off and call the move
  edit in the same handler (the drag below).

```html
<script>
  const draw = () => {
    if (!document.documentElement.hasAttribute("data-erga-editing")) return;
    document.querySelectorAll(".card:not(:has(> .ctl))").forEach((card) =>
      card.insertAdjacentHTML("beforeend", `<div class="ctl"><button class="grip">⠿</button><button class="del">Delete</button></div>`));
  };
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".ctl .del")?.closest(".card");
    if (card) ergaEditor.call("delete_card", { n: [...card.parentElement.children].indexOf(card) + 1 });
  });
  // Drag a card by its grip; the drop moves it, in the same frame.
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".ctl .grip")?.closest(".card");
    if (!card) return;
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    const others = [...card.parentElement.children].filter((c) => c != card);
    drag = { card, others, y0: e.clientY, mids: others.map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; }) };
  });
  document.addEventListener("pointermove", (e) => {
    if (drag) drag.card.style.transform = `translateY(${e.clientY - drag.y0}px)`;
  });
  document.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { card, others, mids } = drag, cards = [...card.parentElement.children];
    drag = null;
    card.style.removeProperty("transform");
    if (!card.getAttribute("style")) card.removeAttribute("style");
    const next = others[mids.filter((m) => m < e.clientY).length]; // the card it goes before; none: the end
    if (next != card.nextElementSibling)
      ergaEditor.call("move_card", { n: cards.indexOf(card) + 1, before: next ? cards.indexOf(next) + 1 : 0 });
  });
  addEventListener("erga-editing", draw);
  draw();
  new MutationObserver(draw).observe(document.body, { childList: true, subtree: true });
</script>
```

`e2e/fixtures/page-api/` (`index.html` and `api.js`) is a fuller example.

## A page's model (window.ergaLLM)

A page may call a model as its signed-in visitor, when its owner turns it
on in Document settings (`share_document` with `page_llm`, and `page_llm_model`: Haiku at first).
The server's API keys pay, so each visitor has an hour's limit, and so has
the server. The page's script has `window.ergaLLM` (in the viewer, and on
the homepage):

- `ergaLLM.status()` answers a Promise of `{ on, model, signedIn }`. Show
  the page's model controls only when `on` is true.
- `ergaLLM.ask({ system, messages, max_tokens })` answers a Promise of
  `{ text }`. `messages` is `[{ role: "user" | "assistant", content }]`,
  with text only, ending with the user's. At most 1024 tokens come back,
  and the system prompt and messages hold at most 24,000 characters.
- When it fails, the Error has a `code`: `"sign_in"` (the visitor isn't
  signed in), `"off"` (the owner turned it off, or the server can't run
  the model), `"limit"` (the visitor or the server reached the hour's
  limit), or `"error"`.
- `ergaLLM.signIn()` opens Erga's sign-in and comes back to the page. Call
  it from a click: on `"sign_in"`, show a button that does.

```js
try {
  const { text } = await ergaLLM.ask({ system: "Answer in one line.", messages: [{ role: "user", content: q }], max_tokens: 300 });
  out.textContent = text;
} catch (e) {
  if (e.code == "sign_in") showSignInButton(() => ergaLLM.signIn());
  else out.textContent = e.message;
}
```
