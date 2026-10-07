// Who did it (#69; tests/attribution.ts): the change log page shows each change's person, and how they did it.
import { expect, test, until } from "../fixtures";
import { servers } from "./factory";
import { freshHours, SETTING, unique, who } from "./who";

test.beforeAll(async () => { await servers.factory(); });

test("/admin/changes shows \"tester\" and beside it how: their admin agent, a shared agent (its label), a shared agent (Share with agent), or nothing in person; every change is by a person's login", async ({ tab }) => {
  const s = await servers.factory(), w = who(s);
  const label = `Attribution ${unique()}`, token = await w.mint(label);
  await w.setInPerson(SETTING, freshHours());
  await w.tool(token, "set_setting", { key: SETTING, value: freshHours() });
  await w.tool(await w.shareToken(), "set_setting", { key: SETTING, value: freshHours() });
  const user = `log-${unique()}`;
  await w.tool(token, "add_user", { login: user });
  await w.adminAgent([{ tool: "set_user_role", args: { login: user, role: "admin" } }, { text: "Done." }]);
  await until(async () => (await w.changes(token)).some((v) => v.changes.some((c) => c.user?.login == user && c.user.event == "role")), 10_000, "the admin agent changes the role");
  for (const v of await w.changes(token)) expect(v.by).toMatch(/^[a-z0-9-]+$/);

  await tab.page.goto(`${s.root}/admin/changes`);
  await until(() => tab.page.evaluate(`!!document.querySelector("li.change")`), 5000, "the change log lists changes");
  const rows = await tab.page.evaluate(`[...document.querySelectorAll("li.change")].map((li) => ({ by: li.querySelector(".by").textContent, via: li.querySelector(".via")?.dataset.via ?? null }))`) as { by: string; via: string | null }[];
  for (const via of ["their admin agent", `a shared agent (${label})`, "a shared agent (Share with agent)", null]) {
    expect(rows.some((r) => r.by == "tester" && r.via == via), `"tester" and ${via ?? "no via"}`).toBe(true);
  }
});
