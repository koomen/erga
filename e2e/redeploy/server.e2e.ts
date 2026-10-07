// Open pages across a redeploy, the server's side: GET /api/release, each page's build and the
// X-Erga-Check answer, and nothing of the site's in a document's own HTML (worker/live.ts).
import { expect, servers, test } from "../fixtures";
import { longDoc } from "./pages";

await servers.main();

test("GET /api/release: each client file's build, and the release", async () => {
  const s = await servers.main();
  const release = await (await fetch(`${s.root}/api/release`)).json() as { files: Record<string, string>; version: string };
  expect(release.files["page.js"]).toHaveLength(16);
  expect(release.files["live.js"]).toBeTruthy();
  expect(release.files["editor.html"]).toBeTruthy();
  expect(release.version).toBeTruthy();
});

test("a page of the site's own carries its build and live.js, and asked with X-Erga-Check answers its build alone", async () => {
  const s = await servers.main();
  const html = await (await fetch(`${s.root}/docs`)).text();
  const build = /<meta name="erga-build" content="(\w+)">/.exec(html)?.[1];
  expect(build).toBeTruthy();
  expect(html).toContain('<script src="/live.js" defer></script>');
  const asked = await fetch(`${s.root}/docs`, { headers: { "X-Erga-Check": "build" } });
  expect(asked.status).toBe(204);
  expect(asked.headers.get("x-erga-build")).toBe(build!);
});

test("a document's own HTML gets nothing of the site's", async () => {
  const s = await servers.main();
  const doc = await longDoc(s);
  const info = await (await fetch(`${doc.address}/api/doc`)).json() as { docName?: { id: string } };
  const own = await (await fetch(`${s.root}/d/${info.docName?.id ?? doc.address.split("/").pop()}/doc/index.html`)).text();
  expect(own).toContain("A long page");
  expect(own).not.toContain("live.js");
  expect(own).not.toContain("erga-build");
});
