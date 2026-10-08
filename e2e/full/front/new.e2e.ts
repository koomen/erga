// /new and the documents list (front.ts): a blank document, its automatic address, the landing
// page the server makes, and another site's link or form asking first.
import { expect, test } from "../../fixtures";
import { person, servers, template } from "./front";

await servers.script();

test("a new person's list is empty", async () => {
  const p = await person(await servers.script());
  expect(await p.docs()).toContain("No documents yet");
});

test("/new makes a blank document, a copy of templates/doc, Untitled at /<you>/untitled, listed as unedited; it sends its maker to its editor", async () => {
  const p = await person(await servers.script());
  const id = await p.make();
  const name = await p.nameOf(id);
  expect(name).toMatchObject({ title: "Untitled", slug: "untitled", titleSet: false, slugSet: false });
  expect(await (await p.get(`/${p.login}/untitled/doc/index.html`)).text()).toBe(template("doc"));
  const list = await p.docs();
  expect(list).toContain(`href="/${p.login}/untitled#edit"`);
  expect(list).toContain(">Untitled<");
  expect(list).toContain("Unedited");
});

test("a second Untitled document gets the next free slug, /<you>/untitled-2", async () => {
  const p = await person(await servers.script());
  await p.make();
  expect((await p.nameOf(await p.make())).slug).toBe("untitled-2");
});

test("/new?from=landing copies the landing page the server makes, and / shows it", async () => {
  // (The old harness checked this on a fresh server, before anything asked for the landing document; the worker's
  // server may have made it for an earlier test, which /new?from=landing and / don't tell apart.)
  const p = await person(await servers.script());
  const copy = await p.get("/new?from=landing");
  expect(copy.status).toBe(302);
  expect(copy.headers.get("location") ?? "").toMatch(/#edit$/);
  const front = await (await p.get("/")).text();
  // The viewer on it until its first deploy is done, then the page itself (worker/home.ts).
  expect(front.includes('class="erga-view"') || front.includes("<erga-controls"), front.slice(0, 1500)).toBe(true);
  expect(front).toContain('href="/new?from=landing"');
});

test("another site's link or form to /new asks first and makes nothing; the button, posted from here, makes the document", async () => {
  const p = await person(await servers.script());
  const before = await p.docs();
  const linked = await p.get("/new?from=landing", { headers: { "Sec-Fetch-Site": "cross-site" } });
  expect(linked.status).toBe(200);
  expect(await linked.text()).toContain(`<form method="post" action="/new?from=landing">`);
  expect(await p.docs()).toBe(before);
  expect((await p.get("/new", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status).toBe(200);
  const posted = await p.get("/new", { method: "POST", headers: { Origin: p.origin } });
  expect(posted.status).toBe(302);
  expect(posted.headers.get("location") ?? "").toMatch(new RegExp(`^/${p.login}/`));
});

test("sign-in's next= stays on the site, however the address is dressed up", async () => {
  const s = await servers.script();
  for (const next of ["//elsewhere.example", "/\\elsewhere.example", "/\t/elsewhere.example", "https://elsewhere.example"]) {
    const res = await fetch(`${s.root}/auth/github?as=someone&next=${encodeURIComponent(next)}`, { redirect: "manual" });
    expect(res.headers.get("location"), JSON.stringify(next)).toBe("/");
  }
});
