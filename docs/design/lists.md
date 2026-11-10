# Lists in the page editor

Update (2026-10-30, docs/design/view.md, step 4): an item's text beside its nested list is a unit of its own
(`<li>text<ul>…</ul></li>`, `shared/manuscript.ts`, `headOf`), so Tab no longer puts the text in a `<p>`, whose
margins showed as a gap. Tab and Shift+Tab change only tags and the spaces that indent the lines, so another tab that
types in the item keeps its text. Paste writes an item with a nested list the same way. A page whose items have
their text in a `<p>` keeps it. Two lists of the same kind side by side join when the edit put one of them there
(items pasted right above a list). What follows is the design as it was decided first.

Decision (2026-10-28): **refactor, but not as a rewrite.** All list edits now go
through one module, `libs/text/api/lists.ts`. It has one model of a list
item, the list operations as pure functions of the source, and one cleanup
after every edit. A full model with a serializer that writes the whole list
again is not used. The reasons are in "Not chosen" below.

## Findings

**How lists were edited.** The editor's model is the HTML source. Its units are
the text blocks (`shared/manuscript.ts`). A `<ul>`, an `<ol>` and the `<li>`
around a nested list are not units: no unit holds them. Nine code paths
edited list HTML, each with its own view of an item:

| Edit | Where (before) |
|---|---|
| Enter: split an item, or leave the list from an empty item | `edit.ts` `enter` |
| Backspace/Delete at an edge: join two units | `edit.ts` `join`, `joinHtml` |
| Delete a selection across units | `edit.ts` `replaceSpec` |
| Tab, Shift+Tab | `edit.ts` `indentItem` (150 lines) |
| Backspace at a to-do's checkbox | `edit.ts` `deleteChar` |
| A list left empty after an edit | `edit.ts` `emptiedLists` |
| Paste into an item | `clipboard.ts` `pasteBlocks` |
| `- `, `1. `, `[ ] ` | `markdown.ts` `blockRule`, `todoRule` |
| Shift+Enter, line breaks | `edit.ts` `enter`, `deleteChar` (not only for lists) |

**The root cause.** The generic block edits (split, join, delete across
blocks, paste) work on units. They do not know the item as a structure. An
item with a nested list holds its text in a `<p>`: `<li><p>text</p><ul>…</ul></li>`.
For such an item, Enter and paste split the `<p>`, not the `<li>`, so one item
got two paragraphs. A join took the nested list out and left the `<p>` alone
in the item. A delete across a list's edge never joined, because the two units
were not siblings. Also, each path cleaned up after itself, or did not. There
was no single cleanup that keeps the rules of a list. The five recent fixes
each patched one key in one place.

**Measured.** The table in `tests/lists.test.ts` has 68 cases: each key at the
start, middle and end of first, middle, last, empty, nested and to-do items,
selections across items and lists, paste, and the round trips. On the code
before, 18 of the 68 cases failed. A sweep of 468 key presses found 3 more:
Shift+Tab lost the caret at the end of an item's text. Now none fail.

## Design

1. **One item model.** `itemOf(unit)` gives the `<li>`, its list, the element
   that holds its text (the `<li>` or its first `<p>`) and its nested lists.
2. **Operations as pure functions** of `(source, units, selection)`. Each one
   gives back `{changes, selection}`, and the editor makes these in one
   transaction, so one undo step undoes the operation:
   - `enterItem`: leave the list from an empty item. Split an item with a `<p>`
     as an item (the second half keeps the nested lists). At the start of an
     item with a `<p>` or a checkbox, put a blank item before it.
   - `indentItems`: Tab and Shift+Tab (sink and lift in ProseMirror's words).
   - `carryLists`: when an item with nested lists joins the text before it,
     the item goes, and each line keeps its level.
   - `dropBlankItem`: a join into a blank item before removes the blank item,
     so the item keeps its id, class and checkbox.
   - `itemSplit`: a paste splits an item, not its `<p>`.
   - `untodo`: Backspace at a checkbox removes the checkbox.
3. **One cleanup** (`tidy`). It runs in `dispatch` after every local edit that
   changed list tags, in the same transaction:
   - It removes a list that the edit made empty.
   - It joins two lists of the same kind that the edit made adjacent.
   - It removes the `<p>` from an item whose last nested list the edit removed.
4. **Small changes, the author's HTML kept.** Only the items that an operation
   moves are written again. Attributes, classes, styles and the line layout
   of the list stay as they are.

These rules agree with ProseMirror (`splitListItem`, `sinkListItem`,
`liftListItem`, and a join that keeps the nested lists) and with Google Docs
(Enter in an empty item leaves the list, Backspace joins with the line above).

## Not chosen: one model of the list, written again as a whole

In ProseMirror the document is the model, and the HTML comes from it. In Erga
the source is the document, and authors write it by hand. A serializer that
writes a whole list again has these problems:
- It changes the author's formatting, unless it can reproduce any layout
  exactly.
- It turns each key into a change of the whole list. With Yjs, a collaborator
  who types in another item at the same time can lose that text.
- It is a larger change (most of `edit.ts`), with more risk to edits that work
  now.

The operations here work on the same item model and keep the same rules,
but each one changes only the source that it must change.

## Limits

- Tab moves an item with its nested items (as in ProseMirror and Notion). In
  Google Docs, each line moves alone.
- Backspace at the start of a to-do takes its checkbox off first, so Enter
  then Backspace at a to-do's start does not give back the source.
- Redo puts the caret at the end of the changed text. This is so for all
  edits, not only lists, and it is not changed here.
- The Markdown starts (`markdown.ts`) still write their own list HTML. They
  make a new list from a paragraph, and they had no bugs.

Tests: `tests/lists.test.ts` (no browser, 69 tests) and
`e2e/editor/lists.e2e.ts`.
