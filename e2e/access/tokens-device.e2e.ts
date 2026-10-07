// The device flow with a scope (The device flow): the approval page shows the scope, the
// document and the expiry; Deny tells the agent, and Approve in the browser hands it a token of that scope.
import { expect, servers, test, until } from "../fixtures";
import { getter, mint, publish, signIn, tool } from "./access";

await servers.main();

const ask = async (root: string, body: object) => (await (await fetch(`${root}/api/auth/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as { code: string; user_code: string; approve_url: string };
const poll = (root: string, code: string) => fetch(`${root}/api/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });

test("denied: the agent's poll hears it's gone", async () => {
  const root = (await servers.main()).root;
  const denied = await ask(root, { label: "Denied agent", scope: "admin" });
  await getter(root)("/tokens/approve", { method: "POST", headers: { Cookie: await signIn(root, null), Origin: root }, body: new URLSearchParams({ code: denied.user_code, answer: "deny" }) });
  expect((await poll(root, denied.code)).status).toBe(410);
});

test("the approval page shows the scope, the document and the expiry, with Approve and Deny; approved in the browser, the agent collects a document token", async ({ tab }) => {
  const root = (await servers.main()).root;
  tab.strict = true;
  const made = await publish(root, (await mint(root, null, { label: "Docs", scope: "documents" })).token, "Scoped one");
  const asked = await ask(root, { label: "Claude Code", scope: "document", doc: made.address, expires: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) });
  const u = new URL(asked.approve_url), approvePath = u.pathname + u.search;
  const html = await (await getter(root)(approvePath, { headers: { Cookie: await signIn(root, null) } })).text();
  for (const part of ["One document", "Scoped one", "Expires", ">Deny<", ">Approve<"]) expect(html).toContain(part);
  const page = tab.page;
  await page.goto(root + approvePath);
  await page.evaluate(() => (document.querySelector("button[value=approve]") as HTMLButtonElement).click());
  await until(() => page.evaluate(() => document.body.innerText.includes("Approved")), 10_000, "approved in the browser");
  const got = (await (await poll(root, asked.code)).json()) as { token?: string };
  expect(got.token).toBeTruthy();
  expect((await tool(root, got.token!, "whoami")).text).toContain('"scope": "document"');
});
