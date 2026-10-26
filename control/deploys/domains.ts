// Domains through Cloudflare Registrar: search, check, register, and a registration's progress.

import { Cloudflare, DeployError } from "./cloudflare-api";

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
  if (!/^[a-z0-9.-]{1,63}$/.test(query)) throw new DeployError("Search with letters, digits, dashes and dots only.");
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
  if (!offer?.registrable) throw new DeployError(`${name} can't be registered now${offer?.reason ? `: ${offer.reason}` : ""}.`);
  if (offer.premium) throw new DeployError(`${name} is a premium domain: register it on Cloudflare's Registrar page instead.`);
  if (offer.price != confirmed.price || offer.currency != confirmed.currency) {
    throw new DeployError(`${name} now costs ${offer.price} ${offer.currency}, not the ${confirmed.price} ${confirmed.currency} you confirmed. Nothing was bought: check the new price and confirm again.`);
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
