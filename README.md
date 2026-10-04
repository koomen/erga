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
    bun start                       # erga.dev's app, locally: your documents at /docs, /new, the front page at /
    bun start ./path/to/site        # and any folder with index.html or index.md, edited in place
    bun start ./notes/some.md       # or a single file
    bun start --reload              # open tabs reload by themselves on every edit (live mode runs this)

`bun start` (`dev.ts`; `--help` lists its options) builds the editor and runs
the same Worker as erga.dev, under Vite and the Cloudflare plugin, at
`http://localhost:4400`. The first time, it makes `.dev.vars` for you (see
`.dev.vars.example`): you're signed in as `DEV_LOGIN`. An `ANTHROPIC_API_KEY`
turns the agent on: exported in the shell that runs `bun start` (and so task
previews and live mode, which inherit the task queue's environment), or in
`.dev.vars`. A real key in `.dev.vars` wins; a placeholder there (empty, short,
not `sk-…`) counts as none, so the exported one is used. It reaches the Worker
as a binding (`dev/agent-key.ts`, `cloudflare.config.ts`), never written to
`.dev.vars`.

There's one server, and it's the hosted one (below), so what you see locally
is what erga.dev does. With nothing named, the browser opens on your
documents; a file or folder you name joins them, edited where it is, and
more can be opened from `/docs` (see [Local development](#local-development)).

## Hosted: erga.dev

The editor runs on Cloudflare. A front-door Worker (`worker/index.ts`)
serves the app's routes (`front.ts`). Its pages:

- **The viewer**, `/<owner>/<slug>`: a document as it renders, read-only,
  with small icons at the top right like the editor's: Clone (a copy of your
  own, in the editor: `/new?from=<id>`) for anyone who may see it, and the
  pencil (Edit) for those who may edit it. In the editor the pencil is blue
  (on): clicking it goes back to the viewer. Beside it, right to left: the
  view (page, Markdown or HTML), share with people (for the owner: who may
  view or edit it, as on Documents), share with an agent, track changes
  and pause. The viewer and the editor are one page (see [One page, viewing or
  editing](#one-page-viewing-or-editing)): the pencil switches
  between them without a reload, and the document doesn't move.
- **The front page**, `/`: the landing document, for anyone, signed in or not,
  served directly from its last deploy, with the viewer's controls on top
  (see [The front page](#the-front-page) and [The homepage, served
  directly](#the-homepage-served-directly)).
- **Documents**, `/docs`: home for anyone signed in, and under it **the
  editor**, `/<owner>/<slug>#edit`, whose breadcrumbs (Documents › its
  title) lead back. A document's address always means the document: `#edit`
  (which never reaches the server) opens it in the editor, on the same page.
- **A document's other pages**, `/<owner>/<slug>/<page>` (`/blog` is
  `blog.html`, else `blog/index.html`), each with its editor at `#edit` after
  it (see [Documents with many pages](#documents-with-many-pages)).
- **Settings**, `/settings`: your agent tokens (`/tokens` redirects there).
- **Admin settings**, `/admin`: the server's settings and users, for admins.
- **Deploy your own**, `/deploy`: anyone signed in, by default (see
  [Deploy your own](#deploy-your-own)).

The user menu in the upper right of every page reaches Documents,
Settings and (for admins) Admin settings. Clone and Edit sign you in with
GitHub first (only the server's users: see [Users, admins and
settings](#users-admins-and-settings)); a copy is yours at `/<you>/<slug>`,
which only you can open until you share it. `/new` makes a blank document
instead (a copy of `templates/doc/`). Each document is a
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
canonical address is `/<owner>/<slug>` (the viewer; its editor is that with
`#edit`); `/d/<id>` always works, and `/<owner>/<id>` (older links) and any
slug it had before redirect to it (pages under them too). There is no `/edit`
route: `/<owner>/<slug>/edit` is a page called edit, if the document has one. The
title follows the page's first `<h1>` (else `<title>`, else "Untitled") until
someone sets it, and the slug follows the title (lowercase letters, digits
and dashes, `-2`, `-3`... when taken) until someone sets it. Rename from the
title after Documents in the editor's breadcrumbs (it opens the document's
pages; the pencil on the first row, the document itself, renames it), or by asking an agent
(its `get_title` and `set_title` tools, for the embedded agent and external
ones). Every open tab follows a rename: its title, and its address bar. The
editor itself talks to its document at `/d/<id>`, which a
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
shares from `/docs`: each of their documents has a Share button, whose
dialog adds people by GitHub login (can edit or can view), changes or
removes them, sets what anyone signed in with the link may do (no access,
view, edit) and copies the link; someone shared with who isn't a user of
the server yet is marked "can't sign in yet". Underneath it's `POST
/docs/share` (`id`, `login` or `*`, `role`: `editor`, `viewer`, or `none` to
stop), which answers everyone's permissions (and `notUsers`), and `GET
/docs/share?id=`, which only reads them. The owner's agent (in the editor,
or with a token) shares too, with `share_document` and `document_access`.
Server admins get nothing on documents by being admins, with one exception:
the front page, which only admins may edit while it's the front page (see
[The homepage, served directly](#the-homepage-served-directly)).
Test people may open only test documents, as editors of those of whoever
minted their token.

`/docs` lists the documents you own or that are shared with you by name,
latest edit first, with a New document button, share, rename and delete
buttons on each of yours (one you've shared says so), and whose each shared
one is and your role on it; each opens in the editor, whose breadcrumbs
lead back. Each document keeps its row up to
date (when it's edited, and the title that follows its heading, at most
every two seconds). A document nobody edits is deleted after the
`delete_docs_after_hours` setting (24 by default) from when it's made, by an
alarm set when it's made. Set to never (`null`), new documents don't expire,
`/docs` doesn't say they will, and one whose alarm comes up after the switch
stays. An edit is a change to a
file's text, from a person, an agent or a publish; opening the document,
moving a caret or the room's own bookkeeping never are. One still open in
a tab when its time comes gets another hour. Test documents are neither
listed nor deleted.

Agents can do all of this too, with an agent token: see [Agent tokens and
the server's API](#agent-tokens-and-the-servers-api) (`/llms.txt`,
`/settings`).

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

**Who you are, on every page.** The upper right of every page erga.dev
serves (`account.ts`) shows your avatar (your GitHub picture, or your
initial on your colour if it doesn't load); clicking it opens a small menu:
your name, Documents, Settings, Admin settings (admins only) and Sign
out. Signed out, it's a person in a circle whose menu has only Sign in (with
GitHub, bringing you back to the same page). The Worker adds it to each of the site's own HTML pages
(`withAccount`, `worker/index.ts`); the editor shows it itself, as your
avatar at the far right of its controls (the front door tells it which links,
`meta name="erga-account"`), and a document's own files and pages origin
never get it.

### The front page

What `/` shows is a document like any other, in the database and its own
Durable Object: the one the `landing_document` setting names (kept by id,
so a rename doesn't lose it). Everyone sees it at `/`, signed in or not,
read-only, with Clone, which makes you a copy (`/new?from=landing`; the
`create_document` tool's `template: "landing"`), and, for those who may edit
it, Edit. Unlike any other document it's served directly, on this site, from
its last deploy, with no frame (see [The homepage, served
directly](#the-homepage-served-directly)); until its first deploy is done,
`/` is the viewer on it, in a frame on its pages origin, as any document's.
An admin who may edit a document makes it the front page, and only if
everyone who may edit it is an admin: from `/admin` (type its address), its
settings (`POST /api/docs/<id>/home`), or by asking an agent
(`set_setting`).

**The server makes it itself.** The repo's `landing/` folder (the demo page:
its `index.html` or `index.md`, and text files beside it) is built into the
Worker (`worker/index.ts`). When something asks for the front page (`/`,
`/new?from=landing`) and `landing_document` is unset, or names a document
that's gone, the server makes a document from those files and sets the
setting to it (`seedLanding`, `front.ts`): there's always a front page, and
it's always a real document, editable like any other. So on a fresh deploy
the first visit to `/` makes it, with nothing to run after the deploy: no
token, no build secret, no change to the deploy command. Its owner is the
first login in `ADMINS` (locally, `DEV_LOGIN`), at `/<them>/landing`; the
other `ADMINS` may edit it too; anyone else sees it at `/`. Requests at once
make one: in one isolate they share the work, and across isolates the setting
is claimed compare-and-set, the loser deleting the document it made.

It's made from the repo only then: after that it's the admins' document, and a
deploy with a changed `landing/` doesn't touch it. To start again from the
repo's `landing/`, reset `landing_document` on `/admin` (or delete the
document): the next visit to `/` makes a fresh copy (at `/<them>/landing-2`
if the old one is still there). A document an admin chooses is respected and
never replaced while it's there, and if the deploy locks `landing_document`
(`server.config.ts`) the server never makes one. With no `ADMINS` (and no
`DEV_LOGIN`) there's nobody to make it for, and `/` is a plain start page
with the way in; so is a locked setting naming a document that isn't there.

Locally, `bun start` does the same: on a fresh local database the first `/`
makes `/<DEV_LOGIN>/landing`. Test servers too, when a test asks for `/`.

### The homepage, served directly

Every document renders in a frame on its own origin, for safety (see [Pages
run on their own origin](#pages-run-on-their-own-origin)). The front page
(the homepage) is the exception: `/` is its page itself, served on this site
as close to a static file as it gets, with Erga's controls on top, and
nothing in between. It looks exactly as the viewer shows it (the same
viewport, title and controls; `tests/home.ts` compares them pixel by pixel),
but for one thing: the page starts below the controls, in a band of its own
coloured as the page's background, so they never cover its top (as every
document's does: task #38). It loads about twice as fast (below).

**What `/` sends** (`serveHome`, `worker/home.ts`): the page as its last
deploy rendered it (`renderHome`, `home.ts`), then, as soon as it's known who's
asking, the controls (`homeHeader`): Clone, Edit (the document's address with
`#edit`) for those who may edit it, and who you are (account.ts's corner). The
page goes out at once; signed out, so do the controls, and nothing is asked
of the database at all. The controls are a declarative shadow root on an
`<erga-controls>` element, so they paint as they arrive, before any script,
and neither side's styles reach the other: the host's own `!important` rules
win over anything the page says about it, and its few lines of script move
it out of the page's `<body>` and run the avatar's menu. The band is the
root's top padding (in the page's head from the start, so nothing moves when
the controls arrive), with the controls' own band over it, fixed (on a phone
it scrolls away with the page), in the page's background colour (its root's,
else its body's, else the canvas's; anchors scroll to below it). A deploy's files are
at `/_home/<gen>/<path>` (a new `<gen>` each deploy, so they're cached for
good); the page's relative URLs that load something (`src`, `srcset`, `href`
on `<link>`, `poster`, `url()` and `@import` in CSS, inline styles) are
pointed there. Links to its other pages stay relative: the deploy's files
are also served at the root (`/<name>.<ext>` or `/<folder>/<name>.<ext>`)
when the app has nothing there. Only an HTML page is served directly; a
Markdown homepage's deploy fails, saying so, and `/` stays the viewer.

**How it's served.** The deploy's snapshot lives in one Durable Object
(`Home`, named "home"). The Worker keeps it in the isolate's memory and in
the colo's cache (the Cache API), and checks the Durable Object for a newer
one at most every 5 seconds (`ERGA_HOME_RECHECK_MS`), after answering: so `/`
waits on nothing but memory, and on a cold isolate the colo's cache. We chose
this over Cloudflare Pages: Pages would be a second project, with an API
token as a secret, and erga.dev's `/` belongs to the Worker (its custom
domain), so the Worker would have to fetch each page from Pages, a hop more
than reading its own cache. KV would mean a namespace for every deploy (and
`/deploy` making one), for the same edge caching; Workers static assets need
a Worker deploy. This needs nothing new outside the Worker, works the same
locally (`bun start`) and on `/deploy`ed servers, and on workers.dev (which
has no Cache API) still serves from memory. A new deploy is everywhere within
seconds: about 5 in each isolate and colo, after the next request.

**Deploys** (`Home`, `worker/home.ts`). A deploy renders the homepage's
published version (`publishedFiles`, `worker/published.ts`) and keeps it with
its files under a new generation; the one before stays a while for pages
still open on it, then goes. About five minutes after the published version
changes (`ERGA_HOME_DELAY_MS` locally), on the object's alarm, the next
deploy runs; each change pushes it back. Redeploy now runs it at once. A
deploy that fails says why, and the last good one keeps serving. Making
another document the homepage drops the snapshot and deploys the new one at
once (meanwhile `/` is the viewer on it); deleting the homepage drops it too
(the next `/` makes a new one from `landing/`). Every change of the deploy's
state is told to everyone who has the homepage document open: `{ type: "home"
}` on its `/api/events`. The published version is the one published in
"manual" mode; in "latest" mode, the document as it is now, which changes
each time a version is cut (see Versions and publishing). The document's host
calls `publishedChanged` whenever it fires `firePublished`.

**Its API** (`homeApi`, `home.ts`; the settings UI builds on it):

    GET  /api/docs/<id>/home          for anyone who may open the document (or an admin)
      → { isHome: boolean,
          canSet: boolean,            an admin who may edit it, and landing_document isn't locked by the deploy
          blocked: string | null,     why it can't be the homepage (someone who isn't an admin may edit it), or null
          deploy: { state: "idle" | "scheduled" | "deploying" | "deployed" | "failed",
                    at: ISO time | null (the last success), scheduledFor: ISO time | null,
                    version: number | null (the published version that's live), error: string | null } }
    POST /api/docs/<id>/home   { isHome: boolean }   admins: sets or clears landing_document; answers as GET
    POST /api/docs/<id>/home/deploy                  admins: deploys again now (the homepage only); answers as GET

Refusals are `{ error }` with 401, 403 (not an admin, not allowed, from
another site), 404, 409 (locked by the deploy, or not the homepage). Clearing
it resets `landing_document`, so the next `/` makes a fresh homepage from
`landing/`. A document that isn't the homepage has `deploy.state` `idle`.

**Security.** The homepage's scripts run on erga.dev's own origin, where they
can do anything the person viewing it can (call the app's API as them, read
its local storage). So only admins may edit it, which the directory enforces
(`directory.ts`): a document can't become the homepage while anyone who isn't
an admin may edit it (`homeBlocked`, which GET `/home` reports as `blocked`),
nobody but an admin can be made its editor while it's the homepage (`share`),
and anyone else whose permission says otherwise (an admin since made a user)
only views it (`homeLimit`, in `access` and `openAs`, so the room, the
agents and publishing all follow). What's left to trust is the admins. The
session cookie is `HttpOnly` (`SameSite=Lax`), so the page can't read it;
`/` says `Content-Security-Policy: frame-ancestors 'self'`, `Referrer-Policy:
no-referrer`, `Cache-Control: private, no-cache`.

**To check on a real account** (the tests run locally only): the `Home`
Durable Object's first deploy with `cf deploy` (a new class, declared in
`exports`), the Cache API on erga.dev, `www.erga.dev` (not one of the Worker's
domains today; add it to `domains` in `cloudflare.config.ts` if it should
serve `/` too), and how quickly a deploy reaches other colos.

**Speed** (`bun tests/bench.ts --prod --only front`, medians of 5, ms; cold is
a fresh browser, warm the same page again; "visible" is the page's first
contentful paint):

|  | ttfb | visible (cold) | visible (warm) | requests | kB (cold) |
|---|---|---|---|---|---|
| desktop, before | 5 | 156 | 52 | 17 | 600 |
| desktop, after | 5 | 133 | 31 | 9 | 190 |
| desktop, 50ms to the database, before | 111 | 373 | 199 | 17 | 600 |
| desktop, 50ms to the database, after | 4 | 123 | 35 | 9 | 190 |
| phone (Slow 4G), before | 159 | 806 | 400 | 17 | 600 |
| phone (Slow 4G), after | 156 | 463 | 234 | 9 | 190 |

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
signed in gets a row as they come. An admin's agent does all of it for them
too (see [Agents configure the server](#agents-configure-the-server)): ask
the agent in the editor, or Claude Code with their token, to add a user.

**The admin page.** `/admin` (`admin.ts`) is for admins only; anyone else,
and an agent with an admin's token, gets a 404 there. It shows every
setting compactly (its key, a one-line description, its value with Save
and Reset; a small "set by whom" note, with when and the default on hover, or a
"Locked" badge for one the deploy fixes, whose value is shown read-only), and every user (last seen, who added them,
a User/Admin role menu and a remove button; a bootstrap admin's are
disabled), with a box to add one by GitHub login. Underneath it's `POST
/admin/settings` (`key` and `value` as JSON, or `reset=1`) and `POST
/admin/users` (`do=add|role|remove`, `login`, `role`), answering JSON, from
this site's pages only.

**Settings.** `server_config` holds the server's settings, a JSON value per
key with who set it and when (`config.ts`). Only the keys declared in
`SETTINGS` exist, each with a description, a default and a parser that
refuses a bad value saying why; one never set has its default. Today there's
`delete_docs_after_hours`, `landing_document` ([The front page](#the-front-page)) and `deploy_page` ([Deploy your own](#deploy-your-own)).
A change to `landing_document`, however it's made, reaches the homepage's
deploys (`ServerConfig`'s `changed`, which `worker/d1.ts` hands to
`worker/home.ts`).
A setting may name a document (`kind: "document"`): the admin page takes and
shows it by address, and the directory checks who may set it (`checks`).
`delete_docs_after_hours` is a whole number of hours, or `null` (also
`"never"`) for never; the admin page offers it as "After [n] hours" or
"Never". Anyone's request may read a setting (the server reads them
to do its work); only admins list and change them.

**Settings the deploy fixes.** A setting can also be fixed in the repo, in
`server.config.ts`:

    export default { delete_docs_after_hours: 72 };   // or null: never delete

A key there is locked: the deployed value wins over whatever the table holds,
and nobody can change it, from the admin page, the API or an agent (`set` and
`reset` refuse with `NotAllowed`, saying it's fixed by the deploy and what it
stays). Admins still see it, read-only, with its value. A key left out is the
admins' to set, in `server_config`. Taking a key out and deploying hands it
back: what an admin set before it was locked counts again. So the precedence
is: the deploy's value, else the one an admin set, else the default.

`ERGA_SERVER_CONFIG`, a JSON object in the environment of the deploy (or of
`bun start`), adds to `server.config.ts` or overrides it, for one deploy or
one dev server: `ERGA_SERVER_CONFIG='{"delete_docs_after_hours":3}' bun start`.
`cloudflare.config.ts` hands the two, merged, to the Worker as the
`SERVER_CONFIG` binding (JSON), which `directoryOf(env)` (`worker/d1.ts`)
passes to the `Directory` as its locked settings. `bun server.config.ts`
checks them against `SETTINGS` and prints them: `site.sh` runs it before
every deploy and `bun start` before it starts, so a key that isn't a setting,
or a value it won't take, stops there, saying why. Locally the same file
applies, so local development is locked the same way as erga.dev.

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
  `reset(by, key)`. An entry (`ConfigEntry`) has the key, its description,
  `value` (what applies now), `default`, `source` (`default`, `set` or
  `locked`), `locked` (true when the deploy fixes it: show it read-only),
  `deployed` (the deploy's value, only when locked) and who set it and when.

The admin-only calls throw `NotAllowed` (and a bad value `ConfigError`) with
a message a person or an agent can act on.

### Versions and publishing

A document keeps **versions** (`versions.ts`): snapshots of its whole file
set (every page, style, script and image), numbered 1, 2, 3... A version is
cut after a burst of edits, not on every keystroke. The rule
(`noteEdit` in `worker/doc-host.ts`):

- edits pause for 30 seconds;
- a burst has gone on for 5 minutes since its first edit (long typing still
  gets versions);
- an agent's turn ends (the embedded agent's, or an external agent's calls, 8
  seconds after its last): one version per agent turn, since while any agent
  works the two rules above wait for it;
- the last person who may edit leaves (their room connection closes);
- before a publish;
- when the document's room opens, if what it holds isn't the latest version
  (edits whose timers didn't run, because the object was evicted).

A cut that finds nothing changed makes no version. A new document's first
version is the files it starts from. Each version says when it was cut, who
edited since the one before (logins, and agents: "koomen’s agent"), and a
five-word description: in the background, the document sends a compact diff
(files added, removed and changed, and the changed lines with one line of
context, about 6KB at most) to Claude Sonnet 5.5 (`DESCRIBE_MODEL`) with the
server's `ANTHROPIC_API_KEY`, and stores its answer. With no key, under the
scripted test model, on test documents, or if the model fails, it's a
fallback made from the file names ("Edited index.html and style.css").
Editing never waits for any of it.

**Storage.** In the document's own Durable Object, beside its files: each
file's bytes once, content-addressed (`b:<sha-256>`), shared by every version
that has them, so a version that changes one file stores one new blob; a
version (`v:<n>`) is a manifest (path → digest) with its details. No other
database is asked, a version is served by the object that holds the document,
and deleting the document deletes its versions. Versions are kept for as long
as the document is.

**Publishing.** What viewers see is the published version, by mode:
**latest** (the default), the document as it is now, up to the keystroke, as
before: the viewer never waits for a version; or **manual**, one chosen
version, until someone publishes another. Editors always edit the current
state. The viewer shows the page from the document's `pub/` (the frame's host
page links it: `/t/<token>/pub/<page>`), which in "latest" mode is `doc/`
exactly (no extra call: the mode is in the object's memory) and in "manual"
mode the published version's files, the page's own relative links included.
Someone who may only view the document (or nobody signed in, on the front
page) gets a pages token that serves the published version for `doc/` too, so
every file they can reach is the published one, and their Clone copies it.

The API (also for the settings UI, and with an agent token):

    GET  /api/docs/<id>/versions[?before=<versionId>&limit=<n>]
      → { current: Version, published: { mode: "latest" | "manual", version: Version },
          versions: Version[] (newest first, 10 by default), total, canEdit, pending }
      Version = { id: "v3", n: 3, at: ISO time, authors: string[], description: string | null }
    POST /api/docs/<id>/publish     editors only; from a browser only from this site's pages
      { mode: "latest" } | { mode: "manual", versionId: "v3" }   (no versionId: the current state)
      → { published } | 4xx { error }
    POST /api/docs/<id>/versions/<versionId>/restore   editors only; from a browser only from this site's pages
      → { current: Version } | 4xx { error }

`description` is null until the model has answered; `pending` says there are
edits since the current version. Publishing the current version (`versionId`
the current one's) while edits are pending cuts them into a new version first
and publishes that, so "current" means up to the keystroke. A **restore**
writes the version's files over the document as it is (files it didn't have
are deleted), as an edit open editors see live, and cuts that as a new current
version, by the person (or "<login>’s agent"), described "Restored version
<n>"; pending edits become a version first, so nothing is lost. In "latest"
mode viewers then see it; in "manual" mode what's published stays. Everyone with the document open hears
`{ type: "versions" }` on its event channel (`/api/events`) when a version is
cut, a description arrives, or the published version changes. In "latest"
mode, `published.version` is the current version.

The agents (the editor's and external ones, over `/api/ext`, the server's
API and MCP) have `list_versions`, `read_version` (a version's files, or one
file as it was), `restore_version` and `publish_version` (`latest`, or
`manual` with a version; editors only), so an agent can do what the person can.

**In process, for the homepage's deploy** (`versions.ts`):
`onPublished(docId | "*", cb)` calls `cb({ docId, published, files() })`
whenever that document's published version changes (a publish, going back to
"latest", or a new version in "latest" mode); it's fired in the document's
Durable Object, so subscribe from code that runs there. `publishedFiles(env,
docId)` answers `{ published, index, files: Map<path, bytes> }` from
anywhere with the Worker's environment: the published version's files in
"manual" mode, the files as they are now in "latest" mode (the Durable
Object's `publishedFiles()` method underneath).

Locally, `ERGA_VERSION_IDLE_MS` and `ERGA_VERSION_MAX_MS` shorten the pause
and the longest burst (the tests do). `bun tests/versions.ts` tests all of
this against a dev server of its own, and `tests/versions.test.ts` the
storage.

### Agents configure the server

An admin's agents can do what an admin can: the editor's own agent and an
external one with their token have the same tools, defined once in
`server-tools.ts` (`SERVER_TOOLS`):

- `document_access`, `share_document`: who a document is shared with, and
  sharing it (its owner only; the editor's agent may leave out `document`
  for the one it's in);
- admins only: `list_settings`, `set_setting`, `reset_setting` (a setting
  the deploy locks shows `"locked": true` and is refused), and `list_users`,
  `add_user`, `set_user_role`, `remove_user` (a bootstrap admin can't be
  demoted or removed; nor can you remove yourself).

They need only the directory and who's asking, so they run in a document's
host for the editor's agent (`agentToolsFor`, given to the session by
`worker/doc-host.ts`) and in the Worker for the server's API (`server-api.ts`
adds them to its registry). The admin ones are offered only to an admin: the
editor's agent gets them (and a line in its system prompt) only if its
person is one, looked up again before each new prompt; a token's tool list
(`/api/ext/tools`, MCP `tools/list`, the personal guide) has them only for
an admin's token, and `/llms.txt` lists them as admins only. Every call is
checked again by the directory (`Users.mustAdmin`), so a stale list can't do
anything. A new tool both agents should have is one more entry in
`SERVER_TOOLS`.

Secrets are set with `bunx cf workers secrets update`: `GITHUB_CLIENT_SECRET`
(for the GitHub OAuth app whose client ID is in `cloudflare.config.ts`, with
the callback `https://erga.dev/auth/github/callback`), `SESSION_SECRET` (any long random
string) and `ANTHROPIC_API_KEY`. Locally they come from `.dev.vars` (the
agent's key from the environment too, above).
`bun tests/worker.ts http://localhost:4400` checks the front door's own
routes against a running dev server: `/new`, `/docs` and its titles,
deleting, and expiry (locally, `/new?unedited=<ms>` shortens a document's
time); `bun tests/worker.ts --local` starts one of its own.

To run it against erga.dev itself, get a test token from
https://erga.dev/settings (it lasts a week) and:

    ERGA_TEST_TOKEN=erga_test_... bun run test:prod

The token signs in test people (Ada, Bo, ...) who can open only test documents
(`/<you>/test....`), where the scripted agent stands in for the model.

### Deploy your own

`/deploy` puts a copy of the server on someone's own Cloudflare account,
with the same settings erga.dev has, and them as its admin. Who may use it
is the `deploy_page` setting: `users` (anyone signed in, the default),
`admins`, or `off`; anyone it doesn't let in gets "not found". `/admin`
links to it. Its breadcrumbs sit after the wordmark in the upper left.

The page goes in four steps:

1. **Connect Cloudflare.** "Authorize with Cloudflare" bounces to
   Cloudflare's OAuth (authorization code with PKCE, a public client: no
   secret) when the server has a client (`CLOUDFLARE_OAUTH_CLIENT_ID`, made
   under Manage Account › OAuth clients, callback
   `https://<server>/deploy/auth/cloudflare/callback`, and the scopes
   `account-settings.read workers-scripts.write d1.write workers-routes.write
   zone.read dns.write`, plus `registrar-domains.admin` for buying domains: the
   ids `GET /oauth/scopes` lists; it stays private to that account until it's
   made public, which needs a logo and a verified domain;
   `CLOUDFLARE_OAUTH_SCOPES` overrides the scopes asked for). Without
   one, or as well, a "Create API token" link opens Cloudflare's dashboard
   with exactly the permissions the deploy needs filled in (a token template
   URL: Account Settings read, Workers Scripts, D1, Workers Routes and DNS
   edit, Zone read; "Include buying a domain" adds `registrar_domains`), and the person pastes the
   token back. Either way the token lives only in their deploy session (a
   Durable Object per browser, `worker/deployer.ts`), sealed with AES-GCM by a
   key made from a cookie's half and `SESSION_SECRET`; it's never logged and
   never in D1, it's forgotten when the deploy succeeds (an OAuth token is
   revoked too) or two hours after connecting, and the page says how to
   delete it on Cloudflare.
2. **Where it goes.** The app on `erga.<subdomain>.workers.dev` (made if the
   account has no subdomain yet) or on a domain in the account (a Workers
   custom domain). Documents' pages need an origin of their own (see [Pages
   run on their own origin](#pages-run-on-their-own-origin)): one per
   document on a second domain of theirs (a wildcard route and an `AAAA 100::`
   DNS record, as erga-pages.dev), or, since workers.dev has no wildcards,
   one shared host, `erga-pages.<subdomain>.workers.dev` (a tiny Worker
   handing every request to the app), which keeps pages off the app's origin
   but not off each other's: the page says so. The Worker learns which from
   `PAGES_DOMAIN` or `PAGES_HOST` (unset: erga-pages.dev). A new domain can
   be bought here through Cloudflare Registrar's API: search, a real-time
   check with the price, then a confirmation showing the price and renewal,
   and the purchase only if the price is still the one confirmed (premium
   names go to the Registrar page).
3. **Signing in with GitHub.** Their own GitHub OAuth app: the page links to
   GitHub's form, filled in, with the homepage and callback URLs to copy,
   and takes the Client ID and secret, and an Anthropic key if they want the
   agent.
4. **Deploy**, watching each step. A step that fails says which it was and
   what Cloudflare said (its message and error code), and Try again runs the
   deploy again from the top: every step is safe to repeat.

The deploy runs in the session's Durable Object, calling the Cloudflare API
directly (`deploy/cloudflare.ts`): no CLI, no container. It deploys a
*release*: this server's own Worker as `cf build` builds it (its modules,
static assets and `worker.config.json`, so the bindings and Durable Objects
follow `cloudflare.config.ts`; the landing project is built into it) and the
migrations, made by `bun deploy/release.ts` into `.site/release/` (site.sh does it on Workers
Builds, `bun run deploy` too; the Worker reads it from its assets, and
nothing serves it to browsers). The requests follow Cloudflare's OpenAPI
schema (github.com/cloudflare/api-schemas) and how workers-sdk's deploy makes
them. The steps: check the account (a Worker called `erga` that isn't Erga
stops it; Erga's Workers carry the tag `erga-deploy`); find or make the D1
database `erga` (one by that name with tables that aren't Erga's stops it, so
nothing is lost; an empty one, from a run that stopped, is used); apply
`migrations/` through D1's `/query`, each file with its `d1_migrations` row in
one batch, as `wrangler d1 migrations apply --remote` sends it; upload the
assets (an upload session from the manifest, then the buckets it asks for,
base64 multipart or one file at a time as its upload token says, each tried
up to four times; hashes are SHA-256 of the base64 and the extension, as
Cloudflare's direct-upload guide does); upload the Worker (the metadata as a
form field, the modules as `application/javascript+module`) with its
bindings (its database by `database_id`, `ADMINS` = the deploying login,
their GitHub app, `SERVER_CONFIG` `{}`), secrets (a new `SESSION_SECRET`,
`GITHUB_CLIENT_SECRET`, `ANTHROPIC_API_KEY`) and its Durable Objects as
declarative `exports` (as `cf deploy` sends them: no migration tags, so the
same deploy can run again); its address (workers.dev, or a custom domain);
the pages' address; and wait for it to answer. The new server makes its front page itself the first time it's
opened, owned by its first admin: the person who deployed it.

Locally, `bun start` (with `bun deploy/release.ts` run once) serves `/deploy`
against the real Cloudflare API. The tests use a pretend Cloudflare
(`deploy/mock.ts`, which answers and refuses as the schema says; a dev server
started with `ERGA_DEPLOY_MOCK=1` uses it, OAuth consent page included, and
`/deploy/api/mock` shows what it was asked to do): `tests/deploy.test.ts` runs
the deploy against it step by step (retries, a stopped run run again, assets
one at a time), and `bun tests/deploy.ts` clicks through the whole page in
headless Chrome (OAuth, buying a domain, deploying, a failure, who may open
it).

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
  `/auth/logout`, which locally signs the browser out altogether (it's
  nobody, as on erga.dev, until it signs in again: `/auth/github`, or the
  corner's Sign in). Anyone may sign in locally, but documents are as private
  as on erga.dev: a blank one opens only for its owner until it's shared,
  while one opened from disk is shared with anyone signed in (`*`, editor).
  `ERGA_AGENT_MODEL=script` swaps in the scripted agent.
- **Files on disk** (`dev/plugin.ts`, a Vite plugin, and `worker/disk.ts`).
  A folder with an `index.html` or `index.md`, or a single `.html` or `.md`
  file, named to `bun start` or posted to `/__erga/open` (a path
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
- **Live reload** (`bun start --reload`, `dev/reload.ts`): every page sent
  to a browser tab gets a small script that reloads the tab when the
  editor's files are rebuilt, when the Worker's code changes (Vite reloads
  the Worker), or when the dev server restarts (Vite restarts it when its
  config, or a file the config imports, such as `front.ts`, changes). A
  document's own frame gets nothing. It's what the task queue's live mode
  runs (AGENTS.md). Edits are watched in any checkout, an agent's worktree
  under `.claude/worktrees/` included; only a checkout's own `.claude/` is
  ignored.

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

On a phone the controls make room: the breadcrumbs shrink to a back arrow,
avatars overlap, the agent covers the page instead
of pushing it aside, and the style bar sits below a selection (the system's
copy menu is above it). The page, the agent and the cards stop above the
on-screen keyboard, and keep clear of a notch.

There's no dark mode: pages are shown as their authors made them, and most
don't support one. The editor's own controls take their colours from the page
under them instead.

### Document settings

The gear in the top row opens the document's settings, in a popover under
it (a sheet from the bottom on a phone; Escape or a click outside closes it):

- **Publishing**: *Latest*, the default, where viewers see the current
  version, up to the keystroke, or *Manual*, where they see the version
  picked, until another is. Switching to Manual keeps what viewers see. The
  published-version menu always shows the published version, the latest ten
  and the three just before the published one (to roll back to); a row for
  each run of versions in between says how many there are and loads them
  (`?before=`). Under it, **Publish the current version** publishes the
  document as it is now, up to the keystroke, when that isn't what's published.
- **Homepage**, for admins and on the homepage itself: whether this document
  is the server's homepage (only admins may change it, not while it deploys),
  how its deploy stands (Scheduled for, Deploying, Deployed at, Failed), and
  **Redeploy now**.
- **Versions**: the latest ten, each with its number, the model's five-word
  description (a quiet placeholder until it arrives), when and who; the
  current and the published one marked. **Edit**, on any version but the
  current one (it shows the moment the pointer is on the version, or the
  keyboard reaches it), makes a copy of that version the current one, to edit
  it now: it appears at the top as a new version ("Restored version 21"), and
  the one it replaced stays a version.

It follows the event channel's `{ type: "versions" }` and `{ type: "home" }`,
so it's always up to date. Someone who can't edit sees it read-only, with a
line saying why. Its code (`src/page/settings.ts`, built as `settings.js`)
loads only when the gear is hovered, focused or clicked.

It talks to the server's `/api/docs/<id>/versions`, `/versions/<versionId>/restore`,
`/publish`, `/home` and `/home/deploy` (see "Versions and publishing" and
"The homepage"). When the document can't be made the homepage (someone who
isn't an admin may edit it), the homepage section says why (`blocked`).
`tests/settings.ts` sets up its state on a real server: documents with many
versions, cut by edits, Manual mode, the homepage and its deploys.

### A document's pages

A document can have more than one page. Its root is `index.html`; the
others sit beside it, in folders if you like. People think in documents, not
files: the tree shows only documents (HTML pages) and the folders holding
them (or nothing yet). A document's stylesheets, scripts, fonts and images
are part of it, out of sight, as are folders holding only those (`fonts/`,
`assets/`); the API lists every file, and agents see them all. The tree of them
(`src/page/tree.ts`, built on its own as `pages-tree.js` and loaded only when it's
opened, so viewing never pays for it) shows in two places: in the editor, the
document's title in the breadcrumbs opens it in a card, the document as its
first row and everything else under it; on `/docs`, the chevron left of each
document opens its pages beneath its row. Folders open and close (remembered
for the tab); documents show by their title when it's known (in the editor,
read from the room as they're edited; "Untitled" counts as none), else by
their name made readable ("spring-migration" is "Spring migration", a
folder's index is the folder's name), with the file's name as a quiet hint
only where two would read the same. Clicking a document opens it, in the
editor for those who may edit (`/<owner>/<slug>/<page>#edit`), in the viewer
otherwise (`/<owner>/<slug>/<page>`), and the one you're on is marked.

Editors get New document (from the new-document template; "My post" is
`my-post.html`) and New folder, at the top level (the foot of the tree) and in each
folder (its +), named in place; rename in place (the menu, F2, or the pencil
on the root row, which renames the document itself: its title and address);
move by drag and drop or the menu's Move to…; and delete (a folder asks
first, in its row, counting the documents in it; `index.html` can't go).
A document links its stylesheets, images and other documents by where they
are from it (`../style.css`), so moving one to another folder (or a folder to
another depth) can leave those behind: the tree says so after the move when
the document has relative links (in the editor it reads them from the room;
on `/docs` it always says so). It doesn't rewrite links, nor those from other
documents to the one that moved or was renamed. The editor renders a page in
a folder with its links resolved from that folder, as the browser does at its
address. Viewers see the tree without any
of that. What the server refuses shows where it happened, in its words. Keys:
↑ ↓ ← → Home End move and open folders, Enter opens, F2 renames, Delete
deletes, Shift-F10 opens a row's menu, Esc cancels or closes.

It talks to `GET /api/docs/<id>/tree` (`{ entries: [{ path, type: "page" |
"folder" | "file", title? }], canEdit }`) and `POST` there (`new_page`,
`new_folder`, `move`, `delete`), and reads it again on a `{ type: "tree" }`
event on the editor's event channel, or when a file comes or goes in the room.
That's the server's own tree API (below). `bun tests/tree.ts` checks the tree
in headless Chrome, against `dev/tree-stub.ts` (`ERGA_TREE_STUB=1`: an
in-memory stand-in for the API that changes no files, so the test can set
any tree and make changes fail).

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
it's on disk; while the room isn't open (nobody editing), it serves them
straight from storage, which then holds the latest text, so viewing never
waits for a room to open. The room is platform-neutral (storage is a four-method
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
- **Who's here.** Avatars at the top right: the others, then you, apart at the far right (your menu).
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
Its tools (read, edit, write, ls, find, grep, new_page, mkdir, mv, rm, view_page; get_title and set_title rename the document) are written against
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
starts everyone on Opus instead. Set it up with `ANTHROPIC_API_KEY`: locally
exported before `bun start` or in `.dev.vars`; a secret on erga.dev. pi's model catalogue
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
with the page's API (`/api/ext`) and your agent token (see [Agent
tokens and the server's API](#agent-tokens-and-the-servers-api): the same
token works for the whole server); paste it
into the other agent, which reads the guide and waits, then say what to change. The agent reads the guide at
`GET /api/ext` (how to call the tools, their JSON schemas, and
[DOCUMENT_PROMPT.md](DOCUMENT_PROMPT.md)), then calls
`POST /api/ext/tools/<name>` with the arguments as JSON. These are the
embedded agent's own tools (read, edit, write, ls, find, grep, new_page,
mkdir, mv, rm, view_page, and get_title and set_title for the document's
title and address),
run in your agent's session, so its edits are handled exactly like your
agent's: attributed to "Pete's agent", marked in its colour, undoable from
the agent panel, with its badge spinning while it works. Each call shows in
your agent panel as "External agent: …". It works with the embedded agent
off too (no API key needed). The share button's token is the same each time
you open it (in any tab or browser), until New token in the dialog turns it
off and makes another; `/settings` lists and revokes it with the rest.

### Agent tokens and the server's API

An agent holding one of your agent tokens can do everything you can do in
the app, as you: list your documents, make, rename and delete them, publish
a folder of files (a static site, a page) as a document, and use every
document's tools (read, edit, write, ... as above) on any document you may
edit. It's one kind of token, the same mechanism as the share button's: the
front door (`front.ts`, `withTokens`) treats `Authorization: Bearer erga_...`
as signing in as its person (`Session.agent`), so it works on the server's
API and on each document's `/api/ext` alike, with your own permissions
(`Directory.may`).

**Tokens** (`tokens.ts`, in D1: `migrations/0100_tokens.sql`) last until
they're revoked. A token is an HMAC of its id with `SESSION_SECRET`, and only
its SHA-256 is stored, so the database alone holds no working token. There
are three ways to get one:

- `/settings`: make one (shown once, with what to tell the agent and the
  `claude mcp add` line), see when each was last used, revoke any. (It also
  still shows a test token for the test suite.)
- The share button: your one "Share button" token, shown again each time
  until it's rotated.
- An agent asks, from the command line, with no sign-in of its own (a device
  flow): `POST /api/auth/request {"label": "Claude Code"}` answers an
  `approve_url` for you to open (signed in; it shows a code to compare) and a
  `code` it polls `POST /api/auth/poll` with: 202 until you approve, then the
  token, once. Requests last 15 minutes.

**The API** (`server-api.ts`), discoverable from nothing:

    GET  /llms.txt                the guide, for anyone: getting a token, calling the API, publishing, every tool
    GET  /api, /api/ext           the same guide (personal, with a token)
    GET  /api/ext/tools           the tools as JSON (name, description, JSON Schema)
    POST /api/ext/tools/<name>    runs one: {"ok": true, "content": [...]} or {"ok": false, "error"}
    POST /api/publish             a folder as a new document (multipart, each part named by its path; or JSON),
                                  or into one (document=<id>): its files replaced, ones that are gone deleted
    POST /mcp                     the same tools as a stateless MCP server (Streamable HTTP, JSON answers)

So "publish this on erga.dev" works from a local project: the agent reads
`https://erga.dev/llms.txt`, gets a token (or is given one), and posts the
folder:

    args=(); while IFS= read -r f; do args+=(-F "${f#./}=@$f"); done < <(find . -type f ! -path '*/.*')
    curl -s -X POST https://erga.dev/api/publish -H "Authorization: Bearer $ERGA_TOKEN" -F "title=My app" "${args[@]}"

which answers the document's `url`. A published document counts as edited,
so it never expires; files can be at most 2MB each, 50MB in all. Publishing
again (`update_files`, or `document=` to `/api/publish`) writes each file
over the text as it is now, as an edit open tabs see at once
(`DocHost.publish`). In Claude Code, as tools:

    claude mcp add --transport http erga https://erga.dev/mcp --header "Authorization: Bearer $ERGA_TOKEN"

The tools are a registry (`TOOLS` in `server-api.ts`): whoami,
list_documents, create_document, update_files, rename_document,
delete_document, list_tokens and revoke_token, then those the editor's agent
has too (`SERVER_TOOLS` in `server-tools.ts`: sharing, and for an admin's
token the server's settings and users; see [Agents configure the
server](#agents-configure-the-server)), then the document tools
(`documentToolSpecs` in `agent.ts`) with a `document` argument (an address,
URL, id or one of your slugs), run in that document's host as your agent. A
new tool is one more entry (a name, a description, JSON Schema for its
arguments and a `run`): the REST API, MCP and the guide all list it.

### Documents with many pages

A document is a folder, and any page in it is a page of the document
(`tree.ts`). `index.html` (or `index.md`) at its root is the document's own
page; every other `.html` or `.md` file is a page too, with an address under
the document's:

| file | address |
|---|---|
| `index.html` | `/<owner>/<slug>` |
| `about.html` | `/<owner>/<slug>/about` |
| `blog/index.html` | `/<owner>/<slug>/blog` |
| `blog/post.html` | `/<owner>/<slug>/blog/post` |

An address resolves to `<path>.html`, then `<path>.md`, then
`<path>/index.html`, then `<path>/index.md`, so `blog.html` wins over
`blog/index.html`. No address gets a slash added (`/blog/` is the same page,
left as it is); a page's file name (`/blog/post.html`, `/blog/index`)
redirects to its address; anything else is a 404 page. The editor for a page
is its address with `#edit`, the same page in edit mode, exactly as for the
first page; so a page may be called `edit` like any other. Under a document's
address `/api/...` and `/doc/...` are its host (its API, sockets and files,
which older tabs and share links reach under any of its addresses), so no
page or folder may be called `api` or `doc` at the top of a document.

**Relative links and assets.** The viewer and the editor both render a page
at its own file's path on the pages origin (`/t/<token>/doc/blog/post.html`;
the editor's `<base>` is the page's folder), so `../style.css`, `blog.css`
and `post.html` resolve as they would on disk, whatever the address bar says.
A request there for an address rather than a file (`doc/blog`, `doc/blog/`,
`doc/`) is redirected, relatively, to the page's file, so links like `blog/`
and `../` work too. Links starting with `/` don't: DOCUMENT_PROMPT.md tells
agents to link pages relatively.

**Moving between pages.** In the viewer, following a link to another of the
document's pages changes the address bar to that page's (no reload: the frame
says where it went, `erga-nav`), and the pencil opens that page's editor. In
the editor a link outside the text being edited (a menu) opens the other
page's editor (the frame asks the shell, `open`); links in the text aren't
followed, as before (⌘-click opens them in a tab). Switching pages in the
editor loads that page's address, which is quick (the editor's files are
cached and the room is the same), and `window.ergaPage.openPage(path)` does it
for whatever shows the tree. One room holds every file of the document, so
people on different pages are in the same room and their agents see
everything; each tab edits the page its address names (`<meta name="erga-page">`,
which the front door sets).

**Storage.** Pages and other files are what they always were: files in the
room (text as `Y.Text`, others as hashes) and in the document's storage.
Folders are real: a folder made as one (empty ones included) is in the shared
doc's `folders` map and in storage (`dir:<path>` keys in the Durable Object,
real directories for a document on disk), and folders holding files come from
the files' paths. Deleting a page leaves its folder, as on disk. The room's
tree operations (`room.ts`: `create`, `mkdir`, `move`, `remove`) change
storage and the shared doc in one turn of its queue; a move takes a text
file's text as it is now (unsaved edits too), starting a new history at its
new path. A file a participant deletes from the shared doc (an agent's undo
taking back a file it made) is deleted from storage too.

**The tree's API**, for the tree's UI and agents alike (`host.ts`; at
`/api/docs/<id>/tree` through the server's API, with the app's session or an
agent token, and at `/d/<id>/api/tree` for the editor):

    GET  /api/docs/<id>/tree
      → 200 { entries: [ { path: "index.html", type: "page", title: "Home" }, { path: "blog", type: "folder" },
                         { path: "blog/index.html", type: "page", title: "Blog" }, { path: "style.css", type: "file" } ],
              canEdit: boolean,
              moved: [ { from, to } ] }        (the latest moves, for a tab that missed one)
    POST /api/docs/<id>/tree   (JSON; editors only)
      { op: "new_page",   path: "blog/post.html" }   from the new-document template (templates/doc); no
                                                     extension: .html (.md in an index.md document)
      { op: "new_folder", path: "blog/drafts" }      and any folders it's in
      { op: "move",       from: "blog/post.html", to: "posts/hello.html" }
                                                     rename = move; folders with all they hold; a page renamed
                                                     without an extension keeps its own
      { op: "delete",     path: "blog" }             folders recursively
      → 200 { entries: [...] } | 4xx { error: "plain message" }

Paths are relative to the document's root, "/"-separated, with no leading or
trailing slash; every folder is listed (empty ones too), folders first at each
level; `page` is `.html` or `.md`, `file` anything else; a page has a `title`
when it has one (its first heading, else its `<title>`, as a document's title
follows its page). Refused: `..`, hidden
names and `node_modules`, control characters and `< > : " | ? * # %`, names
ending in a space or dot, anything already at the destination (409), a path
inside a file, a folder into itself, the reserved names above, and moving or
deleting the root `index.html` (400); nothing there is a 404, a viewer's POST
a 403 (`canEdit` is false for them), someone the document isn't shared with a
404, a POST from another site a 403. A single file opened from disk has no
tree to change (403).

**Live updates.** Whenever the tree changes, from anyone (a person, another
person, an agent, a publish, a file on disk), every open tab gets
`{ "type": "tree" }` on its event channel (`/api/events`, the socket that
carries the agent's events and renames); a move or delete through the tree's
operations also sends `{ "type": "tree", "moved": { from, to } }` or
`{ "type": "tree", "deleted": path }`. The editor passes each on as an
`erga-tree` event on `window` (its `detail` is the message), for the tree's UI
to refetch, and follows its own page: moved, to its new address; deleted, to
the document's first page.

**Agents** see the document as a file system, with the same powers as a
person: `ls` (folders end in `/`), `find`, `grep`, `read`, `edit`, `write`
(which also makes a page from its own text), `new_page` (from the template),
`mkdir`, `mv` and `rm`, checked exactly as the tree's API checks them. The
embedded agent, external agents over `/api/ext`, the token API and MCP all
have them. Their prompts say the document can have many pages, how files map
to addresses, and to link pages relatively; each message says which page the
person is on.

### Pages run on their own origin

Anyone who can edit a document can put a script in its page, so a page
never runs where it could act as the person viewing it (the homepage aside,
which only admins may edit: see [The homepage, served
directly](#the-homepage-served-directly)). The editor's shell
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

### One page, viewing or editing

A document's page (`viewDocument` in `front.ts`) is the same at
`/<owner>/<slug>` and with `#edit` after it (the server never sees the fragment, so it serves one page; the page decides from `location.hash`, as it loads and whenever it changes), and small (about 4KB compressed):
the controls, floating over the top corners, and a frame filling the window
with the frame's host page in it (`/t/<token>/?view=`), which shows
the document's page straight away, as it renders. All the rest of the weight
is the document's own. Editing is loaded on top, only for those who may edit
and only when they go into it (the pencil, or opening it with `#edit`, or adding `#edit` to the address): the page adds
the editor's controls and styles (`page.html`, served as `/editor.html`) and
its code (`page.js`, which joins the room), and asks the frame for its half
(`frame.js`). That renders the editable page out of sight and puts it in the
plain page's place, scrolled to the same spot; then the editor's controls
fade in over the viewer's. The pencil again, taking `#edit` off the address, and the browser's Back go the other way:
the plain page loads again behind and takes its place, the viewer's controls
fade back, and the editor carries on unseen, so going back in is immediate.
Viewing, the page fetches the editor's files (and wakes the document's room)
once the document has loaded and the browser is idle, or sooner when the
pointer or focus comes to the pencil. The first time in, the
viewer stays as it is while they arrive (the pencil breathes if that takes a
moment); then the editor's controls show and the agent grows out of its
button as on any later switch, once the page has said what its background is,
so the room the page slides over to make is its colour, never a white block.
Only a page opened with `#edit` and reloaded puts the agent back unanimated.
`tests/account.ts` switches both ways and checks that the document stays put;
`tests/switch.ts` records the first switch frame by frame on a slow network,
light and dark, and checks no frame shows white or loses the document, and
that the page never jumps.

The pages origin (`pagesDoor` in `front.ts`) serves the frame at `/t/<token>/`
and the document's files under `/t/<token>/doc/`. The token, signed with
`SESSION_SECRET`, opens that one document for a week, names the shell's origin
(the only one allowed to embed the frame, by `frame-ancestors`, and the only
one it takes orders from), and comes with the editor's own page, which only
people who may open the document get. On Cloudflare that's a wildcard route
on `*.erga-pages.dev/*` (`cloudflare.config.ts`) with a proxied wildcard DNS
record. Locally the origin is `<id>-<owner>.localhost:<port>`, which browsers
send to this machine, and the token's secret is kept in the data directory.

### Loading fast

What happens between asking for a document and seeing it, and what keeps it short:

- **The page itself** asks the database once (`Directory.openAs`: the
  document at that address and your role on it, in one query) and doesn't wait
  on the document's Durable Object at all: its frame asks for `doc/`, which
  the document answers with its page, whatever its name. The front page asks
  the setting's document and its host at the same time. Who you are is worked
  out once per request (`sessionOf`), the corner included.
- **The frame's host page** has its code's version in its address (`&v=`),
  so the browser keeps it for the day (`max-age`; without the version it's
  checked by ETag), and the token in its address stays the same all day (its
  expiry rounds up to a whole day), so the addresses of the document's files
  do too. Its base is the document's folder, so the editable page (a srcdoc,
  which takes it) asks for the document's files there from the start.
- **A file of the document** is asked of its Durable Object at the same time
  as the directory confirms the token's document is still its owner's.
- **The document's files** (`docFile` in `host.ts`) carry an ETag, their
  digest, with `no-cache`: the browser keeps them and asks each time whether
  they changed, getting a 304 and no body when they haven't, so an edit shows
  at once and a repeat visit (or the editor's re-render) downloads nothing it
  has. While the room isn't open they come straight from storage
  (`DocHost.storedFile`).
- **Viewing**, nothing of the editor loads until the document has (above).
- **Editing**, a page opened with `#edit` fetches the editor's files as it
  parses (preloads, added by an inline check of `location.hash` at the top of
  the page, for those who may edit), its frame starts on `frame.js` at once
  (`?edit=1`, added to the frame's address by the same check), and
  the document's details (`/api/doc`, which opens its room) are asked for
  alongside the editor's code rather than after it (`window.ergaDocInfo`).
  `frame.js` leaves out the HTML language (and its CSS and JavaScript), which
  the frame never used (`docExtensions`, `bridge.ts`): a third smaller.
- Every response says where its time went (`Server-Timing`, `worker/timing.ts`):
  the Worker's time, and how many calls to the database and to documents it
  made and how long they took; a file served from storage says so
  (`doc;desc="stored"`).

`bun tests/bench.ts` measures it in headless Chrome: the front page, a
document in the viewer, the same in the editor, and the switch with the
pencil, each cold (nothing cached, the document's room not yet open) and warm,
on a desktop and on a throttled phone (Slow 4G, 4x slower CPU): time to first
byte, first contentful paint, when the document is visible (its frame's first
paint), LCP, load, when the editor is ready, requests and bytes. `--prod` runs
it against the Worker built as deployed (`vite build`, then `vite preview`)
rather than the dev server; either way it puts a gzipping proxy in front, as
Cloudflare compresses what erga.dev sends. `--waterfall` prints each case's
requests with their server timings; `--runs`, `--profile`, `--only` and
`--json` are the rest (its header says more). Locally there's no distance
to the database or the Durable Object, so `--latency 50` has every call to
them wait 50ms first (`ERGA_REMOTE_LATENCY_MS`, local development only), as a
Worker far from them would on erga.dev: that's where the round trips the page
saves (above) show.

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
sharing (the share dialog too) and what each role may do, `/admin` (settings and users, only for admins), deleting, expiry, and the pages origin's
token) and the server's API for agents: asking for a token and approving it,
publishing a folder, the tools over HTTP and MCP (with the person's own
permissions), the share button's token, and revoking.
`bun tests/account.ts` checks the corner on every page (signed in, signed
out, the menu, signing in and back, the editor's avatar, light, dark and a
phone). `bun tests/landing.ts` checks the front page the server makes: on a
fresh server the first `/` (several at once) makes one, its owner edits it in
the editor, someone else sees it without Edit, `/new?from=landing` copies it,
a deleted one is made again, and an admin's choice is kept;
`tests/landing.test.ts` races separate isolates on one database.
`bun tests/home.ts` checks the homepage served directly: the first `/` is the
viewer and starts the first deploy, then `/` is the page itself and looks
like the viewer pixel for pixel (light, dark, desktop, phone; `bun
tests/home-shots.ts <folder> [path or URL]` takes such pictures on their own),
the page's styles and the controls' can't reach each other, its files load,
only admins may edit it, deploys are debounced, Redeploy now, a failed deploy
keeps the last one, the switch on and off, and a locked setting;
`tests/home.test.ts` covers the rendering.
`bun tests/versions.ts` checks versions and publishing: a burst of edits is
one version, an agent's turn is one, leaving cuts one, events and
descriptions arrive, "latest" and "manual" in the viewer (headless Chrome),
who may publish, publishing the current version with edits pending,
restoring, and the agents' tools; `tests/versions.test.ts` covers their
storage (unchanged files stored once).
`tests/directory.test.ts` covers the directory, permissions, users and
settings on bun:sqlite; `tests/tokens.test.ts` the tokens themselves.
`bun tests/settings.ts` checks document settings (the popover, Latest and
Manual, the published-version menu's windows, live updates, the homepage's
deploy states, errors, read-only, a phone and a dark page), and
`tests/versions.test.ts` the menu's windows on their own.
`bun tests/pages.ts` checks documents with many pages: the tree's API and
who may use it, every operation and what it refuses, live tree events,
addresses (`blog.html` before `blog/index.html`, no slash added, 404s, a
page called `edit`, no `/edit` route), `#edit` opening the editor on load
and on a hash change (Back and Forward too, without a reload), the
pages origin's redirects, the agents' file tools (API, MCP and the editor's
agent), folders across a restart and single-page documents, and, in headless
Chrome, nested pages in the viewer and editor with their relative assets, the
address following links, and an open editor following its page when it's
moved (`--keep` leaves the server running with the sample document);
`tests/tree.test.ts` covers `tree.ts` and the room's tree operations.
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
- `landing/`: the demo page, built into the Worker, which the server makes the
  front page when there's none (`seedLanding`, `front.ts`)
- `home.ts`, `worker/home.ts`, `worker/published.ts`: the homepage served
  directly: its rendering, controls and API; its deploys (the `Home` Durable
  Object) and serving `/`; the published version it deploys
- `front.ts`: the app's own routes and pages (the front page, `/new`, `/docs` and
  its share dialog, delete, the unedited rule, titles)
- `admin.ts`: `/admin`, the server's settings and users, for admins
- `deploy/`, `worker/deploy.ts`, `worker/deployer.ts`: `/deploy`, deploying
  Erga to your own Cloudflare account (the API steps, the release, the
  pretend Cloudflare the tests use, the page)
- `account.ts`: who you are in the upper right of every page (avatar and menu, or sign in)
- `directory.ts`: the directory of documents (addresses, titles, permissions, who may do what), over
  `Sql`; `worker/d1.ts` puts it on D1; its tables in `migrations/`, which `migrate.ts` applies to
  erga.dev's D1 (the dev server applies them locally)
- `users.ts`, `config.ts`: the server's users and admins, and its settings, on the same database
- `tokens.ts`: agent tokens (one kind, standing for a person everywhere), in
  D1 (`migrations/0100_tokens.sql`)
- `server-api.ts`: the server's API for agents (`/llms.txt`, `/api/ext`,
  `/api/publish`, `/api/auth/...`, `/mcp`), its tool registry, and `/tokens`
- `versions.ts`: a document's versions (content-addressed snapshots of its
  files, in its Durable Object), their descriptions, and the hooks for the
  homepage's deploy (`onPublished`, `publishedFiles`)
- `server-tools.ts`: the tools both the editor's agent and a token's agent
  have: sharing, and the server's settings and users for an admin
- `host.ts`: the per-document host (API, `/doc/`)
- `worker/`: erga.dev on Cloudflare (front door, sign-in, Durable Objects,
  and `disk.ts`, a document's files on disk in local development)
- `dev.ts`, `dev/`, `vite.config.ts`: local development (`bun start`): the
  Worker under Vite, the plugin that links files on disk to documents, and
  live reload (`dev/reload.ts`)
- `api.ts`: the host's HTTP API (Effect's HttpApi): each endpoint's request,
  response and failures; the editor imports its types
- `room.ts`: the document room (shared Yjs doc, sync, write-back, disk merges, the tree's operations)
- `tree.ts`: a document's file tree: pages and their addresses, the tree's entries, names it takes
- `agent.ts`, `workspace.ts`, `.dev.vars.example`: the per-person agent session, its
  tools over the shared doc, and its settings; `dev/agent-key.ts` picks its key
  locally (`.dev.vars` or the environment)
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
- `src/page/settings.ts`, `src/page/versions.ts`: document settings (the gear's
  popover: publishing, the homepage, versions), built on its own as `settings.js`
- `package.json`: the pinned CodeMirror and Yjs packages the page editor bundles, and pi
- `src/page/tree.ts`: a document's pages as a tree (built as `pages-tree.js`, loaded on demand), in the editor and on `/docs`
- `style.css`: theme colours, typography and the editor's styling
- `fonts/`: the self-hosted Inter web font
- `tests/`: unit tests, `page.ts`, `smoke.ts` and `fixtures/` for the page
  editor, and the multiplayer suite in `suite/` (see above)
