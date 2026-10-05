// The factory's VMs on Cloudflare: Cloudflare Containers, one per task, each
// owned by a Durable Object of this class, FactoryVm, with the
// `durable_object` scheduling policy: the deploy pipeline declares the
// factory's image on the Worker's version (deploy/cloudflare.ts, the
// "factory" step; deploy/targets.json, `factory`), and each VM starts from it
// with the instance type chosen here. With no FACTORY_VM binding or no
// FACTORY_PREVIEW_DOMAIN, nothing here runs.
//
// It needs only the platform's basic container API: start the container,
// reach a TCP port over HTTP, keep it up while it's idle, destroy it. The
// image's agent (factory/vm/agent.ts, port 8080) runs the jobs, as it does
// locally, and the preview's relay listens on 4401. The jobs' scripts
// (factory/vm/*.ts) come with each job, from this Worker's own version, so
// the image changes only with its Dockerfile and agent (factory/vm/build.ts).
//
// Previews: https://<vm>.<FACTORY_PREVIEW_DOMAIN>/ (the documents' pages
// domain: its wildcard route and DNS record already send every name to this
// Worker, and its Universal SSL certificate covers one label under it). The
// board's link carries a short-lived signed ticket; the first request trades
// it for a cookie on that host; then every request goes to the container's
// port 4401, with Host set to localhost (the dev server in the VM signs in its
// DEV_LOGIN on localhost only). A document's page on a sibling host can't use
// that cookie: requests from another host of the domain (Sec-Fetch-Site:
// same-site) are refused.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker/env";
import type { VmHost } from "../worker/factory";
import { VM_SCRIPTS } from "./vm/scripts";

/** The part of the container API this uses (a Durable Object's ctx.container). */
interface ContainerApi {
  readonly running: boolean;
  /** The images the Worker's version declares, by name (deploy/cloudflare.ts: "factory"). */
  readonly images?: Record<string, string>;
  start(opts: { image?: string; instance?: string; env?: Record<string, string>; enableInternet: boolean }): void;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout?(ms: number): void | Promise<void>;
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

const AGENT = 8080, PREVIEW = 4401;
/** How long a VM stays up after its Durable Object last heard from anyone: the most Cloudflare allows (the factory's alarm pings it more often). */
const IDLE_MS = 6 * 3600_000;
/** The image's name on the Worker's version (deploy/cloudflare.ts, FACTORY_IMAGE_NAME). */
export const IMAGE_NAME = "factory";
/** A VM's size: 2 vCPU, 8 GiB (Claude Code, the dev server and Chromium at once). FACTORY_VM_INSTANCE overrides it. */
const INSTANCE = "standard-3";

export class FactoryVm extends DurableObject<Env> {
  private get box(): ContainerApi {
    const c = (this.ctx as unknown as { container?: ContainerApi }).container;
    if (!c) throw new Error("FactoryVm has no container: the deploy declares it (deploy/targets.json, factory; README, The factory)");
    return c;
  }

  private async secret(): Promise<string> {
    let s = await this.ctx.storage.get<string>("secret");
    if (!s) { s = crypto.randomUUID(); await this.ctx.storage.put("secret", s); }
    return s;
  }

  /** Keeps a running container up for IDLE_MS after this call (a restarted object starts without the timeout). */
  private async touch() {
    if (this.box.running) await this.box.setInactivityTimeout?.(IDLE_MS);
  }

  /** Starts the container if it isn't running, and waits for its agent (the first start on a machine pulls the image: minutes). */
  async boot(): Promise<void> {
    const secret = await this.secret();
    if (!this.box.running) {
      const image = this.box.images?.[IMAGE_NAME] ?? this.env.FACTORY_IMAGE;
      if (!image) throw new Error("this Worker's version declares no factory image (deploy/targets.json, factory; the deploy's factory step)");
      this.box.start({ image, instance: this.env.FACTORY_VM_INSTANCE?.trim() || INSTANCE, env: { FACTORY_AGENT_SECRET: secret }, enableInternet: true });
    }
    let last = "";
    for (const until = Date.now() + 5 * 60_000; Date.now() < until;) {
      try {
        const r = await this.box.getTcpPort(AGENT).fetch("http://vm/health", { headers: { Authorization: `Bearer ${secret}` } });
        if (r.ok) { await this.touch(); return; }
        last = `it answered ${r.status}`;
      } catch (e) { last = (e as Error).message; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`the VM's agent didn't answer in 5 minutes (${last})`);
  }

  async job(script: string, args: string[], env: Record<string, string>, wait: boolean): Promise<{ code: number; output: string } | null> {
    await this.touch();
    const r = await this.box.getTcpPort(AGENT).fetch("http://vm/job", {
      method: "POST", headers: { Authorization: `Bearer ${await this.secret()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ script, args, env, wait, scripts: VM_SCRIPTS }),
    });
    if (!r.ok) throw new Error(`the VM's agent answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const out = wait ? await r.json() as { code: number; output: string } : null;
    await this.touch();
    return out;
  }

  async alive(): Promise<boolean> { await this.touch(); return this.box.running; }
  async stop(): Promise<void> { if (this.box.running) await this.box.destroy(); await this.ctx.storage.deleteAll(); }

  /** A request for the preview, sent on to the VM as if to localhost. */
  async preview(request: Request): Promise<Response> {
    if (!this.box.running) return new Response("This task's VM has stopped: its preview is gone.", { status: 410 });
    await this.touch();
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
      const name = vmName(task);
      await vm(name).boot();
      return { vm: name, preview: `https://${name}.${env.FACTORY_PREVIEW_DOMAIN!.trim()}` };
    },
    job: (name, script, args, jobEnv, wait) => vm(name).job(script, args, jobEnv, wait),
    stop: (name) => vm(name).stop(),
    alive: (name) => vm(name).alive(),
    // Erga's own repository (#39): its Git endpoint, which checks the factory's tokens and its branch rules (factory/git-grant.ts).
    repo: () => `${origin}/git/erga.git`,
  };
}

/** A new VM's name, and so its preview's host: task-<id>-<6 hex>. */
export const vmName = (task: number) => `task-${task}-${crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")}`;
const VM_NAME = /^task-\d+-[0-9a-f]{6}$/;

/**
 * A request to a preview host (<vm>.<FACTORY_PREVIEW_DOMAIN>), or null if it isn't one: another name under the
 * domain is a document's pages origin (front.ts), which the caller serves.
 */
export async function previewDoor(request: Request, env: Env, ticketOk: (vm: string, ticket: string) => Promise<boolean>): Promise<Response | null> {
  const domain = env.FACTORY_PREVIEW_DOMAIN?.trim();
  const url = new URL(request.url);
  if (!domain || !env.FACTORY_VM || !url.hostname.endsWith(`.${domain}`)) return null;
  const name = url.hostname.slice(0, -domain.length - 1);
  if (!VM_NAME.test(name)) return null;
  // Another host of the same domain (a document's page) mustn't reach the preview with the viewer's cookie.
  if (request.headers.get("sec-fetch-site") == "same-site") return new Response("Open this preview from the factory's board.", { status: 403 });
  const cookie = /(?:^|;\s*)factory_preview=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const ticket = url.searchParams.get("factory_ticket");
  if (ticket && (await ticketOk(name, ticket))) {
    url.searchParams.delete("factory_ticket");
    return new Response(null, { status: 302, headers: { Location: url.pathname + url.search, "Set-Cookie": `factory_preview=${ticket}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`, "Referrer-Policy": "no-referrer" } });
  }
  if (!cookie || !(await ticketOk(name, cookie))) return new Response("Open this preview from the factory's board.", { status: 403 });
  return env.FACTORY_VM.getByName(name).preview(request);
}
