// `bun erga dashboard`: a live page on localhost with what the old Ops page showed: production and staging (the
// release each runs, its health, its branch's last run and the deploy jobs' logs), the feature branches (ahead and
// behind staging, and whether each merges cleanly), and the commits of staging and main. It reads GitHub with gh and
// the servers over HTTPS (deploy/cli/observe.ts), at most every 15 seconds. It listens on 127.0.0.1 only, and only reads.

import type { State } from "./flow";
import { readState } from "./observe";

/** The first free port from `from`. */
function freePort(from: number): number {
  for (let p = from; p < from + 20; p++) {
    try {
      Bun.serve({ port: p, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return p;
    } catch {}
  }
  return from;
}

export async function startDashboard(wanted: number, open: boolean) {
  const port = freePort(wanted);
  let cached: { at: number; value: State | { error: string } } | null = null;
  let pending: Promise<void> | null = null;
  const refresh = () =>
    (pending ??= readState()
      .then((value) => {
        cached = { at: Date.now(), value };
      })
      .catch((e: Error) => {
        cached = { at: Date.now(), value: { error: e.message } };
      })
      .finally(() => {
        pending = null;
      }));
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.get("host") ?? ""))
        return new Response("Wrong host.", { status: 403 });
      if (url.pathname == "/") return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname == "/api/state") {
        if (!cached || Date.now() - cached.at > 15_000) await refresh();
        return Response.json(cached!.value, { headers: { "Cache-Control": "no-store" } });
      }
      return new Response("Not found.", { status: 404 });
    },
  });
  console.log(`PASS  The dashboard: http://localhost:${server.port}/`);
  console.log("NOTE  Keep this command running. It reads GitHub and the servers each time the page asks, at most every 15 seconds.");
  if (open) Bun.spawn(["open", `http://localhost:${server.port}/`]);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Erga deploys</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#77736b;--line:#ddd8ce;--card:#fff;--ok:#2e9b5b;--okbg:#e3f4ea;--warn:#b7801a;--warnbg:#fbf0d9;--bad:#cf4b3f;--badbg:#fbe4e1;--accent:#2f6fde;--zebra:#f2efe8}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#ecebe7;--muted:#9a978f;--line:#3a3a40;--card:#212126;--ok:#5cc489;--okbg:#18301f;--warn:#e0b04a;--warnbg:#3a2e12;--bad:#ef7a6e;--badbg:#3d1c19;--accent:#6b9cff;--zebra:#1d1d22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 2px}h2{font-size:15px;margin:22px 0 8px}.sub{color:var(--muted);margin:0 0 14px}
.servers{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card h3{margin:0 0 4px;font-size:16px;display:flex;gap:8px;align-items:center}
.card .host{color:var(--muted);font-size:13px}.card dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:8px 0 0;font-size:14px}
.card dt{color:var(--muted)}.card dd{margin:0;overflow-wrap:anywhere}
.pill{font-size:12px;font-weight:700;border-radius:999px;padding:1px 9px;white-space:nowrap}
.ok{background:var(--okbg);color:var(--ok)}.warn{background:var(--warnbg);color:var(--warn)}.bad{background:var(--badbg);color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12.5px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
.scroll{overflow-x:auto}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--zebra);padding:1px 4px;border-radius:4px}
a{color:var(--accent)}.muted{color:var(--muted)}.err{color:var(--bad)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:860px){.cols{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>Erga deploys</h1><p class="sub" id="sub">Reading GitHub and the servers...</p>
<div class="servers" id="servers"></div>
<h2>Feature branches</h2><div class="scroll" id="branches"></div>
<div class="cols"><div><h2 id="waitingh">On staging, not on main</h2><div class="scroll" id="waiting"></div></div>
<div><h2 id="logh">main</h2><div class="scroll" id="log"></div></div></div>
</div>
<script>
const $=(s)=>document.querySelector(s);
const h=(s)=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago=(t)=>{const s=(Date.now()-t)/1000;return s<90?"just now":s<5400?Math.round(s/60)+" min ago":s<129600?Math.round(s/3600)+" h ago":Math.round(s/86400)+" days ago"};
const pill=(cls,t)=>'<span class="pill '+cls+'">'+h(t)+'</span>';
const runPill=(r)=>!r?pill("warn","no run"):r.status!="completed"?pill("warn",r.status):pill(r.conclusion=="success"?"ok":"bad",r.conclusion);
const commitLink=(repo,sha)=>'<a href="https://github.com/'+h(repo)+'/commit/'+h(sha)+'" target="_blank"><code>'+h(sha.slice(0,7))+'</code></a>';
async function refresh(){
  let s;try{s=await fetch("/api/state").then(r=>r.json())}catch(e){$("#sub").innerHTML='<span class="err">The dashboard command stopped.</span>';return}
  if(s.error){$("#sub").innerHTML='<span class="err">'+h(s.error)+'</span>';return}
  $("#sub").innerHTML=h(s.repo)+": main <code>"+h((s.heads.main||"?").slice(0,12))+"</code>, staging <code>"+h((s.heads.staging||"?").slice(0,12))+"</code>. Latest release: "+h(s.latestRelease||"none")+". Read "+ago(s.at)+".";
  $("#servers").innerHTML=s.servers.map(v=>{
    const jobs=(v.run&&v.run.jobs||[]).map(j=>'<a href="'+h(j.url)+'" target="_blank">'+h(j.name)+"</a> "+(j.status=="completed"?h(j.conclusion):h(j.status))).join(", ");
    return '<div class="card"><h3>'+h(v.name)+" "+(v.healthy==null?pill("warn","no answer"):v.healthy?pill("ok","healthy"):pill("bad","unhealthy"))+'</h3><div class="host"><a href="https://'+h(v.host)+'" target="_blank">'+h(v.host)+"</a> from "+h(v.branch)+"</div><dl>"
      +"<dt>Runs</dt><dd><code>"+h(v.version||"?")+"</code> "+(v.current?pill("ok","the branch's head"):pill("warn","not the branch's head"))+"</dd>"
      +"<dt>Last run</dt><dd>"+runPill(v.run)+(v.run?' <a href="'+h(v.run.url)+'" target="_blank">'+h(v.run.sha.slice(0,7))+"</a> "+ago(v.run.at):"")+"</dd>"
      +(jobs?"<dt>Logs</dt><dd>"+jobs+"</dd>":"")+"</dl></div>"}).join("");
  $("#branches").innerHTML=s.branches.length?"<table><tr><th>Branch</th><th>Against staging</th><th>Merge</th><th>Last commit</th></tr>"+s.branches.map(b=>"<tr><td><a href=\\"https://github.com/"+h(s.repo)+"/tree/"+h(b.name)+"\\" target=\\"_blank\\">"+h(b.name)+"</a></td><td>"+b.ahead+" ahead, "+b.behind+" behind</td><td>"+(b.conflicts==null?pill("warn","not checked"):b.ahead==0?pill("warn","nothing to merge"):b.conflicts.length?pill("bad","conflicts")+' <span class="muted">'+h(b.conflicts.join(", "))+"</span>":pill("ok","merges cleanly")+" <code>bun erga merge "+h(b.name)+"</code>")+"</td><td>"+h(b.subject)+' <span class="muted">'+ago(b.at)+"</span></td></tr>").join("")+"</table>":'<p class="muted">No feature branches.</p>';
  $("#waitingh").textContent="On staging, not on main ("+s.waiting.length+")";
  $("#waiting").innerHTML=s.waiting.length?"<table>"+s.waiting.map(c=>"<tr><td>"+commitLink(s.repo,c.sha)+"</td><td>"+h(c.subject)+' <span class="muted">'+ago(c.at)+"</span></td></tr>").join("")+"</table>":'<p class="muted">Nothing: main is at staging. </p>';
  $("#log").innerHTML="<table>"+s.log.map(c=>"<tr><td>"+commitLink(s.repo,c.sha)+"</td><td>"+(c.tag?pill("ok",c.tag)+" ":"")+h(c.subject)+' <span class="muted">'+ago(c.at)+"</span></td></tr>").join("")+"</table>";
}
refresh();setInterval(refresh,20000);
</script></body></html>`;
