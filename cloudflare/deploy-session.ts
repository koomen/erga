// One person's install, from /deploy (on the control Worker): a Durable
// Object per session, named by a random id that only their browser has (with
// a key, in a cookie). It holds their Cloudflare token, sealed (AES-GCM) with
// a key made from that cookie's key and the Worker's SESSION_SECRET, so
// neither this storage nor the cookie alone can open it, and only for as long
// as the install takes: it's deleted when the install succeeds, when they
// forget it, and two hours after they connected at the latest. It's never
// logged, and never goes to D1. A token from Cloudflare's OAuth is also
// revoked at the end. The GitHub App the manifest flow made for the install
// (its client secret) is kept the same way, until the install is done.
//
// Every call names who's asking (the front door's signed-in login), and only
// the person who connected may use the session. The install itself runs here
// (deploy/install.ts: the app and its control Worker, from a release of the
// store) and records each step as it goes; the page polls `info` to show them.

import { DurableObject } from "cloudflare:workers";
import {
  checkPlan, Cloudflare, DeployError, loadRelease, OAUTH, pagesShown, appHost, registerDomain, registrationStatus, searchDomains,
  type DeployPlan, type DomainOffer, type Fetch, type Release,
} from "../deploy/pipeline";
import { controlHostOf, INSTALL_STEPS, runInstall, stagingHostOf, type Installed } from "../deploy/install";
import { hashSecret } from "../deploy/forks";
import { mockCloudflare, type MockState } from "../deploy/mock-cloudflare";
import { open, randomSecret, seal, type Sealed } from "../deploy/seal";
import type { Env } from "./env";
import { releaseStoreOf } from "./releases";

const SESSION = "session", RUN = "run";
/** A fork's id: 16 lowercase letters and digits (deploy/forks.ts isForkId). */
const forkId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const LIFETIME_MS = 2 * 60 * 60 * 1000;

/** The GitHub App the manifest flow made for this install (cloudflare/deploy-routes.ts): its secret sealed as the token is. */
export interface GithubApp { name: string; clientId: string; url: string; sealed: Sealed }
interface Session { owner: string; via: "oauth" | "token"; created: number; sealed: Sealed | null; accounts: { id: string; name: string }[]; github?: GithubApp }

export type StepState = { id: string; title: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
export interface RunState {
  status: "running" | "done" | "failed";
  started: number;
  ended?: number;
  steps: StepState[];
  error?: string;
  result?: Installed;
  /** What was asked for, as the page shows it again. */
  summary: { app: string; pages: string; worker: string; account: string; control: string; staging: string; release: string };
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

  /** What the page needs to pick up where it was: connected or not, the GitHub App made, and the install's progress. */
  async info(owner: string): Promise<{ connected: boolean; via?: string; accounts?: { id: string; name: string }[]; expires?: number; githubApp?: { name: string; clientId: string; url: string }; run: RunState | null }> {
    const session = await this.session(owner);
    const stored = await this.ctx.storage.get<RunState & { owner?: string }>(RUN);
    const run = stored && stored.owner == owner.toLowerCase() ? (({ owner: _, ...r }) => r)(stored) : null;
    if (!session) return { connected: false, run };
    const githubApp = session.github ? { name: session.github.name, clientId: session.github.clientId, url: session.github.url } : undefined;
    return { connected: !!session.sealed, via: session.via, accounts: session.accounts, expires: session.created + LIFETIME_MS, ...(githubApp ? { githubApp } : {}), run };
  }

  /** The GitHub App the manifest flow made: kept with the session, its secret sealed with the browser's key. */
  async setGithubApp(owner: string, key: string, app: { name: string; clientId: string; secret: string; url: string }): Promise<Answer<{}>> {
    const session = await this.session(owner);
    if (!session) return { ok: false, error: "Connect your Cloudflare account first." };
    await this.ctx.storage.put(SESSION, { ...session, github: { name: app.name, clientId: app.clientId, url: app.url, sealed: await seal(app.secret, key) } } satisfies Session);
    return { ok: true };
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

  /**
   * The release an install deploys: the store's (deploy/releases.ts; stable's latest, or the version asked for), or in
   * local development the release in the server's own files.
   */
  private async release(version: string | undefined): Promise<{ release: Release; from: string } | { error: string }> {
    const store = releaseStoreOf(this.env);
    if (store) {
      const stable = await store.channel("stable");
      const want = version ?? stable.latest ?? undefined;
      if (want) {
        const r = await store.load(want).catch((e) => { throw new DeployError(`Release ${want} couldn't be read from the store: ${message(e)}`); });
        if (!r) return { error: `There's no release ${want} in the store.` };
        return { release: r, from: version ? `release ${want}` : `stable's latest, ${want}` };
      }
      if (!this.env.ASSETS) return { error: "No release is on stable yet: an admin promotes one on the Ops page (Releases) first." };
    }
    if (!this.env.ASSETS) return { error: "This server has no release store." };
    let unreadable = "";
    const r = await loadRelease(async (path) => {
      const res = await this.env.ASSETS.fetch(new Request(`http://localhost/release/${path.split("/").map(encodeURIComponent).join("/")}`));
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    }).catch((e) => { unreadable = message(e); return null; });
    if (!r) return { error: unreadable || "This server has no release to deploy (it's built with the server's deploy: bun deploy/release.ts)." };
    return { release: r, from: `this server's own release, ${r.version}` };
  }

  /** Starts the install (it carries on here; the page follows it with `info`). `origin`: this control Worker's address, the install's upstream. */
  async start(owner: string, key: string, plan: DeployPlan, mock: boolean, origin: string): Promise<Answer<{ run: RunState }>> {
    if (this.running) return { ok: false, error: "An install is already running in this session." };
    const t = await this.token(owner, key);
    if ("error" in t) return { ok: false, error: t.error };
    if (!t.session.accounts.some((a) => a.id == plan.accountId)) return { ok: false, error: "Choose one of your accounts." };
    // The GitHub App the manifest flow made, unless the page pasted an OAuth app's values.
    if (!plan.githubClientId?.trim() && t.session.github) {
      try { plan = { ...plan, githubClientId: t.session.github.clientId, githubClientSecret: await open(t.session.github.sealed, key) }; } catch { return { ok: false, error: "This browser's install session doesn't match: connect your Cloudflare account again." }; }
    }
    plan = { ...plan, admin: owner };
    const wrong = checkPlan(plan);
    if (wrong) return { ok: false, error: wrong };
    let got: Awaited<ReturnType<Deployer["release"]>>;
    try { got = await this.release(plan.version); } catch (e) { return { ok: false, error: message(e) }; }
    if ("error" in got) return { ok: false, error: got.error };
    const { release } = got;
    const run: RunState & { owner: string } = {
      owner: owner.toLowerCase(), status: "running", started: Date.now(),
      steps: INSTALL_STEPS.map((s) => ({ id: s.id, title: s.title, status: "pending" })),
      summary: { app: `https://${appHost(plan)}`, pages: pagesShown(plan), worker: plan.workerName, account: t.session.accounts.find((a) => a.id == plan.accountId)?.name ?? plan.accountId, control: `https://${controlHostOf(plan)}`, staging: `https://${stagingHostOf(plan)}`, release: release.version },
    };
    const save = () => this.ctx.storage.put(RUN, run);
    await save();
    this.running = true;
    const net = this.net(mock);
    const work = (async () => {
      try {
        // The install's fork first (deploy/forks.ts): its repository here, seeded at the release's commit, which its
        // control Worker reaches with a secret only it and the hash here know.
        const fork = { id: forkId(), secret: randomSecret() };
        const made = await this.env.PIPELINE?.getByName("deploys").makeFork(fork.id, await hashSecret(fork.secret), (await this.commitOf(release)) ?? null, owner.toLowerCase());
        if (!made) throw new DeployError("This server has no deploys' object to keep the install's fork.");
        if (!made.ok) throw new DeployError(`The install's repository (a fork of Erga's) couldn't be made: ${made.error}`);
        run.result = await runInstall(new Cloudflare(t.token, net), release, plan, {
          sessionSecret: randomSecret(), controlSecret: randomSecret(), snapshotToken: randomSecret(), fork,
          upstream: { origin, clientId: this.env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() || (mock ? "mock" : "") },
          site: net,
          report: (id, status, detail) => {
            const step = run.steps.find((s) => s.id == id)!;
            step.status = status;
            if (detail != null) step.detail = detail;
            void save();
          },
        });
        run.status = "done";
        // Done with the token: forget it, and give back what Cloudflare's OAuth gave. The GitHub App's secret goes with it.
        if (t.session.via == "oauth") await net(OAUTH.revoke, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.token, client_id: this.env.CLOUDFLARE_OAUTH_CLIENT_ID || "mock" }) }).catch(() => {});
        await this.ctx.storage.put(SESSION, { ...t.session, sealed: null, github: undefined });
        // Upstream remembers the install: its control Worker may consent through the relay (control/routes.ts), and the Ops page lists it.
        await this.env.PIPELINE?.getByName("deploys").registerInstall({ control: run.result.control, app: run.result.url, accountId: plan.accountId, by: owner.toLowerCase(), at: Date.now(), version: release.version, fork: fork.id }).catch((e) => console.log(`the install wasn't registered: ${message(e)}`));
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

  /** The commit a release of the store was built from (its manifest says), for the fork's seed; null for this server's own release (the repository's main, then). */
  private async commitOf(release: Release): Promise<string | null> {
    const store = releaseStoreOf(this.env);
    const m = store ? await store.manifest(release.version).catch(() => null) : null;
    return m?.commit ?? null;
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
