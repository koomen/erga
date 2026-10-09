// Documents' addresses (front.ts): /d/<id>, /<owner>/<id> and the canonical /<owner>/<slug>, the
// viewer there and the editor with #edit, and no /edit route.
import { expect, test } from "../../fixtures";
import { person, servers } from "./front";

await servers.script();

test("/d/<id>, /<you>/<id> (keeping the query) and a differently cased owner all redirect to the canonical /<you>/<slug>", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  expect(await p.location(`/d/${id}`)).toBe(`/${p.login}/untitled`);
  expect(await p.location(`/${p.login}/${id}?from=here`)).toBe(`/${p.login}/untitled?from=here`);
  expect(await p.location(`/${p.login.toUpperCase()}/untitled`)).toBe(`/${p.login}/untitled`);
});

test("the canonical address is the viewer (the page, Edit, Clone, a way back to Documents), which goes into the editor with #edit as it loads, naming the host it talks to", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const html = await (await p.get(`/${p.login}/untitled`)).text();
  for (const want of ['<iframe id="frame" class="erga-view"', `href="/${p.login}/untitled#edit"`, `href="/new?from=${id}"`, 'href="/docs"']) expect(html, want).toContain(want);
  expect(html).toContain(`<meta name="erga-base" content="/d/${id}">`);
  expect(html).toContain("<title>Untitled</title>");
  expect(html).toContain('if (location.hash == "#edit") {\n  document.body.classList.add("erga-editing");');
  // The editor's code isn't in the viewer's page.
  expect(html).not.toContain('/page.js"></script>');
});

test("no /edit route: after an address it is a page called edit (none here: a 404); an address with no document is a 404; the host answers under every address", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  expect((await p.get(`/${p.login}/untitled/edit`)).status).toBe(404);
  expect(await p.location(`/d/${id}/edit`)).toBe("(404)");
  expect((await p.get(`/${p.login}/nothing-here`)).status).toBe(404);
  expect((await p.get(`/d/zzzzzzzz`)).status).toBe(404);
  for (const sub of [`/d/${id}/api/doc`, `/${p.login}/untitled/api/doc`, `/${p.login}/${id}/api/doc`]) expect((await p.get(sub)).ok, sub).toBe(true);
});
