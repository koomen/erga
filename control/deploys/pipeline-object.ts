// The deploys' Durable Object (one, named "deploys"): it holds
// control/deploys/branches.ts, which decides everything, and gives it what only a
// Durable Object has: storage that outlives a restart, an alarm (each deploy
// runs in one), and the event stream (/api/events: {type: "deploys"} on each
// change, {type: "deploy-log"} with each deploy's new log lines, and whatever
// else is published here, e.g. the repository's {type: "source"}).
//
// It runs in the control Worker (control/index.ts), which builds commits in
// its own container (control/builder/) and deploys every target. Each
// target's deploy history (the last 100 deploys and their logs) is in this
// object's storage too.
//
// In local development with ERGA_DEPLOY_MOCK=1 the app's own Worker hosts it,
// and it deploys to the mock Cloudflare's Erga account with the mock
// builder, which "builds" a commit by stamping the server's own release with
// it: a push to staging deploys "staging" and a merge to main deploys
// "production", both in the mock.

import { DurableObject } from "cloudflare:workers";
import { BranchDeploys, type DeployEnv, type ReleaseTag, type TargetStatus } from "./branches";
import type { DeployLog, DeployRecord } from "./history";
import { fixedCredential, OAuthCredential, sealKeyFrom, type CredentialStatus, type TokenAnswer } from "./credential";
import { Cloudflare, DeployError } from "./cloudflare-api";
import { loadRelease, type Release } from "./release-format";
import { httpBlobs, ReleaseStore, type ReleasesView } from "./releases";
import { builderEndpoint, forkBuildBody, forkBuilder, forkHosts, forkRepo, hashSecret, isForkId, type ForkRecord } from "../install/forks";
import { installFleet } from "./fleet";
import { SOURCE } from "../../deploy/targets";
import { artifactsRemoteFor, forkOf, githubAppOf, hasSource, releaseStoreOf } from "../cloudflare";
import { FLEET_ACCOUNT, MOCK_SNAPSHOT_TOKEN, mockBuilder, mockCloudflare } from "../../dev/mock-cloudflare";
import { containerBuilder } from "../builder/client";
import { builderFetch, type BuilderEnv } from "../builder/worker";
import type { HostEnv } from "../env";
import { GithubError, installationToken, uninstall } from "../source/index.ts";
import { SYSTEM } from "../../shared/attribution";
import { sourceForBuild } from "../source/service";
import * as Effect from "effect/Effect";

export type RelayEvent = { type: string } & Record<string, unknown>;

/** An install made from this control Worker's /deploy: where its control Worker and app are, whose account, who did it, which release, its fork's id. */
export interface InstallRecord { control: string; app: string; staging?: string; accountId: string; by: string; at: number; version: string; fork?: string }

/**
 * The mock Cloudflare (ERGA_DEPLOY_MOCK=1): one for the Worker's isolate, not one for each instance of the object. The
 * runtime evicts an idle object and makes a new one, which reads the deploys' state from storage; a mock of its own
 * would have forgotten every Worker those deploys uploaded ("Worker erga-staging not found").
 */
let fleetMock: ReturnType<typeof mockCloudflare> | null = null;

/** The build containers' bindings, where this Worker has them (the control Worker; never the app). */
const buildsOf = (env: HostEnv): BuilderEnv | null =>
  env.BUILDS ? { BUILDS: env.BUILDS, CF_VERSION_METADATA: env.CF_VERSION_METADATA } : null;

export class Pipeline extends DurableObject<HostEnv> {
  private deploys: BranchDeploys;
  private store: ReleaseStore | null;
  private deps: { net: typeof globalThis.fetch };
  private credential: ReturnType<typeof fixedCredential> | OAuthCredential;
  private listeners = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private beat: ReturnType<typeof setInterval> | null = null;
  /** The mock's builder over HTTP, for forks' builds in local development (erga.dev's go to the build container). */
  private mockBuilds: ((request: Request) => Promise<Response>) | null = null;

  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    const mock = env.ERGA_DEPLOY_MOCK == "1";
    const deployEnv: DeployEnv = mock
      ? { CLOUDFLARE_ACCOUNT_ID: FLEET_ACCOUNT, SNAPSHOT_TOKEN: MOCK_SNAPSHOT_TOKEN }
      : { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, SNAPSHOT_TOKEN: env.SNAPSHOT_TOKEN };
    // The dev server's own release: the app hosts this object there, with its files (ASSETS).
    const release = async (): Promise<Release> => {
      const r = await loadRelease(async (path) => {
        const res = await env.ASSETS?.fetch(new Request(`http://localhost/release/${path.split("/").map(encodeURIComponent).join("/")}`));
        return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      });
      if (!r) throw new Error("this dev server has no release to stand in for a build (run bun deploy/release.ts)");
      return r;
    };
    // The mock builder fails a commit whose subject says "[mock-fail]" (a real commit's id can't be chosen to start 0bad).
    const mockFails = async (commit: string) => {
      if (!hasSource(env) || !env.SOURCE) return false;
      const view = await env.SOURCE.getByName("erga").branches(env.ERGA_DEV_ORIGIN ?? "").catch(() => null);
      return !!view?.branches.some((b: { commits: { sha: string; subject: string }[] }) => b.commits.some((c) => c.sha == commit && c.subject.includes("[mock-fail]")));
    };
    const fleet = mock ? (fleetMock ??= mockCloudflare({ fleet: true, stagingSecrets: true, delayMs: 25 })) : null;
    const net = fleet ? fleet.fetch : globalThis.fetch.bind(globalThis);
    this.deps = { net };
    // The Cloudflare credential: the OAuth grant an admin connected at /install (kept in this object's storage, sealed).
    // Under the mock with no client, a token the mock takes, so the dev server deploys with no consent.
    const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() ?? "";
    this.credential = mock && !clientId ? fixedCredential("mock-dev-deploys", "the mock") : new OAuthCredential({
      storage: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v), delete: (k) => ctx.storage.delete(k) },
      net, client: { id: clientId || "mock", ...(env.CLOUDFLARE_OAUTH_CLIENT_SECRET ? { secret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET } : {}) },
      sealKey: sealKeyFrom(env.SESSION_SECRET ?? ""), log: (l) => console.log(l),
    });
    const schedule = async (ms: number) => {
      const at = Date.now() + ms;
      const now = await ctx.storage.getAlarm();
      if (now == null || now > at) await ctx.storage.setAlarm(at);
    };
    this.store = releaseStoreOf(env);
    // A downstream's control Worker (control/deploys/fleet.ts): its three targets from its fork's branches; upstream's store and
    // build container, through the fork's secret, in the builder's place; and its repository's Update from upstream.
    const installed = installFleet(env);
    const upstream = installed?.upstream ? new ReleaseStore(httpBlobs(installed.upstream.origin, net)) : null;
    const fork = forkOf(env);
    const devOrigin = env.ERGA_DEV_ORIGIN ?? "";
    const repo = () => { if (!env.SOURCE || !hasSource(env)) throw new Error("This control Worker has no repository."); return env.SOURCE.getByName("erga"); };
    const builds = buildsOf(env);
    const mockBuild = mock ? mockBuilder(release, { delayMs: 200, fails: mockFails }) : null;
    this.deploys = new BranchDeploys({
      storage: { get: (k) => ctx.storage.get(k), put: (k, v) => ctx.storage.put(k, v), delete: (k) => ctx.storage.delete(k) },
      env: deployEnv,
      credential: this.credential,
      net,
      releases: installed ? null : this.store,
      releasesChanged: () => this.publish({ type: "releases" }),
      ...(installed ? {
        fleet: installed,
        upstream: {
          channel: () => upstream!.channel(installed.upstream!.channel),
          update: () => repo().update(devOrigin, { login: SYSTEM, name: "Erga" }),
          heads: () => repo().heads(devOrigin),
          // Its hosts, told to its fork at upstream when a domain is added or removed (the consent relay's allowed returns).
          ...(fork ? { hosts: (hosts: string[]) => forkHosts(fork, hosts, net) } : {}),
        },
      } : {}),
      // The build container, in this Worker (the control Worker's BUILDS objects), or the mock; a downstream fetches upstream's
      // releases, and has its own commits built at upstream.
      builder: upstream
        ? fork
          ? forkBuilder(fork, upstream, net)
          : null
        : (mockBuild ??
          (builds
            ? containerBuilder({ fetch: (input, init) => builderFetch(new Request(input, init), builds, (p) => ctx.waitUntil(p)) })
            : null)),
      schedule,
      changed: () => this.publish({ type: "deploys" }),
      logged: (event) => this.publish(event),
      // The commit to build: the repository's remote and a read token, through this Worker's own binding.
      source: async (commit) => {
        if (!env.ARTIFACTS) return null;
        const s = await sourceForBuild(env, commit);
        return { cloneUrl: s.remote, token: s.token.split("?")[0] };
      },
      ...(mock ? { waitMs: 5000, sleep: (ms: number) => Effect.runPromise(Effect.sleep(Math.min(ms, 50))) } : {}),
      // After the control Worker deployed itself: this object starts again on the new code (control/deploys/self-restart.ts).
      // Not under the mock: there the app's own Worker hosts this object, and the "control Worker" it deploys is the mock's.
      ...(mock ? {} : { restart: (why: string) => ctx.abort(why), runs: env.ERGA_VERSION }),
    });
    // The Ops page's ping, answered with no wake-up: an open page never keeps this object busy (and on old code).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // An install looks at upstream's channel now and then (control/deploys/branches.ts alarm): the first look soon after this object wakes.
    if (installed) ctx.blockConcurrencyWhile(async () => { if ((await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now() + 5000); });
    // Forks' builds, where this is erga.dev's control Worker under the mock: the mock builder, over the container's protocol.
    if (mockBuild && !installed) this.mockBuilds = builderEndpoint(mockBuild);
  }

  status(history = 0): Promise<{ targets: (TargetStatus & { history?: DeployRecord[] })[]; credential: CredentialStatus }> { return this.deploys.status({ history }); }
  // The Cloudflare credential (control/deploys/credential.ts): its status, a consent's grant kept, and forgotten (control/routes.ts, /install).
  credentialStatus(): Promise<CredentialStatus> { return this.deploys.credential(); }
  async connectCredential(answer: TokenAnswer, by: string): Promise<string> {
    if (!(this.credential instanceof OAuthCredential)) throw new Error("This server deploys with a fixed token: there's nothing to connect.");
    const token = await this.credential.connect(answer, by);
    // The deploys that waited for it go now; the Ops page hears of the new credential at once.
    await this.deploys.ready();
    this.publish({ type: "deploys" });
    return token;
  }
  async disconnectCredential(): Promise<void> { if (this.credential instanceof OAuthCredential) await this.credential.disconnect(); this.publish({ type: "deploys" }); }
  logOf(name: string, deployId?: string): Promise<DeployLog | null> { return this.deploys.logOf(name, deployId); }
  historyOf(name: string, limit?: number): Promise<DeployRecord[] | null> { return this.deploys.historyOf(name, limit); }
  hook(branch: string, commit: string, trigger?: string): Promise<void> { return this.deploys.hook(branch, commit, trigger); }
  redeploy(name: string, trigger?: string) { return this.deploys.redeploy(name, trigger); }
  /** A redeploy with options (redeploy, fresh_data: true): staging with a fresh copy of production's data. */
  redeployWith(name: string, trigger: string, o: { fresh?: boolean }) { return this.deploys.redeploy(name, trigger, o); }
  /** Back to the Worker version before the live deploy (rollback). */
  rollback(name: string, trigger?: string) { return this.deploys.rollback(name, trigger); }
  async alarm(): Promise<void> { await this.deploys.alarm(); }
  // Each environment's domains (deploys, view domains; set_domain).
  domains() { return this.deploys.domains(); }
  addDomain(name: string, hostname: string, by: string) { return this.deploys.addDomain(name, hostname, by); }
  removeDomain(name: string, hostname: string, by: string) { return this.deploys.removeDomain(name, hostname, by); }

  // ---- the installs made from here (/deploy, control/install/install.ts): remembered, so their control Workers may consent
  // through this Worker's OAuth callback (control/routes.ts, the relay), and the Ops page can list them.
  async installs(): Promise<InstallRecord[]> { return (await this.ctx.storage.get<InstallRecord[]>("installs")) ?? []; }
  async registerInstall(i: InstallRecord): Promise<void> {
    const list = (await this.installs()).filter((x) => x.control != i.control);
    list.unshift(i);
    await this.ctx.storage.put("installs", list.slice(0, 200));
    this.publish({ type: "installs" });
  }
  /** Whether `origin` (https://ops.example.com) is one of an install's Workers made from here (its control Worker, the app, staging, or a domain it added since). */
  async isInstall(origin: string): Promise<boolean> { return !!(await this.installOf(origin)); }
  private async installOf(origin: string): Promise<InstallRecord | null> {
    const installs = await this.installs();
    const direct = installs.find((x) => x.control == origin || x.app == origin || x.staging == origin);
    if (direct) return direct;
    const host = origin.replace(/^https:\/\//, "");
    const fork = (await this.forks()).find((f) => f.hosts?.includes(host));
    return fork ? installs.find((x) => x.fork == fork.id) ?? null : null;
  }

  // ---- the forks (control/install/forks.ts): each install's repository here, in Erga's Artifacts namespace, and its builds in this Worker's container.
  private async forks(): Promise<ForkRecord[]> { return (await this.ctx.storage.get<ForkRecord[]>("forks")) ?? []; }
  private async forkOf(id: string, secret: string): Promise<ForkRecord | null> {
    if (!isForkId(id) || !secret) return null;
    const hash = await hashSecret(secret);
    return (await this.forks()).find((f) => f.id == id && f.secretHash == hash) ?? null;
  }
  /**
   * Makes an install's fork before the install: the Artifacts repo fork-<id> (with this Worker's credential), seeded with
   * this repository's history up to `commit` (its main's head when not given) as main and staging. `secretHash`: the
   * install's FORK_SECRET, hashed; the secret itself is never here.
   */
  async makeFork(id: string, secretHash: string, commit: string | null, by: string): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
    if (!isForkId(id)) return { ok: false, error: "Not a fork id." };
    if (!this.env.SOURCE || !hasSource(this.env)) return { ok: false, error: "This control Worker has no repository to fork." };
    try {
      const origin = this.env.ERGA_DEV_ORIGIN ?? "";
      const source = this.env.SOURCE.getByName("erga");
      // A repository with no main yet (a fresh dev server) makes an empty fork: nothing to seed.
      const at = commit ?? (await source.heads(origin)).main ?? "";
      if (this.env.ARTIFACTS) {
        const cf = new Cloudflare(await this.credential.token(), this.deps.net);
        const base = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/artifacts/namespaces/${SOURCE.namespace}/repos`;
        const there = await cf.call<{ name: string }>("GET", `${base}/${forkRepo(id)}`, "find the fork's repo", undefined, { allow404: true });
        if (!there) await cf.call("POST", base, "make the fork's repo", { name: forkRepo(id), default_branch: "main", description: `A fork of Erga's source: an install's (${by})` });
      }
      if (at) {
        const remote = await artifactsRemoteFor(this.env, forkRepo(id), "write", origin);
        const seeded = await source.seedFork(origin, { url: remote.url, headers: remote.headers }, at);
        if ("error" in seeded) return { ok: false, error: seeded.error };
      }
      const list = (await this.forks()).filter((f) => f.id != id);
      list.push({ id, secretHash, commit: at, by, at: Date.now() });
      await this.ctx.storage.put("forks", list);
      return { ok: true, commit: at };
    } catch (e) {
      return { ok: false, error: e instanceof DeployError ? e.message : `The fork couldn't be made: ${(e as Error).message}` };
    }
  }
  private async saveFork(fork: ForkRecord): Promise<void> {
    await this.ctx.storage.put("forks", (await this.forks()).map((f) => (f.id == fork.id ? fork : f)));
  }
  /**
   * The GitHub App's consent relay saw an install's Worker (`origin`) connect installation `installationId`: the fork
   * owns it from now on (tokens are minted for it, its webhooks relayed to the install's control Worker).
   */
  async installationSeen(origin: string, installationId: number): Promise<boolean> {
    const install = await this.installOf(origin);
    const fork = install?.fork ? (await this.forks()).find((f) => f.id == install.fork) : null;
    if (!fork) return false;
    if (!fork.installations?.includes(installationId)) await this.saveFork({ ...fork, installations: [...(fork.installations ?? []), installationId] });
    return true;
  }
  /** A GitHub installation token for an install's connected repository (its secret checked; the installation must be its own). */
  async forkGithubToken(id: string, secret: string, installationId: number): Promise<{ token: string; expiresAt: number } | { error: string; status: number }> {
    const fork = await this.forkOf(id, secret);
    if (!fork) return { error: "No such fork, or the secret is wrong.", status: 403 };
    if (!fork.installations?.includes(installationId)) return { error: "That GitHub installation isn't this install's: connect GitHub from its Ops page.", status: 403 };
    const app = githubAppOf(this.env);
    if (!app?.privateKey) return { error: "This control Worker has no GitHub App key.", status: 503 };
    try { return await installationToken(app, installationId); } catch (e) { return { error: (e as Error).message, status: e instanceof GithubError ? e.status : 502 }; }
  }
  async forkGithubUninstall(id: string, secret: string, installationId: number): Promise<{ ok: true } | { error: string; status: number }> {
    const fork = await this.forkOf(id, secret);
    if (!fork) return { error: "No such fork, or the secret is wrong.", status: 403 };
    if (!fork.installations?.includes(installationId)) return { error: "That GitHub installation isn't this install's.", status: 403 };
    const app = githubAppOf(this.env);
    if (app?.privateKey) await uninstall(app, installationId).catch(() => {});
    await this.saveFork({ ...fork, installations: fork.installations.filter((i) => i != installationId) });
    return { ok: true };
  }
  /** An install's hosts, as it tells them (its domains changed): where its consents may come back to. */
  async forkHosts(id: string, secret: string, hosts: string[]): Promise<{ ok: true } | { error: string; status: number }> {
    const fork = await this.forkOf(id, secret);
    if (!fork) return { error: "No such fork, or the secret is wrong.", status: 403 };
    const clean = [...new Set(hosts.map((h) => String(h).trim().toLowerCase()).filter((h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)))].slice(0, 50);
    await this.saveFork({ ...fork, hosts: clean });
    return { ok: true };
  }
  /** Whose a GitHub installation is (the webhook's relay): the install's control Worker, and its fork secret's hash (the relay's signature key). */
  async forkOfInstallation(installationId: number): Promise<{ control: string; secretHash: string } | null> {
    const fork = (await this.forks()).find((f) => f.installations?.includes(installationId));
    const install = fork && (await this.installs()).find((x) => x.fork == fork.id);
    return fork && install ? { control: install.control, secretHash: fork.secretHash } : null;
  }
  /** A fork's repository, for its control Worker (its secret checked): the remote and a token of `scope`. */
  async forkAccess(id: string, secret: string, scope: "read" | "write"): Promise<{ remote: string; token: string; expiresAt: string } | null> {
    if (!(await this.forkOf(id, secret))) return null;
    const r = await artifactsRemoteFor(this.env, forkRepo(id), scope, this.env.ERGA_DEV_ORIGIN ?? "");
    return { remote: r.url, token: r.token, expiresAt: r.expiresAt };
  }
  /** A build of one of a fork's commits, in this Worker's container (the mock's, locally): the container's stream, as control/builder/client.ts reads it. */
  async forkBuild(id: string, secret: string, path: "build" | "cancel", buildId: string, body: string): Promise<Response> {
    if (!(await this.forkOf(id, secret))) return Response.json({ error: "No such fork, or the secret is wrong." }, { status: 403 });
    const source = await artifactsRemoteFor(this.env, forkRepo(id), "read", this.env.ERGA_DEV_ORIGIN ?? "");
    const request = new Request(`http://builder/${path}?id=${encodeURIComponent(buildId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: path == "build" ? forkBuildBody(body, { cloneUrl: source.url, token: source.token.split("?")[0] }) : body });
    if (this.mockBuilds) return this.mockBuilds(request);
    const builds = buildsOf(this.env);
    if (!builds) return Response.json({ error: "This control Worker has no build container." }, { status: 503 });
    return builderFetch(request, builds, (p) => this.ctx.waitUntil(p));
  }

  // ---- the release store (control/deploys/releases.ts): both channels; a release tag cut (stable follows the newest).
  async releases(): Promise<ReleasesView | null> {
    return this.store ? this.store.view() : null;
  }
  async tagged(t: ReleaseTag): Promise<void> {
    await this.deploys.channels.tagged(t);
  }

  /** An event to everyone listening on /api/events. */
  publish(event: RelayEvent): void {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const w of this.listeners) w.write(bytes).catch(() => this.listeners.delete(w));
    for (const ws of this.ctx.getWebSockets()) send(ws, JSON.stringify(event));
  }

  /** A hibernatable WebSocket closed (the page went away): closed here too. */
  webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code == 1005 || code == 1006 ? 1000 : code);
    } catch {
      /* closed already */
    }
  }
  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011);
    } catch {
      /* closed already */
    }
  }

  /**
   * /api/events (the routes have checked it is an admin): a WebSocket (the Ops page: it holds none of the browser's six
   * connections to the host), else server-sent events (an API client), one message of JSON each. The WebSocket is
   * hibernatable: the runtime holds it, the page pings it (setWebSocketAutoResponse), and this object can be evicted
   * with pages open, so it doesn't keep old code after a deploy. Its restart closes the socket, and the page connects
   * again.
   */
  async fetch(request?: Request): Promise<Response> {
    if (request?.headers.get("Upgrade")?.toLowerCase() == "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      send(server, JSON.stringify({ type: "hello" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    // A comment now and then keeps proxies from closing a quiet stream, and finds the ones that went away.
    this.beat ??= setInterval(() => {
      for (const w of this.listeners) w.write(new TextEncoder().encode(": ping\n\n")).catch(() => this.listeners.delete(w));
      if (!this.listeners.size && this.beat) {
        clearInterval(this.beat);
        this.beat = null;
      }
    }, 20_000);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.listeners.add(writer);
    writer.write(new TextEncoder().encode(`retry: 3000\ndata: ${JSON.stringify({ type: "hello" })}\n\n`)).catch(() => this.listeners.delete(writer));
    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }
}

/** A message to a WebSocket that may have gone. */
function send(ws: WebSocket, text: string): void {
  try {
    ws.send(text);
  } catch {
    /* gone: the runtime drops it */
  }
}
