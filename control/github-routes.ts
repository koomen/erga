// The control Worker's GitHub routes (control/routes.ts hands them the request): the App's one callback
// (/auth/github/callback: a sign-in, Connect GitHub coming back, an install's consent relayed), Google's relay for
// an install's sign-in, Connect GitHub (/github/connect, and its pick page), and the webhook (/github/webhook).

import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Base64Url } from "effect/encoding";
import { sealKeyFrom } from "./deploys/credential.ts";
import { CONTROL, TARGETS } from "../deploy/targets.ts";
import { cookies, finishSignIn, GITHUB_CONNECT_COOKIE, googleEndpoints, googleToken, setCookie } from "../server/identity/index.ts";
import { open, seal } from "./deploys/seal.ts";
import {
  createRepo,
  exchangeUserCode,
  GithubError,
  githubAuthorizeUrl,
  installationOf,
  installationRepos,
  installUrl,
  linkOf,
  relaySignature,
  userInstallations,
  userOf,
  verifyRelay,
  verifyWebhook,
  type GithubRepo,
  PushEvent,
  type UserToken,
} from "./source/index.ts";
import { openRelay, relayNonce, relayOrigin, relayState, sealRelay } from "../shared/relay.ts";
import { byLine } from "../shared/attribution.ts";
import { actingAdmin } from "../server/identity/index.ts";
import type { AdminLayout } from "../server/admin/index.ts";
import { webPage as page } from "../server/pages/index.ts";
import { esc, jsonInScript } from "../shared/html.ts";
import { randomToken } from "../shared/bytes.ts";
import { respond } from "../server/http.ts";
import { json } from "../shared/http.ts";
import type { Control } from "./routes.ts";

/** An install's consent state: its control Worker's origin (base64url), a dot, a random part (shared/relay.ts relayState; relayOrigin reads the origin back). */
export const b64u = (s: string) => Base64Url.encode(s);
/** A consent's cookie (base64url JSON) as `schema` reads it, or null. */
export const cookieOf = <A>(schema: Schema.Codec<A>, value: string | undefined): A | null =>
  Result.match(Base64Url.decodeString(value ?? ""), {
    onFailure: () => null,
    onSuccess: (json) => Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(json)),
  });

const GITHUB_COOKIE = GITHUB_CONNECT_COOKIE;
/** What the connect popup posts to the page that opened it (the Ops page, here or on the app), and on its BroadcastChannel. */
export const GITHUB_MESSAGE = "erga-github";
/** The consent in flight, in its cookie: the state, whether it runs in a popup; and, while the person picks a repository, the installation and their token (sealed). */
const GithubConsent = Schema.Struct({
  state: Schema.String,
  popup: Schema.Boolean,
  installation: Schema.optionalKey(Schema.Number),
  token: Schema.optionalKey(Schema.Struct({ iv: Schema.String, data: Schema.String })),
});
type GithubConsent = typeof GithubConsent.Type;
const readGithubConsent = (request: Request): GithubConsent | null => {
  const c = cookieOf(GithubConsent, cookies(request).get(GITHUB_COOKIE));
  return c?.state ? c : null;
};
/** Where this repository lives, for the source object's calls (the control Worker's own origin, wherever the page is). */
const sourceOrigin = (c: Control, url: URL) => c.platform.control?.url ?? url.origin;
const netOf = (c: Control): typeof fetch => c.net ?? globalThis.fetch.bind(globalThis);
const sealKeyOf = (c: Control) => c.sealKey ?? sealKeyFrom(c.platform.secret);
const backgroundOf = (c: Control) =>
  c.background ??
  ((work: Promise<unknown>) => {
    work.catch((e) => console.log(`background: ${(e as Error).message}`));
  });

/**
 * /auth/github/callback: the App's one callback, three things come to it. A consent an install's Worker started (the
 * state names its origin; nothing of ours matches): the code traded here, the answer sealed and relayed there. Connect
 * GitHub coming back (installation_id): the repository picked or made, and linked. Else a sign-in.
 */
export async function githubCallback(request: Request, url: URL, c: Control): Promise<Response> {
  const q = url.searchParams;
  const state = q.get("state");
  const consent = readGithubConsent(request);
  const ours = !!consent && consent.state == state;
  if (!ours && c.forks && c.github?.clientSecret) {
    const to = relayOrigin(state);
    if (to && to != url.origin) {
      if (!(await c.deploys.isInstall(to)))
        return page("Not an install", `This consent names ${esc(to)}, which isn't a server installed from here.`, 400);
      const installation = Number(q.get("installation_id")) || null;
      const payload: { token?: string; error?: string } = q.get("error")
        ? {
            error:
              q.get("error") == "access_denied"
                ? "You didn't authorize Erga on GitHub, so nothing changed."
                : `GitHub didn't authorize Erga: ${q.get("error_description") || q.get("error")}`,
          }
        : {};
      if (!payload.error) {
        const t = await exchangeUserCode(
          c.github,
          { code: q.get("code") ?? "", redirect: `${url.origin}/auth/github/callback` },
          netOf(c)
        ).catch((e: Error) => ({ error: e.message, error_description: e.message }) as UserToken);
        if (t.access_token) payload.token = t.access_token;
        else payload.error = `GitHub gave no token (${t.error_description || t.error || "no answer"}).`;
      }
      // The installation is the install's from now on: tokens for it, its webhooks relayed to its control Worker.
      if (installation && payload.token) await c.forks.installationSeen(to, installation);
      const back = new URL(`${to}/auth/github/callback`);
      for (const k of ["state", "installation_id", "setup_action"]) if (q.get(k)) back.searchParams.set(k, q.get(k)!);
      back.searchParams.set("relay", await sealRelay(relayNonce(state!), payload));
      return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
    }
  }
  if (ours || q.get("installation_id") || q.get("setup_action")) return githubConnectFinish(request, url, c, consent);
  return respond(finishSignIn, request, c.platform);
}

/**
 * /auth/google/callback: an install's sign-in with Erga's Google client (the state names its origin). The code is traded
 * here, with the client's secret, and the token relayed to the install sealed under the state's nonce, as GitHub's is.
 */
export async function googleRelay(request: Request, url: URL, c: Control): Promise<Response> {
  const q = url.searchParams,
    state = q.get("state");
  const to = relayOrigin(state);
  if (!to || to == url.origin || !c.forks || !c.google?.secret)
    return page("Not here", "Sign-in with Google comes back here only for an install's server.", 404);
  if (!(await c.deploys.isInstall(to)))
    return page("Not an install", `This sign-in names ${esc(to)}, which isn't a server installed from here.`, 400);
  const payload: { token?: string; error?: string } = {};
  if (q.get("error"))
    payload.error =
      q.get("error") == "access_denied"
        ? "You didn't allow Erga on Google's page, so nothing changed."
        : `Google didn't sign you in: ${q.get("error")}`;
  else {
    const t = await googleToken(
      googleEndpoints(c.google.origin ?? null),
      c.google,
      q.get("code") ?? "",
      `${url.origin}/auth/google/callback`,
      netOf(c)
    );
    if (t.access_token) payload.token = t.access_token;
    else payload.error = `Google gave no token (${t.error_description || t.error || "no answer"}).`;
  }
  const back = new URL(`${to}/auth/google/callback`);
  back.searchParams.set("state", state!);
  back.searchParams.set("relay", await sealRelay(relayNonce(state!), payload));
  return new Response(null, { status: 302, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
}

/** The end of Connect GitHub: the popup's last page tells the Ops page that opened it and closes; an error stays, with Try again. */
function githubDone(
  o: { ok: true; repo: string; warning?: string | null } | { ok: false; error: string },
  c: Control,
  url: URL,
  ...setCookies: string[]
): Response {
  const hosts = c.hosts ?? { production: TARGETS.production.host, staging: TARGETS.staging.host, control: CONTROL.host };
  const origins = [...new Set([url.origin, c.app, ...Object.values(hosts).map((h) => `https://${h}`)])];
  const message = jsonInScript({
    type: GITHUB_MESSAGE,
    ok: o.ok,
    ...(o.ok ? { repo: o.repo, ...(o.warning ? { warning: o.warning } : {}) } : { error: o.error }),
  });
  const text = o.ok ? `GitHub is connected: ${o.repo}.${o.warning ? ` ${o.warning}` : ""}` : `GitHub isn't connected: ${o.error}`;
  const r = page(
    o.ok ? "GitHub connected" : "GitHub not connected",
    `${esc(text)} ${o.ok ? "You can close this window." : `<a href="/github/connect?popup=1">Try again</a>, or close this window.`}<script>
const m = ${message};
try { new BroadcastChannel(${JSON.stringify(GITHUB_MESSAGE)}).postMessage(m); } catch {}
if (window.opener) for (const o of ${JSON.stringify(origins)}) try { window.opener.postMessage(m, o); } catch {}
${o.ok && !o.warning ? "setTimeout(() => window.close(), 300);" : ""}
</script>`,
    o.ok ? 200 : 400
  );
  r.headers.set("Cache-Control", "no-store");
  for (const x of [setCookie(url, GITHUB_COOKIE, "", 0), ...setCookies]) r.headers.append("Set-Cookie", x);
  return r;
}

/** An admin's session on this Worker, for the connect pages (the cookie proves the popup started here; the session says who). */
async function adminSession(request: Request, c: Control): Promise<AdminLayout["session"] | null> {
  const session = await c.platform.sessionOf(request);
  return (await actingAdmin(c.platform.directory.users, session)) ? session : null;
}

/** Connect GitHub coming back from the App's install page: the person's token (relayed, or the code traded here), then the repository. */
async function githubConnectFinish(request: Request, url: URL, c: Control, consent: GithubConsent | null): Promise<Response> {
  const q = url.searchParams;
  const app = c.github;
  if (!app) return githubDone({ ok: false, error: "This server has no GitHub App set up." }, c, url);
  if (!consent || consent.state != q.get("state"))
    return githubDone({ ok: false, error: "This didn't start here, or took more than ten minutes." }, c, url);
  if (q.get("error"))
    return githubDone(
      {
        ok: false,
        error:
          q.get("error") == "access_denied"
            ? "You didn't authorize Erga on GitHub, so nothing changed."
            : `GitHub didn't authorize Erga: ${q.get("error_description") || q.get("error")}`,
      },
      c,
      url
    );
  const session = await adminSession(request, c);
  if (!session) return githubDone({ ok: false, error: "Sign in here as an admin first." }, c, url);
  let installationId = Number(q.get("installation_id")) || 0;
  let token: string | undefined;
  const relayed = q.get("relay");
  if (relayed) {
    const o = await openRelay<{ token?: string; error?: string }>(relayNonce(consent.state), relayed);
    if (!o)
      return githubDone(
        {
          ok: false,
          error: `The answer relayed from ${c.github?.www && c.oauth.relay ? c.oauth.relay.replace(/^https?:\/\//, "") : "upstream"} didn't open: it was for another consent.`,
        },
        c,
        url
      );
    if (o.error) return githubDone({ ok: false, error: o.error }, c, url);
    token = o.token;
  } else {
    if (!app.clientSecret)
      return githubDone(
        { ok: false, error: "This server can't trade GitHub's code for a token (no client secret), and no relay answered." },
        c,
        url
      );
    const t = await exchangeUserCode(app, { code: q.get("code") ?? "", redirect: `${url.origin}/auth/github/callback` }, netOf(c)).catch(
      (e: Error) => ({ error: e.message }) as UserToken
    );
    if (!t.access_token)
      return githubDone(
        {
          ok: false,
          error: `GitHub gave no token (${t.error_description || t.error || "no answer"}). The App must request user authorization during installation.`,
        },
        c,
        url
      );
    token = t.access_token;
  }
  if (!token) return githubDone({ ok: false, error: "GitHub gave no token." }, c, url);
  // Authorized first (Connect on Erga's own App): the installation the person has, on their own account if they have
  // one there; none yet, and the install page comes next, with the same consent.
  if (!installationId) {
    const mine = await userInstallations(app, token, netOf(c)).catch((e: Error) => e);
    if (mine instanceof Error)
      return githubDone(
        { ok: false, error: mine instanceof GithubError ? mine.message : `GitHub couldn't be reached: ${mine.message}` },
        c,
        url
      );
    const have = mine.find((i) => i.account?.login.toLowerCase() == session.login.toLowerCase()) ?? mine[0];
    if (!have)
      return new Response(null, { status: 302, headers: { Location: installUrl(app, consent.state), "Cache-Control": "no-store" } });
    installationId = have.id;
  }
  return githubPick(
    request,
    url,
    c,
    { token, installationId, by: session.login.toLowerCase(), state: consent.state, popup: consent.popup },
    null
  );
}

/**
 * The repository: the one the installation reaches when it is one; else the person picks one of them, or has Erga make
 * one (the pick page, in the popup; the token sealed in the cookie meanwhile). Then the link, and the first sync.
 */
async function githubPick(
  request: Request,
  url: URL,
  c: Control,
  o: { token: string; installationId: number; by: string; state: string; popup: boolean },
  choice: { repoId?: number; create?: { name: string; isPrivate: boolean } } | null
): Promise<Response> {
  const app = c.github!;
  const net = netOf(c);
  try {
    const [installation, repos, me] = await Promise.all([
      installationOf(app, o.token, o.installationId, net),
      installationRepos(app, o.token, o.installationId, net),
      userOf(app, o.token, net),
    ]);
    if (!installation?.account)
      return githubDone(
        { ok: false, error: "GitHub doesn't list that installation for you: install the App on an account of yours." },
        c,
        url
      );
    let repo: GithubRepo | undefined;
    let problem: string | null = null;
    if (choice?.repoId) repo = repos.find((r) => r.id == choice.repoId);
    else if (choice?.create) {
      try {
        repo = await createRepo(
          app,
          o.token,
          {
            owner: installation.account,
            me: me.login ?? o.by,
            name: choice.create.name,
            isPrivate: choice.create.isPrivate,
            installationId: o.installationId,
            selection: installation.repository_selection ?? "selected",
          },
          net
        );
      } catch (e) {
        problem = (e as Error).message;
      }
    } else if (repos.length == 1) repo = repos[0];
    if (!repo) {
      // The pick page: the repositories the installation reaches, or a new one; the token kept sealed in the cookie for the choice.
      const consent: GithubConsent = {
        state: o.state,
        popup: o.popup,
        installation: o.installationId,
        token: await seal(o.token, await sealKeyOf(c)),
      };
      return githubPickPage(
        c,
        { account: installation.account, repos, problem, state: o.state },
        setCookie(url, GITHUB_COOKIE, b64u(JSON.stringify(consent)), 600)
      );
    }
    const link = linkOf(o.installationId, installation.account, repo, o.by);
    const source = c.platform.source;
    if (!source) return githubDone({ ok: false, error: "This server has no repository to sync." }, c, url);
    const status = await source.object.connectGithub(sourceOrigin(c, url), link, byLine(o.by));
    return githubDone(
      { ok: true, repo: repo.full_name, warning: status.error ? `The first sync had a problem: ${status.error}` : null },
      c,
      url
    );
  } catch (e) {
    return githubDone(
      { ok: false, error: e instanceof GithubError ? e.message : `GitHub couldn't be reached: ${(e as Error).message}` },
      c,
      url
    );
  }
}

/** The pick page, in the popup: one of the installation's repositories, or a new one. */
function githubPickPage(
  c: Control,
  o: { account: { login: string; type: string }; repos: readonly GithubRepo[]; problem: string | null; state: string },
  setCookie: string
): Response {
  const list = o.repos.length
    ? `<p>The App reaches these repositories of <b>${esc(o.account.login)}</b>. Which one is Erga's?</p>
    <form method="post" action="/github/connect/pick" class="pick"><input type="hidden" name="state" value="${esc(o.state)}">
      ${o.repos.map((r, i) => `<label><input type="radio" name="repo" value="${r.id}"${i == 0 ? " checked" : ""}> ${esc(r.full_name)}${r.private ? ' <span class="soft">(private)</span>' : ""}</label>`).join("\n      ")}
      <p><button type="submit" class="new">Use this repository</button></p>
    </form>`
    : `<p>The App reaches no repository of <b>${esc(o.account.login)}</b> yet.</p>`;
  const make = `<form method="post" action="/github/connect/pick" class="pick"><input type="hidden" name="state" value="${esc(o.state)}">
      <p>Or Erga makes a new one on <b>${esc(o.account.login)}</b>:</p>
      <label>Name <input name="name" value="erga" required pattern="[A-Za-z0-9._-]{1,100}"></label>
      <label><input type="checkbox" name="private" checked> Private</label>
      <p><button type="submit" class="pill">Make it and use it</button></p>
    </form>`;
  const r = page(
    "Connect GitHub",
    `<style>.pick label { display: block; margin: 6px 0; } .bad { color: #c2410c; } .pick input[name=name] { font: inherit; padding: 4px 8px; }</style>${o.problem ? `<p class="bad">${esc(o.problem)}</p>` : ""}${list}${make}`,
    o.problem ? 400 : 200
  );
  r.headers.set("Cache-Control", "no-store");
  r.headers.append("Set-Cookie", setCookie);
  return r;
}

/** /github/connect (a GET: the Ops page opens it in a popup) and /github/connect/pick (the pick page's form), an admin's. */
export async function githubConnectRoutes(request: Request, url: URL, c: Control, session: AdminLayout["session"]): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const app = c.github;
  if (!app) return githubDone({ ok: false, error: "This server has no GitHub App set up (GITHUB_APP_CLIENT_ID)." }, c, url);
  if (path == "/github/connect" && request.method == "GET") {
    const popup = url.searchParams.get("popup") == "1";
    // An install's consent names this origin for erga.dev's callback (the App's one) to relay it here.
    const state = c.oauth.relay ? relayState(url.origin, randomToken(18)) : randomToken(18);
    const consent: GithubConsent = { state, popup };
    // GitHub's install page, for an account that already has the App, shows its settings and never comes back. So
    // where this Worker trades codes itself (erga.dev's), the person authorizes first, and the installation they have is used.
    return new Response(null, {
      status: 302,
      headers: {
        Location: app.clientSecret ? githubAuthorizeUrl(app, state, `${url.origin}/auth/github/callback`) : installUrl(app, state),
        "Set-Cookie": setCookie(url, GITHUB_COOKIE, b64u(JSON.stringify(consent)), 600),
        "Cache-Control": "no-store",
      },
    });
  }
  if (path == "/github/connect/pick" && request.method == "POST") {
    if (request.headers.get("origin") != url.origin) return json({ error: "Forbidden" }, 403);
    const consent = readGithubConsent(request);
    const form = await request.formData().catch(() => null);
    if (!consent || !form || form.get("state") != consent.state || !consent.installation || !consent.token)
      return githubDone({ ok: false, error: "This didn't start here, or took more than ten minutes." }, c, url);
    let token: string;
    try {
      token = await open(consent.token, await sealKeyOf(c));
    } catch {
      return githubDone({ ok: false, error: "The consent's token didn't open: start again." }, c, url);
    }
    const repoId = Number(form.get("repo")) || 0;
    const choice = repoId ? { repoId } : { create: { name: String(form.get("name") ?? "").trim(), isPrivate: !!form.get("private") } };
    return githubPick(
      request,
      url,
      c,
      { token, installationId: consent.installation, by: session.login.toLowerCase(), state: consent.state, popup: consent.popup },
      choice
    );
  }
  return json({ error: "Not found" }, 404);
}

/**
 * POST /github/webhook: GitHub's push events, signed with the webhook secret (erga.dev's control Worker); or one relayed
 * from erga.dev to an install's control Worker, signed with its fork secret's hash. A push on the connected repository
 * syncs it in (in the background: GitHub wants its answer at once); one on an install's repository is relayed.
 */
export async function githubWebhook(request: Request, url: URL, c: Control): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const event = request.headers.get("x-github-event") ?? "";
  const relayed = request.headers.get("x-erga-relay-signature");
  if (relayed) {
    if (!c.forkSecretHash || !(await verifyRelay(c.forkSecretHash, body, relayed)))
      return json({ error: "The relay's signature doesn't match." }, 401);
  } else {
    const secret = c.github?.webhookSecret;
    if (!secret) return json({ error: "This server takes no webhooks from GitHub (no webhook secret)." }, 404);
    if (!(await verifyWebhook(secret, body, request.headers.get("x-hub-signature-256"))))
      return json({ error: "The signature isn't the webhook secret's." }, 401);
  }
  if (event == "ping") return json({ ok: true, pong: true });
  if (event != "push") return json({ ok: true, ignored: event || "no event" });
  let payload: PushEvent;
  const read = Schema.decodeUnknownOption(Schema.fromJsonString(PushEvent))(new TextDecoder().decode(body));
  if (Option.isNone(read)) return json({ error: "The body isn't JSON." }, 400);
  payload = read.value;
  const source = c.platform.source;
  if (!source) return json({ ok: true, ignored: "this server has no repository" });
  const origin = sourceOrigin(c, url);
  backgroundOf(c)(
    (async () => {
      const status = await source.object.githubPushed(origin, payload);
      if (status || relayed || !c.forks) return;
      // Not ours: an install's, by its installation; relayed to its control Worker, signed with what both sides have.
      const fork = payload.installation?.id ? await c.forks.ofInstallation(payload.installation.id) : null;
      if (!fork) return;
      await netOf(c)(`${fork.control}/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-Erga-Relay-Signature": await relaySignature(fork.secretHash, body),
        },
        body,
      });
    })().catch((e) => console.log(`github webhook (${payload.ref ?? "?"}): ${(e as Error).message}`))
  );
  return json({ ok: true, accepted: payload.ref ?? null }, 202);
}
