// The homepage the server makes for itself on a fresh database (server/documents/landing.ts seedLanding).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../../helpers/fixtures";
import { ROOT } from "../../helpers/env";
import { frameOf, get, landingSetting, signedOut } from "./home";

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
