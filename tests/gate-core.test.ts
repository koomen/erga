// The gate's core (gate/core.ts): every path, and both sides of every check, with forged, expired and swapped values.
// No server and no browser: a request in, an answer out. (Its agents' side: tests/gate-agents.test.ts.)

import { describe, expect, test } from "bun:test";
import { type Config, edge, GATE_COOKIES, open, type Req, seal, signedIn } from "../gate/core.ts";
import {
  access,
  ADA,
  after,
  forged,
  forwarded,
  gate,
  hopOf,
  hopped,
  IDP,
  KEY,
  memberCookie,
  near,
  NOW,
  now,
  oauth,
  port,
  req,
  type Respond,
  responded,
  set,
  shellCookie,
  sso,
} from "./helpers/gate.ts";

describe("values", () => {
  test("a value opens only as its kind, under its key, before its end, unchanged", async () => {
    const v = await seal(port, KEY, "s", { sub: "a" }, now + 10);
    expect(v).toMatch(/^s\.[\w-]+\.[\w-]+$/);
    expect(await open<{ sub: string }>(port, KEY, "s", v, now)).toEqual({ sub: "a", e: now + 10 });
    expect(await open(port, KEY, "m", v, now)).toBeNull();
    expect(await open(port, "other-key", "s", v, now)).toBeNull();
    expect(await open(port, KEY, "s", v, now + 10)).toBeNull();
    expect(await open(port, KEY, "s", forged(v), now)).toBeNull();
    // One kind's signature under another kind's name.
    expect(await open(port, KEY, "m", `m.${v.split(".").slice(1).join(".")}`, now)).toBeNull();
    for (const bad of ["", "s", "s..", `${v}.x`, "s.e30.", "x".repeat(5000), undefined])
      expect(await open(port, KEY, "s", bad, now)).toBeNull();
  });

  test("a name outside ASCII comes back as it was", async () => {
    const v = await seal(port, KEY, "s", { name: "Zoë 木" }, now + 10);
    expect((await open<{ name: string }>(port, KEY, "s", v, now))?.name).toBe("Zoë 木");
  });
});

describe("the shell, SSO", () => {
  test("no proof: a page goes to sign in and comes back; anything else gets a 401 that names the metadata", async () => {
    const page = responded(await gate(req("https://erga.example.com/ada/notes?edit", { dest: "document" }), sso, port));
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe(`/_edge/sign-in?next=${encodeURIComponent("/ada/notes?edit=")}`);
    for (const r of [
      req("https://erga.example.com/api/tools/x", { method: "POST" }),
      req("https://erga.example.com/mcp"),
      req("https://erga.example.com/x", { dest: "empty" }),
    ]) {
      const a = responded(await gate(r, sso, port));
      expect(a.status).toBe(401);
      expect(a.headers["www-authenticate"]).toContain("https://erga.example.com/.well-known/oauth-protected-resource");
    }
  });

  test("the shell cookie names the person; a forged, expired, other-key or other-kind one names nobody", async () => {
    const good = await shellCookie(sso);
    const who = forwarded(await gate(req("https://erga.example.com/documents", { cookie: { "__Host-erga": good } }), sso, port));
    expect(who).toEqual({ kind: "person", ...ADA, i: NOW, e: now + 3600 });
    const bad = [
      forged(good),
      await shellCookie(sso, ADA, now - 1),
      await shellCookie({ ...sso, key: "k2" }),
      await memberCookie(sso),
      await seal(port, KEY, "a", { ...ADA, g: "g1" }, now + 60),
    ];
    for (const cookie of bad) {
      const a = responded(
        await gate(req("https://erga.example.com/documents", { cookie: { "__Host-erga": cookie }, dest: "document" }), sso, port)
      );
      expect(a.status).toBe(302);
    }
  });

  test("two cookies with one name: any good one counts", async () => {
    const good = await shellCookie(sso);
    for (const pair of [
      ["junk", good],
      [good, "junk"],
      [forged(good), good],
    ])
      expect(forwarded(await gate(req("https://erga.example.com/", { cookie: { "__Host-erga": pair } }), sso, port)).kind).toBe("person");
  });

  test("a person with no member cookie gets one on the way; with one, none", async () => {
    const s = await shellCookie(sso, ADA, now + 7 * 3600, NOW - 5 * 3600_000);
    const a = await gate(req("https://erga.example.com/", { cookie: { "__Host-erga": s }, dest: "document" }), sso, port);
    if (a.do != "forward") throw new Error("not forwarded");
    // (Only a page's answer carries it.)
    expect(await gate(req("https://erga.example.com/", { cookie: { "__Host-erga": s }, dest: "empty" }), sso, port)).toMatchObject({
      cookies: [],
    });
    const c = set(a.cookies)["__Host-member"];
    // The other site's copy: SameSite=None, no Domain (so __Host-), not partitioned, until the shell cookie's end.
    expect(c.attrs).toEqual(["Path=/", `Max-Age=${7 * 3600}`, "HttpOnly", "Secure", "SameSite=None"]);
    expect((await open(port, KEY, "m", c.value, now))?.e).toBe(now + 7 * 3600);
    const b = await gate(
      req("https://erga.example.com/", { cookie: { "__Host-erga": s, "__Host-member": c.value }, dest: "document" }),
      sso,
      port
    );
    expect(b).toEqual({ do: "forward", caller: { kind: "person", ...ADA, i: NOW - 5 * 3600_000, e: now + 7 * 3600 }, cookies: [] });
  });

  test("another host is nothing behind SSO, and its own where anyone may come in", async () => {
    expect(responded(await gate(req("https://www.example.org/"), sso, port)).status).toBe(404);
    expect(forwarded(await gate(req("https://www.example.org/"), oauth, port))).toEqual({ kind: "none" });
  });

  test("the deny list refuses a person and their agent", async () => {
    const denied = { ...port, denied: (sub: string) => sub == "sub-ada" };
    const s = await shellCookie(sso);
    expect(responded(await gate(req("https://erga.example.com/", { cookie: { "__Host-erga": s } }), sso, denied)).status).toBe(401);
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "g1" }, now + 60);
    expect(responded(await gate(req("https://erga.example.com/mcp", { bearer: t }), sso, denied)).status).toBe(401);
    expect(
      forwarded(
        await gate(
          req("https://erga.example.com/", { cookie: { "__Host-erga": await shellCookie(sso, { ...ADA, sub: "sub-bob" }) } }),
          sso,
          denied
        )
      ).kind
    ).toBe("person");
  });
});

describe("the shell, OAuth (anyone may come in)", () => {
  test("no proof goes on as nobody; a person as themselves", async () => {
    expect(await gate(req("https://erga.example.com/ada/notes"), oauth, port)).toEqual({
      do: "forward",
      caller: { kind: "none" },
      cookies: [],
    });
    const s = await shellCookie(oauth, { ...ADA, p: "github" });
    expect(forwarded(await gate(req("https://erga.example.com/", { cookie: { "__Host-erga": s } }), oauth, port))).toMatchObject({
      kind: "person",
      p: "github",
    });
  });

  test("a token that isn't good signs in nobody, whatever cookie comes with it", async () => {
    const s = await shellCookie(oauth);
    const a = responded(
      await gate(req("https://erga.example.com/api/tools/x", { bearer: "a.e30.nope", cookie: { "__Host-erga": s } }), oauth, port)
    );
    expect(a.status).toBe(401);
  });
});

describe("agent tokens", () => {
  test("a good token is the person's agent, by its grant; forged, expired, or another kind: 401", async () => {
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "grant1" }, now + 60);
    expect(forwarded(await gate(req("https://erga.example.com/mcp", { method: "POST", bearer: t }), sso, port))).toEqual({
      kind: "agent",
      p: "sso",
      sub: "sub-ada",
      g: "grant1",
    });
    const refresh = await seal(port, KEY, "r", { p: "sso", sub: "sub-ada", g: "grant1", k: "c", u: now + 60 }, now + 60);
    for (const bad of [
      forged(t),
      await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "grant1" }, now),
      refresh,
      await shellCookie(sso),
    ])
      expect(responded(await gate(req("https://erga.example.com/mcp", { method: "POST", bearer: bad }), sso, port)).status).toBe(401);
  });

  test("a token opens nothing on a content host", async () => {
    const t = await seal(port, KEY, "a", { p: "sso", sub: "sub-ada", g: "grant1" }, now + 60);
    expect(responded(await gate(req("https://abc-ada.pages.example.net/t/x/", { bearer: t }), sso, port)).status).toBe(401);
  });
});

describe("sign-in", () => {
  const start = (c: Config, q = "") => gate(req(`https://erga.example.com/_edge/sign-in${q}`), c, port);

  test("the start goes to the issuer with a state and a PKCE challenge, and keeps both in the state cookie", async () => {
    const a = responded(await start(sso, "?next=/ada/notes"));
    const at = new URL(a.headers.location);
    expect(at.origin + at.pathname).toBe(IDP.authorize);
    expect(at.searchParams.get("client_id")).toBe("client-1");
    expect(at.searchParams.get("redirect_uri")).toBe("https://erga.example.com/_edge/callback");
    expect(at.searchParams.get("code_challenge_method")).toBe("S256");
    const c = set(a.cookies)["__Host-signin"];
    expect(c.attrs).toEqual(["Path=/", "Max-Age=600", "HttpOnly", "Secure", "SameSite=Lax"]);
    const st = await open<{ s: string; v: string; x: string; p: string }>(port, KEY, "i", c.value, now);
    expect(st).toMatchObject({ s: at.searchParams.get("state")!, x: "/ada/notes", p: "sso" });
    expect(await port.sha256(st!.v)).toBe(at.searchParams.get("code_challenge")!);
    expect(st!.v).toMatch(/^[\w-]{43}$/);
  });

  test("two requests get different states and verifiers", async () => {
    const one = responded(await gate(req("https://erga.example.com/_edge/sign-in", { id: "a" }), sso, port));
    const two = responded(await gate(req("https://erga.example.com/_edge/sign-in", { id: "b" }), sso, port));
    expect(new URL(one.headers.location).searchParams.get("state")).not.toBe(new URL(two.headers.location).searchParams.get("state"));
  });

  test("next is a path of this site only", async () => {
    for (const next of ["https://evil.example.org/", "//evil.example.org", "/\\evil.example.org", "javascript:alert(1)", "/a b"]) {
      const a = responded(await start(sso, `?next=${encodeURIComponent(next)}`));
      const st = await open<{ x: string }>(port, KEY, "i", set(a.cookies)["__Host-signin"].value, now);
      expect(st?.x).toBe("/");
    }
  });

  test("the issuer is by name where there are several; an unknown name is nothing", async () => {
    expect(responded(await start(oauth)).status).toBe(404);
    expect(responded(await start(oauth, "?idp=nope")).status).toBe(404);
    expect(responded(await start(oauth, "?idp=__proto__")).status).toBe(404);
    expect(responded(await start(oauth, "?idp=google")).status).toBe(302);
  });

  /** A sign-in started, and its callback's request. */
  async function callback(c: Config, o: { state?: string; query?: string; cookie?: string | string[] } = {}) {
    const a = responded(await start(c, "?next=/ada/notes"));
    const state = new URL(a.headers.location).searchParams.get("state")!;
    const cookie = set(a.cookies)["__Host-signin"].value;
    const q = req(`https://erga.example.com/_edge/callback?${o.query ?? "code=code-1"}&state=${o.state ?? state}`, {
      cookie: { "__Host-signin": o.cookie ?? cookie },
      id: "req-2",
    });
    return { q, cookie, state };
  }

  test("the callback with the browser's state asks the mount to trade the code, with the verifier", async () => {
    const { q, cookie } = await callback(sso);
    const st = await open<{ v: string }>(port, KEY, "i", cookie, now);
    expect(await gate(q, sso, port)).toEqual({
      do: "exchange",
      idp: "sso",
      code: "code-1",
      verifier: st!.v,
      redirect: "https://erga.example.com/_edge/callback",
      next: "/ada/notes",
      x: "",
    });
  });

  test("the callback refuses another state, no cookie, a forged cookie, and an old one", async () => {
    const other = await callback(sso, { state: "x".repeat(32) });
    expect(responded(await gate(other.q, sso, port)).status).toBe(400);
    const none = await callback(sso);
    expect(responded(await gate({ ...none.q, cookies: {} }, sso, port)).status).toBe(400);
    const bad = await callback(sso);
    expect(responded(await gate({ ...bad.q, cookies: { "__Host-signin": [forged(bad.cookie)] } }, sso, port)).status).toBe(400);
    const old = await callback(sso);
    expect(responded(await gate({ ...old.q, now: NOW + 601_000 }, sso, port)).status).toBe(400);
    // Another browser's sign-in (its state and its cookie do not match this one's).
    const mine = await callback(sso);
    const theirs = responded(await gate(req("https://erga.example.com/_edge/sign-in", { id: "theirs" }), sso, port));
    expect(
      responded(await gate({ ...mine.q, cookies: { "__Host-signin": [set(theirs.cookies)["__Host-signin"].value] } }, sso, port)).status
    ).toBe(400);
  });

  test("a sign-in canceled at the issuer goes back, with the state cleared and no exchange", async () => {
    const one = { ...oauth, idp: { sso: IDP } };
    const { q } = await callback(one, { query: "error=access_denied" });
    const a = responded(await gate(q, one, port));
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe(`/auth/sign-in?next=${encodeURIComponent("/ada/notes")}&canceled=`);
    expect(set(a.cookies)["__Host-signin"].attrs).toContain("Max-Age=0");
  });

  test("signedIn sets the shell cookie and the member cookie, clears the state, and goes on", async () => {
    const { q } = await callback(sso);
    const a = responded(await signedIn(q, sso, port, ADA));
    expect(a.status).toBe(302);
    expect(a.headers.location).toBe("/ada/notes");
    const c = set(a.cookies);
    expect(c["__Host-erga"].attrs).toEqual(["Path=/", `Max-Age=${30 * 86400}`, "HttpOnly", "Secure", "SameSite=Lax"]);
    expect<unknown>(await open(port, KEY, "s", c["__Host-erga"].value, now)).toEqual({ ...ADA, i: NOW, e: now + 30 * 86400 });
    expect(c["__Host-member"].attrs).toEqual(["Path=/", `Max-Age=${30 * 86400}`, "HttpOnly", "Secure", "SameSite=None"]);
    expect((await open(port, KEY, "m", c["__Host-member"].value, now))?.e).toBe(now + 30 * 86400);
    expect(c["__Host-signin"].attrs).toContain("Max-Age=0");
    // The settings' hours (Config.hours), where they say: the shell cookie's life, and the member cookie's with it.
    const day = set(responded(await signedIn(q, { ...sso, hours: 24 }, port, ADA)).cookies);
    expect([day["__Host-erga"].attrs[1], day["__Host-member"].attrs[1]]).toEqual(["Max-Age=86400", "Max-Age=86400"]);
    // Erga's own next (the username step) in place of the sign-in's; never another site.
    expect(responded(await signedIn(q, sso, port, ADA, "/auth/username")).headers.location).toBe("/auth/username");
    expect(responded(await signedIn(q, sso, port, ADA, "https://evil.example.org")).headers.location).toBe("/");
  });

  test("same site: the member cookie is for the shell's domain, Lax", async () => {
    const { q } = await callback(near);
    const c = set(responded(await signedIn(q, near, port, ADA)).cookies);
    expect(c.member.attrs).toEqual(["Path=/", `Max-Age=${30 * 86400}`, "HttpOnly", "Domain=erga.example.com", "Secure", "SameSite=Lax"]);
    expect(c["__Host-member"]).toBeUndefined();
  });

  test("signedIn counts only on the callback that proved its sign-in", async () => {
    const { q } = await callback(sso);
    // No state cookie; another path; another issuer's identity; no subject; another method.
    expect(responded(await signedIn({ ...q, cookies: {} }, sso, port, ADA)).status).toBe(400);
    expect(responded(await signedIn({ ...q, path: "/documents" }, sso, port, ADA)).status).toBe(400);
    expect(responded(await signedIn(q, sso, port, { ...ADA, p: "other" })).status).toBe(400);
    expect(responded(await signedIn(q, sso, port, { ...ADA, sub: "" })).status).toBe(400);
    expect(responded(await signedIn({ ...q, method: "POST" }, sso, port, ADA)).status).toBe(400);
    expect(responded(await signedIn({ ...q, query: { ...q.query, state: "nope" } }, sso, port, ADA)).status).toBe(400);
  });

  test("the gate's paths never go on to Erga, on any host or method", async () => {
    for (const url of [
      "https://erga.example.com/_edge/nope",
      "https://abc-ada.pages.example.net/_edge/accept",
      "https://erga.example.com/_edge/",
    ])
      expect(responded(await gate(req(url), sso, port)).status).toBe(404);
    expect(responded(await gate(req("https://erga.example.com/_edge/sign-in", { method: "POST" }), sso, port)).status).toBe(404);
  });
});

describe("content on another site: the hand-off", () => {
  const PAGE = "https://abc12345-ada.pages.example.net/t/pass/index.html?x=1";

  test("a member's browser goes on, as a member; every other cookie value does not", async () => {
    const m = await memberCookie(sso);
    expect(await gate(req(PAGE, { cookie: { member: m } }), sso, port)).toEqual({ do: "forward", caller: { kind: "member" }, cookies: [] });
    expect(forwarded(await gate(req(PAGE, { cookie: { member: ["x", m] } }), sso, port)).kind).toBe("member");
    for (const bad of [forged(m), await memberCookie(sso, now), await memberCookie({ ...sso, key: "k2" }), await shellCookie(sso), "1"])
      expect(responded(await gate(req(PAGE, { cookie: { member: bad }, dest: "empty" }), sso, port)).status).toBe(401);
  });

  test("the shell cookie opens nothing on a content host", async () => {
    const a = responded(await gate(req(PAGE, { cookie: { "__Host-erga": await shellCookie(sso) }, dest: "empty" }), sso, port));
    expect(a.status).toBe(401);
  });

  test("a page with no member cookie goes to the vouch with a nonce; a file, a script's request and a socket get a 401", async () => {
    const a = responded(await gate(req(PAGE, { dest: "iframe" }), sso, port));
    expect(a.status).toBe(200);
    const at = new URL(hopped(a));
    expect(at.origin + at.pathname).toBe("https://erga.example.com/_edge/vouch");
    expect(at.searchParams.get("back")).toBe(PAGE);
    const nonce = set(a.cookies).nonce;
    expect(nonce.attrs).toEqual([
      "Path=/",
      "Max-Age=120",
      "HttpOnly",
      "Domain=pages.example.net",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ]);
    expect(at.searchParams.get("n")).toBe(await port.sha256(nonce.value));
    for (const r of [
      req(PAGE, { dest: "script" }),
      req(PAGE, { dest: "websocket" }),
      req(PAGE),
      req(PAGE, { dest: "iframe", method: "POST" }),
    ]) {
      const b = responded(await gate(r, sso, port));
      expect(b.status).toBe(401);
      expect(b.cookies).toEqual([]);
    }
  });

  test("each request's nonce is its own, and nobody without the key can make it", async () => {
    const a = responded(await gate(req(PAGE, { dest: "iframe", id: "a" }), sso, port));
    const b = responded(await gate(req(PAGE, { dest: "iframe", id: "b" }), sso, port));
    const k2 = responded(await gate(req(PAGE, { dest: "iframe", id: "a" }), { ...sso, key: "k2" }, port));
    expect(set(a.cookies).nonce.value).not.toBe(set(b.cookies).nonce.value);
    expect(set(a.cookies).nonce.value).not.toBe(set(k2.cookies).nonce.value);
  });

  /** The first step, and its vouch request (as the browser sends it, with __Host-member). */
  async function toVouch(o: { member?: string | string[] } = {}) {
    const first = responded(await gate(req(PAGE, { dest: "iframe" }), sso, port));
    const nonce = set(first.cookies).nonce.value;
    const member = o.member ?? (await memberCookie(sso, now + 9 * 3600));
    return { nonce, q: req(hopOf(first.body), { dest: "iframe", cookie: { "__Host-member": member }, id: "req-2" }) };
  }

  test("the vouch gives a member's browser a ticket to the accept host only: the nonce's hash, the member cookie's end, 60 seconds", async () => {
    const { q, nonce } = await toVouch();
    const a = responded(await gate(q, sso, port));
    expect(a.cookies).toEqual([]);
    const at = new URL(hopped(a));
    expect(at.origin + at.pathname).toBe("https://accept.pages.example.net/_edge/accept");
    expect(at.searchParams.get("back")).toBe(PAGE);
    expect<unknown>(await open(port, KEY, "t", at.searchParams.get("ticket")!, now)).toEqual({
      n: await port.sha256(nonce),
      m: now + 9 * 3600,
      e: now + 60,
    });
    expect(a.cookies).toEqual([]);
  });

  test("a ticket never outlives the member cookie", async () => {
    const { q } = await toVouch({ member: await memberCookie(sso, now + 30) });
    const at = new URL(hopped(await gate(q, sso, port)));
    expect((await open(port, KEY, "t", at.searchParams.get("ticket")!, now))?.e).toBe(now + 30);
  });

  test("the vouch reads only __Host-member: no cookie, a forged one, an expired one, or the shell cookie go to sign in", async () => {
    const { q } = await toVouch();
    const cases: Record<string, string[]>[] = [
      {},
      { "__Host-member": [forged(await memberCookie(sso))] },
      { "__Host-member": [await memberCookie(sso, now)] },
      { "__Host-erga": [await shellCookie(sso)] },
      { "__Host-member": [await shellCookie(sso)] },
      // The content domain's cookie name proves nothing on the shell.
      { member: [await memberCookie(sso)] },
    ];
    for (const cookies of cases) {
      const a = responded(await gate({ ...q, cookies }, sso, port));
      expect(a.status).toBe(302);
      expect(a.headers.location.startsWith("/_edge/sign-in?next=")).toBe(true);
    }
  });

  test("the vouch says nothing of its values with no member cookie: a page goes to sign in, anything else gets a 401", async () => {
    for (const url of ["https://erga.example.com/_edge/vouch", "https://erga.example.com/_edge/vouch?back=x&n=y"]) {
      expect(responded(await gate(req(url), sso, port)).status).toBe(401);
      expect(responded(await gate(req(url, { dest: "iframe" }), sso, port)).status).toBe(302);
      // A member's browser hears that the values are wrong.
      const member = { "__Host-member": await memberCookie(sso) };
      expect(responded(await gate(req(url, { cookie: member }), sso, port)).status).toBe(400);
    }
  });

  test("the vouch refuses a `back` that is no document's address, and a hash that is none", async () => {
    const { q } = await toVouch();
    const backs = [
      "https://evil.example.org/",
      "https://pages.example.net.evil.example.org/",
      "https://accept.pages.example.net/_edge/accept",
      "http://abc-ada.pages.example.net/",
      "https://erga.example.com/",
      "https://abc-ada.pages.example.net@evil.example.org/",
      "https://evil.example.org/#.pages.example.net",
      "https://evil.example.org\\.pages.example.net/",
      "javascript://abc.pages.example.net/",
      "",
    ];
    for (const back of backs) expect(responded(await gate({ ...q, query: { ...q.query, back } }, sso, port)).status).toBe(400);
    for (const n of ["", "short", "!".repeat(43), "a".repeat(44)])
      expect(responded(await gate({ ...q, query: { ...q.query, n } }, sso, port)).status).toBe(400);
  });

  /** Through the vouch: the accept's request, with the browser's nonce. */
  async function toAccept() {
    const { q, nonce } = await toVouch();
    const a = responded(await gate(q, sso, port));
    return {
      nonce,
      ticket: new URL(hopOf(a.body)).searchParams.get("ticket")!,
      q: req(hopOf(a.body), { dest: "iframe", cookie: { nonce }, id: "req-3" }),
    };
  }

  test("the accept sets the member cookie for the content domain, partitioned, marks the nonce used, and goes back", async () => {
    const { q } = await toAccept();
    const a = responded(await gate(q, sso, port));
    expect(hopped(a)).toBe(PAGE);
    expect(a.headers.location).toBeUndefined();
    expect(a.headers["referrer-policy"]).toBe("no-referrer");
    const c = set(a.cookies);
    expect(c.member.attrs).toEqual([
      "Path=/",
      `Max-Age=${9 * 3600}`,
      "HttpOnly",
      "Domain=pages.example.net",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ]);
    // The same member cookie as the shell's copy.
    expect(c.member.value).toBe(await memberCookie(sso, now + 9 * 3600));
    // The nonce's cookie now holds the accept's mark: a signed value, for 20 seconds.
    expect(c.nonce.value).toBe(await seal(port, KEY, "d", {}, now + 20));
    expect(c.nonce.attrs.slice(0, 2)).toEqual(["Path=/", "Max-Age=20"]);
    // And the page then opens.
    expect(
      forwarded(await gate(req(PAGE, { dest: "iframe", cookie: { member: c.member.value, nonce: c.nonce.value } }), sso, port)).kind
    ).toBe("member");
  });

  test("the accept refuses: no nonce, another browser's nonce, a forged or old ticket, another kind, another `back`", async () => {
    const { q, ticket } = await toAccept();
    const refuse = async (r: Req) => {
      const a = responded(await gate(r, sso, port));
      expect(a.status).toBe(400);
      expect(a.cookies).toEqual([]);
    };
    await refuse({ ...q, cookies: {} });
    await refuse({ ...q, cookies: { nonce: ["another-browsers-nonce"] } });
    await refuse({ ...q, query: { ...q.query, ticket: forged(ticket) } });
    await refuse({ ...q, now: NOW + 61_000 });
    await refuse({ ...q, query: { ...q.query, ticket: await memberCookie(sso) } });
    await refuse({ ...q, query: { ...q.query, ticket: await seal(port, "k2", "t", { n: "x", m: now + 60 }, now + 60) } });
    await refuse({ ...q, query: { ...q.query, back: "https://evil.example.org/" } });
    await refuse({ ...q, query: { ...q.query, back: "https://accept.pages.example.net/_edge/accept" } });
    // A nonce among two cookies of the name still counts.
    expect(responded(await gate({ ...q, cookies: { nonce: ["x", q.cookies.nonce![0]] } }, sso, port)).status).toBe(200);
  });

  test("the accept is on the accept host only, and the accept host has nothing else", async () => {
    const { q } = await toAccept();
    expect(responded(await gate({ ...q, host: "abc12345-ada.pages.example.net" }, sso, port)).status).toBe(404);
    expect(responded(await gate({ ...q, host: "erga.example.com" }, sso, port)).status).toBe(404);
    expect(
      responded(await gate(req("https://accept.pages.example.net/t/pass/", { cookie: { member: await memberCookie(sso) } }), sso, port))
        .status
    ).toBe(404);
    expect(responded(await gate(req("https://accept.pages.example.net/"), oauth, port)).status).toBe(404);
  });

  /** The gate's page for a browser that can't end the hand-off: fixed, with no script, nothing loaded, and no way on. */
  const unsupported = (a: Respond, status: number) => {
    expect(a.status).toBe(status);
    expect(a.cookies).toEqual([]);
    expect(a.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(a.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.body).toContain("This browser can't open documents on this server");
    for (const needs of [
      "Chrome or Edge, version 114",
      "Firefox, version 103",
      "Safari 26.2 or later, on macOS 26.2",
      "iOS or iPadOS 26.2",
    ])
      expect(a.body).toContain(needs);
    expect(a.body).not.toMatch(/<script|http-equiv|src=|href=|url\(|https?:/i);
  };

  test("a browser that keeps no cookie of the frame's sees the page for it at the accept, each time, and goes nowhere", async () => {
    const { q, ticket } = await toAccept();
    for (const visit of [1, 2]) unsupported(responded(await gate({ ...q, cookies: {}, id: `visit-${visit}` }, sso, port)), 400);
    // On CloudFront the accept is the edge function's.
    unsupported(responded((await edge({ ...q, cookies: {} }, sso, port))!), 400);
    // Only for a good ticket: a forged or an old one with no nonce says nothing of browsers.
    for (const r of [
      { ...q, cookies: {}, query: { ...q.query, ticket: forged(ticket) } },
      { ...q, cookies: {}, now: NOW + 61_000 },
    ])
      expect(responded(await gate(r, sso, port)).body).toBe("Open the document again.");
    // Another browser's nonce is not a browser with no cookie.
    expect(responded(await gate({ ...q, cookies: { nonce: ["another-browsers-nonce"] } }, sso, port)).body).toBe(
      "Open the document again."
    );
  });

  test("a browser that drops the member cookie sees the same page, not a loop; its script's request gets a 401", async () => {
    const mark = await seal(port, KEY, "d", {}, now + 20);
    unsupported(responded(await gate(req(PAGE, { dest: "iframe", cookie: { nonce: mark } }), sso, port)), 401);
    const a = responded(await gate(req(`${PAGE}file.txt`, { dest: "empty", cookie: { nonce: mark } }), sso, port));
    expect([a.status, a.headers["content-type"]]).toEqual([401, "text/plain; charset=utf-8"]);
  });

  test("only the accept's own mark stops a hand-off: a cookie of its name that a document's script set does not", async () => {
    // A document's script can set a cookie for the whole content domain, with any name and value. None of these is the
    // gate's mark: the page goes to the vouch as with no cookie, so one document can't stop the others from opening.
    const planted = ["done", forged(await seal(port, KEY, "d", {}, now + 20)), await seal(port, KEY, "d", {}, now - 1)];
    planted.push(await seal(port, "another-key", "d", {}, now + 20), await memberCookie(sso));
    for (const nonce of planted) {
      const a = await gate(req(PAGE, { dest: "iframe", cookie: { nonce } }), sso, port);
      expect(new URL(hopped(a)).pathname).toBe("/_edge/vouch");
    }
    // Beside a planted cookie, the gate's own mark still counts.
    const both = { nonce: ["done", await seal(port, KEY, "d", {}, now + 20)] };
    unsupported(responded(await gate(req(PAGE, { dest: "iframe", cookie: both }), sso, port)), 401);
  });

  test("sign-out's frame on the accept host ends the content domain's member cookie, for a member's browser only", async () => {
    const out = (cookie: Record<string, string> = {}, c = sso) =>
      gate(req("https://accept.pages.example.net/_edge/sign-out", { dest: "iframe", cookie }), c, port).then(responded);
    // No proof, or one that isn't good: a 401, and no cookie changes.
    const bad: Record<string, string>[] = [{}, { member: forged(await memberCookie(sso)) }, { member: await memberCookie(sso, now) }];
    for (const cookie of bad) expect([(await out(cookie)).status, (await out(cookie)).cookies]).toEqual([401, []]);
    // (Where anyone may come in, there is no proof to ask for.)
    expect((await out({}, oauth)).status).toBe(200);
    const a = await out({ member: await memberCookie(sso) });
    expect(a.status).toBe(200);
    // The hand-off's mark ends too: the next sign-in's first frame starts a new hand-off.
    expect([set(a.cookies).nonce.value, set(a.cookies).nonce.attrs[1]]).toEqual(["", "Max-Age=0"]);
    expect(set(a.cookies).member.attrs).toEqual([
      "Path=/",
      "Max-Age=0",
      "HttpOnly",
      "Domain=pages.example.net",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ]);
  });

  test("where anyone may come in, a content host answers with no cookie, and the vouch never runs", async () => {
    expect(await gate(req(PAGE, { dest: "iframe" }), oauth, port)).toEqual({ do: "forward", caller: { kind: "none" }, cookies: [] });
  });
});

describe("content on the same site", () => {
  const PAGE = "https://abc12345-ada.pages.erga.example.com/t/pass/";

  test("the member cookie of the shell's domain opens it; with none, a 401 and no hand-off", async () => {
    expect(forwarded(await gate(req(PAGE, { dest: "iframe", cookie: { member: await memberCookie(near) } }), near, port)).kind).toBe(
      "member"
    );
    const a = responded(await gate(req(PAGE, { dest: "iframe" }), near, port));
    expect(a.status).toBe(401);
    expect(a.cookies).toEqual([]);
  });

  test("there is no vouch, no accept and no accept host", async () => {
    const m = { "__Host-member": await memberCookie(near), member: await memberCookie(near) };
    expect(
      responded(
        await gate(
          req(`https://erga.example.com/_edge/vouch?back=${encodeURIComponent(PAGE)}&n=${"a".repeat(43)}`, { cookie: m }),
          near,
          port
        )
      ).status
    ).toBe(404);
    expect(
      responded(await gate(req("https://accept.pages.erga.example.com/_edge/accept?ticket=x", { cookie: m }), near, port)).status
    ).toBe(404);
    expect(responded(await gate(req("https://accept.pages.erga.example.com/_edge/sign-out"), near, port)).status).toBe(404);
  });

  test("a person on the shell with no member cookie gets the domain's one", async () => {
    const a = await gate(
      req("https://erga.example.com/", { cookie: { "__Host-erga": await shellCookie(near) }, dest: "document" }),
      near,
      port
    );
    if (a.do != "forward") throw new Error("not forwarded");
    expect(set(a.cookies).member.attrs).toContain("Domain=erga.example.com");
  });
});

describe("behind Cloudflare Access", () => {
  const proof = { ...ADA, p: "access", e: now + 600 };

  test("the person is Access's, on each request: no shell cookie, no sign-in, no callback", async () => {
    const a = await gate(req("https://erga.example.com/documents", { access: proof, dest: "document" }), access, port);
    if (a.do != "forward") throw new Error("not forwarded");
    expect(a.caller).toEqual({ kind: "person", ...ADA, p: "access", i: NOW, e: now + 600 });
    // The member cookie for the vouch, until the proof's end.
    expect((await open(port, KEY, "m", set(a.cookies)["__Host-member"].value, now))?.e).toBe(now + 600);
    expect(responded(await gate(req("https://erga.example.com/_edge/sign-in"), access, port)).status).toBe(404);
    expect(responded(await gate(req("https://erga.example.com/_edge/callback?code=x&state=y"), access, port)).status).toBe(404);
  });

  test("the gate's own shell cookie counts for nothing there, and no proof (or an ended one) is a 401, never a redirect", async () => {
    const s = await shellCookie(access);
    for (const r of [
      req("https://erga.example.com/", { cookie: { "__Host-erga": s }, dest: "document" }),
      req("https://erga.example.com/", { access: { ...proof, e: now }, dest: "document" }),
    ])
      expect(responded(await gate(r, access, port)).status).toBe(401);
  });

  test("signedIn never signs there", async () => {
    expect(responded(await signedIn(req("https://erga.example.com/_edge/callback?code=x&state=y"), access, port, ADA)).status).toBe(400);
  });

  test("the hand-off and agent tokens are the same", async () => {
    const m = await memberCookie(access);
    const v = responded(
      await gate(
        req(`https://erga.example.com/_edge/vouch?back=${encodeURIComponent("https://a-b.pages.example.net/t/x/")}&n=${"a".repeat(43)}`, {
          cookie: { "__Host-member": m },
        }),
        access,
        port
      )
    );
    expect(hopOf(v.body).startsWith("https://accept.pages.example.net/_edge/accept?ticket=")).toBe(true);
    const t = await seal(port, KEY, "a", { p: "access", sub: "sub-ada", g: "g1" }, now + 60);
    expect(forwarded(await gate(req("https://erga.example.com/mcp", { bearer: t }), access, port)).kind).toBe("agent");
  });
});

describe("this machine (no HTTPS)", () => {
  const dev: Config = {
    key: KEY,
    shell: "localhost:4712",
    content: "localhost:4712",
    https: false,
    open: true,
    idp: { github: IDP },
    oauth: true,
    tag: "_4712",
  };

  test("cookies have no __Host-, no Secure and no SameSite=None, and carry the port", async () => {
    const start = responded(await gate(req("http://localhost:4712/_edge/sign-in?next=/x"), dev, port));
    const state = set(start.cookies)["signin_4712"];
    expect(state.attrs).toEqual(["Path=/", "Max-Age=600", "HttpOnly", "SameSite=Lax"]);
    const q = req(`http://localhost:4712/_edge/callback?code=c&state=${new URL(start.headers.location).searchParams.get("state")}`, {
      cookie: { signin_4712: state.value },
    });
    const c = set(responded(await signedIn(q, dev, port, { ...ADA, p: "github" })).cookies);
    expect(c["erga_4712"].attrs).toEqual(["Path=/", `Max-Age=${30 * 86400}`, "HttpOnly", "SameSite=Lax"]);
    expect(c["member_4712"].attrs).toEqual(["Path=/", `Max-Age=${30 * 86400}`, "HttpOnly", "Domain=localhost", "SameSite=Lax"]);
    expect(
      forwarded(
        await gate(
          req("http://localhost:4712/", { cookie: { erga_4712: c["erga_4712"].value, member_4712: c["member_4712"].value } }),
          dev,
          port
        )
      ).kind
    ).toBe("person");
    expect(forwarded(await gate(req("http://abc-ada.localhost:4712/t/x/"), dev, port)).kind).toBe("none");
  });

  test("the gate names every cookie of its own, for a mount to drop", () => {
    expect(GATE_COOKIES(sso)).toEqual(["__Host-erga", "__Host-signin", "__Host-member", "member", "nonce"]);
    expect(GATE_COOKIES(access).slice(5)).toEqual(["CF_Authorization", "CF_AppSession", "CF_Binding"]);
    expect(GATE_COOKIES(dev)).toEqual(["erga_4712", "signin_4712", "member_4712", "member_4712", "nonce_4712"]);
  });
});
