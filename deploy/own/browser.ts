// The person's steps in the browser that `bun erga setup` opens: a page on this machine's loopback, for one step, that
// stops when the step is done. No agent sees these pages or what goes through them.
//
//   githubApp     the page posts the app's manifest to GitHub (GitHub's manifest flow needs a form POST); GitHub makes
//                 the app and comes back with a code; the page changes it for the app's id and secret, into
//                 .erga/secrets.json (with a staging address: under both hosts, since they share the app)
//   oidcSecret    single sign-on on AWS: one field for the client secret of the company's sign-in, into Secrets Manager
//
// Trap: a page here never shows a secret, and the command never prints one.

import { randomBytes } from "node:crypto";
import { esc } from "../../shared/html";
import { type Answers, githubManifest } from "./plan";
import { DIR, putSecret } from "./store";

/** Opens `url` in the person's browser. */
export const openBrowser = (url: string) =>
  void Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });

const html = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Erga setup</title><body style="font:15px/1.5 system-ui;max-width:560px;margin:48px auto;padding:0 16px">${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
const doneHtml = (what: string) =>
  html(`<h1 style="font-size:20px">Done</h1><p>${esc(what)} Go back to your terminal: setup goes on by itself.</p>`);

/**
 * One step's page on the loopback, opened in the browser. `route` answers each request; it ends the step with "" (done)
 * or a failure, or null to go on. The result: "" (done), a failure, or null when `ms` ends first.
 */
async function step(
  route: (req: Request, url: URL) => Promise<{ res: Response; end?: string }>,
  ms: number,
  open: (url: string) => void
): Promise<string | null> {
  let end: (r: string) => void = () => {};
  const ended = new Promise<string>((r) => (end = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const r = await route(req, new URL(req.url));
      if (r.end != undefined) queueMicrotask(() => end(r.end!));
      return r.res;
    },
  });
  open(`http://127.0.0.1:${server.port}/`);
  try {
    return await Promise.race([ended, Bun.sleep(ms).then(() => null)]);
  } finally {
    // The last page has its answer before the server stops.
    setTimeout(() => server.stop(), 500);
  }
}

/** The GitHub App of `a`: the person clicks Create on GitHub. Its id and secret go into .erga/secrets.json. */
export function githubApp(
  a: Answers,
  ms: number,
  o: { dir?: string; api?: typeof fetch; open?: (url: string) => void } = {}
): Promise<string | null> {
  const { dir = DIR, api = fetch, open = openBrowser } = o;
  const state = randomBytes(16).toString("hex");
  return step(
    async (req, url) => {
      if (url.pathname == "/") {
        const manifest = JSON.stringify(githubManifest(a, `${url.origin}/created`));
        return {
          res: html(`<form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${esc(manifest)}"><p>Sending you to GitHub to make the app for ${esc(a.host)}…</p><button>Go on</button></form>
<script>document.forms[0].submit()</script>`),
        };
      }
      if (url.pathname != "/created") return { res: html("Not found.", 404) };
      const code = url.searchParams.get("code") ?? "";
      if (url.searchParams.get("state") != state || !/^[0-9a-f]{8,64}$/i.test(code))
        return { res: html("That answer from GitHub was not for this setup.", 400) };
      const r = await api(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-setup" },
      });
      const app = (await r.json().catch(() => null)) as { client_id?: string; client_secret?: string; message?: string } | null;
      if (!r.ok || !app?.client_id || !app.client_secret) {
        const why = `GitHub didn't give the app's values: ${app?.message ?? r.status}.`;
        return { res: html(esc(why), 502), end: why };
      }
      for (const host of [a.host, a.staging].filter(Boolean)) {
        putSecret(host, "GITHUB_CLIENT_SECRET", app.client_secret, dir);
        putSecret(host, "GITHUB_CLIENT_ID", app.client_id, dir);
      }
      return { res: doneHtml("GitHub made the app."), end: "" };
    },
    ms,
    open
  );
}

/** Single sign-on on AWS: the person types the client secret, and `put` stores it (Secrets Manager). */
export function oidcSecret(a: Answers, put: (secret: string) => Promise<void>, ms: number): Promise<string | null> {
  const form = (problem = "") =>
    html(`<h1 style="font-size:20px">The client secret of your company's sign-in</h1>
<p>Erga's client <code>${esc(a.client)}</code> at ${esc(a.issuer)}. The secret goes to AWS Secrets Manager, never to your agent.</p>
${problem ? `<p style="color:#b42318">${esc(problem)}</p>` : ""}<form method="post" action="/"><input name="secret" type="password" autocomplete="off" style="width:100%;padding:6px 8px" autofocus>
<p><button>Save</button></p></form>`);
  return step(
    async (req) => {
      if (req.method != "POST") return { res: form() };
      const secret = String((await req.formData()).get("secret") ?? "").trim();
      if (!secret) return { res: form("Type the client secret.") };
      return put(secret).then(
        () => ({ res: doneHtml("AWS has the client secret."), end: "" }),
        (e: Error) => ({ res: form(`AWS did not take the secret: ${e.message}`) })
      );
    },
    ms,
    openBrowser
  );
}
