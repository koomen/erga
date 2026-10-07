// Staging signed out ("signed out"): the sign-in page, JSON 403 for the API and MCP, git asks
// for a token; signing in and the static files still open.
import { spawnSync } from "node:child_process";
import { cleanEnv } from "../env";
import { expect, servers, test } from "../fixtures";
import { get, mcp, page, refusedJson, signedOut } from "./admins";

await servers.staging();

test("signed out: pages say to sign in, with the button; the API and MCP answer JSON 403", async () => {
  const s = await servers.staging(), out = { Cookie: signedOut(s) };
  let r = await page(s, "/docs", out);
  const html = await r.text();
  expect(r.status).toBe(403);
  expect(html).toContain("Staging is for admins: sign in");
  expect(html).toContain('href="/auth/github?next=%2Fdocs"');
  r = await page(s, "/", out);
  expect(r.status).toBe(403);
  expect(await r.text()).toContain("Staging is for admins: sign in");
  expect(await refusedJson(await get(s, "/api/deploys", { headers: out })), "the API").toBe(true);
  expect(await refusedJson(await mcp(s, out)), "MCP").toBe(true);
});

test("signed out: signing in and the static files still open", async () => {
  const s = await servers.staging(), out = { Cookie: signedOut(s) };
  expect((await get(s, "/auth/github?next=/docs", { headers: out })).status).toBe(302);
  expect((await get(s, "/style.css", { headers: out })).status).toBe(200);
  expect((await get(s, "/fonts/inter.css", { headers: out })).status).toBe(200);
});

test("an anonymous git read gets 401, asking for a token, and git ls-remote fails", async () => {
  const s = await servers.staging();
  const r = await get(s, "/git/erga.git/info/refs?service=git-upload-pack");
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toMatch(/^Basic/);
  const ls = spawnSync("git", ["ls-remote", `${s.root}/git/erga.git`], { encoding: "utf8", env: cleanEnv(), timeout: 30_000 });
  expect(ls.status).not.toBe(0);
});
