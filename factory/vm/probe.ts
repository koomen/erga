#!/usr/bin/env bun
// Checks the factory's image on Cloudflare Containers, for real, without
// touching any server: it puts up a throwaway Worker (erga-factory-probe,
// on workers.dev) whose one Durable Object starts a container from the image
// deploy/targets.json names, exactly as FactoryVm does (the `durable_object`
// policy, ctx.container.images.factory, standard-4, internet on, the agent on
// 8080), and runs one task in it with the scripted stand-in: the VM's real
// scripts (run.ts, task.ts, fake-claude.ts) clone a small repository made in
// the VM, make the task's branch, change the front page, start the preview
// (relayed on 4401), take a screenshot with the VM's Chromium, and report to
// a pretend factory API that the probe Worker serves. Then it deletes the
// container, the application and the Worker.
//
//   CLOUDFLARE_ACCOUNT_ID=<id> bun factory/vm/probe.ts [--keep] [--shot FILE] [--instance standard-4] [--wait SECONDS]
//
// --shot saves the screenshot the VM took. --keep leaves the Worker up (delete it with
// `bunx cf workers delete erga-factory-probe`). This machine's own credential (deploy/credential.ts).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cloudflare } from "../../deploy/cloudflare.ts";
import { imageRef, prepareImage } from "../../deploy/containers.ts";
import { FACTORY } from "../../deploy/targets.ts";

const WORKER = "erga-factory-probe", CLASS = "FactoryProbe";
const ROOT = join(import.meta.dirname, "../..");

/** The probe Worker: a pretend factory API for task #1, and the Durable Object that owns the container. */
const PROBE = String.raw`
import { DurableObject } from "cloudflare:workers";
const json = (b, s = 200) => Response.json(b, { status: s });
export class ${CLASS} extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.reports = []; this.shots = []; }
  async api(req) {
    const url = new URL(req.url);
    if (req.headers.get("authorization") != "Bearer " + this.env.PROBE_TASK_TOKEN) return json({ error: "token" }, 403);
    const rest = url.pathname.replace(/^\/api\/factory\/tasks\/1/, "");
    if (rest == "/brief") return json({ title: "Probe: the factory on Cloudflare", branch: "task/1-probe", base: "staging", prompt: "probe", instructions: null, maxTurns: 1 });
    if (rest == "/screenshots") { const b = new Uint8Array(await req.arrayBuffer()); this.shots.push({ caption: url.searchParams.get("caption"), png: btoa(String.fromCharCode(...b.subarray(0, 4))) , size: b.length, data: b }); return json({ ok: true }); }
    const body = await req.json().catch(() => ({}));
    this.reports.push({ at: Date.now(), kind: rest || req.method, body });
    return json({ ok: true });
  }
  async probe(secret, seed, scripts) {
    const out = { steps: [] };
    try { return await this.probe1(secret, seed, scripts, out); } catch (e) { out.steps.push("threw: " + String(e && e.stack || e)); return out; }
  }
  async probe1(secret, seed, scripts, out) {
    const c = this.ctx.container, t0 = Date.now();
    const step = (s) => out.steps.push(((Date.now() - t0) / 1000).toFixed(1) + "s " + s);
    out.images = c.images ? Object.fromEntries(Object.entries(c.images)) : null;
    step("images: " + JSON.stringify(out.images) + ", running: " + c.running);
    c.start({ image: c.images.factory, instance: this.env.PROBE_INSTANCE || "standard-4", enableInternet: true, env: { FACTORY_AGENT_SECRET: secret } });
    step("start() returned");
    const agent = (path, body) => c.getTcpPort(8080).fetch("http://vm" + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let up = false, last = "";
    for (const until = Date.now() + Number(this.env.PROBE_WAIT_MS || 240000); Date.now() < until && !up;) {
      try { const r = await agent("/health"); up = r.ok; last = r.status; } catch (e) { last = String(e); }
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    step(up ? "the agent answers" : "the agent never answered: " + last);
    if (up) await c.setInactivityTimeout?.(600000);
    if (!up) { await c.destroy().catch(() => {}); return out; }
    const job = async (scripts, env) => (await agent("/job", { script: "run.ts", args: ["work"], env, wait: true, scripts })).json();
    out.seed = await job(seed, {});
    step("seeded a repository in the VM (exit " + out.seed.code + ")");
    out.run = await job(scripts, { FACTORY_API: this.env.PROBE_ORIGIN + "/api/factory", FACTORY_TASK: "1", FACTORY_TOKEN: this.env.PROBE_TASK_TOKEN,
      REPO_URL: "file:///work/origin.git", REPO_TOKEN: "", FACTORY_WORK: "/work", FACTORY_PREVIEW_PORT: "4400", FACTORY_PUBLIC_PORT: "4401", FACTORY_PREVIEW: "static" });
    step("the task's job ended (exit " + out.run.code + ")");
    try { const r = await c.getTcpPort(4401).fetch("http://localhost:4400/"); out.preview = { status: r.status, note: (await r.text()).includes("factory-note") }; } catch (e) { out.preview = { error: String(e) }; }
    step("the preview on 4401: " + JSON.stringify(out.preview));
    out.reports = this.reports;
    out.shots = this.shots.map((s) => ({ caption: s.caption, size: s.size, png: s.png }));
    out.shot = this.shots[0] ? btoa(Array.from(this.shots[0].data, (b) => String.fromCharCode(b)).join("")) : null;
    await c.destroy();
    step("destroyed");
    return out;
  }
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const o = env.PROBE.getByName("probe");
    if (url.pathname.startsWith("/api/factory/")) return o.api(req);
    if (url.pathname == "/probe" && req.method == "POST" && req.headers.get("authorization") == "Bearer " + env.PROBE_SECRET) {
      const b = await req.json();
      try { return json(await o.probe(env.PROBE_SECRET, b.seed, b.scripts)); } catch (e) { return json({ error: String(e && e.stack || e) }, 500); }
    }
    return new Response("not found", { status: 404 });
  },
};
`;

/** A job that makes /work/origin.git: a repository with a staging branch holding the front page (landing/) and an empty package.json. */
const SEED = String.raw`
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const files = JSON.parse(process.env.SEED_FILES ?? "{}");
const sh = (c, cwd) => execSync(c, { cwd, stdio: "inherit" });
sh("rm -rf /work/seed /work/origin.git /work/erga && mkdir -p /work/seed");
for (const [p, text] of Object.entries(files)) { mkdirSync("/work/seed/" + p.split("/").slice(0, -1).join("/"), { recursive: true }); writeFileSync("/work/seed/" + p, text); }
sh("git init -q -b staging && git add . && git commit -qm 'The probe repository' && git clone -q --bare . /work/origin.git", "/work/seed");
console.log("seeded");
`;

if (import.meta.main) {
  const { machineCredential } = await import("../../deploy/credential.ts");
  const args = process.argv.slice(2);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const cred = machineCredential();
  if (!/^[0-9a-f]{32}$/.test(accountId) || !cred) { console.error("Set CLOUDFLARE_ACCOUNT_ID, and log in (bunx cf auth login) or set CLOUDFLARE_API_TOKEN."); process.exit(1); }
  const cf = new Cloudflare(cred.token);
  const acc = `/accounts/${accountId}`;
  const ref = imageRef(accountId, FACTORY.image);
  const rand = () => crypto.randomUUID().replace(/-/g, "");
  const secret = rand(), taskToken = rand();
  const sub = (await cf.call<{ subdomain: string }>("GET", `${acc}/workers/subdomain`, "read the workers.dev subdomain"))!.subdomain;
  const origin = `https://${WORKER}.${sub}.workers.dev`;
  const t0 = Date.now();
  const say = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  let appId: string | null = null;
  try {
    await prepareImage(cf, accountId, ref);
    say(`image ${ref}: prepared`);
    const metadata = JSON.stringify({
      main_module: "probe.js", compatibility_date: "2026-09-30",
      bindings: [{ type: "durable_object_namespace", name: "PROBE", class_name: CLASS }, { type: "secret_text", name: "PROBE_SECRET", text: secret },
        { type: "secret_text", name: "PROBE_TASK_TOKEN", text: taskToken }, { type: "plain_text", name: "PROBE_ORIGIN", text: origin },
        { type: "plain_text", name: "PROBE_WAIT_MS", text: String(Number(args.includes("--wait") ? args[args.indexOf("--wait") + 1] : 240) * 1000) },
        { type: "plain_text", name: "PROBE_INSTANCE", text: args.includes("--instance") ? args[args.indexOf("--instance") + 1] : "standard-4" }],
      exports: { [CLASS]: { type: "durable-object", storage: "sqlite" } },
      containers: [{ name: `${WORKER}-${CLASS.toLowerCase()}`, class_name: CLASS, images: { factory: ref } }],
      tags: ["erga-factory-probe"],
    });
    const upload = async () => {
      const form = new FormData();
      form.set("metadata", metadata);
      form.append("probe.js", new File([PROBE], "probe.js", { type: "application/javascript+module" }));
      await cf.call("PUT", `${acc}/workers/scripts/${WORKER}`, "upload the probe Worker", form);
    };
    await upload();
    await cf.call("POST", `${acc}/workers/scripts/${WORKER}/subdomain`, "turn on its workers.dev address", { enabled: true, previews_enabled: false });
    const settings = await cf.call<{ bindings: { type: string; class_name?: string; namespace_id?: string }[] }>("GET", `${acc}/workers/scripts/${WORKER}/settings`, "read its settings");
    appId = settings!.bindings.find((b) => b.class_name == CLASS)!.namespace_id!;
    await cf.call("POST", `${acc}/containers/applications`, "make its container application", { name: `${WORKER}-${CLASS.toLowerCase()}`, scheduling_policy: "durable_object", durable_objects: { namespace_id: appId } });
    say(`${origin}: up, with its container application ${appId}`);
    const vm = join(import.meta.dirname);
    const scripts = Object.fromEntries(readdirSync(vm).filter((n) => ["common.ts", "fake-claude.ts", "merge.ts", "run.ts", "task.ts"].includes(n)).map((n) => [n, readFileSync(join(vm, n), "utf8")]));
    const seedFiles = { "landing/index.html": readFileSync(join(ROOT, "landing/index.html"), "utf8"), "package.json": `{ "name": "probe", "private": true }\n` };
    const seed = { "run.ts": `process.env.SEED_FILES = ${JSON.stringify(JSON.stringify(seedFiles))};\n${SEED}` };
    let res: Response | null = null;
    for (let i = 0; i < 8; i++) {
      res = await fetch(`${origin}/probe`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ seed, scripts }) }).catch(() => null);
      // A new application takes a while to reach the Durable Object's machines.
      const early = !!res && (await res.clone().text()).includes("no container application");
      if (early) say("the container application isn't there for the Durable Object yet: again in 10 s");
      if (res && !early && res.status != 404 && res.status != 522 && res.status != 530) break;
      await Bun.sleep(early ? 10_000 : 2000);
    }
    const text = await res!.text();
    const out = (() => { try { return JSON.parse(text); } catch { return { error: `HTTP ${res!.status}: ${text.slice(0, 1500)}` }; } })() as any;
    for (const s of out.steps ?? []) console.log(`   VM ${s}`);
    if (out.error) console.log(`   ${out.error}`);
    console.log(`   images on the version: ${JSON.stringify(out.images)}`);
    console.log(`   reports to the pretend factory: ${(out.reports ?? []).map((r: any) => `${r.kind}${r.body?.message ? `: ${r.body.message}` : r.body?.status ? `: ${r.body.status}` : ""}`).join(" | ")}`);
    console.log(`   screenshots: ${JSON.stringify(out.shots)}`);
    if (out.run?.code) console.log(`   the job's output:\n${out.run.output}`);
    const at = args.indexOf("--shot");
    if (at >= 0 && out.shot) { writeFileSync(args[at + 1], Buffer.from(out.shot, "base64")); say(`the VM's screenshot: ${args[at + 1]}`); }
    const ok = out.run?.code == 0 && out.preview?.status == 200 && out.preview?.note && (out.reports ?? []).some((r: any) => r.body?.status == "complete") && out.shots?.length;
    say(ok ? "PROBE OK: a task ran with the stand-in in a real Cloudflare container" : "PROBE FAILED");
    process.exitCode = ok ? 0 : 1;
  } finally {
    if (!args.includes("--keep")) {
      if (appId) await cf.call("DELETE", `${acc}/containers/applications/${appId}`, "delete its container application").catch((e) => console.log(`   (the application: ${(e as Error).message})`));
      await cf.call("DELETE", `${acc}/workers/scripts/${WORKER}?force=true`, "delete the probe Worker").catch((e) => console.log(`   (the Worker: ${(e as Error).message})`));
      say("the probe Worker and its application deleted");
    }
  }
}
