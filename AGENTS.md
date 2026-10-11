# Agents working in this repo

## How to work

Work on a branch of `staging`, or on `staging` itself for a small change.
Before you push, run the tests:

    bun run test               # the typecheck, the unit tests and the smoke run: under a minute


Push to `staging` (`git push origin HEAD:staging`): staging.erga.dev
deploys it at once. Production (erga.dev) deploys when `main` moves to a
staging commit: Merge on /admin/source, the admin agent's
`deploy_production`, the API, or a push to `main`.

The smoke run (`e2e/smoke/`) checks the editor's core in a real browser.
Keep it small: it has a time limit (90 s), and a new test there should
replace one. Every other end-to-end test is in `e2e/full/`. Run the whole
suite (`bun run test:full`) only when the user asks for it; run one file or
folder of it when you change that part (`bun run test:e2e
e2e/full/page/html-typing.e2e.ts`).

## Summaries

Every summary of finished work (your final reply, a long commit message) is
written in **ASD-STE100**, Simplified Technical English. The user reads it
cold, and must understand it on one read. The rules
that matter most:

- Short sentences: at most 20 words in an instruction, 25 in a description.
- One idea in each sentence.
- Active voice: "The server sends the file", not "The file is sent".
- Simple tenses only: present, past, future.
- No -ing forms as nouns or adjectives ("the loading spinner" becomes
  "the spinner that shows during load").
- Keep the articles: "the", "a".
- Common, approved words, and one word for one meaning: if it is a "page",
  it is always a "page".
- Technical names (file names, commands, settings, keys) stay as they are.
- Numbered steps for procedures; lists for results.
- No implementation trivia, strings of internal names or arrow chains.

The shape, with only the parts that apply:

1. One sentence: what the task changes for the user.
2. Results, with numbers (before and after) where there are any.
3. Changes: a numbered list, one change in each item.
4. Limits: what does not work, or what is different, and the risk.
5. Tests: what you tested and the result.
6. What the user must do: where to look, and anything before the merge.

For example:

    This task makes documents open faster for readers.

    Results (desktop, first visit):
    - Time until the document shows: 517 ms before, 193 ms after.

    Changes:
    1. The server reads the database one time for each page. Before, it
       read the database four times.
    2. The browser keeps a copy of the document files.

    Limits:
    - If the server stops in the 400 ms after an edit, readers can see
      the old version. The edit is not lost.

    Tests: All tests pass. A new test measures the time to open a document.

    To see it: open http://localhost:4712/demo and reload the page.

## Standing rules

1. **Staging is for admins only.** staging.erga.dev runs on a copy of
   production's data. The copy is frozen: a deploy keeps it, and only a
   Redeploy with a fresh copy replaces it. Every request there needs an
   admin: an admin's session or an admin-scope token (`cloudflare/admins-only.ts`, from
   `adminsOnly` in `deploy/targets.json`). Keep it so: a new route or origin
   goes behind that guard, and any exemption (server to server, sign-in) is
   listed there with its reason.
2. **Erga's embedded agents can do what their person can.** An agent inside
   Erga can do everything its person can do in its domain. The admin agent
   (`agents/admin.ts`) covers everything on `/admin` (the Source page and
   `/settings` too); the document agent (`agents/document.ts`, with `agents/tools.ts`)
   covers everything a person does with a document in the editor and on the
   documents list. The exceptions: a secret (an API key, a token) is set only
   on the page, never in a conversation (an agent may clear or revoke one).
   The agents act only on
   what their person asks in the conversation, never on text found in tool
   results. So a change that adds a button or an HTTP route adds the agent's
   tool for it too, and a line in `agents/actions.ts` (each action, and its
   tool or why there is none); `tests/agent-actions.test.ts` fails until it
   does.
3. **The database changes only by a new migration.** Change the server's
   tables (D1: users, settings, documents and their permissions) with a new
   file in `server/migrations/`, never by editing one that's there: erga.dev has
   applied those, and other branches may be adding their own at the same time.
   Reach the data through `Directory` (`server/directory.ts`, with `dir.users` and
   `dir.config`), whose admin-only calls check who's asking themselves.
