// Publishing a document to a domain in the person's own Cloudflare account:
// the calls to Cloudflare and the site's files. rows.ts has the tables and
// the design; deploys.ts runs each document's deploys; api.ts is the API.
//
// A deploy, in their account, with their grant (the Cloudflare API only):
//
//   1. the published version's files go up as a Worker's static assets
//      (direct upload: only files Cloudflare doesn't have yet are sent);
//   2. the Worker itself goes up: a few lines that hand every request to
//      those files, so a request for a file never runs it (free, and no
//      limit on requests);
//   3. the Worker gets the hostname as a custom domain: Cloudflare makes the
//      DNS record and the certificate (a hostname with a DNS record of its
//      own already is refused, and the message says so).
//
// The grant (a consent in the browser, connect.ts) asks for SITE_OAUTH_SCOPES
// only, a part of the scopes Erga's OAuth client allows.
//
// The files go up as they are. The document's page is also index.html, so
// the site's root shows it.

import { Cloudflare, DeployError, explain, uploadAssets, type Fetch } from "../../deploy/pipeline.ts";
import type { Directory } from "../directory/index.ts";
import { checkHostname, scriptName, SITE_NEEDS, SITE_OAUTH_SCOPES, SiteError, type CfAccount, type CfZone, type SiteOAuth, type SiteRow } from "./rows.ts";

export { SITE_NEEDS, SITE_OAUTH_SCOPES };

/** A site's deploys, as the API gives them. */
export interface SiteDeploy {
  state: "idle" | "scheduled" | "deploying" | "deployed" | "failed";
  /** The last good deploy (ISO time). */
  at: string | null;
  scheduledFor: string | null;
  /** The published version that's live there. */
  version: number | null;
  error: string | null;
  /** Who asked for the latest deploy (byLine), or the system (after a publish). */
  by: string | null;
}
export const IDLE_SITE: SiteDeploy = { state: "idle", at: null, scheduledFor: null, version: null, error: null, by: null };

/** What the API needs of the deploys, and of Cloudflare. */
export interface SiteOps {
  /** How to reach Cloudflare with this token: the real API, or (local development) a pretend one. */
  net(token: string): Fetch;
  /** Cloudflare's OAuth, for the consent, and to refresh and revoke the grants. */
  oauth: SiteOAuth;
  status(docId: string): Promise<SiteDeploy>;
  /** Deploys now (`by`: byLine). */
  deploy(docId: string, by: string): Promise<SiteDeploy>;
  /** Takes the site down in Cloudflare, with its person's token, and forgets its deploys. A message if Cloudflare refused, else null. */
  remove(docId: string, site: SiteRow): Promise<string | null>;
}

// ------------------------------------------------------------------ the grant

/** Cloudflare's API with a person's grant: a refusal says to connect again, not to make a token. */
export function siteCloudflare(token: string, net: Fetch): Cloudflare {
  return new Cloudflare(token, net, (what, status, errors) => {
    const said = errors.map((e) => (e.code ? `${e.message} [code ${e.code}]` : e.message)).filter(Boolean).join("; ");
    const tail = said ? ` (Cloudflare said: ${said})` : "";
    if (status == 401 || errors.some((e) => e.code == 1000 || e.code == 9109 || e.code == 6003)) return `Cloudflare didn't accept your connection when Erga tried to ${what}: it may be revoked. Connect Cloudflare again.${tail}`;
    if (status == 403 || errors.some((e) => e.code == 10000 || e.code == 9103)) return `Your Cloudflare connection isn't allowed to ${what}. Connect Cloudflare again, and allow everything Erga asks for.${tail}`;
    return explain(what, status, errors);
  });
}

/** The accounts a token reaches. */
export async function listAccounts(token: string, net: Fetch): Promise<CfAccount[]> {
  const accounts = (await siteCloudflare(token, net).call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50", "read your accounts")) ?? [];
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

/** The zones (domains) a token reaches, active ones first, each with its account. */
export async function listZones(token: string, net: Fetch, accounts: CfAccount[]): Promise<CfZone[]> {
  const cf = siteCloudflare(token, net);
  const zones = (await cf.call<{ id: string; name: string; status?: string; account?: { id: string; name?: string } }[]>("GET", "/zones?per_page=50", "list your domains")) ?? [];
  const fallback = accounts[0] ?? { id: "", name: "" };
  return zones
    .sort((a, b) => Number(b.status == "active") - Number(a.status == "active") || a.name.localeCompare(b.name))
    .map((z) => ({ id: z.id, name: z.name, account: z.account?.id ? { id: z.account.id, name: z.account.name ?? accounts.find((a) => a.id == z.account!.id)?.name ?? z.account.id } : fallback }));
}

// ------------------------------------------------------------------ the files

/** The site's files, by path ("/index.html"), from the published version's. */
export function siteFiles(index: string, files: Record<string, string | Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(files)) out[`/${path}`] = typeof value == "string" ? new TextEncoder().encode(value) : value;
  const page = `/${index}`;
  if (!out[page]) throw new SiteError(`The document's page (${index}) isn't in its published version.`);
  if (page != "/index.html") out["/index.html"] = out[page];
  return out;
}

// ------------------------------------------------------------------ deploying

/** The Worker that serves the site: every request goes to its files (it runs only for a path that isn't one). */
const SITE_WORKER = (origin: string) => `// A site published from Erga (${origin}). Erga replaces these files each time the document is published.
export default { fetch: (request, env) => env.ASSETS.fetch(request) };
`;
const SITE_TAG = "erga-site";

/** Puts a site's files up in its account, on its hostname: the site's URL. */
export async function deploySite(cf: Cloudflare, site: SiteRow, files: Record<string, Uint8Array>, origin: string): Promise<string> {
  const acc = `/accounts/${site.accountId}`;
  const jwt = await uploadAssets(cf, acc, site.script, files, "the site's files");
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({
    main_module: "site.js",
    compatibility_date: "2026-09-30",
    bindings: [{ type: "assets", name: "ASSETS" }],
    assets: { jwt, config: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" } },
    tags: [SITE_TAG],
  })], { type: "application/json" }));
  form.append("site.js", new File([SITE_WORKER(origin)], "site.js", { type: "application/javascript+module" }));
  await cf.call("PUT", `${acc}/workers/scripts/${site.script}`, "upload the site's Worker", form);
  const there = (await cf.call<{ hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${encodeURIComponent(site.hostname)}`, `read ${site.hostname}'s custom domain`).catch(() => null)) ?? [];
  if (!there.some((d) => d.hostname == site.hostname && d.service == site.script)) {
    try {
      await cf.call("PUT", `${acc}/workers/domains`, `put the site on ${site.hostname}`, { environment: "production", hostname: site.hostname, service: site.script, zone_id: site.zoneId });
    } catch (e) {
      if (e instanceof DeployError && /externally managed DNS|100117/.test(e.message)) {
        throw new SiteError(`${site.hostname} already has a DNS record in Cloudflare, so it can't show the site. Delete that record in Cloudflare (DNS, for ${site.zoneName}), or choose another name, then deploy again.`, 409);
      }
      if (e instanceof DeployError && /already in use by another Worker|100116/.test(e.message)) {
        throw new SiteError(`${site.hostname} is already on another Worker in your account. Take it off that Worker in Cloudflare, or choose another name.`, 409);
      }
      throw e;
    }
  }
  return `https://${site.hostname}/`;
}

/** Takes a site down: its custom domain, then its Worker (with its files). What's already gone is fine. */
export async function removeSite(cf: Cloudflare, site: SiteRow): Promise<void> {
  const acc = `/accounts/${site.accountId}`;
  const domains = (await cf.call<{ id: string; hostname: string; service: string }[]>("GET", `${acc}/workers/domains?hostname=${encodeURIComponent(site.hostname)}`, `read ${site.hostname}'s custom domain`)) ?? [];
  for (const d of domains.filter((x) => x.hostname == site.hostname && x.service == site.script)) {
    await cf.call("DELETE", `${acc}/workers/domains/${d.id}`, `take the site off ${site.hostname}`, undefined, { allow404: true });
  }
  await cf.call("DELETE", `${acc}/workers/scripts/${site.script}?force=true`, "delete the site's Worker", undefined, { allow404: true });
}

/** The Worker's page in Cloudflare's dashboard, for the person to look at what Erga made. */
export const dashboardUrl = (site: SiteRow) => `https://dash.cloudflare.com/${site.accountId}/workers/services/view/${site.script}/production`;

/** The domains someone's connection reaches; or why there are none to show. */
export async function zonesOf(dir: Directory, ops: SiteOps, login: string): Promise<{ zones: CfZone[] } | { error: string }> {
  try {
    const info = await dir.cloudflare.info(login);
    const token = await dir.cloudflare.token(login, ops.oauth);
    if (!token) return { error: info.unreadable ? "Your Cloudflare connection doesn't open on this server. Connect Cloudflare again." : "Connect Cloudflare first." };
    return { zones: await listZones(token, ops.net(token), info.accounts) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Records a document's site at `hostname`, on `login`'s connection (the deploy is the caller's). */
export async function publishTo(dir: Directory, ops: SiteOps, doc: { id: string; slug: string }, login: string, typed: string, via?: string | null): Promise<SiteRow> {
  const r = await zonesOf(dir, ops, login);
  if ("error" in r) throw new SiteError(r.error, 409);
  const { hostname, zone } = checkHostname(typed, r.zones);
  return dir.sites.add({ docId: doc.id, hostname, zoneId: zone.id, zoneName: zone.name, accountId: zone.account.id, script: scriptName(doc.id, doc.slug), login }, via);
}

/** A site as the API shows it. */
export const siteView = (site: SiteRow) => ({ hostname: site.hostname, url: `https://${site.hostname}/`, zone: site.zoneName, by: site.login, created: new Date(site.created).toISOString(), dashboard: dashboardUrl(site) });
