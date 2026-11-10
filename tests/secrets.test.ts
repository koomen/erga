// The fixes from the audit of how secrets are stored and handled (each fix's reason is a comment next to it): each test
// stands for one way a secret could leak or be used where it shouldn't.

import { expect, test } from "bun:test";
import { Directory } from "../server/directory/index.ts";
import { Tokens } from "../server/identity/tokens";
import { freshLogin, runTool, server as app, type Server } from "./helpers/app";
import { memory } from "./helpers/memory-sql";


test("an agent token works only on the server whose secret made it, not on a copy of its database (staging's)", async () => {
  const sql = memory();
  const dir = new Directory(sql);
  const production = new Tokens(sql, "production-secret-".repeat(3), dir), staging = new Tokens(sql, "staging-secret-".repeat(3), dir);
  const { token } = await production.mint({ login: "ada", name: "Ada" }, "Claude Code", { scope: "documents" });
  expect((await production.verify(token))?.login).toBe("ada");
  // Staging holds the same rows (its database is a copy of production's), but not production's secret.
  expect(await staging.verify(token)).toBeNull();
  // Its own tokens still work there.
  const own = await staging.mint({ login: "ada", name: "Ada" }, "Claude Code", { scope: "documents" });
  expect((await staging.verify(own.token))?.login).toBe("ada");
  expect(await production.verify(own.token)).toBeNull();
});

test("the Share buttons on a copy of production's database (staging's) give a token that works there, not production's row", async () => {
  const sql = memory();
  const dir = new Directory(sql);
  const production = new Tokens(sql, "production-secret-".repeat(3), dir), staging = new Tokens(sql, "staging-secret-".repeat(3), dir);
  const ada = { login: "ada", name: "Ada" };
  const before = await production.share(ada, false);
  const shared = await staging.share(ada, false);
  expect((await staging.verify(shared.token))?.login).toBe("ada");
  expect(shared.token).not.toBe(before.token);
  // The next time, the same token (staging's own now), as on production.
  expect((await staging.share(ada, false)).token).toBe(shared.token);
  expect((await production.share(ada, false)).token).not.toBe(shared.token);
});

test("a document's pages token is checked whole (its MAC compared in constant time): a changed one opens nothing", async () => {
  const { pagesToken, readPagesToken } = await import("../server/documents");
  const token = await pagesToken("pages-secret", "ada", "abcd1234", "https://erga.dev");
  expect(await readPagesToken("pages-secret", token, "ada", "abcd1234")).toBe("https://erga.dev");
  const flip = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const bad of [flip, token.slice(0, -1), `${token}x`, token.split(".")[0] + "."]) expect(await readPagesToken("pages-secret", bad, "ada", "abcd1234")).toBeNull();
  expect(await readPagesToken("another-secret", token, "ada", "abcd1234")).toBeNull();
});

test("a person removed from a document can't read it with the page address they kept; the others can, after a load", async () => {
  // The whole app, in memory: a share that ends stops the address of the document's page (its pass:
  // server/documents/pages-origin.ts) that the person kept; someone whose share stays gets a new address at their next load.
  const s = app();
  const at = (await s.fetch("/new")).headers.get("location")!.replace(/[?&]edit=?$/, "");
  const id = ((await (await s.fetch(`${at}/api/doc`)).json()) as { docName: { id: string } }).docName.id;
  /** Shares as the owner (the dev login), as their page does. */
  const share = async (login: string, role: string) => (await runTool(s, "share_document", { document: id, login, role })).status;
  /** The address of the document's files that the viewer gives `who`: its pages origin, with their pass. */
  const filesOf = async (server: Server, who: string) => {
    const html = await (await server.fetch(`${at}?user=${who}`)).text();
    const files = /https?:\/\/[^"'\s]+\/t\/[^/"'\s]+\//.exec(html)?.[0];
    expect(files, `${who}'s viewer names the page's address`).toBeTruthy();
    return files!;
  };
  const sam = freshLogin("sam"),
    kim = freshLogin("kim");
  expect(await share(sam, "viewer")).toBe(200);
  expect(await share(kim, "viewer")).toBe(200);
  const sams = await filesOf(s, sam),
    kims = await filesOf(s, kim);
  expect((await s.fetch(`${sams}index.html`)).status).toBe(200);
  // The owner removes Sam.
  expect(await share(sam, "none")).toBe(200);
  const kept = await s.fetch(`${sams}index.html`);
  expect(kept.status).toBe(403);
  expect(await kept.text()).toBe("This link has expired: reload the page.");
  // Kim's address from before stops too; the next load gives a new one, which opens the page.
  expect((await s.fetch(`${kims}index.html`)).status).toBe(403);
  const again = await filesOf(s, kim);
  expect(again).not.toBe(kims);
  expect((await s.fetch(`${again}index.html`)).status).toBe(200);
});
