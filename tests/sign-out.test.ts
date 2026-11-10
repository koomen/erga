// Sign-out ends all the person's sign-ins, on all devices (server/identity/sign-in.ts, signOut): each session cookie
// carries the person's sign-in number (users.sessions), and sign-out raises the number. A cookie that someone copied
// stops with it.

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Directory } from "../server/directory/index.ts";
import { sessionOf } from "../server/identity/session.ts";
import { signIn, signOut } from "../server/identity/sign-in.ts";
import { respond } from "../server/http";
import type { Platform } from "../server/platform";
import { memory } from "./helpers/memory-sql";

const ORIGIN = "https://erga.test";

async function server() {
  const dir = new Directory(memory(), { admins: ["root"] });
  await dir.users.add({ login: "root", admin: true }, "ada");
  await dir.users.add({ login: "root", admin: true }, "bo");
  const platform = {
    secret: "s".repeat(40),
    directory: dir,
    dev: () => false,
    signIn: {},
    deploy: {},
  } as unknown as Platform;
  /** A new sign-in of `login`: its session cookie, as a browser keeps it. */
  const cookieOf = async (login: string) => {
    const r = await respond(
      Effect.flatMap(
        Effect.sync(() => new Request(`${ORIGIN}/auth/x`)),
        (request) => signIn(platform, request, { login, name: login }, "/docs")
      ),
      new Request(`${ORIGIN}/auth/x`),
      platform
    );
    return r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("erga_session="))!;
  };
  const who = async (cookie: string) => (await sessionOf(platform, new Request(`${ORIGIN}/docs`, { headers: { cookie } })))?.login ?? null;
  const out = (cookie: string) =>
    respond(signOut, new Request(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie, origin: ORIGIN } }), platform);
  const elsewhere = (cookie: string, method: string) =>
    respond(
      signOut,
      new Request(`${ORIGIN}/auth/logout`, { method, headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" } }),
      platform
    );
  return { dir, cookieOf, who, out, elsewhere };
}

test("sign-out ends every sign-in of the person: a copied cookie and another device's stop; other people's stay", async () => {
  const { cookieOf, who, out } = await server();
  const laptop = await cookieOf("ada"),
    phone = await cookieOf("ada"),
    copied = laptop,
    other = await cookieOf("bo");
  expect([await who(laptop), await who(phone), await who(other)]).toEqual(["ada", "ada", "bo"]);

  expect((await out(laptop)).status).toBe(200);
  expect([await who(copied), await who(phone)]).toEqual([null, null]);
  expect(await who(other)).toBe("bo");

  // A new sign-in works, and the old cookies stay ended.
  const again = await cookieOf("ada");
  expect([await who(again), await who(copied)]).toEqual(["ada", null]);
});

test("a request that isn't the person's own sign-out ends nothing", async () => {
  const { cookieOf, who, elsewhere } = await server();
  const cookie = await cookieOf("ada");
  // Another site's link to /auth/logout, and its form: the question, not the sign-out.
  expect(await (await elsewhere(cookie, "GET")).text()).toContain("Sign out of Erga");
  expect(await (await elsewhere(cookie, "POST")).text()).toContain("Sign out of Erga");
  expect(await who(cookie)).toBe("ada");
});
