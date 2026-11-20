// The gate's core, for agents (gate/core.ts): MCP's authorization server, and what Erga's answer asks of the gate. Both
// sides of every check, with forged, expired and swapped values. (The rest: tests/gate-core.test.ts.)

import { describe, expect, test } from "bun:test";
import { type Config, open, type Req, seal, TOKEN } from "../gate/core.ts";
import {
  access,
  ADA,
  after,
  forged,
  forwarded,
  gate,
  IDP,
  KEY,
  memberCookie,
  near,
  NOW,
  now,
  oauth,
  port,
  req,
  responded,
  set,
  shellCookie,
  sso,
} from "./helpers/gate.ts";

describe("MCP's authorization server", () => {
  const VERIFIER = "v".repeat(43);
  const authorize = async (c: Config, more = "") =>
    `https://erga.example.com/oauth/authorize?response_type=code&client_id=claude-code&redirect_uri=${encodeURIComponent("http://localhost:8123/callback")}&state=st-1&code_challenge=${await port.sha256(VERIFIER)}&code_challenge_method=S256${more}`;

  test("the metadata is fixed JSON, open, and names the registration endpoint", async () => {
    const server = responded(await gate(req("https://erga.example.com/.well-known/oauth-authorization-server"), sso, port));
    expect(server.status).toBe(200);
    const body = JSON.parse(server.body);
    expect(body).toMatchObject({
      issuer: "https://erga.example.com",
      token_endpoint: "https://erga.example.com/oauth/token",
      registration_endpoint: "https://erga.example.com/oauth/register",
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
      expect(JSON.parse(responded(await gate(req(`https://erga.example.com${path}`), sso, port)).body).resource).toBe(
        "https://erga.example.com/mcp"
      );
  });

  test("register: open, keeps nothing, takes this computer's redirects only, and names the client by the app", async () => {
    const at = "https://erga.example.com/oauth/register";
    const asks = (form: unknown, id = "req-1") =>
      gate(req(at, { method: "POST", form: typeof form == "string" ? form : JSON.stringify(form), id }), sso, port);
    // No body yet: the mount reads it, and asks again (on AWS, the Lambda; its header starts with "&").
    expect(await gate(req(at, { method: "POST" }), sso, port)).toEqual({ do: "body" });
    const ok = responded(
      await asks(`&${JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:51234/callback"] })}`)
    );
    expect(ok.status).toBe(201);
    const made = JSON.parse(ok.body);
    expect(made).toMatchObject({
      client_name: "Claude Code",
      redirect_uris: ["http://localhost:51234/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(made.client_id).toMatch(/^Claude-Code\.[a-z0-9]{6}$/);
    // Another request: another client ID; no name: "app".
    const other = JSON.parse(responded(await asks({ redirect_uris: ["http://127.0.0.1:9/cb"] }, "req-2")).body).client_id;
    expect(other).toMatch(/^app\.[a-z0-9]{6}$/);
    expect(other).not.toBe(made.client_id);
    // A name with anything in it: a safe, short label.
    expect(
      JSON.parse(responded(await asks({ client_name: '<script>é&"x"</script>'.repeat(9), redirect_uris: ["http://[::1]/"] })).body)
        .client_id
    ).toMatch(/^[A-Za-z0-9-]{1,40}\.[a-z0-9]{6}$/);
    // An app that names its hosted redirects too (VS Code, Cursor) keeps this computer's only.
    const mixed = responded(
      await asks({
        redirect_uris: ["https://vscode.example/redirect", "http://127.0.0.1/", "app://callback", "http://127.0.0.1:33418/", 7],
      })
    );
    expect(mixed.status).toBe(201);
    expect(JSON.parse(mixed.body).redirect_uris).toEqual(["http://127.0.0.1/", "http://127.0.0.1:33418/"]);
    // Refused: another site's redirect, none, too many, a fragment, a secret, and a body that isn't JSON.
    for (const bad of [
      { redirect_uris: ["https://elsewhere.example/callback"] },
      { redirect_uris: ["http://localhost.evil.example/cb"] },
      { redirect_uris: [] },
      { redirect_uris: Array(11).fill("http://localhost/cb") },
      { redirect_uris: ["http://localhost/cb#x"] },
      { redirect_uris: ["http://localhost/cb"], token_endpoint_auth_method: "client_secret_basic" },
      "not json",
    ])
      expect(responded(await asks(bad)).status).toBe(400);
    // A deploy's own redirects (a hosted app's) count too.
    expect(
      responded(
        await gate(
          req(at, { method: "POST", form: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }) }),
          { ...sso, redirects: ["https://app.example/cb"] },
          port
        )
      ).status
    ).toBe(201);
  });

  test("authorize needs the shell cookie: without one a page goes to sign in; with one it goes on to Erga's approval", async () => {
    const url = await authorize(sso);
    const a = responded(await gate(req(url, { dest: "document" }), sso, port));
    expect(a.status).toBe(302);
    expect(a.headers.location.startsWith("/_edge/sign-in?next=%2Foauth%2Fauthorize")).toBe(true);
    // Also where anyone may come in.
    expect(
      responded(await gate(req(await authorize(oauth), { dest: "document" }), oauth, port)).headers.location.startsWith(
        "/auth/sign-in?next="
      )
    ).toBe(true);
    const s = { "__Host-erga": await shellCookie(sso), "__Host-member": await memberCookie(sso) };
    expect(forwarded(await gate(req(url, { cookie: s }), sso, port)).kind).toBe("person");
    // An agent approves nothing.
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "g1" }, now + 60);
    expect(responded(await gate(req(url, { bearer: t }), sso, port)).status).toBe(401);
  });

  test("authorize refuses a request that isn't whole, before Erga sees it", async () => {
    const s = { "__Host-erga": await shellCookie(sso), "__Host-member": await memberCookie(sso) };
    const base = new URL(await authorize(sso));
    const change = (k: string, v: string | null) => {
      const u = new URL(base);
      if (v == null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
      return u.toString();
    };
    const bad = [
      change("response_type", "token"),
      change("client_id", null),
      change("redirect_uri", "https://evil.example.org/cb"),
      change("redirect_uri", "http://localhost.evil.example.org/cb"),
      change("redirect_uri", "http://localhost:1/cb#frag"),
      change("redirect_uri", "javascript:alert(1)"),
      change("code_challenge", null),
      change("code_challenge", "short"),
      change("code_challenge_method", "plain"),
    ];
    for (const url of bad) expect(responded(await gate(req(url, { cookie: s }), sso, port)).status).toBe(400);
    // A redirect the deploy lists, exactly.
    const listed = { ...sso, redirects: ["https://app.example.org/cb"] };
    expect(forwarded(await gate(req(change("redirect_uri", "https://app.example.org/cb"), { cookie: s }), listed, port)).kind).toBe(
      "person"
    );
    expect(responded(await gate(req(change("redirect_uri", "https://app.example.org/cb/x"), { cookie: s }), listed, port)).status).toBe(
      400
    );
  });

  /** Erga approved: the code, as the app gets it. */
  async function approved(c: Config = sso) {
    const q = req(await authorize(c), { method: "POST", cookie: { "__Host-erga": await shellCookie(c) } });
    const a = await after(q, c, port, "code grant1");
    const back = new URL(a!.headers.location);
    return { q, a: a!, code: back.searchParams.get("code")!, back };
  }
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const trade = (o: Record<string, string>, c: Config = sso, at = NOW) =>
    gate(req("https://erga.example.com/oauth/token", { method: "POST", form: form(o), now: at }), c, port);
  const CODE = {
    grant_type: "authorization_code",
    client_id: "claude-code",
    redirect_uri: "http://localhost:8123/callback",
    code_verifier: VERIFIER,
  };

  test("Erga's approval becomes a code, back at the app with its state; a refusal says access_denied", async () => {
    const { a, back, code } = await approved();
    expect(a.status).toBe(302);
    expect(back.origin + back.pathname).toBe("http://localhost:8123/callback");
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(await open(port, KEY, "c", code, now)).toMatchObject({
      p: "sso",
      sub: "sub-ada",
      g: "grant1",
      k: "claude-code",
      r: "http://localhost:8123/callback",
      e: now + 60,
      u: now + 30 * 86400,
    });
    const q = req(await authorize(sso), { method: "POST", cookie: { "__Host-erga": await shellCookie(sso) } });
    const no = await after(q, sso, port, "deny");
    expect(no!.headers.location).toBe("http://localhost:8123/callback?error=access_denied&state=st-1");
  });

  test("a code is made only for a person's POST of a whole request on the shell", async () => {
    const { q } = await approved();
    expect(await after({ ...q, method: "GET" }, sso, port, "code grant1")).toBeNull();
    expect(await after({ ...q, cookies: {} }, sso, port, "code grant1")).toBeNull();
    expect(await after({ ...q, path: "/documents" }, sso, port, "code grant1")).toBeNull();
    expect(await after({ ...q, query: { ...q.query, redirect_uri: "https://evil.example.org/" } }, sso, port, "code grant1")).toBeNull();
    expect(await after({ ...q, host: "abc-ada.pages.example.net" }, sso, port, "code grant1")).toBeNull();
    expect(await after(q, sso, port, "code")).toBeNull();
    expect(await after(q, sso, port, "code bad.grant")).toBeNull();
    expect(await after(q, sso, port, "nope grant1")).toBeNull();
    expect(await after(q, sso, port, null)).toBeNull();
    expect(await after(q, { ...sso, oauth: false }, port, "code grant1")).toBeNull();
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "g1" }, now + 60);
    expect(await after({ ...q, cookies: {}, headers: { authorization: `Bearer ${t}` } }, sso, port, "code grant1")).toBeNull();
  });

  test("the token endpoint asks the mount for the body first", async () => {
    expect(await gate(req("https://erga.example.com/oauth/token", { method: "POST" }), sso, port)).toEqual({ do: "body" });
    expect(responded(await gate(req("https://erga.example.com/oauth/token"), sso, port)).status).toBe(405);
    expect(responded(await gate(req("https://erga.example.com/oauth/token", { method: "OPTIONS" }), sso, port)).status).toBe(204);
  });

  test("the code with its verifier, client and redirect gives an agent token for an hour and a refresh grant", async () => {
    const { code } = await approved();
    const a = responded(await trade({ ...CODE, code }));
    expect(a.status).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(a.body);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const { x, ...token } = (await open<{ x: string }>(port, KEY, "a", body.access_token, now))!;
    expect<unknown>(token).toEqual({ p: "sso", sub: "sub-ada", g: "grant1", e: now + 3600 });
    expect(await open(port, KEY, "r", body.refresh_token, now)).toMatchObject({ g: "grant1", k: "claude-code", x, e: now + 30 * 86400 });
    // The token is the person's agent on the shell, of this exchange of the code.
    expect(forwarded(await gate(req("https://erga.example.com/mcp", { method: "POST", bearer: body.access_token }), sso, port))).toEqual({
      kind: "agent",
      p: "sso",
      sub: "sub-ada",
      g: "grant1",
      x,
    });
    // A refresh grant is no token.
    expect(
      responded(await gate(req("https://erga.example.com/mcp", { method: "POST", bearer: body.refresh_token }), sso, port)).status
    ).toBe(401);
  });

  test("a code traded two times gives two exchanges, each with its own mark in its tokens; a refresh keeps its exchange's mark", async () => {
    const { code } = await approved();
    // (The gate keeps no state: the code is good for its 60 seconds. Erga takes one exchange's tokens only for a
    // grant, and ends the grant when it sees another's: tests/agent-grants.test.ts.)
    const tradeAs = async (id: string, o: Record<string, string>) =>
      JSON.parse(responded(await gate(req("https://erga.example.com/oauth/token", { method: "POST", form: form(o), id }), sso, port)).body);
    const markOf = async (kind: string, value: string) => (await open<{ x?: string }>(port, KEY, kind, value, now))!.x;
    const one = await tradeAs("req-a", { ...CODE, code });
    const two = await tradeAs("req-b", { ...CODE, code });
    const [x1, x2] = [await markOf("a", one.access_token), await markOf("a", two.access_token)];
    expect(x1).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(x2).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(x2).not.toBe(x1);
    expect([await markOf("r", one.refresh_token), await markOf("r", two.refresh_token)]).toEqual([x1, x2]);
    const next = await tradeAs("req-c", { grant_type: "refresh_token", client_id: "claude-code", refresh_token: one.refresh_token });
    expect([await markOf("a", next.access_token), await markOf("r", next.refresh_token)]).toEqual([x1, x1]);
    // A token made on the page is of no exchange.
    const q = req("https://erga.example.com/tokens/new", { method: "POST", cookie: { "__Host-erga": await shellCookie(sso) } });
    const made = await after(q, sso, port, `token grant2 ${now + 3600}`);
    expect(await markOf("a", made!.headers["x-erga-token"])).toBeUndefined();
  });

  test("the code is refused with another verifier, client or redirect, when forged or old, and as a refresh grant", async () => {
    const { code } = await approved();
    const bad: [Record<string, string>, number?][] = [
      [{ ...CODE, code, code_verifier: "w".repeat(43) }],
      [{ ...CODE, code, code_verifier: "" }],
      [{ ...CODE, code, client_id: "other" }],
      [{ ...CODE, code, redirect_uri: "http://localhost:8124/callback" }],
      [{ ...CODE, code: forged(code) }],
      [{ ...CODE, code: "" }],
      [{ ...CODE, code }, NOW + 61_000],
      [{ grant_type: "refresh_token", client_id: "claude-code", refresh_token: code }],
      [
        {
          ...CODE,
          code: await seal(
            port,
            "k2",
            "c",
            { p: "sso", sub: "sub-ada", g: "g", k: "claude-code", r: CODE.redirect_uri, ch: await port.sha256(VERIFIER), u: now + 99 },
            now + 60
          ),
        },
      ],
    ];
    for (const [o, at] of bad) {
      const a = responded(await trade(o, sso, at));
      expect(a.status).toBe(400);
      expect(JSON.parse(a.body)).toEqual({ error: "invalid_grant" });
    }
    expect(JSON.parse(responded(await trade({ grant_type: "password" })).body)).toEqual({ error: "unsupported_grant_type" });
  });

  test("the refresh grant gives new tokens until the grant's end, to its client only; a token or a code is no refresh grant", async () => {
    const { code } = await approved();
    const first = JSON.parse(responded(await trade({ ...CODE, code })).body);
    const later = NOW + 20 * 86400_000;
    const a = responded(
      await trade({ grant_type: "refresh_token", client_id: "claude-code", refresh_token: first.refresh_token }, sso, later)
    );
    expect(a.status).toBe(200);
    const body = JSON.parse(a.body);
    expect((await open(port, KEY, "a", body.access_token, later / 1000))?.e).toBe(later / 1000 + 3600);
    // The grant's end stays where the approval put it.
    expect((await open(port, KEY, "r", body.refresh_token, later / 1000))?.e).toBe(now + 30 * 86400);
    // The last hour's token ends with the grant.
    const last = JSON.parse(
      responded(
        await trade(
          { grant_type: "refresh_token", client_id: "claude-code", refresh_token: first.refresh_token },
          sso,
          NOW + 30 * 86400_000 - 60_000
        )
      ).body
    );
    expect(last.expires_in).toBe(60);
    for (const [o, at] of [
      [{ grant_type: "refresh_token", client_id: "other", refresh_token: first.refresh_token }, NOW],
      [{ grant_type: "refresh_token", client_id: "claude-code", refresh_token: first.access_token }, NOW],
      [{ grant_type: "refresh_token", client_id: "claude-code", refresh_token: forged(first.refresh_token) }, NOW],
      [{ grant_type: "refresh_token", client_id: "claude-code", refresh_token: first.refresh_token }, NOW + 30 * 86400_000],
    ] as const)
      expect(responded(await trade(o, sso, at)).status).toBe(400);
  });

  test("someone on the deny list gets no token from a code or a refresh grant", async () => {
    const { code } = await approved();
    const denied = { ...port, denied: () => true };
    const a = await gate(req("https://erga.example.com/oauth/token", { method: "POST", form: form({ ...CODE, code }) }), sso, denied);
    expect(responded(a).status).toBe(400);
  });

  test("off (the strict choice): no metadata, no authorize, no token endpoint; a token is made on the page", async () => {
    const strict = { ...sso, oauth: false };
    const s = { "__Host-erga": await shellCookie(strict), "__Host-member": await memberCookie(strict) };
    expect(responded(await gate(req("https://erga.example.com/.well-known/oauth-authorization-server"), strict, port)).status).toBe(401);
    expect(responded(await gate(req("https://erga.example.com/oauth/token", { method: "POST", form: "" }), strict, port)).status).toBe(401);
    // Behind the cookie they are Erga's addresses like any other (it has nothing there).
    expect(forwarded(await gate(req(await authorize(strict), { cookie: s }), strict, port)).kind).toBe("person");
  });
});

describe("what Erga asks of the gate", () => {
  test("a token for a grant, made on the page: for a person's POST, until the end asked, at most the grant's days", async () => {
    const q = req("https://erga.example.com/tokens/new", { method: "POST", cookie: { "__Host-erga": await shellCookie(sso) } });
    const a = await after(q, sso, port, `token grant9 ${now + 7 * 86400}`);
    expect<unknown>(await open(port, KEY, "a", a!.headers[TOKEN], now)).toEqual({
      p: "sso",
      sub: "sub-ada",
      g: "grant9",
      e: now + 7 * 86400,
    });
    const long = await after(q, sso, port, `token grant9 ${now + 400 * 86400}`);
    expect((await open(port, KEY, "a", long!.headers[TOKEN], now))?.e).toBe(now + 30 * 86400);
    expect(await after(q, sso, port, `token grant9 ${now}`)).toBeNull();
    expect(await after(q, sso, port, "token grant9")).toBeNull();
    expect(await after({ ...q, method: "GET" }, sso, port, `token grant9 ${now + 60}`)).toBeNull();
    expect(await after({ ...q, cookies: {} }, sso, port, `token grant9 ${now + 60}`)).toBeNull();
  });

  test("an agent never gets a token made", async () => {
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "g1" }, now + 60);
    const q = req("https://erga.example.com/tokens/new", { method: "POST", bearer: t });
    expect(await after(q, sso, port, `token grant9 ${now + 60}`)).toBeNull();
  });

  test("sign-out ends the shell cookie and the member cookie's shell copy; same site, the domain's one", async () => {
    const q = req("https://erga.example.com/auth/logout", { method: "POST" });
    const far = set((await after(q, sso, port, "out"))!.cookies);
    expect(far["__Host-erga"].attrs).toEqual(["Path=/", "Max-Age=0", "HttpOnly", "Secure", "SameSite=Lax"]);
    expect(far["__Host-member"].attrs).toEqual(["Path=/", "Max-Age=0", "HttpOnly", "Secure", "SameSite=None"]);
    const same = set((await after(q, near, port, "out"))!.cookies);
    expect(same.member.attrs).toEqual(["Path=/", "Max-Age=0", "HttpOnly", "Domain=erga.example.com", "Secure", "SameSite=Lax"]);
    // Nothing on a content host, whatever a document's answer says.
    expect(await after(req("https://abc-ada.pages.example.net/t/x/"), sso, port, "out")).toBeNull();
  });
});
