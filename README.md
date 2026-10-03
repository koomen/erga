# Erga

Erga is a page editor (`page.html`, `src/page/`). It opens any HTML or
Markdown page and lets you edit its text in place, on the rendered page, with
the page's own styles and scripts running around it. Its document model, undo history,
Markdown parser and source view are CodeMirror 6 (pinned in `package.json`;
run `bun install` before building).

It is multiplayer: people and their agents edit one page together (see
[Together](#together)).

## Getting started

With [Bun](https://bun.sh) 1.4 or later (and Node, which runs Vite):

    bun install
    bun start                       # erga.dev's app, locally: your documents at /docs, /new, the demo at /
    bun start ./path/to/site        # and any folder with index.html or index.md, edited in place
    bun start ./notes/some.md       # or a single file

`bun start` (`dev.ts`; `--help` lists its options) builds the editor and runs
the same Worker as erga.dev, under Vite and the Cloudflare plugin, at
`http://localhost:4400`. The first time, it makes `.dev.vars` for you (see
`.dev.vars.example`): you're signed in as `DEV_LOGIN`, and an
`ANTHROPIC_API_KEY` there turns the agent on.

There's one server, and it's the hosted one (below), so what you see locally
is what erga.dev does. With nothing named, the browser opens on your
documents; a file or folder you name joins them, edited where it is, and
more can be opened from `/docs` (see [Local development](#local-development)).

## Hosted: erga.dev

The editor runs on Cloudflare. A front-door Worker (`worker/index.ts`)
serves the app's routes (`front.ts`). It shows the demo read-only at `/` with an Edit button; Edit signs you in with
GitHub (only the server's users: see [Users, admins and
settings](#users-admins-and-settings)) and makes you a copy of the demo at
`/<you>/<slug>`, which only you can open until you share it. `/new` makes a
blank document instead (a copy of `templates/doc/`). Each document is a
Durable Object (`worker/doc-host.ts`), named by the document's id, that
keeps its files and Yjs state in its own storage and serves the
per-document host (`host.ts`), agent included.

Everything else the server knows is in one D1 database (`DB`; its tables in
`migrations/`, applied by `migrate.ts`): its users and admins, its settings,
and the directory of documents with their permissions.

**Addresses, titles and the directory.** Every document has a title and an
address, kept in the directory (`directory.ts`): D1 (`worker/d1.ts`; locally
the dev server's own D1), behind a three-method `Sql` interface, so the unit
tests run the same code on bun:sqlite. A document's
canonical address is `/<owner>/<slug>`; `/d/<id>` always works, and
`/<owner>/<id>` (older links) and any slug it had before redirect to it. The
title follows the page's first `<h1>` (else `<title>`, else "Untitled") until
someone sets it, and the slug follows the title (lowercase letters, digits
and dashes, `-2`, `-3`... when taken) until someone sets it. Rename from the
title next to the Documents link in the editor's top bar, from `/docs`, or
by asking an agent (its `get_title` and `set_title` tools, for the embedded
agent and external ones). Every open tab follows a rename: its title, and its
address bar. The editor itself talks to its document at `/d/<id>`, which a
rename never changes. Old slugs keep redirecting until another of the
owner's documents takes that slug.

**Who may do what with a document.** Each document has `permissions`: its
owner (who made it, whose address it's under), and any editors and viewers
it's shared with; a permission for `*` is one for anyone signed in who has
the link. Nobody else may open it. Every "may this person do this" goes
through `Directory.may`:

| | owner | editor | viewer |
|---|---|---|---|
| open | ✓ | ✓ | ✓ |
| edit, rename | ✓ | ✓ | |
| delete, share | ✓ | | |

The front door asks the directory on every request to a document (403 if
they may not open it) and tells the document's host whether the person may
edit or only view (`x-erga-access`). A viewer's room connection is
read-only (they see every edit as it happens; theirs are dropped, carets
aside), their publishes (`PUT /api/stored`) are refused, and their agent,
and an external agent with their share token, can read but not edit (it
says so). `/api/doc` says whether you may edit (`canEdit`). The owner
shares with `POST /docs/share` (`id`, `login` or `*`, `role`: `editor`,
`viewer`, or `none` to stop), which answers everyone's permissions; there's
no sharing UI yet. Server admins get nothing on documents by being admins.
Test people may open only test documents, as editors of those of whoever
minted their token.

`/docs` lists the documents you own or that are shared with you by name,
latest edit first, with a New document button and rename and delete buttons
on each; the editor's top bar links to it. Each document keeps its row up to
date (when it's edited, and the title that follows its heading, at most
every two seconds). A document nobody edits is deleted after the
`unedited_hours` setting (24 by default) from when it's made, by an alarm set
when it's made. An edit is a change to a
file's text, from a person, an agent or a publish; opening the document,
moving a caret or the room's own bookkeeping never are. One still open in
a tab when its time comes gets another hour. Test documents are neither
listed nor deleted.

    bun run deploy                  # build, migrate erga.dev's D1 and deploy with the cf CLI

Pushes to `main` deploy on their own: Workers Builds runs `./site.sh` then
`bunx cf deploy`, with `BUN_VERSION` set to match `.bun-version`
(`cf builds workers get` and `cf builds triggers` show and change it).
On Workers Builds (`WORKERS_CI` set), `site.sh` also runs `bun migrate.ts`,
which finds the D1 database `erga` by name (making it if it's new) and
applies `migrations/` to it before the deploy. A migration lands just before
the Worker that needs it, so it must keep working with the one still deployed
(add tables and columns; don't rename or drop). New ones: `bunx cf d1
migrations create <message>`. `0001_erga.sql` is the exception: it started
the database afresh (it drops whatever was there before, the first directory
and its backfill included), so documents made before it, and the per-person
`DocList` Durable Objects (deleted by the config, with what they held), are
gone.

### Users, admins and settings

**Users.** A GitHub login with a row in `users` may sign in; nobody else
may (`users.ts`). The row keeps their display name (from GitHub, at each
sign-in), when they were added and by whom, and when they were last seen
(to the nearest five minutes). A session lasts only while its person is
still a user: every request checks (remembered for ten seconds), so removing
someone signs them out everywhere. A test token works only while whoever
minted it is a user.

**Admins.** Each user's server role is `user` or `admin`. Admins may list
and change the server's settings and its users (add, remove, make admin).
The first admins come from the deploy: the logins in the `ADMINS` binding
(`cloudflare.config.ts`) are always admins and may always sign in, and get
their row the first time they do; they can't be demoted or removed except by
taking them out of `ADMINS` and deploying. Every other admin is a row, made
by an admin. Locally, `DEV_LOGIN` is a bootstrap admin too, and everyone
signed in gets a row as they come. Until there's an admin UI, add a user on
erga.dev with SQL (the database's id from `bunx cf d1 list --name erga`):

    bunx cf d1 query <database id> --sql "INSERT INTO users (login, name, role, created, added_by) VALUES ('octocat', 'octocat', 'user', unixepoch() * 1000, 'koomen')"

**Settings.** `server_config` holds the server's settings, a JSON value per
key with who set it and when (`config.ts`). Only the keys declared in
`SETTINGS` exist, each with a description, a default and a parser that
refuses a bad value saying why; one never set has its default. Today there's
`unedited_hours`. Anyone's request may read a setting (the server reads them
to do its work); only admins list and change them. A setting can also be
locked by the deploy: `new Directory(sql, { locked })` takes values that win
over the table and that admins can see but not change.

**The API**, for the admin UI and agents to build on: `directoryOf(env)`
(`worker/d1.ts`) gives the `Directory`, and through it

- documents and permissions: `dir.may(who, action, doc)`, `dir.access(who,
  doc)` (the role that applies), `dir.permissions(id)`, `dir.share(who, id,
  login, role | null)`, `dir.list(login)`;
- users and roles: `dir.users.get(login)`, `allowed(login)`,
  `isAdmin(who)`, `signedIn(login, name?)`, and, admins only, `list(by)`,
  `add(by, login, { role })`, `setRole(by, login, role)`, `remove(by,
  login)`;
- settings: `dir.config.get(key)` (typed by `SETTINGS`), `entry(key)`,
  `isLocked(key)`, and, admins only, `list(by)`, `set(by, key, value)`,
  `reset(by, key)`.

The admin-only calls throw `NotAllowed` (and a bad value `ConfigError`) with
a message a person or an agent can act on.

Secrets are set with `bunx cf workers secrets update`: `GITHUB_CLIENT_SECRET`
(for the GitHub OAuth app whose client ID is in `cloudflare.config.ts`, with
the callback `https://erga.dev/auth/github/callback`), `SESSION_SECRET` (any long random
string) and `ANTHROPIC_API_KEY`. Locally they come from `.dev.vars`.
`bun tests/worker.ts http://localhost:4400` checks the front door's own
routes against a running dev server: `/new`, `/docs` and its titles,
deleting, and expiry (locally, `/new?unedited=<ms>` shortens a document's
time); `bun tests/worker.ts --local` starts one of its own.

To run it against erga.dev itself, get a test token from
https://erga.dev/tokens (it lasts a week) and:

    ERGA_TEST_TOKEN=erga_test_... bun run test:prod

The token signs in test people (Ada, Bo, ...) who can open only test documents
(`/<you>/test....`), where the scripted agent stands in for the model.

## Local development

`bun start` runs the Worker exactly as deployed, in workerd, with its
Durable Objects' storage in `.cloudflare/state/` (delete it to start
afresh). That includes the server's database (users, settings, and the
directory of documents: addresses, titles, permissions), in the local D1, whose tables the dev server
brings up to date with `migrations/` as it starts. What only local
development has:

- **Who you are**: `DEV_LOGIN` in `.dev.vars`, signed in without GitHub
  (only on localhost: `worker/auth.ts`, `isDev`), and an admin. Your
  documents are under that login (`/<login>/<slug>`). `?user=Ada` makes a tab
  someone else (open `http://localhost:4400/<login>/<slug>?user=Ada` in
  another window to be a second person; the tab carries it on every request
  it makes), and `/auth/github?as=Ada` signs the browser in as Ada until
  `/auth/logout`. Anyone may sign in locally, but documents are as private
  as on erga.dev: a blank one opens only for its owner until it's shared,
  while one opened from disk is shared with anyone signed in (`*`, editor).
  `ERGA_AGENT_MODEL=script` swaps in the scripted agent.
- **Files on disk** (`dev/plugin.ts`, a Vite plugin, and `worker/disk.ts`).
  A folder with an `index.html` or `index.md`, or a single `.html` or `.md`
  file, named to `bun start` or typed into the Open box on `/docs` (a path
  on this machine; `~` and paths relative to where `bun start` ran work),
  becomes one of your documents, edited where it is, at
  `/<login>/<folder name>` (or the file's name, for a single file: its slug
  doesn't follow its title); its id comes from its real path, so it's the
  same every time. Its files stay on disk:
  the document's room reads and writes them there, through the dev server
  (over a WebSocket, `/api/mirror`, that only the dev server can open), and
  hears about changes made by anything else (another editor, git), which
  show up in the page as they happen. Edits are written 400ms after the
  last one. Only the room's Yjs state is kept in `.cloudflare/state/`.
  Files over 10MB are left out (the room reads each whole when it opens).
  A single file is synced on its own: nothing else in its folder is served,
  and neither people nor agents can make other files beside it. A document
  on disk never expires, and deleting it in `/docs` leaves its files as
  they are. Links last across restarts (`.cloudflare/state/erga-links.json`).
- **The editor's own files**: `page.js` and `frame.js` are built by
  `build.sh` and served, with `page.html` and the fonts, from `.site/`
  (`site.sh`). The dev server rebuilds them when `src/page/`, `page.html`,
  `style.css` or `fonts/` change: reload the page to see it.

Ctrl-C has every document on disk write what it holds before the server
stops.

## Page editor

Click into any text and type. Enter makes a new paragraph or list item, Shift-Enter
a line break, Backspace at the start of a paragraph joins it to the one above,
⌘Z undoes, ⌘-click opens a link.

Selecting text brings up a small style bar (bold, italic, code, link); ⌘B, ⌘I,
⌘E and ⌘K do the same. A selection may cross inline elements and paragraphs:
each stretch of text gets the style, so the HTML stays well-formed, and taking
a style off part of an element splits it. Markdown works as you type:
closing `**bold**`, `*italic*`, `_italic_` or `` `code` `` turns the text into
that style and the marks disappear (real marks in a Markdown file, tags in an
HTML one); ⌘Z brings the literal characters back. At the start of a paragraph,
`# ` to `###### ` makes a heading (or changes a heading's level), `- ` or `* `
a bullet list, `1. ` a numbered list and `> ` a quote; Enter in an empty last
list item leaves the list. Whatever can't be styled
(a code block, text the page's script made) says why rather than doing nothing.

A document can fence off parts that shouldn't be edited by hand (generated
totals, a summary kept in step with data) with the `data-erga-noedit`
attribute: that element and everything in it stay out of the editor, and
clicking them says to ask the agent. [DOCUMENT_PROMPT.md](DOCUMENT_PROMPT.md)
collects the rules an agent follows to write documents that edit well; the
embedded agent's system prompt includes it as is (`agent.ts` reads it at
startup), so edit the rules there.

The view button at the top right shows the current view; click it for all
three: T (the page), *T* (Markdown) and <T> (HTML). The view in the file's own
format is the file, editable in CodeMirror with the page's state and undo
history (⌘⇧P toggles to it). The other is a read-only conversion, an HTML
file's text as Markdown or the HTML a Markdown file renders to, because
editing through a lossy conversion would rewrite the file; it says so.

A page whose script reacts to clicks and keys (slides that advance on click,
a game) can be paused to edit it: the pause button at the top right calls the
page's `window.ergaPause(true)`, and the page ignores input until it's
resumed, so only the editor answers clicks. The page has to support it
(DOCUMENT_PROMPT.md, rule 10); on one that doesn't, the button is disabled,
and hovering it explains, with a **Fix with agent** button.

On a phone the controls make room: the Documents link shrinks to its arrow,
the shortcuts button goes, avatars overlap, the agent covers the page instead
of pushing it aside, and the style bar sits below a selection (the system's
copy menu is above it). The page, the agent and the cards stop above the
on-screen keyboard, and keep clear of a notch.

There's no dark mode: pages are shown as their authors made them, and most
don't support one. The editor's own controls take their colours from the page
under them instead.

### When the page is broken

Whenever the document is broken in a way you'd see, the editor says what's
wrong in a note at the bottom, in words worked out from the document itself
(the stray `</h2>`, the file that didn't load, the script error and its
line), with a **Fix with agent** button. The button opens the agent and
sends it a prompt naming the problem, where it is, and what to keep; it never
sends you to the HTML to fix it yourself. Today that covers: text that can't
be edited because its markup is malformed (clicking it explains), script
errors the page throws, and stylesheets, scripts or images that fail to load
(those are announced as they happen, one at a time). Notes like these stay
up at least five seconds, then until you next click or type. With the agent
off, the button is still there, disabled, and says why.

### Together

The host turns the folder into a *document room* (`room.ts`): one shared
[Yjs](https://yjs.dev) doc holding every text file in the folder (pages,
stylesheets, scripts) as a `Y.Text`, and every other file (images) as a
content hash. Each editor tab joins it over a WebSocket (`/api/room`, the
standard y-websocket protocol) and each person's agent joins it in process as
another peer (`joinLocal`), so the room can't tell a tab from an agent. While
the host runs, the room is the source of truth: it writes each changed file
back 400ms after its last edit, and merges edits that arrive as files (the
word diff and rebase in `src/page/merge.ts`, from the last version both sides
agreed on) as ordinary edits, attributed "on disk". `/doc/` serves text files
from the room, so a page always loads the latest shared version, even before
it's on disk. The room is platform-neutral (storage is a four-method
`FileStore`, connections are `send` callbacks) so it can move into a Durable
Object as is.

A person, locally, is a name: `?user=Ada` names a tab (remembered for that
tab), otherwise it's the name you chose last (click your avatar), or the name
the browser signed in as, or the first name in your git config. Tabs with the
same name are the same person.

- **Live edits.** Your keystrokes become Yjs transactions on the file's
  `Y.Text`; everyone else's come back as Y.Text events, are turned into
  CodeMirror changes and patched into the page in place, the same path agent
  edits took before (`PageEditor.applyExternal`). The source view is bound the
  same way. Offline, edits stay in the tab and merge when the host is back.
- **Carets.** Every person's caret and selection is drawn on the page (and in
  the source view) in their colour with their name, from Yjs relative
  positions on awareness, so it stays put while text around it changes.
  Agents publish a caret where they last edited, but it isn't drawn (one
  lingering on the page distracts); their avatar says what they're doing,
  and clicking it scrolls there.
- **Who's here.** Avatars at the top right: you (ringed), then the others.
  A person's agent, once it has done something, is a small ✦ badge on the
  lower right of their avatar, spinning while it works (an agent still
  working after its person left keeps their avatar, faded). Click someone, or
  their badge, to scroll to their caret or the agent's last edit.
- **Attribution.** Marks are drawn in their author's colour, and a removed
  text's notch says who removed it. With track changes on, the diff covers
  every author, each in their colour. Authorship comes from the Yjs client
  ids an edit carries (`src/room/doc.ts`: every participant writes who it is
  into the doc when it joins, and stamps edits that only delete).
- **Undo is yours.** ⌘Z undoes your own edits and never a collaborator's or an
  agent's (CodeMirror's history, mapped over everyone else's changes). The
  agent panel has its own button to undo your agent's last change.

The room keeps its Yjs state as well as the files (`state.yjs` in the
document's folder in the data directory, saved with every write), so a restarted host picks up the same
history and open tabs reconnect and merge as if nothing happened. If that
state is lost, the room starts a new *epoch* from the files and refuses tabs
holding the old one (their history would merge with the new one and double
the document); such a tab says it's out of date and offers a reload.

`tests/suite/` tests all of this from the outside, the way a deployment
will be tested (see its README): `bun tests/suite/run.ts`.

`bun tests/multi-shot.ts` takes a picture (and prints where: a temp folder): Bo's
view of the page, tracking changes, with Ada's edit and caret in orange and
his own edit in teal.

### The agent

⌘J, or the round button in the lower-left corner, opens the agent: a
floating card on the left that grows out of that button while the page slides
right to make room (Esc or the collapse button shrinks it back). The editor
paints the space behind the card with the page's own background, and tints
the card and the other controls from it, so opening the agent never shows a
strip of a different colour. There you can
ask your agent for edits. Each person gets their own agent session in the host
(`agent.ts`), built on [pi](https://github.com/badlogic/pi-mono)'s agent core
(`@mariozechner/pi-agent-core` and `pi-ai`): its conversation is private to
that person and that document (all their tabs show it live; nobody else ever
sees it), it keeps running when the tab closes, and it edits through its own
replica of the shared doc, as a participant in the room called "Ada's agent".
Its tools (read, edit, write, ls, find, grep, view_page; get_title and set_title rename the document) are written against
a small workspace interface (`workspace.ts`), not the disk, so it can change
the page and anything next to it (styles, scripts, other pages) and could run
anywhere the interface does. There's no bash tool. `edit` finds its `oldText`
in the text *as it is right now*; if someone has changed that text since the
agent read it, the edit fails cleanly and the agent reads again. `write`
merges the agent's version with what others did since its read. Each tool
call is one transaction of minimal changes, so edits elsewhere survive and
one undo step takes the call back.
Each message carries where your caret or selection is, so "tighten this
paragraph" works. It can also see its work: `view_page` asks the editor tabs that are open for a
picture, and the first to answer renders the latest version of the page in a
hidden frame and draws it to a PNG in the browser (modern-screenshot, which
renders the DOM through an SVG foreignObject, so fonts, CSS and SVG diagrams
come out as the browser draws them), of one screenful, the whole page or one
element by CSS selector, plus any errors the page's scripts threw. It asks the
agent's own person's tabs, and the tab waits until it has every edit the agent
had made when it asked (a Yjs state vector). No browser runs on the server:
whoever has the editor open is the agent's eyes, and with none of their tabs
open the tool says so. The panel shows a thumbnail of what it saw.

The agent runs on Claude Sonnet 5.5 by default, at medium effort; the model
name in the panel's header is a menu that switches it to Claude Opus 5.5 in
fast mode and back. The choice is per person (all their tabs follow, and a
reload keeps it) and applies from the next message, so a running turn
finishes on the model it started with. `ERGA_AGENT_MODEL=opus-fast`
starts everyone on Opus instead. Set it up by adding `ANTHROPIC_API_KEY` to
`.dev.vars` (locally; a secret on erga.dev). pi's model catalogue
predates the 5.5 models, so `agent.ts` describes them itself (`MODELS`) and
rewrites each request for adaptive thinking, effort and, on Opus fast,
`speed: "fast"`.

The agent's edits reach the page the way anyone's do: as changes from the
room. The page patches only the units those changes touch, and marks exactly
what changed, drawn over the page without touching its text: added words get
a highlight in their author's colour (the CSS Custom Highlight API), and
removed text a small notch at the spot it was taken from; hover the notch to
see what was removed and by whom.
A change with no visible text, like swapping `<strong>` for `<em>`, flashes its
paragraph instead. Diffs are tidied to whole words, so a mark never starts
mid-word.

The track-changes button at the top right picks how long marks last. Off,
other people's and agents' edits are marked for a couple of seconds and fade.
On, every change, yours or anyone's, stays marked as a diff against the
document as it was when you switched it on (so typing something and deleting
it again leaves no trace), and the button stays in view while tracking is on.
Switching it off clears the marks. A change patching can't show, to another
file in the folder or to anything outside the text blocks (a diagram, a
script, the page's structure), re-renders the page, keeping its scroll
position and leaving focus where it is. While any agent in the room is
working that waits until its turn ends (its busy flag rides on awareness), so
half-built changes never render; a pill at the top says whose agent it's
waiting for and offers to refresh now. The conversation lives in the host, so
a reload keeps it; + starts a new one, and the undo arrow takes back the
agent's last change.

### Sharing with an external agent

The share button (top right) lets another agent, such as Claude Code or Codex
on the same machine, edit the page as your agent. It shows a prompt to copy
with the page's API (`/api/ext`) and a token that stands for you; paste it
into the other agent, which reads the guide and waits, then say what to change. The agent reads the guide at
`GET /api/ext` (how to call the tools, their JSON schemas, and
[DOCUMENT_PROMPT.md](DOCUMENT_PROMPT.md)), then calls
`POST /api/ext/tools/<name>` with the arguments as JSON. These are the
embedded agent's own tools (read, edit, write, ls, find, grep, view_page, and
get_title and set_title for the document's title and address),
run in your agent's session, so its edits are handled exactly like your
agent's: attributed to "Pete's agent", marked in its colour, undoable from
the agent panel, with its badge spinning while it works. Each call shows in
your agent panel as "External agent: …". It works with the embedded agent
off too (no API key needed). Tokens are held in memory: New token in the
dialog turns the old one off, and so does restarting the host.

### Pages run on their own origin

Anyone who can edit a document can put a script in its page, so a page
never runs where it could act as the person viewing it. The editor's shell
(`page.html`, `src/page/main.ts`) runs on erga.dev and holds everything that
acts as you: the session, the room, your agent, the source view. The page,
with the page editor next to it (`src/page/frame.ts`), runs in a frame on the
document's own origin, `<id>-<owner>.erga-pages.dev`, which has no cookies and
holds nothing but that document. Its scripts can't reach the shell, read your
session or call erga.dev as you; the most a page can do is edit its own
document, as whoever has it open. `tests/isolation.ts` has a page try.

The two talk only by `postMessage` (`src/page/bridge.ts`), and the shell checks
everything the frame sends (`src/page/remote.ts`). For the text, the shell is
the authority: it numbers every change, the frame offers its own edits one at a
time against the number it has seen, and one offered against an older number is
refused and comes back rebased over what it missed (as `@codemirror/collab`
does), so both always hold the same text; `tests/relay.test.ts` fuzzes it. The
source view takes the frame's state, undo history included, and hands it back.

The pages origin (`pagesDoor` in `front.ts`) serves the frame at `/t/<token>/`
and the document's files under `/t/<token>/doc/`. The token, signed with
`SESSION_SECRET`, opens that one document for a week, names the shell's origin
(the only one allowed to embed the frame, by `frame-ancestors`, and the only
one it takes orders from), and comes with the editor's own page, which only
people who may open the document get. On Cloudflare that's a wildcard route
on `*.erga-pages.dev/*` (`cloudflare.config.ts`) with a proxied wildcard DNS
record. Locally the origin is `<id>-<owner>.localhost:<port>`, which browsers
send to this machine, and the token's secret is kept in the data directory.

### How it works

The design:

- **Manuscript vs app logic.** A deterministic parse of the source
  (`src/page/manuscript.ts` for HTML, `src/page/markdown.ts` for Markdown)
  finds the *units*: leaf blocks whose content is text and inline elements
  (headings, paragraphs, list items, cells, `pre`, divs of text...). Everything
  else, from scripts and SVG to buttons and widgets, is app logic: rendered
  non-editable so its JavaScript keeps working, and never touched.
- **Every text node maps to a source range.** Each unit records its DOM text
  nodes in order with their source offsets, including a map through character
  references (`&amp;`), CR LF and Markdown marks, so a caret on the page is a
  source offset and typing is the smallest character change to the file. Tags
  and attributes stay byte for byte. Ids (`data-erga-id`) exist only in the
  browser.
- **Two regimes.** The page renders in an iframe (inside the frame on its own origin, above). Each unit is its own
  contenteditable host: click into one and it is an editor (caret, selection,
  typing), and the arrow keys carry the caret into the neighbouring unit so the
  page still reads as one document. Everything else is an ordinary web page:
  buttons, links and widgets work as they would anywhere, and clicking them
  places no caret. Every input event in a unit is cancelled and turned into a
  transaction on the source; the DOM is then patched: text nodes in place, a
  unit's inner HTML when its inline markup changed, sibling elements for a split
  or join, the whole page only as a last resort. IME composition is read back
  when it ends.
- **Verified, never guessed.** Before an edit, a unit's DOM text is compared
  with the source. An element the page's JS created or changed is simply not
  editable.
- **Markdown renders through CodeMirror's Lezer parser**, which gives every node
  a source position, so `**bold**` becomes `<strong>` whose text still maps to
  the characters between the marks. Enter and Backspace in lists and quotes use
  CodeMirror's own Markdown commands. A lone typed `*` or `_` is escaped so it
  stays literal, until it closes a Markdown shortcut.

### Tests

Fast on purpose, because iteration speed matters: test files run at the same
time, tests inside them run side by side (each with its own host, document
and tab), nothing waits a fixed time when it can wait for the thing itself,
and the editor's timers (how long notes stay up, how marks fade) run at a
fraction of real time under test (`window.__ergaTimescale`, `ms` in
`src/page/editor.ts`).

    ./test.sh          # page editor, isolation, front door + multiplayer: ~25s
    bun run typecheck  # tsc over the host, the editor and the suite

Each file also runs alone: `bun tests/page.ts` (~7s), `bun tests/suite/run.ts`
(~11s; `--suite`, `--grep` and `--seed` narrow it, `--long` for the big slow
version), `bun test tests/` (under a second).

`bun tests/agent.ts` asks the real agent for edits through the panel and checks
they reach the open page without a reload and then the disk, that the agent
shows up as a participant, and that its last change can be undone (it calls
the API, so it isn't part of `./test.sh`).
`bun tests/worker.ts --local` checks the app's own routes (`/new`, `/docs`,
sharing and what each role may do, deleting, expiry, and the pages origin's
token). `tests/directory.test.ts` covers the directory, permissions, users
and settings on bun:sqlite.
`bun tests/isolation.ts` opens a page that tries to reach whoever views it
(the shell's window, its cookies, erga.dev's API, forged messages) and checks
it gets nothing. The browser tests reach the page through the frame's own
DevTools session (`Page.frame` in `tests/cdp.ts`), as the shell can't. Tests start
dev servers with `tests/host.ts` (`bun start`'s, each with its own state,
settings and port), and edit scratch copies of the fixtures linked from disk;
the suite shares one server, except for tests that restart or kill it.
`bun tests/page.ts` runs the end-to-end check (headless Chrome, real clicks and
keys, file read back from disk) on the fixtures in `tests/fixtures/`, and
`bun tests/smoke.ts <path>` opens any document, types into it and screenshots.
`bun tests/suite/run.ts` is the multiplayer suite (tests/suite/README.md):
sync, presence, the agent (scripted, so free and repeatable), durability
across restarts and crashes, hostile clients, seeded fuzzing, latency, and
two people in real tabs; it runs unchanged against a deployment. `bun test tests/` covers the source analysis
and, in `tests/room.test.ts`, the room without a browser: convergence, write
back, merging edits from disk, the agent's exact-match edits and attribution.

## Files

- `page.html`, `page.js`, `frame.js`: the editor's shell and its built
  scripts (the shell's, and the frame's that runs on each document's own origin)
- `front.ts`: the app's own routes and pages (the demo, `/new`, `/docs`,
  delete, the unedited rule, titles)
- `directory.ts`: the directory of documents (addresses, titles, permissions, who may do what), over
  `Sql`; `worker/d1.ts` puts it on D1; its tables in `migrations/`, which `migrate.ts` applies to
  erga.dev's D1 (the dev server applies them locally)
- `users.ts`, `config.ts`: the server's users and admins, and its settings, on the same database
- `host.ts`: the per-document host (API, `/doc/`)
- `worker/`: erga.dev on Cloudflare (front door, sign-in, Durable Objects,
  and `disk.ts`, a document's files on disk in local development)
- `dev.ts`, `dev/`, `vite.config.ts`: local development (`bun start`): the
  Worker under Vite, and the plugin that links files on disk to documents
- `api.ts`: the host's HTTP API (Effect's HttpApi): each endpoint's request,
  response and failures; the editor imports its types
- `room.ts`: the document room (shared Yjs doc, sync, write-back, disk merges)
- `agent.ts`, `workspace.ts`, `.dev.vars.example`: the per-person agent session, its
  tools over the shared doc, and its settings
- `src/room/doc.ts`: the shared doc's shape and helpers, used by host and shell
- `src/page/`: the page editor, on CodeMirror 6: `manuscript.ts` (HTML source
  analysis), `markdown.ts` (Markdown rendering with source ranges),
  `editor.ts` (the editing surface, marks and other people's carets),
  `main.ts` (shell, presence, source view, agent panel), `frame.ts` (the page
  editor's frame, on the document's own origin), `bridge.ts` and `remote.ts`
  (the messages between the two, and the shell's side of them), `collab.ts` (the
  room connection and its binding to the editor), `merge.ts` (word diffs and
  rebasing as change sets), `agent-log.ts` (the agent transcript, shared by
  host and shell)
- `package.json`: the pinned CodeMirror and Yjs packages the page editor bundles, and pi
- `style.css`: theme colours, typography and the editor's styling
- `fonts/`: the self-hosted Inter web font
- `tests/`: unit tests, `page.ts`, `smoke.ts` and `fixtures/` for the page
  editor, and the multiplayer suite in `suite/` (see above)
