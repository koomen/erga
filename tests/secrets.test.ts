// The fixes from the audit of how secrets are stored and handled (each fix's reason is a comment next to it): each test
// stands for one way a secret could leak or be used where it shouldn't.

import { expect, test } from "bun:test";
import { seal } from "../gate/core.ts";
import { webPort } from "../gate/port.ts";
import { edgeKey } from "../server/identity/caller.ts";
import { freshLogin, runTool, server as app, type Server } from "./helpers/app";


test("an agent's token and a sign-in's cookie work only on the server whose secret made them: the gate's key comes from it", async () => {
  const s = app();
  const login = freshLogin("key");
  const who = { p: "dev", sub: login, email: "", name: login };
  const end = Math.floor(Date.now() / 1000) + 3600;
  const whoami = async (headers: Record<string, string>) =>
    (
      await s.fetch("/api/tools/whoami", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: s.root, ...headers },
        body: "{}",
      })
    ).status;
  // A sign-in's cookie under this server's key signs its person in; under another server's key it is nobody's.
  const cookie = async (secret: string) =>
    `erga=${await seal(webPort, await edgeKey(secret), "s", { ...who, i: Date.now() }, end)}; erga_signed_out=1`;
  expect(await whoami({ Cookie: await cookie(s.platform.secret) })).toBe(200);
  expect(await whoami({ Cookie: await cookie("another-server's-secret") })).toBe(401);
  // The same for an agent's token; and the server's secret itself is not the key.
  const token = (secret: string, key?: string) =>
    edgeKey(secret).then((k) => seal(webPort, key ?? k, "a", { p: "dev", sub: login, g: "nosuchgrant" }, end));
  expect(await whoami({ Authorization: `Bearer ${await token("another-server's-secret")}` })).toBe(401);
  expect(await whoami({ Authorization: `Bearer ${await token("", s.platform.secret)}` })).toBe(401);
  // A token under this server's key reaches the app, which finds no grant for it: refused there.
  const refused = await s.fetch("/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(s.platform.secret)}` },
    body: "{}",
  });
  expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([401, expect.stringContaining('error="invalid_token"')]);
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
