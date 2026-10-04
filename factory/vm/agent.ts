#!/usr/bin/env bun
// The VM's agent: the image's main process (CMD). It listens on port 8080
// and runs the factory's jobs (run.ts, merge.ts) when asked, so the factory
// needs nothing from the platform but an HTTP port: on Cloudflare the
// container's Durable Object reaches it through getTcpPort(8080) (factory/
// cloudflare.ts); locally Docker publishes it on this machine's loopback
// (dev/factory.ts).
//
//   GET  /health                                   "ok"
//   POST /job { script, args, env, wait }          runs bun /opt/factory/<script> args, with env added; with wait,
//                                                  answers { code, output } when it ends, else { started: true } at once
//
// Every request needs "Authorization: Bearer $FACTORY_AGENT_SECRET" (set
// when the VM starts). Jobs' output goes to /work/vm.log too. A job's env
// (its tokens) is for that job only: the agent keeps none of it.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const SECRET = process.env.FACTORY_AGENT_SECRET ?? "";
delete process.env.FACTORY_AGENT_SECRET;
const DIR = import.meta.dirname;
const LOG = join(process.env.FACTORY_WORK ?? "/work", "vm.log");
mkdirSync(join(LOG, ".."), { recursive: true });

function job(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const p = spawn("bun", [join(DIR, script), ...args], { cwd: process.env.FACTORY_WORK ?? "/work", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (c: Buffer) => { tail = (tail + c.toString()).slice(-20000); try { appendFileSync(LOG, c); } catch { /* the log is a nicety */ } };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => take(Buffer.from(String(e))));
    p.on("close", (code) => resolve({ code: code ?? 1, output: tail }));
  });
}

Bun.serve({
  port: Number(process.env.FACTORY_AGENT_PORT ?? 8080),
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!SECRET || req.headers.get("authorization") != `Bearer ${SECRET}`) return new Response("no", { status: 401 });
    if (url.pathname == "/health") return new Response("ok");
    if (url.pathname == "/job" && req.method == "POST") {
      const { script, args = [], env = {}, wait = false } = await req.json() as { script: string; args?: string[]; env?: Record<string, string>; wait?: boolean };
      if (!["run.ts", "merge.ts"].includes(script)) return Response.json({ error: "no such script" }, { status: 400 });
      const running = job(script, args, env);
      return Response.json(wait ? await running : { started: true });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log("factory agent listening");
