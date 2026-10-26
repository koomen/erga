// How long a document lasts: one nobody edits goes on time, one
// edited or open stays, and one deleted from the list is gone, addresses and all.
import { expect, test, until } from "../../helpers/fixtures";
import { person, servers, tools } from "./front";

await servers.script();

/** Each test document goes this long after it's made unless someone edits it (?unedited=, dev only): time to share it and join its room first. */
const UNEDITED_MS = 4000;

test("a document nobody edits is deleted on time, and leaves the list; one that's edited stays; one someone has open stays for now (an hour more)", async () => {
  const p = await person(await servers.script());
  const token = await p.token();
  const [kept, open] = [await p.make(`?unedited=${UNEDITED_MS}`), await p.make(`?unedited=${UNEDITED_MS}`)];
  await p.share(kept, "Bo", "editor");
  await p.share(open, "Cy", "editor");
  const bo = await p.join(kept, "Bo"), cy = await p.join(open, "Cy");
  try {
    bo.insertAfter("<p>", "Bo was here. ");
    // Made last, so when it's gone the others' time is up too.
    const gone = await p.make(`?unedited=${UNEDITED_MS}`);
    await until(async () => !(await p.exists(gone)), UNEDITED_MS + 6000, "the unedited document goes");
    // The open one's time was put off by an hour: its alarm has come.
    const expiresOf = async (id: string) => ((await tools(p.base, token).call("list_documents")).data as { id: string; expires?: string }[]).find((d) => d.id == id)?.expires;
    await until(async () => Date.parse((await expiresOf(open)) ?? "0") - Date.now() > 30 * 60_000, 5000, "the open document's time put off");
    expect(await p.exists(kept)).toBe(true);
    expect(await p.exists(open)).toBe(true);
    const list = await p.docs();
    expect(list).not.toContain(`value="${gone}"`);
    expect(list).toContain(`href="${(await p.nameOf(kept)).address}?edit"`);
  } finally { bo.destroy(); cy.destroy(); }
});

test("a document is deleted only from this site's pages (a delete without an Origin is refused); then it's gone, off the list, and its address is a 404", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const address = (await p.nameOf(id)).address;
  const form = (headers: Record<string, string>) => p.get("/docs/delete", { method: "POST", body: new URLSearchParams({ id }), headers });
  expect((await form({})).status).toBe(403);
  expect((await form({ Origin: p.origin })).status).toBe(303);
  expect(await p.exists(id)).toBe(false);
  expect(await p.docs()).not.toContain(`value="${id}"`);
  expect((await p.get(address)).status).toBe(404);
});
