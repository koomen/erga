// Which servers are for admins only (deploy/targets.json `adminsOnly`), and sign-in on a server with no GitHub OAuth app.
import { expect, test } from "bun:test";
import { isAdminsOnly, TARGETS } from "../deploy/targets";
import { pagesToken, readPagesClaims } from "../front";
import { finishSignIn, startSignIn } from "../worker/auth";
import type { Env } from "../worker/env";

test("staging is for admins only; production, a /deploy server and local development aren't", () => {
  expect(TARGETS.staging.adminsOnly).toBe(true);
  expect(isAdminsOnly("staging")).toBe(true);
  expect(isAdminsOnly(" staging ")).toBe(true);
  for (const t of ["production", "", undefined, "constructor", "toString", "Staging"]) expect(isAdminsOnly(t)).toBe(false);
});

test("a pages token names its admin only when asked to (staging), and it can't be changed", async () => {
  const plain = await pagesToken("s", "ada", "abcd2345", "https://staging.erga.dev");
  expect((await readPagesClaims("s", plain, "ada", "abcd2345"))?.by).toBeUndefined();
  const named = await pagesToken("s", "ada", "abcd2345", "https://staging.erga.dev", undefined, { by: "Koomen" });
  expect((await readPagesClaims("s", named, "ada", "abcd2345"))?.by).toBe("koomen");
  const [claims, mac] = named.split(".");
  const forged = btoa(atob(claims.replace(/-/g, "+").replace(/_/g, "/")).replace("koomen", "bo")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await readPagesClaims("s", `${forged}.${mac}`, "ada", "abcd2345")).toBeNull();
});

test("no GitHub OAuth app (GITHUB_CLIENT_ID empty): sign-in says so, rather than sending people to GitHub's 404", async () => {
  const env = { GITHUB_CLIENT_ID: "", SESSION_SECRET: "x" } as Env;
  for (const answer of [await startSignIn(env, new Request("https://staging.erga.dev/auth/github?next=/docs")), await finishSignIn(env, new Request("https://staging.erga.dev/auth/github/callback?code=1&state=2"))]) {
    expect(answer.status).toBe(503);
    expect(answer.headers.get("location")).toBeNull();
    const html = await answer.text();
    expect(html).toContain("Sign-in isn't set up on this server: it has no GitHub OAuth app.");
    expect(html).toContain("GITHUB_CLIENT_ID");
  }
  const set = await startSignIn({ GITHUB_CLIENT_ID: "Ov23abc", SESSION_SECRET: "x" } as Env, new Request("https://erga.dev/auth/github"));
  expect(set.status).toBe(302);
  expect(set.headers.get("location")).toStartWith("https://github.com/login/oauth/authorize?client_id=Ov23abc&");
});
