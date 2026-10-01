# The multiplayer suite

Black-box tests of a document room, its participants and their agents. They
reach the server only through its public surface (the contract below), so
the same run works against the local host today and against the Cloudflare
deployment once there is one:

    bun tests/suite/run.ts                    # local: spawns open.ts per test
    bun tests/suite/run.ts --long             # bigger crowds, longer fuzzing, real 75s idle waits
    bun tests/suite/run.ts --repeat 10        # ten runs, ten seeds
    bun tests/suite/run.ts --suite fuzz --seed 4711     # replay one randomised run
    bun tests/suite/run.ts --grep restart     # tests whose name matches

    SCRATCHWORK_TARGET_DOC=https://edit.example.com/p/sw-test/doc \
    SCRATCHWORK_TARGET_USERS='{"Ada":{"Cookie":"..."},"Bo":{"Cookie":"..."}, ...}' \
    SCRATCHWORK_TARGET_CAPS=browser,scriptedAgent \
    bun tests/suite/run.ts --remote           # a deployment

A failing randomised test prints its seed and the command that replays it.
`--json out.json` writes the results, metrics included, for a dashboard or CI.

## What it checks

| suite | what |
|---|---|
| sync | joining, live edits both ways, new files, what's served (the room's latest) and what's stored (written back, then idle), publishes merged with live edits, stale publishes refused (412), publishes racing the room's own writes, disk edits, images |
| presence | carets reach others and stay on their word as text moves, people who leave politely or drop disappear, every edit attributed (insertions, pure deletions, publishes), thirty people at once |
| agent | (scripted model) its edits reach others attributed to it and are stored, busy/activity/caret on awareness, stale aim fails cleanly, `write` keeps edits made after its read, undo exactly its last change, private transcripts, runs with no tab open, `view_page` with no tab, two agents at once, a person typing where the agent edits |
| durability | everyone leaving, idle eviction (same epoch after), graceful restart mid-write, a tab editing through a restart, a killed server, a room that lost its saved history refusing old tabs, a foreign replica refused |
| robustness | random bytes, truncated/corrupt/unknown Yjs messages, a storm of 80 connections and ten ghosts, a 1MB paste, path traversal on every file endpoint, bad requests to the agent |
| fuzz | seeded random edits from several hands with offline spells and (sometimes stale) publishes: everyone converges, storage and the served page match, a newcomer matches, and no token inserted is lost, duplicated or resurrected; arbitrary edits with unicode; newcomers mid-burst |
| latency | edit propagation p50/p95/max, the slowest of twenty, join time, five people typing for ten seconds with no lag building up (budgets: 60ms locally, 400ms remote, or `SCRATCHWORK_SUITE_P95_MS`) |
| browser | real tabs in headless Chrome: typing on the page, carets and coloured marks, interleaved typing, ⌘Z only your own, the source view, a headless participant's edit on the page, the agent panel per person and `view_page` through the owner's tab, a tab riding out a restart, a refused tab offering a reload |

Every test gets a fresh document. Capabilities a target lacks skip the tests
that need them, and say so: `restart`, `kill`, `disk` (local only),
`scriptedAgent`, `liveAgent`, `browser`, `roles` (view-only access; the
test for it is waiting on a deployment that has roles).

### The suite catches what it should

Each of these deliberate breakages was run against the suite and caught:

| broken on purpose | caught by |
|---|---|
| the room merges any replica, ignoring epochs | durability: lost history, foreign replica |
| no saved Yjs state (a restart rebuilds from files) | durability: tab through restart, killed server; browser: tab rides out a restart (the document doubles) |
| the agent's `write` diffs against the current text | agent: write keeps edits made after its read |
| writes and merges not queued | sync: publishes landing as the room writes (every run); fuzz (sometimes) |
| pure deletions not stamped | presence: every edit attributed |
| malformed messages throw | robustness: corrupt Yjs messages |
| `If-Match` ignored | fuzz: deleted tokens come back |

Rerun this when the server changes shape (especially when moving to
Durable Objects): break each piece and see the suite go red.

## The contract

Everything is relative to a document's base URL (`http://127.0.0.1:4400`
locally; whatever the hosted server gives a document).

- `GET /` the shell. `GET /api/doc` → `{ name, path, kind }`.
- `WS /api/room/<name>?user=…&epoch=…` the room, in y-websocket's protocol
  (message 0 sync, 1 awareness, 3 query awareness). The doc's shape is in
  `src/room/doc.ts`: `files` (path → Y.Text), `assets` (path → hash),
  `authors` (client id → who), `room.epoch`. A replica naming another epoch
  is refused with close code 4409; a malformed message closes the socket with
  4400 and changes nothing.
- `GET /doc/<path>` the room's latest text for text files, storage for the rest.
- `GET /api/stored/<path>` what storage holds, with an `ETag`.
  `PUT /api/stored/<path>` an edit arriving as a file (a publish), with
  optional `If-Match`: 200 `{ ok, etag }`, 412 stale, 415 binary, 400 bad
  path. Hosted, behind the project's write role.
- `GET /api/agent?user=` → `{ enabled, model, log }`; `POST /api/agent`
  `{ text, context?, after? }`; `POST /api/agent/{abort,reset,undo}`;
  `GET /api/events?user=` (a WebSocket) the person's events as JSON
  messages (agent events, view requests); `POST /api/agent/view` a tab's answer to one.
- `POST /api/share?user=` `{ rotate? }` → `{ token }`, the person's token for
  an external agent; with `Authorization: Bearer <token>`, `GET /api/ext`
  the guide (Markdown), `GET /api/ext/tools` the tools as JSON Schema, and
  `POST /api/ext/tools/<name>` a tool call with its arguments as JSON →
  `{ ok, content }` or `{ ok: false, error }` (400, 401, 404).
- Locally a person is `?user=Name`; hosted, it's their session (and
  `SCRATCHWORK_TARGET_USERS` gives the suite one signed-in account per test
  person).

## Running it against production

- Point it at a **scratch document** whose URL contains `test`: the suite
  rewrites it for every test (`RemoteTarget` refuses anything else).
- The scripted agent model (`SCRATCHWORK_AGENT_MODEL=script`) is for staging
  only: never let real users reach a server running it. On production, leave
  `scriptedAgent` out of the capabilities (the agent tests skip) and add
  `liveAgent` for a smoke test with the real model if wanted.
- Run `--long` at least once per deploy: it waits out Durable Object eviction
  and fuzzes with more hands for longer.
- The latency budgets are a starting point; set `SCRATCHWORK_SUITE_P95_MS`
  to what production should meet, and watch the `--json` metrics over time.
