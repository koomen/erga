// The account corner in the pages the server sends (the markup): every page of the site's own has
// it, the editor has its own, a document has none.
import { expect, servers, test } from "../fixtures";
import { getter, newDoc } from "./access";

await servers.main();

test("every page of the site's own has your avatar in its corner", async () => {
  const get = getter((await servers.main()).root);
  for (const path of ["/", "/docs", "/admin", "/settings", "/nobody-here"]) {
    const html = await (await get(path)).text();
    expect(html, path).toContain('data-erga-account="in"');
    expect(html, path).toContain("https://avatars.githubusercontent.com/tester?s=64");
  }
});

test("the editor's page has the corner, and the links for its own menu, Admin among them for an admin", async () => {
  const root = (await servers.main()).root, get = getter(root);
  const { at } = await newDoc(root);
  const html = await (await get(at)).text();
  expect(html).toContain('data-erga-account="in"');
  expect(html).toContain('name="erga-account"');
  expect(JSON.parse(/name="erga-account" content="([^"]+)"/.exec(html)![1].replaceAll("&quot;", '"')).admin).toBe("/admin");
});

test("a document's own files, and the front page's document on its pages origin, have no corner", async () => {
  const root = (await servers.main()).root, get = getter(root);
  const { id } = await newDoc(root);
  expect(await (await get(`/d/${id}/doc/index.html`)).text()).not.toContain("data-erga-account");
  // The front page: the viewer's frame until its first deploy is done, then the page itself, whose one corner is in its controls (worker/home.ts).
  const front = await (await get("/")).text();
  const frameSrc = /<iframe id="frame" class="erga-view" (?:data-)?src="([^"]+)"/.exec(front)?.[1].replaceAll("&amp;", "&");
  if (frameSrc) {
    const framed = await (await fetch(frameSrc.replace(/^http:\/\/[^/]+/, root), { headers: { Host: new URL(frameSrc).host } })).text();
    expect(framed).not.toContain("data-erga-account");
  } else {
    const at = front.indexOf("<erga-controls");
    expect(at).toBeGreaterThan(0);
    expect(front.split("data-erga-account").length).toBe(2);
    expect(front.indexOf("data-erga-account")).toBeGreaterThan(at);
  }
});

test("someone who isn't an admin has no Admin, and a local tab's ?user= stays on the links", async () => {
  const html = await (await getter((await servers.main()).root)("/docs?user=Ada")).text();
  expect(html).toContain('data-erga-account="in"');
  expect(html).toContain('href="/docs?user=Ada"');
  expect(html).not.toContain('href="/admin');
});

test("signed out, /docs asks you to sign in first, and the front page's corner offers it", async () => {
  const root = (await servers.main()).root, get = getter(root);
  const out = await get("/auth/logout", { method: "POST", headers: { Origin: root } });
  const cookie = out.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");
  expect((await get("/docs", { headers: { Cookie: cookie } })).headers.get("location")).toBe("/auth/github?next=%2Fdocs");
  const front = await (await get("/", { headers: { Cookie: cookie } })).text();
  expect(front).toContain('data-erga-account="out"');
  expect(front).toContain('href="/auth/github?next=%2F"');
});
