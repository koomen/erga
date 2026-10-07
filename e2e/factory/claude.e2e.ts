// The Claude sign-in: stored, never shown, signed out again (tests/factory.ts, 7).
import { expect, test, until } from "../fixtures";
import { board, factory, servers } from "./factory";

await servers.factory();

test("a bad token is refused with the reason; a wrapped one is taken, on the page and by the server; a good one is stored, never shown, and signed out", async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  expect((await f.api("/claude", { method: "DELETE" })).body.signedIn).toBe(false);
  const b = await board(tab.page, s.root);
  const why = () => b.eval<string>(`document.getElementById("c-why").textContent`);
  const signedIn = () => b.eval<boolean>(`document.getElementById("claude-pill").textContent == "Claude: signed in"`);
  await b.click("#claude-pill");
  await until(() => b.eval(`!!document.getElementById("c-token")`), 3000, "the sign-in dialog");
  await b.fill("#c-token", "not a token");
  await b.click("#c-save");
  await expect.poll(why).toContain("isn't a Claude Code token");
  await b.fill("#c-token", "sk-ant-oat01-abc$def!0123456789012345");
  await b.click("#c-save");
  await expect.poll(why).toContain("characters other than letters");
  const fake = `sk-ant-oat01-${"x".repeat(40)}`;
  await b.fill("#c-token", `${fake.slice(0, 25)}  ${fake.slice(25)} `); // as the terminal wraps it
  await b.click("#c-save");
  await expect.poll(signedIn).toBe(true);
  const wrapped = await f.api("/claude", { method: "PUT", json: { token: `${fake.slice(0, 30)}\n${fake.slice(30)}` } });
  expect(wrapped.status).toBe(200);
  expect(wrapped.body.signedIn).toBe(true);
  expect((await f.api("/claude", { method: "DELETE" })).body.signedIn).toBe(false);
  await b.click("#claude-pill");
  await until(() => b.eval(`!!document.getElementById("c-token")`), 3000, "the sign-in dialog, again");
  await b.fill("#c-token", fake);
  await b.click("#c-save");
  await expect.poll(signedIn).toBe(true);
  for (const path of ["", "/claude", "/tasks"]) expect(JSON.stringify((await f.api(path)).body)).not.toContain(fake);
  expect(await b.eval<string>(`document.documentElement.outerHTML`)).not.toContain(fake.slice(14));
  expect((await f.api("/claude", { method: "DELETE" })).body.signedIn).toBe(false);
});
