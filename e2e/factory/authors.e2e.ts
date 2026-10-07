// Who the factory's commits are by (#68, factory/author.ts; tests/factory-authors.ts): a task added in a session,
// by the admin agent and with a Share with agent token each records its person, and the stand-in's commits on its
// branch are that person's, committed by Erga factory.
import { expect, test, until } from "../fixtures";
import { board, factory, servers, TASK_MS } from "./factory";
import { admin, author, commits, FACTORY } from "./people";

test.beforeAll(async () => { await servers.factory(); });

// Three tasks done at once by simulated VMs.
test("each way of adding a task (a session, the admin agent, Share with agent's token) gives it its person, whose name is on its commits, committed by the factory; the detail view names the person", { timeout: TASK_MS + 15_000 }, async ({ tab }) => {
  const s = await servers.factory(), f = factory(s);
  await f.on();
  const ada = await admin(f, "Ada"), grace = await admin(f, "Grace");

  const t1 = (await f.api("/tasks", { json: { title: "Tester's own task", description: "A note on the front page." } })).body;
  expect([t1.by, t1.person]).toEqual(["tester", "tester"]);

  const title2 = `Ada's agent's task ${ada.login}`;
  const said = await f.api("/agent", { who: ada.name, json: { text: "Queue it @script " + JSON.stringify([{ tool: "create_task", args: { title: title2, description: "Another note." } }, { text: "Queued." }]) } });
  expect(said.status, JSON.stringify(said.body)).toBe(200);
  const t2 = await until(async () => ((await f.api("/tasks")).body as { title: string }[]).find((t) => t.title == title2) as any, 15_000, "the agent queues the task");
  expect([t2.by, t2.person]).toEqual([`${ada.login}, via their admin agent`, ada.login]);

  const share = await fetch(`${s.root}/admin/share?user=${encodeURIComponent(grace.name)}`, { method: "POST", headers: { Origin: s.root }, body: new URLSearchParams({}) });
  const minted = await share.json() as { token?: string };
  expect(share.ok && !!minted.token?.startsWith("erga_"), JSON.stringify(minted)).toBe(true);
  const t3 = (await f.api("/tasks", { token: minted.token, json: { title: "Grace's agent's task", description: "A third note." } })).body;
  expect([t3.by, t3.person]).toEqual([`${grace.login}, via a shared agent (Share with agent)`, grace.login]);

  await f.until([t1.id, t2.id, t3.id], "complete");
  for (const [t, who] of [[t1, author("tester", "tester")], [t2, author(ada.name, ada.login)], [t3, author(grace.name, grace.login)]] as const) {
    const own = commits(f, `staging..${(await f.task(t.id)).branch}`);
    expect(own.length, `#${t.id} has commits`).toBeGreaterThan(0);
    for (const c of own) expect([c.author, c.committer], `#${t.id}: ${c.subject}`).toEqual([who, FACTORY]);
  }

  const b = await board(tab.page, s.root);
  await until(() => b.eval(`!!document.querySelector('[data-open="${t2.id}"]')`), 5000, "the card");
  await b.click(`[data-open="${t2.id}"]`);
  await until(() => b.eval(`document.getElementById("dlg").open`), 5000, "the detail opens");
  await expect.poll(() => b.eval<string>(`document.querySelector("#dlg .person")?.innerText ?? ""`)).toBe(`Added by ${ada.login}, via their admin agent · commits by ${ada.login}`);
});
