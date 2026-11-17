// The app's health check (server/health.ts): what it checks, and how it says what's wrong. And the server's scheduled
// run (tick): the report goes into the one row of `health`, where the ops tool reads it with the same statement
// through the platform's database API (deploy/pipeline/account.ts), and the default homepage is made.

import { expect, test } from "bun:test";
import { Directory } from "../server/directory";
import { readHealth } from "../deploy/pipeline/account";
import { health, tick } from "../server/health";
import type { Platform } from "../server/platform";
import { server, signedOut } from "./helpers/app";
import { memory } from "./helpers/memory-sql";

function directory(): Directory {
  const sql = memory();
  return new Directory(sql, { admins: ["ada"] });
}

/** `linked`: the document linked to the Erga domain. */
const platform = (dir: Directory, exists: (id: string) => Promise<boolean>, linked: string | null = null): Platform =>
  ({
    directory: dir,
    deploy: { version: "abcdef123456", primary: null },
    site: () => ({ status: async () => ({ doc: linked }) }),
    docs: { index: async (doc: { id: string }) => ((await exists(doc.id)) ? "index.html" : null) },
} as unknown as Platform);

test("healthy: the database answers and the Erga domain's document opens; with none linked, nothing to open and still healthy", async () => {
  const dir = directory();
  let h = await health(platform(dir, async () => true));
  expect(h).toMatchObject({
    ok: true,
    version: "abcdef123456",
    checks: { db: { ok: true }, documents: { ok: true, note: "no document is linked to the Erga domain: nothing to open" } },
  });
  expect(h.checks.db.ms).toBeGreaterThanOrEqual(0);
  const { doc } = await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Home", created: 1 });
  const opened: string[] = [];
  h = await health(
    platform(
      dir,
      async (id) => {
        opened.push(id);
        return true;
      },
      doc.id
    )
  );
  expect(h.ok).toBe(true);
  expect(h.checks.documents).toMatchObject({ ok: true });
  expect(opened).toEqual([doc.id]);
});

test("unhealthy: a document that doesn't open, or a database that throws, fails its check and the report, with the reason", async () => {
  const dir = directory();
  const { doc } = await dir.add({ id: "aaaaaaaa", owner: "ada", title: "Home", created: 1 });
  let h = await health(platform(dir, async () => false, doc.id));
  expect(h).toMatchObject({
    ok: false,
    checks: { db: { ok: true }, documents: { ok: false, error: `the Erga domain's document ${doc.id} has no host` } },
  });
  h = await health(
    platform(
      dir,
      async () => {
        throw new Error("Durable Object reset");
      },
      doc.id
    )
  );
  expect(h.checks.documents).toMatchObject({ ok: false, error: "Durable Object reset" });
  const broken = {
    ...platform(dir, async () => true),
    directory: {
      ...dir,
      config: {
        get: async () => {
          throw new Error("D1_ERROR: no such table: server_config");
        },
      },
      route: (id: string) => dir.route(id),
    },
  } as unknown as Platform;
  h = await health(broken);
  expect(h.ok).toBe(false);
  expect(h.checks.db).toMatchObject({ ok: false, error: "D1_ERROR: no such table: server_config" });
});

test("the scheduled run: the report goes into the one health row, which the ops tool's own statement reads; the first run makes the homepage", async () => {
  const s = server();
  // The statement that the ops tool sends to the database's API (deploy/pipeline/account.ts, healthRow).
  const row = async () => {
    const [r] = await s.sql.all<{ at: number; version: string | null; ok: number; checks: string }>(
      "SELECT at, version, ok, checks FROM health WHERE id = 1"
    );
    return r ? { at: r.at, version: r.version, ok: !!r.ok, checks: JSON.parse(r.checks) } : null;
  };
  expect(await row()).toBeNull();
  expect((await s.fetch("/", { headers: signedOut() })).status).toBe(404);
  const report = await tick(s.platform, 1_800_000_000_000);
  expect(report.ok).toBe(true);
  expect(await row()).toMatchObject({
    at: 1_800_000_000_000,
    version: null,
    ok: true,
    checks: { db: { ok: true }, documents: { ok: true } },
  });
  expect(readHealth(await row(), null, 1_800_000_030_000).healthy).toBe(true);
  // No request asked for the default homepage: the run made it, and published it.
  expect((await s.platform.directory.find("/_home"))?.id).toBeTruthy();
  // The next minute: the same row, with the new time. The homepage is there: nothing is made again.
  await tick(s.platform, 1_800_000_060_000);
  expect((await s.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM health"))[0].n).toBe(1);
  expect((await row())?.at).toBe(1_800_000_060_000);
});
