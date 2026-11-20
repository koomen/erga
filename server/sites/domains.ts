// The domains a document can be published to: the Erga domain (the server's own, always) and the custom domains the
// deploy registered (`bun erga deploy <host> --domain <domain>`: Platform's deploy.domains). Each has one site object
// (publishing.ts), named by its key.

import type { Platform } from "../platform.ts";
import type { SiteStatus } from "./state.ts";

/** The Erga domain's key. Not its host: a server whose address changes keeps what it published there. */
export const ERGA = "";

/** Every domain's key: the Erga domain first, then the deploy's. */
export const domainsOf = (platform: Platform): string[] => [ERGA, ...platform.deploy.domains];

/** The domain a request came to. */
export const domainOf = (platform: Platform, url: URL): string => (platform.deploy.domains.includes(url.hostname) ? url.hostname : ERGA);

/** The Erga domain's name as people see it: the host the app answers at (`origin`), else the deploy's. */
export const ergaName = (platform: Platform, origin?: string): string => (origin ? new URL(origin).host : (platform.deploy.app ?? "erga"));

/** A domain's name as people see it; `erga`: the Erga domain's (ergaName). */
export const domainName = (domain: string, erga: string): string => (domain == ERGA ? erga : domain);

/** The domain a name means (as domainName gives it), or null if the server has no such domain. */
export function domainNamed(platform: Platform, erga: string, name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n == erga || n == erga.replace(/:\d+$/, "")) return ERGA;
  return platform.deploy.domains.includes(n) ? n : null;
}

/** Every domain with its state now, the Erga domain first. */
export async function sitesOf(platform: Platform): Promise<{ domain: string; status: SiteStatus }[]> {
  const domains = domainsOf(platform);
  const statuses = await Promise.all(domains.map((d) => platform.site(d).status()));
  return domains.map((domain, i) => ({ domain, status: statuses[i] }));
}

/**
 * The server's scheduled run, for the custom domains that a deploy removed (`bun erga deploy <host> --remove-domain
 * <domain>` writes each into `removed_domains`, after its deploy): the document that is published to one is
 * unpublished, and its snapshot goes. A domain that the server has again keeps its document. Each row goes after.
 * Only a domain's name: never the Erga domain's key, or its object's name.
 */
export async function unpublishRemoved(platform: Platform): Promise<void> {
  for (const domain of await platform.directory.removedDomains()) {
    if (domain.includes(".") && !platform.deploy.domains.includes(domain)) {
      const site = platform.site(domain);
      const { doc } = await site.status();
      if (doc) await site.unlink(doc);
    }
    await platform.directory.forgetRemovedDomain(domain);
  }
}
