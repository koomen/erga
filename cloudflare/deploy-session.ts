// One person's deploy, from /deploy (worker/deploy.ts): a Durable Object per
// session, named by a random id that only their browser has (with a key, in
// a cookie). It holds their Cloudflare token, sealed (AES-GCM) with a key
// made from that cookie's key and the server's SESSION_SECRET, so neither
// this storage nor the cookie alone can open it, and only for as long as the
// deploy takes: it's deleted when the deploy succeeds, when they forget it,
// and two hours after they connected at the latest. It's never logged, and
// never goes to D1. A token from Cloudflare's OAuth is also revoked at the end.
//
// Every call names who's asking (the front door's signed-in login), and only
// the person who connected may use the session. The deploy itself runs here
// (deploy/cloudflare.ts) and records each step as it goes; the page polls
// `info` to show them.

import { DurableObject } from "cloudflare:workers";
import {
  checkPlan, Cloudflare, deploy, DeployError, loadRelease, OAUTH, pagesShown, appHost, registerDomain, registrationStatus, searchDomains, STEPS,
  type DeployPlan, type Deployed, type DomainOffer, type Fetch, type StepId,
} from "../deploy/pipeline";
import { mockCloudflare, type MockState } from "../deploy/mock-cloudflare";
import { open, randomSecret, seal, type Sealed } from "../deploy/seal";
import type { Env } from "./env";

const SESSION = "session", RUN = "run";
const LIFETIME_MS = 2 * 60 * 60 * 1000;

interface Session { owner: string; via: "oauth" | "token"; created: number; sealed: Sealed | null; accounts: { id: string; name: string }[] }

export type StepState = { id: StepId; title: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
export interface RunState {
  status: "running" | "done" | "failed";
  started: number;
  ended?: number;
  steps: StepState[];
  error?: string;
  result?: Deployed;
  /** What was asked for, as the page shows it again. */
  summary: { app: string; pages: string; worker: string; account: string };
}
export type Answer<T> = ({ ok: true } & T) | { ok: false; error: string };

export class Deployer extends DurableObject<Env> {
  private mock: ReturnType<typeof mockCloudflare> | null = null;
  private running = false;

  /** Cloudflare, real or (local development with ERGA_DEPLOY_MOCK) pretend. */
  private net(mock: boolean): Fetch {
    if (!mock) return globalThis.fetch.bind(globalThis);
    this.mock ??= mockCloudflare({ delayMs: 40 });
    return this.mock.fetch;
  }

  private async session(owner: string): Promise<Session | null> {
    const s = await this.ctx.storage.get<Session>(SESSION);
    if (!s || s.owner != owner.toLowerCase()) return null;
    if (Date.now() - s.created > LIFETIME_MS) { await this.forgetAll(); return null; }
    return s;
  }

  /** The session's token, opened with the browser's key; an error saying what to do if there's none. */
  private async token(owner: string, key: string): Promise<{ session: Session; token: string } | { error: string }> {
    const session = await this.session(owner);
    if (!session?.sealed) return { error: "Connect your Cloudflare account first (it's forgotten after a deploy, and two hours after you connect)." };
    try { return { session, token: await open(session.sealed, key) }; } catch { return { error: "This browser's deploy session doesn't match: connect your Cloudflare account again." }; }
  }

  /** Takes a token (pasted, or from Cloudflare's OAuth), checks it, and keeps it sealed: the accounts it can reach. */
  async attach(owner: string, via: "oauth" | "token", token: string, key: string, mock: boolean): Promise<Answer<{ accounts: { id: string; name: string }[] }>> {
    token = token.trim();
    if (!/^[\w.-]{20,2000}$/.test(token) && !(mock && token.startsWith("mock-"))) return { ok: false, error: "That doesn't look like a Cloudflare API token: copy the whole token from the page Cloudflare showed after you made it." };
    try {
      const cf = new Cloudflare(token, this.net(mock));
      const accounts = ((await cf.call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50", "list your accounts")) ?? []).map((a) => ({ id: a.id, name: a.name }));
      if (!accounts.length) return { ok: false, error: "The token can't reach any account. Make it with the link on this page, which gives it access to your account." };
      await this.forgetAll();
      await this.ctx.storage.put(SESSION, { owner: owner.toLowerCase(), via, created: Date.now(), sealed: await seal(token, key), accounts } satisfies Session);
      await this.ctx.storage.setAlarm(Date.now() + LIFETIME_MS);
      return { ok: true, accounts };
    } catch (e) { return { ok: false, error: message(e) }; }
  }

  /** What the page needs to pick up where it was: connected or not, and the deploy's progress. */
  async info(owner: string): Promise<{ connected: boolean; via?: string; accounts?: { id: string; name: string }[]; expires?: number; run: RunState | null }> {
    const session = await this.session(owner);
    const stored = await this.ctx.storage.get<RunState & { owner?: string }>(RUN);
    const run = stored && stored.owner == owner.toLowerCase() ? (({ owner: _, ...r }) => r)(stored) : null;
    if (!session) return { connected: false, run };
    return { connected: !!session.sealed, via: session.via, accounts: session.accounts, expires: session.created + LIFETIME_MS, run };
  }

  /** An account's workers.dev subdomain and its domains (zones). */
  async account(owner: string, key: string, accountId: string, mock: boolean): Promise<Answer<{ subdomain: string | null; zones: { id: string; name: string; status: string }[] }>> {
    const t = await this.token(owner, key);
    if ("error" in t) return { ok: false, error: t.error };
    if (!t.session.accounts.some((a) => a.id == accountId)) return { ok: false, error: "Choose one of your accounts." };
    try {
      const cf = new Cloudflare(t.token, this.net(mock));
      const sub = await cf.call<{ subdomain: string }>("GET", `/accounts/${accountId}/workers/subdomain`, "read your workers.dev subdomain", undefined, { allow404: true }).catch((e) => {
        // An account that has never used Workers has none yet: that's a choice to make, not an error.
        if (e instanceof DeployError && e.status != 401 && e.status != 403) return null;
        throw e;
      });
      const zones = ((await cf.call<{ id: string; name: string; status: string }[]>("GET", `/zones?account.id=${accountId}&per_page=50`, "list your domains")) ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status }));
      return { ok: true, subdomain: sub?.subdomain ?? null, zones };
    } catch (e) { return { ok: false, error: message(e) }; }
  }

  async searchDomains(owner: string, key: string, accountId: string, q: string, mock: boolean): Promise<Answer<{ offers: DomainOffer[] }>> {
    const t = await this.token(owner, key);
    if ("error" in t) return { ok: false, error: t.error };
    try { return { ok: true, offers: await searchDomains(new Cloudflare(t.token, this.net(mock)), accountId, q) }; } catch (e) {
      const m = message(e);
      return { ok: false, error: /isn't allowed/.test(m) ? `${m} Buying a domain needs the Registrar permission: make the token with "Include buying a domain" ticked.` : m };
    }
  }

  /** Buys a domain, at the price the person confirmed (checked again first); waits up to ~20s for it to complete. */
  async register(owner: string, key: string, accountId: string, name: string, confirmed: { price: string; currency: string }, mock: boolean): Promise<Answer<{ state: string; completed: boolean }>> {
    const t = await this.token(owner, key);
    if ("error" in t) return { ok: false, error: t.error };
    try {
      const cf = new Cloudflare(t.token, this.net(mock));
      let r = await registerDomain(cf, accountId, name, confirmed);
      for (let i = 0; i < 10 && !r.completed && (r.state == "in_progress" || r.state == "pending"); i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        r = await registrationStatus(cf, accountId, name);
      }
      if (r.state == "failed" || r.state == "blocked") return { ok: false, error: `Cloudflare couldn't register ${name} (${r.state})${r.error ? `: ${r.error}` : ""}. Check the Registrar page in your dashboard.` };
      if (r.state == "action_required") return { ok: false, error: `Cloudflare needs something from you to finish registering ${name}${r.error ? ` (${r.error})` : ""}: open the Registrar page in your dashboard.` };
      return { ok: true, ...r };
    } catch (e) { return { ok: false, error: message(e) }; }
  }

  /** Starts the deploy (it carries on here; the page follows it with `info`). */
  async start(owner: string, key: string, plan: DeployPlan, mock: boolean): Promise<Answer<{ run: RunState }>> {
    if (this.running) return { ok: false, error: "A deploy is already running in this session." };
    const t = await this.token(owner, key);
    if ("error" in t) return { ok: false, error: t.error };
    if (!t.session.accounts.some((a) => a.id == plan.accountId)) return { ok: false, error: "Choose one of your accounts." };
    plan = { ...plan, admin: owner };
    const wrong = checkPlan(plan);
    if (wrong) return { ok: false, error: wrong };
    let unreadable = "";
    const release = await loadRelease(async (path) => {
      const r = await this.env.ASSETS.fetch(new Request(`http://localhost/release/${path.split("/").map(encodeURIComponent).join("/")}`));
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    }).catch((e) => { unreadable = message(e); return null; });
    if (!release) return { ok: false, error: unreadable || "This server has no release to deploy (it's built with the server's deploy: bun deploy/release.ts)." };
    const run: RunState & { owner: string } = {
      owner: owner.toLowerCase(), status: "running", started: Date.now(),
      steps: STEPS.map((s) => ({ id: s.id, title: s.title, status: "pending" })),
      summary: { app: `https://${appHost(plan)}`, pages: pagesShown(plan), worker: plan.workerName, account: t.session.accounts.find((a) => a.id == plan.accountId)?.name ?? plan.accountId },
    };
    const save = () => this.ctx.storage.put(RUN, run);
    await save();
    this.running = true;
    const net = this.net(mock);
    const work = (async () => {
      try {
        run.result = await deploy(new Cloudflare(t.token, net), release, plan, {
          sessionSecret: randomSecret(),
          site: net,
          report: (id, status, detail) => {
            const step = run.steps.find((s) => s.id == id)!;
            step.status = status;
            if (detail != null) step.detail = detail;
            void save();
          },
        });
        run.status = "done";
        // Done with the token: forget it, and give back what Cloudflare's OAuth gave.
        if (t.session.via == "oauth") await net(OAUTH.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.token, client_id: this.env.CLOUDFLARE_OAUTH_CLIENT_ID || "mock" }) }).catch(() => {});
        await this.ctx.storage.put(SESSION, { ...t.session, sealed: null });
      } catch (e) {
        run.status = "failed";
        const step = run.steps.find((s) => s.status == "running");
        if (step) step.status = "failed";
        // Which step, and what Cloudflare said. Every step can run again: Try again picks up where this stopped.
        run.error = `${step ? `Stopped at “${step.title}”. ` : ""}${message(e)}`;
      } finally {
        run.ended = Date.now();
        this.running = false;
        await save();
      }
    })();
    this.ctx.waitUntil(work);
    return { ok: true, run };
  }

  /** Forgets the token now (the run's record stays, for the page). */
  async forget(owner: string): Promise<void> {
    const s = await this.session(owner);
    if (s) await this.ctx.storage.put(SESSION, { ...s, sealed: null });
  }

  /** Local development: what the pretend Cloudflare was asked to do. */
  async mockState(): Promise<MockState | null> { return this.mock?.state ?? null; }

  private async forgetAll() { await this.ctx.storage.delete(SESSION); }

  async alarm() { await this.ctx.storage.deleteAll(); }
}

const message = (e: unknown) => (e instanceof DeployError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}. Try again.`);
