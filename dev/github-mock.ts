// A pretend GitHub, for the tests and local development: the parts of github.com and api.github.com that sign-in
// with GitHub touches (server/identity/sign-in.ts). One origin, the dev server's, under /__github:
//
//   GET  /login/oauth/authorize              GitHub's sign-in page: Authorize goes back to the app's callback with a code
//   POST /login/oauth/access_token           the code for the person's token (the app's client id and secret checked)
//   /api/...                                 api.github.com: a person's profile (/users/<login>), the person (/user),
//                                            their organizations (/user/memberships/orgs)
//
// Everything it was asked is in `state`, which the tests read.

import { esc } from "../shared/html.ts";

/** The id the pretend GitHub gives a login (/users/<login>): the same each time. */
export const mockGithubId = (login: string) =>
  1_000_000 + [...login.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 7);

/** The OAuth app that signs people in: its name, and its client id and secret. */
export interface MockGithubApp {
  slug: string;
  clientId: string;
  clientSecret: string;
}
export interface MockGithubOptions {
  app: MockGithubApp;
  /** This pretend GitHub's origin and base path (the dev server's, /__github). */
  origin: string;
  base?: string;
  /** The app's callback URL: sign-in comes back to it (GitHub accepts no other redirect). */
  callback: string;
  /** Who uses the browser (their GitHub login), and the organizations they are in. */
  user?: string;
  orgs?: string[];
}
export interface MockGithubState {
  /** The tokens minted for people. */
  tokens: { token: string; kind: "user"; login?: string }[];
}

/** When the pretend GitHub's rate limit resets (x-ratelimit-reset, in seconds): 2030-01-01 12:34 UTC. */
const RESET = Date.UTC(2030, 0, 1, 12, 34) / 1000;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Pretend GitHub</title><style>body{font:15px system-ui;max-width:560px;margin:40px auto;padding:0 16px}.btn{display:inline-block;padding:8px 14px;border:1px solid #888;border-radius:8px;background:#fff;color:#000;text-decoration:none;cursor:pointer}h1{font-size:20px}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

export function mockGithub(opts: MockGithubOptions) {
  const base = opts.base ?? "/__github";
  const user = opts.user ?? "ada";
  /**
   * The app's callback: as given, or, when it shares this pretend GitHub's origin (local development: both on the dev
   * server), on the origin the request came to (localhost or 127.0.0.1, as the browser has it, so the cookies match).
   */
  const callbackFor = (url: URL) =>
    new URL(opts.callback).origin == opts.origin ? new URL(new URL(opts.callback).pathname, url.origin) : new URL(opts.callback);
  const callbackOk = (given: string, url: URL) => {
    try {
      const g = new URL(given),
        c = callbackFor(url);
      return g.pathname == c.pathname && (g.origin == c.origin || g.origin == new URL(opts.callback).origin);
    } catch {
      return false;
    }
  };
  let nextId = 1000;
  const state: MockGithubState = { tokens: [] };
  const codes = new Map<string, string>();
  const tokenOf = (request: Request) => /^(?:Bearer|token)\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
  const userToken = (request: Request) => {
    const t = tokenOf(request);
    return state.tokens.find((x) => x.token == t) ?? null;
  };

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${base}/`)) return null;
    const path = url.pathname.slice(base.length);

    // ---- github.com: sign-in
    if (path == "/login/oauth/authorize" && request.method == "GET") {
      const back = url.searchParams.get("redirect_uri") ?? "";
      if (!callbackOk(back, url))
        return html(`<h1>Pretend GitHub</h1><p>The redirect_uri ${esc(back)} isn't the app's callback (${esc(opts.callback)}).</p>`, 400);
      const code = `code-${user}-${crypto.randomUUID().slice(0, 8)}`;
      codes.set(code, user);
      const yes = new URL(back);
      yes.searchParams.set("code", code);
      yes.searchParams.set("state", url.searchParams.get("state") ?? "");
      const no = new URL(back);
      no.searchParams.set("error", "access_denied");
      no.searchParams.set("state", url.searchParams.get("state") ?? "");
      return html(
        `<h1>Pretend GitHub</h1><p>Authorize <b>${esc(opts.app.slug)}</b> as <b>${esc(user)}</b>?</p><p><a class="btn" id="authorize" href="${esc(yes.toString())}">Authorize</a> <a class="btn" href="${esc(no.toString())}">Cancel</a></p>`
      );
    }
    if (path == "/login/oauth/access_token" && request.method == "POST") {
      const b = (await request.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; code?: string };
      if (b.client_id != opts.app.clientId) return json({ error: "Not Found" }, 404);
      if (b.client_secret != opts.app.clientSecret)
        return json({
          error: "incorrect_client_credentials",
          error_description: "The client_id and/or client_secret passed are incorrect.",
        });
      const login = b.code ? codes.get(b.code) : undefined;
      if (!login) return json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      codes.delete(b.code!);
      const token = `ghu_mock_${login}_${++nextId}`;
      state.tokens.push({ token, kind: "user", login });
      return json({ access_token: token, token_type: "bearer", scope: "", expires_in: 28800 });
    }

    // ---- api.github.com
    if (!path.startsWith("/api/")) return json({ message: "Not Found" }, 404);
    const p = path.slice(4);
    let m: RegExpExecArray | null;
    // A person's public profile, for a GitHub account's access rule: every login is a person (its id a number made from
    // the login, the same each time), but no-such-* ones, which GitHub doesn't know. A rate-limited-* one answers as
    // GitHub does when a server's IP used up its 60 lookups an hour, unless the app's client id and secret come with it.
    if ((m = /^\/users\/([^/]+)$/.exec(p)) && request.method == "GET") {
      const login = decodeURIComponent(m[1]);
      if (login.toLowerCase().startsWith("no-such-")) return json({ message: "Not Found" }, 404);
      const asApp = request.headers.get("authorization") == `Basic ${btoa(`${opts.app.clientId}:${opts.app.clientSecret}`)}`;
      if (login.toLowerCase().startsWith("rate-limited-") && !asApp)
        return Response.json(
          { message: "API rate limit exceeded for 203.0.113.7." },
          { status: 403, headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET) } }
        );
      return json({ login, id: mockGithubId(login), type: "User" });
    }
    const me = userToken(request);
    if (!me) return json({ message: "Bad credentials" }, 401);
    if (p == "/user" && request.method == "GET") return json({ login: me.login, name: me.login == "ada" ? "Ada Lovelace" : me.login, id: 101 });
    // Their organizations: the ones the person is in (opts.orgs), active; one more where their invitation still waits.
    if (p.startsWith("/user/memberships/orgs") && request.method == "GET")
      return json([
        ...(opts.orgs ?? []).map((o) => ({ state: "active", role: "member", organization: { login: o } })),
        { state: "pending", role: "member", organization: { login: "invited-org" } },
      ]);
    return json({ message: "Not Found" }, 404);
  }

  return { fetch: handle, state, user, app: opts.app };
}
export type MockGithub = ReturnType<typeof mockGithub>;
