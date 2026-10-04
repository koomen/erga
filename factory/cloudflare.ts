// The factory's VMs on Cloudflare (experimental, NOT YET RUN against the
// real service): Cloudflare Containers, one per task, each owned by a
// Durable Object of this class, FactoryVm, and started from the factory's
// image (factory/vm/Dockerfile). Inert until the runbook's steps declare the
// container and its binding (README, The factory, Runbook): with no
// FACTORY_VM binding, nothing here runs.
//
// It needs only the platform's most basic container API: start the
// container, reach a TCP port over HTTP, destroy it. The image's agent
// (factory/vm/agent.ts, port 8080) runs the jobs, as it does locally, and
// the preview's relay listens on 4401.
//
// Previews: https://<vm>.<FACTORY_PREVIEW_DOMAIN>/ (a wildcard route to this
// Worker). The board's link carries a short-lived signed ticket; the first
// request trades it for a cookie on that host; then every request goes to
// the container's port 4401, with Host set to localhost (the dev server in
// the VM signs in its DEV_LOGIN on localhost only).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type { VmHost } from "../worker/factory";

/** The part of the container API this uses (a Durable Object's ctx.container). */
interface ContainerApi {
  readonly running: boolean;
  start(opts?: { env?: Record<string, string>; enableInternet?: boolean }): void;
  destroy(reason?: unknown): Promise<void>;
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

const AGENT = 8080, PREVIEW = 4401;

export class FactoryVm extends DurableObject<Env> {
  private get box(): ContainerApi {
    const c = (this.ctx as unknown as { container?: ContainerApi }).container;
    if (!c) throw new Error("FactoryVm has no container: declare it in cloudflare.config.ts (README, The factory, Runbook)");
    return c;
  }

  private async secret(): Promise<string> {
    let s = await this.ctx.storage.get<string>("secret");
    if (!s) { s = crypto.randomUUID(); await this.ctx.storage.put("secret", s); }
    return s;
  }

  /** Starts the container if it isn't running, and waits for its agent. */
  async boot(): Promise<void> {
    const secret = await this.secret();
    if (!this.box.running) this.box.start({ env: { FACTORY_AGENT_SECRET: secret }, enableInternet: true });
    for (let i = 0; i < 120; i++) {
      try {
        const r = await this.box.getTcpPort(AGENT).fetch("http://vm/health", { headers: { Authorization: `Bearer ${secret}` } });
        if (r.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the VM's agent didn't answer in 60 seconds");
  }

  async job(script: string, args: string[], env: Record<string, string>, wait: boolean): Promise<{ code: number; output: string } | null> {
    const r = await this.box.getTcpPort(AGENT).fetch("http://vm/job", {
      method: "POST", headers: { Authorization: `Bearer ${await this.secret()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ script, args, env, wait }),
    });
    if (!r.ok) throw new Error(`the VM's agent answered ${r.status}`);
    return wait ? r.json() : null;
  }

  async alive(): Promise<boolean> { return this.box.running; }
  async stop(): Promise<void> { if (this.box.running) await this.box.destroy(); await this.ctx.storage.deleteAll(); }

  /** A request for the preview, sent on to the VM as if to localhost. */
  async preview(request: Request): Promise<Response> {
    if (!this.box.running) return new Response("This task's VM has stopped: its preview is gone.", { status: 410 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("Host", "localhost:4400");
    headers.delete("Cookie");
    return this.box.getTcpPort(PREVIEW).fetch(`http://localhost:4400${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, redirect: "manual" });
  }
}

/** The VMs on Cloudflare: one FactoryVm each. */
export function containersHost(env: Env, origin: string): VmHost {
  const ns = env.FACTORY_VM!;
  const vm = (name: string) => ns.getByName(name);
  return {
    kind: "cloudflare",
    async start(task) {
      const name = `task-${task}-${crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
      await vm(name).boot();
      return { vm: name, preview: `https://${name}.${env.FACTORY_PREVIEW_DOMAIN}` };
    },
    job: (name, script, args, jobEnv, wait) => vm(name).job(script, args, jobEnv, wait),
    stop: (name) => vm(name).stop(),
    alive: (name) => vm(name).alive(),
    // Erga's own repository (#39): its Git endpoint, which checks the factory's tokens and its branch rules.
    repo: () => `${origin}/git/erga.git`,
  };
}

/** A request to a preview host (<vm>.<FACTORY_PREVIEW_DOMAIN>), or null if it isn't one. */
export async function previewDoor(request: Request, env: Env, ticketOk: (vm: string, ticket: string) => Promise<boolean>): Promise<Response | null> {
  const domain = env.FACTORY_PREVIEW_DOMAIN?.trim();
  const url = new URL(request.url);
  if (!domain || !env.FACTORY_VM || !url.hostname.endsWith(`.${domain}`)) return null;
  const name = url.hostname.slice(0, -domain.length - 1);
  if (!/^task-\d+-[0-9a-f]{6}$/.test(name)) return new Response("Not found", { status: 404 });
  const cookie = /(?:^|;\s*)factory_preview=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const ticket = url.searchParams.get("factory_ticket");
  if (ticket && (await ticketOk(name, ticket))) {
    url.searchParams.delete("factory_ticket");
    return new Response(null, { status: 302, headers: { Location: url.pathname + url.search, "Set-Cookie": `factory_preview=${ticket}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` } });
  }
  if (!cookie || !(await ticketOk(name, cookie))) return new Response("Open this preview from the factory's board.", { status: 403 });
  return env.FACTORY_VM.getByName(name).preview(request);
}
