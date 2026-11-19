// The verify harness's Cloudflare Access (setting 4, dev/verify.ts): Access in front of the shell's host, with the
// test issuer (idp.ts) as its identity provider, so that a run signs in with no person. What it makes in the team (the
// account's Zero Trust organization), and removes again, each by its name:
//
//   the identity provider   erga-verify-<n>: generic OIDC, at the test issuer. Access sends a person there, trades the
//                           code with the client's secret and PKCE, and checks the ID token's signature (/jwks)
//   the application         erga-verify-<n>, for the shell's host. Only that provider signs in, and at once (no page of
//                           choices). Its policy, erga-verify-<n>, allows the issuer's two people by their addresses.
//                           Its cookie is HttpOnly
//   the open application    erga-verify-<n>-open, for the paths of the shell that carry no Access proof (OPEN). Its
//                           policy, erga-verify-<n>-open, is a bypass for everyone: the gate checks its own values
//                           there (gate/mounts/access.ts)
//
// Trap: an identity provider is the whole team's. An application that names no providers of its own would offer it on
// its sign-in page. So the deploy refuses while the team has such an application.
// Trap: a service token is no person. Access's proof for one has no subject, and the gate takes it for nobody: so a
// run signs in as a person, at an issuer.
// Trap: Access's proof is also in a cookie of the shell's host (CF_Authorization). The gate drops it from what goes on
// to Erga, with its own cookies.

import { account } from "./erga.ts";
import { type Answer, ask, type Jar } from "./http.ts";
import { CLIENT, local, type Run, type Setting } from "./run.ts";
import { mine } from "./safe.ts";

const nameOf = (s: Setting) => mine(`erga-verify-${s.n}`);
/** The issuer's people (idp.ts): the policy allows these addresses. */
const PEOPLE = ["ada@example.com", "bob@example.com"];

/**
 * The paths of the shell that Access lets through with no sign-in, because what comes there has no Access proof: the
 * vouch (a frame of the documents' site: the browser sends it no Lax cookie), the agents' metadata and token endpoint
 * (an agent's app has no proof before its token), and MCP (an agent's app has the gate's token, never an Access
 * sign-in). The gate checks its own values on each.
 */
export const OPEN = [
  "/_edge/vouch",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
  "/mcp",
];

interface App {
  id: string;
  name: string;
  aud: string;
  allowed_idps?: string[];
}
interface Provider {
  id: string;
  name: string;
}

/**
 * Makes the setting's identity provider, application and open application. `issuer` deploys the test issuer for the
 * address it sends a person back to (the team's own callback), and gives the issuer's address. `run.idp.url` gets it.
 */
export async function deployAccess(
  s: Setting,
  run: Run,
  issuer: (s: Setting, run: Run, redirect: string) => Promise<string>
): Promise<{ team: string; aud: string }> {
  const { cf, acc } = await account();
  const name = nameOf(s);
  const org = await cf.call<{ auth_domain: string }>("GET", `${acc}/access/organizations`, "read the Zero Trust team");
  const team = org?.auth_domain.replace(/\.cloudflareaccess\.com$/, "");
  if (!team) throw new Error("The account has no Zero Trust team: Cloudflare Access is not set up there.");
  // Only the suite's own team (dedicated.ts asked before; the team is read again here, where it is used).
  if (team != local().cloudflare.team) throw new Error(`The account's Zero Trust team is ${team}, not the one of .erga/verify.json.`);
  const apps = (await cf.call<App[]>("GET", `${acc}/access/apps?per_page=200`, "list the Access applications")) ?? [];
  const wide = apps.filter((a) => !a.name.startsWith(name) && !a.allowed_idps?.length);
  if (wide.length)
    throw new Error(
      `The Access application ${wide.map((a) => a.name).join(", ")} names no identity providers of its own: it would offer the run's test issuer on its sign-in page. Nothing was made.`
    );
  // (A deploy after one that stopped: what that one made goes first.)
  await removeAccess(s);
  run.idp.url = await issuer(s, run, `https://${team}.cloudflareaccess.com/cdn-cgi/access/callback`);
  const provider = await cf.call<Provider>("POST", `${acc}/access/identity_providers`, "make the Access identity provider", {
    name,
    type: "oidc",
    config: {
      client_id: CLIENT,
      client_secret: run.idp.secret,
      auth_url: `${run.idp.url}/authorize`,
      token_url: `${run.idp.url}/token`,
      certs_url: `${run.idp.url}/jwks`,
      scopes: ["openid", "email", "profile"],
      pkce_enabled: true,
      email_claim_name: "email",
    },
  });
  const app = async (o: { name: string; hosts: string[]; more: object; policy: object }) => {
    const made = await cf.call<App>("POST", `${acc}/access/apps`, `make the Access application ${o.name}`, {
      name: mine(o.name),
      type: "self_hosted",
      domain: o.hosts[0],
      self_hosted_domains: o.hosts,
      app_launcher_visible: false,
      session_duration: "24h",
      ...o.more,
    });
    await cf.call("POST", `${acc}/access/apps/${made!.id}/policies`, `make the Access policy ${o.name}`, {
      name: o.name,
      precedence: 1,
      ...o.policy,
    });
    return made!;
  };
  const made = await app({
    name,
    hosts: [s.shell],
    more: {
      allowed_idps: [provider!.id],
      auto_redirect_to_identity: true,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: "lax",
    },
    policy: { decision: "allow", include: PEOPLE.map((email) => ({ email: { email } })) },
  });
  await app({
    name: `${name}-open`,
    hosts: OPEN.map((path) => `${s.shell}${path}`),
    more: {},
    policy: { decision: "bypass", include: [{ everyone: {} }] },
  });
  console.log(`Access: the team ${team}; the application ${name} for ${s.shell}, and ${name}-open for ${OPEN.length} paths.`);
  return { team, aud: made.aud };
}

/** Removes the setting's applications (their policies go with them) and its identity provider, each by its name. */
export async function removeAccess(s: Setting): Promise<void> {
  const { cf, acc } = await account();
  const name = nameOf(s);
  const gone = async <T extends { id: string; name: string }>(kind: string, path: string, names: string[]) => {
    const all = (await cf.call<T[]>("GET", `${acc}/access/${path}?per_page=200`, `list the Access ${kind}s`)) ?? [];
    for (const want of names) {
      const found = all.filter((x) => x.name == want);
      for (const x of found) await cf.call("DELETE", `${acc}/access/${path}/${x.id}`, `delete the Access ${kind} ${mine(x.name)}`);
      console.log(found.length ? `Removed the Access ${kind} ${want}` : `The Access ${kind} ${want}: none`);
    }
  };
  // The applications first: an identity provider that an application names can't go.
  await gone("application", "apps", [name, `${name}-open`]).catch((e: Error) =>
    console.log(`Access applications: NOT removed: ${e.message}`)
  );
  await gone("identity provider", "identity_providers", [name]).catch((e: Error) =>
    console.log(`The Access identity provider ${name}: NOT removed: ${e.message}`)
  );
}

/** Whether an answer is Access's own, off to the team's sign-in: the request had no Access proof. */
export const toAccess = (run: Run, a: Answer) =>
  a.status == 302 && (a.headers.get("location") ?? "").startsWith(`https://${run.access!.team}.cloudflareaccess.com/`);

/**
 * Signs `who` in at Access, as a browser does: a page of the shell, Access's sign-in, the issuer's form, the team's
 * callback, and back to the page. The answers, in order; the last is the page's (the gate's or the origin's).
 */
export async function accessSignIn(run: Run, who: string, jar: Jar, next = "/"): Promise<Answer[]> {
  const trail = [await ask(`https://${run.shell}${next}`, { jar, dest: "document" })];
  for (let i = 0; i < 12; i++) {
    const last = trail.at(-1)!;
    // A redirect; or Access's own sign-in page, whose script goes on to the application's one identity provider.
    const to =
      last.status >= 300 && last.status < 400
        ? last.headers.get("location")
        : new URL(last.url).host == `${run.access!.team}.cloudflareaccess.com`
          ? (/ data-auto-redirect-url="([^"]+)"/.exec(last.text)?.[1].replace(/&amp;/g, "&") ?? null)
          : null;
    if (!to) break;
    const url = new URL(to, last.url).href;
    // The issuer's form, as the person sends it.
    trail.push(
      url.startsWith(`${run.idp.url}/authorize`)
        ? await ask(url, { body: new URLSearchParams({ who, pass: run.idp.password }).toString() })
        : await ask(url, { jar, dest: "document" })
    );
  }
  return trail;
}
