// The Setup tab of the ops page (`bun erga`, deploy/cli/ops-page.ts serves these routes under /setup/): the checklist
// of `bun erga setup <host>`. Where the setup is, who does each step and how, live checks, the person's own forms (the
// decisions, the sign-in apps: secrets typed here, never in the agent's chat), and a chat with the agent
// (.erga/inbox.jsonl; the agent reads it with `bun erga setup <host> inbox --wait` and answers with
// `bun erga setup <host> say`). The ops page takes a POST only from its own origin. Its script: deploy/own/setup.js.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { esc } from "../../shared/html";
import { githubManifest, PRESETS, QUESTIONS } from "./plan";
import { addMessage, answersOf, DIR, loadOwn, messages, putSecret, ROOT, saveOwn } from "./store";
import { setAnswers, status } from "./cli";

const json = (v: unknown, s = 200) =>
  new Response(JSON.stringify(v), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The GitHub app requests this page sent, by their state: an answer from GitHub must match one. */
const states = new Set<string>();
let cached: { at: number; value: unknown } | null = null;

async function statusNow(port: number, fresh = false) {
  if (!fresh && cached && Date.now() - cached.at < 4000) return cached.value;
  const s = await status({ port });
  const own = loadOwn();
  cached = {
    at: Date.now(),
    value: {
      steps: s.steps,
      next: s.next,
      answers: answersOf(own),
      github: own.github,
      google: own.google,
      secrets: s.facts.secrets,
      head: s.facts.head?.slice(0, 12),
    },
  };
  return cached.value;
}

/** One request of the Setup tab: /setup.js, /setup/panel, /setup/api/..., /setup/github/.... */
export async function setupRoute(req: Request, url: URL): Promise<Response> {
  if (url.pathname == "/setup.js")
    return new Response(readFileSync(join(ROOT, "deploy/own/setup.js")), { headers: { "Content-Type": "text/javascript" } });
  const p = url.pathname.slice("/setup".length);
  if (p == "/panel") return new Response(PANEL, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (p == "/api/status") return json(await statusNow(Number(url.port), url.searchParams.has("fresh")));
  if (p == "/api/messages" && req.method == "GET") return json(messages());
  if (p == "/api/messages" && req.method == "POST") {
    const { text } = (await req.json()) as { text?: string };
    if (!text?.trim()) return json({ error: "Empty." }, 400);
    return json(addMessage("person", text.trim()));
  }
  if (p == "/api/answers" && req.method == "POST") {
    const problems = setAnswers((await req.json()) as Record<string, string>);
    cached = null;
    return json({ problems });
  }
  if (p == "/api/google" && req.method == "POST") {
    const { id, secret } = (await req.json()) as { id?: string; secret?: string };
    if (!id?.trim().endsWith(".apps.googleusercontent.com") || !secret?.trim())
      return json({ problems: ["The client id ends with .apps.googleusercontent.com, and the secret is needed too."] });
    const own = loadOwn();
    own.google = { clientId: id.trim() };
    saveOwn(own);
    putSecret(answersOf(own).host, "GOOGLE_CLIENT_SECRET", secret.trim());
    cached = null;
    return json({ problems: [] });
  }
  // GitHub's app manifest: a form the browser posts to GitHub, which makes the app, then comes back here.
  if (p == "/github/new" && req.method == "GET") {
    const a = answersOf(loadOwn());
    if (!a.host) return new Response("Answer the questions first.", { status: 400 });
    const state = randomBytes(16).toString("hex");
    states.add(state);
    const org = url.searchParams.get("org")?.trim();
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
      return new Response("This answer isn't for a request from this page. Start again from the checklist.", { status: 400 });
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
      return new Response(
        `GitHub didn't give the app's values: ${esc(app?.message ?? String(r.status))}. Start again from the checklist.`,
        { status: 502 }
      );
    const own = loadOwn();
    own.github = { clientId: app.client_id, slug: app.slug, url: app.html_url };
    saveOwn(own);
    putSecret(answersOf(own).host, "GITHUB_CLIENT_SECRET", app.client_secret);
    cached = null;
    addMessage("agent", `The GitHub App ${app.slug} is made, and its values are stored. Tell me to go on, and I'll deploy.`);
    return Response.redirect(`${url.origin}/#${encodeURIComponent(answersOf(own).host)}/setup`, 303);
  }
  return new Response("Not found.", { status: 404 });
}

/**
 * `bun erga setup <host> start`: the ops page at the setup's tab. An ops page that runs already (.erga/page.port) is
 * enough; else this command runs one, until Ctrl-C.
 */
export async function startPage(wanted: number, open: boolean) {
  const host = answersOf(loadOwn()).host;
  const at = (port: number) => `http://127.0.0.1:${port}/#${encodeURIComponent(host)}/setup`;
  const port = existsSync(join(DIR, "page.port")) ? Number(readFileSync(join(DIR, "page.port"), "utf8")) : 0;
  const runs =
    port > 0 &&
    (await fetch(`http://127.0.0.1:${port}/view`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false
    ));
  let url = runs ? at(port) : "";
  if (!runs) {
    const { startOpsPage } = await import("../cli/ops-page");
    url = at(startOpsPage({ dir: DIR, cwd: ROOT, port: wanted, open: false }).server.port!);
  } else console.log(`PASS  The ops page runs already.`);
  console.log(`NEXT  Give the person this address: ${url}${runs ? "" : " Keep this command running (in the background)."}`);
  if (open) Bun.spawn([process.platform == "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });
}

const QUESTION_FIELDS = QUESTIONS.map((q) => {
  const input =
    q.key == "preset"
      ? `<select name="preset">${Object.entries(PRESETS)
          .map(([k, p]) => `<option value="${k}">${esc(p.title)}</option>`)
          .join("")}</select>`
      : q.key == "providers"
        ? `<select name="providers"><option value="github">GitHub</option><option value="github,google">GitHub and Google</option></select>`
        : `<input name="${q.key}" autocomplete="off">`;
  return `<label><b>${esc(q.ask)}</b>${input}<small>${esc(q.help)}</small></label>`;
}).join("");

/** The checklist's markup: the steps, then the person's forms and the chat. deploy/own/setup.js fills it. */
const PANEL = `<div class="s-wrap"><div class="s-main">
<p class="s-sub" data-s="sub">Checking...</p>
<ol class="s-steps" data-s="steps"></ol>
</div><aside class="s-side">
<details class="s-card" data-s="decide" open><summary><h3>Your decisions</h3></summary><form data-s="answers">${QUESTION_FIELDS}<button>Save</button><div class="s-problems" data-s="aprob"></div></form></details>
<div class="s-card" data-s="github" hidden><h3>GitHub sign-in</h3><p>One click makes a GitHub App for sign-in, with the right addresses. GitHub then sends its values back to this page. Nothing to copy.</p>
<div data-s="ghmake"><p><a class="s-btn" href="/setup/github/new">Create the GitHub App</a></p><small>For an organization's app: <a href="#" data-s="orgapp">make it under an organization</a>.</small></div><p data-s="ghdone" hidden></p></div>
<div class="s-card" data-s="google" hidden><h3>Google sign-in</h3><ol data-s="gsteps"></ol><form data-s="gform"><label><b>Client ID</b><input name="id" autocomplete="off"></label><label><b>Client secret</b><input name="secret" type="password" autocomplete="off"><small>It goes to .erga/secrets.json on this machine, and to your server. Never paste it in the chat.</small></label><button>Save</button><div class="s-problems" data-s="gprob"></div></form></div>
<div class="s-card s-chat"><h3>Your agent</h3><div class="s-log" data-s="log"></div><form data-s="say"><textarea name="text" rows="2" placeholder="A message to your coding agent"></textarea><button>Send</button></form><small>Your agent reads these with <code>bun erga setup &lt;host&gt; inbox</code>. Your terminal works too.</small></div>
</aside></div>`;
