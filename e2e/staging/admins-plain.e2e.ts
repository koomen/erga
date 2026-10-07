// A server with no deploy target is unchanged by staging's guard (tests/staging-admins.ts, "no deploy target").
import { expect, servers, test } from "../fixtures";
import { frameOf, get, page, pagesFetch, publish } from "./admins";
import { mint, signIn } from "./staging";

test.beforeAll(async () => { await servers.main(); });

test("signed out, /docs sends you to sign in; anonymous git reads and users who aren't admins get in", async () => {
  const s = await servers.main();
  let r = await page(s, "/docs", { Cookie: `erga_signed_out_${s.port}=1` });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toMatch(/^\/auth\/github/);
  r = await get(s, "/git/erga.git/info/refs?service=git-upload-pack");
  expect([401, 403]).not.toContain(r.status);
  expect((await page(s, "/docs", { Cookie: await signIn(s.root, "bo") })).status).toBe(200);
});

test("its pages tokens name nobody, and work", async () => {
  const s = await servers.main();
  const admin = await mint(s.root, await signIn(s.root), "admin");
  const doc = await publish(s, admin, "Plain");
  const frame = frameOf(await (await page(s, new URL(doc.address, s.root).pathname)).text());
  const claims = JSON.parse(atob(/\/t\/([^/.]+)\./.exec(frame)![1].replace(/-/g, "+").replace(/_/g, "/")));
  expect("a" in claims).toBe(false);
  expect((await pagesFetch(`${frame}doc/index.html`)).status).toBe(200);
});
