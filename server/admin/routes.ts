// The admin page: the server's settings and its users and
// admins, for admins only. Everyone else gets "not found": they
// can't see the page, nor that there is one.
//
// The routes are ROUTES, below: each page, and the two POSTs that set a secret.
//
// The API keys page shows whether each key is set, its
// last four characters, and who set it when; and, read-only, the secrets only the
// deploy sets. The page never gets a saved key back, nor does any answer here.
//
// The Authentication page shows this server's GitHub OAuth app and Google
// OAuth client: the client ID (public), whether the secret is set (never the
// secret), the URLs the provider needs, a live check, and how to make one.
// A client ID and secret pasted there win over the deploy's, after the
// provider accepts them, with the lockout rules server/identity/apps.ts gives.
// Each server's page sets its own sign-in only. A save, a discard or a clear
// shows the page again in place, with its message under the provider's card.
//
// Every page has the layout every admin page shares: the
// breadcrumb, Share with agent, and the sidebar to Settings, API keys, Authentication, Change log, Users and Ops.
//
// Every other change on these pages (a setting, a user, a rule, a key cleared, a
// provider switched) is an operation (server/operations/admin.ts): the pages'
// scripts call it over POST /api/tools/<name>, as the agents do. These POSTs set
// secrets only, so they answer only the person, in their browser: JSON, or
// { error } with the message the directory gave, from this site's pages only.
// An agent token (Session.agent) never gets in, even an admin's. A setting the deploy locks is shown, read-only,
// and so is the dev server's DEV_LOGIN (a bootstrap admin), who can't be demoted or removed here,
// and the last admin, who can't be demoted or removed at all.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpServerResponse } from "effect/http";
import { routeFor, SECRET, type RouteRow } from "../../shared/routes.ts";
import { ConfigError, CredentialError, NotAllowed, roleValue, type UserRole } from "../directory/index.ts";
import { page } from "../pages/index.ts";
import { type Platform, type Session, whoOf } from "../platform.ts";
import { authOps, AuthError, ScopeError, type Provider } from "../identity/index.ts";
import type { Who } from "../directory/index.ts";
import { call, ctx, Field, form, json, plainJson, redirect } from "../http.ts";
import { settingsPage } from "./settings.ts";
import { analyticsPage, isSpan } from "./analytics.ts";
import { apiKeysPage } from "./api-keys.ts";
import { authPage } from "./auth.ts";
import { usersPage } from "./users.ts";
import { accessPage } from "./access.ts";
import { changesPage } from "./changes.ts";
import { feedbackPage } from "./feedback.ts";

/** Who asks, checked: an admin, in their browser. */
interface Asked {
  readonly platform: Platform;
  readonly session: Session;
  readonly who: Who;
  readonly url: URL;
}
type Answer = HttpServerResponse.HttpServerResponse;
type Run = (a: Asked, f: AdminFields) => Promise<Answer> | Answer;

/** The Authentication page's facts, with live checks. */
const authStatus = (a: Asked) => authOps(a.platform, a.url.origin).status(a.who);

/** Every /admin route: a page (GET), or a POST that sets a secret, which is set only here. */
export const ROUTES: readonly RouteRow<Run>[] = [
  {
    method: "GET",
    path: "/admin",
    // ?days=7, 30 or 90
    run: (a) => {
      const days = Number(a.url.searchParams.get("days") ?? 30);
      return analyticsPage(a.platform, a.session, isSpan(days) ? days : 30);
    },
    action: "Read each day's activity, the most active and newest users (Analytics)",
    domain: "admin",
    tool: "analytics",
  },
  {
    method: "GET",
    path: "/admin/settings",
    run: (a) => settingsPage(a.platform, a.session),
    action: "Read the settings and pages' model use today (Settings)",
    domain: "admin",
    tool: "settings",
  },
  {
    method: "GET",
    path: "/admin/changes",
    // The settings' versions and production deploys, newest first; ?before=n for older ones.
    run: (a) => {
      const before = Number(a.url.searchParams.get("before"));
      return changesPage(a.platform, a.session, Number.isInteger(before) && before > 0 ? before : undefined);
    },
    action: "Read the change log (Change log)",
    domain: "admin",
    tool: "settings",
  },
  {
    method: "GET",
    path: "/admin/users",
    run: (a) => usersPage(a.platform, a.session),
    action: "Read the users (Users)",
    domain: "admin",
    tool: "people",
  },
  {
    method: "GET",
    path: "/admin/access",
    run: (a) => accessPage(a.platform, a.session),
    action: "Read the group rules, and whether users can share content publicly (Access)",
    domain: "admin",
    tool: "people",
  },
  {
    method: "GET",
    path: "/admin/api-keys",
    run: (a) => apiKeysPage(a.platform, a.session),
    action: "Read the API keys' status (API keys)",
    domain: "admin",
    tool: "settings",
  },
  {
    method: "GET",
    path: "/admin/feedback",
    run: (a) => feedbackPage(a.platform, a.session),
    action: "Read the feedback people sent, with each one's issue (Feedback)",
    domain: "admin",
    tool: "feedback",
  },
  {
    method: "GET",
    path: "/admin/auth",
    run: async (a) => authPage(a.session, await authStatus(a)),
    action: "Read how people sign in on this server (Authentication)",
    domain: "admin",
    tool: "sign_in",
  },
  {
    method: "GET",
    path: "/admin/auth/status",
    // {here, google, providers} (server/identity/apps.ts, AuthStatus: never a secret)
    run: async (a) => json(await authStatus(a)),
    action: "Read the same, as JSON, with live checks (Authentication)",
    domain: "admin",
    tool: "sign_in",
  },
  {
    method: "POST",
    path: "/admin/credentials",
    // name (anthropic), and value. The answer says what the page shows: never the key.
    run: async (a, f) => plainJson({ credential: await a.platform.directory.credentials.set(a.who, f.name, f.value) }),
    action: "Set or replace an API key (API keys)",
    domain: "admin",
    exempt: SECRET,
  },
  {
    method: "POST",
    path: "/admin/auth",
    // provider (github or google), do=save (clientId, secret). The answer says what the page shows: never the secret.
    run: async (a, f) => {
      if (f.do != "save") return elsewhere();
      const provider: Provider = f.provider == "google" ? "google" : "github";
      return plainJson({
        result: await authOps(a.platform, a.url.origin).save(a.who, { clientId: f.clientId, secret: f.secret }, provider),
      });
    },
    action: "Set a GitHub app's or Google client's ID and secret (Authentication)",
    domain: "admin",
    exempt: SECRET,
  },
];

const elsewhere = () => plainJson({ error: "Not here: every other change is an operation, POST /api/tools/<name>." }, 404);

/** /admin and its POSTs. */
export const adminRoutes = Effect.gen(function* () {
  const { request, url, platform } = yield* ctx;
  const session = yield* call(() => platform.sessionOf(request));
  const read = request.method == "GET" || request.method == "HEAD";
  if (!session && read) return redirect(`/auth/sign-in?next=${encodeURIComponent(url.pathname)}`);
  const who = session && whoOf(session);
  // Only the person themselves, in a browser (which comes with admin power): an agent with their token isn't an admin here.
  const admin = !!who && !session?.agent && (yield* call(() => platform.directory.users.actsAsAdmin(who)));
  if (read) {
    const found = admin ? routeFor(ROUTES, "GET", url.pathname) : null;
    if (!found) return notFound();
    return yield* call(async () => found.route.run({ platform, session: session!, who: who!, url }, NO_FIELDS));
  }
  if (request.method != "POST") return notFound();
  if (!admin) return plainJson({ error: "Only an admin can do that." }, session ? 403 : 401);

  if (request.headers.get("origin") != url.origin) return plainJson({ error: "Forbidden" }, 403);
  const fields = yield* form(AdminForm).pipe(Effect.orDie);
  const run = routeFor(ROUTES, "POST", url.pathname)?.route.run ?? elsewhere;
  return yield* Effect.tryPromise({ try: async () => run({ platform, session: session!, who: who!, url }, fields), catch: refusal }).pipe(
    // The directory's own words, for a person to act on, with the refusal's own status.
    Effect.catch((e) => Effect.succeed(plainJson({ error: e.message }, e.status)))
  );
});

/** Every POST's fields (a field that's missing is ""). */
const AdminForm = Schema.Struct({
  do: Field,
  key: Field,
  value: Field,
  reset: Field,
  name: Field,
  clear: Field,
  provider: Field,
  clientId: Field,
  secret: Field,
  force: Field,
  on: Field,
  kind: Field,
  access: Field,
  id: Field,
  login: Field,
  person: Field,
  role: Field,
  handle: Field,
  deploy: Field,
});
type AdminFields = typeof AdminForm.Type;
const NO_FIELDS = Schema.decodeUnknownSync(AdminForm)({});

/** What a POST's call may refuse with, as its typed error; anything else is a defect. */
function refusal(e: unknown): NotAllowed | ScopeError | ConfigError | CredentialError | AuthError {
  if (
    e instanceof NotAllowed ||
    e instanceof ScopeError ||
    e instanceof ConfigError ||
    e instanceof CredentialError ||
    e instanceof AuthError
  )
    return e;
  throw e;
}

const notFound = () => page("Not found", "There's nothing here. <a href=\"/\">Back to the start</a>.", 404);
