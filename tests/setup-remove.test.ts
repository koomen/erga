// `bun erga setup <host> remove` on Cloudflare (deploy/own/remove.ts), against the mock Cloudflare: it deletes what
// setup made, and with it the wildcard DNS record of the documents' pages, which Cloudflare keeps when the Worker goes.
// Only the record as setup made it: one that a person changed stays. The dry run (no --yes) names the record.

import { beforeAll, expect, test } from "bun:test";
import { type CloudflareEntry, DEFAULT_REPO } from "../deploy/cli/config";
import { Cloudflare } from "../deploy/deployer/cloudflare-api";
import { removalText, removeOnCloudflare } from "../deploy/own/remove";
import { targetFacts } from "../deploy/pipeline/pipeline";
import { mockCloudflare } from "../dev/mock-cloudflare";
import { deployTo, fleet, prepareRelease } from "./helpers/deploys.ts";

beforeAll(prepareRelease, 120_000);

const entry: CloudflareEntry = { host: "example.com", repo: DEFAULT_REPO, branch: "main", ...targetFacts(fleet()) };
const RECORD = "DNS record *.example-pages.com deleted (only the one that setup made)";

/** The instance as setup and a deploy made it, and its removal's parts as they went. */
async function deployed() {
  const mock = mockCloudflare({ fleet: true });
  await deployTo(fleet(), mock);
  const zone = mock.state.zones.find((z) => z.name == "example-pages.com")!.id;
  const remove = async () => {
    const parts: string[] = [];
    await removeOnCloudflare(new Cloudflare("mock-machine-token", mock.fetch), "example.com", entry, {
      done: (what) => parts.push(what),
      skipped: (what, why) => parts.push(`SKIP ${what}: ${why}`),
    });
    return parts;
  };
  return { mock, zone, remove, records: () => mock.state.dns[zone].map((r) => `${r.type} ${r.name} ${r.content}`) };
}

test("the dry run names the pages' DNS record, when setup made one", () => {
  expect(removalText("example.com", entry)).toBe(
    "This deletes example.com: the Workers erga and erga-pages, the database erga and the bucket erga-files, with every document on it, and the DNS record *.example-pages.com that setup made for the documents' pages."
  );
  // Pages on the shared host have no record; and a host with no entry yet has its names only.
  expect(removalText("example.com", { ...entry, pages: { kind: "shared" } })).not.toContain("DNS record");
  expect(removalText("erga.example.org", null)).toBe(
    "This deletes erga.example.org: the Workers erga-example-org and erga-example-org-pages, the database erga-example-org and the bucket erga-example-org-files, with every document on it."
  );
});

test("the removal deletes the pages' wildcard record with the Worker; a run again finds none", async () => {
  const { mock, zone, remove, records } = await deployed();
  // Another record of the zone, which setup did not make.
  mock.state.dns[zone].push({ id: "a".repeat(32), type: "AAAA", name: "www.example-pages.com", content: "100::", proxied: true });
  expect(records()).toContain("AAAA *.example-pages.com 100::");
  const parts = await remove();
  expect(parts).toEqual(
    expect.arrayContaining(["custom domain example.com removed", "Worker erga deleted", RECORD, "database erga deleted"])
  );
  expect(records()).toEqual(["AAAA www.example-pages.com 100::"]);
  expect(mock.state.scripts.erga).toBeUndefined();
  expect(await remove()).toContain(`SKIP ${RECORD}: there is none`);
}, 60_000);

test("a record that is not as setup made it stays", async () => {
  const { mock, zone, remove, records } = await deployed();
  mock.state.dns[zone].find((r) => r.name == "*.example-pages.com")!.content = "2001:db8::1";
  expect(await remove()).toContain(`SKIP ${RECORD}: the record there is not as setup made it: it stays`);
  expect(records()).toEqual(["AAAA *.example-pages.com 2001:db8::1"]);
}, 60_000);
