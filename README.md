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
- **Admin settings**, `/admin`: the server's settings, and **Users**,
  `/admin/users`: who may sign in, when they joined, and their roles (admin,
  deploy); for admins (and, with admin keys required, only once they've
  unlocked admin access with their SSH key).
- **Admin keys**, `/admin/keys`: an admin's SSH keys, and unlocking admin
  access with them (see [Admin SSH keys](#admin-ssh-keys)).
- **Deploy your own**, `/deploy`: a page of its own, not an admin one; anyone
  signed in, by default (see [Deploy your own](#deploy-your-own)).
- **Factory**, `/admin/factory`: Erga's own repository and its deploys, the
  factory's tasks and the factory's own agent, on one page, for admins
  (`/admin/source` and `/source` redirect there; see
  [Erga's own source](#ergas-own-source) and [The factory](#the-factory-experimental)).

The user menu in the upper right of every page reaches Documents,
Settings, Deploy your own (for those the `deploy_page` setting lets in) and
(for admins) Admin settings. Clone and Edit sign you in with
GitHub first (only the server's users: see [Users, admins and
settings](#users-admins-and-settings)); a copy is yours at `/<you>/<slug>`,
which only you can open until you share it. `/new` makes a blank document
instead (a copy of `templates/doc/`). Each document is a
Durable Object (`worker/doc-host.ts`), named by the document's id, that
keeps its files and Yjs state in its own storage and serves the
per-document host (`host.ts`), agent included.

Everything else the server knows is in one D1 database (`DB`; its tables in
`migrations/`, applied by the deploy pipeline): its users and admins, its settings,
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
edit or only view (`x-erga-access`). Its sockets open only from this site's own pages: a
WebSocket whose `Origin` is another (another subdomain included, which the
session cookie reaches) gets 403. A viewer's room connection is
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

    bun run deploy                  # erga.dev from this machine, through the one deploy pipeline (asks first)
    bun run deploy:staging          # staging.erga.dev the same way
    bun run setup:staging           # the one-time setup of staging, and its first deploy (asks at each step)

How erga.dev and staging.erga.dev are deployed, and how a branch deploys
itself, is [Deploys: staging and production](#deploys-staging-and-production).
In short: `main` in Erga's own source (Cloudflare Artifacts) deploys
erga.dev, and `staging` deploys staging.erga.dev; each server builds and
deploys its own branch when it moves. A push to GitHub deploys nothing
(Workers Builds is off for `erga` since task #3). The main checkout's
`origin` is Erga's own Git endpoint (`https://erga.dev/git/erga.git`), and the
task queue pushes each merge to its `staging`, so a merge on the board
deploys staging.erga.dev. erga.dev moves only when someone moves `main` to
staging: Merge on erga.dev/admin/factory, or `tq release`. The deploy pipeline applies `migrations/` to the
database before it uploads the Worker.

A migration lands just before the Worker that needs it, so it must keep working with the one still deployed (add tables
and columns; don't rename or drop). New ones: `bunx cf d1 migrations create
<message>`. `0001_erga.sql` is the exception: it started the database afresh
(it drops whatever was there before, the first directory and its backfill
included), so documents made before it, and the per-person `DocList` Durable
Objects (deleted by the config, with what they held), are gone.

**Who you are, on every page.** The upper right of every page erga.dev
serves (`account.ts`) shows your avatar (your GitHub picture, or your
initial on your colour if it doesn't load); clicking it opens a small menu:
your name, Documents, Settings, Deploy your own (as `deploy_page` says),
Admin settings (admins only) and Sign
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

### New documents from a template

The + button (New document) makes a new document. It is in the viewer's
controls, beside Clone and Edit (on a document's page and on the front page,
served directly or not), and in the editor's top row, beside the pencil. It
opens a picker of templates, under the button: **Page** (a blank document:
the base typography, Literata and Instrument Sans, in one reading column,
and nothing more), **Design doc** (`templates/design-doc`: the same column
with a header, flow diagrams, tables and boxed decisions with status chips;
it was Page's starting point before) and the **Presentation** group, with **Slides** (below), **Canvas
presentation** (`templates/canvas`, a Prezi-style talk: four frames on one
large canvas, each a step with its label and picture; going to another step
zooms out to the whole canvas, then in on that frame, and a click on a frame
goes to it too) and the **Solar system tour** (below). An empty group says it
has no templates yet. The demo page
is no template: Clone, on the front page, copies it. Every option and group
heading is in the app's typeface, Inter, at one size and weight (the picker
loads `/fonts/inter.css` on a page that hasn't it). Each template is a link to
`/new?template=<id>`, which makes the document and opens it in the editor.
Signed out, the picker says you sign in first; `/new` sends you to sign in
and back to `/new?template=<id>`, which asks you to confirm (the way back from
GitHub is another site) and then makes it. An unknown template is a 404.
Escape, a click elsewhere or leaving the window closes the picker; ↑ ↓ move
in it. `/new` with no template is the first one, Page.

All of it comes from one registry, `templates.ts` (no server code: the
picker's markup, style and script are there too, for the viewer, `home.ts`
and the editor). To add a template:

1. Put its starting document in a folder of its own, `templates/<name>/`,
   with `index.html` (or `index.md`) and the text files beside it (the
   Worker reads them as text).
2. Add one entry to `TEMPLATES` in `templates.ts`, where it should show in
   the picker:

       { id: "slides", name: "Slides", group: "Presentation",
         description: "16:9 slides you step through.", files: "templates/slides" },

   `id` is its name in `/new?template=` (keep it once it's out: links name
   it), `group` one of `TEMPLATE_GROUPS` (or none, to stand on its own), and
   `files` the folder.
3. A new group goes in `TEMPLATE_GROUPS`, with the template it comes after.

`bun tests/new-doc.ts` checks it in headless Chrome: each template's
document, the picker and its typeface in the viewer, the editor and the signed-out front page,
and the way to sign in.

**Slides** (`templates/slides`) is a deck of 16:9 slides, the shape of Google
Slides', one at a time and as large as the window allows (everything in a
slide is sized in `cqw`, hundredths of its width, so it all scales). It
starts with two slides, each a title and "Hello". Each slide is a step
(`window.ergaSteps`, below): its label is the slide's title, and its picture
in the list of steps is the slide drawn small (a copy of it, with the page's
styles, in an SVG). A slide is a `<section class="slide">` in `<body>`; add
one and it counts. `bun tests/slides.ts` checks it, viewing and editing
(`--shots` keeps pictures).

**Solar system tour** (`templates/solar-system`) is a presentation
(DOCUMENT_PROMPT.md, "Presentations") with no libraries: a canvas draws a
small 3D model of the Sun and the eight planets, which go around it, among
stars. Each `.note` section is a step, and its `data-planet` names the
planet the camera goes to: the first, with none, is the overview. Going to a
step flies the camera there in about two seconds (at once with reduced
motion), over the Sun rather than through it, and the camera follows the
planet. Each step's picture in the list (`image()`) is the view from that
step's camera, now. The notes are the page's text, so they're edited like any
other. `bun tests/solar-system.ts` checks it, viewing and editing.

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
by an admin. The server always keeps an admin: nobody may demote or remove
the last one (`NotAllowed`, saying so). Locally, `DEV_LOGIN` is a bootstrap admin too, and everyone
signed in gets a row as they come. Being an admin says who *may* administer
the server; with admin keys required (off by default), doing it also needs
admin access unlocked with an SSH key the admin added themselves (see
[Admin SSH keys](#admin-ssh-keys)). An admin's
agent can do it all for them with an admin token (see [Agents configure the
server](#agents-configure-the-server)): ask Claude Code, with one, to add a user.

**The deploy role.** Apart from their role, an admin may grant any user the
deploy role (`users.deploy`, `Users.setDeploy`): they may then use
[/deploy](#deploy-your-own) while `deploy_page` is `admins`, as admins
may. With `users` everyone signed in may anyway, and with `off` nobody may.

**The admin pages.** Every page under `/admin` has the same layout
(`admin-layout.ts`): a breadcrumb in the upper left (Erga › Admin › the
page), Share with agent in the upper right (the editor's button and card,
with a factory token: `admin-share.js`, built from
`src/page/admin-share.ts`), and a sidebar on the left with Settings
(`/admin`), Change log (`/admin/changes`), Users (`/admin/users`) and Factory (`/admin/factory`). The
sidebar collapses to a rail of icons, and expands again, with an animation,
so the factory's board gets the full width; the browser remembers which
(`localStorage`, `erga:admin-sidebar`). On a phone the links are a row above
the page.

Every `/admin` route is for admins only, checked on the server: the Worker
asks the server's role (`Users.isAdmin`) before any of them answers
(`adminGate`, `worker/index.ts`), and each page's own door checks again.
Anyone else, and an agent with an admin's token, gets a 404 there (a POST:
401 or 403); signed out, a page sends you to sign in. Only the admin role
counts: being allowed to use `/deploy` (`deploy_page`), a document's
sharing, or any token never makes anyone an admin. The admin APIs
(`/api/admin/...`, `/api/source/...`, `/api/deploys`, `/api/factory/...`,
the admin tools) check the role themselves, as they always have. An admin who hasn't
unlocked admin access goes to `/admin/keys` first, and comes back.

`/admin` shows every
setting compactly (its key, a one-line description, a "Last set at … by …"
line under it, with the default on hover, or a "Locked" badge for one the
deploy fixes, whose value is shown read-only), each with a control that fits
it: an on/off switch for a boolean or a setting whose `choices` are off and
on, and a select for other `choices` (both save as soon as they change); a
user picker (chips, and a box to add one of the server's users) for a list of
users (`kind: "users"`, the `logins` parser); a document's address; a
number. Those typed in have Save, and Reset when they're set (not a
document's: empty is none). `/admin/users` lists every user (who added
them, when they joined and were last seen) with a switch for each role,
Admin and Deploy, and a remove button, and a box to add one by GitHub
login. Roles change only with the switches, never typed text. `/admin/changes`,
the **Change log**, lists every change to the settings, newest first, each
with when, who, and each setting's value from and to (a reset badged), 50 at
a time (Older changes: `?before=<n>`). A bootstrap admin's Admin switch and
remove button are off, and so are the last admin's, saying why. Underneath it's `POST
/admin/settings` (`key` and `value` as JSON, or `reset=1`) and `POST
/admin/users` (`do=add|role|deploy|remove`, `login`, `role`, `deploy`: 1
or 0), answering JSON, from this site's pages only. The directory checks on
the server, for every one, that an admin asks (`Users.mustAdmin`).

**API keys.** The Settings page starts with the server's API keys
(`credentials.ts`): the Anthropic key (the editor's agent, the factory's
agent, version descriptions) and the OpenAI key (ready for OpenAI's models;
nothing calls OpenAI yet). An admin pastes one and saves it, replaces it, or
clears it (`POST /admin/credentials`: `name` `anthropic` or `openai`,
and `value`, or `clear=1`). The page shows only whether each is set, its
last four characters, and who set it when, never the key. The key is in its
own table (`credentials`), encrypted with AES-GCM under a key from
`FACTORY_KEY` (locally the session secret), and the change log says only
"ANTHROPIC_API_KEY key set" (or replaced, cleared). The code that calls
Anthropic reads the stored key first (`withKeys` in `worker/d1.ts`), else
the Worker secret of the same name (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
An open document keeps the key it opened with until it closes; the factory's
agent reads it again after a minute. docs/secrets.md has the details.

**Settings.** `server_config` holds the server's settings, a JSON value per
key with who set it and when (`config.ts`). Only the keys declared in
`SETTINGS` exist, each with a description, a default and a parser that
refuses a bad value saying why; one never set has its default. Today there's
`delete_docs_after_hours`, `landing_document` ([The front page](#the-front-page)), `deploy_page` ([Deploy your own](#deploy-your-own)) and `factory` ([The factory](#the-factory-experimental)).
A change to `landing_document`, however it's made, reaches the homepage's
deploys (`ServerConfig`'s `changed`, which `worker/d1.ts` hands to
`worker/home.ts`).
A setting may name a document (`kind: "document"`): the admin page takes and
shows it by address, and the directory checks who may set it (`checks`).
`delete_docs_after_hours` is a whole number of hours, or `null` (also
`"never"`) for never; the admin page offers it as "After [n] hours" or
"Never". Anyone's request may read a setting (the server reads them
to do its work); only admins list and change them.

**Settings' versions.** Each change to a setting, however it's made (the
admin page, an agent, the homepage's switch, the server's own write), keeps
a version of the settings, as a document keeps versions: a row in
`server_config_versions` (numbered 1, 2, 3...) with who made it, when, and
what changed (`[{ key, from, to, reset? }]`, each value as it applied
before and after; a default when it had no row). It's written with the
change, in one batch, only while the row is still the one read (else it reads
again), so a change saved twice at once is recorded once. A change that
changes nothing (the same value again, a
reset of a default) makes no version. Only admins read them.

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
  `isAdmin(who)`, `hasDeploy(who)`, `signedIn(login, name?)`, and, admins only, `list(by)`,
  `add(by, login, { role })`, `setRole(by, login, role)`, `setDeploy(by,
  login, deploy)`, `remove(by, login)`;
- settings: `dir.config.get(key)` (typed by `SETTINGS`), `entry(key)`,
  `isLocked(key)`, and, admins only, `list(by)`, `set(by, key, value)`,
  `reset(by, key)`, `history(by, { before?, limit? })` (the settings' versions,
  newest first, and their `total`). An entry (`ConfigEntry`) has the key, its description,
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
      optional body { path: "blog/post.html" }   (only that file)
      → { current: Version, from: "v3", files: string[] } | 4xx { error }

`description` is null until the model has answered; `pending` says there are
edits since the current version. Publishing the current version (`versionId`
the current one's) while edits are pending cuts them into a new version first
and publishes that, so "current" means up to the keystroke. A **restore**
writes the version's files over the document as it is (files it didn't have
are deleted), as an edit open editors see live, and cuts that as a new current
version, by the person (or "<login>’s agent"), described "Restored version
<n>"; pending edits become a version first, so nothing is lost. With a
`path`, only that file comes back ("Restored <path> from version <n>"), and
the other files stay as they are. In "latest"
mode viewers then see it; in "manual" mode what's published stays. Everyone with the document open hears
`{ type: "versions" }` on its event channel (`/api/events`) when a version is
cut, a description arrives, or the published version changes. In "latest"
mode, `published.version` is the current version.

The agents (the editor's and external ones, over `/api/ext`, the server's
API and MCP) have `list_versions`, `read_version` (a version's files, or one
file as it was), `diff_versions` (a unified diff for each file, `from` a version
or `last_turn`, the default: where that agent's last turn ended, `to` a version
or `current`, the default: the document as it is now; `path` for one file or
folder), `restore_version` and `publish_version` (`latest`, or
`manual` with a version; editors only), so an agent can do what the person can.
`restore_version` takes a `path` to restore one file, and answers the new
current version's id and the restored text, so the agent can edit against it
at once. An `edit` whose `oldText` was in the text the agent last saw, but
isn't in the file now, says the file changed since, names any restore of it
since, and gives the current version's id.

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

An admin's agent can do what an admin can, with an admin token (see [Admin
SSH keys](#admin-ssh-keys)). The editor's own agent and an external one
with a token have the same tools, defined once in `server-tools.ts`
(`SERVER_TOOLS`), but the admin ones only ever reach an external agent with
an admin token:

- `document_access`, `share_document`: who a document is shared with, and
  sharing it (its owner only; the editor's agent may leave out `document`
  for the one it's in);
- admins only: `list_settings`, `set_setting`, `reset_setting` (a setting
  the deploy locks shows `"locked": true` and is refused), and `list_users`,
  `add_user`, `set_user_role`, `set_user_deploy`, `remove_user` (a bootstrap
  admin can't be demoted or removed, nor can the last admin; nor can you
  remove yourself).

They need only the directory and who's asking, so they run in a document's
host for the editor's agent (`agentToolsFor`, given to the session by
`worker/doc-host.ts`) and in the Worker for the server's API (`server-api.ts`
adds them to its registry). The admin ones are offered only to an admin
with admin access unlocked (`Users.isUnlocked`): a token's tool list
(`/api/ext/tools`, MCP `tools/list`, the personal guide) has them only for
an admin token (an admin's plain agent token gets a line saying how to make
one), and `/llms.txt` lists them as admins only. The editor's agent never
has them: a document's host carries no unlock, and the document's own text
can steer its agent. Every call is checked again by the directory
(`Users.mustAdmin`), so a stale list can't do anything. A new tool both agents should have is one more entry in
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

### Admin SSH keys

**Off by default.** Unless the deploy sets `ERGA_ADMIN_KEYS_REQUIRED=1`
(`cloudflare.config.ts`), a signed-in admin is enough: every signed-in
session carries an unlock that names no key (`SIGN_IN_KEY`, made in
`worker/auth.ts` and `front.ts`'s `withTokens`), so the admin check
(`Users.isAdmin`) is the only one left. Non-admins and people signed out are
refused as before. An admin's agent token works as an admin token does
(but never the share button's token: below)
(the admin tools, the Git endpoint), and `/admin/keys` says no key is
needed. The keys, the challenges and admin tokens still work; to turn the
requirement back on, make `ERGA_ADMIN_KEYS_REQUIRED`'s default `"1"` in
`cloudflare.config.ts` (`tests/admin-keys.ts` runs with it on;
`tests/admin-open.ts` checks it off). Everything below describes the
requirement while it's on.

Everything that administers, edits or deploys the server itself needs more
than a GitHub sign-in: an admin must also have **unlocked admin access**, by
signing a one-time challenge from the server with an SSH key they added
themselves. An unlock lasts an hour. Ordinary documents (reading, editing,
sharing, publishing them) don't need it.

**What needs an unlock** (the audit; each refuses a locked admin with 403
and `{ error, locked: true }`, or sends them to unlock first):

| surface | where |
|---|---|
| `/admin`, `POST /admin/settings`, `POST /admin/users` | `admin.ts` |
| the admin tools (`list_settings`, `set_setting`, `reset_setting`, `list_users`, `add_user`, `set_user_role`, `set_user_deploy`, `remove_user`) over `/api/ext/tools`, `/mcp` and the editor's agent | `server-tools.ts`, `server-api.ts` |
| `dir.config.list/set/reset`, `dir.users.list/add/setRole/remove`, whatever calls them | `Users.mustAdmin` (`users.ts`, `config.ts`) |
| `/api/factory/...` (not the VMs' own task tokens, nor factory tokens, below), the factory's agent and minting factory tokens | `worker/factory.ts` |
| `/admin/factory` (the board, the dashboard and the agent), `GET /api/source/branches`, `POST /api/source/merge`, `POST /api/source/mirror` | `worker/source.ts` |
| `/git/erga.git` (clone, fetch, push) | `worker/source.ts` |
| `GET /api/deploys`, `POST /api/deploys/<name>` (redeploy), `/log`, `/history`, `GET /api/events` | `worker/deploys.ts` |
| `POST /api/docs/<id>/home` (choosing the homepage), `POST /api/docs/<id>/home/deploy` | `home.ts` |
| editing the homepage document (its room, publishing, agents): its scripts run on this site itself, as whoever views it | `Directory.homeLimit` |
| adding and revoking admin keys | `admin-access.ts` |

Not covered, on purpose: `/api/deploys/<name>/hook` and `/api/snapshot/...`
(server to server, with `DEPLOY_HOOK_SECRET` and `SNAPSHOT_TOKEN`); the
factory VMs' `fct…` and `fgt…` tokens (one task, one branch, minted by the
factory for a task an unlocked admin started); factory tokens (`erga_factory_…`,
"Share with agent" on `/admin/factory`: made by an unlocked admin, they only
create, read and instruct factory tasks, and end with the key that unlocked
the admin who made them); `/deploy` (it deploys a copy
to the person's own Cloudflare account, and changes nothing here); `/__erga/...`
(local development only, with the dev server's secret).

**How it works** (`sshsig.ts`, `admin-keys.ts`, `admin-access.ts`; tables
in `migrations/0110_admin_keys.sql`):

- *Keys.* An admin adds public keys on `/admin/keys`. A key belongs to the
  admin who added it, and only they can unlock with it; one key can't be
  two admins'. Adding one needs proof of holding it: a challenge naming
  the key's fingerprint, signed with it. ed25519, ECDSA (P-256/384/521),
  RSA (2048 bits or more, `rsa-sha2-256`/`512` signatures, never SHA-1) and
  security keys (`sk-ssh-ed25519`, `sk-ecdsa-sha2-nistp256`, a touch
  required) work; the private key never leaves the admin's computer.
- *Signatures* are OpenSSH's own (`ssh-keygen -Y sign -n erga-admin`),
  verified in the Worker with WebCrypto. The namespace `erga-admin` means
  a signature made for anything else (a git commit, a file) never counts.
- *Challenges* are made by the server for one admin, one purpose (`unlock`
  or `add-key`) and this server's host (so staging's can't be used on
  erga.dev), with a random nonce: `erga-admin unlock host=erga.dev
  login=ada nonce=… expires=…`. Each works once (deleted as it's checked,
  whatever the answer) and for five minutes: no replay.
- *Unlocks.* A signed unlock challenge gives a browser the `erga_admin`
  cookie (HttpOnly, SameSite=Strict, Secure, an hour), valid only with the
  session of the same person; or, with an agent token, an **admin token**
  (`erga_admin_…`, an hour by default, 12 at most) for an agent, a script
  or Git. Both are HMACs with `SESSION_SECRET` (apart from sessions' and
  agent tokens'), name the key that made them, and are checked on every
  request: the key must still be there and still its admin's (remembered
  ten seconds; at once in the isolate that revoked it). Lock now clears the
  cookie; signing out does too. A session carries the unlock as
  `Session.unlocked`, `whoOf` passes it on, and the directory's admin-only
  calls check it (`Users.mustAdmin`, `isUnlocked`).
- *Git, unattended.* `source/git-credential.ts`, Git's credential helper for
  the Git endpoint, makes the admin token at the moment Git asks, with the
  SSH key (through ssh-agent) and an agent token kept in the macOS keychain;
  see [Erga's own source](#ergas-own-source).
- *Agents and scripts.* `ERGA_TOKEN=<agent token> bun admin-login.ts
  https://erga.dev [--key ~/.ssh/id_ed25519] [--hours 1]` asks for a
  challenge, signs it with `ssh-keygen` and prints an admin token. So an
  admin token needs both an agent token (a GitHub sign-in made it) and the
  key. An admin token can't make another.
- *The first key (bootstrap).* An admin with no key may add one without an
  unlock, but only a key listed on their GitHub account
  (`github.com/<login>.keys`), which only they can put there; adding it also
  unlocks the browser. After that, a new key needs an unlock with one they
  already have. Locally (`bun start`) GitHub isn't asked.
- *Revocation.* An unlocked admin revokes their own keys, or any other
  admin's (a lost laptop, a leak). It ends every unlock and admin token made
  with the key at once. Someone made a user or removed loses their keys too.
  Revoked keys stay listed, with who revoked them. `/admin/keys` also shows
  a log: keys added and revoked, unlocks, admin tokens, failed tries.
- *Lockout recovery.* Lost one key: unlock with another and revoke it. Lost
  them all: another admin revokes them, and you add a first key from GitHub
  again. The only admin, with none left: whoever holds the Cloudflare account
  revokes them in D1, then you start again from GitHub:
  `bunx cf d1 execute erga --remote --command "UPDATE admin_keys SET revoked = unixepoch() * 1000, revoked_by = 'recovery' WHERE login = '<you>' AND revoked IS NULL"`.
- *Local development.* `ERGA_ADMIN_UNLOCKED=1` counts every admin as
  unlocked, on localhost only (`isDev`); `tests/host.ts` sets it for the
  tests that aren't about this, and `bun start` leaves it off.

**Threat model.** What it stops: someone with a stolen Erga session cookie
or agent token (an XSS elsewhere, a leaked `.env`, a token pasted into the
wrong agent) can no longer change settings or users, push or merge code,
deploy, use the factory, or edit the homepage; they also need an admin's SSH
private key, and a fresh signature each hour. A prompt injection in a
document can't make the editor's agent use admin tools. A signature can't be
replayed (one-time nonces), moved to another server (the host is signed) or
borrowed from git (the namespace). A database leak gives no working unlock
(it holds only public keys; cookies and tokens need `SESSION_SECRET`).

**What's still weak.**

1. *GitHub is the root for a first key.* Someone who controls an admin's
   GitHub account before the admin adds a key (or after another admin
   revokes all of theirs) can sign in, add their own key to GitHub and
   bootstrap. Add a key soon after becoming an admin.
2. *A machine with Cloudflare credentials deploys erga.dev without an Erga
   key*: `bun run deploy`, `wrangler`, and the Cloudflare dashboard. Pushes
   to GitHub deploy nothing (Workers Builds is off for `erga`), and the task
   queue's pushes go through Erga's Git endpoint with an admin token like
   anyone's. The machine that runs the task queue keeps an agent token in its
   keychain (`source/git-credential.ts`): with that machine's SSH key, it
   pushes to staging. The Cloudflare account and `SESSION_SECRET` remain
   roots of trust outside this scheme.
8. *The deploy tokens are bearer credentials in the Workers* ([Deploys: the
   deploy tokens](#deploys-staging-and-production)). Anyone who runs code in
   a Worker (code merged to its branch, or a dependency it pulls in) can read
   its `CLOUDFLARE_DEPLOY_TOKEN`. Staging's token deploys only
   `erga-staging`; production's deploys `erga` and `erga-staging`; neither
   can make or delete a Worker, nor change a custom domain, route or DNS
   record. But both carry **D1 Write on the whole account**, as Cloudflare
   has no per-database scope: on erga.dev's account, which other projects
   share, that reaches their databases as well as production's. So code
   pushed or merged to `staging` (by an unlocked admin, or a factory task an
   unlocked admin merged) could read or wipe every D1 database in the
   account. The merge is the review. Erga on an account of its own would
   limit this to Erga's databases. Revoke a token on the dashboard (Manage
   Account › Account API Tokens) or make new ones with `bun deploy/setup.ts
   --tokens`.
3. *An unlock is a bearer credential for its hour.* A stolen session cookie
   together with its `erga_admin` cookie, or a stolen admin token, works
   until it ends or its key is revoked. Revoking the key is the only way to
   end an admin token early; there's no per-token revocation.
4. *The homepage runs on this site.* An unlocked admin who views a homepage
   with hostile script gives that script their admin power for the rest of the
   unlock (same origin). Only unlocked admins may edit it, which narrows but
   doesn't close this. An editor tab opened while unlocked keeps its room
   connection writable after the unlock ends, until it reconnects.
5. *Revocation takes up to ten seconds* to reach other isolates (as with
   removing a user).
9. *The factory's agent reads text other agents wrote.* On `/admin/factory`
   an unlocked admin's own agent (`factory/agent.ts`) reads task titles, asks,
   summaries, logs and screenshots, all written by the VMs' Claude Code or by
   whoever queued the task, and any of it can try to steer it (a prompt
   injection). Task #1 kept the admin tools out of the editor's agent for this
   reason; this agent has none of them either. Its tools only queue, read and
   instruct factory tasks (no merge, discard or start, no settings, users,
   pushes or deploys), every call checks again that its admin is unlocked (the
   unlock their page sent last, its key not revoked, still an admin), and its
   prompt says tool answers are information, never instructions. What an
   injection could still do: queue tasks, or send instructions to a task,
   that the admin didn't ask for, for the rest of the unlock. Each task's work
   lands only on its branch, and an admin approves every merge by hand: the
   merge is the review. **Factory tokens** ("Share with agent", for an agent
   such as Claude Code on a laptop) have the same reach and the same risk,
   plus that of any bearer token: up to 12 hours, revocable in the dialog,
   and ended when the key that unlocked their admin is revoked.
6. *The `/deploy` page, server-to-server secrets and the factory's VM tokens*
   are outside this scheme (above). The VMs run code an admin asked for, with
   the branch's push token: the merge is the review.
7. *No second factor beyond the key.* A key with no passphrase on a stolen
   laptop is enough (with the session or an agent token). Security keys
   (`ed25519-sk`), which need a touch, are the better choice.

### Deploys: staging and production

Erga's source has two branches, `staging` and `main` (task #39 hosts it in
Cloudflare Artifacts). The latest `staging` is always deployed to
**staging.erga.dev**, and the latest `main` to **erga.dev**. Each server
deploys itself: when its branch moves, it builds the new head and deploys
it onto its own Worker. Staging is where that is tried first: its own
pipeline builds and deploys its own commit, the same code that will deploy
erga.dev. It shares nothing writable with production, and gets a fresh copy
of production's data on every deploy.

**One pipeline.** Every deploy of Erga goes through `runPipeline`
(`deploy/cloudflare.ts`): /deploy's (a copy on someone else's account),
staging's and production's. Its input is a *target* (an account, a Worker,
a D1 database, the app's domain, the pages' domain, text settings, secrets,
service bindings, and maybe a snapshot to copy in) and a *release* (the
Worker as `cf build` builds it from `cloudflare.config.ts`, the editor's
files and `migrations/`: `deploy/release.ts`). Its output is a live server,
each step reported as it goes. `cloudflare.config.ts` stays the one place
bindings and Durable Objects are declared; each target changes only what's
its own. The targets are `deploy/targets.json` (typed by `deploy/targets.ts`),
which `cloudflare.config.ts` reads for production's names too:

| | production | staging |
|---|---|---|
| branch | `main` | `staging` |
| app | erga.dev | staging.erga.dev |
| Worker (so its Durable Objects) | `erga` | `erga-staging` |
| D1 | `erga` | `erga-staging`, made afresh from production's on each deploy |
| documents' pages | `<id>-<owner>.erga-pages.dev` | `<id>-<owner>.erga-pages-staging.dev` |
| secrets | its own, kept | its own (SESSION_SECRET, its own GitHub app, its own deploy token), kept |

Both are in the same account. Staging's documents' pages have a zone of
their own, erga-pages-staging.dev (task #4): a route
`*.erga-pages-staging.dev/*` to `erga-staging` and a proxied `*` AAAA
`100::` record there (the setup's first deploy makes both), and the zone's
free Universal SSL certificate, which covers `*.erga-pages-staging.dev`.
(Universal SSL covers only one level below a zone, so staging's pages
couldn't be `*.staging.erga-pages.dev` without a paid advanced certificate:
`deploy/setup.ts --certificate` would order one for a domain deeper in its
zone.) staging.erga.dev is a Workers custom domain, whose DNS record and
certificate Cloudflare makes. A deploy to anything but production that would
use production's Worker, database or addresses, or put its pages on or under
production's pages domain, stops before it calls Cloudflare (`guardTarget`),
and a snapshot never goes into its own source.

The steps: check the account; find or make the database (for staging:
delete its old copy and make a new one); copy production's database in
(staging); apply `migrations/`; upload the editor's files; upload the Worker
with its bindings (its database, `DEPLOY_TARGET`, `ERGA_VERSION` = the
commit, `CLOUDFLARE_ACCOUNT_ID`, the `BUILDER` service; secrets kept with
`keep_bindings`, as `cf deploy` keeps them) and its Durable Objects as
declarative exports; its address; its pages' address; wait until the new
release answers at `/api/deploys/version`; copy production's documents in
(staging).

**Building.** A Worker can't run `bun install` or Vite, so a commit is built
in a **Cloudflare Container**: the builder Worker `erga-builder`
(`deploy/builder/`: `worker.ts`, its `wrangler.jsonc`, a `Dockerfile` with
Bun 1.4.2, Node 22 and Git, and `server.ts`), which the servers reach over a
service binding (`BUILDER`) and which has no public address. The pipeline asks
Artifacts for the repo's remote and a 15-minute read-only token
(through the server's own Artifacts binding, `worker/source.ts`; the REST
API, `deploy/source.ts`, only for a server without one, and it needs a token
with Artifacts Read, which the deploy tokens don't have), and the container fetches the commit, runs `bun install
--frozen-lockfile`, `./site.sh` and `bun deploy/release.ts`
(`deploy/builder/build.ts`), and streams its output back, then the release
(`deploy/bundle.ts`). GitHub is not involved. Why this: Workers Builds connects
only GitHub and GitLab repos, and Artifacts' own build-on-push guide runs a
Workflow whose steps are container sandboxes (`@cloudflare/ci`), which is the
same thing with more parts; the builder can move there later without the
pipeline changing. Each build has a container of its own (the pipeline
names it, and up to 4 run at once), so staging and production can build at
the same moment; the container is destroyed when its build ends or is
cancelled. If no container starts (503), the pipeline logs "waiting for the
builder" and tries again, with backoff, for about 5 minutes. A machine builds the same way (`deploy/run.ts`, in a
scratch worktree, with the checkout's packages linked).

**Branches deploy themselves** (`deploy/branches.ts`, in one Durable Object
per server, `Pipeline`, named "deploys": `worker/pipeline.ts`). #39 calls
`deployHook(branch, commit)` (`deploy/index.ts`) after any push or merge
that moves `staging` or `main`. The server whose target is that branch
(`DEPLOY_TARGET`) queues the commit and deploys it in its alarm: build, then
the pipeline on its own Worker. A push while a deploy runs cancels it: the
running deploy stops before its next step (never half way through one; its
build is stopped too, the builder's container killing its commands), is
marked `cancelled`, and the newest waiting commit deploys straight after.
Stopped before the Worker's upload, nothing on the target changed: it stays
on its last good version. Stopped after it, the newer deploy replaces what
went up. A deploy the server's restart interrupted isn't carried on when a
newer one waits: it's cancelled too. Each server passes on the moves it
hears for the other's branch (`POST /api/deploys/<name>/hook`, with
`DEPLOY_HOOK_SECRET`): production tells staging of `staging`, staging tells
production of `main` (so a merge on staging.erga.dev's /admin/factory deploys
erga.dev too). Production never deploys a commit another server names: it
reads `main`'s head from its own view of the repository and deploys that.
**Production may deploy staging itself:** its token may (above), so when
staging's server doesn't take a move or a redeploy passed on to it (it's
down, its last deploy broke it, or it can't deploy itself), production runs
the same pipeline on staging's Worker, from its own `Pipeline` object, and
says so in staging's log and history (`…, deployed by erga.dev`). Staging
never deploys production, whatever it hears (its token can't). A server
deploys itself only with `CLOUDFLARE_DEPLOY_TOKEN` set: without it a push is
noted in its log and nothing is deployed. Both have theirs (staging since
task #2, production since task #3).

**Pushes from this machine: the task queue.** The main checkout's `origin` is
Erga's Git endpoint, `https://erga.dev/git/erga.git` (GitHub is the `github`
remote, a mirror Erga keeps itself). The queue merges into the main
checkout's `main` and pushes it to Erga's `staging`; that push deploys
staging.erga.dev, as any push to staging does. It never moves `main`:

1. Before a merge, the queue fetches origin and merges `origin/staging`
   into the task's branch with `main`. Commits made in Erga (a factory task,
   a push from elsewhere) so come back to `main`, and the push is a
   fast-forward. If that conflicts, the queue stops and the task's own
   agent resolves it (status `needs-agent`, then `tq continue`: AGENTS.md,
   "Merging").
2. After the merge, it pushes `main` to `staging`
   (`remote.origin.push` is `refs/heads/main:refs/heads/staging`, so a plain
   `git push` in the main checkout does the same). The task's log has what
   Erga said (`Erga: staging is now 1a2b3c4`). A refused push undoes
   nothing: the merge stays in `main`, the log says why, and the queue
   pushes again by itself between merges (a queue merge that staging can
   take as a fast-forward) or with the next merge.
3. **Production is a deliberate step**: Merge on erga.dev/admin/factory, or `tq
   release` (`POST /api/release` on the queue: Erga's `main` to `staging`'s
   head, or `tq release <commit>`, one of staging's commits). Agents run it
   only when the user asks. The board's Branches column counts the commits
   that staging has and production doesn't ("2 not released").

**Signing in, unattended** (`source/git-credential.ts`, within [Admin SSH
keys](#admin-ssh-keys)). Git asks the credential helper for the password,
and it answers an admin token: an hour long, made by `admin-login.ts` at
that moment, with the SSH key (`~/.ssh/id_ed25519` through ssh-agent, so a
key with a passphrase signs with no prompt) and an agent token. Both tokens
are kept in the macOS keychain, never in a file or on a command line: the
agent token until it's revoked (on its own it can't administer anything),
the admin token until five minutes before it ends. The queue signs in
(`git-credential.ts login`) before it talks to origin, and its background
fetches use only a token Git already has, so it makes at most one admin
token an hour, and only while it merges or releases. The first time on a
machine there's no agent token: the helper asks erga.dev for one (the device
flow), and the board and `tq watch` show the link to approve it ("origin
sign-in: open https://erga.dev/tokens/approve?code=… and approve it"). That
one approval is the only step a person takes; after it, nothing asks again
unless the token is revoked (then it asks again, the same way).
`bun source/git-credential.ts status` says what it holds; `forget` drops it.

The queue sets the main checkout up itself, when it starts (or at its next
fetch, if it can't yet): only when no merge runs and the checkout is clean
on `main`, and only its remotes and credential settings change. `origin`
becomes Erga's endpoint and the old `origin` is renamed `github` (refs
included); `main` pushes to and tracks `origin/staging`; Git uses only the
helper for erga.dev (`credential.https://erga.dev.helper`, set to `""` then
the helper, so the keychain's own helper never keeps an ended token).
`TASK_QUEUE_ORIGIN=""` leaves the remotes alone.

Why erga.dev's endpoint and not staging's: the admin keys and agent tokens
are production's (staging's database is a copy, with its own
`SESSION_SECRET`, so production's tokens don't work there), and a bad
staging deploy can't break the way pushes reach it. Both servers proxy the
same repository, and production's pipeline tells staging of the push (or
deploys it itself).

A server deploying itself is restarted by its own new version part way
through: Cloudflare resets a Worker's Durable Objects when a version goes
up. So each step's end is kept in storage, an alarm is set just before the
Worker's upload, and the new version picks the deploy up where the old one
stopped (it checks the Worker's `ERGA_VERSION` to know the upload went
through): the address, the pages, waiting for the new release, copying the
documents. A deploy stopped before the upload is marked failed
("interrupted") and runs again from the top by itself, up to three times in
all (`ATTEMPTS` in `deploy/branches.ts`); after that, Redeploy runs it
again. Every step is safe to repeat. The build's release (~15 MB, one line
of the builder's stream) is read in one pass and its files decoded natively:
reading it the slow way reset the `Pipeline` object right after each build
(13 to 23 s of CPU and hundreds of MB of garbage in its 128 MB isolate). Changing a secret on the Worker (`bunx cf workers secrets update`,
the setup) is a new version too, and resets the `Pipeline` object up to a
minute later: change secrets when no deploy runs, or the running one is
interrupted and starts again from the top.

**Staging's snapshot of production.** On each staging deploy:

- **D1:** staging's database is deleted and made anew, production's is
  exported with D1's export API (read-only on it; D1 holds production's
  writes for the moment it takes) and loaded with D1's import API, then the
  commit's own migrations run on it, as they will on production.
- **Durable Objects:** each document's storage (its files, folders, meta,
  the room's Yjs state, and its expiry alarm) is read from production's
  read-only endpoint, `POST /api/snapshot/docs` (`DocHost.exportStorage`:
  `storage.list` and `getAlarm` only, nothing opened or written), and written
  into staging's through staging's import endpoint (only where
  `SNAPSHOT_IMPORT` is 1, and never on production, whatever its settings
  say), ten at a time, behind the shared `SNAPSHOT_TOKEN`
  (`deploy/snapshot.ts`). Documents staging had that production doesn't are
  emptied. Old staging data isn't kept.
- **Secrets** aren't copied: staging has its own.

What isn't copied, or doesn't carry over: sign-ins (sessions are signed
with production's SESSION_SECRET: people sign in to staging again, with its
own GitHub app); agent tokens (their rows are copied, but a token is an HMAC
with the server's secret, so production's don't work on staging; make new
ones there); edits a room still holds in memory and hasn't written yet (a
few seconds' worth); documents made after the database's copy (not in its
directory) or deleted before the documents step (listed, but empty); /deploy
sessions; staging's own deploy record (kept); the homepage's deployed
snapshot (the `Home` object: staging makes its own from the same document). The source repo is shared, not
copied. Before production runs this version with `SNAPSHOT_TOKEN` set, the
documents step is skipped, and says so.

**The deploy tokens** (`deploy/tokens.ts`). Each server deploys with its own
Cloudflare API token, its `CLOUDFLARE_DEPLOY_TOKEN` secret, made by
`deploy/setup.ts` through the API (an account-owned token), checked, and
stored on the Worker; nobody copies or pastes it, and it's never printed. The
rules are `deploys` in `deploy/targets.json`: production's server may deploy
staging and production, staging's may deploy staging only.

| permission | staging's token (`erga-deploy-staging`) | production's (`erga-deploy-production`) | what for |
|---|---|---|---|
| Individual Workers Editor (Specified Workers) | `erga-staging` | `erga`, `erga-staging` | upload and deploy versions, secrets (kept), static assets, settings; its Durable Objects inherit it. It can't make or delete a Worker |
| D1 Write | the account | the account | staging's database deleted and made afresh from production's export; migrations |
| Zone Read, Workers Routes Read, DNS Read | erga.dev, erga-pages-staging.dev | erga.dev, erga-pages.dev, erga-pages-staging.dev | find the zones; check the custom domain, the pages' route and DNS record are there and point at the Worker |

**Writing Erga's source (the factory).** No token carries an Artifacts
permission, on purpose: each server writes Erga's Artifacts repository
through its own **Artifacts binding** (`ARTIFACTS`, namespace `erga` only:
`worker/artifacts.ts` mints one-hour tokens for the one repo), and the
factory's VMs, pushes and merges all go through the server's Git endpoint
(`/git/erga.git`), which holds Erga's rules. An Artifacts API token would
reach every repository in the account's namespaces and bypass those rules.
The pipeline keeps the binding on every deploy of Erga's own targets
(`Target.artifacts`), and `deploy/setup.ts` checks staging has it.

Nothing else: no account read, no Workers Scripts on the account, nothing on
the builder (a service binding needs no permission on the Worker it binds),
no Artifacts (the servers read and write Erga's source through their
Artifacts binding, and the factory pushes through the server's Git endpoint:
[Erga's own source](#ergas-own-source)), no write on DNS, routes or custom
domains. The setup's first deploy, with your own credential, makes the
Worker, its custom domain, the pages' route and their DNS record; a deploy
after that only reads them (the pipeline reads before it writes, and writes
only what's missing), so no deploy token can move erga.dev, a route or a
DNS record. A token can name only a Worker that's there, so staging's token
is made after its first deploy, and production's after `erga-staging` exists.

Before storing a token, the setup checks it with the token itself: it's
active; it reads each of its Workers' settings, the D1 list, and its zones'
routes and DNS records; it can't read or write the Workers it mustn't reach
(staging's: `erga`), make a Worker, or write a DNS record or a route (asked
with an empty body, which Cloudflare refuses before doing anything; a 403 is
the answer it must get); and its policies, read back, are exactly the plan.
A token that fails is deleted, not stored. Making them needs your credential
to be allowed to make account API tokens (`deploy/credential.ts`: the cf
CLI's login asks for `account_api_tokens:create`, or an API token with
Account API Tokens Write); `bun deploy/setup.ts --tokens` makes them again
(rotation: the old ones by the same name are deleted once the new one is
stored).

What's left (the residual risk): **D1 Write is account-wide.** Cloudflare
has no per-database scope for D1 yet (Workers roles don't cover bound
resources), so each deploy token can read, change and delete every D1
database in the account: production's, and, on a shared account such as
erga.dev's, other projects' databases too. The code only ever exports
production's database and only writes staging's, and the tests check every
call, but code on the `staging` branch runs with staging's token: whoever can
put code on staging (an admin's push, a factory merge) could reach every
database in the account. Moving Erga to a Cloudflare account of its own
limits that to Erga's two databases. A deploy token also can, within its
Workers: replace them, change or delete their secrets, and read or wipe
their Durable Objects (documents). Staging's can do that to staging only;
production's to both.

**Status.** `GET /api/deploys` (admins with admin access unlocked: the browser's, or an admin token)
answers `{targets: [{name, host, branch, state, commit, deployId,
liveDeploy, at, error, log, deployed, pending, steps, self}]}`: `state` is
`idle`, `building`, `deploying`, `deployed`, `failed` or `cancelled`; `log`
the last lines. `?history=N` adds each target's last N deploys (`history`). Another server's
target is that server's own answer when it gives one (`remote`).
`POST /api/deploys/<name>` redeploys that target's branch head now (on
production, `staging` is passed on). `GET /api/deploys/<name>/log` (admins)
is the latest deploy's whole log, `{deployId, commit, state, trigger,
started, ended, error, live, lines: [{at, text, step?}]}`, and
`?deploy=<id>` any past deploy's: each line with its time (ms) and its step (`build`, or one
of the pipeline's), the first and last 2,500 lines if it's longer. It's kept
in storage as it grows, so one deploy's log runs on across the restart its
own upload causes; another server's target's log comes from that server.
**History:** `GET /api/deploys/<name>/history?limit=N` (default 20) is a
target's deploys, newest first, `{target, deploys: [{id, commit, state,
started, ended, trigger, error, supersededBy?, replacedBy?, live}]}`:
`trigger` says what started it (`push by ada`, `merge by ada`, `redeploy by
ada`, `…, passed on` when another server passed it on), a cancelled one
names the commit and deploy that took its place. The last 100 of each
target, and their logs, are kept in the `Pipeline` Durable Object's storage
(older ones' logs deleted); another server's history comes from that server.
`/api/events` (admins) is server-sent events: `{type: "deploys"}` on each
change, `{type: "deploy-log", target, deployId, lines}` with each deploy's
new lines as they arrive (for a live log), and others put there with
`publishEvent` in `deploy/index.ts` (#39's `{type: "source"}`).
`GET /api/deploys/version` (anyone) is the release the server runs. The
dashboard is **/admin/factory**: the commits, one dot column beside them
(a solid green circle: on main too; a hollow orange one: only on staging),
and each target's deploys beside the commit each deployed (one for each
commit: the running one, else the live one, else the newest; its state as
plain text, and only the live one with a background),
any deploy's log, past or live, in a modal;
`/admin/deploys` (and `/source`) redirect there.

**The branch model.** There are only two branches, and `staging` is always
at or ahead of `main`: `main` only fast-forwards to a commit of `staging`
(#39 refuses anything else). The pipeline relies on nothing more than that a
branch's head is a commit on that branch: the builder fetches the branch and
checks the commit out, which a fast-forward keeps reachable; production
builds the commit itself (it doesn't take staging's build), and a push to
`main` never makes staging deploy.

Locally, `ERGA_DEPLOY_MOCK=1 ERGA_DEPLOY_TARGET=staging bun start` makes the
dev server staging, deploying into the mock Cloudflare's copy of Erga's
account (`deploy/mock.ts`, `fleet`) with a mock builder; a push is
`curl -X POST -H "Authorization: Bearer mock-hook-secret-0123456789abcdef"
-d '{"branch":"staging","commit":"<40 hex>"}' localhost:4400/api/deploys/staging/hook`
(a commit starting `0bad`, or whose subject has `[mock-fail]`, fails to
build). The other target's server (production, here) is played in the same
Durable Object, at its host in the mock, so a merge to main on /admin/factory
deploys "production" too, and both columns fill.

#### Runbook: staging and production, and their deploy tokens

Each step is yours to run or approve; `deploy/setup.ts` asks before each
change, and `--dry-run` shows the plan (and exactly what each token grants)
without doing anything. It uses your own credential: `CLOUDFLARE_API_TOKEN`
if set, else the cf CLI's login (`bunx cf auth login`; `--force` once if your
login is older than the `account_api_tokens:create` scope).

Done on erga.dev's account (2026-10-04, task #2): the Artifacts repo
`erga/erga`, the builder, staging's secrets, SNAPSHOT_TOKEN and
DEPLOY_HOOK_SECRET on production, `erga-staging` with its own D1 copy of
production's data, staging.erga.dev and its pages' route and DNS record
(on erga-pages-staging.dev since task #4, step 9), staging's deploy token (made with a short-lived token
maker, then deleted), and staging deploying itself on a push to its branch.
Still to do are the steps marked *(you)*.

1. **Merge this to `main`** (task #2; then Workers Builds still deployed
   erga.dev from GitHub, until step 8).
2. **Staging's GitHub OAuth app** *(you: GitHub has no API for OAuth apps)*.
   At github.com/settings/applications/new: homepage
   `https://staging.erga.dev`, callback
   `https://staging.erga.dev/auth/github/callback`. Put its Client ID in
   `deploy/targets.json` (`targets.staging.vars.GITHUB_CLIENT_ID`) and
   commit; set its client secret on staging:
   `bunx cf workers secrets update GITHUB_CLIENT_SECRET --name erga-staging`
   (or answer the setup's question). Until then nobody can sign in to staging.
3. **Run the setup:** `CLOUDFLARE_ACCOUNT_ID=<id> bun deploy/setup.ts`. It
   checks the account and zones; makes the Artifacts repo if it's missing;
   deploys the builder (`bunx wrangler@4.147.0 deploy` in `deploy/builder`,
   with Docker running) if it's missing, or with `--builder`; makes
   staging's secrets (SESSION_SECRET kept if there's one; SNAPSHOT_TOKEN and
   DEPLOY_HOOK_SECRET new, set on production's Worker too: a new version of
   the same code); builds HEAD here and deploys staging (`erga-staging`, its
   D1 made afresh with production's data, staging.erga.dev,
   `*.erga-pages-staging.dev`); then makes **staging's deploy token**,
   checks it and stores it on `erga-staging` (above). Staging's pages need
   no certificate of their own: the zone's Universal SSL covers them.
4. **Staging's deploy token** *(you, if step 3 stopped there)*. The cf
   CLI's OAuth login can't make API tokens (Cloudflare doesn't grant it that
   scope), so make a short-lived **token maker** on the dashboard: Manage
   Account › Account API Tokens › Create Token › Custom, one permission,
   Account › Account API Tokens › Edit, a TTL of today. Then
   `CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_TOKEN_MAKER="$(pbpaste)" bun deploy/setup.ts --tokens`.
   The setup checks the maker first (an account-owned token, active, allowed
   to make tokens; otherwise it says which of these is wrong), uses it only to
   make, read back and delete tokens, and uses your cf login for the rest.
   Delete the maker afterwards.
5. **Seed the source** (once): the repo is empty until the history is in.
   Push `main` and `staging` through a server's Git endpoint
   (`ERGA_TOKEN=<admin token> bun source/import.ts https://staging.erga.dev`,
   which needs step 2 to sign in), or straight to Artifacts with a write
   token from its API (the setup's credential can make one), then tell
   staging (`POST /api/deploys/staging/hook` with DEPLOY_HOOK_SECRET; a push
   through the Git endpoint does that itself).
6. **Verify it.** https://staging.erga.dev/api/deploys/version answers
   staging's release; https://staging.erga.dev/admin/factory (signed in) shows the
   commits and both targets. erga.dev is unchanged.
7. **Staging deploys itself.** Push a commit to staging (`git push
   https://staging.erga.dev/git/erga.git HEAD:staging`, an admin token from
   `bun admin-login.ts https://staging.erga.dev` as the password; or merge a
   factory task). Watch `/admin/factory` or `/api/deploys/staging/log`: the builder
   builds it, the pipeline deploys it with staging's own token, the server
   restarts into the new version and finishes, and `/api/deploys/version`
   says the new commit.
8. **Production deploys itself** (done on erga.dev, 2026-10-04, task #3):
   - Workers Builds' trigger for `erga` deleted (`bunx cf builds triggers
     list --external-script-id <erga's tag>`, then `bunx cf builds triggers
     delete <uuid>`): a push to GitHub deploys nothing now.
   - A new `DEPLOY_HOOK_SECRET` on both Workers (`bun deploy/setup.ts
     --hook-secret`; since task #5 nothing on a machine needs it).
   - erga.dev deployed once from a machine (`bun run deploy`, which asks you
     to type "production"): the pipeline adds the `BUILDER` and `ARTIFACTS`
     bindings and `ERGA_VERSION`.
   - Erga's `staging` and `main` brought to GitHub's `main` (with
     `deploy/publish.ts`, removed in task #5: the queue now pushes to Erga's
     Git endpoint itself).
   - Production's deploy token made with a short-lived token maker, checked
     and stored on `erga` (`CLOUDFLARE_TOKEN_MAKER=… bun deploy/setup.ts
     --tokens --production`, answering no to staging's token). It also reads
     `erga-pages-staging.dev`, staging's pages zone (task #4). The maker
     was kept for task #4, then deleted.
   - `migrate.ts` and the `WORKERS_CI` lines in `site.sh` removed.

   To go back to Workers Builds (if ever): make the trigger again (build
   `./site.sh`, deploy `bunx cf deploy`, branch `main`) and set
   `TASK_QUEUE_PUBLISH=""`. To roll erga.dev back to an earlier version:
   `bunx cf workers deployments create --worker erga --strategy percentage
   --versions '[{"version_id":"<id>","percentage":100}]'` (ids from `bunx cf
   workers versions list --worker-id erga`).
9. **Staging's pages on their own zone** (done on erga.dev, 2026-10-04,
   task #4): `erga-pages-staging.dev`, bought for it, so the zone's free
   Universal SSL certificate covers `*.erga-pages-staging.dev`.
   - `targets.staging.pages` in `deploy/targets.json`: zone and domain
     `erga-pages-staging.dev`. `guardTarget` refuses a non-production
     target whose pages are on or under `erga-pages.dev`.
   - Staging's deploy token made again with read on the new zone. Until
     staging ran this code it also read erga-pages.dev (an older commit's
     deploy, resumed on its own code, reads its old pages zone); after the
     merge it was made again without (`setup.ts --tokens`).
   - Staging deployed once from a machine with the task's code (the
     pipeline without the snapshot, keeping staging's data), which made the
     `*.erga-pages-staging.dev/*` route to `erga-staging` and the proxied
     `*` AAAA `100::` record on the new zone.
   - After the merge, the old `*.staging.erga-pages.dev/*` route and DNS
     record on erga-pages.dev deleted.

### Deploy your own

`/deploy` puts a copy of the server on someone's own Cloudflare account,
with the same settings erga.dev has, and them as its admin. Who may use it
is the `deploy_page` setting: `users` (anyone signed in, the default),
`admins` (and users with the deploy role, granted on `/admin/users`), or `off`; anyone it doesn't let in gets "not found". It's a page of its own, not
an admin page: the user menu links to it for those it lets in, admin
settings don't list it, and `/admin/deploy` redirects to it. Using it gives
no admin rights: someone who isn't an admin still can't read or change the
server's settings, its users, its source or the factory. Its breadcrumbs sit after the wordmark in the upper left.

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
directly through the one deploy pipeline (`deploy/cloudflare.ts`,
`runPipeline`, with the plan as a target in their account: see [Deploys:
staging and production](#deploys-staging-and-production)): no CLI, no
container. It deploys a
*release*: this server's own Worker as `cf build` builds it (its modules,
static assets and `worker.config.json`, so the bindings and Durable Objects
follow `cloudflare.config.ts`; the landing project is built into it) and the
migrations, made by `bun deploy/release.ts` into `.site/release/` (site.sh does it on Workers
Builds, and the builder for every branch deploy; the Worker reads it from its assets, and
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

### Erga's own source

Erga's canonical repository is hosted by Erga itself, in Cloudflare
Artifacts ("versioned storage that speaks Git": each repository a Durable
Object running a Git server). One repository, `erga`, with two branches:
**staging** and **main**, and never any other. Staging is always at or
ahead of main, and main only follows staging: edits are pushed to staging,
which deploys to staging.erga.dev; then main moves forward to staging (or to
one of its commits), which deploys to erga.dev. So the two never diverge:
there are no merge commits or conflicts between them. GitHub
(github.com/koomen/erga) stays, as a mirror. Deploys build from Erga (the
deploy pipeline's `deployHook`, below).

**How Erga uses Artifacts.** Through the Worker's Artifacts binding
(`ARTIFACTS`), for two things only: the repository's Git remote
(`repo.info().remote`) and short-lived repo-scoped tokens for it
(`repo.createToken("read" | "write", 3600)`, kept until ten minutes before
they expire; `worker/artifacts.ts`). Everything else is plain Git over
HTTPS, the protocol every git client speaks (`source/remote.ts`: protocol
v2's `ls-refs` and `fetch`, and v0's `receive-pack`). Not the REST API: that
needs a Cloudflare API token with Artifacts Edit as a secret, which can do
far more than one repository's tokens. And Erga proxies Git itself, with its
own sign-in in front, rather than handing out Artifacts' remote: Artifacts'
tokens don't know Erga's admins, Artifacts can't hold Erga's rules (two
branches, main only forward), and every branch move must go through Erga so
it can tell the Factory page, the deploy pipeline and the mirror.

**The Git endpoint**, `https://<server>/git/erga.git` (`worker/source.ts`,
`source/http.ts`): clone, fetch, pull and push, over Git's smart HTTP. Git
asks for a username and password: any username, and an admin token as the
password (`ERGA_TOKEN=<agent token> bun admin-login.ts https://erga.dev`,
see [Admin SSH keys](#admin-ssh-keys)); admins only (no token, an agent
token, or one that ended or whose key was revoked: 401, which makes git ask;
a user who isn't an admin: 403).

    git remote add erga https://erga.dev/git/erga.git
    git fetch erga
    git push erga HEAD:staging

Or let Git make the admin token itself, each time it needs one, with
`source/git-credential.ts` as its credential helper (below, "Pushes from this
machine"): the main checkout is set up so.

Clones and fetches stream straight through to Artifacts with a read token.
A push is Erga's (`source/repo.ts`, `SourceRepo.receive`, in one Durable
Object, `SourceHost`, `worker/source-host.ts`, so pushes and merges happen
one at a time): Erga advertises only staging and main; a push to anything
else, or a delete, is refused; the objects go to Artifacts under a
quarantine branch (`refs/heads/erga-incoming/<id>-<branch>`); Erga reads
the new commits back and checks them (main takes fast-forwards only, even
`--force`); then it moves each branch from where it
was (Artifacts refuses a move whose old value is stale, so two pushes at
once can't lose one) and drops the quarantine branches. The checks: a push
to main must be one of staging's commits (staging's new head counts, when the
same push moves both: `git push erga HEAD:staging HEAD:main`) and forward of
main; a push to staging, even `--force`, must keep every commit main has
(rewriting what's only on staging is fine). `git push` shows
what happened (`remote: Erga: main is now 1a2b3c4 (3 new commits).`).

Erga keeps an index of the commits (parents, subject, author, times) in
that Durable Object's SQLite: "is this a fast-forward", "where do these
branches meet" and "the last 25 commits" never ask Artifacts. Commits never
change, so it's a cache that's always right; anything missing (a push made
straight to Artifacts) is fetched from Artifacts when it's needed.

**Merging**, `POST /api/source/merge { from: "staging", to: "main", commit? }`
(admins; the Factory page's Merge button, and a commit's Merge to here):
main moves forward to staging's head, or to `commit`, one of staging's
commits it doesn't have yet. Always a fast-forward; `from` and `to` can only
be staging and main. Answers `{ commit, fastForward, upToDate }` or `{ error }`.

**The GitHub mirror.** After each branch move, in the background, Erga
pushes staging and main to GitHub (`GITHUB_MIRROR_URL`, github.com/koomen/erga
by default, with the `GITHUB_MIRROR_TOKEN` secret: a token that may push
there). A failure is recorded and shown, never blocks a push or a merge.
main moves on GitHub only forward: if GitHub's main has commits Erga
doesn't (someone pushed there directly), the mirror stops for main and
says so, rather than drop them; pull them into Erga's main and it carries
on. With no token there's no mirror (the page says so). `POST
/api/source/mirror` runs it now.

**The Factory page**, `/admin/factory` (`source/page.ts`, admins with admin
access unlocked; breadcrumbs Erga › Admin › Source): the one place to manage
the source, its deploys and the factory. Three parts on one page: the factory's
task board ([The factory](#the-factory-experimental)), this dashboard, and the
factory's own agent. On a wide window the agent sits on the left, as in the
editor, with the board above the dashboard beside it; narrower than 1000px,
tabs (Tasks, Source, Agent) show one at a time. Each part's stylesheet is
scoped to its pane (`scopeCss`: its width queries measure the pane, so the
board keeps its five columns beside the agent). `/source`, `/admin/factory`
and `/admin/deploys` redirect here. The dashboard: One list, staging's last 25 commits,
newest first, with two dot columns beside it, as the task queue board's
Branches column draws them: staging's (a hollow orange circle for a commit
only on staging, a solid green circle for one main has too) and main's (a
solid green circle where main has it). Circles only, no other shapes. Then
two deploy columns, staging and production: a "live" mark on the commit each
target has live ("building", "deploying" or "failed" on one in progress),
and each target's status in the column's head, from `GET /api/deploys`;
clicking it opens that deploy's log, live (`GET /api/deploys/<name>/log`,
then `{ "type": "deploy-log" }` events). Merge moves main to staging's head;
hovering a commit only on staging offers Merge to here. Also the mirror's
status: clicking it opens the GitHub sync dialog, with Push now while the mirror is on, or the steps that turn it on (the token, the `GITHUB_MIRROR_TOKEN` secret on this server's Worker) while it is off (`bun tests/source-mirror.ts` tests it). Then the last moves, and the `git remote add` lines. It
updates by itself, on the deploy pipeline's event stream, `GET /api/events`
(one hub for admins' pages, `worker/deploys.ts`): `{ "type": "source" }` when
a branch moves or the mirror's status changes (`publishEvent` in
`deploy/index.ts`), `{ "type": "deploys" }`, and `{ "type": "deploy-log",
target, deployId, lines }` for an open log. Live log lines come as events
only from the server running the deploy (staging's runs on staging's own
server), so while a deploy runs and no events arrive, the open log asks for
`GET /api/deploys/<name>/log` every two seconds.

`GET /api/source/branches` → `{ branches: [ { name, commit, commits: [ {
sha, subject, author, email, at, parents, inMain } ], ahead } ], mirror: {
url, lastPushAt, error, state, refs }, moves, remote }`. The API takes the
app's session or an admin token (Bearer), with admin access unlocked either
way; a POST with the session alone must come from this site's pages.

**For the deploy pipeline.** After every push or merge that moves a branch,
the repository calls the pipeline's `deployHook(branch, commit, env)`
(`deploy/index.ts`). To read a commit for a build, the pipeline asks
`sourceForBuild(env, commit)` (`worker/source.ts`, through the Artifacts
binding; the REST API, `deploy/source.ts`, only on a server without one): it
answers the
repository's Git remote with a read token (an hour; Bearer, or HTTP Basic
with any username), for `git clone` in a build environment, and
`archive()`, the commit's files as a tar, read through Erga. The commit
should be a branch's head (Artifacts lets those be fetched).

**Locally**, Artifacts has no local mode (miniflare's binding only proxies to
the real service), so `bun start` stands in for it: the dev server serves a
bare repository with Git's own `git http-backend`
(`/__artifacts/git/erga/erga.git`, in `.cloudflare/state/artifacts/`,
`dev/git-server.ts`), taking repo tokens as Artifacts does (read or write,
with an expiry) that the Worker mints the same way, and a pretend GitHub
for the mirror (`/__github/koomen/erga.git`). Local development never
reaches the real Artifacts or GitHub. Seed it from your checkout:

    ERGA_TOKEN=erga_... bun source/import.ts http://localhost:4400 --from .

`bun test tests/source.test.ts` tests the Git formats, pushes and the
branch model, merges and the mirror against real git without a Worker; `bun tests/source.ts` tests
it end to end on a dev server (auth, `git clone`, `git push` and `git pull`,
the branch model, merges, the mirror, and the Factory page in headless
Chrome: the dots' shapes and colours, the deploy columns, the live log,
Merge to here, light, dark and a phone; `--keep` leaves it running).

**Setting it up on erga.dev**, once:

1. Make the repository (Workers Paid plan; Artifacts makes the namespace
   with it): `bunx wrangler artifacts repos create erga --namespace erga
   --default-branch main` (or the dashboard: Storage & databases ›
   Artifacts).
2. Make a GitHub token that may push to koomen/erga (a fine-grained token,
   Contents: read and write) and set it: `bunx cf workers secrets update`
   `GITHUB_MIRROR_TOKEN`.
3. Set `ERGA_ARTIFACTS_NAMESPACE=erga` in the deploy's environment (Workers
   Builds' build variables) and deploy: `cloudflare.config.ts` then binds
   `ARTIFACTS` and the mirror. Branch deploys and `deploy/run.ts` do this
   themselves: the build (`deploy/builder/build.ts`) sets it from the
   commit's own `deploy/targets.json` (`source.namespace`), and the pipeline
   puts the binding only on Erga's own targets (never on a `/deploy` copy).
   No API token is involved: the binding is the server's access, and a
   deploy token needs no Artifacts permission.
4. Seed it with the whole history, through Erga: `ERGA_TOKEN=<an admin
   token> bun source/import.ts https://erga.dev` (from GitHub's main).
   It refuses if main is already there.
5. Point your checkouts at it and push there; GitHub follows. The task queue
   does this for the main checkout itself ([Pushes from this
   machine](#deploys-staging-and-production)); by hand:

       git remote rename origin github
       git remote add origin https://erga.dev/git/erga.git
       git config remote.origin.push refs/heads/main:refs/heads/staging
       git config credential.https://erga.dev.helper ""
       git config --add credential.https://erga.dev.helper "!bun $PWD/source/git-credential.ts"

Limits: a push is read whole into memory (at most 100MB); a clone during a push can briefly see the
quarantine branch; the commit index loads every commit's parents, which is
fine for Erga's thousands but not for millions.

### The factory (experimental)

The factory is the task queue (`development/task-queue/`) inside Erga, on
`/admin/factory`, the Factory page (with the source dashboard and the factory's agent;
`/admin/source` and `/source` redirect there): the same board (Queued, Working, Ready to merge and Merging,
with `needs agent` cards in Merging; merged tasks leave the board), but each task is done by Claude Code in a VM of its own, not on
this machine: on staging.erga.dev and erga.dev a Cloudflare Container
([On Cloudflare](#on-cloudflare), below). It's a prototype: admins only, and
off until an admin sets the `factory` setting to `on` (`/admin`). It does
background tasks only; live mode stays on the user's own computer, with the
local queue.

**A task is a branch.** Adding a task names its branch
`task/<id>-<slug>` (as the local queue does) and starts a VM. In the VM
(`factory/vm/run.ts`) the task's job clones Erga's repository, makes the
branch from staging and pushes it at once, installs the dependencies, and
runs Claude Code (`claude -p`, unattended) with the task's prompt
(`factory/prompt.ts`: AGENTS.md's worker prompt, with `task` in place of
`tq`). Claude Code works on the clone, runs the app headless (`task
preview`: `bun start` in the VM), takes screenshots with headless Chromium
(`task shot`), commits, and says `task done "summary"`, which pushes the
branch and moves the card to Ready to merge. Then the VM waits: its preview
stays up, and the detail view takes more instructions ("Send to Claude
Code"), which run Claude Code again on the same branch (`--continue`).
The detail view takes instructions **while the task works**, too (the API's
`revise`, the agent's `instruct_task`): the factory keeps them for the task
(its log says "<who> asked, while it works: ..."), and its Claude Code gets
them when its current step ends, in the same session, with all its work.
`run.ts` asks the factory every 5 seconds whether some wait; Claude Code's
hooks (`task.ts hook`, after each tool call and when it would stop, set in
`~/.claude/settings.json` by `common.ts`, `prepareClaude`) then take them,
each one once, and the log says "Claude Code got the instructions from
...". If one command still runs a minute after they came
(`LIMITS.instructionsWait`), `run.ts` stops that command only (the
processes Claude Code started for it, not Claude Code), and Claude Code
gets them with a line that says which command was stopped, so it can run it
again if it still needs it. A subagent's tool calls don't take them: the
main Claude Code gets them when the subagent ends. A run that says done or
fails before it got them doesn't finish the task: the factory gives them
to a new run, on the same branch (`--continue`).
**Restart** works on any task that has run and isn't merged or discarded:
working, ready to merge, failed, merging, needs agent, or stuck. It runs the
task again on the same branch. First the old VM, if it is still up, saves
the work (`merge.ts save`): it stops Claude Code and the preview, drops an
unfinished merge, commits anything not committed ("Work in progress …,
saved by the factory before a restart") and pushes the branch. Then the old
VM stops, and a fresh VM, with a fresh git token, starts Claude Code in a
new session (`run.ts restart`) with the task's prompt, a note that it was
restarted, and every instruction sent to it so far, in order (those sent while it worked too)
(`factory/prompt.ts`, `restartPrompt`). The log says who restarted it,
from which state, and what was saved. A merge that was running is dropped
(its answer is ignored), and reports from the old Claude Code are refused.
If the old VM is gone or doesn't answer in 3 minutes, the restart goes on
from what was pushed.
*Merge** works in the task's own VM, in its clone (`factory/vm/merge.ts`):
it stops the preview, merges staging into the branch and pushes it, then
moves staging to a `--no-ff` merge commit of it ("Merge task/…: title"),
deletes the branch and stops the VM; merges run one at a time. A task uses
the same agent from start until merge: when the merge conflicts, or one of
its steps fails or times out, the card goes to **needs agent** (in Merging,
with Merge off and the reason) and the factory wakes the task's own Claude
Code (`run.ts resolve`: the same session, `--continue`, as "Send to Claude
Code" does) with the reason, the log and instructions to resolve, test under
time limits and commit (`factory/prompt.ts`, `resolvePrompt`). When it says
`task done`, the merge runs again by itself; when it says `task fail`, the
task goes back to Ready to merge with its reason. No fresh Claude Code that
doesn't know the task resolves anything. (A VM that was replaced has no
session: then Claude Code gets the task's whole brief first.) The push goes through Erga's Git endpoint,
which tells the deploy pipeline (`deployHook`) as for any push to staging:
staging.erga.dev deploys itself, and the move is recorded as the push of the
admin who pressed Merge. **Discard** deletes the branch and stops the VM.
Branches live only as long as their task, and the Factory page (task #39)
shows only staging and main, so they never appear there.

**Timeouts.** Nothing in a VM waits forever. Every step of a job has a
time limit (`factory/vm/common.ts`, `LIMITS`): git (clone 5 min, fetch and
push 2 min, the rest 1 min), `bun install` 10 min, the preview's start
150 s, a screenshot 60 s, Claude Code's run 3 hours (on a merge, 1 hour).
Each step runs in a process group of its own (`step`): at its limit the
whole tree is killed (TERM, then KILL), and when it ends, whatever it left
in its group is killed too; only the preview (`task preview`, in a session
of its own) outlives it, until the merge stops it. Then the task's Claude
Code is woken with the log: a merge step makes the card `needs agent`
(above); a failed or hung install goes first in Claude Code's instructions;
Claude Code itself, past its limit, is stopped and woken once (`--continue`)
to finish, and the task fails the second time. A clone that fails twice
fails the task (no Claude Code has worked on it yet). The factory waits at
most 30 minutes for a merge job's answer. Claude Code is told
(`factory/prompt.ts`) to run builds, tests and servers under a limit with
`task run --timeout SECONDS -- CMD` (the same process-tree kill, exit 124),
and to leave no processes behind. The merge stops the preview first: on
2026-10-05 a 3-hour-old dev server blocked `vite build` in the local queue.

**Dependencies between tasks** are the local queue's (task #49; the rules
are one file, `development/task-queue/deps.ts`, that both use). A task has
`startAfter` (no VM until those tasks are merged) and `mergeAfter` (it works
now, but doesn't merge until they're merged; `startAfter` counts too): set
on the New task form or `POST /api/factory/tasks`, changed in the detail
view's Dependencies section or `PATCH /api/factory/tasks/<id>`. Ids must
name other tasks, not discarded ones, and a cycle is refused (400). Each
task carries a computed `blockedBy` (`start`, `merge`, `stuck`, `reason`).
Start (`POST .../start`) and Merge answer 409 while blocked; a merge asked
for while its dependency merges ahead of it is allowed, and checked again
when its turn comes (if the dependency didn't merge, it goes back to Ready to
merge, saying why). A discarded or failed dependency blocks its dependents
until someone removes or changes it. The factory has no outer agent, so when
a dependency merges (or is removed) it starts each queued task that no longer
waits, itself; dependents' logs say what happened, and the event stream
sends `{ type: "unblocked" | "blocked" }` (a toast on the board). On the
board: a chip on the card ("waiting for #12", "merges after #12", "blocked by
#12"), waiting tasks at the bottom of Queued with Start off, and Merge off
with the reason.

**Stalled tasks.** A task that is working or needs agent, and whose log has
had no new line in 5 minutes, is *stalled* (`factory/stall.ts`): its Claude
Code may be hung, or in one long step. Its card and its detail view show a
badge ("stalled 12 min") and the detail view says since when; the board
checks again every 30 seconds, and a new log line clears it. The API's tasks
carry a computed `stalled {since, quietMs}`, and `list_tasks` and `get_task`
tell the factory's agent how long the task has been quiet. "Stalled" is not
"blocked": a blocked task waits for its dependencies.

**The factory's agent.** Beside the board, an agent panel like the editor's
(the same panel and conversation, `src/page/agent-chat.ts`; its own code is
`src/page/factory-agent.ts`, built to `factory-agent.js`) talks to the admin's
own agent session (`factory/agent.ts`), one per admin, in the `Factory`
Durable Object, so it keeps working when the tab closes and a reload keeps the
conversation. It queues up work the way the local outer agent uses the task
queue (AGENTS.md): `create_task` (title, ask, `startAfter`, `mergeAfter`),
`set_dependencies`, `instruct_task` (more instructions for a task that
works, is ready to merge or failed), and reads with `list_tasks`, `get_task` (the ask,
summary, error, preview URL, log) and `view_screenshot`; it sees `needs
agent` cards and why, and what the task's Claude Code is doing (its words and
the commands it runs go on the task's log, "Claude: …", "Claude runs Bash:
…", at most every 5 seconds); `factory_status`
says whether the factory is on. It can't merge, discard or start a task:
an admin approves each merge by hand on the board, and Merge merges into
staging, which deploys itself. Each message carries the task open on the
board, if any, so "this task" means something. It acts only for an unlocked
admin, checked on every call; [Admin SSH keys](#admin-ssh-keys) has the risk
(task text can steer it). It runs on the editor agent's models
(`ANTHROPIC_API_KEY`, `ERGA_AGENT_MODEL`). API: `GET`/`POST /api/factory/agent`,
`POST /api/factory/agent/abort|reset|model`, and `{ type: "agent" }` events on
`/api/factory/events`, to that admin only.

**Share with agent.** The button on the board's head makes a factory token
for an outside agent (Claude Code on a laptop, say) and a prompt to paste into
it, as the editor's share button does. Only an unlocked admin in a browser can
make one (`POST /api/factory/tokens { label, hours }`: 1 to 12 hours, shown
once; only its SHA-256 is kept, in the `Factory` object), and the dialog lists
them and revokes them (`DELETE /api/factory/tokens/<id>`). A token also ends
when the admin key that unlocked its admin is revoked, or they stop being an
admin. With `Authorization: Bearer erga_factory_…` an agent reads the guide
(`GET /api/factory/guide`), the factory, its tasks and screenshots, adds tasks
(`POST /api/factory/tasks`), changes dependencies (`PATCH`) and sends
instructions (`POST .../revise`), as "<admin>'s agent (shared: <label>)".
Anything else answers 403: merge, discard, start, the Claude sign-in, the
agent, tokens, events.

Without a signed-in Claude plan, a scripted stand-in (`factory/vm/fake-claude.ts`)
does each task the same way, with a change known in advance (a note under
the front page's heading), so all of it can be tried and tested for free.
It also finishes merges that need it (it resolves conflicts by keeping both
sides' lines, checks under a limit, and says done). For tests, a task's ask
can steer it, with the stand-in only: `[factory-test: hang STEP SECONDS]`
makes a step hang once with that limit (`install`, or a merge step:
`merge:fetch`, `merge:merge`, `merge:push`), `[factory-test: can't resolve]`
makes it give up on a merge, and `[factory-test: resolve after SECONDS]`
makes it wait first.

**Try it locally:** `bun start`, set `factory` to `on` on `/admin`, open
`/admin/factory`, and add a task (or ask the agent to). With Docker running (OrbStack or Docker
Desktop), each VM is a container of the factory's image (built the first
time, a few minutes; then reused); without, a simulation runs the same
scripts in a folder per VM, with a light preview (`ERGA_FACTORY_RUNNER=docker|sim`
picks one). The repository is the dev server's own: a bare repository in its
state folder (`.cloudflare/state/factory/erga.git`), made the first time
from this checkout's HEAD, as staging and main. Nothing is pushed anywhere
else, and no credential of this machine is used: the simulation gives each
job a HOME of its own, and a job gets only the environment the factory hands
it. Measured on a Mac (M-series, OrbStack), with the stand-in:

| step | time |
|---|---|
| a VM starts (image cached; the first build is ~3 min) | 0.2–1.7 s |
| clone, branch from staging, push | 0.5–0.9 s |
| `bun install` from the image's cache | 0.8–1.8 s |
| the preview (the real app, `bun start`, in the VM) is up | ~4 s |
| a screenshot (headless Chromium in the VM) | ~1 s |
| added to ready to merge | ~10 s |
| merge into staging, branch deleted, VM stopped | ~2 s |

`bun tests/factory.ts` tests it end to end with simulated VMs (in
`./test.sh`), and `bun tests/factory.ts --docker` with real containers: off
by default, a task added on the board (branch, VM, change, preview,
screenshot, push), merge, discard, more instructions, the tokens' limits,
the Claude sign-in, and dependencies (bad ids and cycles, a blocked start
with no VM, a blocked merge, the merge-time check, a discarded dependency,
the automatic start on unblock), then `/admin/factory` itself (the layout, the
old pages' redirects, a phone's tabs), the factory's agent with the scripted
model (it queues a task with a dependency, reads it, looks at its screenshot,
sends instructions, has no merge or discard tool), factory tokens (what
they may and may not do, Revoke), and merges that need the task's agent: a
conflict (needs agent on the board, Merge off, the reason, the preview
stopped; the same VM's stand-in resolves it and the merge goes on to
merged), a merge step that hangs (killed at its limit with its process
tree, needs agent, then merged) and an install that hangs (the stand-in is
told and installs again). `tests/factory.test.ts` tests the branch names and
the git tokens' rules. `tests/factory-cards.ts` checks that the board's cards
stay compact, on a board of fixture tasks: a title on one line (the full
title in its tooltip), no branch name (the detail has it), the last update
as a short time on the title's line ("5m"), small buttons on one row, and
the thumbnails; and that the detail view shows the screenshots first, three in
a row, one enlarged to the modal's width on a click and back on a second click,
and the left and right arrow keys going to the previous and next screenshot
(around at the ends) in the grid and in the enlarged view, Escape shrinking
it, and the arrows still moving the cursor in the instructions.
It also types in a task's instructions while live updates of that task arrive:
the redrawn detail view keeps the focus, the cursor, the selection, the unsent
text and the other fields' values (`keepState` in `factory/page.ts`).

**How it fits together.**

- `worker/factory.ts`: the API (`/api/factory/...`, listed at its top) and
  the `Factory` Durable Object ("factory"), which holds every task, its log
  and screenshots, the Claude token, the factory tokens and each admin's
  agent session, and drives the VMs. The board (`factory/page.ts`, a part of
  `/admin/factory`) updates live from its event stream.
- A `VmHost` starts and stops VMs and runs jobs in them. Locally it's the
  dev server (`dev/factory.ts`: Docker or the simulation, and the
  repository); on Cloudflare, Containers (`factory/cloudflare.ts`,
  [On Cloudflare](#on-cloudflare)).
- The image (`factory/vm/Dockerfile`): Bun (`.bun-version`), Node (Vite runs
  on it), git, Chromium, socat, Claude Code (pinned: 2.1.285; its flags and
  events change between releases), the VM's agent, and the repo's
  dependencies in Bun's cache, about 2.2 GB. `bun factory/vm/build.ts`
  builds it, tagged `erga-factory:<hash>` of the Dockerfile, the agent and
  the Bun version: the dependencies are only a cache (a clone's `bun install`
  fetches what it lacks), and the jobs' scripts (`run.ts`, `merge.ts`,
  `task.ts`, `fake-claude.ts`, `common.ts`) come with each job, from the
  server's own version (`factory/vm/scripts.ts`; locally the dev server reads
  them from the checkout). So a change to a script ships with the next deploy,
  and the image changes only when its Dockerfile or agent does. Not root:
  Claude Code refuses to skip its prompts as root.
- The VM's agent (`factory/vm/agent.ts`, the image's main process, port
  8080) runs the jobs when the factory asks, so the platform needs only an
  HTTP port: locally Docker publishes it on the loopback; on Cloudflare the
  container's Durable Object reaches it. The preview shows on port 4401 (a
  relay to the app's 4400, as the app listens on the VM's loopback).
- Each job gets, in its environment only: the factory's API and the task's
  own token for it (`fct…`: it reports on that task only), the repository and
  a git token (`fgt…`, `factory/git-grant.ts`) that reads staging, main and
  that task's branch, and pushes that task's branch only, for two hours; and,
  for a job that runs Claude Code, the Claude token, if there is one (merge,
  save, stop and discard jobs never get it). A merge job's git token also moves
  staging, once, and only to the merge itself: one new commit on top of
  staging's head, whose second parent is the task's branch as pushed (with
  staging in it), with that branch's files (`mergeShape`). It lasts as long
  as the merge job may (35 minutes), and `SourceRepo` keeps the ids of the
  ones it has spent. The token is made when the merge job starts (after the
  merge waits its turn), so it doesn't matter how long ago the task became
  ready to merge, and the job is stopped at 30 minutes, before the token
  ends. If the endpoint refuses the staging push anyway (a spent or older
  token, a merge that isn't the branch's), the task goes back to Ready to
  merge with the reason, and Merge tries again with a new token; only a
  staging that moved meanwhile makes the job try again by itself. On Cloudflare the repository
  is Erga's Git endpoint (`/git/erga.git`), which takes these tokens beside
  admin tokens (`worker/source.ts`, `SourceRepo.receive`): a task branch
  (`task/<id>-<slug>`) is made, moved and deleted only with its own task's
  token, never shown on the Factory page, mirrored or deployed, and never
  listed to another task's VM (its reads are protocol v2, with `ls-refs`
  filtered and `want-ref` checked: `source/http.ts`).
  Scripts take tokens out of anything they log, and the factory hides
  anything shaped like a token in what a VM reports (`hideTokens`,
  `factory/prompt.ts`); git gets its token through
  its environment, never its command line or `.git/config`; the preview gets
  none of them. Every secret, where it lives and who reads it: [docs/secrets.md](docs/secrets.md). The preview's own `Set-Cookie` headers are dropped (it could
  otherwise set a cookie on the whole previews' and pages' domain).
- **What a task's VM can reach** (the audit of 2026-10-06, task #37). A VM is
  one Unix user, so the task's code (Claude Code, and anything it runs or a
  task's ask talks it into) can read everything any job there gets: the
  agent's secret (`/proc/1/environ`), the task's tokens, the Claude token and,
  during a merge, the merge job's git token (its environment, or a git hook
  or a changed cached script that the merge job then runs). So the server
  decides what each token can do, never the VM. What it can reach:
  1. *The Claude plan's token* (`CLAUDE_CODE_OAUTH_TOKEN`): the riskiest. A
     VM can copy it out (it has the internet) and use the plan elsewhere until
     someone signs out on /admin/factory and revokes it at claude.ai. The fix
     would be a proxy in the Worker that holds the token and lets each VM use
     it only while its task works.
  2. *Staging, through a merge*: only when an admin presses Merge, once, and
     only to the merge of the task's branch as it is then. The task's code can
     still change its own branch up to that moment, and resolve a conflict as
     it likes: what lands is what the branch holds, which may not be what the
     screenshots showed. Read the diff before Merge.
  3. *Its own branch*: read and push, for two hours a token, as long as the
     task works. Not main, not another task's branch, never staging without
     a merge.
  4. *Its own task on the factory's API* (`fct…`, a week): its log, status,
     summary, preview and screenshots. Never another task's (403), and nothing
     once it is merged or discarded. What it writes reaches the admin's own
     factory agent, which treats it as information and has no tool to merge,
     discard, push or deploy (`factory/agent.ts`).
  5. *The internet*, from the VM (Claude Code and `bun install` need it).
  It can't reach: main or production, deploy or Cloudflare tokens (no job
  gets any), the server's secrets or database, other tasks' branches, data or
  VMs, or an admin's session (the preview gets no cookies; its ticket is for
  its own VM's host). The local stand-in (`dev/factory.ts`) checks a merge
  token's refs, not the merge's shape: locally, nothing deploys staging.

**Findings.**

1. *Compute: Cloudflare Containers, driven from a Durable Object.* A
   container is a Firecracker microVM owned by a Durable Object
   (`ctx.container`: start it, reach a port, destroy it). The Sandbox SDK is
   now (1.0) only helpers on top (files, R2 mounts, directory backups), and
   its 0.x API (exec, exposePort) is legacy until 2026-12-31, so the
   factory uses the plain container API and its own agent. Instance types go
   up to standard-4 (4 vCPU, 12 GiB, 20 GB disk); the factory wants
   standard-3 (2 vCPU, 8 GiB) or more: Claude Code alone wants 4 GB, plus
   the dev server and Chromium. It uses standard-4, the largest (custom
   types go no higher: 4 vCPU, 12 GiB, 20 GB). Starts: "often 1–3 seconds"; Cloudflare's
   `durable_object` scheduling (blog, 2026-09-30) reports a median of
   0.65 s and lets the image and instance type be chosen at start. Disk is
   ephemeral; filesystem snapshots (beta, `durable_object` policy only,
   30 days) could later hold a warm clone; R2 mounts are the other way to
   keep anything. Egress: on by default for the `Container` class, off for
   native `start()` unless `enableInternet`; `allowedHosts` makes it
   deny-by-default, and outbound handlers can intercept HTTP(S) in Worker
   code. Pricing on Workers Paid: $0.000020 per vCPU-second, $0.0000025 per
   GiB-second, $0.00000007 per GB-second of disk, egress $0.025/GB after
   1 TB, with 375 vCPU-minutes and 25 GiB-hours included each month: a
   standard-4 VM costs at most about $0.40 an hour while it runs. No fixed
   lifetime; an inactivity timeout up to 6 hours. Browser Rendering could
   take screenshots instead of Chromium in the VM, but it would need the
   preview on a public URL; Chromium in the image is simpler.
   (developers.cloudflare.com/containers: limits, pricing, outbound traffic,
   faq; /sandbox: concepts, lifetime, previews, coding-agents/claude-code;
   blog.cloudflare.com/faster-agent-sandboxes.)
2. *The image* is built from the repo and versioned by its inputs (above).
   On Cloudflare, `wrangler deploy` builds a Dockerfile and pushes only the
   changed layers to Cloudflare's registry (which the `durable_object`
   policy requires); an image may be as large as the instance type's disk.
3. *Signing in to Claude once.* `claude setup-token` (on any computer with
   Claude Code) runs the browser sign-in for a Pro or Max plan and prints a
   one-year OAuth token (`sk-ant-oat01-…`) that `claude -p` takes as
   `CLAUDE_CODE_OAUTH_TOKEN`. The admin pastes it once on the board ("Claude:
   not signed in"); the `Factory` object keeps it encrypted (AES-GCM, with
   a key from the `FACTORY_KEY` Worker secret), shows it to nobody (the API
   says only whether there is one, who set it and when), and puts it in the
   environment of the claude command's job only. Notes: `--bare` mode
   ignores the token (and may become `-p`'s default: the factory never
   passes it); an `ANTHROPIC_API_KEY` in the VM would win over the token
   (the VM never gets one); on Linux Claude Code would otherwise keep a
   login in `~/.claude/.credentials.json`, which an ephemeral VM loses.
   Anthropic's terms: Pro and Max are for "ordinary, individual usage";
   your own token in your own sandbox, for yourself, is what `setup-token`
   is documented for, but many tasks at once may stretch "ordinary", and
   it must never serve other people (code.claude.com/docs: authentication,
   headless, legal-and-compliance).
4. *Branches.* As above. The repository must enforce the git tokens' rules
   (a task's branch only; staging only for a merge): Artifacts' own tokens
   are for the whole repository, so the VMs must push through Erga's Git
   endpoint (#39), which then also sees staging move and starts its deploy.
5. *Previews* run in the task's VM, from the clone, and stay up until the
   merge or discard. Locally Docker publishes them on a port of the
   loopback. On Cloudflare each VM has a host, `<vm>.<FACTORY_PREVIEW_DOMAIN>`,
   under the documents' pages domain (`task-7-1a2b3c.erga-pages-staging.dev`):
   its wildcard route, DNS record and free Universal SSL certificate (one
   label under the zone) already reach the Worker, so previews need nothing
   new and nothing bought. The Worker tells them from documents' pages by
   their name (`task-<id>-<6 hex>`; a document's is `<8 characters>-<owner>`),
   and refuses a request from another host of the domain (`Sec-Fetch-Site:
   same-site`, a document's page). The board's "Open preview" goes
   through `/api/factory/tasks/<id>/open`, which gives a 12-hour ticket for
   that host only; the Worker trades it for a cookie there, then sends each
   request to the VM's port 4401 as if to localhost (the dev server in the
   VM signs everyone in as its `DEV_LOGIN`, on localhost only, so the
   ticket is what keeps it to admins).
6. *The board* is the local one's, without live mode, the Merged column or
   the Branches column (merged tasks leave the board; the Factory page shows staging).

**Risks.**

- The Claude token is in the job's environment, so the task's own code, and
  any command Claude Code runs, can read it. A prompt injection (from a page,
  a dependency, a test fixture) could send it out while the VM has the
  internet. It gives Claude usage on your plan, nothing else; revoke it from
  claude.ai's settings and sign in again. Narrow the egress to what a task
  needs (api.anthropic.com, the npm registry, Erga itself) once that list is
  known.
- `FACTORY_KEY` decrypts the token: it's a Worker secret, and anyone who can
  read the Worker's secrets or run code in the Worker can read the token.
- A task's git token can push its own branch only, but Claude Code in the
  VM could still write anything to that branch: the merge is the review.
- The preview is a dev server in which everyone is signed in: only the
  ticket guards it.

**Assessment.**

Works (locally, end to end, in real containers): tasks as branches made from
staging; VMs from a prepared image in under 2 seconds; the clone, the
install, the real app headless in the VM, screenshots, push and report in
about 10 seconds with the stand-in; merge into staging and the branch
deleted; discard; more instructions on the same branch; tokens scoped to
one task and one branch; the Claude token stored encrypted and never shown.

Uncertain: whether a server's own deploy token (no Containers permission)
may upload a version that names the image (the pipeline then deploys without
the VMs, and says so: [On Cloudflare](#on-cloudflare)); the in-VM Chromium's
memory with the dev server and Claude Code; the preview's documents (they run
on `*.localhost` origins in the VM's dev server, which the preview host
doesn't reach yet: the app opens, documents' pages don't).

Might not work: real Claude Code never ran here (no sign-in on this machine
was used, by design), so its first run may need prompt and flag fixes;
`./test.sh` starts many dev servers at once and may be too slow, or run out
of memory, on even a standard-4 VM (the prompt may have to ask for the
tests that cover the change only); and the plan's usage limits with several
tasks at once.

### On Cloudflare

Task #7 put the factory on Cloudflare: the README's old runbook ("the first
real run") is code now, and staging.erga.dev runs it.

- **The image** is in the account's container registry,
  `registry.cloudflare.com/<account>/erga-factory:<tag>@sha256:<digest>`
  (Containers takes only digest-pinned images), and `deploy/targets.json`
  names it (`factory.image`; a test keeps its tag equal to
  `factory/vm/build.ts`'s; Cloudflare is given the digest alone,
  `…/erga-factory@sha256:<digest>`, as wrangler names images). `bun
  factory/vm/push.ts` builds it for Cloudflare's machines (linux/amd64, with
  Docker, and `--provenance=false`: Docker Desktop otherwise pushes an index
  with an attestation beside the image, which Containers can't start, "There
  is no container instance that can be provided"), pushes it (a 15-minute
  registry password, in a Docker config folder of its own), prepares it for
  Containers, starts a container from it (`probeImage`, `factory/vm/probe.ts`),
  and only then writes its name into `deploy/targets.json` (`updatePin`):
  commit that. A new image can take up to an hour after its preparation
  before Containers starts it ("There is no container instance that can be
  provided to this Durable Object"; task #21's: refused after 11 minutes,
  started after 28), and a version that names it in that time has VMs that
  don't start. So the pin moves only after a real start, and until then
  every deploy keeps the old image; `push.ts --wait` tries the start again
  every 10 minutes, for up to 90. It does nothing when the tags already
  match. A deploy from a machine (`deploy/run.ts`) deploys with the pinned
  image (pushing it first if the registry lacks it), then does the same as `push.ts` (once, without waiting) and says
  what came of it: a new pin to commit (`run.ts` won't deploy an uncommitted
  checkout, so it isn't forgotten), "pushed, not started yet: try again
  later", or what it lacks (Docker, a login that may use Containers). A
  Worker can't run Docker, so a server deploying itself always uses the
  image `deploy/targets.json` names; the test that compares the tags fails
  until the pin follows a new Dockerfile or agent, and says how. The probe
  uses a Worker of its own, so running tasks keep the old image meanwhile.
- **The deploy pipeline** (`runPipeline`, `deploy/containers.ts`) has two
  more steps on Erga's own targets (`factory: true` in
  `deploy/targets.json`): "image" (prepared for Containers) before the
  Worker's upload, and "vms" after it. The upload names the image on the
  version (`containers: [{ name: "<worker>-factoryvm", class_name:
  "FactoryVm", images: { factory: <ref> } }]`, the `durable_object`
  scheduling policy, as `wrangler deploy` sends it) and sets
  `FACTORY_PREVIEW_DOMAIN` (the pages domain) and `FACTORY_IMAGE`; "vms" makes
  the container application for the Worker's FactoryVm namespace once (its id
  is the namespace's), after the upload, as wrangler does. `cloudflare.config.ts` declares `FactoryVm` and its
  binding `FACTORY_VM` on every build; elsewhere (locally, `/deploy`) it's an
  object nothing uses. A release without FactoryVm (an older commit) skips
  both steps.
- **The deploy tokens are unchanged.** Cloudflare's narrowest container
  permission is account-wide (Workers Containers Read or Write), and making a
  token needs a token maker, which no longer exists. So the tokens get no
  Containers permission, and what needs one is done once from a machine with
  your own login (the cf CLI's has `containers:write`): `bun deploy/setup.ts
  --factory` makes `FACTORY_KEY` on the Worker if it has none, pushes and
  prepares the image, and makes the container application (with
  `--production`, on erga.dev too). A server deploying itself then needs
  none: the image is prepared, the application is there, and the version only
  names the image. If Cloudflare refuses a token's upload that names an image
  (403), the pipeline uploads the version without the VMs (the rest of Erga
  as it should be), and the deploy's log says so. Then the only way back to
  VMs on self-deploys is a token with Workers Containers Read and Write: one
  token maker, made by you once (`CLOUDFLARE_TOKEN_MAKER=… bun
  deploy/setup.ts --tokens`, after adding the permission to
  `deploy/tokens.ts`).
- **A VM** (`factory/cloudflare.ts`) is a container of a FactoryVm object
  named `task-<id>-<6 hex>`: started from `ctx.container.images.factory`,
  instance type `standard-4` (4 vCPU, 12 GiB, 20 GB disk, Cloudflare's
  largest; chosen at each start, so the container application has none of
  its own; `FACTORY_VM_INSTANCE` overrides it), internet on. A container stops a while after its object last heard
  from anyone, so each call sets that to the most Cloudflare allows (six
  hours), and the factory's alarm asks every VM whether it's up every 20
  minutes while any task has one. A VM that stopped anyway is noted on its
  task; more instructions or a merge start a new one.
- **`bun factory/vm/probe.ts`** checks the image on Cloudflare for real, with
  no server involved: a throwaway Worker (`erga-factory-probe`, on
  workers.dev) starts a container exactly as FactoryVm does, runs one task
  with the stand-in in it (a small repository made in the VM; the real
  `run.ts`, `task.ts` and `fake-claude.ts`; the preview on 4401; a screenshot
  with the VM's Chromium) against a pretend factory API, then deletes the
  container, its application and the Worker. On 2026-10-05 it passed: the
  agent answered 1.7 s after `start()`, and the whole task (clone, branch,
  change, preview, screenshot, report) took 3.4 s more. In the first hour
  after a new image was pushed and prepared, starts failed with "There is no
  container instance that can be provided" (Cloudflare still putting the
  image on its machines, it seems); later the same image started at once. So
  push a new image a while before it's needed. (The Dockerfile installs
  `lsof`, which images before it lack; tests/host.ts doesn't need it: on
  Linux it reads `/proc/*/cwd`. The next image built picks it up; there's
  no need to push one just for that.)

Done on erga.dev's account (task #7): the image pushed and prepared;
`FACTORY_KEY` on `erga-staging`; staging deployed from a machine with this
code (`bun deploy/run.ts staging --no-snapshot`, keeping its data), which made
its container application `erga-staging-factoryvm`; the probe passed. Not
tested on staging itself: a task added on its board, since nobody can sign in
to staging yet (no GitHub OAuth app), and the factory's API takes a signed-in
admin only. To finish:

1. Merge it (staging then deploys itself with its own token: watch its
   "worker" and "vms" steps on `/admin/factory`).
2. **Sign in to Claude** *(you)*: on your computer, `claude setup-token`,
   then paste the token on the board (Claude: not signed in, then Save).
   Without it the scripted stand-in does each task.
3. On staging, `/admin`, set `factory` to `on`; open `/admin/factory`; add a
   small task. Staging needs its GitHub OAuth app to sign in (the deploys
   runbook, step 2).
4. erga.dev: after a release, `bun deploy/setup.ts --factory --production`
   (its `FACTORY_KEY` and container application).
5. If anything goes wrong: discard the task, set `factory` to `off`, and
   "Sign out" on the board (which deletes the stored token); revoke the
   token on claude.ai if it may have leaked.

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

A presentation (slides, a walkthrough) can tell Erga its steps, through
`window.ergaSteps` (DOCUMENT_PROMPT.md, rule 11 and "Presentations": the
contract, with a minimal example). Viewing and editing alike, the page then
gets back and forward buttons under it, with the step it's at, and the arrow
keys step too, except in text being edited. The button on the left opens a
list of the steps over the page's right side: the page's own pictures of
them (its `image()`), kept until the document changes, else each step's
number and label; a click goes to that step. The frame's host page reads the
contract from the page shown and relays it (`HOST_SCRIPT`: `erga-steps`,
`erga-step`, `erga-step-image`, the pictures as Blobs), and the document's
page draws the controls (`STEPS_BOOT` in `front.ts`), outside the editor's
own, so they're the same in both; an edit (`ergaHost.changed`, `frame.ts`)
makes the pictures out of date. `bun tests/steps.ts` checks it all, viewing
and editing (`--shots` keeps pictures).
The list's pictures take the frame's shape as it is, so they follow the
window when it changes size.

On a phone the controls make room: the breadcrumbs shrink to a back arrow,
avatars overlap, the agent covers the page instead
of pushing it aside, and the style bar sits below a selection (the system's
copy menu is above it). The page, the agent and the cards stop above the
on-screen keyboard, and keep clear of a notch.

There's no dark mode: pages are shown as their authors made them, and most
don't support one. The editor's own controls take their colours from the page
instead, on a band in the page's colour above it (see "One page, viewing or
editing").

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

A document can have more than one page. Its home page is `index.html`; the
others sit beside it, in folders if you like. People think in pages, not
files: a document has pages, and the tree shows only its pages (HTML and
Markdown files) and the folders holding them (or nothing yet). The
document's stylesheets, scripts, fonts and images are shared assets, out of sight, as are folders holding only those (`fonts/`,
`assets/`); the API lists every file, and agents see them all. The tree of them
(`src/page/tree.ts`, built on its own as `pages-tree.js` and loaded only when it's
opened, so viewing never pays for it) shows in two places: in the editor, the
document's title in the breadcrumbs opens it in a card, the document as its
first row and everything else under it; on `/docs`, the chevron left of each
document opens its pages beneath its row. Folders open and close (remembered
for the tab); pages show by their title when it's known (in the editor,
read from the room as they're edited; "Untitled" counts as none), else by
their name made readable ("spring-migration" is "Spring migration", a
folder's index is the folder's name), with the file's name as a quiet hint
only where two would read the same. Clicking a page opens it, in the
editor for those who may edit (`/<owner>/<slug>/<page>#edit`), in the viewer
otherwise (`/<owner>/<slug>/<page>`), and the one you're on is marked.

Editors get New page (from the new-page template; "My post" is
`my-post.html`) and New folder, at the top level (the foot of the tree) and in each
folder (its +), named in place; rename in place (the menu, F2, or the pencil
on the root row, which renames the document itself: its title and address);
move by drag and drop or the menu's Move page to… (Move folder to…); and
delete (Delete page; a folder asks first, in its row, counting the pages in
it; `index.html` can't go). The tree says "page" for pages throughout, and
"document" only for the document itself (the root row's rename).
A page links its stylesheets, images and other pages by where they
are from it (`../style.css`), so moving one to another folder (or a folder to
another depth) can leave those behind: the tree says so after the move when
the page has relative links (in the editor it reads them from the room;
on `/docs` it always says so). It doesn't rewrite links, nor those from other
pages to the one that moved or was renamed. The editor renders a page in
a folder with its links resolved from that folder, as the browser does at its
address. Viewers see the tree without any
of that. What the server refuses shows where it happened, in its words. Keys:
↑ ↓ ← → Home End move and open folders, Enter opens, F2 renames, Delete
deletes, Shift-F10 opens a row's menu, Esc cancels or closes.

It talks to the server's tree API (below): `GET /api/docs/<id>/tree` (`{
entries: [{ path, type: "page" | "folder" | "file", title? }], canEdit }`,
each page with its title) and `POST` there (`new_page`, `new_folder`, `move`,
`delete`). It reads the tree again on a `{ type: "tree", moved?, deleted? }`
event on the editor's event channel (which `main.ts` passes on as an
`erga-tree` event on `window`), or when a file comes or goes in the room;
on Documents, which has no event channel, an open tree is read again every
few seconds while the tab is in view, and when you come back to it. Changes
from elsewhere wait while you're naming, moving or deleting something, so
the rows never shift under you. A folder that moved stays open where it went,
and when the page you're editing moves (anyone's doing: another tab, an
agent), the editor goes to its new address with the tree still open, marking
it there. `bun tests/tree.ts` checks all of it in headless Chrome against a
real server, on `tests/fixtures/multi` linked from disk: every operation,
two tabs, an agent over the token API, a viewer, and a page two folders down
that uses the stylesheet, image and font from the folders above it.

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
Its tools (read, edit, write, ls, find, grep, list_pages, open_page, new_page, mkdir, mv, rm, view_page; get_title and set_title rename the document) are written against
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
It renders at the size of the person's own page and in their light or dark
mode (each message's `<editor>` block tells the agent both), unless the agent
passes `width`, `height` or `color_scheme`. Since a frame can't be given a
mode of its own, the other mode is had by rewriting the page's
`prefers-color-scheme` queries (its CSS and its scripts' `matchMedia`). The
picture waits, up to 5 s, for the page's web fonts (laid out first, since a
font loads only once text needs it) and images (lazy ones too); a font
stylesheet from another site, like Google Fonts, can't be read by the page,
so its `@font-face` rules are fetched (CORS) and added, or the picture would
draw that text in a fallback. Beside the picture the agent gets the window
size, the mode and the fonts the text rendered in (a font that didn't load
shows as the one the browser fell back to), and anything still loading.
`bun tests/view-page.ts` checks it in headless Chrome.

The agent runs on Claude Opus 5.5 in fast mode by default, at medium effort;
the model name in the panel's header is a menu that switches it to Claude
Sonnet 5.5 and back. The choice is per person (all their tabs follow, and a
reload keeps it) and applies from the next message, so a running turn
finishes on the model it started with. `ERGA_AGENT_MODEL=sonnet`
starts everyone on Sonnet instead. Set it up with the Anthropic API key on `/admin` ([API keys](#users-admins-and-settings)), or `ANTHROPIC_API_KEY`: locally
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
embedded agent's own tools (read, edit, write, ls, find, grep, list_pages,
open_page, new_page, mkdir, mv, rm, view_page, and get_title and set_title for the document's
title and address),
run in your agent's session, so its edits are handled exactly like your
agent's: attributed to "Pete's agent", marked in its colour, undoable from
the agent panel, with its badge spinning while it works. Each call shows in
your agent panel as "External agent: …". It works with the embedded agent
off too (no API key needed). The share button's token is the same each time
you open it (in any tab or browser), until New token in the dialog turns it
off and makes another; `/settings` lists and revokes it with the rest.
It never carries admin power, not even an admin's: no admin tools, deploys,
Erga's source or Git endpoint, nor editing the homepage (`withTokens`,
`front.ts`). It goes to an agent along with a document, and the document's
text can steer that agent, as it can the editor's own.

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
has too (`SERVER_TOOLS` in `server-tools.ts`: sharing, and for an admin
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

**Agents** see a document as one file system, rooted at the document's
folder: every page's files, the shared assets and the folders, whichever page
the person has open. Users see pages; agents see files. They have the same
powers as a person: `ls` (folders end in `/`; by default the root), `find`
and `grep` (the whole document by default), `read`, `edit`, `write` (which
also makes a page from its own text), `new_page` (from the template),
`mkdir`, `mv` and `rm`, checked exactly as the tree's API checks them.
`list_pages` gives the tree as users see it: each page's file, title and
address, by folder, with the assets counted. `open_page { path }` (a file,
or an address under the document) switches the person's open editor to a
page: every tab they have open on that document goes there (the host sends
`{ "type": "open", path }` on its event channel). With no tab open, nothing
opens, and the tool says so and gives the page's address to pass on.
`new_page { path, open: true }` makes a page and opens it. The embedded
agent, external agents over `/api/ext`, the token API and MCP all have them;
an external agent's `open_page` moves the editor of the person whose token it
holds. Their prompts say a document is a folder of files whose `.html` files
are its pages (`index.html` the home page) and the rest shared assets, how
files map to addresses, and to link pages relatively; each message says
which page the person has open, and where their caret is.

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
the controls, on a band across the top, and a frame filling the window
below the band, with the frame's host page in it (`/t/<token>/?view=`), which shows
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

The document starts below the band, so the controls never cover its first
line, at any width. The band takes the document's own background, as a solid
colour (a gradient's colour at the top edge), and the controls turn light on
a dark page. The frame's host page reads the background of the page it shows
on every frame and tells the document's page (`HOST_SCRIPT`, `BAND_BOOT` in
`front.ts`), so the band follows a theme switch or another page of the
document. The page remembers each document's colour (`erga:band:v1:<id>`)
and paints it before anything loads, so a reload, viewing or editing, shows
no white. On a first visit nothing is remembered: the host page keeps the
document out of sight until the band has its colour (half a second at most),
so a dark page never shows under a white band; the window is white only
before the document shows at all. A link to another of the document's pages,
in a colour of its own, waits in the same way, a frame or two. The band is the same height viewing and
editing, so the document doesn't move between them. `tests/band.ts` checks
that no control covers the text of pages whose first line is at their top
edge (light, dark, a gradient; desktop and phone), compares the band's
pixels with the page's, and records a first visit, a hard reload and the
switch into the editor and back frame by frame on a slow network.

**The viewer's controls fade while you read** (`FADE` in `front.ts`), on a
document's page and on the homepage alike: Clone, Edit and your avatar are
whole at the top of the page, and fade to 20% (`FADED`) as soon as it scrolls,
in 180ms (at once, with `prefers-reduced-motion`). They're whole again back at
the top, while the pointer is within 100px of them (`FADE_NEAR`), while one has
keyboard focus, and while your menu is open. On a touch screen, a tap near them
brings them back until the page scrolls again. Nothing else changes it, no
timer included: the same scroll and pointer always look the same. The band
behind them stays as it is, in the page's colour. On a document's page the page
scrolls in its frame, on its own origin, so the frame's host page tells the
shell where it's scrolled to and where the pointer is over it (`erga-scroll`,
`erga-pointer`); the most a page can do with them is fade the controls or bring
them back. The editor's controls don't fade. `bun tests/fade.ts` checks it
all in both, on a desktop and a phone, with every frame of the fade keeping the
band's colour (`--shots` keeps pictures).

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

    ./test.sh          # every test file: ~3.5 minutes on a 10-core Mac
    bun run typecheck  # tsc over the host, the editor and the suite

`./test.sh` runs the files in a pool, the longest first: one for every two
usable cores, as each file has dev servers and a Chrome of its own, and more
at once only slows them all. `tests/cores.ts` decides, for test.sh,
`tests/page.ts`'s scenarios and `tests/cdp.ts`'s browsers alike: the cores
are the fewest of what the OS reports and the container's CPU quota (cgroup
v2 or v1), and memory caps it (1 GB a file). `TEST_JOBS=n` sets it exactly;
`TEST_CORES_PER_JOB=c` tunes it (the factory's VMs set 3: Claude Code and the
preview share their 4 cores). test.sh prints what it found. Each file prints its
time. Each file also runs alone: `bun tests/page.ts` (~30s; `PAGE_JOBS=n`
scenarios at a time), `bun tests/suite/run.ts` (~22s; `--suite`, `--grep` and
`--seed` narrow it, `--long` for the big slow version), `bun tests/factory.ts`
(~57s), `bun test tests/` (~11s).

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
`bun tests/admin-keys.ts` checks admin SSH keys on a dev server without
the shortcut: every admin, source, deploy, factory and homepage surface
refusing a locked admin, the first key, Lock now, unlocking once (a replay
refused), `admin-login.ts`'s admin token for the tools and Git, revoking,
and the page in headless Chrome; `tests/admin-keys.test.ts` the keys,
challenges and unlocks on bun:sqlite, and `tests/sshsig.test.ts` the
signatures, against every kind of key ssh-keygen makes.
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
`tests/pipeline.test.ts` runs the one pipeline on production and staging
against the mock Cloudflare's copy of Erga's account: staging's own Worker,
database, Durable Objects, secrets and pages origin, a fresh copy of
production's database and documents each time, nothing written to
production (every call checked), the guards, failure and retry, branch
pushes (the queue, passing a push on, the status, the deploy log and its
events), staging deploying itself across the restart its own upload causes
(one log across it), the builder's stream, and
`deploy/setup.ts` run end to end. `tests/tokens.test.ts` covers the deploy
tokens against a mock that enforces a token's policies: each plan, the check
catching a token broader than its plan, staging's token deploying staging
(reading, never writing, its address, route and DNS record) and refused
production, staging deploying itself with it, production deploying staging
when staging's server doesn't take a move, and the Artifacts binding going
only to Erga's own targets. `bun tests/deploys.ts` does it in the real
Worker: a push to a dev server playing staging, its status and events, the
deploy's log whole and live, Redeploy, a failed build, the redirect from
/admin/deploys to /admin/factory, and who may.
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

- `docs/secrets.md`: every token, key and secret: what it's for, where it's set, who reads it, and the audit's risks
- `page.html`, `page.js`, `frame.js`: the editor's shell and its built
  scripts (the shell's, and the frame's that runs on each document's own origin)
- `templates.ts`, `templates/`: what a new document starts from: the registry of templates (the + button's
  picker, `/new?template=<id>`) and their files
- `landing/`: the demo page, built into the Worker, which the server makes the
  front page when there's none (`seedLanding`, `front.ts`)
- `home.ts`, `worker/home.ts`, `worker/published.ts`: the homepage served
  directly: its rendering, controls and API; its deploys (the `Home` Durable
  Object) and serving `/`; the published version it deploys
- `front.ts`: the app's own routes and pages (the front page, `/new`, `/docs` and
  its share dialog, delete, the unedited rule, titles)
- `admin.ts`: `/admin`, the server's settings and users, for admins
- `sshsig.ts`, `admin-keys.ts`, `admin-access.ts`, `admin-login.ts`: admin SSH keys: OpenSSH
  signatures verified with WebCrypto; keys, challenges and unlocks (in D1:
  `migrations/0110_admin_keys.sql`); `/admin/keys` and `/api/admin/...`; the command line's admin token
- `source/`, `worker/source.ts`, `worker/source-host.ts`, `worker/artifacts.ts`: Erga's own source in
  Cloudflare Artifacts (Git's formats, the smart HTTP client and endpoint, pushes, the branch model, the
  GitHub mirror, the Factory page, the import script); `dev/git-server.ts`, local development's stand-ins
  for Artifacts and GitHub
- `deploy/cloudflare.ts`: the one deploy pipeline (`runPipeline`: targets, steps, D1's export and import)
- `deploy/targets.json`, `deploy/targets.ts`: Erga's own targets, production and staging (cloudflare.config.ts reads production's names there)
- `deploy/branches.ts`, `deploy/index.ts`, `worker/pipeline.ts`, `worker/deploys.ts`: branches deploying
  themselves (the hook, the queue, carrying on after the restart), their status, logs, events and routes
- `deploy/snapshot.ts`: copying documents' Durable Objects from production into staging
- `deploy/builder/`: the builder Worker and its container (building a commit: `build.ts`), and the
  pipeline's side of it (`client.ts`); `deploy/bundle.ts`, a release as one file; `deploy/source.ts`, the
  source repo in Artifacts
- `deploy/run.ts`, `deploy/setup.ts`: a deploy from a machine, and staging's one-time setup
- `source/git-credential.ts`: Git's credential helper for Erga's Git endpoint: admin tokens from the SSH key, the agent token in the keychain (tests: `tests/admin-keys.ts`)
- `deploy/tokens.ts`, `deploy/credential.ts`: the servers' narrow deploy tokens (planned, made,
  checked), and the person's own credential the setup uses
- `deploy/page.ts`, `deploy/release.ts`, `deploy/mock.ts`, `deploy/seal.ts`, `worker/deploy.ts`,
  `worker/deployer.ts`: `/deploy`, deploying Erga to your own Cloudflare account (the page, the
  release, the pretend Cloudflare the tests use, Erga's own account included)
- `factory/`, `worker/factory.ts`, `dev/factory.ts`: the factory (experimental), tasks done by
  Claude Code in VMs: the board, the factory's agent (`factory/agent.ts`) and prompt, the VM's image and scripts (`factory/vm/`: its build,
  push to Cloudflare's registry and probe), the git tokens' rules (`factory/git-grant.ts`), the
  Containers host, the API and Durable Object, and the local repository and VMs;
  `deploy/containers.ts`, the pipeline's Containers calls
- `account.ts`: who you are in the upper right of every page (avatar and menu, or sign in)
- `directory.ts`: the directory of documents (addresses, titles, permissions, who may do what), over
  `Sql`; `worker/d1.ts` puts it on D1; its tables in `migrations/`, which the deploy pipeline applies to
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
  host and shell), `agent-chat.ts` (the agent panel's conversation, shared with
  `factory-agent.ts`, the factory's panel on `/admin/factory`, built as `factory-agent.js`)
- `src/page/settings.ts`, `src/page/versions.ts`: document settings (the gear's
  popover: publishing, the homepage, versions), built on its own as `settings.js`
- `package.json`: the pinned CodeMirror and Yjs packages the page editor bundles, and pi
- `src/page/tree.ts`: a document's pages as a tree (built as `pages-tree.js`, loaded on demand), in the editor and on `/docs`
- `style.css`: theme colours, typography and the editor's styling
- `fonts/`: the self-hosted Inter web font
- `tests/`: unit tests, `page.ts`, `smoke.ts` and `fixtures/` for the page
  editor, and the multiplayer suite in `suite/` (see above)
