// Erga's side of the gate (gate/core.ts): the one check in front of every request. The gate says who calls, in a
// header that it always writes itself (the caller); Erga decides what that caller may do (admit.ts), and asks the gate
// for the few things only the gate does (it alone signs): an agent's code or token, and sign-out.
//
// Where the gate runs is the deploy's choice (mode.ts): inside this Worker, as its first call (mount.ts), or in front
// of it. Erga's code is the same in both: it reads the caller here, and answers with the header that asks the gate.
//
// Trap: the caller's header counts only because nothing reaches the app but through the gate. cloudflare/index.ts
// passes every request through `gated` (mount.ts), and nothing else may call the app with an outside request.
// Trap: the gate's settings (gateConfig) read the database only on the sign-in's callback. Each request passes here
// before the app, and a new server's first ones come before its database has a table (cloudflare/dev.ts,
// /__erga/migrate): a read on every path stops them all.

import { ASK, CALLBACK, type Caller, type Config, HEALTH, type Identity, SIGN_IN, signInCookies } from "../../gate/core.ts";
import { webPort } from "../../gate/port.ts";
import { readCaller } from "../../gate/mounts/web.ts";
import { HttpServerResponse } from "effect/http";
import { isLocal } from "../../shared/http.ts";
import { SIGN_IN_PROVIDERS, SSO } from "../../shared/sign-in.ts";
import type { Vouched } from "../directory/index.ts";
import type { Platform } from "../platform.ts";
import { GRANT_DAYS } from "./grants.ts";
import { type Provider, PROVIDERS, providerOf } from "./providers.ts";
import { signInApp } from "./settings.ts";

/** Who calls, as the gate found them. */
export const callerOf = (request: Request): Caller => readCaller(request, webPort);

/** Local development's issuer: its subject is an account's login. It counts only there (admit.ts). */
export const DEV = "dev";
/** Local development: this browser signed out, so it's nobody (not the dev login) until it signs in again (mount.ts). */
export const SIGNED_OUT = "erga_signed_out";

/** The provider a person's account is kept under: the gate's issuer; with a gate in front, the organization's sign-in (SSO). */
export const providerFor = (platform: Pick<Platform, "signIn">, who: Pick<Identity, "p">) => (platform.signIn.mode == "gate" ? SSO : who.p);

/**
 * A person as a gate in front names them, as every sign-in gives one (accounts.ts). The gate gives an address only
 * when its issuer verified it.
 */
export const vouchedOf = (platform: Pick<Platform, "signIn">, who: Identity): Vouched => ({
  provider: providerFor(platform, who),
  subject: who.sub,
  handle: who.email.toLowerCase(),
  name: who.name || null,
  emails: who.email ? [{ email: who.email.toLowerCase(), verified: true }] : [],
  groups: [],
});

/**
 * An answer that asks the gate (gate/core.ts, `after`): "code <grant>", "deny", "token <grant> <end>", "out". The ask
 * is for this one request's browser, so no cache keeps the answer, whatever the route said of it: a shared cache
 * (CloudFront, before the gate's response function) would give the ask to the next browser too, and sign it out.
 */
export const asking = (response: HttpServerResponse.HttpServerResponse, ask: string) =>
  HttpServerResponse.setHeaders(response, { [ASK]: ask, "Cache-Control": "no-store" });

/** The edge key of a gate inside this Worker: from the server's secret, and apart from every other use of it. */
const keys = new Map<string, Promise<string>>();
export const edgeKey = (secret: string) => {
  let key = keys.get(secret);
  if (!key) {
    if (keys.size > 4) keys.clear();
    keys.set(secret, (key = Promise.resolve(webPort.hmac(`erga-edge-key:${secret}`, "the gate inside the Worker"))));
  }
  return key;
};

/** A local server's port, with its colon: each names its hosts and its cookies for it. */
const portOf = (url: URL) => (isLocal(url) && url.port ? `:${url.port}` : "");

/** The documents' domain, as the gate names it (gate/core.ts, Config.content): with the port, locally. */
export const contentDomain = (platform: Pick<Platform, "pagesDomain">, url: URL) => `${platform.pagesDomain(url)}${portOf(url)}`;

/**
 * The gate's settings, where it runs inside this Worker. `url`: the request's address.
 *
 * Where anyone may come in (oauth): a request with no proof goes on as nobody, and the OAuth providers sign people in.
 * Its issuers are read only by the gate's own sign-in (?idp=): there, the app of the provider it names (x=pending:
 * the values that wait for a test sign-in).
 * With the organization's sign-in (gate/sso.ts): only a request with a proof goes on, and the issuer is the deploy's,
 * or Cloudflare Access. The shell is the deploy's app host and no other: an address of this Worker that the deploy
 * did not name (workers.dev) is no way in. One path goes on with no proof, as nobody: the server's health report,
 * which the account's deployer asks after each deploy (gate/core.ts, Config.health).
 *
 * How long a sign-in lasts is the admins' setting (sign_in_days), read only where the gate signs one: its callback
 * (this file's second trap). A change is for the sign-ins after it: a cookie keeps the end it was signed with. Local
 * development's own sign-in (signInCookiesFor) lasts the gate's own 30 days, whatever the setting.
 */
export async function gateConfig(platform: Platform, url: URL): Promise<Config> {
  const content = contentDomain(platform, url);
  const host = url.host.toLowerCase();
  const sso = platform.signIn.mode == "gate" && platform.signIn.at == "inside" ? platform.signIn.sso : null;
  // A document's host, or a custom domain's, has the app's host as its shell: the deploy says which that is.
  const apart =
    host.endsWith(`.${content}`) || url.hostname == platform.pagesShared?.(url) || platform.deploy.domains.includes(url.hostname);
  const idp: Config["idp"] = {};
  const id = url.pathname == SIGN_IN ? providerOf(url.searchParams.get("idp")) : null;
  if (id && platform.signIn.mode == "oauth") {
    const app = await signInApp(platform, url.searchParams.get("x") == "pending" ? "pending" : "active", id);
    if (app?.clientId) idp[id] = await issuerOf(platform, id, app.clientId);
  }
  const app = platform.deploy.app ? platform.deploy.app + portOf(url) : "";
  return {
    key: await edgeKey(platform.secret),
    shell: apart ? app : (sso && app) || host,
    content,
    https: url.protocol == "https:",
    open: !sso,
    idp: sso ? sso.idp : idp,
    // (With the organization's sign-in: the deployer's check of a new release has no sign-in. Where anyone may come
    // in, the report goes on as every path does.)
    ...(sso ? { health: HEALTH } : { chooser: "/auth/sign-in" }),
    oauth: true,
    ...(url.pathname == CALLBACK ? { hours: (await platform.directory.config.get("sign_in_days")) * 24 } : {}),
    grantDays: GRANT_DAYS,
    tag: portOf(url).replace(":", "_"),
  };
}

/**
 * The gate's accept host (gate/core.ts: accept.<the documents' domain>, which has no documents), where the documents
 * are on another site than the app's; null where they share the app's site, or have no hosts of their own. The
 * sign-out page loads its sign-out, which ends the documents' site's cookie.
 */
export function acceptOrigin(platform: Pick<Platform, "pagesDomain" | "pagesShared">, url: URL): string | null {
  const content = contentDomain(platform, url);
  if (platform.pagesShared?.(url) || `.${content}`.endsWith(`.${url.host}`)) return null;
  return `${url.protocol}//accept.${content}`;
}

/** A page of the documents' site that shows nothing: the app's pages frame it, hidden (handOff). */
export const WARM_PATH = "/erga-warm";

/**
 * With a gate in front and the documents on another site, a browser's first frame there goes through the gate's
 * hand-off (three steps, before the document). Two things make that wait shorter: the editor's page connects to the
 * accept host early (`accept`), and the person's list of documents runs the hand-off once, in a hidden frame
 * (`warm`), so their first document opens with the site's cookie there already. Null: no hand-off here.
 */
export function handOff(platform: Pick<Platform, "pagesDomain" | "pagesShared" | "signIn">, url: URL) {
  const accept = platform.signIn.mode == "gate" ? acceptOrigin(platform, url) : null;
  return accept ? { accept, warm: `${accept.replace("//accept.", "//warm.")}${WARM_PATH}` } : null;
}

/**
 * Where a document's page gets the templates' typefaces (server/pages/reader.ts): the viewer's origin `shell`, one
 * address for every document. Not behind a gate in front: a font's request from another origin carries no cookie, and
 * the gate refuses it. There, the page's own origin ("").
 */
export const fontsAt = (platform: Pick<Platform, "signIn">, shell: string) => (platform.signIn.mode == "gate" ? "" : shell);

/** Whether an access rule reads this provider's groups: then its sign-in asks for them. */
export async function wantsGroups(platform: Pick<Platform, "directory">, provider: Provider): Promise<boolean> {
  const kind = SIGN_IN_PROVIDERS[provider].groups?.kind;
  if (!kind) return false;
  try {
    return (await platform.directory.rules.all()).some((r) => r.kind == kind);
  } catch {
    return false;
  }
}

/** A provider as the gate's issuer: where its sign-in is, this server's client there, and what the sign-in asks. */
async function issuerOf(platform: Platform, id: Provider, client: string) {
  const p = PROVIDERS[id];
  const origin = platform.signIn.mode == "oauth" ? platform.signIn.origins[id] : null;
  const { scope, ...more } = p.authorize({ groups: await wantsGroups(platform, id) });
  return { authorize: p.authorizeUrl(origin), client, scope, more };
}

/**
 * A sign-in's cookies, made here: local development's sign-in, which has no issuer (accounts.ts, mount.ts). Only where
 * the gate runs inside this Worker, and only for local development's callers.
 */
export async function signInCookiesFor(platform: Platform, url: URL, identity: Identity, now = Date.now()): Promise<string[]> {
  return signInCookies(now, await gateConfig(platform, url), webPort, identity);
}
