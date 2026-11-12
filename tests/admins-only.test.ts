// Pages tokens on a server for admins only, and sign-in on a server with no OAuth app for a provider.
import { expect, test } from "bun:test";
import { pagesToken, readPagesClaims } from "../server/documents/index.ts";
import { finishOAuth, startOAuth } from "../server/identity/oauth";
import type { Platform } from "../server/platform";
import type { Directory } from "../server/directory/index.ts";
import { respond } from "../server/http.ts";
import { server as app, signedOut } from "./helpers/app";

/** A server with this GitHub client ID, and nothing else sign-in needs for these requests. */
const serverWith = (clientId: string): Platform => ({
  secret: "x", dev: () => false, directory: {} as Directory,
  signIn: {
    mode: "oauth",
    apps: { github: { clientId, secret: "" }, google: { clientId: "", secret: "" } },
    origins: { github: null, google: null },
    devLogin: null,
    encryptionKey: null,
  },
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
    await respond(startOAuth("github"), new Request("https://staging.erga.dev/auth/github?next=/docs"), env),
    await respond(finishOAuth("github"), new Request("https://staging.erga.dev/auth/github/callback?code=1&state=2"), env),
  ]) {
    expect(answer.status).toBe(503);
    expect(answer.headers.get("location")).toBeNull();
    const html = await answer.text();
    expect(html).toContain("<h1>GitHub sign-in isn't set up</h1>");
    expect(html).toContain("This server has no GitHub OAuth app yet.");
    expect(html).toContain("GITHUB_CLIENT_ID");
  }
  // The same page for each provider: Google's, with its own names.
  const google = await respond(finishOAuth("google"), new Request("https://staging.erga.dev/auth/google/callback?code=1&state=2"), env);
  expect(google.status).toBe(503);
  const html = await google.text();
  expect(html).toContain("<h1>Google sign-in isn't set up</h1>");
  expect(html).toContain("GOOGLE_CLIENT_ID");
  const set = await respond(startOAuth("github"), new Request("https://erga.dev/auth/github"), serverWith("Ov23abc"));
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

test("a server whose deploy says DEPLOY_TARGET=staging is for admins only: signed out, a page asks to sign in, and the API refuses", async () => {
  const s = app({ staging: true });
  const page = await s.fetch("/docs", { headers: { ...signedOut(), Accept: "text/html" } });
  expect(page.status).toBe(403);
  const html = await page.text();
  expect(html).toContain("Staging is for admins: sign in");
  // No SNAPSHOT_FROM here: the page names no primary, and no instance's name.
  expect(html).not.toContain("Erga itself");
  const api = await s.fetch("/api/tools", { headers: signedOut() });
  expect(api.status).toBe(403);
  expect(((await api.json()) as { adminsOnly?: boolean }).adminsOnly).toBe(true);
  // (The same server lets its admin in: the guard, not a broken route, refused those.)
  expect((await s.fetch("/docs", { headers: { Accept: "text/html" } })).status).toBe(200);
});
