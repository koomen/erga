// `bun erga setup <host> remove` of an instance on Cloudflare: what it deletes (the dry run says it), and the deletion.
// It deletes what setup made, and nothing else: the instance's Workers (their routes and the app's custom domain go
// with them), its database, its bucket when empty, and the wildcard DNS record of the documents' pages.
//
// Trap: Cloudflare deletes a Worker's routes with the Worker, but never a DNS record. The record of the pages
// (*.<pages domain>) stays unless this deletes it. Only a record as setup makes it is deleted (pipeline.ts,
// PAGES_RECORD: its type, its name and its content): a record that a person changed is that person's.

import type { CloudflareEntry } from "../cli/config";
import type { Cloudflare } from "../deployer/cloudflare-api";
import { findDatabase, zoneIdOf } from "../pipeline/account";
import { PAGES_RECORD } from "../pipeline/pipeline";
import { namesOf } from "./plan";

/** The name of the DNS record that setup made for the documents' pages, or null: the pages have the shared host. */
const pagesRecord = (entry: CloudflareEntry | null) =>
  entry?.pages.kind == "zone" ? `*.${entry.pages.domain ?? entry.pages.zoneName}` : null;

/** What the removal deletes, for the dry run (no --yes). `entry`: the host's entry, if it has one. */
export function removalText(host: string, entry: CloudflareEntry | null): string {
  const n = namesOf(host, entry);
  const record = pagesRecord(entry);
  return `This deletes ${host}: the Workers ${n.worker} and ${n.pagesWorker}, the database ${n.database} and the bucket ${n.bucket}, with every document on it${record ? `, and the DNS record ${record} that setup made for the documents' pages` : ""}.`;
}

/**
 * Deletes the instance. Each part by itself: one that fails is skipped with its reason, and the rest goes on, so a run
 * again deletes what is left. `done` and `skipped` say each part.
 */
export async function removeOnCloudflare(
  cf: Cloudflare,
  host: string,
  entry: CloudflareEntry,
  o: { done: (what: string) => void; skipped: (what: string, why: string) => void }
): Promise<void> {
  const n = namesOf(host, entry);
  const acc = `/accounts/${entry.account}`;
  const part = (what: string, f: () => Promise<unknown>) =>
    f().then(
      () => o.done(what),
      (e: Error) => o.skipped(what, e.message)
    );
  const domains =
    (await cf
      .call<{ id: string; hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${host}`, "read custom domains")
      .catch(() => [])) ?? [];
  for (const d of domains.filter((d) => d.service == n.worker))
    await part(`custom domain ${host} removed`, () => cf.call("DELETE", `${acc}/workers/domains/${d.id}`, "remove the custom domain"));
  for (const w of [n.pagesWorker, n.worker])
    await part(`Worker ${w} deleted`, () =>
      cf.call("DELETE", `${acc}/workers/scripts/${w}?force=true`, "delete the Worker", undefined, { allow404: true })
    );
  // After the Worker: its route on the pages' names is gone, and nothing answers there.
  const record = pagesRecord(entry);
  if (record && entry.pages.kind == "zone") {
    const pages = entry.pages;
    await part(`DNS record ${record} deleted (only the one that setup made)`, async () => {
      const zone = `/zones/${pages.zoneId ?? (await zoneIdOf(cf, entry.account, pages.zoneName))}`;
      const found =
        (await cf.call<{ id: string; type: string; name: string; content: string }[]>(
          "GET",
          `${zone}/dns_records?type=${PAGES_RECORD.type}&name=${encodeURIComponent(record)}`,
          `read ${pages.zoneName}'s DNS records`
        )) ?? [];
      const made = found.filter((r) => r.type == PAGES_RECORD.type && r.name == record && r.content == PAGES_RECORD.content);
      if (!made.length) throw new Error(found.length ? "the record there is not as setup made it: it stays" : "there is none");
      for (const r of made) await cf.call("DELETE", `${zone}/dns_records/${r.id}`, `delete the DNS record ${record}`);
    });
  }
  const db = await findDatabase(cf, acc, n.database).catch(() => null);
  if (db) await part(`database ${n.database} deleted`, () => cf.call("DELETE", `${acc}/d1/database/${db}`, "delete the database"));
  await part(`bucket ${n.bucket} deleted (only if empty)`, () =>
    cf.call("DELETE", `${acc}/r2/buckets/${n.bucket}`, "delete the bucket", undefined, { allow404: true })
  );
}
