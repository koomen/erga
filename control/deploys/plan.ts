// A deploy's plan: where the new server answers and where documents' pages run, checked before anything is made.

/** Where the new server answers and where documents' pages run. */
export interface DeployPlan {
  accountId: string;
  /** The Worker's name ("erga"): also its workers.dev address, <name>.<subdomain>.workers.dev. */
  workerName: string;
  /** The account's workers.dev subdomain. */
  subdomain: string;
  /** The account has none yet: make `subdomain`. */
  createSubdomain?: boolean;
  /** The app's address: <name>.<subdomain>.workers.dev, or a hostname on one of the account's zones (a custom domain). */
  app: { kind: "workers.dev" } | { kind: "domain"; zoneId: string; zoneName: string; hostname: string };
  /**
   * Documents' pages: on a zone of their own, one origin per document
   * (<id>-<owner>.<zone>, a wildcard route and DNS record), as erga.dev does
   * on erga-pages.dev; or "shared", one origin for every document's pages at
   * <name>-pages.<subdomain>.workers.dev (workers.dev has no wildcards),
   * which keeps pages away from the app but not from each other.
   */
  pages: { kind: "shared" } | { kind: "zone"; zoneId: string; zoneName: string };
  /** The GitHub login deploying it: the new server's bootstrap admin (ADMINS). */
  admin: string;
  adminName?: string;
  /** A release of the store to install (12 hex digits), in place of stable's latest (trying edge, or an older one). */
  version?: string;
  /** Turns the agent on; optional. */
  anthropicKey?: string;
}

/** The database a /deploy server gets. */
export const DB_NAME = "erga";

export const appHost = (p: Pick<DeployPlan, "app" | "workerName" | "subdomain">) =>
  p.app.kind == "domain" ? p.app.hostname : `${p.workerName}.${p.subdomain}.workers.dev`;
/** The shared pages host on workers.dev (pages: "shared"). */
export const sharedPagesHost = (p: Pick<DeployPlan, "workerName" | "subdomain">) => `${p.workerName}-pages.${p.subdomain}.workers.dev`;
/** How the pages address reads on the page: a wildcard, or the shared host. */
export const pagesShown = (p: Pick<DeployPlan, "pages" | "workerName" | "subdomain">) =>
  p.pages.kind == "zone" ? `*.${p.pages.zoneName}` : sharedPagesHost(p);

/** What's wrong with a plan, for the person filling it in; null if nothing. */
export function checkPlan(p: DeployPlan): string | null {
  if (!/^[a-f0-9]{32}$/.test(p.accountId)) return "Choose a Cloudflare account.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(p.workerName)) return "The Worker's name is lowercase letters, digits and dashes.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(p.subdomain)) return "Your workers.dev subdomain is lowercase letters, digits and dashes.";
  if (p.app.kind == "domain") {
    const h = p.app.hostname.toLowerCase();
    if (!(h == p.app.zoneName || h.endsWith(`.${p.app.zoneName}`)) || !/^[a-z0-9.-]+$/.test(h)) return `The app's address must be ${p.app.zoneName} or a name under it.`;
  }
  if (p.pages.kind == "zone" && p.app.kind == "domain" && p.pages.zoneId == p.app.zoneId) {
    return `Documents' pages need a different domain from the app's (${p.app.zoneName}): a page's scripts mustn't share the app's site. Pick another domain, or the shared pages address.`;
  }
  if (!/^[A-Za-z0-9-]{1,39}$/.test(p.admin)) return "Sign in to Erga with GitHub first.";
  if (p.version != null && p.version != "" && !/^[0-9a-f]{12}$/.test(p.version)) return "A release's version is 12 hex digits, as the store lists it.";
  if (p.anthropicKey && !p.anthropicKey.trim().startsWith("sk-")) return "An Anthropic API key starts with sk-; leave it empty to deploy without the agent.";
  return null;
}
