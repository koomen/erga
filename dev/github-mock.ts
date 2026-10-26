// A pretend GitHub, for the tests and local development: the parts of
// github.com and api.github.com that Erga's GitHub App touches
// (server/source/github.ts), in front of the pretend Git host
// (git-server.ts, /__github/<owner>/<repo>.git). One origin, the dev
// server's, under /__github:
//
//   GET  /login/oauth/authorize              GitHub's sign-in page: Authorize goes back to the App's callback with a code
//   POST /login/oauth/access_token           the code for the person's token (the App's client id and secret checked)
//   GET|POST /apps/<slug>/installations/new  the App's install page: which repositories; Install comes back to the callback
//                                            with the installation's id (and a code: user authorization during installation)
//   /api/...                                 api.github.com: a person's profile (/users/<login>), the person (/user, /user/memberships/orgs), their installations and the repositories each
//                                            reaches, a new repository, installation tokens (a JWT signed with the App's key),
//                                            the App uninstalled, the webhook's deliveries
//
// A push to the pretend Git host (`pushed`) sends the push event to the
// webhook, signed with the webhook secret, as GitHub does. Everything it was
// asked is in `state`, which the tests read.

import { MOCK_GITHUB_TOKEN } from "./git-server.ts";

/** The id the pretend GitHub gives a login (/users/<login>): the same each time. */
export const mockGithubId = (login: string) =>
  1_000_000 + [...login.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 7);

export interface MockGithubApp {
  slug: string; clientId: string; clientSecret: string;
  /** The App's private key (PKCS#8 PEM): the JWTs are checked with its public half. None: any JWT passes. */
  privateKey?: string;
  webhookSecret?: string;
  /** Whether the App may make repositories (the Administration permission). */
  administration?: boolean;
}
export interface MockGithubOptions {
  app: MockGithubApp;
  /** This pretend GitHub's origin and base path (the dev server's, /__github): clone URLs are under it. */
  origin: string; base?: string;
  /** The App's callback URL: sign-in and the install page come back to it (GitHub accepts no other redirect). */
  callback: string;
  /** Where push events go, when set. */
  webhook?: string;
  /** Who uses the browser (their GitHub login), and the organizations they may install the App on. */
  user?: string; orgs?: string[];
  /** Repositories there from the start ("ada/erga"). */
  repos?: string[];
  net?: typeof fetch;
}
export interface MockRepo { id: number; owner: string; name: string; private: boolean }
export interface MockInstallation { id: number; account: { login: string; type: string }; selection: "all" | "selected"; repoIds: number[] }
export interface MockGithubState {
  repos: MockRepo[]; installations: MockInstallation[];
  /** The deliveries sent to the webhook: the event, the ref, and the status the webhook answered. */
  deliveries: { event: string; ref: string; after: string; status: number; body: string }[];
  /** The tokens minted: user tokens (ghu_), installation tokens (ghs_). */
  tokens: { token: string; kind: "user" | "installation"; login?: string; installationId?: number }[];
  /** The JWTs that failed the check. */
  badJwts: number;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const html = (body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>Pretend GitHub</title><style>body{font:15px system-ui;max-width:560px;margin:40px auto;padding:0 16px}button,.btn{display:inline-block;padding:8px 14px;border:1px solid #888;border-radius:8px;background:#fff;color:#000;text-decoration:none;cursor:pointer}h1{font-size:20px}label{display:block;margin:6px 0}</style>${body}`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Git's receive-pack request: the ref updates it carries (old, new, ref), before the pack. */
export function pushCommands(body: Uint8Array): { old: string; new: string; ref: string }[] {
  const out: { old: string; new: string; ref: string }[] = [];
  let i = 0;
  const dec = new TextDecoder();
  while (i + 4 <= body.length) {
    const len = parseInt(dec.decode(body.subarray(i, i + 4)), 16);
    if (!len) break;
    const line = dec.decode(body.subarray(i + 4, i + len)).split("\0")[0].trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m) out.push({ old: m[1], new: m[2], ref: m[3] });
    i += len;
  }
  return out;
}

export function mockGithub(opts: MockGithubOptions) {
  const base = opts.base ?? "/__github";
  const user = opts.user ?? "ada";
  /**
   * The App's callback: as given, or, when it shares this pretend GitHub's origin (local development: both on the dev
   * server), on the origin the request came to (localhost or 127.0.0.1, as the browser has it, so the cookies match).
   */
  const callbackFor = (url: URL) => (new URL(opts.callback).origin == opts.origin ? new URL(new URL(opts.callback).pathname, url.origin) : new URL(opts.callback));
  const callbackOk = (given: string, url: URL) => { try { const g = new URL(given), c = callbackFor(url); return g.pathname == c.pathname && (g.origin == c.origin || g.origin == new URL(opts.callback).origin); } catch { return false; } };
  const net = opts.net ?? fetch;
  let nextId = 1000;
  const state: MockGithubState = { repos: [], installations: [], deliveries: [], tokens: [], badJwts: 0 };
  for (const full of opts.repos ?? []) { const [owner, name] = full.split("/"); state.repos.push({ id: ++nextId, owner, name, private: false }); }
  const codes = new Map<string, string>();
  const repoView = (r: MockRepo) => ({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, default_branch: "main", clone_url: `${opts.origin}${base}/${r.owner}/${r.name}.git`, html_url: `${opts.origin}${base}/${r.owner}/${r.name}`, owner: { login: r.owner, type: opts.orgs?.includes(r.owner) ? "Organization" : "User" } });
  const accountsOf = () => [{ login: user, type: "User" }, ...(opts.orgs ?? []).map((o) => ({ login: o, type: "Organization" }))];
  const installationView = (i: MockInstallation) => ({ id: i.id, account: i.account, repository_selection: i.selection, app_slug: opts.app.slug });
  const reposOf = (i: MockInstallation) => state.repos.filter((r) => r.owner == i.account.login && (i.selection == "all" || i.repoIds.includes(r.id)));
  const tokenOf = (request: Request) => /^(?:Bearer|token)\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
  const userToken = (request: Request) => { const t = tokenOf(request); return state.tokens.find((x) => x.token == t && x.kind == "user") ?? null; };

  let publicKey: Promise<CryptoKey | null> | null = null;
  const verifier = () => (publicKey ??= (async () => {
    if (!opts.app.privateKey) return null;
    const der = Uint8Array.from(atob(opts.app.privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const priv = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const pub = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true };
    return crypto.subtle.importKey("jwk", pub, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  })());
  /** The App's own JWT, checked: its signature (when the key is known), its issuer's shape, its expiry. */
  const appJwtOk = async (request: Request): Promise<boolean> => {
    const t = tokenOf(request);
    const parts = t?.split(".") ?? [];
    if (parts.length != 3) return false;
    try {
      const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const claims = JSON.parse(new TextDecoder().decode(unb64u(parts[1]))) as { exp?: number; iss?: string };
      if (!claims.iss || !claims.exp || claims.exp * 1000 < Date.now()) { state.badJwts++; return false; }
      const key = await verifier();
      if (!key) return true;
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      if (!ok) state.badJwts++;
      return ok;
    } catch { state.badJwts++; return false; }
  };

  const makeRepo = (owner: string, name: string, isPrivate: boolean): Response => {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return json({ message: "Repository creation failed.", errors: [{ message: "name is invalid" }] }, 422);
    if (state.repos.some((r) => r.owner == owner && r.name == name)) return json({ message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }, 422);
    if (opts.app.administration === false) return json({ message: "Resource not accessible by integration" }, 403);
    const repo: MockRepo = { id: ++nextId, owner, name, private: isPrivate };
    state.repos.push(repo);
    return json(repoView(repo), 201);
  };

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${base}/`)) return null;
    const path = url.pathname.slice(base.length);
    // The Git host's paths (/<owner>/<repo>.git/...): not this mock's.
    if (/^\/[^/]+\/[^/]+\.git(\/|$)/.test(path)) return null;

    // ---- github.com: sign-in, and the App's install page
    if (path == "/login/oauth/authorize" && request.method == "GET") {
      const back = url.searchParams.get("redirect_uri") ?? "";
      if (!callbackOk(back, url)) return html(`<h1>Pretend GitHub</h1><p>The redirect_uri ${esc(back)} isn't the App's callback (${esc(opts.callback)}).</p>`, 400);
      const code = `code-${user}-${crypto.randomUUID().slice(0, 8)}`;
      codes.set(code, user);
      const yes = new URL(back); yes.searchParams.set("code", code); yes.searchParams.set("state", url.searchParams.get("state") ?? "");
      const no = new URL(back); no.searchParams.set("error", "access_denied"); no.searchParams.set("state", url.searchParams.get("state") ?? "");
      return html(`<h1>Pretend GitHub</h1><p>Authorize <b>${esc(opts.app.slug)}</b> as <b>${esc(user)}</b>?</p><p><a class="btn" id="authorize" href="${esc(yes.toString())}">Authorize</a> <a class="btn" href="${esc(no.toString())}">Cancel</a></p>`);
    }
    if (path == "/login/oauth/access_token" && request.method == "POST") {
      const b = (await request.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; code?: string };
      if (b.client_id != opts.app.clientId) return json({ error: "Not Found" }, 404);
      if (b.client_secret != opts.app.clientSecret) return json({ error: "incorrect_client_credentials", error_description: "The client_id and/or client_secret passed are incorrect." });
      const login = b.code ? codes.get(b.code) : undefined;
      if (!login) return json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      codes.delete(b.code!);
      const token = `ghu_mock_${login}_${++nextId}`;
      state.tokens.push({ token, kind: "user", login });
      return json({ access_token: token, token_type: "bearer", scope: "", expires_in: 28800 });
    }
    const install = new RegExp(`^/apps/${opts.app.slug}/installations/new$`).exec(path);
    if (install && (request.method == "GET" || request.method == "POST")) {
      const form = request.method == "POST" ? await request.formData().catch(() => null) : null;
      const stateParam = String(form?.get("state") ?? url.searchParams.get("state") ?? "");
      if (!form) {
        const accounts = accountsOf();
        return html(`<h1>Install ${esc(opts.app.slug)}</h1><form method="post"><input type="hidden" name="state" value="${esc(stateParam)}">
<p>On which account? ${accounts.map((a, i) => `<label><input type="radio" name="account" value="${esc(a.login)}"${i == 0 ? " checked" : ""}> ${esc(a.login)}</label>`).join("")}</p>
<p>Which repositories? <label><input type="radio" name="selection" value="all"> All repositories</label><label><input type="radio" name="selection" value="selected" checked> Only select repositories:</label></p>
${state.repos.map((r) => `<label><input type="checkbox" name="repo" value="${r.id}" checked> ${esc(r.owner)}/${esc(r.name)}</label>`).join("") || "<p><i>(no repositories yet: Erga may make one)</i></p>"}
<p><button type="submit" id="install">Install</button></p></form>`);
      }
      const account = accountsOf().find((a) => a.login == String(form.get("account") ?? user)) ?? accountsOf()[0];
      const selection = form.get("selection") == "all" ? "all" : "selected";
      const repoIds = form.getAll("repo").map(Number).filter((id) => state.repos.some((r) => r.id == id && r.owner == account.login));
      const have = state.installations.find((i) => i.account.login == account.login);
      const installation: MockInstallation = have ? Object.assign(have, { selection, repoIds: [...new Set([...have.repoIds, ...repoIds])] }) : { id: ++nextId, account, selection, repoIds };
      if (!have) state.installations.push(installation);
      const code = `code-${user}-${crypto.randomUUID().slice(0, 8)}`;
      codes.set(code, user);
      const back = callbackFor(url);
      back.searchParams.set("code", code); back.searchParams.set("installation_id", String(installation.id)); back.searchParams.set("setup_action", have ? "update" : "install"); back.searchParams.set("state", stateParam);
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }

    // ---- api.github.com
    if (!path.startsWith("/api/")) return json({ message: "Not Found" }, 404);
    const p = path.slice(4);
    let m: RegExpExecArray | null;
    if (p.startsWith("/app")) {
      if (!(await appJwtOk(request))) return json({ message: "A JSON web token could not be decoded" }, 401);
      if (p == "/app" && request.method == "GET") return json({ id: 1, slug: opts.app.slug, name: "Erga Editor (pretend)", client_id: opts.app.clientId });
      if (p == "/app/hook/deliveries" && request.method == "GET") return json(state.deliveries.map((d, i) => ({ id: i + 1, event: d.event, status_code: d.status })));
      if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && request.method == "POST") {
        const i = state.installations.find((x) => x.id == Number(m![1]));
        if (!i) return json({ message: "Not Found" }, 404);
        const token = `ghs_mock_${i.id}_${++nextId}`;
        state.tokens.push({ token, kind: "installation", installationId: i.id });
        return json({ token, expires_at: new Date(Date.now() + 3600_000).toISOString(), repository_selection: i.selection }, 201);
      }
      if ((m = /^\/app\/installations\/(\d+)$/.exec(p)) && request.method == "DELETE") {
        const at = state.installations.findIndex((x) => x.id == Number(m![1]));
        if (at < 0) return json({ message: "Not Found" }, 404);
        state.installations.splice(at, 1);
        return new Response(null, { status: 204 });
      }
      return json({ message: "Not Found" }, 404);
    }
    // A person's public profile, for a GitHub account's access rule: every login is a person (its id a number made from
    // the login, the same each time), but no-such-* ones, which GitHub doesn't know.
    if ((m = /^\/users\/([^/]+)$/.exec(p)) && request.method == "GET") {
      const login = decodeURIComponent(m[1]);
      if (login.toLowerCase().startsWith("no-such-")) return json({ message: "Not Found" }, 404);
      return json({ login, id: mockGithubId(login), type: "User" });
    }
    const me = userToken(request);
    if (!me) return json({ message: "Bad credentials" }, 401);
    if (p == "/user" && request.method == "GET") return json({ login: me.login, name: me.login == "ada" ? "Ada Lovelace" : me.login, id: 101 });
    // Their organizations: the ones the person is in (opts.orgs), active; one more where their invitation still waits.
    if (p.startsWith("/user/memberships/orgs") && request.method == "GET") return json([...(opts.orgs ?? []).map((o) => ({ state: "active", role: "member", organization: { login: o } })), { state: "pending", role: "member", organization: { login: "invited-org" } }]);
    if (p.startsWith("/user/installations") || p == "/user/repos" || p.startsWith("/orgs/")) {
      if (p == "/user/installations" && request.method == "GET") return json({ total_count: state.installations.length, installations: state.installations.map(installationView) });
      if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p)) && request.method == "GET") {
        const i = state.installations.find((x) => x.id == Number(m![1]));
        if (!i) return json({ message: "Not Found" }, 404);
        const repos = reposOf(i).map(repoView);
        return json({ total_count: repos.length, repositories: repos });
      }
      if ((m = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(p)) && request.method == "PUT") {
        const i = state.installations.find((x) => x.id == Number(m![1]));
        if (!i || !state.repos.some((r) => r.id == Number(m![2]))) return json({ message: "Not Found" }, 404);
        if (i.selection == "all" || i.repoIds.includes(Number(m[2]))) return new Response(null, { status: 304 });
        i.repoIds.push(Number(m[2]));
        return new Response(null, { status: 204 });
      }
      if (p == "/user/repos" && request.method == "POST") { const b = (await request.json().catch(() => ({}))) as { name?: string; private?: boolean }; return makeRepo(me.login!, String(b.name ?? ""), !!b.private); }
      if ((m = /^\/orgs\/([^/]+)\/repos$/.exec(p)) && request.method == "POST") {
        if (!opts.orgs?.includes(m[1])) return json({ message: "Not Found" }, 404);
        const b = (await request.json().catch(() => ({}))) as { name?: string; private?: boolean };
        return makeRepo(m[1], String(b.name ?? ""), !!b.private);
      }
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p)) && request.method == "GET") {
      const r = state.repos.find((x) => x.owner == m![1] && x.name == m![2]);
      return r ? json(repoView(r)) : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  }

  /** A push landed on the pretend Git host (owner/name): the push event to the webhook, signed, for each ref moved. */
  async function pushed(owner: string, name: string, body: Uint8Array): Promise<void> {
    if (!opts.webhook) return;
    const repo = state.repos.find((r) => r.owner == owner && r.name == name);
    const installation = repo && state.installations.find((i) => reposOf(i).includes(repo));
    if (!repo || !installation) return;
    for (const c of pushCommands(body)) {
      const payload = JSON.stringify({ ref: c.ref, before: c.old, after: c.new, repository: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner } }, installation: { id: installation.id }, sender: { login: user }, pusher: { name: user } });
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(opts.app.webhookSecret ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = `sha256=${Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))), (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const r = await net(opts.webhook, { method: "POST", headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-GitHub-Delivery": crypto.randomUUID(), "X-Hub-Signature-256": sig, "User-Agent": "GitHub-Hookshot/mock" }, body: payload }).catch(() => null);
      state.deliveries.push({ event: "push", ref: c.ref, after: c.new, status: r?.status ?? 0, body: r ? await r.text().catch(() => "") : "" });
    }
  }

  /** Whether a token the Git host sees is one this mock minted for an installation (or the fixed pretend token). */
  const gitTokenOk = (token: string | null) => token == MOCK_GITHUB_TOKEN || (!!token && state.tokens.some((t) => t.token == token && t.kind == "installation"));

  return { fetch: handle, pushed, gitTokenOk, state, user, app: opts.app };
}
export type MockGithub = ReturnType<typeof mockGithub>;
