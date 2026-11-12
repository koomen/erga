// The OAuth providers: GitHub and Google, one entry each (PROVIDERS). All that is one provider's own is in its entry:
// where its app is made and what its values look like, how its app is checked, its addresses, what its sign-in asks,
// and how it says who signed in (a `Vouched`: server/directory/identities.ts). The flow (oauth.ts), the apps' values
// and their rules (apps.ts, settings.ts) and the pages read an entry by its id, and never ask which provider it is.
// A new provider is a new entry here, a row in shared/sign-in.ts, and its two routes (server/app.ts).

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { githubAvatar, googleAvatar } from "../../shared/avatars.ts";
import { SIGN_IN_PROVIDERS } from "../../shared/sign-in.ts";
import { groupOf, NotAllowed, type Vouched } from "../directory/index.ts";

/** An app's two values. An empty string: not set. */
export interface AppValues {
  clientId: string;
  secret: string;
}

export type CheckState = "working" | "misconfigured" | "not_set_up" | "unknown";

/** What a live check of an app found. */
export interface AppCheck {
  state: CheckState;
  /** One sentence for the page. */
  summary: string;
  /** What is wrong, one item each (empty when it works). */
  reasons: string[];
  /** When (ms since the epoch). */
  at: number;
}

/** What a provider's token exchange answers. */
export type Token = { access_token?: string; error?: string; error_description?: string };

/** What a call to a provider may be told: a fetch (the tests'), and how long to wait. */
type Ask = { fetch?: typeof fetch; timeoutMs?: number };

/** One OAuth provider. `origin`, wherever it is given: a stand-in's (the tests'); null: the provider's own addresses. */
export interface OAuthProvider {
  label: string;
  /** Where an OAuth app is made. */
  newApp: string;
  /** The deploy's names for the app's client ID (a text binding) and secret (a Worker secret). */
  idEnv: string;
  secretEnv: string;
  callbackPath: string;
  /** What a client ID looks like, and how the page says so. */
  clientId: RegExp;
  clientIdShape: string;
  /** A client ID's start, as an example. */
  clientIdLike: string;
  /** What the provider calls an app. */
  appWord: string;
  /** What the page says when the secret is missing. */
  noSecret: string;
  /** The steps to make its app for a server: `name` (the app's), `origin` (the server's), `pagePlace` (where its values go). */
  setup(o: { name: string; origin: string; pagePlace: string }): string[];
  /** Whether an app's values work, without signing anyone in: a token exchange with a code that can't be real. */
  check(v: AppValues, o?: Ask & { origin?: string | null }): Promise<AppCheck>;
  /** Where a browser goes to sign in. */
  authorizeUrl(origin: string | null): string;
  /** What that address takes besides the client, the callback and the state. `groups`: a rule reads its groups. */
  authorize(o: { groups: boolean }): Record<string, string>;
  /** Its token for the callback's code, traded with the app's secret. */
  token(origin: string | null, app: AppValues, code: string, redirect: string): Promise<Token>;
  /** Who the token's person is; null: it didn't say. The token is used here once, and never stored. */
  who(origin: string | null, token: string, o: { groups: boolean }): Promise<Vouched | null>;
  /**
   * An account by its login, as the provider answers now (for a person added by a login); null: no such account.
   * `app`: the sign-in app, which the provider counts the lookups against. Absent: it has no logins to look up.
   */
  lookup?(origin: string | null, app: AppValues | null, login: string): Promise<{ subject: string; handle: string } | null>;
}

/** A check's answer, or null when none came in time (8 s unless said: the request is cancelled then), or the error. */
const answerIn = (ms: number | undefined, f: (signal: AbortSignal) => Promise<Response>) =>
  Effect.runPromise(
    Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) }).pipe(
      Effect.timeoutOption(Duration.millis(ms ?? 8000)),
      Effect.map(Option.getOrNull),
      Effect.catch((e) => Effect.succeed(e))
    )
  );

const checked =
  (at: number) =>
  (state: CheckState, summary: string, reasons: string[] = []): AppCheck => ({ state, summary, reasons, at });

// ------------------------------------------------------------ GitHub

const githubWww = (origin: string | null) => origin ?? "https://github.com";
/** GitHub's API (a stand-in serves its API under /api). */
const githubApi = (origin: string | null) => (origin ? `${origin}/api` : "https://api.github.com");
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "Erga" };

/**
 * The organizations someone is an active member of, private memberships too, as GitHub answers their token
 * (/user/memberships/orgs). An OAuth app's token needs read:org, and an organization that restricts OAuth apps must
 * have approved it; a GitHub App's token sees the organizations it's installed on, with Members (read). No answer:
 * none, so a rule that needs one refuses them, and says why.
 */
export async function memberships(api: string, token: string): Promise<string[]> {
  const r = await fetch(`${api}/user/memberships/orgs?state=active&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS },
  }).catch(() => null);
  if (!r?.ok) {
    console.log(`GitHub's /user/memberships/orgs answered ${r?.status ?? "nothing"}: no organizations for this sign-in`);
    return [];
  }
  const list = (await r.json().catch(() => [])) as { state?: string; organization?: { login?: string } }[];
  return Array.isArray(list)
    ? [...new Set(list.filter((m) => m.state == "active" && m.organization?.login).map((m) => m.organization!.login!.toLowerCase()))]
    : [];
}

const github: OAuthProvider = {
  label: SIGN_IN_PROVIDERS.github.label,
  newApp: "https://github.com/settings/applications/new",
  idEnv: "GITHUB_CLIENT_ID",
  secretEnv: "GITHUB_CLIENT_SECRET",
  callbackPath: "/auth/github/callback",
  clientId: /^[A-Za-z0-9._-]{8,80}$/,
  clientIdShape: "a GitHub Client ID: it is 8 to 80 letters and digits, like Ov23li…",
  clientIdLike: "Ov23li…",
  appWord: "app",
  noSecret: "Paste the app's client secret too (Generate a new client secret, on the app's page on GitHub).",
  setup: (o) => [
    `Open ${github.newApp}, signed in as the GitHub account that should own the app.`,
    `Enter the application name "${o.name}", the homepage URL ${o.origin}, and the authorization callback URL ${o.origin}${github.callbackPath}. Leave Enable Device Flow off. Click Register application.`,
    `Copy the Client ID. Click Generate a new client secret, and copy the secret.`,
    `Paste both ${o.pagePlace} and click Save. Erga checks them with GitHub before it uses them.`,
  ],
  // GitHub answers 404 for a client ID it doesn't know, incorrect_client_credentials for a wrong (or no) secret, and
  // bad_verification_code when the client ID and secret are right. The callback URL is checked only during a real sign-in.
  async check(v, o = {}) {
    const out = checked(Date.now());
    if (!v.clientId) return out("not_set_up", "No GitHub OAuth app: nobody can sign in with GitHub here.", ["No client ID."]);
    const f = o.fetch ?? fetch;
    const r = await answerIn(o.timeoutMs, (signal) =>
      f(`${githubWww(o.origin ?? null)}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Erga" },
        body: JSON.stringify({ client_id: v.clientId, client_secret: v.secret, code: `erga-check-${crypto.randomUUID()}` }),
        signal,
      })
    );
    if (r instanceof Error) return out("unknown", `Couldn't reach GitHub to check the app (${r.message}).`);
    if (!r) return out("unknown", "GitHub didn't answer the check in time.");
    const body = (await r.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (r.status == 404 || body.error == "Not Found")
      return out("misconfigured", "GitHub has no OAuth app with this client ID.", [
        `GitHub doesn't know the client ID ${v.clientId}: it is wrong, or its app was deleted.`,
      ]);
    if (body.error == "incorrect_client_credentials") {
      return v.secret
        ? out("misconfigured", "The client secret is wrong.", [
            "GitHub refused the client secret for this client ID. Generate a new one on the app's page on GitHub.",
          ])
        : out("misconfigured", "The app has no client secret here.", ["The client ID is right, but there is no client secret."]);
    }
    if (body.error == "bad_verification_code") return out("working", "GitHub accepts the client ID and secret.");
    if (r.status == 429 || r.status >= 500) return out("unknown", `GitHub couldn't check the app now (${r.status}).`);
    return out(
      "unknown",
      `GitHub answered the check with ${body.error ? `"${body.error}"` : `status ${r.status}`}.`,
      body.error_description ? [body.error_description] : []
    );
  },
  authorizeUrl: (origin) => `${githubWww(origin)}/login/oauth/authorize`,
  // read:org, only while a rule names a GitHub organization: their memberships, private ones too (an OAuth app's scope;
  // Erga's GitHub App ignores scopes: it needs the Members permission, and to be installed on the organization).
  authorize: ({ groups }) => ({ scope: groups ? "read:user read:org" : "read:user", allow_signup: "false" }),
  token: (origin, app, code, redirect) =>
    fetch(`${githubWww(origin)}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Erga" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.secret, code, redirect_uri: redirect }),
    }).then(
      (r) => r.json() as Promise<Token>,
      (e: Error) => ({ error: "unreachable", error_description: e.message })
    ),
  async who(origin, token, { groups }) {
    const api = githubApi(origin);
    const user = await fetch(`${api}/user`, { headers: { Authorization: `Bearer ${token}`, ...GITHUB_HEADERS } }).then(
      (r) => r.json() as Promise<{ login?: string; name?: string | null; id?: number }>,
      () => ({}) as { login?: string; name?: string | null; id?: number }
    );
    if (!user.login || typeof user.id != "number") return null;
    const login = user.login.toLowerCase();
    // No email: GitHub's profile email isn't one it vouches for. Its organizations, when a rule names any: asked now,
    // with their token. An account from before identities has its GitHub login as its username (oldLogin).
    const orgs = groups ? await memberships(api, token) : null;
    return {
      provider: "github",
      subject: String(user.id),
      handle: login,
      name: user.name?.trim() || null,
      emails: [],
      groups: orgs?.map((o) => groupOf("github_org", o)) ?? null,
      picture: githubAvatar(user.id),
      oldLogin: login,
    };
  },
  // GitHub's public users API (GET /users/<login>): asked as the sign-in app, so GitHub counts the lookups against the
  // app's 5,000 an hour, not the 60 an hour of the server's IP, which other Cloudflare Workers share.
  async lookup(origin, app, login) {
    const r = await fetch(`${githubApi(origin)}/users/${encodeURIComponent(login)}`, {
      headers: {
        ...GITHUB_HEADERS,
        ...(app?.clientId && app.secret ? { Authorization: `Basic ${btoa(`${app.clientId}:${app.secret}`)}` } : {}),
      },
    }).catch(() => null);
    if (r?.status == 404) return null;
    const body = r?.ok ? ((await r.json().catch(() => null)) as { id?: number; login?: string; type?: string } | null) : null;
    if (!body?.id || !body.login) {
      // One line in the server's log: never the login, nor the app's values.
      console.log(`GitHub's users lookup: ${r ? `status ${r.status}` : "no answer"}`);
      const reset = Number(r?.headers.get("x-ratelimit-reset"));
      if ((r?.status == 403 || r?.status == 429) && r.headers.get("x-ratelimit-remaining") == "0")
        throw new NotAllowed({
          message: reset
            ? `GitHub's rate limit stops this lookup until ${new Date(reset * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC: try again then.`
            : "GitHub's rate limit stops this lookup: try again in an hour.",
        });
      throw new NotAllowed({
        message: `GitHub didn't answer for "${login}" (${r ? `status ${r.status}` : "no answer"}): try again in a minute.`,
      });
    }
    if (body.type && body.type != "User")
      throw new NotAllowed({ message: `"${body.login}" is a GitHub ${body.type.toLowerCase()}, not a person's account.` });
    return { subject: String(body.id), handle: body.login };
  },
};

// ------------------------------------------------------------ Google

/** Google's sign-in endpoints, or a stand-in's under its origin (the tests'). */
const googleEndpoints = (origin: string | null) =>
  origin
    ? { authorize: `${origin}/o/oauth2/v2/auth`, token: `${origin}/token`, userinfo: `${origin}/v1/userinfo` }
    : {
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
      };

/** Google's token exchange: a form. */
const googleExchange = (origin: string | null, body: Record<string, string>, signal?: AbortSignal, f: typeof fetch = fetch) =>
  f(googleEndpoints(origin).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...body, grant_type: "authorization_code" }).toString(),
    signal,
  });

const google: OAuthProvider = {
  label: SIGN_IN_PROVIDERS.google.label,
  newApp: "https://console.cloud.google.com/apis/credentials",
  idEnv: "GOOGLE_CLIENT_ID",
  secretEnv: "GOOGLE_CLIENT_SECRET",
  callbackPath: "/auth/google/callback",
  clientId: /^[0-9]{4,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/,
  clientIdShape: "a Google OAuth client ID: digits, a dash, letters and digits, then .apps.googleusercontent.com",
  clientIdLike: "1234…apps.googleusercontent.com",
  appWord: "client",
  noSecret: "Paste the client's secret too (on the client's page in Google Cloud Console).",
  setup: (o) => [
    `Open ${google.newApp}, in the Google Cloud project that should own the client. If Google asks, set up the OAuth consent screen first (External, the app name "${o.name}", your support email).`,
    `Click Create credentials, then OAuth client ID. Choose the application type Web application, and the name "${o.name}".`,
    `Under Authorized redirect URIs, add ${o.origin}${google.callbackPath}. Click Create.`,
    `Copy the Client ID and the Client secret.`,
    `Paste both ${o.pagePlace} and click Save. Erga checks them with Google before it uses them.`,
  ],
  // Google answers invalid_client for a client ID it doesn't know ("The OAuth client was not found.") or a wrong secret
  // ("Unauthorized"), and invalid_grant when the client ID and secret are right. The redirect URI is checked only
  // during a real sign-in.
  async check(v, o = {}) {
    const out = checked(Date.now());
    if (!v.clientId) return out("not_set_up", "No Google OAuth client: nobody can sign in with Google here.", ["No client ID."]);
    const r = await answerIn(o.timeoutMs, (signal) =>
      googleExchange(
        o.origin ?? null,
        {
          client_id: v.clientId,
          client_secret: v.secret,
          code: `erga-check-${crypto.randomUUID()}`,
          redirect_uri: "https://example.com/auth/google/callback",
        },
        signal,
        o.fetch
      )
    );
    if (r instanceof Error) return out("unknown", `Couldn't reach Google to check the client (${r.message}).`);
    if (!r) return out("unknown", "Google didn't answer the check in time.");
    const body = (await r.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (body.error == "invalid_client") {
      if (/not found/i.test(body.error_description ?? ""))
        return out("misconfigured", "Google has no OAuth client with this client ID.", [
          `Google doesn't know the client ID ${v.clientId}: it is wrong, or its client was deleted.`,
        ]);
      return v.secret
        ? out("misconfigured", "The client secret is wrong.", [
            "Google refused the client secret for this client ID. Add a new secret on the client's page in Google Cloud Console.",
          ])
        : out("misconfigured", "The client has no secret here.", ["The client ID is right, but there is no client secret."]);
    }
    if (body.error == "invalid_grant") return out("working", "Google accepts the client ID and secret.");
    if (r.status == 429 || r.status >= 500) return out("unknown", `Google couldn't check the client now (${r.status}).`);
    return out(
      "unknown",
      `Google answered the check with ${body.error ? `"${body.error}"` : `status ${r.status}`}.`,
      body.error_description ? [body.error_description] : []
    );
  },
  authorizeUrl: (origin) => googleEndpoints(origin).authorize,
  authorize: () => ({ response_type: "code", scope: "openid email profile", prompt: "select_account" }),
  token: (origin, app, code, redirect) =>
    googleExchange(origin, { client_id: app.clientId, client_secret: app.secret, code, redirect_uri: redirect }).then(
      (r) => r.json() as Promise<Token>,
      (e: Error) => ({ error: "unreachable", error_description: e.message })
    ),
  // OpenID Connect's claims: their sub, their email and whether Google verified it, their picture, and for a Google
  // Workspace account its organization (hd: its domain; a personal account has none).
  async who(origin, token) {
    type User = { sub?: string; email?: string; email_verified?: boolean | string; name?: string; hd?: string; picture?: string };
    const user = await fetch(googleEndpoints(origin).userinfo, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }).then(
      (r) => r.json() as Promise<User>,
      () => ({}) as User
    );
    if (!user.sub) return null;
    const email = user.email?.trim().toLowerCase() ?? "";
    const hd = user.hd?.trim().toLowerCase();
    return {
      provider: "google",
      subject: String(user.sub),
      handle: email || String(user.sub),
      name: user.name?.trim() || null,
      emails: email ? [{ email, verified: user.email_verified === true || user.email_verified === "true" }] : [],
      groups: hd ? [groupOf("workspace", hd)] : [],
      picture: googleAvatar(user.picture),
    };
  },
};

/** The OAuth providers, by id. */
export const PROVIDERS = { github, google } satisfies Record<string, OAuthProvider>;
export type Provider = keyof typeof PROVIDERS;
/** A provider by an id as given (a path, a form); null: none. */
export const providerOf = (id: unknown): Provider | null =>
  typeof id == "string" && Object.hasOwn(PROVIDERS, id) ? (id as Provider) : null;
