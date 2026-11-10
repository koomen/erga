// The view cookie (server/identity/session.ts): the session the server's browser holds while view_page renders a page
// in the viewer. It signs its person in only on its one document's paths and the operations, never with admin power;
// anywhere else, or once expired, it signs in nobody (not even local development's dev login).
import { expect, test } from "bun:test";
import { sessionOf, viewCookie } from "../server/identity/session.ts";
import { type Platform, whoOf } from "../server/platform.ts";
import { VIA } from "../shared/attribution.ts";

const SECRET = "test-secret";
const DOC = "abcd1234";
const fake = (dev: boolean) =>
  ({
    secret: SECRET,
    dev: () => dev,
    signIn: { devLogin: "dev" },
    directory: {
      users: { signedIn: async (login: string) => ({ login }), allowed: async () => true, get: async (login: string) => ({ login }) },
      find: async (ref: string) => (ref == "/ada/notes" ? { id: DOC } : ref == "/ada/other" ? { id: "zzzz9999" } : null),
    },
  }) as unknown as Platform;

const ask = async (path: string, cookie: string, dev = false) =>
  sessionOf(fake(dev), new Request(`https://erga.test${path}`, { headers: { cookie: `erga_session=${cookie}` } }));

test("it signs its person in on its document's viewer, its API and the operations: one document, no admin power", async () => {
  const cookie = await viewCookie(SECRET, "ada", DOC);
  for (const path of [`/d/${DOC}`, `/d/${DOC}/api/key`, "/ada/notes", "/ada/notes/api/room", "/api/tools/ls"]) {
    const s = await ask(path, cookie);
    expect(s, path).toMatchObject({ login: "ada", onlyDoc: DOC, view: true });
    expect(s?.admin, path).toBeUndefined();
  }
});

test("what it does is an agent's: the server's browser runs an agent's code", async () => {
  const s = await ask(`/d/${DOC}/api/key`, await viewCookie(SECRET, "ada", DOC));
  expect(whoOf(s!)).toEqual({ login: "ada", onlyDoc: DOC, via: VIA.view });
});

test("anywhere else, or expired, it signs in nobody, not even the dev login", async () => {
  const cookie = await viewCookie(SECRET, "ada", DOC);
  for (const path of ["/docs", "/api/agent", "/api/agent/conversation", "/ada/other", `/d/zzzz9999`, "/tokens", "/admin"])
    for (const dev of [false, true]) expect(await ask(path, cookie, dev), `${path} ${dev ? "(dev)" : ""}`).toBeNull();
  const old = await viewCookie(SECRET, "ada", DOC, Date.now() - 3_600_000);
  expect(await ask(`/d/${DOC}`, old, true)).toBeNull();
});
