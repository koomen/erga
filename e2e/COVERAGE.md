# The suite: what it covers

One suite: `bun run test`. It has 60 seconds on the Mac Studio (16 cores), with the unit tests beside the browser tests.
A browser test is a journey: one user path, on one page, with its checks as steps (`journey`, e2e/helpers/fixtures.ts).
Each journey file has a budget of test time. `bun run test` names a file that is over its budget, and
tests/suite.test.ts fails when a file has no row here.

A new check goes into a journey as a step or a line, inside the budget. A check of pure logic is a unit test.
A test that reproduces a bug is a tool of its task: it stays only as a part of this map.

| Id | Journey file | The risk it covers | Budget (s) |
|---|---|---|---|
| E0 | `e2e/smoke/editor.e2e.ts` | The old smoke run, until the editor's journeys take its place. | 10 |
