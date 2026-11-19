// Sign-out ends all the person's sign-ins, on all devices (server/identity/sign-in.ts, signOut): the gate's cookie
// says when its sign-in was made, sign-out writes its time for the person (users.sessions), and a sign-in made before
// it is nobody's (server/identity/admit.ts). A cookie that someone copied stops with it. The answer asks the gate to
// end this browser's cookies, and the page loads the gate's sign-out on the documents' site.

import { expect, test } from "bun:test";
import { freshLogin, server as app } from "./helpers/app";

const cookieIn = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`));

function server() {
  const s = app();
  /** A new sign-in of the GitHub account `handle` (local development's pretend provider): the gate's cookie, as a browser keeps it. */
  const cookieOf = async (handle: string, subject: string) => {
    // (A sign-in made in the same millisecond as a sign-out is ended with it: the next one is later.)
    const t = Date.now();
    while (Date.now() == t);
    const r = await s.fetch(`/auth/dev?provider=github&subject=${subject}&handle=${handle}&next=/documents`);
    return cookieIn(r, "erga")!;
  };
  const who = async (cookie: string) => {
    const r = await s.fetch("/api/tools/whoami", {
      method: "POST",
      headers: { Cookie: cookie, Origin: s.root, "Content-Type": "application/json" },
      body: "{}",
    });
    return r.ok ? ((await r.json()) as { result: { login: string } }).result.login : null;
  };
  const out = (cookie: string) => s.fetch("/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: s.root } });
  const elsewhere = (cookie: string, method: string) =>
    s.fetch("/auth/logout", { method, headers: { Cookie: cookie, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
  return { s, cookieOf, who, out, elsewhere };
}

test("sign-out ends every sign-in of the person: a copied cookie and another device's stop; other people's stay", async () => {
  const { s, cookieOf, who, out } = server();
  const ada = freshLogin("ada"),
    bo = freshLogin("bo");
  const laptop = await cookieOf(ada, "1"),
    phone = await cookieOf(ada, "1"),
    copied = laptop,
    other = await cookieOf(bo, "2");
  expect([await who(laptop), await who(phone), await who(other)]).toEqual([ada, ada, bo]);

  const answer = await out(laptop);
  expect(answer.status).toBe(200);
  // The gate ends this browser's cookies (Erga asked it to: the header that asks never leaves the server). The
  // documents share this site here (<id>.localhost under localhost), so their cookie ended with it.
  expect([cookieIn(answer, "erga"), cookieIn(answer, "member")]).toEqual(["erga=", "member="]);
  expect(await answer.text()).toContain('"gate":null');
  expect(answer.headers.get("x-erga-gate")).toBeNull();
  expect([await who(copied), await who(phone)]).toEqual([null, null]);
  expect(await who(other)).toBe(bo);
  // The gate ends the cookies of a browser that comes with a sign-in from before it.
  const stale = await s.fetch("/documents", { headers: { Cookie: phone }, redirect: "manual" });
  expect([cookieIn(stale, "erga"), cookieIn(stale, "member"), stale.headers.get("x-erga-gate")]).toEqual(["erga=", "member=", null]);

  // A new sign-in works, and the old cookies stay ended.
  const again = await cookieOf(ada, "1");
  expect([await who(again), await who(copied)]).toEqual([ada, null]);
});

test("a request that isn't the person's own sign-out ends nothing", async () => {
  const { cookieOf, who, elsewhere } = server();
  const ada = freshLogin("ada");
  const cookie = await cookieOf(ada, "1");
  // Another site's link to /auth/logout, and its form: the question, not the sign-out.
  for (const method of ["GET", "POST"]) {
    const asked = await elsewhere(cookie, method);
    expect(await asked.text()).toContain("Sign out of Erga");
    expect(cookieIn(asked, "erga")).toBeUndefined();
  }
  expect(await who(cookie)).toBe(ada);
});

test("documents on another site: the sign-out page loads the gate's sign-out there, which ends that site's cookie", async () => {
  const { s } = server();
  // (The app at 127.0.0.1, and the documents under localhost: two sites.)
  const page = await s.fetch("http://127.0.0.1/auth/logout", { method: "POST", headers: { Origin: "http://127.0.0.1" } });
  expect(await page.text()).toContain('"gate":"http://accept.localhost/_edge/sign-out"');
  const r = await s.fetch("http://accept.localhost/_edge/sign-out");
  expect(r.status).toBe(200);
  expect(r.headers.getSetCookie().join("\n")).toMatch(/^member=; Path=\/; Max-Age=0; HttpOnly; Domain=localhost/);
});
