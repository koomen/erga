// `bun erga deploy <host> --remove-domain <domain>`: a custom domain leaves an instance on Cloudflare (deploy.ts runs
// these, in this order):
//
// 1. Cloudflare: the Worker's custom domain is deleted. From then on, nothing answers at the domain.
// 2. The instance: a deploy with the domain off its custom domains (the Worker's deploy facts, and its spec).
// 3. .erga/config.json: the domain leaves the entry.
// 4. The server: a row in `removed_domains`, through D1's API. The server's scheduled run unpublishes the document that
//    is published to the domain (server/sites/domains.ts): only the server reaches a domain's publishing.
//
// --dry-run says these, with what Cloudflare has now, and changes nothing. A run that stops goes on when it runs again:
// the domain is in the entry until step 3.

import { boundDatabase, d1 } from "../deployer/cloudflare";
import { Cloudflare, type Fetch } from "../deployer/cloudflare-api";
import { type CloudflareEntry, entryOf, isAws, readConfig } from "./config";

/** The entry of `host`, and the domains in lower case: an error when one of them is not a custom domain of the instance. */
export function removalOf(dir: string, host: string, domains: readonly string[]): { entry: CloudflareEntry; domains: string[] } {
  const entry = entryOf(readConfig(dir), host);
  if (!entry) throw new Error(`${host} has no entry in .erga/config.json. Register it first: bun erga register ${host}`);
  if (isAws(entry)) throw new Error(`${host} is on AWS: --remove-domain is only for an instance on Cloudflare.`);
  const has = entry.domains ?? [];
  const names = [...new Set(domains.map((d) => d.toLowerCase()))];
  for (const d of names)
    if (!has.includes(d)) throw new Error(`${d} is not a custom domain of ${host}. Its custom domains: ${has.join(", ") || "none"}.`);
  return { entry, domains: names };
}

/** The entry with `domains` off its custom domains. */
export function withoutDomains(entry: CloudflareEntry, domains: readonly string[]): CloudflareEntry {
  const { domains: has, ...rest } = entry;
  const kept = (has ?? []).filter((d) => !domains.includes(d));
  return { ...rest, ...(kept.length ? { domains: kept } : {}) };
}

/** Cloudflare's custom domain of that name in the account: its id, and the Worker that it is on. null: there is none. */
async function customDomain(cf: Cloudflare, account: string, hostname: string): Promise<{ id: string; service: string } | null> {
  const found = await cf.call<{ id: string; hostname: string; service: string }[]>(
    "GET",
    `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
    `read ${hostname}'s custom domain`
  );
  return found?.find((d) => d.hostname == hostname) ?? null;
}

/** What the removal does on Cloudflare for one domain, by what is there now: a line, and the custom domain to delete (or null). */
async function onCloudflare(cf: Cloudflare, entry: CloudflareEntry, domain: string): Promise<{ id: string | null; says: string }> {
  const there = await customDomain(cf, entry.account, domain);
  if (!there) return { id: null, says: `Cloudflare has no custom domain ${domain}: there is nothing to delete there` };
  if (there.service != entry.worker)
    return { id: null, says: `on Cloudflare, ${domain} is the address of another Worker (${there.service}): it stays there` };
  return {
    id: there.id,
    says: `the custom domain ${domain} of the Worker ${entry.worker} is deleted on Cloudflare: nothing answers at https://${domain} after`,
  };
}

/** --dry-run: what the removal does, with what Cloudflare has now. It changes nothing. */
export async function removalPlan(o: {
  dir: string;
  host: string;
  domains: readonly string[];
  net?: Fetch;
  token?: string;
}): Promise<string[]> {
  const { entry, domains } = removalOf(o.dir, o.host, o.domains);
  const { netOf } = await import("./deploy");
  const { net, token } = await netOf(o);
  const cf = new Cloudflare(token, net);
  const lines = [`A dry run: nothing changes. bun erga deploy ${o.host}${domains.map((d) => ` --remove-domain ${d}`).join("")} does this:`];
  for (const d of domains) {
    lines.push(
      `  ${d}:`,
      `    1. ${(await onCloudflare(cf, entry, d)).says.replace(/^./, (c) => c.toUpperCase())}.`,
      `    2. The instance: a deploy of ${entry.branch}'s head takes ${d} off its custom domains (the Worker's deploy facts, and its spec).`,
      `    3. .erga/config.json: ${d} leaves ${o.host}'s entry.`,
      `    4. The server: it unpublishes the document that is published to ${d}, within a minute of the deploy.`
    );
  }
  lines.push("  It keeps each document, and each zone on Cloudflare.");
  return lines;
}

/** Step 1: deletes the Worker's custom domain on Cloudflare, when it is this Worker's. */
export async function detach(cf: Cloudflare, entry: CloudflareEntry, domain: string, log: (line: string) => void): Promise<void> {
  log(`Remove the custom domain ${domain} from Cloudflare...`);
  const { id, says } = await onCloudflare(cf, entry, domain);
  if (id) await cf.call("DELETE", `/accounts/${entry.account}/workers/domains/${id}`, `delete the custom domain ${domain}`);
  log(`Remove the custom domain ${domain} from Cloudflare: done, ${says}`);
}

/** Step 4: the rows that tell the server to unpublish the documents that are published to `domains`. `at`: now, in ms. */
export async function askUnpublish(
  cf: Cloudflare,
  entry: CloudflareEntry,
  domains: readonly string[],
  at: number,
  log: (line: string) => void
): Promise<void> {
  const acc = `/accounts/${entry.account}`;
  const db = await boundDatabase(cf, acc, entry.worker);
  try {
    if (!db) throw new Error("no such table: the Worker has no database");
    for (const d of domains)
      await d1(
        cf,
        acc,
        db,
        "INSERT OR REPLACE INTO removed_domains (domain, at) VALUES (?1, ?2)",
        [d, at],
        `tell the server that ${d} is removed`
      );
    log(`The server unpublishes the document that is published to ${domains.join(", ")} at its next scheduled run, within a minute.`);
  } catch (e) {
    if (!/no such table/.test((e as Error).message)) throw e;
    log(
      `NOTE  The release that ${entry.host} runs has no table for removed domains: a document that was published to ${domains.join(", ")} keeps its link, and nothing serves it.`
    );
  }
}
