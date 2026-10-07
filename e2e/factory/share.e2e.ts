// Share with agent: an admin token in the editor's card.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";

await servers.factory();

const TOKEN = /erga_[A-Za-z0-9_-]{20,}/;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("Share with agent is an icon in the header bar; its card has an admin token for 12 hours, the same one until New token turns it off; Escape closes it; Revoke at /tokens ends it", async ({ tab }) => {
  const s = await servers.factory();
  const b = await board(tab.page, s.root);
  const as = (path: string, token: string) => fetch(`${s.root}/api/factory${path}`, { headers: bearer(token) });
  expect(await b.eval<boolean>(`!!document.querySelector(".chrome-top > #btn-share.icon-btn[data-tip] svg") && !document.querySelector("#tasks #btn-share, .share-btn")`)).toBe(true);
  await b.click("#btn-share");
  await until(() => b.eval(`!document.getElementById("share").hidden && document.getElementById("share").matches(".help.share") && document.getElementById("btn-share").getAttribute("aria-expanded") == "true"`), 5000, "the editor's card");
  const prompt = () => b.eval<string>(`document.getElementById("share-prompt").value`);
  await expect.poll(prompt, { timeout: 10_000 }).toMatch(TOKEN);
  const text = await prompt();
  const first = TOKEN.exec(text)![0];
  expect(first.startsWith("erga_factory_")).toBe(false);
  expect(text).toContain(`${s.root}/api/admin/guide`);
  expect(text).toContain("Authorization: Bearer");
  expect(text).toMatch(/admin/);
  expect(text).not.toMatch(/can't merge/);
  const note = await b.eval<string>(`document.querySelector("#share .share-note").textContent`);
  expect(note).toMatch(/admin pages/);
  expect(note).toMatch(/12 hours/);
  expect(note).toMatch(/can't make tokens/);
  expect(await b.eval<boolean>(`!!document.querySelector("#share #share-copy.share-primary") && !!document.querySelector("#share #share-rotate")`)).toBe(true);
  expect((await as("/tasks", first)).ok).toBe(true);
  // The same token again, until New token (the server makes it from its id again; tokens.ts keeps only its hash).
  const again = await b.eval<{ token: string; label: string; expires: number }>(`fetch("/admin/share", { method: "POST", body: new URLSearchParams({}) }).then((r) => r.json())`);
  expect(again.token).toBe(first);
  expect(again.label).toBe("Share with agent");
  expect(again.expires - Date.now()).toBeGreaterThan(11.9 * 3600_000);
  expect(again.expires - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
  await b.click("#share-rotate");
  await expect.poll(async () => { const v = await prompt(); return TOKEN.test(v) && !v.includes(first); }, { timeout: 10_000 }).toBe(true);
  expect((await as("/tasks", first)).status).toBe(401);
  const card = TOKEN.exec(await prompt())![0];
  expect((await as("/tasks", card)).ok).toBe(true);
  await b.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await expect.poll(() => b.eval<boolean>(`document.getElementById("share").hidden && document.getElementById("btn-share").getAttribute("aria-expanded") == "false"`)).toBe(true);
  await b.eval(`fetch("/admin/share", { method: "POST", body: new URLSearchParams({}) }).then((r) => r.json()).then((t) => fetch("/tokens/revoke", { method: "POST", body: new URLSearchParams({ id: t.id }) })).then((r) => r.ok)`);
  await expect.poll(async () => (await as("/tasks", card)).status).toBe(401);
});
