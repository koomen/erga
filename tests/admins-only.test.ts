// Pages tokens on a server for admins only, and sign-in on a server with no GitHub OAuth app.
import { expect, test } from "bun:test";
import { pagesToken, readPagesClaims } from "../server/documents/index.ts";
import { finishSignIn, startSignIn } from "../server/identity/sign-in";
import type { Platform } from "../server/platform";
import type { Directory } from "../server/directory/index.ts";
import { respond } from "../server/http.ts";

/** A server with this GitHub client ID, and nothing else sign-in needs for these requests. */
const serverWith = (clientId: string): Platform => ({
  secret: "x", dev: () => false, directory: {} as Directory,
  signIn: { app: { clientId, secret: "" }, github: "https://github.com", devLogin: null, encryptionKey: null },
  deploy: { target: null, version: null, primary: null },
  own: { get: async () => undefined, put: async () => {}, delete: async () => {} },
} as unknown as Platform);

test("a pages token names its admin only when asked to (staging), and it can't be changed", async () => {
  const plain = await pagesToken("s", "ada", "abcd2345", "https://staging.erga.dev");
  expect((await readPagesClaims("s", plain, "ada", "abcd2345"))?.by).toBeUndefined();
  const named = await pagesToken("s", "ada", "abcd2345", "https://staging.erga.dev", undefined, { by: "Koomen" });
  expect((await readPagesClaims("s", named, "ada", "abcd2345"))?.by).toBe("koomen");
  const [claims, mac] = named.split(".");
  const forged = btoa(atob(claims.replace(/-/g, "+").replace(/_/g, "/")).replace("koomen", "bo")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(await readPagesClaims("s", `${forged}.${mac}`, "ada", "abcd2345")).toBeNull();
  // An editor's token says so (its pages come with the editor's scripts in them); a reader's doesn't.
  expect((await readPagesClaims("s", plain, "ada", "abcd2345"))?.edit).toBeUndefined();
  expect((await readPagesClaims("s", await pagesToken("s", "ada", "abcd2345", "https://staging.erga.dev", undefined, { edit: true }), "ada", "abcd2345"))?.edit).toBe(true);
});

test("no GitHub OAuth app (GITHUB_CLIENT_ID empty): sign-in says so, rather than sending people to GitHub's 404", async () => {
  const env = serverWith("");
  for (const answer of [
    await respond(startSignIn, new Request("https://staging.erga.dev/auth/github?next=/docs"), env),
    await respond(finishSignIn, new Request("https://staging.erga.dev/auth/github/callback?code=1&state=2"), env),
  ]) {
    expect(answer.status).toBe(503);
    expect(answer.headers.get("location")).toBeNull();
    const html = await answer.text();
    expect(html).toContain("Sign-in isn't set up on this server: it has no GitHub OAuth app.");
    expect(html).toContain("GITHUB_CLIENT_ID");
  }
  const set = await respond(startSignIn, new Request("https://erga.dev/auth/github"), serverWith("Ov23abc"));
  expect(set.status).toBe(302);
  expect(set.headers.get("location")).toStartWith("https://github.com/login/oauth/authorize?client_id=Ov23abc&");
});

test("an admin's token without the admin scope reaches only the API, MCP and documents' routes on staging (tokenPath)", async () => {
  const { tokenPath } = await import("../server/identity/token-paths");
  for (const p of [
    "/mcp",
    "/api/publish",
    "/api/tools",
    "/api/tools/versions",
    "/api/tools/rename_document",
    "/ada/notes/api/doc",
    "/ada/notes/doc/index.html",
    "/d/abcd2345/doc/a.css",
    "/d/abcd2345/api/doc",
  ])
    expect(`${p}: ${tokenPath(p)}`).toBe(`${p}: true`);
  for (const p of [
    "/admin",
    "/admin/users/api/x",
    "/api/admin/agent",
    "/api/admin/guide",
    "/api",
    "/api/ext/tools/read",
    "/api/source/api/x",
    "/api/deploys",
    "/api/events",
    "/api/docs/abcd2345/home",
    "/settings",
    "/tokens/new",
    "/docs",
    "/new",
    "/deploy/x/api",
    "/tokens/x/api",
    "/ada/notes",
    "/d/notanid/doc/x",
    "/",
  ])
    expect(`${p}: ${tokenPath(p)}`).toBe(`${p}: false`);
});
