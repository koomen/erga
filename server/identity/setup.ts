// /setup: where the person finishes a new server, on one page. `bun erga setup` (deploy/own/cli.ts) builds the server
// with no sign-in and no admin, and opens this page in the person's browser with a link that is signed with the
// server's own secret, which only the machine that set it up has. The steps, each a row of the page:
//
//   GitHub   one click: GitHub makes a GitHub App from a manifest and comes back here with a code; the server changes
//            it for the app's client ID and secret, and keeps them as /admin/auth does (apps.ts: encrypted)
//   Google   the person makes an OAuth client and pastes its client ID and secret; the server checks them with Google
//   Updates  only where the server has a deployer in the cloud (Platform.deploy.deployer: setup installed it, with no
//            token): the person pastes the deployer's token, and the server hands it to the deployer at once. The
//            deployer checks it with Cloudflare and keeps it; the row shows its answer. The server keeps no token.
//   Admin    the person signs in with a provider that is set up, and becomes the server's first admin
//
// One provider is enough. With a gate in front (mode.ts) the page has no provider's row: the gate signs people in.
//
//   GET  /setup?t=<link>     the link, one time: this browser gets the page's pass (a cookie), and goes to /setup
//   GET  /setup              the page
//   GET  /setup/github       GitHub's answer, with the app's code
//   POST /setup/google       clientId, secret
//   POST /setup/deployer     token
//   GET, POST /setup/admin   the person who is signed in becomes the admin (the sign-in comes back here)
//
// The page is there only while the server has no admin: the first admin closes it for good. No agent sees it: a
// secret goes from the person's browser to this server, never through a conversation.
//
// Trap: nothing here answers a secret back: a row says that a value is set, never the value.
// Local development always has an admin (DEV_LOGIN): there the page shows with no link, to work on it, and its last
// step makes no admin.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { esc } from "../../shared/html.ts";
import { PROVIDER_CSS, providerButtons, type SignInChoice } from "../../shared/sign-in.ts";
import { call, ctx, Field, form, html, NO_STORE, redirect, type Route, text } from "../http.ts";
import { appPage, inlineStyle, page, pageBars } from "../pages/index.ts";
import type { DeployerSays, Platform } from "../platform";
import { signed } from "../signed.ts";
import { AuthError, type ProvidersOn } from "./apps.ts";
import { cookies, withCookie } from "./cookies.ts";
import { CALLBACK_PATH, PROVIDERS } from "./providers.ts";
import { appsSet, setUpApp, signInChoices } from "./settings.ts";
import { LINK_SECONDS, SetupLink } from "./setup-link.ts";

const COOKIE = "erga_setup";
/** How long the browser that opened the link keeps the page: as long as a setup may take. */
const PASS_SECONDS = 12 * 60 * 60;
/** The pass of the browser that opened the link. */
const Pass = signed("setup", Schema.Struct({}), PASS_SECONDS);
/** GitHub's `state`: its answer is to this server's own form. */
const GithubState = signed("setup-github", Schema.Struct({}), LINK_SECONDS);
/** The links that were used (their `n`), in the server's own storage. */
const SPENT = "setup:links";

/** Whether this browser holds the setup page's pass, on a server with no admin: its person may join, to become the admin. */
export const settingUp = async (platform: Pick<Platform, "secret" | "directory">, request: Request) =>
  !!(await Pass.open(platform.secret, cookies(request).get(COOKIE))) && !(await platform.directory.users.hasAdmin());

/** Uses the link `n`: false when it was used before. */
async function spend(platform: Pick<Platform, "own">, n: string): Promise<boolean> {
  const spent = ((await platform.own.get(SPENT)) as string[] | undefined) ?? [];
  if (spent.includes(n)) return false;
  await platform.own.put(SPENT, [...spent.slice(-50), n]);
  return true;
}

const gone = () =>
  page(
    "This link does not work any more",
    "The link to the setup page works one time, for 30 minutes. Ask your agent to run its <code>bun erga setup</code> command again: it opens a new one.",
    410
  );
const closed = () => page("Setup is done", 'This server has an admin: its setup page is closed. <a href="/">Go to Erga</a>.', 410);

/** A row's error, shown in the row. */
type Problem = { row: Row; message: string; clientId?: string };
type Row = "github" | "google" | "deployer" | "admin";

const SetupForm = Schema.Struct({ clientId: Field, secret: Field, token: Field });

export const setupRoute: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const post = request.method == "POST";
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const dev = platform.dev(url);
  if (!dev && (yield* call(() => platform.directory.users.hasAdmin()))) return closed();
  const held = !!(yield* call(() => Pass.open(platform.secret, cookies(request).get(COOKIE))));
  const t = url.searchParams.get("t");
  if (url.pathname == "/setup" && !post && t) {
    const link = yield* call(() => SetupLink.open(platform.secret, t));
    // A link that was used, in the browser that has the page: the page.
    if (!link || !(yield* call(() => spend(platform, link.n)))) return held ? redirect("/setup", 302, NO_STORE) : gone();
    const pass = yield* call(() => Pass.seal(platform.secret, {}));
    return withCookie(redirect("/setup", 302, NO_STORE), request, COOKIE, pass, PASS_SECONDS);
  }
  if (!held && !dev) return gone();
  const deployer = platform.deploy.deployer;
  const show = (problem?: Problem) => setupPage(platform, request, url, problem);
  /** Sets a provider's app, then the page again: with why not, in the provider's row. */
  const setApp = (provider: "github" | "google", input: { clientId: string; secret: string }) =>
    Effect.gen(function* () {
      const refused = yield* call(() =>
        setUpApp(platform, provider, input).then(
          () => "",
          (e) => (e instanceof AuthError ? e.message : Promise.reject(e))
        )
      );
      return refused ? yield* show({ row: provider, message: refused, clientId: input.clientId }) : redirect("/setup", 303, NO_STORE);
    });

  switch (`${request.method} ${url.pathname}`) {
    case "GET /setup":
    case "HEAD /setup":
      return yield* show();
    case "GET /setup/github": {
      if (platform.signIn.mode != "oauth") return redirect("/setup", 302, NO_STORE);
      if (!(yield* call(() => GithubState.open(platform.secret, url.searchParams.get("state")))))
        return yield* show({ row: "github", message: "That answer from GitHub was not for this page. Try again." });
      const github = platform.signIn.origins.github;
      const values = yield* call(() => PROVIDERS.github.manifest!.values(github, url.searchParams.get("code") ?? ""));
      if (typeof values == "string") return yield* show({ row: "github", message: values });
      return yield* setApp("github", values);
    }
    case "POST /setup/google": {
      if (platform.signIn.mode != "oauth") return redirect("/setup", 303, NO_STORE);
      const f = yield* form(SetupForm).pipe(Effect.orDie);
      return yield* setApp("google", { clientId: f.clientId, secret: f.secret });
    }
    case "POST /setup/deployer": {
      if (!deployer) return redirect("/setup", 303, NO_STORE);
      const f = yield* form(SetupForm).pipe(Effect.orDie);
      // Straight to the deployer, which checks it and keeps it: nothing of the token stays here.
      const says = yield* call(() => deployer.ask(f.token.trim()));
      return says.ok ? redirect("/setup", 303, NO_STORE) : yield* show({ row: "deployer", message: says.why });
    }
    case "GET /setup/admin":
    case "POST /setup/admin": {
      const session = yield* call(() => platform.sessionOf(request));
      // The sign-in comes first: the pass lets this person make their account (accounts.ts), and they come back here.
      if (!session || session.agent) return redirect("/auth/sign-in?next=/setup/admin", 302, NO_STORE);
      if (!(yield* call(() => platform.directory.users.claim(session.login))))
        return page("This server has an admin already", 'Another sign-in was first. <a href="/">Go to Erga</a>.', 409);
      return withCookie(redirect("/", 303, NO_STORE), request, COOKIE, "", 0);
    }
  }
  return text("Not found", 404);
});

type State = "done" | "next" | "optional" | "skipped" | "waiting";
const CHIP: Record<State, string> = { done: "Done", next: "Next", optional: "Optional", skipped: "Skipped", waiting: "Waiting" };

/** The page: each row as the server is now. `problem`: what a row's last try said, shown in that row (status 400). */
const setupPage = (platform: Platform, request: Request, url: URL, problem?: Problem) =>
  Effect.gen(function* () {
    const oauth = platform.signIn.mode == "oauth";
    const [set, choices, says, session, state] = yield* call(() =>
      Promise.all([
        oauth ? appsSet(platform) : null,
        signInChoices(platform),
        platform.deploy.deployer?.ask() ?? null,
        platform.sessionOf(request),
        GithubState.seal(platform.secret, {}),
      ])
    );
    // "Skip for now" is the address's alone (?skip): the server keeps nothing of it.
    const skipped = url.searchParams.has("skip");
    const login = session && !session.agent ? session.login : null;
    const rows = rowsOf({ platform, url, set, choices, says, skipped, login, state, problem });
    // The row that is open: the one with a problem, else the first that is next.
    const open = problem?.row ?? rows.find((r) => r.state == "next")?.id;
    const body = `${pageBars(null, [{ label: "Setup" }], { agent: false })}<main class="setup">
  <h1>Setup</h1>
  <p class="lede">Finish the setup of <code>${esc(url.host)}</code>. Do each step below. This page closes for good when you are done.</p>
  <ol class="steps">
    ${rows
      .map(
        (r) => `<li><details name="step" data-step="${r.id}" data-state="${r.state}"${r.id == open ? " open" : ""}>
      <summary><h2>${esc(r.title)}</h2><span class="chip ${r.state}">${CHIP[r.state]}</span></summary>
      <div class="step">${r.id == problem?.row ? `<p class="problem" role="alert">${esc(problem.message)}</p>` : ""}${r.body}</div>
    </details></li>`
      )
      .join("\n    ")}
  </ol>
</main>`;
    return html(appPage("Setup", `${inlineStyle("setup")}${PROVIDER_CSS}`, body), problem ? 400 : 200, NO_STORE);
  });

interface RowsOf {
  platform: Platform;
  url: URL;
  /** The OAuth mode: the providers that have an app. null: a gate in front signs people in. */
  set: ProvidersOn | null;
  choices: SignInChoice[];
  /** What the server's deployer says; null: the server has none, and the page has no step for it. */
  says: DeployerSays | null;
  /** The person skipped the deployer's step. */
  skipped: boolean;
  /** Who is signed in on this browser, in person. */
  login: string | null;
  state: string;
  problem?: Problem;
}

/** The rows, in order: each one's state, and what it says. */
function rowsOf(o: RowsOf): { id: Row; title: string; state: State; body: string }[] {
  const { url, set, says } = o;
  const origin = url.origin;
  const rows: { id: Row; title: string; state: State; body: string }[] = [];
  const any = !set || set.github || set.google;
  if (set && o.platform.signIn.mode == "oauth") {
    const github = PROVIDERS.github;
    const manifest = github.manifest!;
    rows.push({
      id: "github",
      title: "Set up GitHub sign-in",
      state: set.github ? "done" : set.google ? "optional" : "next",
      body: set.github
        ? "<p>GitHub sign-in is set up: this server has its GitHub App, and keeps the app's secret encrypted.</p>"
        : `<p>People sign in to Erga with their GitHub account. For that, Erga needs a GitHub App. The button opens GitHub with the app's settings filled in. Click <b>Create GitHub App</b> there: GitHub sends you back here, and this server keeps the app's secret, encrypted.</p>
<form method="post" action="${esc(manifest.action(o.platform.signIn.origins.github))}?state=${encodeURIComponent(o.state)}">
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest.of(origin, `${origin}/setup/github`)))}">
  <button class="new">Create the GitHub App on GitHub</button>
</form>`,
    });
    const google = PROVIDERS.google;
    const steps = google.setup({ name: `Erga (${url.host})`, origin, pagePlace: "below" }).slice(0, -1);
    const link = (line: string) =>
      esc(line).replace(esc(google.newApp), `<a href="${esc(google.newApp)}" target="_blank" rel="noopener">${esc(google.newApp)}</a>`);
    rows.push({
      id: "google",
      title: "Set up Google sign-in",
      state: set.google ? "done" : set.github ? "optional" : "next",
      body: set.google
        ? "<p>Google sign-in is set up: this server has its OAuth client, and keeps the client's secret encrypted.</p>"
        : `<p>People sign in to Erga with their Google account. For that, Erga needs an OAuth client of your Google Cloud project.</p>
<ol class="how">${steps.map((s) => `<li>${link(s)}</li>`).join("")}</ol>
<p>Erga checks both values with Google before it keeps them. Your own sign-in, in the last step, checks the redirect URI <code>${esc(origin + CALLBACK_PATH)}</code>.</p>
<form method="post" action="/setup/google" class="fields">
  <label>Client ID<input class="input" name="clientId" value="${esc(o.problem?.row == "google" ? (o.problem.clientId ?? "") : "")}" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore autocapitalize="off" spellcheck="false" placeholder="${esc(google.clientIdLike)}" required></label>
  <label>Client secret<input class="input" type="password" name="secret" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="Paste the secret" required></label>
  <div class="buttons"><button class="new">Save and check</button></div>
</form>`,
    });
  }
  const deployer = o.platform.deploy.deployer;
  const ready = !!says?.ok && says.ready;
  if (deployer && says) {
    const { account, worker } = deployer;
    rows.push({
      id: "deployer",
      title: "Turn on automatic updates",
      state: ready ? "done" : o.skipped ? "skipped" : any ? "next" : "waiting",
      body: ready
        ? `<p>The deployer is ready${says.ok && says.head ? `, at <code>${esc(says.head.slice(0, 12))}</code>` : ""}: each new release of Erga deploys by itself. An admin turns that off, or gives the deployer another token, on the Deploy page (<code>/admin/deploy</code>).</p>`
        : `${says.ok || o.problem?.row == "deployer" ? "" : `<p class="problem" role="alert">${esc(says.why)}</p>`}${
            o.skipped
              ? `<p><b>Skipped.</b> The deployer has no token, so it deploys nothing: you deploy each new release from your machine, with <code>bun erga deploy ${esc(url.host)}</code>. Paste a token now, or later on the Deploy page (<code>/admin/deploy</code>).</p>`
              : ""
          }${tokenSteps(account, worker)}
<form method="post" action="/setup/deployer" class="fields">
  ${TOKEN_FIELD}
  <div class="buttons"><button class="new">Check the token</button>${o.skipped ? "" : `<a class="pill" href="/setup?skip">Skip for now</a>`}</div>
</form>`,
    });
  }
  rows.push({
    id: "admin",
    title: "Sign in as the admin",
    state: any ? "next" : "waiting",
    body: `${
      !any
        ? "<p>First set up GitHub or Google sign-in, above. One of them is enough.</p>"
        : o.login
          ? `<p>You are signed in as <b>${esc(o.login)}</b>. This server has no admin yet. As its admin, you decide who may sign in, and you change its settings.</p>
<form method="post" action="/setup/admin"><button class="new">Become the admin of ${esc(url.host)}</button></form>`
          : `<p>Sign in to become the first admin of <code>${esc(url.host)}</code>. After that, this page is closed for good.</p>
<span class="providers">${providerButtons(o.choices, "/setup/admin")}</span>`
    }
<p class="later">You manage the rest later, on the admin pages: Sign-in, Access (who may sign in) and Deploy (the updates).</p>`,
  });
  return rows;
}

/** How a person makes the deployer's token, and where it goes: on the setup page, and on the Deploy page (server/admin/deploy.ts). */
export const tokenSteps = (
  account: string,
  worker: string
) => `<p>A deployer in your Cloudflare account deploys each new release of Erga by itself. It needs a token that can change the Worker <code>${esc(worker)}</code>, and nothing else.</p>
<ol class="how">
  <li>Open <a href="https://dash.cloudflare.com/${esc(account)}/api-tokens" target="_blank" rel="noopener">Account API tokens</a> on Cloudflare, and choose Create Token.</li>
  <li>Give it one permission: Workers, for the Worker <code>${esc(worker)}</code> only, with the role Editor. No other permission, and no other Worker: the database needs none.</li>
  <li>Create the token, copy it, and paste it here.</li>
</ol>
<p>This server hands the token to the deployer, and keeps nothing of it. The deployer checks it with Cloudflare, and keeps it encrypted. Your agent never sees it. The deployer refuses a token that can do more.</p>`;

/** The field for the token. */
export const TOKEN_FIELD = `<label>The deployer's token<input class="input" type="password" name="token" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="Paste the token" required></label>`;
