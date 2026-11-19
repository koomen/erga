// The requests of the server's own browser (server/identity/admit.ts, viewRequest), which the app answers in process
// while view_page renders a page in the viewer (cloudflare/render.ts). One that the viewer's own page made is its
// person's, only on its one document's paths and the operations, never with admin power; anywhere else it is
// nobody's. Any other is nobody's, whatever its headers say. The whole render, with a browser: tests/render-front.test.ts.
import { expect, test } from "bun:test";
import { sessionOf, viewRequest } from "../server/identity/admit.ts";
import { callerOf } from "../server/identity/caller.ts";
import { calling, server as app } from "./helpers/app";
import { type Platform, whoOf } from "../server/platform.ts";
import { VIA } from "../shared/attribution.ts";

const DOC = "abcd1234";
const fake = (dev: boolean) =>
  ({
    secret: "test-secret",
    dev: () => dev,
    signIn: { mode: "oauth", devLogin: "dev" },
    directory: {
      users: { signedIn: async (login: string) => ({ login }), allowed: async () => true, get: async (login: string) => ({ login }) },
      find: async (ref: string) => (ref == "/ada/notes" ? { id: DOC } : ref == "/ada/other" ? { id: "zzzz9999" } : null),
    },
  }) as unknown as Platform;

const ADA = { login: "ada", doc: DOC };
const asked = (path: string, as: typeof ADA | null, headers: Record<string, string> = {}) =>
  viewRequest(`https://erga.test${path}`, { method: "GET", headers: new Headers(headers) }, as);

test("the viewer's own page is its person on the document's viewer, its API and the operations: one document, no admin power", async () => {
  for (const path of [`/d/${DOC}`, `/d/${DOC}/api/key`, "/ada/notes", "/ada/notes/api/room", "/api/tools/ls"]) {
    const s = await sessionOf(fake(false), asked(path, ADA));
    expect(s, path).toMatchObject({ login: "ada", onlyDoc: DOC, view: true });
    expect(s?.admin, path).toBeUndefined();
  }
});

test("what it does is an agent's: the server's browser runs an agent's code", async () => {
  const s = await sessionOf(fake(false), asked(`/d/${DOC}/api/key`, ADA));
  expect(whoOf(s!)).toEqual({ login: "ada", onlyDoc: DOC, via: VIA.view });
});

test("anywhere else it is nobody, not even the dev login", async () => {
  for (const path of ["/documents", "/api/agent", "/api/agent/conversation", "/ada/other", `/d/zzzz9999`, "/tokens", "/admin"])
    for (const dev of [false, true]) expect(await sessionOf(fake(dev), asked(path, ADA)), `${path} ${dev ? "(dev)" : ""}`).toBeNull();
});

test("a request brings no caller, token, cookie or address, whatever a page's script wrote in it; only the mark names a person", async () => {
  const admin = { kind: "person", p: "dev", sub: "tester", email: "", name: "tester", i: Date.now(), e: Date.now() / 1000 + 3600 } as const;
  const forged = {
    ...calling(admin),
    Authorization: "Bearer a-token",
    Cookie: "erga=1; erga_signed_out=1",
    "CF-Connecting-IP": "203.0.113.9",
    "X-Forwarded-For": "203.0.113.9",
    "X-Kept": "1",
  };
  // Not the viewer's own page (the document's page, a worker): nobody.
  const other = asked(`/d/${DOC}`, null, forged);
  expect([...other.headers]).toEqual([["x-kept", "1"]]);
  expect(callerOf(other)).toEqual({ kind: "none" });
  expect(await sessionOf(fake(true), other)).toBeNull();
  // The viewer's own page: its person, never who the header names.
  expect(await sessionOf(fake(true), asked(`/d/${DOC}`, ADA, forged))).toMatchObject({ login: "ada", view: true });
  // And the mark is the request's own: the same address and headers in another request name nobody.
  const marked = asked(`/d/${DOC}`, ADA);
  expect(await sessionOf(fake(false), new Request(marked.url, { headers: marked.headers }))).toBeNull();
});

test("behind the gate, in the whole app: the viewer's page is its person on the document, with no admin power, nobody elsewhere, and makes no token", async () => {
  const s = app();
  const at = (await s.fetch("/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const id = ((await (await s.fetch(`${at}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  /** The app's answer in process, as the render asks it: the viewer's own page's request (`own`), or another's. */
  const ask = (path: string, own: boolean, init: { method?: string; body?: string } = {}) =>
    s.erga(
      viewRequest(
        s.root + path,
        {
          method: init.method ?? "GET",
          headers: new Headers({ "Content-Type": "application/json", Origin: s.root }),
          body: init.body,
        },
        own ? { login: "tester", doc: id } : null
      )
    );
  const whoami = async (r: Response) => ((await r.json()) as { result?: { via?: string; adminPower?: boolean } }).result;
  // (The dev login, through the gate: an admin.)
  const post = { method: "POST", headers: { "Content-Type": "application/json", Origin: s.root }, body: "{}" };
  expect(await whoami(await s.fetch("/api/tools/whoami", post))).toMatchObject({ adminPower: true });
  expect(await whoami(await ask("/api/tools/whoami", true, { method: "POST", body: "{}" }))).toMatchObject({
    via: VIA.view,
    adminPower: false,
  });
  expect((await ask("/api/tools/whoami", false, { method: "POST", body: "{}" })).status).toBe(401);
  // Its own document opens; the admin pages and the person's list don't.
  expect((await ask(`/d/${id}/api/doc`, true)).status).toBe(200);
  expect((await ask(`/d/${id}/api/doc`, false)).status).toBe(401);
  expect((await ask("/admin", true)).status).not.toBe(200);
  expect((await ask("/documents", true)).status).toBe(302);
  // And it makes no token.
  const made = await ask("/tokens/new", true, { method: "POST", body: JSON.stringify({ label: "x", scope: "documents" }) });
  expect([made.status, made.headers.get("x-erga-token")]).toEqual([403, null]);
});
