// /setup: where the person finishes a new server, on one page. `bun erga setup` (deploy/own/cli.ts) builds the server
// with no sign-in and no admin, and opens this page in the person's browser with a link that is signed with the
// server's own secret, which only the machine that set it up has. The steps, each a row of the page:
//
//   GitHub   one click: GitHub makes a GitHub App from a manifest and comes back here with a code; the server changes
//            it for the app's client ID and secret, and keeps them as /admin/auth does (apps.ts: encrypted)
//   Google   the person makes an OAuth client and pastes its client ID and secret; the server checks them with Google
//   Updates  only where the link says so (cloud deploys on Cloudflare): the person pastes the deployer's token, and the
//            setup command installs the deployer with it (setup-link.ts says how the two meet)
//   Admin    the person signs in with a provider that is set up, and becomes the server's first admin
//
// One provider is enough. With a gate in front (mode.ts) the page has no provider's row: the gate signs people in.
//
//   GET  /setup?t=<link>     the link, one time: this browser gets the page's pass (a cookie), and goes to /setup
//   GET  /setup              the page
//   GET  /setup/github       GitHub's answer, with the app's code
//   POST /setup/google       clientId, secret
//   POST /setup/deployer     token, or skip
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
import type { Platform } from "../platform";
import { signed } from "../signed.ts";
import { AuthError, type ProvidersOn } from "./apps.ts";
import { cookies, withCookie } from "./cookies.ts";
import { CALLBACK_PATH, PROVIDERS } from "./providers.ts";
import { appsSet, setUpApp, signInChoices } from "./settings.ts";
import {
  type DeployerEvent,
  type DeployerStep,
  deployerStep,
  LINK_SECONDS,
  PASS_SECONDS,
  readStep,
  sealToken,
  type SetupFacts,
  SetupFacts as Facts,
  SetupLink,
} from "./setup-link.ts";

const COOKIE = "erga_setup";
/** The pass of the browser that opened the link: the link's facts, for as long as a setup may take. */
const Pass = signed("setup", Facts, PASS_SECONDS);
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

const SetupForm = Schema.Struct({ clientId: Field, secret: Field, token: Field, skip: Field });

/** A token as a person pastes it: one line, with no spaces. */
const TOKEN = /^[\x21-\x7e]{20,400}$/;

export const setupRoute: Route = Effect.gen(function* () {
  const { platform, request, url } = yield* ctx;
  const post = request.method == "POST";
  if (post && request.headers.get("origin") != url.origin) return text("Forbidden", 403);
  const dev = platform.dev(url);
  if (!dev && (yield* call(() => platform.directory.users.hasAdmin()))) return closed();
  let facts: SetupFacts | null = yield* call(() => Pass.open(platform.secret, cookies(request).get(COOKIE)));
  const t = url.searchParams.get("t");
  if (url.pathname == "/setup" && !post && t) {
    const link = yield* call(() => SetupLink.open(platform.secret, t));
    // A link that was used, in the browser that has the page: the page. (A new link brings its own facts: a run
    // again of the setup command, with another answer.)
    if (!link || !(yield* call(() => spend(platform, link.n)))) return facts ? redirect("/setup", 302, NO_STORE) : gone();
    const pass = yield* call(() => Pass.seal(platform.secret, { deployer: link.deployer }));
    return withCookie(redirect("/setup", 302, NO_STORE), request, COOKIE, pass, PASS_SECONDS);
  }
  facts ??= dev ? { deployer: null } : null;
  if (!facts) return gone();
  const deploys = platform.directory.deploys;
  const show = (problem?: Problem) => setupPage(platform, request, url, facts, problem);
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
      if (!facts.deployer) return redirect("/setup", 303, NO_STORE);
      const f = yield* form(SetupForm).pipe(Effect.orDie);
      const token = f.token.trim();
      if (!f.skip && !TOKEN.test(token))
        return yield* show({
          row: "deployer",
          message: token ? "That isn't a token: it is one line, with no spaces." : "Paste the token.",
        });
      const event: DeployerEvent = f.skip
        ? { kind: "skipped" }
        : { kind: "pasted", ...(yield* call(() => sealToken(platform.secret, token))) };
      // The setup command writes the row too: the event goes onto the row as it is now, until that holds.
      yield* call(async () => {
        for (let i = 0; i < 5; i++) {
          const from = await deploys.setupStep();
          if (await deploys.setSetupStep(from, JSON.stringify(deployerStep(readStep(from), event)))) return;
        }
      });
      return redirect("/setup", 303, NO_STORE);
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

type State = "done" | "next" | "optional" | "skipped" | "working" | "waiting";
const CHIP: Record<State, string> = {
  done: "Done",
  next: "Next",
  optional: "Optional",
  skipped: "Skipped",
  working: "Installing",
  waiting: "Waiting",
};

/** The page: each row as the server is now. `problem`: what a row's last try said, shown in that row (status 400). */
const setupPage = (platform: Platform, request: Request, url: URL, facts: SetupFacts, problem?: Problem) =>
  Effect.gen(function* () {
    const oauth = platform.signIn.mode == "oauth";
    const [set, choices, step, session, state] = yield* call(() =>
      Promise.all([
        oauth ? appsSet(platform) : null,
        signInChoices(platform),
        facts.deployer ? platform.directory.deploys.setupStep().then(readStep) : null,
        platform.sessionOf(request),
        GithubState.seal(platform.secret, {}),
      ])
    );
    const rows = rowsOf({
      platform,
      url,
      facts,
      set,
      choices,
      step,
      login: session && !session.agent ? session.login : null,
      state,
      problem,
    });
    // The row that is open: the one with a problem, else the first that is next.
    const open = problem?.row ?? rows.find((r) => r.state == "next" || r.state == "working")?.id;
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
</main>${step?.at == "waiting" ? `<script>setTimeout(()=>location.replace("/setup"),3000)</script>` : ""}`;
    return html(appPage("Setup", `${inlineStyle("setup")}${PROVIDER_CSS}`, body), problem ? 400 : 200, NO_STORE);
  });

interface RowsOf {
  platform: Platform;
  url: URL;
  facts: SetupFacts;
  /** The OAuth mode: the providers that have an app. null: a gate in front signs people in. */
  set: ProvidersOn | null;
  choices: SignInChoice[];
  /** null: the page has no step for the deployer. */
  step: DeployerStep | null;
  /** Who is signed in on this browser, in person. */
  login: string | null;
  state: string;
  problem?: Problem;
}

/** The rows, in order: each one's state, and what it says. */
function rowsOf(o: RowsOf): { id: Row; title: string; state: State; body: string }[] {
  const { url, set, step } = o;
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
  if (step && o.facts.deployer) {
    const { account, worker } = o.facts.deployer;
    const state: State =
      step.at == "installed" ? "done" : step.at == "skipped" ? "skipped" : step.at == "waiting" ? "working" : any ? "next" : "waiting";
    const formHtml = `<p>A deployer in your Cloudflare account deploys each new release of Erga by itself. It needs a token that can change the Worker <code>${esc(worker)}</code>, and nothing else.</p>
<ol class="how">
  <li>Open <a href="https://dash.cloudflare.com/${esc(account)}/api-tokens" target="_blank" rel="noopener">Account API tokens</a> on Cloudflare, and choose Create Token.</li>
  <li>Give it one permission: Workers, for the Worker <code>${esc(worker)}</code> only, with the role Editor. No other permission, and no other Worker: the database needs none.</li>
  <li>Create the token, copy it, and paste it here.</li>
</ol>
<p>This server keeps the token sealed, until the setup command on your machine installs the deployer with it. Then the token is the deployer's secret on Cloudflare, and this server holds it no more. Your agent never sees it. Erga refuses a token that can do more.</p>
<form method="post" action="/setup/deployer" class="fields">
  <label>The deployer's token<input class="input" type="password" name="token" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="Paste the token"></label>
  <div class="buttons"><button class="new">Install the deployer</button>${step.at == "skipped" ? "" : `<button class="pill" name="skip" value="1" formnovalidate>Skip for now</button>`}</div>
</form>`;
    rows.push({
      id: "deployer",
      title: "Turn on automatic updates",
      state,
      body:
        step.at == "installed"
          ? `<p>The deployer is installed: each new release of Erga deploys by itself. An admin turns that off on the Deploy page (<code>/admin/deploy</code>).</p>${
              step.unconfirmed.length
                ? `<p>Erga could not confirm:</p><ul class="how">${step.unconfirmed.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`
                : ""
            }`
          : step.at == "waiting"
            ? `<p><b>Erga checks the token and installs the deployer.</b> This takes some seconds, and the page shows the result by itself.</p><p>The setup command on your machine does this work. If nothing changes after a minute, ask your agent to run its <code>bun erga setup</code> command again.</p>`
            : `${step.at == "refused" ? `<p class="problem" role="alert">The deployer is not installed:<br>${esc(step.why).replace(/\n/g, "<br>")}</p>` : ""}${
                step.at == "skipped"
                  ? `<p><b>Skipped.</b> No deployer is installed: you deploy each new release from your machine, with <code>bun erga deploy ${esc(url.host)}</code>. To install the deployer after all, paste a token now, or run setup again later.</p>`
                  : ""
              }${formHtml}`,
    });
  }
  const answered = !step || step.at == "installed" || step.at == "skipped";
  const ready = any && answered;
  rows.push({
    id: "admin",
    title: "Sign in as the admin",
    state: ready ? "next" : "waiting",
    body: `${
      !ready
        ? `<p>${any ? "First answer the step for automatic updates, above." : "First set up GitHub or Google sign-in, above. One of them is enough."}</p>`
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
