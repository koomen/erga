// Who may open and edit a document: nobody but its owner until it's
// shared; then editors edit and viewers only look; only the owner shares.
import { expect, test, until } from "../../helpers/fixtures";
import { person, servers } from "./front";

await servers.script();

test("someone it isn't shared with can't open it, nor reach its host, and is told why", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const r = await p.as("Ada", `/${p.login}/untitled`);
  expect(r.status).toBe(403);
  expect(await r.text()).toContain("hasn't been shared with");
  expect((await p.as("Ada", `/d/${id}/api/doc`)).status).toBe(403);
});

test("the owner shares it with a viewer, who opens it and has it on their list, view only, without a delete button; but can't publish to it, rename, delete or share it", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const shared = await p.share(id, "Ada", "viewer");
  expect(shared.status).toBe(200);
  expect(shared.body.permissions?.map((x) => `${x.login}:${x.role}`)).toEqual([`${p.login}:owner`, "ada:viewer"]);
  expect((await p.as("Ada", `/${p.login}/untitled`)).status).toBe(200);
  expect((await p.as("Ada", `/d/${id}/doc/index.html`)).ok).toBe(true);
  const list = await (await p.as("Ada", "/docs")).text();
  expect(list).toContain(`href="/${p.login}/untitled?user=Ada&amp;edit"`);
  expect(list).toContain(`${p.login} · view only`);
  expect(list).not.toContain(`value="${id}"`);
  expect((await p.as("Ada", `/d/${id}/api/stored/index.html`, { method: "PUT", body: "<h1>Mine now</h1>" })).status).toBe(403);
  expect((await p.tool("rename_document", { document: id, title: "Viewer's title" }, "Ada")).status).toBe(403);
  expect((await p.tool("delete_document", { document: id }, "Ada")).status).toBe(403);
  expect((await p.share(id, "Bo", "editor", "Ada")).status).toBe(403);
});

test("in the room, a viewer sees every edit and theirs reach nobody, nor storage; made an editor, the same person's edits land, and they may publish", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "viewer");
  const owner = await p.join(id, p.login), viewer = await p.join(id, "Ada");
  try {
    viewer.insertAfter("<p>", "Viewer was here. ");
    // The viewer's edit has gone out before the owner's is made: once the owner's is stored, the room has had both.
    await until(() => viewer.provider.ws?.bufferedAmount === 0, 2000, "the viewer's edit sent");
    owner.insertAfter("<p>", "Owner was here. ");
    await until(() => viewer.text()?.toString().includes("Owner was here."), 5000, "the viewer sees the owner's edit");
    await until(async () => (await (await p.get(`/d/${id}/api/stored/index.html`)).text()).includes("Owner was here."), 10_000, "the owner's edit stored");
    expect(owner.text()?.toString()).not.toContain("Viewer was here.");
    expect(await (await p.get(`/d/${id}/api/stored/index.html`)).text()).not.toContain("Viewer was here.");
    viewer.destroy();
    await p.share(id, "Ada", "editor");
    const editor = await p.join(id, "Ada");
    try {
      editor.insertAfter("<p>", "Editor was here. ");
      await until(() => owner.text()?.toString().includes("Editor was here."), 5000, "an editor's edit reaches the owner");
      expect((await p.as("Ada", `/d/${id}/api/stored/notes.txt`, { method: "PUT", body: "hi" })).ok).toBe(true);
    } finally { editor.destroy(); }
  } finally { viewer.destroy(); owner.destroy(); }
});

test("shared with anyone who has the link, anyone signed in may open it, as a viewer; unshared, nobody can again; the owner's own permission can't be changed", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "viewer");
  expect((await p.as("Dee", `/${p.login}/untitled`)).status).toBe(403);
  await p.share(id, "*", "viewer");
  expect((await p.as("Dee", `/${p.login}/untitled`)).status).toBe(200);
  expect((await p.as("Dee", `/d/${id}/api/stored/index.html`, { method: "PUT", body: "x" })).status).toBe(403);
  await p.share(id, "*", "none");
  await p.share(id, "Ada", "none");
  expect((await p.as("Dee", `/${p.login}/untitled`)).status).toBe(403);
  expect((await p.as("Ada", `/${p.login}/untitled`)).status).toBe(403);
  expect((await p.share(id, p.login, "viewer")).status).toBe(403);
});

test("document_access says who a document is shared with, to its owner only; the list marks it shared, with a share button", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  await p.share(id, "Ada", "viewer");
  const sharedWith = (
    await p.tool<{ permissions: { login: string; role: string }[]; notUsers: string[] }>("document_access", { document: id })
  ).result!;
  expect(sharedWith.permissions.map((x) => `${x.login}:${x.role}`)).toEqual([`${p.login}:owner`, "ada:viewer"]);
  expect(Array.isArray(sharedWith.notUsers)).toBe(true);
  expect((await p.tool("document_access", { document: id }, "Ada")).status).toBe(403);
  const row = (await p.docs()).split(/<li[ >]/).find((li) => li.includes(`/${p.login}/untitled"`)) ?? "";
  expect(row).toContain(">Shared<");
  expect(row).toContain(`class="act share"`);
});

test("the share dialog on /docs, in a browser, adds people, sets anyone-with-the-link and stops sharing with someone", async ({ tab }) => {
  const p = await person(await servers.script());
  const id = await p.make();
  const address = (await p.nameOf(id)).address;
  const page = tab.page;
  await page.goto(`${p.base}/auth/github?as=${p.login}&next=/docs`);
  await page.evaluate(`document.querySelector('li a[href="${address}?edit"]').closest('li').querySelector('button.share').click()`);
  const people = () => page.evaluate(`document.querySelectorAll('#share .people li').length`);
  await expect.poll(people).toBe(1);
  await page.evaluate(`(() => { const f = document.querySelector('#share form.add'); f.elements.login.value = "Bo"; f.elements.role.value = "viewer"; f.requestSubmit(); })()`);
  await expect.poll(people).toBe(2);
  await page.evaluate(
    `(() => { const s = document.getElementById("share-anyone"); s.value = "editor"; s.dispatchEvent(new Event("change")); })()`
  );
  await expect
    .poll(async () =>
      (await p.tool<{ permissions: { login: string; role: string }[] }>("document_access", { document: id }))
        .result!.permissions.map((x) => `${x.login}:${x.role}`)
        .join()
    )
    .toBe(`${p.login}:owner,*:editor,bo:viewer`);
  await page.evaluate(`document.querySelector('#share .people li:last-child button.act').click()`);
  await expect.poll(people).toBe(1);
});
