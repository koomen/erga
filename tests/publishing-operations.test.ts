// Publishing's rules (server/operations/publishing.ts, server/sites/), on the whole app in memory: one document for each
// domain, an admin alone publishes, a claimed domain needs replace and serves the old document until the publish,
// "Not published" frees the domain at once, a domain with nothing published answers with nothing, and the header bar
// works only on the Erga domain.

import { expect, test } from "bun:test";
import { runTool, server, signedOut } from "./helpers/app";

const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

async function world() {
  const s = server({ domains: ["site.test"] });
  const make = async (title: string) =>
    (
      await runTool<{ id: string }>(s, "create_document", {
        title,
        files: { "index.html": page(title), "about.html": page(`About ${title}`) },
      })
    ).result!.id;
  const set = (document: string, args: Record<string, unknown>, as = {}) => runTool(s, "set_publishing", { document, ...args }, as);
  const publish = (document: string, as = {}) => runTool(s, "publish_document", { document }, as);
  const publishing = async (document: string, as = {}) => (await runTool(s, "ls", { document }, as)).result.publishing;
  /** An address as someone signed out gets it: its status and its text. */
  const at = async (address: string) => {
    const r = await s.fetch(address, { headers: signedOut() });
    return [r.status, await r.text()] as const;
  };
  return { s, make, set, publish, publishing, at };
}

test("a document takes a free domain, serves nothing until it is published, and leaves the domain free at once", async () => {
  const { make, set, publish, publishing, at } = await world();
  const a = await make("Alpha");
  expect(await publishing(a)).toMatchObject({
    domain: null,
    state: "free",
    canPublish: true,
    domains: [
      { domain: "localhost", erga: true, document: null },
      { domain: "site.test", erga: false, document: null },
    ],
  });
  // No such domain; no publish without a domain.
  expect((await set(a, { domain: "elsewhere.test" })).error).toMatch(
    /has no domain elsewhere\.test\. Its domains: localhost, site\.test\./
  );
  expect((await publish(a)).error).toBe("This document has no domain: choose one first (set_publishing).");
  // Linked: nothing is live yet.
  expect((await set(a, { domain: "site.test" })).result.publishing).toMatchObject({
    domain: "site.test",
    state: "linked",
    bars: false,
    version: null,
  });
  expect(await at("http://site.test/")).toEqual([404, ""]);
  // Published: its files at their clean addresses, as they are, and nothing of it on the Erga domain.
  const done = (await publish(a)).result;
  expect(done.publishing).toMatchObject({ state: "published", version: 1, serving: true });
  expect(done.live).toMatchObject({ url: "http://site.test/", files: { "about.html": "http://site.test/about.html" } });
  expect((await at("http://site.test/"))[1]).toContain("<h1>Alpha</h1>");
  expect((await at("http://site.test/about"))[1]).toContain("<h1>About Alpha</h1>");
  expect((await at("http://site.test/"))[1]).not.toContain("<erga-controls");
  expect(await at("/")).toEqual([404, ""]);
  // Not published: free at once.
  expect((await set(a, { domain: "" })).result.publishing).toMatchObject({ domain: null, state: "free" });
  expect(await at("http://site.test/")).toEqual([404, ""]);
  expect(await at("http://site.test/about")).toEqual([404, ""]);
});

test("a claimed domain: refused with the document's name; with replace, the old document serves until the new one is published", async () => {
  const { make, set, publish, publishing, at } = await world();
  const a = await make("Alpha"),
    b = await make("Beta");
  await set(a, { domain: "localhost" });
  await publish(a);
  const refused = await set(b, { domain: "localhost" });
  expect([refused.status, refused.error]).toEqual([
    409,
    "Alpha (/tester/alpha) is published to localhost. Ask your user, then call this again with replace: true. Visitors see that document until this one is published.",
  ]);
  expect((await publishing(b)).domain).toBeNull();
  // Replace: Alpha is unlinked, and still what the domain serves.
  expect((await set(b, { domain: "localhost", replace: true })).result.publishing).toMatchObject({
    state: "linked",
    version: null,
    serving: true,
  });
  expect(await publishing(a)).toMatchObject({ domain: null, state: "free", version: null });
  expect((await at("/"))[1]).toContain("<h1>Alpha</h1>");
  // Alpha can't publish there any more; Beta's publish replaces it.
  expect((await publish(a)).status).toBe(409);
  expect((await publish(b)).result.publishing.state).toBe("published");
  expect((await at("/"))[1]).toContain("<h1>Beta</h1>");
  // A document has one domain: Beta moves to the custom one, and the Erga domain is free at once.
  expect((await set(b, { domain: "site.test" })).result.publishing).toMatchObject({ domain: "site.test", state: "linked" });
  expect(await at("/")).toEqual([404, ""]);
  expect((await publishing(a)).domains.map((d: { document: { title: string } | null }) => d.document?.title ?? null)).toEqual([
    null,
    "Beta",
  ]);
});

test("the header bar: on at first on the Erga domain, changed at once with no publish, and never on a custom domain", async () => {
  const { make, set, publish, at } = await world();
  const a = await make("Alpha");
  expect((await set(a, { domain: "localhost" })).result.publishing.bars).toBe(true);
  const live = (await publish(a)).result.publishing;
  for (const path of ["/", "/about"]) expect((await at(path))[1], path).toContain("<erga-controls");
  const off = (await set(a, { bars: false })).result.publishing;
  expect(off).toMatchObject({ bars: false, state: "published", at: live.at, version: live.version });
  for (const path of ["/", "/about"]) {
    const [status, html] = await at(path);
    expect([path, status, html.includes("<erga-controls"), html.includes("padding-top")]).toEqual([path, 200, false, false]);
  }
  // A custom domain never has it.
  expect((await set(a, { domain: "site.test", bars: true })).error).toBe("The Erga header bar can only be shown on localhost.");
  expect((await set(a, { domain: "site.test" })).result.publishing.bars).toBe(false);
  expect((await set(a, { bars: true })).status).toBe(400);
});

test("only an admin changes the publishing; an editor sees it, a viewer doesn't; a deleted document frees its domain", async () => {
  const { s, make, set, publish, publishing, at } = await world();
  const a = await make("Alpha");
  await set(a, { domain: "localhost" });
  await publish(a);
  const bo = { user: "Bo" };
  await runTool(s, "share_document", { document: a, login: "bo", role: "viewer" });
  expect(await publishing(a, bo)).toBeUndefined();
  await runTool(s, "share_document", { document: a, login: "bo", role: "editor" });
  expect(await publishing(a, bo)).toMatchObject({ domain: "localhost", state: "published", canPublish: false });
  expect((await set(a, { domain: "" }, bo)).status).toBe(403);
  expect((await publish(a, bo)).status).toBe(403);
  // The editor's edit is not live until an admin publishes.
  expect((await runTool(s, "write", { document: a, files: { "index.html": page("By Bo") } }, bo)).error).toBeUndefined();
  expect((await at("/"))[1]).toContain("<h1>Alpha</h1>");
  await publish(a);
  expect((await at("/"))[1]).toContain("<h1>By Bo</h1>");
  expect((await runTool(s, "delete_document", { document: a })).error).toBeUndefined();
  expect(await at("/")).toEqual([404, ""]);
  expect((await s.platform.site("").status()).state).toBe("free");
});
