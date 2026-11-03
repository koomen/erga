// Domains: each environment's custom domains on its Worker (the Ops page,
// deploys and set_domain), and domains through Cloudflare Registrar (the install page):
// search, check, register, and a registration's progress.
//
// Adding a domain is a guide (addDomain): a domain not on Cloudflare yet, name servers not moved yet, a name with a
// DNS record of its own, a name another Worker has; then the wait for its certificate (`live` in the view). A
// partial (CNAME) setup isn't offered: it needs Cloudflare's Business plan. A domain moves its name servers to
// Cloudflare (free), or comes from Cloudflare Registrar.

import { Cloudflare, DeployError } from "./cloudflare-api";
import type { BranchDeploys } from "./branches";
import type { DeployName } from "../../deploy/targets";

export interface DomainOffer {
  name: string;
  registrable: boolean;
  /** Why it can't be registered (Cloudflare's reason, in words). */
  reason?: string;
  currency?: string;
  /** What registering costs now, and each renewal. */
  price?: string;
  renewal?: string;
  premium?: boolean;
}

const REASONS: Record<string, string> = {
  domain_unavailable: "already taken",
  extension_not_supported_via_api: "this ending can't be registered through the API yet: use the Registrar page",
  extension_not_supported: "Cloudflare doesn't sell this ending",
  extension_disallows_registration: "this ending doesn't allow registration",
  domain_premium: "a premium domain: register it on Cloudflare's Registrar page",
};

/** Cloudflare Registrar's search: candidate names, each checked for availability and price (search alone isn't the source of truth). */
export async function searchDomains(cf: Cloudflare, accountId: string, q: string): Promise<DomainOffer[]> {
  const query = q.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,63}$/.test(query)) throw new DeployError({ message: "Search with letters, digits, dashes and dots only." });
  const found = (await cf.call<{ domains?: { name: string }[] } | { name: string }[]>("GET", `/accounts/${accountId}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=8`, "search for domains")) ?? [];
  const names = (Array.isArray(found) ? found : found.domains ?? []).map((d) => d.name).slice(0, 8);
  if (query.includes(".") && !names.includes(query)) names.unshift(query);
  return names.length ? checkDomains(cf, accountId, names.slice(0, 20)) : [];
}

/** Real-time availability and pricing (Registrar's check), for up to 20 names. */
export async function checkDomains(cf: Cloudflare, accountId: string, names: string[]): Promise<DomainOffer[]> {
  const answer = (await cf.call<{ domains?: RawCheck[] } | RawCheck[]>("POST", `/accounts/${accountId}/registrar/domain-check`, "check whether a domain is free", { domains: names })) ?? [];
  return (Array.isArray(answer) ? answer : answer.domains ?? []).map((d) => ({
    name: d.name, registrable: !!d.registrable, ...(d.reason ? { reason: REASONS[d.reason] ?? d.reason.replace(/_/g, " ") } : {}),
    ...(d.pricing ? { currency: d.pricing.currency, price: d.pricing.registration_cost, renewal: d.pricing.renewal_cost } : {}),
    ...(d.tier && d.tier != "standard" ? { premium: true } : {}),
  }));
}
interface RawCheck { name: string; registrable?: boolean; reason?: string; tier?: string; pricing?: { currency: string; registration_cost: string; renewal_cost: string } }

/**
 * Registers `name`, if it still costs exactly what the person confirmed
 * (`confirmed`: the price and currency they saw). Checks again first, as
 * Registrar asks, and refuses premium names (they need a fee acknowledgement
 * the API doesn't take yet). Answers the registration's state.
 */
export async function registerDomain(cf: Cloudflare, accountId: string, name: string, confirmed: { price: string; currency: string }): Promise<{ state: string; completed: boolean; error?: string }> {
  const [offer] = await checkDomains(cf, accountId, [name]);
  if (!offer?.registrable)
    throw new DeployError({ message: `${name} can't be registered now${offer?.reason ? `: ${offer.reason}` : ""}.` });
  if (offer.premium) throw new DeployError({ message: `${name} is a premium domain: register it on Cloudflare's Registrar page instead.` });
  if (offer.price != confirmed.price || offer.currency != confirmed.currency) {
    throw new DeployError({
      message: `${name} now costs ${offer.price} ${offer.currency}, not the ${confirmed.price} ${confirmed.currency} you confirmed. Nothing was bought: check the new price and confirm again.`,
    });
  }
  // One year, at the price shown (registration_cost is the first year's); auto-renew and WHOIS privacy keep Registrar's defaults (off, redaction).
  const r = await cf.call<Workflow>("POST", `/accounts/${accountId}/registrar/registrations`, `register ${name}`, { domain_name: name, years: 1 });
  return workflow(r);
}
interface Workflow { state: string; completed: boolean; error?: { code: string; message: string } }
const workflow = (r: Workflow | null) => ({ state: r?.state ?? "in_progress", completed: !!r?.completed, ...(r?.error ? { error: `${r.error.message} [${r.error.code}]` } : {}) });

/** Where a registration has got to. */
export async function registrationStatus(cf: Cloudflare, accountId: string, name: string): Promise<{ state: string; completed: boolean; error?: string }> {
  return workflow(await cf.call<Workflow>("GET", `/accounts/${accountId}/registrar/registrations/${encodeURIComponent(name)}/registration-status`, `check on ${name}'s registration`));
}

// ---- each environment's domains: its Worker's custom domains, through the credential (the operations deploys and set_domain).

/** One of an environment's domains: its own address (`primary`, the fleet's), or one added on the Ops page; the zone it's on, when known. */
export interface DomainEntry {
  hostname: string;
  primary: boolean;
  zone: string | null /** One added here: it answers (its certificate is there). */;
  live?: boolean;
}

/** What a domain needs before it can go on a Worker (the Ops page shows each as a step, with what to do). */
export type DomainNeed =
  /** Its domain isn't in the account: add it on Cloudflare (Add a site), or buy one there. */
  | { kind: "zone"; hostname: string; domain: string; accountId: string }
  /** Its domain is in the account, but the registrar still names other name servers: set these. */
  | { kind: "nameservers"; hostname: string; domain: string; nameservers: string[]; current: string[] }
  /** The name has DNS records of its own: Erga replaces them only when asked. */
  | { kind: "replace"; hostname: string; domain: string; records: { type: string; content: string }[] };
interface Zone {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
  original_name_servers?: string[];
}

/**
 * The domain a person registered, from a hostname: its last two labels, or three under a two-letter country's
 * second level (co.uk, com.au). A guess for the words on the page only: Cloudflare says which zone it is.
 */
export function domainOf(host: string): string {
  const labels = host.split(".");
  const n = labels.length > 2 && labels.at(-1)!.length == 2 && /^(co|com|net|org|ac|gov|edu|ne|or)$/.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-n).join(".");
}
/** deploys, view domains: each environment's domains. */
export interface DomainsView { targets: Partial<Record<DeployName, DomainEntry[]>> }

export class Domains {
  constructor(private deploys: BranchDeploys) {}

  /** Every environment's domains: its own address first (the fleet's: a deploy puts the Worker on it), then the others added here. */
  async domains(): Promise<DomainsView | { error: string; status?: number }> {
    const wrong = await this.deploys.deps.credential.status();
    if (wrong.problem) return { error: `Nothing can be read: ${wrong.problem}`, status: 409 };
    try {
      const cf = await this.deploys.cf();
      const acc = this.deploys.deps.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
      const all = (await cf.call<{ id: string; hostname: string; service: string; zone_name?: string; zone_id: string }[]>("GET", `/accounts/${acc}/workers/domains`, "read the account's custom domains")) ?? [];
      const targets: DomainsView["targets"] = {};
      for (const name of this.deploys.fleet.names) {
        const spec = this.deploys.specOf(name);
        const own: DomainEntry = { hostname: spec.host, primary: true, zone: all.find((d) => d.hostname == spec.host)?.zone_name ?? null };
        const more = await Promise.all(
          all
            .filter((d) => d.service == spec.worker && d.hostname != spec.host)
            .map(
              async (d): Promise<DomainEntry> => ({
                hostname: d.hostname,
                primary: false,
                zone: d.zone_name ?? null,
                live: await this.answers(d.hostname),
              })
            )
        );
        targets[name] = [own, ...more.sort((a, b) => (a.hostname < b.hostname ? -1 : 1))];
      }
      return { targets };
    } catch (e) {
      return { error: e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`, status: 502 };
    }
  }

  /**
   * A domain added to an environment, as a guide: each answer is the next step, said in place. The hostname's domain
   * isn't in the account (`need: zone`: add it on Cloudflare), its name servers haven't moved (`need: nameservers`:
   * the ones to set at the registrar), or the name has a DNS record of its own (`need: replace`: only with `replace`).
   * Else it goes on the Worker, and the view says when it answers (its certificate takes a minute or more).
   */
  async addDomain(
    name: string,
    hostname: string,
    by: string,
    o: { replace?: boolean } = {}
  ): Promise<DomainsView | { need: DomainNeed } | { error: string; status?: number }> {
    if (!this.deploys.fleet.has(name)) return { error: `There's no environment called ${name}.`, status: 404 };
    const host = hostname
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
      return { error: "A hostname looks like docs.example.com.", status: 400 };
    if (host.endsWith(".workers.dev"))
      return { error: "A workers.dev address comes with the Worker: add a domain of your own.", status: 400 };
    const spec = this.deploys.specOf(name);
    for (const other of this.deploys.fleet.names)
      if (this.deploys.specOf(other).host == host) return { error: `${host} is ${other}'s own address.`, status: 409 };
    const wrong = await this.deploys.deps.credential.status();
    if (wrong.problem) return { error: `Nothing can be changed: ${wrong.problem}`, status: 409 };
    try {
      const cf = await this.deploys.cf();
      const acc = this.deploys.deps.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
      const zones = (await cf.call<Zone[]>("GET", `/zones?account.id=${acc}&per_page=50`, "list the account's zones")) ?? [];
      const zone = zones.filter((z) => host == z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) return { need: { kind: "zone", hostname: host, domain: domainOf(host), accountId: acc } };
      if (zone.status != "active") {
        const z = await cf.call<Zone>("GET", `/zones/${zone.id}`, `read ${zone.name}`).catch(() => zone);
        return {
          need: {
            kind: "nameservers",
            hostname: host,
            domain: zone.name,
            nameservers: z?.name_servers ?? [],
            current: z?.original_name_servers ?? [],
          },
        };
      }
      const there =
        (await cf.call<{ hostname: string; service: string }[]>(
          "GET",
          `/accounts/${acc}/workers/domains?hostname=${encodeURIComponent(host)}`,
          `read ${host}'s custom domain`
        )) ?? [];
      const taken = there.find((d) => d.hostname == host && d.service != spec.worker);
      if (taken)
        return {
          error: `${host} is already the address of your Worker ${taken.service}. Remove it there (Workers › ${taken.service} › Domains), or choose another name.`,
          status: 409,
        };
      if (!o.replace) {
        const records =
          (await cf
            .call<{ type: string; name: string; content: string }[]>(
              "GET",
              `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`,
              `read ${host}'s DNS records`
            )
            .catch(() => [])) ?? [];
        if (records.length)
          return {
            need: {
              kind: "replace",
              hostname: host,
              domain: zone.name,
              records: records.map((r) => ({ type: r.type, content: r.content })),
            },
          };
      }
      await cf.call("PUT", `/accounts/${acc}/workers/domains`, `put ${spec.worker} on ${host}`, {
        hostname: host,
        service: spec.worker,
        zone_id: zone.id,
        environment: "production",
        ...(o.replace ? { override_existing_dns_record: true } : {}),
      });
      console.log(`domain ${host} added to ${name} (${spec.worker}) by ${by}`);
      this.deploys.deps.logged?.({ type: "domains" });
      const view = await this.domains();
      await this.tellHosts(view);
      return view;
    } catch (e) {
      return { error: e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`, status: 502 };
    }
  }

  /** Whether a domain added here answers yet: any answer from https://<host>/ (before its certificate, none). */
  private async answers(host: string): Promise<boolean> {
    const r = await this.deploys.deps.net(`https://${host}/api/health`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    return !!r;
  }

  /** An install: every host its environments answer at, told to upstream (the GitHub consent relay sends people back only to one of them). */
  private async tellHosts(view: DomainsView | { error: string }): Promise<void> {
    if ("error" in view || !this.deploys.deps.upstream?.hosts) return;
    const hosts = Object.values(view.targets).flat().map((d) => d.hostname);
    await this.deploys.deps.upstream.hosts(hosts).catch((e: Error) => console.log(`upstream wasn't told the hosts: ${e.message}`));
  }

  /** A domain taken off an environment's Worker (never its own address: a deploy would put it back, and the health check goes there). */
  async removeDomain(name: string, hostname: string, by: string): Promise<DomainsView | { error: string; status?: number }> {
    if (!this.deploys.fleet.has(name)) return { error: `There's no environment called ${name}.`, status: 404 };
    const host = hostname.trim().toLowerCase(),
      spec = this.deploys.specOf(name);
    if (host == spec.host) return { error: `${host} is ${name}'s own address: it stays.`, status: 409 };
    const wrong = await this.deploys.deps.credential.status();
    if (wrong.problem) return { error: `Nothing can be changed: ${wrong.problem}`, status: 409 };
    try {
      const cf = await this.deploys.cf();
      const acc = this.deploys.deps.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
      const there = (await cf.call<{ id: string; hostname: string; service: string }[]>("GET", `/accounts/${acc}/workers/domains?hostname=${encodeURIComponent(host)}`, `read ${host}'s custom domain`)) ?? [];
      const mine = there.find((d) => d.hostname == host && d.service == spec.worker);
      if (!mine) return { error: `${host} isn't one of ${name}'s domains.`, status: 404 };
      await cf.call("DELETE", `/accounts/${acc}/workers/domains/${mine.id}`, `take ${spec.worker} off ${host}`);
      console.log(`domain ${host} removed from ${name} (${spec.worker}) by ${by}`);
      this.deploys.deps.logged?.({ type: "domains" });
      const view = await this.domains();
      await this.tellHosts(view);
      return view;
    } catch (e) {
      return { error: e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`, status: 502 };
    }
  }
}
