// A share that ends stops the address of the document's page (its pass: server/documents/pages-origin.ts) that the
// person kept: it opens the document's files no more. Someone whose share stays gets a new address at their next load.
import { expect, servers, test } from "../../helpers/fixtures";
import { pagesFetch } from "../../helpers/pages-fetch";
import { newDoc, unique } from "./access";

await servers.main();

/** Shares as the owner (the dev server's own person), as their page does. */
const share = (root: string, id: string, login: string, role: string) =>
  fetch(`${root}/api/tools/share_document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(root).origin },
    body: JSON.stringify({ document: id, login, role }),
  }).then((r) => r.status);

/** The address of the document's files that the viewer gives `who`: its pages origin, with their pass. */
async function filesOf(address: string, who: string): Promise<string> {
  const html = await (await fetch(`${address}?user=${who}`)).text();
  const files = /https?:\/\/[^"'\s]+\/t\/[^/"'\s]+\//.exec(html)?.[0];
  expect(files, `${who}'s viewer names the page's address`).toBeTruthy();
  return files!;
}

test("a person removed from a document can't read it with the page address they kept; the others can, after a load", async () => {
  const root = (await servers.main()).root;
  const made = await newDoc(root);
  const address = root + made.at.replace(/[?&]edit=?$/, "");
  const sam = unique("sam"),
    kim = unique("kim");
  expect(await share(root, made.id, sam, "viewer")).toBe(200);
  expect(await share(root, made.id, kim, "viewer")).toBe(200);
  const sams = await filesOf(address, sam),
    kims = await filesOf(address, kim);
  expect((await pagesFetch(`${sams}index.html`)).status).toBe(200);
  // The owner removes Sam.
  expect(await share(root, made.id, sam, "none")).toBe(200);
  const kept = await pagesFetch(`${sams}index.html`);
  expect(kept.status).toBe(403);
  expect(await kept.text()).toBe("This link has expired: reload the page.");
  // Kim's address from before stops too; the next load gives a new one, which opens the page.
  expect((await pagesFetch(`${kims}index.html`)).status).toBe(403);
  await expect.poll(async () => (await pagesFetch(`${await filesOf(address, kim)}index.html`)).status).toBe(200);
});
