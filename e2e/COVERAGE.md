# The suite: what it covers

One suite: `bun run test`. It has 60 seconds on the Mac Studio (16 cores): the format check, the lint, the typecheck,
the unit tests and the browser tests run at the same time, and one run at a time has the machine (dev/turn.ts).

A browser test is a **journey**: one user path on one page, with its checks as steps (`journey`,
e2e/helpers/fixtures.ts). A page load costs 300 to 500 ms; a step with keys only costs 10 to 60 ms. So a check is a
step of a journey before it is a test with a page of its own. Each journey file has a budget: its test time in
seconds, with 8 workers (the most of 10 runs, plus 30%). `bun run test` names each file that is over its budget, and
fails when the whole run takes more than 60 seconds. tests/suite.test.ts holds this map to the files: a file with no
row fails, and the budgets sum to 280 seconds at most.

Measured (2026-11-10, 10 runs with no failure): 436 browser tests in 28 files, 186 s of test time, 35 to 36 s for the
whole run with the 1,100 unit tests beside them. Before: 861 browser tests in 282 files, 5 to 11 minutes.

The rules:

1. A new check goes into a journey as a step or as a line of a step, inside the file's budget. When the budget is
   full, the new check takes the place of a weaker one.
2. A check of logic that needs no page is a unit test (tests/): the editor's rules, access rules, state machines.
3. A test that reproduces a bug is a tool of its task. Before the push it becomes a step, a unit case, or it goes.
4. All files run on one kind of server (`servers.main()`), which a worker starts one time. A file that needs other
   settings, or a restart, starts a server of its own (`servers.of`), and pays for it from its budget.
5. No fixed pause: a step waits for a state (`expect.poll`, `until`, `ed.shows`). tests/test-habits.test.ts holds it.

| Id | Journey file | The risk it covers | Budget (s) |
|---|---|---|---|
| E1 | `e2e/editor/typing.e2e.ts` | Typed text is lost, lands in the wrong place, or the page, the source and the file on disk differ. Undo does not give the text back. | 7 |
| E2 | `e2e/editor/lists.e2e.ts` | A list breaks under Enter, Tab, Shift+Tab or Backspace; the focus leaves the editor on Tab. | 6 |
| E3 | `e2e/editor/caret.e2e.ts` | The caret is drawn in the wrong place or skips text; a selection by keys or mouse takes the wrong range. | 15 |
| E4 | `e2e/editor/clipboard.e2e.ts` | A paste brings styles or scripts in, or loses the formatting; a copy leaves Erga broken outside. | 5 |
| E5 | `e2e/editor/format.e2e.ts` | The format bar, the link bar, a Markdown shortcut or the slash menu changes the wrong text. | 9 |
| E6 | `e2e/editor/steady.e2e.ts` | Keys are lost while the page renders again; a browser extension, broken HTML or an edit on disk corrupts the document. | 11 |
| S1 | `e2e/shell/open.e2e.ts` | The editor does not open, opens twice, flashes, or loses its place after a reload, a page switch or a slow start. | 11 |
| S2 | `e2e/shell/panels.e2e.ts` | A panel or a bar covers the text, or a control is out of reach on a phone or at a zoom. | 7 |
| S3 | `e2e/shell/offline.e2e.ts` | Edits made offline are lost or doubled; a signed-out tab keeps writing. | 7 |
| Y1 | `e2e/sync/two-people.e2e.ts` | Two people lose or double text; they end with different documents; undo takes the other person's text. | 10 |
| Y2 | `e2e/sync/restart.e2e.ts` | A deploy or a crash loses edits, doubles the document, or loses pages. | 10 |
| Y3 | `e2e/sync/bad-input.e2e.ts` | Bad bytes, a storm of sockets or a huge paste stops the server or reaches other files. | 4 |
| G1 | `e2e/agent/turn.e2e.ts` | The agent's turn is not shown, cannot be undone, or acts without the person's Approve. | 15 |
| G2 | `e2e/agent/tools.e2e.ts` | An agent tool edits the wrong file, shows a wrong picture, or works on a document it may not open. | 21 |
| V1 | `e2e/viewer/reader.e2e.ts` | A reader gets a blank or wrong page, links leave the viewer, or the bars hide the text. | 9 |
| V2 | `e2e/viewer/live.e2e.ts` | A reader sees an old page; the page's scripts run twice. | 8 |
| T1 | `e2e/templates/templates.e2e.ts` | A template makes a broken document; a deck does not step or leaves full screen in a bad state. | 11 |
| D1 | `e2e/documents/list.e2e.ts` | A person cannot make, find, archive or delete a document; the list shows old rows. | 14 |
| D2 | `e2e/documents/tree.e2e.ts` | A page or folder cannot be made, renamed, moved or deleted; the tree shows old rows. | 12 |
| A1 | `e2e/access/sign-in.e2e.ts` | A person cannot sign in, or a person who may not, can. | 10 |
| A2 | `e2e/access/share.e2e.ts` | A person without access reads or edits; access taken away stays; a share does not arrive. | 9 |
| A3 | `e2e/access/tokens.e2e.ts` | A token gives more than its scope; an agent cannot sign in; a key shows in a page. | 8 |
| A4 | `e2e/access/admin.e2e.ts` | An admin page does not save a setting, or shows old values. | 6 |
| C1 | `e2e/comments/comments.e2e.ts` | A comment is lost, lands on the wrong text, or a commenter changes the text. | 9 |
| R1 | `e2e/versions/versions.e2e.ts` | A version is not cut; Restore gives the wrong text; the homepage deploys by itself. | 14 |
| H1 | `e2e/homepage/homepage.e2e.ts` | The homepage is blank on a new server, shows the wrong document, or a deploy breaks it. | 7 |
| P1 | `e2e/page-model/page-model.e2e.ts` | A page spends the owner's model budget for a visitor who may not, or past the limit. | 4 |
| X1 | `e2e/security/boundaries.e2e.ts` | A page's script reaches the editor, the cookies or a token; another site frames Erga; a hostile page takes the tab. | 6 |

