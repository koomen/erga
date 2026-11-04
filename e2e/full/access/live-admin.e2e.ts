// Live pages on the admin pages: a change made elsewhere (an agent with an admin token, another tab)
// shows on the open page at once, in place, and nothing else on it moves (server/news/).
import { expect, servers, test } from "../../helpers/fixtures";
import { admin, freshLogin, person, resetting, tools } from "../front/front";

await servers.script();

test("Users, Settings and the Change log follow an agent's changes as they're made, with no reload", async ({ tab }) => {
  const s = await servers.script();
  const a = await admin(s);
  const page = tab.page;
  tab.strict = true;
  await page.goto(`${s.root}/admin/users?user=tester`);
  // The same page all along: a reload, even the admin shell's in place, would make the list again without this mark.
  await page.evaluate(`document.querySelector("ol.users").dataset.mark = "same"`);
  const login = freshLogin("u");
  /** Their row as shown (someone added who hasn't signed in yet): their handle and role, or "" when there's none. */
  const row = () =>
    page.evaluate<string>(
      `(() => { const li = [...document.querySelectorAll("ol.users > li")].find((li) => li.querySelector(".title").innerText == "${login}"); return li ? li.dataset.live + " " + li.querySelector("select.role").value : ""; })()`
    );
  const added = await a.call("set_user", { action: "add", provider: "github", handle: login, role: "read" });
  expect(added.status).toBe(200);
  const person = (added.data as { person: { person: number } }).person.person;
  await expect.poll(row).toBe(`person:${person} read`);
  await a.call("set_user", { action: "role", person, role: "write" });
  await expect.poll(row).toBe(`person:${person} write`);
  await a.call("set_user", { action: "remove", person });
  await expect.poll(row).toBe("");
  expect(await page.evaluate<string>(`document.querySelector("ol.users").dataset.mark`)).toBe("same");

  // A setting, changed by the agent: its row shows the new value.
  await page.goto(`${s.root}/admin?user=tester`);
  await resetting(s, "delete_docs_after_hours", async () => {
    await a.call("set_setting", { key: "delete_docs_after_hours", value: 7 });
    await expect
      .poll(() =>
        page.evaluate<string>(`document.querySelector('li[data-live="setting:delete_docs_after_hours"] input[name=value]').value`)
      )
      .toBe("7");
  });

  // Access: a rule the agent adds comes in at its place; sharing publicly, switched by the agent, shows switched.
  await page.goto(`${s.root}/admin/access?user=tester`);
  const org = freshLogin("org");
  const rules = () => page.evaluate<string>(`[...document.querySelectorAll("ol.rules > li .title")].map((t) => t.innerText).join(" | ")`);
  await a.call("set_access", { action: "add", kind: "github_org", value: org, access: "read" });
  await expect.poll(rules).toContain(org);
  await resetting(s, "public_sharing", async () => {
    const on = await page.evaluate<boolean>(`document.getElementById("public-sharing").checked`);
    await a.call("set_access", { action: "public", on: !on });
    await expect.poll(() => page.evaluate<boolean>(`document.getElementById("public-sharing").checked`)).toBe(!on);
  });
  const id = ((await a.call("people")).data as { rules: { id: number; value: string }[] }).rules.find((r) => r.value == org)!.id;
  await a.call("set_access", { action: "remove", id });
  await expect.poll(rules).not.toContain(org);

  // The change log: each change comes in at the top.
  await page.goto(`${s.root}/admin/changes?user=tester`);
  const top = () => page.evaluate<string>(`document.querySelector("ol.changes > li").innerText`);
  const other = freshLogin("u");
  await a.call("set_user", { action: "add", provider: "github", handle: other, role: "read" });
  await expect.poll(top).toContain(other);
  // A group rule's change says which group and its access (it showed as a setting before: "access never → never").
  const group = freshLogin("org");
  await a.call("set_access", { action: "add", kind: "github_org", value: group, access: "read" });
  await expect.poll(top).toContain(`${group} added: Can authenticate`);
  const rule = ((await a.call("people")).data as { rules: { id: number; value: string }[] }).rules.find((r) => r.value == group)!.id;
  await a.call("set_access", { action: "remove", id: rule });
  await a.call("set_user", {
    action: "remove",
    person: ((await a.call("people")).data as { users: { person?: number; handle?: string }[] }).users.find((x) => x.handle == other)!
      .person,
  });
});
