// Publishing a document to a domain in the person's own Cloudflare account:
// the calls to Cloudflare and the site's files. rows.ts has the tables and
// the design; deploys.ts runs each document's deploys; api.ts is the API.
//
// A deploy, in their account, with their token (the Cloudflare API only):
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
// The token needs: Account Settings Read (its accounts), Workers Scripts Edit
// (the Worker and its files), Workers Routes Edit and Zone Read on the zones
// (the custom domain, the list of domains). tokenTemplateUrl fills in
// Cloudflare's "Create token" page with exactly these.
//
// An HTML page goes up as it is; a Markdown page goes up as HTML (the
// editor's own renderer, in a plain readable page). The page is also
// index.html, so the site's root shows it.

import { Cloudflare, DeployError, uploadAssets, type Fetch } from "../../deploy/pipeline.ts";
import type { Directory } from "../directory.ts";
import { checkHostname, scriptName, SiteError, type CfAccount, type CfZone, type SiteRow } from "./rows.ts";

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
  status(docId: string): Promise<SiteDeploy>;
  /** Deploys now (`by`: byLine). */
  deploy(docId: string, by: string): Promise<SiteDeploy>;
  /** Takes the site down in Cloudflare, with its person's token, and forgets its deploys. A message if Cloudflare refused, else null. */
  remove(docId: string, site: SiteRow): Promise<string | null>;
}

// ------------------------------------------------------------------ the token

/** The permissions a site needs, as Cloudflare's token template link takes them. */
export const SITE_PERMISSIONS = [
  { key: "account_settings", type: "read", label: "Account Settings: Read", why: "find your account" },
  { key: "workers_scripts", type: "edit", label: "Workers Scripts: Edit", why: "upload the site's files" },
  { key: "workers_routes", type: "edit", label: "Workers Routes: Edit", why: "put the site on your domain" },
  { key: "zone", type: "read", label: "Zone: Read", why: "list your domains" },
] as const;

/** Cloudflare's "Create API token" page, filled in with what a site needs, and nothing else. */
export function tokenTemplateUrl(): string {
  const keys = SITE_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify(keys))}&accountId=*&zoneId=all&name=${encodeURIComponent("Erga sites")}`;
}

/** Checks a token as pasted: that Cloudflare takes it, and the accounts it reaches. */
export async function verifyToken(token: string, net: Fetch): Promise<CfAccount[]> {
  const t = token.trim();
  if (!/^[\w.-]{20,2000}$/.test(t)) throw new SiteError("That doesn't look like a Cloudflare API token. Copy the whole token from the page Cloudflare showed after you made it.");
  const cf = new Cloudflare(t, net);
  const accounts = (await cf.call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50", "read your accounts")) ?? [];
  if (!accounts.length) throw new SiteError("Cloudflare took the token, but it reaches no account. Make it again with the link on this page: it needs Account Settings Read.");
  return accounts.map((a) => ({ id: a.id, name: a.name }));
}

/** The zones (domains) a token reaches, active ones first, each with its account. */
export async function listZones(token: string, net: Fetch, accounts: CfAccount[]): Promise<CfZone[]> {
  const cf = new Cloudflare(token, net);
  const zones = (await cf.call<{ id: string; name: string; status?: string; account?: { id: string; name?: string } }[]>("GET", "/zones?per_page=50", "list your domains")) ?? [];
  const fallback = accounts[0] ?? { id: "", name: "" };
  return zones
    .sort((a, b) => Number(b.status == "active") - Number(a.status == "active") || a.name.localeCompare(b.name))
    .map((z) => ({ id: z.id, name: z.name, account: z.account?.id ? { id: z.account.id, name: z.account.name ?? accounts.find((a) => a.id == z.account!.id)?.name ?? z.account.id } : fallback }));
}

// ------------------------------------------------------------------ the files

/** The site's files, by path ("/index.html"), from the published version's. */
export async function siteFiles(index: string, files: Record<string, string | Uint8Array>, title: string): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const bytes = (v: string | Uint8Array) => (typeof v == "string" ? new TextEncoder().encode(v) : v);
  const text = (v: string | Uint8Array) => (typeof v == "string" ? v : new TextDecoder().decode(v));
  let render: ((src: string, title: string) => string) | null = null;
  for (const [path, value] of Object.entries(files)) {
    if (path.endsWith(".md")) {
      render ??= await markdownPage();
      out[`/${path.slice(0, -3)}.html`] = bytes(render(text(value), path == index ? title : pageTitle(text(value)) ?? title));
    } else out[`/${path}`] = bytes(value);
  }
  const page = `/${index.replace(/\.md$/, ".html")}`;
  if (!out[page]) throw new SiteError(`The document's page (${index}) isn't in its published version.`);
  if (page != "/index.html") out["/index.html"] = out[page];
  return out;
}

const pageTitle = (src: string) => /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(src)?.[1]?.replace(/[*_`]/g, "") ?? null;
const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A Markdown page as a plain, readable HTML page: the editor's own renderer, loaded only when a site has one. */
async function markdownPage(): Promise<(src: string, title: string) => string> {
  const { analyzeMarkdown } = await import("../../client/markdown.ts");
  return (src, title) => {
    const body = analyzeMarkdown(src).html.replace(/ data-erga-id="\d+"/g, "").replace(/ class="erga-empty"/g, "");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
:root { color-scheme: light dark; --fg: #1d2129; --soft: #5b6472; --rule: #e3e6ea; --code: #f3f4f6; --link: #1f5f8b; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ee; --soft: #9aa3b0; --rule: #2b313a; --code: #1b2027; --link: #7fb6e0; } }
body { margin: 0; color: var(--fg); background: Canvas; font: 18px/1.65 Charter, "Iowan Old Style", Georgia, serif; }
main { max-width: 40rem; margin: 0 auto; padding: 12vh 22px 20vh; }
h1, h2, h3, h4 { font-family: system-ui, sans-serif; line-height: 1.25; letter-spacing: -0.01em; }
h1 { font-size: 2.1rem; margin: 0 0 1.2rem; }
a { color: var(--link); }
code, pre { font: 0.86em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); border-radius: 6px; }
code { padding: 0.1em 0.35em; }
pre { padding: 14px 16px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 1.2rem 0; padding: 0 1rem; border-left: 3px solid var(--rule); color: var(--soft); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.4rem 0; }
table { border-collapse: collapse; } td, th { border: 1px solid var(--rule); padding: 6px 10px; }
img { max-width: 100%; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  };
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
  const info = await dir.cloudflare.info(login);
  const token = await dir.cloudflare.token(login);
  if (!token) return { error: info.unreadable ? "Your Cloudflare token doesn't open on this server. Connect again on /settings." : "Connect your Cloudflare account first, on /settings." };
  try { return { zones: await listZones(token, ops.net(token), info.accounts) }; } catch (e) {
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
