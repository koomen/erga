# The page follows the HTML: a design for the editor's view

Date: 2026-10-29. Branch `editing-model`, from origin/staging.
Author: the `editing-model` agent, for Pete.

## 1. Summary

The HTML stays the model. The page on screen stays the real page. The editor
keeps a **binding**: each element and text node that the editor drew from the
HTML is tied, by object, to its node in a parse of the HTML. Every change to
the HTML is a CodeMirror `ChangeSet`. The editor maps the binding through the
change and **reconciles only the smallest element that holds the change**. It
does not parse the whole page, does not diff the whole page, and does not
reload the page (except when a `<script>` or `<style>` changes).

Five rules make it exact and fast:

1. **Identity by binding, not by numbers in the DOM.** No `data-erga-id`
   numbers that change when a block is added. A `WeakMap` ties each live node
   to its source node. Positions of the source nodes move through each change
   (`ChangeSet.mapPos`), as CodeMirror moves positions.
2. **One step makes both changes.** A key computes the HTML change. The same
   step gives the DOM operations: set the text of one node, or reconcile one
   element. Typing changes one text node. Enter, Tab and a join change one
   list or one parent element.
3. **One general path for every other change** (undo, redo, an agent, a merge
   from another tab, the source view): "map and reconcile" (section 5). The
   same path is the fallback for the fast path, so there is no second guess.
4. **Ownership.** The editor keeps exact only what it drew from the HTML.
   Nodes that it did not draw (an extension's element, the page script's
   element, the editor's own layers) are foreign. The editor skips them in
   every walk and never fails because of them.
5. **A check that the page matches the HTML.** After each step the editor
   checks the element it changed. In tests it checks the whole page after
   each key and fails the test on a difference. In production it checks the
   page in idle time. A difference is repaired in place (that one element is
   drawn again from the HTML) and reported.

Two more decisions come with it:

6. **Structural edits change tags only.** Tab, Shift+Tab, Enter and a join
   insert and delete tags. They never write the text of an item again. Then a
   person who types in that item in another tab keeps the text (the merge is
   character by character, with Yjs).
7. **One editing host.** The editor makes the page's content one editing host,
   not one host for each text block. The browser then moves the caret across
   blocks as it does in any document (arrows, Option, Cmd, Shift). All changes
   still go through `beforeinput`. This is the riskiest step; a prototype
   comes first.

## Status (2026-10-30)

- Step 1 (the check in the tests): done.
- Steps 2 and 3 (the binding, and reconcile): done together, in `client/page-editor/mirror.ts`. Two changes to the
  plan below:
  1. `data-erga-id` stays on a unit's element as a mark, but its value never changes: an element gets one when it
     becomes a unit, and keeps it. The editor finds a unit from its element through a `WeakMap`, not by the number.
     So a block added near the top changes nothing below it, and the page's styles and the tests that select
     `[data-erga-id]` stay as they are.
  2. A region is parsed with its own tags around it (risk 1, section 11, was real: Enter in a paragraph makes
     `</p><p>` in it, and a parse of its content alone made a `<p>` in a `<p>`). If the element is no longer one
     element in that parse, its parent is the region.
  Also: a change in one element's open tag sets the attributes that changed, and a change in a `<style>` or the
  `<title>` sets its text, in place. A caret that a change leaves outside every text block (undo's history maps it
  there) goes into the nearest block (`caretInText`). A join of two blocks of one kind side by side deletes only
  the tags between their texts (design rule 6).
- Step 4 (lists): done. An item's text beside its nested list is a unit (`headOf` in `shared/manuscript.ts`), so
  Tab writes no `<p>`. Tab and Shift+Tab change only tags and indent spaces (`indentItems` in `lists.ts`). Paste
  writes items the same way, and a list pasted right above a list of the same kind joins it.
- Step 5 (undo steps): done. An edit that changes tags, and isn't typing, is an undo step of its own
  (`undoStep` in `edit.ts`); Enter over a selection is one step with the delete of the selection.
- Step 6 (block rules): done, in `client/page-editor/blocks.ts`, with the table at its top. Each rule changes tags
  only. Two changes to the plan, to keep behavior that tests and Pete's decisions document:
  1. Backspace at the start of a heading makes it a paragraph, and at the start of a top-level list's first item takes
     the bullet off (Pete's decision, after step 6). A later item joins the item above, and a nested item joins its
     text to the item above, as before (`list-keys`, `list-select`).
  2. Backspace at the start of a quote's first paragraph takes it out of the quote (as Notion, Typora and Bear do).
  In each case the next Backspace joins the block to the one before. Before, the first Backspace joined it.
  Tab in a paragraph, a heading or a quote adds `margin-left` in steps of 40 px to the block's `style` (Pete's
  decision); Shift+Tab takes a step back. A code block's empty last line has a `<br>` after its `\n` (a `<pre>` shows
  no last line break), as a paragraph's has `<br><br>`. Enter at the end of a summary makes a paragraph in its
  details if they are open on the page, else after them.
- Step 7 (one editing host): done. The page's `<body>` is the one editing host (`makeHost` in `core.ts`); each element
  that holds no text block, and isn't in one, is an island (`contenteditable="false"`, `islands`), at attach and for
  the new parts of a reconciled region. The spanning mode is gone (`setSpanning`, `spanKey`, `extendKey`, `extendTo`,
  the drag code): the browser moves the caret and the selection across blocks, with and without Shift. The arrow
  code that is left: ArrowDown out of a last code block (step 6), and Option+ArrowRight or Left at a block's edge
  (Chromium stops there; a Mac goes on to the next block's word). Changes to the plan:
  1. `<body>` is editable only while the text has the focus. After Escape (`leaveText`), after a script's `blur()`,
     or on a page that opens paused, it is not: a page's own key handlers skip editable targets (a deck's arrows,
     PROMPT.md rule 14), and the whole `<body>` would be one. A click on text makes it editable again.
  2. When the frame's window gets the focus back, the editor focuses `<body>` at once (the `<body>` is the active
     element also when the frame has no focus, and the browser does not move a caret in it then).
  3. A caret that lands outside the text (between blocks, in an `<svg>`) goes into the nearest block before the next
     paint, after a key or a mouse up; not after a click in an island (a widget keeps its click).
  4. A composition (IME) over a selection across blocks: the editor deletes the selection when the composition starts.
  5. A press in a selection starts a new selection: the editor does not drag text.
  6. A range that an edit replaces keeps the inline tags it opens or closes (`cut` in `edit.ts`). Before, a delete
     across `<em>` left `</em>` alone in the HTML. One host made this easy to reach.
  Cost: a typed letter takes 0.6 ms at 200 KB and 1.9 ms at 1 MB, before 0.5 ms and 1.7 ms.
- Step 8 (ownership and stored marks): done.
  1. A page's own `contenteditable` element is text like any other: the editor saves what people type in it. In a part
     marked `data-erga-noedit` it stays the page's (`pageOwnBox` in `core.ts`): the islands code keeps its
     `contenteditable`, the editor leaves its keys and input to the browser, and the check skips it. Rule 4 of
     `agents/document/PROMPT.md` (and so `/llms.txt`) says so, with an example.
  2. Cmd+B, Cmd+I, Cmd+U and Cmd+E with no selection store the style for the text typed next at the caret
     (`storeStyle`, `typeStored` in `format.ts`); the key again ends it (Pete: Cmd+B in bold text ends the bold, and
     the next letters go after the `</strong>`). Cmd+U, new, underlines with `<u>`, on a selection too. On: the typed text goes into a new element of the style, and
     the caret stays in it. Off: the text goes past the element's end tag (at its end), before its open tag (at its
     start), or between its two halves. A stored style holds while the caret and the document stay as they were.
- The last open knownBug (an extension's `<span>` around a word locked the paragraph): the editor reads the caret in
  text that others split by its length, and draws the block again from its HTML before the edit (`redraw`). No
  knownBug test is left in `e2e/full/page/`.
- The one-host prototype (step 7) works in Chromium, WebKit and Firefox, with two additions: a caret that lands
  outside the text (in an `<svg>`, or past the last block in Firefox) goes to the nearest block before the paint,
  and Enter and Shift+Enter stay in `keydown` (WebKit sends Shift+Enter as `insertParagraph`).

## The simpler design (2026-10-30)

Pete's page "Erga editor mechanics" proposes four more changes. Their status:

- Change 1 (one map between the source and the page): done. Each run of a unit holds its text node in the parse
  (`TextRun.node`), and the binding ties that node to the live one. A unit's element is `elOf(unit)` and its runs'
  nodes are `runNodes(unit)`, both through the binding (`core.ts`). `els[id]`, the server's `data-erga-id` stamp
  (`stamp`, `markPage`) and the counts of text nodes are gone. The pages origin serves the HTML as written; the editor
  binds it by the parallel walk (section 3.1). While it edits, the editor marks each unit's element with
  `data-erga-text` (no value), for the page's styles and the text guard; `stop()` takes it off. The binding now goes
  into atomic elements too (a `<button>` in a paragraph), so their text is checked; `<svg>`, `<math>`, `<select>`,
  `<textarea>` and `<template>` stay opaque, and a run in them doesn't count. An extension's element around one of our
  text nodes changes nothing: a key writes to the bound node in it, and the check (`check.ts`, `bound`) looks through
  the element. An extension that splits our node (a word in the middle) still makes the editor read the caret by length
  and draw the block again (`redraw`).

## 2. What is wrong today (the evidence)

### 2.1 How the view works now

- The model is the source text in a CodeMirror `EditorState`
  (`client/page-editor/core.ts`).
- `shared/manuscript.ts` finds the **units**: leaf blocks with text. Each unit
  gets a number, `data-erga-id`, by its index in the page (`stamp`).
- Each unit element is its own `contenteditable` host (`prepareUnit`).
- Each key is cancelled in `beforeinput` (`input.ts`) and becomes a change to
  the source (`edit.ts`). Then `render.ts` brings the page to the new source:
  1. `patchText`: a change to text only. `M.editRuns` moves the positions of
     the units in place, and the editor sets the text of the changed text
     nodes. This is the fast path.
  2. Else `patch`: the whole page is analyzed again (`analyzeHtml`). Old and
     new units are matched by mapped start position. If the structure changed,
     `morph` runs.
  3. `morph` (`morph.ts`): it makes two HTML strings of the whole page (before
     and after), parses both with `DOMParser`, and lines up the children with
     an LCS diff. It gives up if the live page has a different shape where the
     change is (an extension's `<div>`, a script's element).
  4. If the morph gives up: a "structural patch" that places new units next to
     a neighbour, and sets `domFrom = ""`. Then the next structural edit cannot
     morph.
  5. Else `render()`, which **reloads the page** (`config.onReload`). Keys
     typed during the reload are lost in several tests.
- Lists: `lists.ts` writes list operations as string surgery. Tab
  (`indentItems`) replaces the whole range from the item above to the last
  moved item with a new string. Then `tidy` runs on every local edit.
- Collaboration: Yjs `Y.Text` on the HTML string in the room
  (`document/room.ts`). The shell and the frame exchange CodeMirror changes,
  and the frame rebases its own edits (`bridge.ts`, `Relay`).

### 2.2 Measurements (headless Chromium, the editor's own entry points)

Typing is already fast. The structural keys are slow, and their cost grows
with the page.

| Key (median, frame work) | 5 KB | 200 KB | 1 MB |
|---|---|---|---|
| Type a letter (`e2e/bench/keystroke.e2e.ts`) | 0.3 ms | 0.5 ms | 1.5 ms |
| A letter from another tab | 0.5 ms | 0.8 ms | 1.8 ms |
| Enter at the end of a paragraph | 1.1 ms | **17.6 ms** | **84.8 ms** |
| Backspace that joins it back | 1.0 ms | 17.5 ms | 86.3 ms |
| Tab in a list item | 1.2 ms | 15.6 ms | 75.3 ms |
| Shift+Tab | 1.2 ms | 16.6 ms | 82.5 ms |

Where the time goes, for Enter at 200 KB: `analyze` 3.1 ms, `morph` 12.7 ms.
At 1 MB: 15 ms and 65 ms. The page has 1,184 DOM mutations for one Enter at
200 KB and 5,828 at 1 MB. Almost all of them are `data-erga-id` numbers that
change on every unit below the new paragraph. A frame is 16 ms, so at 200 KB
Enter already misses a frame. (Spike: `e2e/bench/structural.e2e.ts`,
log in a note (not in the repository).)

For the design: a parse of one `<section>` takes 0.004 ms, and an analysis of
one `<ul>` 0.002 ms; an analysis of the whole 200 KB page takes 5 ms
(a spike (`region.ts`, not in the repository), bun). So a reconcile of one element costs
microseconds of parsing. The DOM work is a few nodes.

So Pete's worry ("redraw the HTML with every new character") is not what
happens for a typed letter. It is what happens, in effect, for every Enter,
Tab, join, undo, redo and merge: two parses of the whole page, a diff, and a
renumbering.

### 2.3 The knownBug tests, by cause

46 knownBug tests were open on this branch's base (`1416486`). I checked the
reading in the brief against the code. It is right, with two more classes
(history, and features that are not there).

**A. The view drifts or reloads (9).** The morph gives up, a fallback guesses,
or the page reloads and keys are lost.

- `list-undo` redo after `- ` and undo; redo of a join; redo of a Tab (3).
  Redo is a CodeMirror inverse change, not a list operation, so it goes
  through `patch`. After a structural patch, `domFrom` is empty, so the next
  one reloads the page.
- `robust-lists` a key right after Tab with an extension's `<div>` in the page.
- `editing-blocks` typing after Cmd+A twice and Backspace, with an extension's element.
- `robust-pages` keys after an extension wraps a word in a `<span>`: the text
  nodes no longer match the runs one to one, so `verify` locks the unit.
- `robust-tabs` the other tab joins your paragraph; the other tab indents the
  item you type in (2). The join and the Tab come as structural changes from
  outside; the second also has class D below.
- `markdown-blocks` `- [ ] ` shows a bullet until a reload: the change is
  outside the units (`list-style` on the `<ul>`), the patch cannot show it.

**B. Lists, quotes and other blocks are not things in the model (11).**

- `list-keys` and `robust-lists` Tab puts the item's text in a `<p>`, and the
  `<p>`'s margins show (2). The `<p>` is there because a unit must be a leaf
  block: `<li>Two<ul>…</ul></li>` has no unit for "Two" today.
- `list-paste` items pasted above a list make a second list.
- `markdown-blocks` Backspace at the start of a heading, of a list's only
  item, of a quote; Enter twice in a quote (4).
- `editing-blocks` Enter at the end of a code block; Enter on an empty quote
  line; Backspace at the start of a quote (3).
- `robust-pages` Enter at the end of a `<summary>` makes a second summary.

**C. The browser decides the key (13).** Each unit is its own editing host, so
the browser stops at the edge of each block.

- `editing-caret` (6): ArrowDown from a title, the column across short blocks,
  Shift+ArrowDown, Cmd+ArrowDown, Option+ArrowRight, Cmd+ArrowRight on a
  wrapped line.
- `list-select` Shift+ArrowUp and Shift+ArrowDown (2).
- Tab in a paragraph moves the focus out (`markdown-blocks`, `editing-blocks`) (2).
- `editing-blocks` a click under the last block; composed text over a
  selection across blocks; Cmd+B with no selection (3).

**D. Undo steps (3).** `list-keys` undo after Tab and typing; `list-undo` Tab
and Shift+Tab are one step; `editing-blocks` Enter over a selection takes two
undos.

**E. Markdown features that are not there (9).** ` ``` `, `---`, `~~`, `***`,
nested bold and italic, `[text](url)`, a typed address, a pasted table, `---`
and `~~` in pasted Markdown. These are not view problems. The fix-markdown
agent works on them now.

**F. Ownership (1).** `robust-pages`: the page's own `contenteditable` box
shows typed text, but the editor does not save it.

So the view design fixes A (9) and F (1) directly, makes B (11) and D (3)
small and safe to fix, and C (13) needs the input change (rule 7). E (9) is
independent.

### 2.4 Collaboration: why keys are lost

The merge is character by character (Yjs, and `Relay` rebases with
`ChangeSet.map`). This keeps text when the changes are small. It breaks when
one side's change **replaces** a range: `indentItems` deletes the range from
the item above to the last moved item and inserts a new string. Text that the
other tab typed in that range maps to the edge of the deleted range and lands
outside the item ("loose text in the `<ul>`"). The fix is in the operations,
not in the merge: a Tab must insert and delete tags only, and leave the
item's text where it is. Then the merge keeps the typed text in the item.

The join case loses keys for a different cause: the join comes into tab B as
an external structural change; B's patch cannot morph it and reloads the page
(class A).

### 2.5 The list-swap report

See section 12.

## 3. The design: the binding

### 3.1 The tree

The editor keeps **one parse of the source**, `M.parseHtml`, as today (the
`ElementNode` tree with source ranges). Each source node that the page shows
is bound to the live DOM node that the browser made from it:

```ts
interface Binding {
  live: WeakMap<Node, SourceNode>;   // live DOM node -> source node
  dom: Map<SourceNode, Node>;        // source node -> live DOM node
}
```

- **At attach**, the editor walks the source tree and the live DOM in
  parallel, from `<body>`. A live child that has no source child at that
  place is foreign (section 6), and the walk skips it. A source text node
  that is whitespace the browser keeps or drops is matched by what the
  browser does (the same rules `verify` and `same` use now). Where the walk
  cannot match (the page's script changed that part), the subtree is
  page-owned (section 6), and nothing inside it is bound.
- **Units** stay as a concept (text blocks that hold a caret), but they are
  objects in the tree, not numbers in the DOM. `data-erga-id` goes from the
  live page. The pages origin can still stamp the first HTML for the first
  binding, if that is faster than the parallel walk; after that, nothing in
  the page holds a number.
- The editor's own marks on page elements (`contenteditable`, `spellcheck`,
  `erga-empty`, `erga-locked`) are listed in one place as "editor
  attributes". The check (section 7) ignores them. Where it can, the editor
  moves them off the page's elements: the placeholder can be a CSS highlight
  or a layer, not a class.

### 3.2 Positions through a change

Source positions in the tree move through each change. Today `M.editRuns`
moves every unit and every node after the change: O(units), 1.5 ms per key at
1 MB. This is acceptable now. If it grows, store each node's start relative to
its parent, so a change moves only the ancestors and the later siblings on
the path (the way CodeMirror's `Text` and Lezer trees keep positions). This
is an optimization, not a part of the first steps.

### 3.3 Why a binding, and not ids or paths

- **Ids in the DOM** (`data-erga-id`) must be numbered again on every
  structural change (1,184 mutations for one Enter at 200 KB). They also show
  in the page's DOM, where a page script or an extension can copy or lose them.
- **Node paths** (child indexes) change when a sibling is added, and the
  page's own nodes make the indexes differ between source and DOM.
- **A binding by object** survives moves (a `Node` moved in the DOM is still
  the same key) and needs no attribute. Positions come from the source tree,
  and CodeMirror's mapping moves them. This is the same split as CodeMirror's
  view: the document has positions, the view has a tree of view objects bound
  to DOM nodes.

## 4. The fast path: typing

A typed letter in a text block:

1. `beforeinput` (insertText) is cancelled, as today.
2. The edit makes a `ChangeSet` (one insertion in one run).
3. `M.editRuns` updates the run in place, as today.
4. The run's bound text node gets the new value: `node.data = text`. One DOM
   write. No parse, no analysis.
5. The caret is set from the model's selection.

This is today's `patchText`, and it stays. What changes: the text node comes
from the binding (`dom.get(run)`), not from "the n-th text node of the unit
element". So an extension's `<span>` around a word (it moves our text node
into its span) does not break the mapping: the bound node is still ours, and
it is still inside the unit. The check accepts a bound text node inside a
foreign inline wrapper, if it is still inside its unit and in order.

Cost: today 0.5 ms at 200 KB and 1.5 ms at 1 MB (the frame's own work, with
the change sent to the shell). The design keeps this; with relative positions
(3.2) the 1 MB figure goes to about the 5 KB figure.

IME, dictation and the emoji picker: the browser changes the DOM itself
(`insertCompositionText` cannot be cancelled). At `compositionend` the editor
reads the bound text node, makes the change, and the DOM write is then a
no-op (the node already holds the text). The check confirms it. This is
today's `readBack`, with the node from the binding.

## 5. The general path: map and reconcile

Every change that is not "text in one run" goes through one function:

```
reconcile(changes: ChangeSet, newSrc: string)
```

1. **Find the region.** Find the smallest bound source element `E` whose own
   open and close tags the change does not touch, and which holds every
   changed range inside its content (`openTo` .. `closeFrom`). For Enter in a
   paragraph that is the paragraph's parent (`<section>`); for Tab, the `<ul>`
   or its parent `<li>`; for a join, the parent of the two blocks. If a change
   touches a `<script>` or `<style>`, or `E` would be the `<html>` or a
   page-owned element, stop: the page loads again (as today, and only then).
2. **Parse the region.** Parse `newSrc` from `E.openTo` to the mapped
   `E.closeFrom`, in the context of `E`'s tag (the parser's rules for `<p>`,
   `<li>`, `<table>`). This is microseconds (section 2.2).
3. **Reuse by mapped position.** An element is the same element if **its open
   tag** is untouched by the change and maps to the new element's open tag,
   with the same tag name. (Changes inside it, or at its close tag, do not
   make it a new element: its children are reconciled.) A text node is the
   same node if its start maps to the new text's start; its data is set if
   the text changed. A reused node keeps its live node, moved to its new
   place if it moved, with its text nodes, its images, its state, and
   whatever a script did to it. A new node gets a new live node (from a
   `<template>` for a new subtree), and inside it, the reuse rule applies
   again (a moved item is moved, not made again).

   Spike (a spike (`identity.ts`, not in the repository), bun): Tab on "Two" in
   `<ul><li>One</li><li>Two <b>bold</b></li><li>Three</li></ul>`, written as
   tag changes only. The rule reuses the `<ul>`, `<li>One`, `<li>Two`, its
   `<b>`, and `<li>Three`. Only the new nested `<ul>` is made. So the DOM
   operations are: make one `<ul>`, move the `<li>Two` node into it, and put
   it in `<li>One`. The caret's text node in "Two" is the same node. A first
   version of the rule ("the whole range is untouched") made `<li>Two` new,
   because the insertion of `</ul></li>` touches its end; the open-tag rule
   is the right one.
4. **Apply.** Put the live children of `E` in the new order with
   `insertBefore`, remove the old bound nodes that were not reused, and leave
   foreign nodes where they are (next to the same neighbour). Update the
   binding: rebind the reused nodes to the new source nodes, bind the new ones.
5. **Update the units** inside `E` only (an analysis of the region), and map
   the rest. Set the editor attributes on new units only.
6. **Check** the region (section 7). Set the DOM selection from the model.

All of this is synchronous, in the same task as the key: one frame, no
flicker. There is no LCS and no parse of the whole page. The work is the size
of `E`'s content.

The reuse rule is what makes the identity exact: a node is "the same" if and
only if its source range is untouched and maps to the new range. This is the
CodeMirror mapping applied to tree nodes. Nothing is guessed from similar
shapes.

**What uses it:** undo and redo (the inverse `ChangeSet`), an agent's edit, a
merge from another tab, an edit on disk, the source view, a custom edit
(`ergaEditor.apply`), paste, and a structural key that has no step of its own
(section 5.1). The fixes for class A come from this: redo no longer reloads,
an extension's `<div>` no longer stops a morph, the `- [ ] ` change to the
`<ul>`'s `style` attribute shows (an attribute change on `E` itself is a
`setAttribute`, with `E`'s parent as the region).

**What goes:** `morph.ts`, the structural branch of `patch`, `domFrom`,
`unshown`, `skeletonOfSource`, the `ids` operation, and `render()` as a
fallback for anything but a script or style.

### 5.1 Structural steps

A structural key (Enter, Tab, Shift+Tab, Backspace or Delete at an edge,
paste of blocks) is a **step**: a pure function of `(source tree, selection)`
that gives

- the `ChangeSet` (tags inserted and deleted; text only where text is typed
  or pasted), and
- the selection after it.

The DOM side of a step is `reconcile` on its region. For Tab, reconcile
reuses the moved `<li>` (its range is untouched: only tags around it change),
so the item's text node is the same node, and the caret does not move. A step
does not need its own DOM code. The steps can still give a "hint" (the region
`E`) to save the search in step 1.

**Tags only.** Tab on "Two" in `<ul><li>One</li><li>Two</li></ul>`:

```
before: <li>One</li>\n<li>Two</li>
after:  <li>One\n<ul><li>Two</li></ul></li>
changes: delete "</li>" after One; insert "<ul>" before <li>Two;
         insert "</ul></li>" after Two's </li>
```

"Two" and its tags `<li>…</li>` are not rewritten. Another tab that types in
"Two" at the same time keeps the text in the item (Yjs, and `Relay`, merge by
character). A move that must move text (Tab of an item that is not next to
its new parent) is the exception; it is written as tag changes when it can,
and as a delete and an insert only when it cannot.

**No `<p>` in an item.** A unit today must be a leaf block, so
`<li>Two<ul>…</ul></li>` had no unit for "Two", and `lists.ts` puts the text
in a `<p>` (whose margins show: class B). The design adds one rule to
`manuscript.ts`: the inline content of an element **before its first block
child** is a unit too (CSS calls it an anonymous block). The unit is
`(li, contentFrom, start of the nested list)`. Then Tab writes no `<p>`, and
the spacing is the page's own list spacing. Existing `<li><p>` pages still
work: their `<p>` is a unit as before.

**One table of block rules.** Enter in an empty block, Backspace at the start,
Enter at the end: one table, by block kind (paragraph, heading, list item,
to-do, quote, code, summary, table cell), with the behaviour Google Docs,
Notion, Typora and Bear agree on. Each rule is a step. This replaces the
special cases in `edit.ts`, `lists.ts` and `markdown.ts`, and it is where the
class B tests are fixed.

**`tidy` becomes part of the steps.** Today `tidy` runs after every local
edit and adds its own changes. In the design, each step leaves valid
structure itself, so there is no second pass. `tidy` stays only as a check in
the unit tests (`tests/lists.test.ts`): after each step, `tidy` must find
nothing.

### 5.2 Undo

Each structural step is its own undo step (`isolateHistory`), and typing after
it starts a new one. This fixes class D (3 tests). Undo and redo apply the
inverse `ChangeSet` through `reconcile`; the selection comes from the history.

## 6. Ownership

| Part of the page | Owner | What the editor does |
|---|---|---|
| Elements and text drawn from the HTML (bound) | the HTML | Keeps them exact. Every change to them comes from a change to the HTML. |
| Nodes in the page that are not from the HTML: an extension's element in `<body>`, a password manager's button, Grammarly's `<span>` | others (foreign) | Skips them in the binding, in reconcile and in the check. Never removes them, unless their parent is removed. |
| Bound nodes that the page's script changed after load (a chart's labels, a clock) | the page's script (page-owned) | Detected at attach (the walk does not match). Not bound, not editable (as `erga-locked` today). A change in the HTML inside it loads the page again. |
| `<script>`, `<style>`, `<template>` | the HTML, but run by the browser | A change loads the page again. |
| The editor's layers (carets, marks, the authors' colours, the editor's style) | the editor | In one host element of the editor's own, outside the page's content (a shadow root on an `erga-` element under `<html>`), so they are never siblings of the page's nodes. |
| The editor attributes on bound elements | the editor | Listed in one place; the check ignores them; `stop()` takes them off. |

Two rules for the edges:

- **A foreign node inside a unit.** If an extension wraps our text node in its
  `<span>`, the bound text node is still ours. A typed key writes to it. The
  check accepts it, if it is still inside its unit, in order. If an extension
  replaces our text node with its own (it removes ours), the check finds a
  bound node that is not connected; it draws that unit again from the HTML
  (the extension's node goes with it).
- **The page's own `contenteditable` (class F).** Today the editor does not
  save it. Decision for Pete: an element in the HTML with `contenteditable`
  becomes a unit like any other (the editor owns it and saves what is typed),
  unless it has `data-erga-noedit`. Then `robust-pages` "text typed in the
  page's own contenteditable box" is fixed. The other choice is to make it
  read-only in the editor and say so.

## 7. Verification

**The check** (`checkRegion(E)`): walk `E`'s source subtree and its bound
live nodes together:

- every bound node is connected, and its live parent is the bound node of its
  source parent (or a foreign inline element inside it, for text);
- the bound children are in the source's order (foreign ones skipped);
- the tag is the same; the attributes are the source's (editor attributes
  skipped);
- a text node's data is the decoded run text (`same`, as `verify` does now).

Cost: proportional to the region. For the whole 200 KB page it is one walk of
about 6,000 nodes; I estimate 2 to 5 ms, run in idle slices of 4 ms.

**When:**

- After each step, on the region the step changed. Always (it is small).
- In tests (`e2e`, `bun run look`): the whole page after every key, and a
  difference fails the test with the first node that differs. Each e2e test
  then also tests the view, not only the snapshot. This is cheap evidence: it
  turns "the page drifted" bugs into failures with a cause.
- In production: the whole page in idle time (`requestIdleCallback`), in
  slices, at most once a second while the person types, and after each change
  from outside (an agent, a merge).

**When it finds a difference:** draw that element again from the HTML
(reconcile with no reuse), keep the caret by its source position, and report
it once (`onProblem`, with the node and the cause) so that the bug is seen.
Never reload the page for it. If the element is page-owned, lock it, as
today.

## 8. Input

| Key or input | Who handles it |
|---|---|
| Text (`insertText`), Backspace, Delete, word and line deletes, Enter, Shift+Enter, paste, cut, drop, undo, redo | The editor: `beforeinput`, cancelled, as today. |
| Tab and Shift+Tab, everywhere in the content | The editor: `keydown`, always cancelled. In a list item: indent. In other blocks: decision for Pete (indent the block as Notion does, or insert nothing). Never a focus move (class C, 2 tests). |
| The arrows, with or without Shift, Option, Cmd; Home, End; Page Up and Down | **The browser**, natively, once the content is one editing host (below). The editor reads the selection after it (`selectionchange`), as today. The editor handles them only where the browser cannot: at a non-text block (a picture, a widget). |
| A click in the margin, or under the last block | The editor: `mousedown` outside a unit puts the caret at the nearest unit's edge (the start of the next, or the end of the last). |
| IME composition, dictation, the emoji picker, spellcheck replacements | The browser writes the DOM; the editor reads it back at the end (section 4). |
| Cmd+B with no selection | The editor: a "stored mark" in the model (as ProseMirror), so the next typed text is bold. |

**One editing host.** Today each unit is its own `contenteditable` host, and
the browser keeps the caret and the selection inside one host. That is why
ArrowDown, Shift+arrows, Option+arrow and Cmd+arrow stop at a block's edge
(class C, 9 tests), and why the editor has the "spanning" mode
(`setSpanning`, which writes an attribute on every unit, O(units), on each
selection that crosses a block).

The design makes the page's content one host: the nearest common ancestor of
the units (usually `<body>`) gets `contenteditable`, and everything in it that
is not manuscript gets `contenteditable="false"` (widgets, scripts' parts,
`data-erga-noedit`, page-owned parts, foreign elements the editor knows of).
The browser then moves the caret through the whole document as in any
editor. The editor still cancels every change in `beforeinput`, so the
browser never edits the DOM except during IME.

Risks of one host, for the prototype: a caret can land between blocks or in
a non-text part (the editor maps it to the nearest unit, as `posNear` does for
the spanning mode now); the page's own click handlers in an editable area (a
button in a `contenteditable="false"` island works in Chrome; the prototype
must test Safari and Firefox); the cost of a large host in Chrome (layout of
the caret in a 1 MB host).

## 9. Collaboration

1. **The merge stays character by character** (Yjs in the room, `Relay`
   rebase in the frame). It keeps text, if the operations do not replace
   ranges.
2. **Structural steps change tags only** (section 5.1). Then a Tab or a join
   in one tab and typing in the same item in another tab merge to the right
   result: the typed text stays in the item.
3. **A change from outside goes through `reconcile`**, never a reload. So the
   keys that this tab types while the change arrives are not lost (class A,
   `robust-tabs`, 2 tests).
4. **The caret maps through the change** (`selection.map`), as today, and the
   DOM selection is set from it after reconcile.
5. **A merge can still make invalid structure** (two tabs each make the
   same item into a list at the same time). The design does not repair it
   automatically on every tab (that would make more conflicts). The page
   shows what the browser makes of the HTML; the binding marks the part
   that does not parse as written as page-owned until a local edit there
   (which runs the step's own rules) or the agent fixes it. This is a known
   limit (section 11).

## 10. What stays, what goes, and the steps

### 10.1 Code

| Stays | Changes | Goes |
|---|---|---|
| The source as the model (`EditorState`) | `render.ts`: `patch` becomes `reconcile` | `morph.ts` |
| `shared/manuscript.ts` parse, runs, decode, `editRuns` | units: objects in the binding; the "inline before the first block" rule | `data-erga-id` in the live page, `stamp` for the live page, `collectEls` |
| `patchText` (the fast path) | `core.ts`: `posFromDOM`, `domAtPos` through the binding | `domFrom`, `unshown`, `skeletonOfSource`, the structural branch of `patch` |
| `input.ts` `beforeinput` handling | `lists.ts`: steps that change tags only | `tidy` as a pass in `dispatch` (it stays as a test) |
| `bridge.ts` `Relay`, `remote.ts`, `room.ts`, `merge.ts` | `edit.ts`: the block rules as one table | `setSpanning` (after step 7) |
| `keepView` (scroll held still) | history: each step isolated | `render()` as a fallback (it stays for scripts and styles only) |

### 10.2 Steps

Each step is shippable alone, with `bun run test` passing, and turns some
knownBug tests green. The counts are from this branch's base; section 12 gives
the state on origin/staging when I finished.

1. **The check, in tests only.** `checkPage()` in the frame, and the e2e
   helper runs it after each key. Old code, new check. Expected: some passing
   tests fail; each failure is a drift bug with its node. Mark them
   `knownBug`. Size: ~150 lines. Turns nothing green; finds the bugs.
2. **The binding.** Bind at attach by a parallel walk; `posFromDOM`,
   `domAtPos`, `unitOf` through the binding; `data-erga-id` goes from the live
   page. `patchText` writes the bound node. Size: ~400 lines changed in
   `core.ts`, `render.ts`, `input.ts`. Green: `robust-pages` extension
   `<span>` (1). Enter at 200 KB loses the 1,184 renumbering mutations.
3. **Reconcile.** Replaces `morph` and the structural patch; `render()` only for
   scripts and styles. Size: ~300 lines new, ~500 lines removed. Green: the 3
   `list-undo` redo tests, `robust-lists` extension `<div>`, `editing-blocks`
   extension element, `robust-tabs` join, `markdown-blocks` `- [ ] ` bullet
   (7). Enter and Tab at 200 KB: from 17 ms to under 2 ms (target; measure
   with `e2e/bench/structural.e2e.ts`).
4. **Tags-only list steps, and the anonymous unit.** `indentItems`,
   `enterItem`, joins and paste as tag changes; no `<p>` in items. Green:
   `list-keys` spacing, `robust-lists` gap, `list-paste` one list,
   `robust-tabs` Tab while typing (4).
5. **History.** Each step isolated. Green: `list-keys` undo, `list-undo` Tab
   then Shift+Tab, `editing-blocks` Enter over a selection (3).
6. **Block rules table.** Heading, list item, quote, code block, summary.
   Green: 4 in `markdown-blocks`, 3 in `editing-blocks`, `robust-pages`
   summary (8). Tab in a paragraph (2) by the Tab rule.
7. **One editing host** (prototype first, section 13). Green: 6 in
   `editing-caret`, 2 in `list-select`, the click under the last block, the
   composed text across blocks (10). Removes the spanning mode.
8. **Ownership decision for a page's own `contenteditable`** (1), and stored
   marks for Cmd+B with no selection (1).

Class E (Markdown features, 9) is outside this plan; the fix-markdown agent
works on it now.

Rough size: steps 1 to 5 are about two weeks of one agent's work; steps 6 to
8 about one more week, with the prototype for step 7 first.

## 11. Risks and unknowns

1. **The parser context of a region.** A region parsed alone can parse
   differently from the whole page (a `<p>` that the next block closes, a
   `<table>`'s implied `<tbody>`). `M.parseHtml` already follows the browser's
   rules; the check catches a difference, and reconcile then takes the parent
   as the region. Risk: low to medium.
2. **The first binding.** A page whose script rebuilds a large part of the
   page on load makes that part page-owned. This is today's `erga-locked`,
   by subtree. Risk: low.
3. **One editing host** in Safari and Firefox (caret in islands,
   `contenteditable="false"` widgets, `beforeinput` coverage). Risk: high;
   this is why it is a prototype first and the last step.
4. **Invalid structure after a merge** (section 9.5). Rare; the page still
   shows; a local edit there repairs it. Risk: low.
5. **The anonymous unit** (`<li>Two<ul>`) touches every place that asks
   "which unit holds this position". Risk: medium; `tests/lists.test.ts` and
   the list e2e tests cover it.
6. **Fix agents in the same files now** (fix-textloss, fix-caret,
   fix-markdown). Their fixes may conflict with steps 2 to 4. Their tests
   stay; their code in `render.ts`, `morph.ts` and `lists.ts` may go with
   steps 3 and 4.

## 12. Status on origin/staging, and the list-swap report

**origin/staging when I finished:** `1416486` (no new commits from the fix
agents yet). 46 knownBug tests are open in `list-*`, `markdown-*`,
`editing-*` and `robust-*`; the list is in a note (not in the repository)
(a spike (`count.sh`, not in the repository) makes it again). The counts in this design are
for that commit. When fix-textloss, fix-caret and fix-markdown push, run the
script again: each test they turn green comes off its class in 2.3.

**The list-swap report** (interim,
`the list-swap agent's notes`): the agent could not reproduce
the swap in 24 setups. It names three possible causes, not proved:

1. `morph.ts` `children()` checks only node names before it changes the
   page. If the HTML the page came from (`domFrom`) does not agree with the
   page, the morph changes the wrong `<li>`, and a later morph or render
   corrects it.
2. `patch()` matches old blocks to new blocks by mapped start positions. A
   change from a word diff (`changesBetween`: a resync, `agree()`, the state
   carried over a reload) can map one item onto another.
3. A reload shows the page from older text, and the editor then brings it to
   the new text.

All three are paths that this design removes: there is no `domFrom` and no
morph (reconcile works from the binding, not from a remembered HTML string);
a node is reused only if its open tag is untouched, and whatever is reused,
the result is checked against the new HTML (section 7), so a wrong match can
cost a reused node, never a wrong order on screen; and there is no reload
for structure. The report also found one more bug: with an extension's
`<div>` in `<body>`, Enter at the end of an item's `<p>` reloads the page and
loses the keys typed during the load (class A; step 3 fixes it).

## 13. What to prototype first

1. **Reconcile on the bench page** (step 3, by itself, behind a flag): Enter,
   Tab, a join, and redo, at 200 KB and 1 MB. Measure the frame time and the
   DOM mutations with `e2e/bench/structural.e2e.ts`. Target: under 2 ms
   and under 20 mutations at any size. Then run the list and robust e2e
   tests with the flag on.
2. **One editing host** in a scratch page (no Erga code): `<body
   contenteditable>`, islands `contenteditable="false"`, every `beforeinput`
   cancelled, in Chrome, Safari and Firefox. Check: the arrows across blocks,
   Shift+arrows, a click in a widget, IME. One day of work, and it decides
   step 7.
