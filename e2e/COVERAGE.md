# The suite: what it covers

One suite: `bun run test`. It has 60 seconds on the Mac Studio (16 cores): the format check, the lint, the typecheck,
the unit tests and the browser tests run at the same time, and one run at a time has the machine (dev/turn.ts).

A browser test is a **journey**: one user path on one page, with its checks as steps (`journey`,
e2e/helpers/fixtures.ts). A page load costs as much as ten checks, so a check is a step of a journey before it is a
test with a page of its own. Each journey file has a budget: its test time in seconds, with 8 workers. `bun run test`
names each file that is over its budget, and fails when the whole run takes more than 60 seconds.
tests/suite.test.ts holds this map to the files: a file with no row fails, and the budgets sum to 300 seconds at most.

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
| E1 | `e2e/editor/typing.e2e.ts` | Typed text is lost, lands in the wrong place, or the page, the source and the file on disk differ. Undo does not give the text back. | 9 |
| E2 | `e2e/editor/lists.e2e.ts` | A list breaks under Enter, Tab, Shift+Tab or Backspace; the focus leaves the editor on Tab. | 6 |
| E3 | `e2e/editor/caret.e2e.ts` | The caret is drawn in the wrong place or skips text; a selection by keys or mouse takes the wrong range. | 14 |
| E4 | `e2e/editor/clipboard.e2e.ts` | A paste brings styles or scripts in, or loses the formatting; a copy leaves Erga broken outside. | 5 |
| E0 | `e2e/smoke/editor.e2e.ts` | The old smoke run: it goes when the editor's journeys are built. | 10 |

The old tests are in e2e/full until their journeys are built. They run only by name (`bun run test:e2e <file>`).
