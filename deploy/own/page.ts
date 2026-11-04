// The local checklist page (`bun own start`): where the deploy is, who does each step and how, live checks, the
// person's own forms (the decisions, the sign-in apps: secrets typed here, never in the agent's chat), and a chat
// with the agent (.erga/inbox.jsonl; the agent reads it with `bun own inbox --wait` and answers with `bun own say`).
// It listens on 127.0.0.1 only, and takes a POST only from its own origin.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { esc } from "../../shared/html";
import { githubManifest, PRESETS, QUESTIONS } from "./plan";
import { addMessage, answersOf, DIR, loadOwn, loadSecrets, messages, saveOwn, saveSecrets } from "./store";
import { setAnswers, status } from "./cli";

const json = (v: unknown, s = 200) =>
  new Response(JSON.stringify(v), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** The first port from `from` that nothing listens on (another checklist page, another program). */
function freePort(from: number): number {
  for (let p = from; p < from + 20; p++) {
    try {
      Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return p;
    } catch {}
  }
  return from;
}

export async function startPage(wanted: number, open: boolean) {
  const port = freePort(wanted);
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const states = new Set<string>();
  let cached: { at: number; value: unknown } | null = null;
  const statusNow = async (fresh = false) => {
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
  };
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      // Only this page's own origin: no other site, and no other name for this address (DNS rebinding).
      if (!origins.includes(`http://${req.headers.get("host")}`)) return new Response("Wrong host.", { status: 403 });
      if (req.method == "POST" && !origins.includes(req.headers.get("origin") ?? "")) return new Response("Wrong origin.", { status: 403 });
      const p = url.pathname;
      if (p == "/" && req.method == "GET") return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (p == "/api/status") return json(await statusNow(url.searchParams.has("fresh")));
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
        const own = loadOwn(),
          s = loadSecrets();
        own.google = { clientId: id.trim() };
        s.GOOGLE_CLIENT_SECRET = secret.trim();
        saveOwn(own);
        saveSecrets(s);
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
        const manifest = JSON.stringify(githubManifest(a, `${url.origin}/github/created`));
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
          headers: { Accept: "application/vnd.github+json", "User-Agent": "erga-own" },
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
        const own = loadOwn(),
          s = loadSecrets();
        own.github = { clientId: app.client_id, slug: app.slug, url: app.html_url };
        s.GITHUB_CLIENT_SECRET = app.client_secret;
        saveOwn(own);
        saveSecrets(s);
        cached = null;
        addMessage("agent", `The GitHub App ${app.slug} is made, and its values are stored. Tell me to go on, and I'll deploy.`);
        return Response.redirect(`${url.origin}/#github`, 303);
      }
      return new Response("Not found.", { status: 404 });
    },
  });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(DIR, "page.port"), String(server.port));
  console.log(`PASS  The checklist page: http://localhost:${server.port}/`);
  console.log("NEXT  Give the person this address. Keep this command running (in the background).");
  if (open) Bun.spawn(["open", `http://localhost:${server.port}/`]);
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your Erga: deploy</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#77736b;--line:#ddd8ce;--card:#fff;--ok:#2e9b5b;--okbg:#e3f4ea;--warn:#b7801a;--bad:#cf4b3f;--accent:#2f6fde;--zebra:#f2efe8}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#ecebe7;--muted:#9a978f;--line:#3a3a40;--card:#212126;--ok:#5cc489;--okbg:#18301f;--warn:#e0b04a;--bad:#ef7a6e;--accent:#6b9cff;--zebra:#1d1d22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;max-width:1180px;margin:0 auto;padding:24px 16px}
@media(max-width:860px){.wrap{grid-template-columns:1fr}}
h1{font-size:24px;margin:0 0 2px}h2{font-size:15px;margin:0 0 8px}.sub{color:var(--muted);margin:0 0 18px}
ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;display:grid;grid-template-columns:26px 1fr auto;gap:4px 10px;align-items:start}
.step .dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff}
.step.done .dot{background:var(--ok);border-color:var(--ok)}.step.done .dot::after{content:"✓"}
.step.fail .dot{background:var(--bad);border-color:var(--bad)}.step.fail .dot::after{content:"!"}
.step.now{border:2px solid var(--accent)}.step.now .dot{border-color:var(--accent)}
.step.blocked{opacity:.55}
.step .t{font-weight:600}.step .d{grid-column:2/4;color:var(--muted);font-size:13.5px}
.step .n{grid-column:2/4;font-size:14px;background:var(--zebra);border-radius:8px;padding:6px 10px;margin-top:4px}
.who{font-size:11.5px;font-weight:700;border-radius:999px;padding:1px 8px;white-space:nowrap}
.who.person{background:#fde9c8;color:#7a4b00}.who.agent{background:#dde8fb;color:#1d4ed8}
@media (prefers-color-scheme:dark){.who.person{background:#4a3410;color:#f5c66b}.who.agent{background:#1f2a44;color:#9cb8ff}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px}
form label{display:block;margin:0 0 10px}form label b{display:block;font-size:13.5px}form small{display:block;color:var(--muted);font-size:12px}
input,select,textarea{font:inherit;width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:8px;padding:7px 14px;background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.problems{color:var(--bad);font-size:13.5px}
#chat .log{height:300px;overflow:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px}
.msg{padding:6px 10px;border-radius:10px;font-size:14px;max-width:92%;white-space:pre-wrap}
.msg.person{align-self:flex-end;background:var(--accent);color:#fff}.msg.agent{align-self:flex-start;background:var(--zebra)}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--zebra);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.n code{background:var(--card)}
.hidden{display:none}
</style></head><body><div class="wrap"><main>
<h1>Your Erga</h1><p class="sub" id="sub">Checking...</p>
<ol class="steps" id="steps"></ol>
</main><aside>
<details class="card" id="decide" open><summary><h2 style="display:inline">Your decisions</h2></summary><form id="answers">${QUESTION_FIELDS}<button>Save</button><div class="problems" id="aprob"></div></form></details>
<div class="card hidden" id="github"><h2>GitHub sign-in</h2><p>One click makes a GitHub App for sign-in, with the right addresses. GitHub then sends its values back to this page. Nothing to copy.</p>
<div id="ghmake"><p><a class="btn" href="/github/new">Create the GitHub App</a></p><small>For an organization's app: <a href="#" id="orgapp">make it under an organization</a>.</small></div><p id="ghdone" class="hidden"></p></div>
<div class="card hidden" id="google"><h2>Google sign-in</h2><ol id="gsteps"></ol><form id="gform"><label><b>Client ID</b><input name="id" autocomplete="off"></label><label><b>Client secret</b><input name="secret" type="password" autocomplete="off"><small>It goes to .erga/secrets.json on this machine, and to your server. Never paste it in the chat.</small></label><button>Save</button><div class="problems" id="gprob"></div></form></div>
<div class="card" id="chat"><h2>Your agent</h2><div class="log" id="log"></div><form id="say"><textarea name="text" rows="2" placeholder="A message to your coding agent"></textarea><button>Send</button></form><small>Your agent reads these with <code>bun own inbox</code>. Your terminal works too.</small></div>
</aside></div>
<script>
const $=(s)=>document.querySelector(s);
const post=(u,b)=>fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
const h=(s)=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const code=(s)=>h(s).replace(/(bun own [^,;.)]+|bunx? [a-z][^,;.)]+|https?:\\/\\/[^\\s,;)]+)/g,"<code>$1</code>");
let filled=false;
async function refresh(fresh){
  const s=await fetch("/api/status"+(fresh?"?fresh":"")).then(r=>r.json());
  const done=s.steps.filter(x=>x.state=="done").length;
  $("#sub").textContent=s.next?\`\${done} of \${s.steps.length} steps done. Next: \${s.next.title} (\${s.next.who=="person"?"you":"your agent"}).\`:"Every step is done. Your Erga is up.";
  $("#steps").innerHTML=s.steps.map(x=>\`<li class="step \${x.state}\${s.next&&s.next.id==x.id?" now":""}"><span class="dot"></span><span class="t">\${h(x.title)}</span><span class="who \${x.who}">\${x.who=="person"?"You":"Agent"}</span><span class="d">\${code(x.detail)}</span>\${x.state!="done"&&s.next&&s.next.id==x.id?\`<span class="n">\${code(x.next)}</span>\`:""}</li>\`).join("");
  const a=s.answers;
  if(!filled){filled=true;for(const [k,v] of Object.entries(a)){const el=$("#answers [name="+k+"]");if(el)el.value=Array.isArray(v)?v.join(","):(v||(k=="staging"?"no":k=="pages"?"shared":""));}}
  const decided=s.steps.find(x=>x.id=="decide")?.state=="done";
  $("#github").classList.toggle("hidden",!decided);
  $("#ghdone").classList.toggle("hidden",!s.github);$("#ghmake").classList.toggle("hidden",!!s.github);
  if(decided&&!refresh.folded){refresh.folded=true;$("#decide").open=false;}
  if(s.github)$("#ghdone").innerHTML="Your app: "+(s.github.url?\`<a href="\${h(s.github.url)}" target="_blank">\${h(s.github.slug||s.github.clientId)}</a>\`:h(s.github.clientId));
  const g=decided&&a.providers.includes("google");
  $("#google").classList.toggle("hidden",!g);
  if(g){const hosts=[a.host,a.staging].filter(Boolean);$("#gsteps").innerHTML=\`<li>Open <a href="https://console.cloud.google.com/auth/clients/create" target="_blank">Google Cloud: Create OAuth client</a> (make a project first if it asks).</li><li>Application type: <b>Web application</b>. Name: Erga.</li><li>Authorized redirect URIs: \${hosts.map(x=>"<code>https://"+h(x)+"/auth/google/callback</code>").join(" and ")}</li><li>Create, then type the Client ID and Client secret here.</li>\`+(s.google?"<li><b>Saved: "+h(s.google.clientId)+"</b></li>":"");}
}
async function chat(){const m=await fetch("/api/messages").then(r=>r.json());const log=$("#log");const end=log.scrollTop+log.clientHeight>=log.scrollHeight-8;log.innerHTML=m.map(x=>\`<div class="msg \${x.from}">\${h(x.text)}</div>\`).join("")||'<div class="msg agent">Your agent will write here too.</div>';if(end)log.scrollTop=log.scrollHeight;}
$("#answers").onsubmit=async(e)=>{e.preventDefault();const r=await post("/api/answers",Object.fromEntries(new FormData(e.target)));$("#aprob").textContent=r.problems.join(" ");refresh(true);};
$("#gform").onsubmit=async(e)=>{e.preventDefault();const r=await post("/api/google",Object.fromEntries(new FormData(e.target)));$("#gprob").textContent=r.problems.join(" ");if(!r.problems.length)e.target.reset();refresh(true);};
$("#say").onsubmit=async(e)=>{e.preventDefault();const t=e.target.text.value.trim();if(!t)return;await post("/api/messages",{text:t});e.target.reset();chat();};
$("#orgapp").onclick=(e)=>{e.preventDefault();const o=prompt("The organization's GitHub login:");if(o)location.href="/github/new?org="+encodeURIComponent(o);};
refresh(true);chat();setInterval(refresh,6000);setInterval(chat,2000);
</script></body></html>`;
