// Erga's GitHub App ("Erga Editor", public, installable on any account): the
// one piece of GitHub Erga talks to, for everything it does there.
//
//   - Sign-in to the control Worker (ops.erga.dev): the App's user
//     authorization, the usual OAuth code flow (sign-in.ts). An install's
//     Workers sign in through erga.dev's callback, the only one registered
//     on the App: the relay (relayState, sealRelay, openRelay).
//   - Connect GitHub on the Ops page: a popup to the App's install page. The
//     person picks the repository there (or Erga makes one with their user
//     token), and GitHub comes back with the installation's id. Erga keeps the
//     id and the repository (GithubLink, in the repository's state), and from
//     then on mints installation tokens (an hour each) from the App's private
//     key, to push the embedded repository to GitHub and to read what GitHub
//     has (the sync: repo.ts).
//   - The webhook (/github/webhook): GitHub tells Erga of each push, signed
//     with the webhook secret (verifyWebhook); a push on GitHub syncs back.
//
// No token is ever pasted: the client secret, the private key and the webhook
// secret are the control Worker's secrets, set once from files
// (control/wrangler.jsonc says which). Platform-neutral: WebCrypto only, and
// a `net` to reach GitHub (the tests' and local development's pretend GitHub,
// dev/github-mock.ts, answers the same routes).

import * as Schema from "effect/Schema";
import { base64url, fromBase64url, hex, sha256 } from "../../shared/bytes";

export interface GithubApp {
  /** The App's id (the JWT's issuer), slug (its install page: github.com/apps/<slug>) and client id (sign-in). */
  appId: string; slug: string; clientId: string;
  /** The client secret (the code exchange), the private key (PKCS#8 PEM: installation tokens), the webhook secret: erga.dev's control Worker has them; an install's has none (it goes through erga.dev). */
  clientSecret?: string; privateKey?: string; webhookSecret?: string;
  /** GitHub's two origins (the pretend GitHub's, in local development and the tests). */
  www: string; api: string;
}

/** The repository Erga is connected to on GitHub: the App's installation there, and the one repository it pushes to. */
export interface GithubLink {
  installationId: number;
  /** Whose account the App is installed on (a user or an organization). */
  account: { login: string; type: string };
  repo: { id: number; fullName: string; cloneUrl: string; htmlUrl: string; private: boolean; defaultBranch: string };
  /** Who connected it, and when. */
  by: string; at: number;
}

/** A repository as GitHub lists it, the fields Erga keeps. */
export interface GithubRepo { id: number; full_name: string; clone_url: string; html_url: string; private: boolean; default_branch: string; owner?: { login: string; type: string } }

/** What GitHub answers for an error: its message. */
export class GithubError extends Schema.TaggedError<GithubError>()("GithubError", { message: Schema.String, status: Schema.Number }) {}

type Net = (input: string, init?: RequestInit) => Promise<Response>;
const enc = new TextEncoder();
const UA = "Erga";

/** GitHub's origins from the App's setting: github.com and api.github.com, or the pretend GitHub (one origin, its API under /api). */
export function githubOrigins(standIn?: string | null): { www: string; api: string } {
  const s = standIn?.trim().replace(/\/+$/, "");
  return s ? { www: s, api: `${s}/api` } : { www: "https://github.com", api: "https://api.github.com" };
}

// ---------------------------------------------------------------- the App's own authentication

/** A JWT for the App itself (RS256, 9 minutes): GET /app, installation tokens, the webhook's deliveries. */
export async function appJwt(appId: string, privateKey: string, now = Date.now()): Promise<string> {
  const pem = privateKey.trim();
  if (!pem.includes("BEGIN PRIVATE KEY"))
    throw new GithubError({
      message:
        "The App's private key must be PKCS#8 (-----BEGIN PRIVATE KEY-----): convert GitHub's .pem with openssl pkcs8 -topk8 -nocrypt.",
      status: 500,
    });
  const der = fromBase64url(
    pem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const at = Math.floor(now / 1000);
  const head = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify({ iat: at - 60, exp: at + 9 * 60, iss: appId })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64url(sig)}`;
}

/** An installation token: an hour's access to the installation's repositories (Contents read and write). */
export async function installationToken(
  app: GithubApp,
  installationId: number,
  net: Net = fetch
): Promise<{ token: string; expiresAt: number }> {
  if (!app.privateKey)
    throw new GithubError({ message: "This Worker has no private key for the GitHub App (GITHUB_APP_PRIVATE_KEY).", status: 500 });
  const jwt = await appJwt(app.appId, app.privateKey);
  const r = await net(`${app.api}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": UA } });
  const body = (await r.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string };
  if (!r.ok || !body.token)
    throw new GithubError({
      message:
        r.status == 404
          ? "GitHub says the App is no longer installed there (the installation is gone): connect GitHub again."
          : `GitHub gave no installation token (${r.status}${body.message ? `: ${body.message}` : ""}).`,
      status: r.status,
    });
  return { token: body.token, expiresAt: Date.parse(body.expires_at ?? "") || Date.now() + 3600_000 };
}

/** The installation's repositories as a Git remote (push and fetch), with its token as the password. */
export const githubRemote = (cloneUrl: string, token: string) => ({ url: cloneUrl, headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } });

/** The App uninstalled from the account (Disconnect): GitHub removes its access there. */
export async function uninstall(app: GithubApp, installationId: number, net: Net = fetch): Promise<void> {
  if (!app.privateKey) return;
  const jwt = await appJwt(app.appId, app.privateKey);
  await net(`${app.api}/app/installations/${installationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": UA } });
}

// ---------------------------------------------------------------- the webhook

export async function signWebhook(secret: string, body: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = typeof body == "string" ? enc.encode(body) : body;
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes as BufferSource)))}`;
}

/** Whether `signature` (X-Hub-Signature-256) is the webhook secret's over `body`: a constant-time compare. */
export async function verifyWebhook(secret: string, body: Uint8Array | string, signature: string | null): Promise<boolean> {
  if (!secret || !signature) return false;
  const want = await signWebhook(secret, body);
  if (want.length != signature.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff == 0;
}

/** A push event's payload, the fields Erga reads. */
export interface PushEvent { ref?: string; before?: string; after?: string; repository?: { id?: number; full_name?: string }; installation?: { id?: number }; sender?: { login?: string }; pusher?: { name?: string } }

// ---------------------------------------------------------------- the consent: sign-in, and Connect GitHub

/** Where the browser goes to install the App (Connect GitHub): GitHub asks which account and repositories, then comes back to the App's callback. */
export function installUrl(app: GithubApp, state: string): string {
  const u = new URL(`${app.www}/apps/${app.slug}/installations/new`);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface UserToken { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string }

/** The code GitHub sent back, traded for the person's token (the App's client secret: erga.dev's control Worker only). */
export async function exchangeUserCode(app: GithubApp, o: { code: string; redirect: string }, net: Net = fetch): Promise<UserToken> {
  if (!app.clientSecret) return { error: "no_client_secret", error_description: "This Worker has no client secret for the GitHub App." };
  const r = await net(`${app.www}/login/oauth/access_token`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code: o.code, redirect_uri: o.redirect }),
  }).catch((e: Error) => {
    throw new GithubError({ message: `Couldn't reach GitHub to finish the sign-in (${e.message}).`, status: 502 });
  });
  return (
    ((await r.json().catch(() => null)) as UserToken | null) ?? {
      error: `http_${r.status}`,
      error_description: "GitHub's token endpoint answered no JSON.",
    }
  );
}

/** GitHub's REST API with a token (a user's, an installation's): the JSON answer, or a GithubError with GitHub's message. */
export async function api<T>(app: Pick<GithubApp, "api">, token: string, method: string, path: string, body?: unknown, net: Net = fetch): Promise<T> {
  const r = await net(`${app.api}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).catch((e: Error) => {
    throw new GithubError({ message: `Couldn't reach GitHub (${e.message}).`, status: 502 });
  });
  if (r.status == 204) return undefined as T;
  const answer = (await r.json().catch(() => null)) as (T & { message?: string; errors?: { message?: string }[] }) | null;
  if (!r.ok)
    throw new GithubError({
      message: `GitHub answered ${r.status}${answer?.message ? `: ${answer.message}` : ""}${
        answer?.errors?.length
          ? ` (${answer.errors
              .map((e) => e.message)
              .filter(Boolean)
              .join("; ")})`
          : ""
      }`,
      status: r.status,
    });
  return answer as T;
}

/** Who the token's person is. */
export const userOf = (app: GithubApp, token: string, net?: Net) => api<{ login?: string; name?: string | null; id?: number }>(app, token, "GET", "/user", undefined, net);

/** The installation, as its person sees it: whose account, and whether it covers all repositories or a selection. */
export const installationOf = (app: GithubApp, token: string, id: number, net?: Net) =>
  api<{ installations?: { id: number; account?: { login: string; type: string }; repository_selection?: string }[] }>(app, token, "GET", "/user/installations?per_page=100", undefined, net)
    .then((r) => r.installations?.find((i) => i.id == id) ?? null);

/** The repositories the installation reaches that the person reaches too (what they picked on GitHub's page). */
export const installationRepos = (app: GithubApp, token: string, id: number, net?: Net) =>
  api<{ repositories?: GithubRepo[] }>(app, token, "GET", `/user/installations/${id}/repositories?per_page=100`, undefined, net).then((r) => r.repositories ?? []);

/**
 * A new repository, made with the person's token (the App needs the Administration permission for it), and added to
 * the installation when it covers a selection. `owner`: the account the App is installed on (the person, or their
 * organization).
 */
export async function createRepo(app: GithubApp, token: string, o: { owner: { login: string; type: string }; me: string; name: string; isPrivate: boolean; installationId: number; selection: string }, net?: Net): Promise<GithubRepo> {
  const name = o.name.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name))
    throw new GithubError({ message: "A repository's name is letters, digits, dots, dashes and underscores.", status: 400 });
  const body = { name, private: o.isPrivate, description: "Erga's source (synced from Erga)", auto_init: false };
  const path = o.owner.type == "Organization" || o.owner.login.toLowerCase() != o.me.toLowerCase() ? `/orgs/${o.owner.login}/repos` : "/user/repos";
  let repo: GithubRepo;
  try {
    repo = await api<GithubRepo>(app, token, "POST", path, body, net);
  } catch (e) {
    if (e instanceof GithubError && (e.status == 403 || e.status == 404))
      throw new GithubError({
        message: `GitHub didn't let Erga make the repository (${e.message}). The App needs the Administration permission on repositories for that; or make ${o.owner.login}/${name} on GitHub yourself, then Connect GitHub again and pick it.`,
        status: e.status,
      });
    throw e;
  }
  if (o.selection != "all") {
    // Added to the installation (204; 304 when it's there already).
    await api(app, token, "PUT", `/user/installations/${o.installationId}/repositories/${repo.id}`, undefined, net).catch(
      (e: GithubError) => {
        if (e.status != 304)
          throw new GithubError({
            message: `The repository is made, but couldn't be added to the App's installation (${e.message}): add it on GitHub (the App's settings), then Connect GitHub again.`,
            status: e.status,
          });
      }
    );
  }
  return repo;
}

/** The link as Erga keeps it, from GitHub's repository and installation. */
export function linkOf(installationId: number, account: { login: string; type: string }, repo: GithubRepo, by: string, at = Date.now()): GithubLink {
  return { installationId, account, repo: { id: repo.id, fullName: repo.full_name, cloneUrl: repo.clone_url, htmlUrl: repo.html_url, private: !!repo.private, defaultBranch: repo.default_branch || "main" }, by, at };
}

// ---------------------------------------------------------------- the relay: an install's consent through erga.dev (shared/relay.ts)

/** A webhook relayed to an install's control Worker: signed with the fork secret's hash (both sides have it; nobody else). */
export const relaySignature = (forkSecretHash: string, body: Uint8Array | string) => signWebhook(`erga-relay:${forkSecretHash}`, body);
export const verifyRelay = (forkSecretHash: string, body: Uint8Array | string, signature: string | null) => verifyWebhook(`erga-relay:${forkSecretHash}`, body, signature);
