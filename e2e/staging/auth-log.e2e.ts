// The change log on both servers says who changed which app, never a secret (tests/admin-auth.ts, "the change log").
import { expect, servers, test } from "../fixtures";
import { form, newApp, PROD_APP, reset } from "./auth";

await servers.pair();

test("production's log has staging's app set, its own new values waiting and discarded; staging's has its app; neither a secret", async () => {
  const p = await servers.pair(), P = p.prod.root, S = p.staging.root;
  await reset(p);
  const app = newApp(), next = newApp();
  expect((await form(P, { do: "save", server: "other", clientId: app.clientId, secret: app.secret })).status).toBe(200);
  expect((await form(P, { do: "save", server: "here", clientId: next.clientId, secret: next.secret })).status).toBe(200);
  expect((await form(P, { do: "discard", server: "here" })).status).toBe(200);
  const prodLog = await (await fetch(`${P}/admin/changes`)).text(), stagingLog = await (await fetch(`${S}/admin/changes`)).text();
  expect(prodLog).toContain(`staging's GitHub app in use: client ID <code>${app.clientId}</code>`);
  expect(prodLog).toContain("waits for a test sign-in");
  expect(prodLog).toContain("new values discarded");
  expect(stagingLog).toContain(`staging's GitHub app in use: client ID <code>${app.clientId}</code>`);
  for (const secret of [PROD_APP.secret, app.secret, next.secret]) {
    expect(prodLog).not.toContain(secret);
    expect(stagingLog).not.toContain(secret);
  }
});
