// The homepage the server makes for itself on a fresh database (server/documents/landing.ts seedLanding).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { frameOf, front, get, landingSetting, setLanding, signedOut } from "./home";
import { runTool } from "../../helpers/tools";

// A fresh database, so a server of its own (a few seconds to start; more on a loaded machine).
const OWN_SERVER = { timeout: 60_000 };

test(
  "on a fresh server, the first / (eight at once) makes one homepage project, /_home, from assets/landing/ (its fonts too)",
  OWN_SERVER,
  async ({ tab }) => {
  const server = await tab.own({ env: { ERGA_HOME_RECHECK_MS: "0" } });
  const fronts = await Promise.all(
    Array.from({ length: 8 }, () => get(server, "/", { headers: signedOut(server) }).then((r) => r.text()))
  );
  const ids = new Set(fronts.map((f) => frameOf(f)?.[1]));
  expect([...ids]).toHaveLength(1);
  expect(ids.has(undefined)).toBe(false);
  // Every one of them at /_home: the seed that won the claim never ends up at home-2 (server/documents/landing.ts seedLanding).
  for (const f of fronts) expect(f).toContain('<meta name="erga-address" content="/_home">');
  const front = fronts[0];
  const id = frameOf(front)![1];
  expect(frameOf(front)![2]).toBe("_home");
  // On an admin's list once, a project called Erga Homepage.
  const list = await (await get(server, "/docs")).text();
  expect(list.match(/href="\/_home\?edit"/g)).toEqual(['href="/_home?edit"']);
  expect(list).toContain("Erga Homepage");
  expect(front).toContain("<title>Erga Homepage</title>");
  expect(front).toContain('href="/new?from=landing"');
  expect(await (await get(server, `/d/${id}/doc/index.html`)).text()).toBe(readFileSync(join(ROOT, "assets/landing/index.html"), "utf8"));
  // Its fonts and images too, byte for byte (assets/landing/ isn't only text).
  for (const rel of readdirSync(join(ROOT, "assets/landing"), { recursive: true }).map(String).filter((f) => /\.(woff2|png|jpe?g|webp|avif|gif)$/.test(f))) {
    const res = await get(server, `/d/${id}/doc/${rel}`);
    expect({ rel, status: res.status }).toEqual({ rel, status: 200 });
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(ROOT, "assets/landing", rel)))).toBe(true);
  }
  expect(await landingSetting(server)).toBe("/_home");
});

test(
  "a server's homepage from before the project (/<admin>/landing) becomes /_home: an admin opens it, its link and Edit; signed out, anyone views it",
  OWN_SERVER,
  async ({ tab }) => {
    // Pete's bug on production: after the adoption, koomen (an admin) got "Not shared with you" on /_home. The
    // document's own host still had its old owner, and decided on that.
    const server = await tab.own();
    const made = await runTool<{ id: string }>(server.root, "create_document", {
      files: { "index.html": "<!doctype html><title>Erga</title><h1>The old homepage</h1>" },
      slug: "landing",
    });
    expect(made.error).toBeUndefined();
    expect((await setLanding(server, made.result!.id)).error).toBeUndefined();
    // The first / adopts it (server/documents/landing.ts adoptLanding).
    await front(server);
    const admin = await get(server, "/_home");
    const page = await admin.text();
    expect({ status: admin.status, refused: page.includes("Not shared with you") }).toEqual({ status: 200, refused: false });
    expect(page).toContain('class="erga-view-button erga-edit-button"');
    // The home page link on /docs goes there.
    expect(await (await get(server, "/docs")).text()).toMatch(
      /class="erga-view-button erga-home-button"[^>]*href="\/_home"|href="\/_home"[^>]*class="erga-view-button erga-home-button"/
    );
    // Signed out, anyone views it.
    const out = await get(server, "/_home", { headers: signedOut(server) });
    expect({ status: out.status, old: (await out.text()).includes("The old homepage") }).toEqual({ status: 200, old: true });
    // The admin edits it, as the editor does: publishing a file into it.
    const wrote = await runTool(server.root, "write", {
      document: "/_home",
      files: { "index.html": "<!doctype html><title>Erga</title><h1>New</h1>" },
    });
    expect(wrote.error).toBeUndefined();
    expect(await (await get(server, `/d/${made.result!.id}/doc/index.html`)).text()).toContain("<h1>New</h1>");
  }
);
