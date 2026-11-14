// The Setup tab's own routes (`bun erga`, deploy/cli/ops-page.ts sends /setup/... here): what the person does on the
// page, which no agent does or sees. Each records the step in .erga/ (store.ts), where the command that waits finds it
// (cli.ts). The tab itself is view.ts. The ops page takes a POST only from its own origin.
//
//   GET  /setup/github/new[?org=]   sends the browser to GitHub with the app's manifest; GitHub makes the app
//   GET  /setup/github/created      GitHub comes back: the app's id, and its secret into .erga/secrets.json
//   POST /setup/aud                 single sign-on on Cloudflare: the Access application's audience tag
//   POST /setup/secret              single sign-on on AWS: the client secret, into AWS Secrets Manager
//   GET  /setup/claim               to the new server, with the link that makes the person its admin and approves the
//                                   ops token (server/identity/claim.ts); a staging instance: the approval alone
//
// Trap: the claim's link is made here, for the browser only. It is never written to a file or to the command's output.

import { randomBytes } from "node:crypto";
import { esc } from "../../shared/html";
import { Claim } from "../../server/identity/claim";
import { githubManifest } from "./plan";
import { loadSecrets, loadSetup, putSecret, stepSetup, updateSetup } from "./store";

/** The GitHub app requests this page sent, by their state: an answer from GitHub must match one. */
const states = new Set<string>();

/** One request of the Setup tab. `dir`: the ops page's .erga/. */
export async function setupRoute(req: Request, url: URL, dir: string): Promise<Response> {
  const setup = loadSetup(dir);
  const p = url.pathname.slice("/setup".length);
  if (!setup) return new Response("No setup is in progress.", { status: 404 });
  const a = setup.flow.answers;
  /** Back to the tab, with why the form was not taken (or nothing). */
  const back = (problem = "") => {
    updateSetup((s) => ({ ...s, problem }), dir);
    return Response.redirect(`${url.origin}/#${encodeURIComponent(a.host)}/setup`, 303);
  };
  const field = async (name: string) => String((await req.formData()).get(name) ?? "").trim();
  // GitHub's app manifest: a form the browser posts to GitHub, which makes the app, then comes back here.
  if (p == "/github/new" && req.method == "GET") {
    const state = randomBytes(16).toString("hex");
    states.add(state);
    const org = url.searchParams.get("org")?.trim();
    if (org && !/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(org)) return back(`"${org}" isn't a GitHub organization's login.`);
    const action = org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    const manifest = JSON.stringify(githubManifest(a, `${url.origin}/setup/github/created`));
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>To GitHub</title><body style="font:15px system-ui;padding:24px">
<form method="post" action="${action}?state=${state}"><input type="hidden" name="manifest" value="${esc(manifest)}"><p>Sending you to GitHub to make the app...</p><button>Go on</button></form>
<script>document.forms[0].submit()</script>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  if (p == "/github/created") {
    const code = url.searchParams.get("code") ?? "",
      state = url.searchParams.get("state") ?? "";
    if (!states.delete(state) || !/^[0-9a-f]{8,64}$/i.test(code))
      return back("That answer from GitHub was not for a request of this page. Click the button again.");
    const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-setup" },
    });
    const app = (await r.json().catch(() => null)) as {
      client_id?: string;
      client_secret?: string;
      slug?: string;
      html_url?: string;
      message?: string;
    } | null;
    if (!r.ok || !app?.client_id || !app.client_secret)
      return back(`GitHub didn't give the app's values: ${app?.message ?? r.status}. Click the button again.`);
    // The secret first: the command that waits goes on when the app's id is in the setup.
    putSecret(a.host, "GITHUB_CLIENT_SECRET", app.client_secret, dir);
    updateSetup((s) => ({ ...s, github: { clientId: app.client_id!, slug: app.slug, url: app.html_url } }), dir);
    return back();
  }
  if (p == "/aud" && req.method == "POST")
    return back(stepSetup([{ type: "set", key: "aud", value: await field("aud") }], dir).problems[0] ?? "");
  if (p == "/secret" && req.method == "POST") {
    const secret = await field("secret");
    if (!secret) return back("Type the client secret.");
    const { putOidcSecret } = await import("../aws/setup");
    return putOidcSecret(a, secret, dir).then(
      () => {
        // The page saw AWS take it: the flow goes on at once, and the command that waits wakes.
        const s = loadSetup(dir)!.flow.seen;
        stepSetup([{ type: "seen", seen: { ...s, app: true } }], dir);
        return back();
      },
      (e: Error) => back(`AWS did not take the secret: ${e.message}`)
    );
  }
  if (p == "/claim" && req.method == "GET") {
    if (!setup.approve) return back();
    const secret = a.stagingOf ? "" : loadSecrets(dir)[a.host]?.SESSION_SECRET;
    const to = secret
      ? `https://${a.host}/auth/claim?t=${encodeURIComponent(await Claim.seal(secret, {}))}&approve=${encodeURIComponent(setup.approve)}`
      : `https://${a.host}/tokens/approve?code=${encodeURIComponent(setup.approve)}`;
    return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return new Response("Not found.", { status: 404 });
}
