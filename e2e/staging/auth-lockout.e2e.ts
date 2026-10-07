// Lockout: new values for a working app wait for a test sign-in, and can be discarded; a clear
// that would stop sign-in is refused; values GitHub doesn't know are refused.
import { expect, servers, test } from "../fixtures";
import { form, newApp, PROD_APP, reset, status } from "./auth";

await servers.pair();

test("production's new values wait while its app works, and Discard drops them", async () => {
  const p = await servers.pair(), P = p.prod.root;
  await reset(p);
  const next = newApp();
  const r = await form(P, { do: "save", server: "here", clientId: next.clientId, secret: next.secret });
  expect(r.status).toBe(200);
  expect(((await r.json()) as { result?: { kept: string } }).result?.kept).toBe("pending");
  let here = (await status(P)).here;
  expect([here.inUse.clientId, here.pending?.clientId, here.pendingCheck?.state]).toEqual([PROD_APP.clientId, next.clientId, "working"]);
  expect((await fetch(`${P}/auth/github?next=/docs`, { redirect: "manual" })).status, "local sign-in still works (it skips GitHub)").toBe(302);
  const d = await form(P, { do: "discard", server: "here" });
  expect(((await d.json()) as { result: { discarded: boolean } }).result.discarded).toBe(true);
  here = (await status(P)).here;
  expect([here.pending, here.inUse.clientId]).toEqual([null, PROD_APP.clientId]);
});

test("clearing staging's values is refused when the deploy has none; a client ID GitHub doesn't know is refused", async () => {
  const p = await servers.pair(), P = p.prod.root, S = p.staging.root;
  await reset(p);
  const app = newApp();
  expect((await form(P, { do: "save", server: "other", clientId: app.clientId, secret: app.secret })).status).toBe(200);
  let r = await form(P, { do: "clear", server: "other" });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error?: string }).error).toMatch(/Clearing would stop sign-in for everyone/);
  expect((await status(S)).here.inUse.source).toBe("page");
  r = await form(P, { do: "save", server: "here", clientId: "Ov23liNoSuchApp000009", secret: "x".repeat(40) });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toMatch(/no OAuth app with this client ID/);
});
