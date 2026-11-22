// The gate's mount on CloudFront (gate/mounts/cloudfront*.ts, lambda.ts: the gate in front, on AWS): the four
// functions as gate/build.ts builds them, and the Lambda, behind CloudFront's events. A whole sign-in and hand-off,
// through a pretend browser that keeps cookies as a browser does. (The gate inside a Worker: tests/gate-mounts.test.ts.)

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { buildFunction, buildLambda, FUNCTION_MAX, type Part, PARTS } from "../gate/build.ts";
import { ASK, CALLER, type Caller, type Config, open, PATTERNS, seal, TOKEN } from "../gate/core.ts";
import { refused } from "../gate/lower.ts";
import { webPort as port } from "../gate/port.ts";
import { browser, hopOf } from "./helpers/gate.ts";
import { CONTENT, IDP, issuer, KEY, PAGE, SHELL } from "./helpers/gate-mounts.ts";

describe("on CloudFront: the four functions as built, and the Lambda", () => {
  const settings: Omit<Config, "key"> = {
    shell: SHELL,
    content: CONTENT,
    https: true,
    open: false,
    idp: { sso: { authorize: IDP.authorize, client: IDP.client, scope: "openid email profile" } },
    oauth: true,
    redirects: [],
  };
  type Handler = (event: unknown) => Promise<Record<string, any>>;
  const fn = {} as Record<Part, Handler>;
  let lambda: (
    event: unknown,
    context?: unknown,
    o?: unknown
  ) => Promise<{ status: string; headers: Record<string, { value: string }[]>; body?: string }>;
  const denied = new Set<string>();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "erga-gate-"));
  /** A function as built for a deploy's settings, loaded. */
  const load = async (part: Part, config: Omit<Config, "key">, name: string = part): Promise<Handler> => {
    const file = join(dir, `${name}.mjs`);
    writeFileSync(file, await buildFunction(part, config, true));
    return (await import(file)).handler;
  };

  beforeAll(async () => {
    // The runtime's two modules: `crypto` is Node's here; `cloudfront` gives the KeyValueStore.
    mock.module("cloudfront", () => ({
      default: { kvs: () => ({ get: async (k: string) => (k == "key" ? KEY : null), exists: async (k: string) => denied.has(k) }) },
    }));
    for (const part of PARTS) fn[part] = await load(part, settings);
    const file = join(dir, "lambda.mjs");
    writeFileSync(file, await buildLambda({ shell: SHELL, region: "us-east-1", idp: { sso: { ...IDP, secret: "/erga/idp-secret" } } }));
    lambda = (await import(file)).handler;
  });

  test("each function is under CloudFront's 10 KB, in syntax that its runtime takes, with a handler by that name and no export", async () => {
    for (const part of PARTS) {
      const code = await buildFunction(part, settings);
      expect(new TextEncoder().encode(code).length).toBeLessThan(FUNCTION_MAX);
      // (tests/gate-lower.test.ts: what the runtime refuses, and that the lowering keeps what the code does.)
      expect(refused(code)).toEqual([]);
      expect(code).toMatch(/function handler\(e\)\{return [\w$]+\(e\)\}$/);
      expect(code).not.toMatch(/\bexport\b/);
    }
  });

  let n = 0;
  /** A request's event, as CloudFront gives it to a function. */
  const event = (
    url: string,
    o: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string>; dest?: string } = {}
  ) => {
    const u = new URL(url);
    const headers: Record<string, { value: string }> = { host: { value: u.host }, "sec-fetch-dest": { value: o.dest ?? "document" } };
    for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = { value: v };
    const querystring: Record<string, { value: string }> = {};
    for (const [k, v] of new URLSearchParams(u.search)) querystring[k] = { value: encodeURIComponent(v) };
    const cookies: Record<string, { value: string }> = {};
    for (const [k, v] of Object.entries(o.cookies ?? {})) cookies[k] = { value: v };
    return { context: { requestId: `cf-${n++}` }, request: { method: o.method ?? "GET", uri: u.pathname, querystring, headers, cookies } };
  };
  /** A viewer request's function, as the distribution's behaviors choose it: by the path. */
  const viewer = (e: ReturnType<typeof event>) => {
    const path = e.request.uri;
    // (As the distribution's behaviors send it: by the gate's own patterns, deploy/aws/template.ts.)
    const fits = (patterns: string[]) => patterns.some((p) => (p.endsWith("*") ? path.startsWith(p.slice(0, -1)) : path == p));
    return fn[fits(PATTERNS.edge) ? "edge" : fits([...PATTERNS.forms, ...PATTERNS.fixed]) ? "agents" : "request"](e);
  };
  const callerIn = (request: Record<string, any>): Caller => JSON.parse(Buffer.from(request.headers[CALLER].value, "base64url").toString());

  /** A whole sign-in: the request function, the Lambda, the response function. The cookies it set. */
  async function signIn() {
    const start = await viewer(event(`https://${SHELL}/_edge/sign-in?next=/documents`));
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location.value).searchParams.get("state")!;
    const cookies = { "__Host-signin": start.cookies["__Host-signin"].value };
    const cb = event(`https://${SHELL}/_edge/callback?code=good&state=${state}`, {
      cookies,
      headers: { "x-erga-exchange": "forged", "x-erga-identity": "forged" },
    });
    const onward = await viewer(cb);
    // On to the Lambda, with what to trade: written by the function, whatever came in.
    expect(onward.headers["x-erga-identity"]).toBeUndefined();
    const fromLambda = await lambda(
      {
        Records: [
          {
            cf: {
              request: {
                method: "GET",
                uri: onward.uri,
                headers: { "x-erga-exchange": [{ value: onward.headers["x-erga-exchange"].value }] },
              },
            },
          },
        ],
      },
      null,
      {
        fetch: issuer(),
        secret: async (name: string) => (name == "/erga/idp-secret" ? "idp-secret" : "wrong"),
      }
    );
    expect(fromLambda.status).toBe("200");
    const response = {
      statusCode: 200,
      headers: { "x-erga-identity": { value: fromLambda.headers["x-erga-identity"][0].value } },
      cookies: {},
    };
    const done = await fn.response({ ...event(`https://${SHELL}/_edge/callback?code=good&state=${state}`, { cookies }), response });
    return { done, state, cookies };
  }

  test("sign-in: the function starts it, the Lambda trades the code, the function signs", async () => {
    const { done } = await signIn();
    expect(done.statusCode).toBe(302);
    expect(done.headers.location.value).toBe("/documents");
    expect(done.headers["x-erga-identity"]).toBeUndefined();
    expect(done.cookies["__Host-erga"].attributes).toBe(`Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`);
    expect(await open(port, KEY, "s", done.cookies["__Host-erga"].value, Date.now() / 1000)).toMatchObject({
      p: "sso",
      sub: "sub-ada",
      email: "ada@example.com",
    });
    expect(done.cookies["__Host-member"].attributes).toContain("SameSite=None");
    expect(done.cookies["__Host-signin"].attributes).toContain("Max-Age=0");
  });

  test("an identity header signs nothing without the sign-in's state in the browser", async () => {
    const identity = Buffer.from(JSON.stringify({ p: "sso", sub: "sub-root", email: "root@example.com", name: "Root" })).toString(
      "base64url"
    );
    const response = () => ({ statusCode: 200, headers: { "x-erga-identity": { value: identity } }, cookies: {} });
    const no = await fn.response({ ...event(`https://${SHELL}/_edge/callback?code=x&state=y`), response: response() });
    expect(no.statusCode).toBe(400);
    expect(no.cookies).toEqual({});
    expect(no.headers["x-erga-identity"]).toBeUndefined();
    const elsewhere = await fn.response({ ...event(`https://${SHELL}/documents`), response: response() });
    expect(elsewhere.cookies).toEqual({});
  });

  test("the Lambda holds no key and names nobody for a code the issuer refuses, or for another path", async () => {
    const x = Buffer.from(
      JSON.stringify({
        do: "exchange",
        idp: "sso",
        code: "bad",
        verifier: "v".repeat(43),
        redirect: `https://${SHELL}/_edge/callback`,
        next: "/",
      })
    ).toString("base64url");
    const o = { fetch: issuer(), secret: async () => "idp-secret" };
    const refused = await lambda(
      { Records: [{ cf: { request: { method: "GET", uri: "/_edge/callback", headers: { "x-erga-exchange": [{ value: x }] } } } }] },
      null,
      o
    );
    expect(refused.headers["x-erga-identity"]).toBeUndefined();
    const other = await lambda(
      { Records: [{ cf: { request: { method: "GET", uri: "/documents", headers: { "x-erga-exchange": [{ value: x }] } } } }] },
      null,
      o
    );
    expect(other.headers["x-erga-identity"]).toBeUndefined();
    expect(await buildLambda({ shell: SHELL, region: "us-east-1", idp: {} })).not.toContain(KEY);
  });

  test("a signed-in request goes on with the caller's header and without the gate's cookies; no proof gets a 401", async () => {
    const { done } = await signIn();
    const cookies = {
      "__Host-erga": done.cookies["__Host-erga"].value,
      "__Host-member": done.cookies["__Host-member"].value,
      theme: "dark",
    };
    const forged = Buffer.from(JSON.stringify({ kind: "person", sub: "sub-root" })).toString("base64url");
    const onward = await viewer(event(`https://${SHELL}/documents`, { cookies, headers: { [CALLER]: forged } }));
    expect(callerIn(onward)).toMatchObject({ kind: "person", sub: "sub-ada" });
    expect(Object.keys(onward.cookies)).toEqual(["theme"]);
    const none = await viewer(event(`https://${SHELL}/api/tools/x`, { method: "POST", dest: "empty", headers: { [CALLER]: forged } }));
    expect(none.statusCode).toBe(401);
    denied.add("deny:sub-ada");
    expect((await viewer(event(`https://${SHELL}/documents`, { cookies }))).statusCode).toBe(401);
    denied.clear();
  });

  test("a request that goes on says the host the viewer asked for, whatever forwarded header came in", async () => {
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    // Erga's server behind CloudFront (celld) takes this header for its own host: the function writes it.
    const plain = await viewer(event(`https://${SHELL}/documents`, { cookies }));
    expect(plain.headers["x-forwarded-host"]).toEqual({ value: SHELL });
    const forged = await viewer(event(`https://${SHELL}/documents`, { cookies, headers: { "x-forwarded-host": "evil.example" } }));
    expect(forged.headers["x-forwarded-host"]).toEqual({ value: SHELL });
    // A document's host, as a member: its own host.
    const member = await seal(port, KEY, "m", {}, Date.now() / 1000 + 60);
    const page = await viewer(event(PAGE, { cookies: { member }, headers: { "x-forwarded-host": SHELL } }));
    expect(page.headers["x-forwarded-host"]).toEqual({ value: new URL(PAGE).host });
  });

  test("no function writes a header that CloudFront refuses from a function (a 502 for the request)", async () => {
    // AWS's list of the headers that an edge function may not add or change ("Restrictions on edge functions").
    const refused =
      /^(connection|expect|keep-alive|proxy-authenticate|proxy-authorization|proxy-connection|trailer|upgrade|x-accel-.*|x-amz-cf-.*|x-amzn-.*|x-cache|x-edge-.*|x-forwarded-proto|x-real-ip|content-length|host|transfer-encoding|via)$/;
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const sent = event(`https://${SHELL}/documents`, { cookies });
    const before = JSON.stringify(sent.request.headers);
    const had = JSON.parse(before) as Record<string, unknown>;
    const on = await viewer(sent);
    const wrote = Object.keys(on.headers).filter((h) => JSON.stringify(on.headers[h]) != JSON.stringify(had[h]));
    expect(wrote.sort()).toEqual([CALLER, "x-erga-wire", "x-forwarded-host"]);
    expect(wrote.filter((h) => refused.test(h))).toEqual([]);
    // And each answer of the gate's own: its headers.
    for (const url of [
      `https://${SHELL}/documents`,
      `https://${SHELL}/_edge/sign-in`,
      `https://${SHELL}/.well-known/oauth-authorization-server`,
    ])
      expect(Object.keys((await viewer(event(url))).headers).filter((h) => refused.test(h))).toEqual([]);
  });

  test("each function answers its own addresses only: any other is a 404, also with a proof", async () => {
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value, "__Host-member": done.cookies["__Host-member"].value };
    const at = (path: string) => event(`https://${SHELL}${path}`, { cookies });
    expect((await fn.request(at("/_edge/sign-in"))).statusCode).toBe(404);
    expect((await fn.request(event(`https://accept.${CONTENT}/t/pass/`, { cookies }))).statusCode).toBe(404);
    expect((await fn.edge(at("/documents"))).statusCode).toBe(404);
    expect((await fn.edge(at("/oauth/token"))).statusCode).toBe(404);
    expect((await fn.agents(at("/documents"))).statusCode).toBe(404);
    expect((await fn.agents(at("/_edge/sign-in"))).statusCode).toBe(404);
  });

  test("the hand-off: the request function starts it, and the edge function runs its two steps", async () => {
    const { done } = await signIn();
    const first = await viewer(event(PAGE, { dest: "iframe" }));
    expect(first.statusCode).toBe(200);
    expect(first.cookies.nonce.attributes).toBe(`Path=/; Max-Age=120; HttpOnly; Domain=${CONTENT}; Secure; SameSite=None; Partitioned`);
    const vouch = await viewer(
      event(hopOf(first.body.data), { dest: "iframe", cookies: { "__Host-member": done.cookies["__Host-member"].value } })
    );
    expect(hopOf(vouch.body.data).startsWith(`https://accept.${CONTENT}/_edge/accept?ticket=`)).toBe(true);
    const accept = await viewer(event(hopOf(vouch.body.data), { dest: "iframe", cookies: { nonce: first.cookies.nonce.value } }));
    expect(hopOf(accept.body.data)).toBe(PAGE);
    const page = await viewer(event(PAGE, { dest: "iframe", cookies: { member: accept.cookies.member.value } }));
    expect(callerIn(page)).toEqual({ kind: "member" });
    expect(page.cookies).toEqual({});
  });

  test("an agent: the code from the response function, the token from the agents' function through the Lambda", async () => {
    const { done } = await signIn();
    const verifier = "v".repeat(43);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      state: "st",
      code_challenge: await port.sha256(verifier),
      code_challenge_method: "S256",
    });
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const post = event(`https://${SHELL}/oauth/authorize?${query}`, { method: "POST", cookies, dest: "empty" });
    const onward = await viewer(structuredClone(post));
    expect(callerIn(onward).kind).toBe("person");
    // Erga approved. The response function sees the request as the request function left it (no gate cookies: a real
    // distribution shows it so), and takes the caller from its sealed header.
    expect(onward.cookies["__Host-erga"]).toBeUndefined();
    const signed = await fn.response({
      context: post.context,
      request: onward,
      response: { statusCode: 200, headers: { [ASK]: { value: "code grant1" } }, cookies: {} },
    });
    expect(signed.statusCode).toBe(302);
    expect(signed.headers[ASK]).toBeUndefined();
    const code = new URL(signed.headers.location.value).searchParams.get("code")!;
    expect(code).toMatch(/^c\./);
    // The token endpoint: no body at the function, so on to the Lambda, which sends the body here again in a header.
    const tokenPost = event(`https://${SHELL}/oauth/token`, { method: "POST", dest: "empty" });
    expect(await fn.agents(tokenPost)).toBe(tokenPost.request);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      code_verifier: verifier,
      code,
    }).toString();
    const again = (async (url: string, init: RequestInit) => {
      const answer = await fn.agents(event(url, { method: "POST", dest: "empty", headers: Object.fromEntries(new Headers(init.headers)) }));
      // (The function's answer comes back through the distribution, with CloudFront's own headers beside it.)
      const headers = Object.fromEntries(Object.entries(answer.headers as Record<string, { value: string }>).map(([k, v]) => [k, v.value]));
      return new Response(answer.body.data, { status: answer.statusCode, headers: { ...headers, "x-cache": "Miss from cloudfront" } });
    }) as unknown as typeof fetch;
    const answer = await lambda(
      {
        Records: [
          {
            cf: {
              request: {
                method: "POST",
                uri: "/oauth/token",
                headers: {},
                body: { data: Buffer.from(form).toString("base64"), encoding: "base64" },
              },
            },
          },
        ],
      },
      null,
      { fetch: again }
    );
    expect(answer.status).toBe("200");
    // The function's answer goes back as it is: a page of any origin may read it (CORS), and no cache keeps it.
    expect(answer.headers).toEqual({
      "cache-control": [{ value: "no-store" }],
      "content-type": [{ value: "application/json" }],
      "referrer-policy": [{ value: "no-referrer" }],
      "x-content-type-options": [{ value: "nosniff" }],
      "access-control-allow-origin": [{ value: "*" }],
    });
    const tokens = JSON.parse(answer.body!);
    const mcp = await viewer(
      event(`https://${SHELL}/mcp`, { method: "POST", dest: "empty", headers: { authorization: `Bearer ${tokens.access_token}` } })
    );
    expect(callerIn(mcp)).toEqual({ kind: "agent", p: "sso", sub: "sub-ada", g: "grant1", x: expect.stringMatching(/^[\w-]{16}$/) });
    expect(mcp.headers.authorization).toBeUndefined();
    // The metadata is the agents' function's; any other address there is nothing.
    expect((await fn.agents(event(`https://${SHELL}/.well-known/oauth-authorization-server`))).statusCode).toBe(200);
    expect((await fn.agents(event(`https://${SHELL}/documents`))).statusCode).toBe(404);
  });

  test("the response function signs for the caller of the request's own proof, never for a caller's header from the viewer", async () => {
    const end = Math.floor(Date.now() / 1000) + 3600;
    const victim = { kind: "person", p: "sso", sub: "sub-root", email: "root@example.com", name: "Root", i: 1, e: end };
    const forged = {
      [CALLER]: Buffer.from(JSON.stringify(victim)).toString("base64url"),
      // A sealed caller with another key, and one with no seal: neither counts.
      "x-erga-wire": await seal(port, "another key, of 32 characters or more", "w", { c: victim }, end),
    };
    const asks = (request: unknown, ask: string) =>
      fn.response({
        context: { requestId: "cf-forged" },
        request,
        response: { statusCode: 200, headers: { [ASK]: { value: ask } }, cookies: {} },
      });
    // With no proof: no token, and no code.
    const nobody = event(`https://${SHELL}/tokens/new`, { method: "POST", dest: "empty", headers: forged });
    expect((await asks(nobody.request, `token grant9 ${end}`)).headers[TOKEN]).toBeUndefined();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: "claude-code",
      redirect_uri: "http://localhost:8123/callback",
      code_challenge: await port.sha256("v".repeat(43)),
      code_challenge_method: "S256",
    });
    const authorize = event(`https://${SHELL}/oauth/authorize?${query}`, { method: "POST", dest: "empty", headers: forged });
    const refused = await asks(authorize.request, "code grant9");
    expect([refused.statusCode, refused.headers.location]).toEqual([200, undefined]);
    // With their own sign-in: a token for themselves, whatever the header says.
    const { done } = await signIn();
    const cookies = { "__Host-erga": done.cookies["__Host-erga"].value };
    const ada = event(`https://${SHELL}/tokens/new`, { method: "POST", dest: "empty", cookies, headers: forged });
    const token = (await asks(ada.request, `token grant9 ${end}`)).headers[TOKEN].value;
    expect(await open(port, KEY, "a", token, Date.now() / 1000)).toMatchObject({ sub: "sub-ada", g: "grant9" });
  });

  test("the token endpoint's POST with no body ends at the function: the Lambda's header is never empty", async () => {
    let asked = 0;
    // A header with no value may be lost on the way: this pretends that it is. Then the function hears no body yet.
    const again = (async (url: string, init: RequestInit) => {
      asked++;
      const headers = Object.fromEntries([...new Headers(init.headers)].filter(([, value]) => value.trim()));
      const e = event(url, { method: "POST", dest: "empty", headers });
      const answer = await fn.agents(e);
      if (answer == e.request) throw new Error("The function sent the request on to the Lambda again: a loop.");
      return new Response(answer.body.data, { status: answer.statusCode });
    }) as unknown as typeof fetch;
    for (const body of [undefined, { data: "", encoding: "text" }, { data: Buffer.from(" ").toString("base64"), encoding: "base64" }]) {
      const request = { method: "POST", uri: "/oauth/token", headers: {}, ...(body ? { body } : {}) };
      const answer = await lambda({ Records: [{ cf: { request } }] }, null, { fetch: again });
      expect([answer.status, JSON.parse(answer.body!)]).toEqual(["400", { error: "unsupported_grant_type" }]);
    }
    expect(asked).toBe(3);
  });

  test("a person's page with no member cookie gets one again: the response function sets the cookie that the core asks for", async () => {
    const { done } = await signIn();
    const shell = { "__Host-erga": done.cookies["__Host-erga"].value };
    const answered = (e: ReturnType<typeof event>, ask?: string, f = fn.response) =>
      f({ ...e, response: { statusCode: 200, headers: ask ? { [ASK]: { value: ask } } : {}, cookies: {} } });
    // The browser lost its member cookie only (or never had one): its next page of the shell brings it back.
    const page = await answered(event(`https://${SHELL}/documents`, { cookies: shell }));
    expect(Object.keys(page.cookies)).toEqual(["__Host-member"]);
    expect(page.cookies["__Host-member"].attributes).toMatch(/^Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=None$/);
    expect(await open(port, KEY, "m", page.cookies["__Host-member"].value, Date.now() / 1000)).not.toBeNull();
    // Content under the shell's host: the one member cookie, for the shell's domain. Without it no document opens there.
    const near = await load("response", { ...settings, content: `pages.${SHELL}` }, "response-near");
    const one = await answered(event(`https://${SHELL}/documents`, { cookies: shell }), undefined, near);
    expect(one.cookies.member.attributes).toMatch(new RegExp(`^Path=/; Max-Age=\\d+; HttpOnly; Domain=${SHELL}; Secure; SameSite=Lax$`));
    // None: with the cookie; for a script's request; for nobody, whatever header names a caller; on a document's host.
    const forged = {
      [CALLER]: Buffer.from(JSON.stringify({ kind: "person", sub: "sub-ada", e: Date.now() / 1000 + 60 })).toString("base64url"),
    };
    for (const e of [
      event(`https://${SHELL}/documents`, { cookies: { ...shell, "__Host-member": page.cookies["__Host-member"].value } }),
      event(`https://${SHELL}/api/news`, { cookies: shell, dest: "empty" }),
      event(`https://${SHELL}/documents`, { headers: forged }),
      event(PAGE, { cookies: shell, dest: "iframe", headers: forged }),
    ])
      expect((await answered(e)).cookies).toEqual({});
    // An answer that signs out only ends the cookies.
    const out = await answered(event(`https://${SHELL}/documents`, { cookies: shell }), "out");
    expect(out.cookies["__Host-member"].attributes).toContain("Max-Age=0");
  });

  test("a document's answer asks the gate nothing", async () => {
    const out = await fn.response({
      ...event(PAGE, { dest: "iframe" }),
      response: { statusCode: 200, headers: { [ASK]: { value: "out" } }, cookies: {} },
    });
    expect(out.cookies).toEqual({});
    expect(out.headers[ASK]).toBeUndefined();
  });
});
