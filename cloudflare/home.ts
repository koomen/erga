// The homepage on Cloudflare (server/home.ts is the platform-neutral half): its
// deploys, in one Durable Object (`Home`, named "home"), and serving them
// at / from the edge.
//
// A deploy renders the homepage document's published version
// into a snapshot: its page and its files, kept in the
// Durable Object's storage under a generation id that's never reused. The
// Worker serves / from that snapshot, remembered in the isolate and in the
// colo's cache (the Cache API), and checks with the Durable Object for a newer
// one at most every few seconds, after answering (stale-while-revalidate), so
// / never waits on anything but the snapshot, and usually not even on that.
// The files are at /_home/<gen>/<path>, cached for good. On workers.dev,
// which has no Cache API, it serves from the isolate's memory alone.
//
// Why not Cloudflare Pages, KV or static assets: Pages is a second project
// with an API token as a secret, and / belongs to this Worker, so it would
// fetch each page from Pages, a hop more than its own cache; KV needs a
// namespace for every deploy (and /deploy making one); static assets need a
// Worker deploy. This needs nothing outside the Worker, and works the same
// locally and on /deploy'ed servers.
//
// When the homepage's published version changes, the next deploy runs about
// five minutes later (ERGA_HOME_DELAY_MS), each change pushing it back
// (debounced), on the object's alarm; "Redeploy now" (POST
// /api/docs/<id>/home/deploy) runs it at once. A deploy that fails leaves
// the last good snapshot serving. Choosing another homepage (the
// landing_document setting, however it's set) drops the snapshot and deploys
// the new one at once; until it's done, / is the viewer on it, as
// it is when there's no snapshot at all (a fresh server, whose first / makes
// the homepage from assets/landing/ and starts its first deploy).
//
// Every change to the deploy's state is told to everyone who has the
// homepage document open ({ type: "home" } on its /api/events).

import { DurableObject } from "cloudflare:workers";
import { accountOf, OWN_ACCOUNT } from "../server/pages/index.ts";
import { roleMay, type DocRow } from "../server/directory";
import { link } from "../server/pages/index.ts";
import { mayDeploy } from "../server/deploys/access";
import { whoOf, type Platform } from "../server/platform";
import { HOME_FILES, homeHeader, IDLE, renderHome, type DeployStatus } from "../server/home";
import { mimeOf } from "../document/host";
import { directoryOf } from "./d1";
import { byLine, SYSTEM } from "../shared/attribution";
import type { Env } from "./env";
import { publishedFiles } from "./published";

/** A deployed snapshot, as the Worker serves it. */
export interface LivePage {
  gen: string;
  docId: string;
  /** The document's address when it was deployed (its Edit link: a later rename redirects). */
  address: string;
  /** The page, split where the controls go. */
  before: string;
  after: string;
  /** Every file it has, by path (the page among them, as it is in the document). */
  files: string[];
  at: number;
  version: number | null;
}

interface State {
  state: DeployStatus["state"];
  at: number | null;
  scheduledFor: number | null;
  version: number | null;
  error: string | null;
  /** The homepage's document, as last seen. */
  docId: string | null;
  /** Deploy again as soon as the one under way is done (it was asked for meanwhile). */
  again?: boolean;
  /** Who asked for the latest deploy (byLine); the system's own (after a publish, a new homepage) when not set. */
  by?: string | null;
}

const STATE = "state", LIVE = "live", FILE = "f:";
const FIVE_MINUTES = 5 * 60 * 1000;

export class Home extends DurableObject<Env> {
  private s: State = { ...IDLE, at: null, scheduledFor: null, docId: null };
  private live: LivePage | null = null;
  /** Bumped whenever the homepage changes to another document: a deploy for the one before is thrown away. */
  private epoch = 0;
  private running = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<State>(STATE)) ?? this.s;
      this.live = (await ctx.storage.get<LivePage>(LIVE)) ?? null;
      // Stopped in the middle of a deploy (the object was moved or restarted): it runs again.
      if (this.s.state == "deploying" && (await ctx.storage.getAlarm()) == null) await ctx.storage.setAlarm(Date.now());
    });
  }

  private delay(): number {
    const ms = Number(this.env.ERGA_HOME_DELAY_MS);
    return ms > 0 ? ms : FIVE_MINUTES;
  }

  /** The deploy's state, as the API gives it. */
  async status(): Promise<DeployStatus> {
    const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
    return { state: this.s.state, at: iso(this.s.at), scheduledFor: iso(this.s.scheduledFor), version: this.s.version, error: this.s.state == "failed" ? this.s.error : null, by: this.s.by ?? byLine(SYSTEM) };
  }

  /** The homepage's document as the database has it now (not as an isolate remembers it). */
  private async homeDoc(): Promise<DocRow | null> {
    const config = directoryOf(this.env).config;
    let ref: unknown = null;
    if (config.isLocked("landing_document")) ref = await config.get("landing_document");
    else { try { ref = JSON.parse((await config.stored("landing_document")) ?? "null"); } catch { ref = null; } }
    const doc = typeof ref == "string" && ref ? await directoryOf(this.env).find(ref) : null;
    return doc && !doc.test ? doc : null;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(STATE, this.s);
  }

  /** Everyone with the document open hears that its homepage state changed. */
  private async tell(...ids: (string | null | undefined)[]): Promise<void> {
    await Promise.all([...new Set(ids.filter((id): id is string => !!id))].map((id) =>
      this.env.DOCUMENTS.getByName(id).notify({ type: "home" }).catch((e: unknown) => console.log(`couldn't tell ${id} about the homepage: ${e}`))));
  }

  /**
   * A document's published version changed: if it's the homepage, its deploy
   * is (re)scheduled for the delay from now, however many changes come.
   */
  async changed(docId: string): Promise<DeployStatus> {
    const home = await this.homeDoc();
    if (home?.id != docId) return this.status();
    this.s.docId = docId;
    this.s.scheduledFor = Date.now() + this.delay();
    this.s.by = null;
    if (this.s.state != "deploying") {
      this.s.state = "scheduled";
      await this.ctx.storage.setAlarm(this.s.scheduledFor);
    }
    await this.save();
    await this.tell(docId);
    return this.status();
  }

  /** Deploys now (Redeploy now), whatever was scheduled. */
  async deploy(by?: string): Promise<DeployStatus> {
    this.s.scheduledFor = null;
    this.s.by = by ?? null;
    if (this.s.state == "deploying") this.s.again = true;
    else {
      this.s.state = "deploying";
      await this.ctx.storage.setAlarm(Date.now());
    }
    await this.save();
    await this.tell(this.s.docId);
    return this.status();
  }

  /**
   * The landing_document setting changed (server/settings.ts tells the Worker, which
   * tells this): another homepage, or none. What's live is the old one's, so
   * it goes (/ is the viewer on the new one until its deploy is done), and the
   * new one deploys at once.
   */
  async homeChanged(): Promise<DeployStatus> {
    const doc = await this.homeDoc();
    const before = this.s.docId;
    if (doc && doc.id == this.live?.docId && doc.id == before) return this.status();
    this.epoch++;
    await this.drop();
    this.s = { state: doc ? "deploying" : "idle", at: null, scheduledFor: null, version: null, error: null, docId: doc?.id ?? null, again: this.running && !!doc };
    if (doc && !this.running) await this.ctx.storage.setAlarm(Date.now());
    await this.save();
    await this.tell(before, doc?.id);
    return this.status();
  }

  /** There's no snapshot to serve (the Worker found none): deploys the homepage if nothing's under way. */
  async ensure(): Promise<void> {
    if (this.live || this.s.state == "deploying" || this.s.state == "scheduled") return;
    const doc = await this.homeDoc();
    if (!doc) return;
    if (doc.id != this.s.docId) return void (await this.homeChanged());
    this.s.state = "deploying";
    await this.ctx.storage.setAlarm(Date.now());
    await this.save();
    await this.tell(doc.id);
  }

  /** A document was deleted: if it was the homepage, its snapshot goes (the next / makes a new homepage). */
  async forget(docId: string): Promise<void> {
    if (this.live?.docId != docId && this.s.docId != docId) return;
    this.epoch++;
    await this.drop();
    this.s = { ...IDLE, at: null, scheduledFor: null, docId: null };
    await this.ctx.storage.deleteAlarm();
    await this.save();
  }

  /** The snapshot, unless the caller already has this generation (`same`); null if there's none. */
  async page(known?: string | null): Promise<{ same: true; gen: string } | { same: false; page: LivePage } | null> {
    if (!this.live) return null;
    return known == this.live.gen ? { same: true, gen: known } : { same: false, page: this.live };
  }

  /** One of a deploy's files. */
  async file(gen: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    const bytes = await this.ctx.storage.get<Uint8Array>(`${FILE}${gen}:${path}`);
    return bytes ? { bytes, type: mimeOf(path) ?? "application/octet-stream" } : null;
  }

  private async drop(): Promise<void> {
    this.live = null;
    await this.ctx.storage.delete(LIVE);
    await this.prune(new Set());
  }

  /** Deletes every deploy's files but `keep`'s. */
  private async prune(keep: Set<string>): Promise<void> {
    const stale = [...(await this.ctx.storage.list({ prefix: FILE })).keys()].filter((k) => !keep.has(k.slice(FILE.length, k.indexOf(":", FILE.length))));
    for (let i = 0; i < stale.length; i += 128) await this.ctx.storage.delete(stale.slice(i, i + 128));
  }

  /** The deploy itself, when its time comes. */
  async alarm(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      do {
        this.s.again = false;
        this.s.state = "deploying";
        this.s.scheduledFor = null;
        await this.save();
        await this.tell(this.s.docId);
        const epoch = this.epoch;
        try {
          const done = await this.run();
          if (epoch != this.epoch) continue;
          if (done) Object.assign(this.s, { state: "deployed", at: done.at, version: done.version, error: null, docId: done.docId });
          else Object.assign(this.s, { state: "idle", error: null });
        } catch (e) {
          if (epoch != this.epoch) continue;
          const message = e instanceof Error ? e.message : String(e);
          console.log(`the homepage's deploy failed: ${message}`);
          Object.assign(this.s, { state: "failed", error: message });
        }
      } while (this.s.again);
      // Changes that came while it ran: the next deploy is scheduled for the delay after the last of them.
      if (this.s.scheduledFor != null) {
        this.s.state = "scheduled";
        await this.ctx.storage.setAlarm(this.s.scheduledFor);
      }
      await this.save();
      await this.tell(this.s.docId);
    } finally {
      this.running = false;
    }
  }

  /** Renders the homepage's published version and makes it the live snapshot. Null: there's no homepage. */
  private async run(): Promise<LivePage | null> {
    const doc = await this.homeDoc();
    if (!doc) { await this.drop(); return null; }
    this.s.docId = doc.id;
    const epoch = this.epoch;
    const published = await publishedFiles(this.env, doc.id);
    if (!published) throw new Error("The homepage's document has no files.");
    const page = published.files[published.index];
    // Local development only: a page that asks for it fails its deploy (e2e/home/switch.e2e.ts checks what that leaves).
    if (this.env.ERGA_LINK_SECRET && String(typeof page == "string" ? page : new TextDecoder().decode(page ?? new Uint8Array())).includes("erga:test-fail-deploy")) {
      throw new Error("This test page asks for its deploy to fail.");
    }
    const gen = `${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(36)).join("")}`;
    const rendered = await renderHome({ index: published.index, files: published.files, gen, title: doc.title });
    const encoder = new TextEncoder();
    const entries = Object.entries(published.files).map(([path, data]) => [`${FILE}${gen}:${path}`, typeof data == "string" ? encoder.encode(data) : data] as const);
    for (let i = 0; i < entries.length; i += 64) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 64)));
    if (epoch != this.epoch) { await this.prune(new Set([this.live?.gen ?? ""])); return null; }
    const live: LivePage = { gen, docId: doc.id, address: `/${doc.owner}/${doc.slug}`, before: rendered.before, after: rendered.after, files: Object.keys(published.files), at: Date.now(), version: published.version };
    const previous = this.live;
    await this.ctx.storage.put(LIVE, live);
    this.live = live;
    // This deploy's files, and the one before's, for pages still open on it.
    await this.prune(new Set([gen, previous?.gen ?? ""]));
    return live;
  }
}

// ---------------------------------------------------------------- serving

const homeObject = (env: Env) => env.HOME.getByName("home");

/** The snapshot as this isolate last had it, and when it last asked whether it's still current. */
let memo: { page: LivePage; checked: number } | null = null;
let refreshing: Promise<LivePage | null> | null = null;

const recheckMs = (env: Env) => { const ms = Number(env.ERGA_HOME_RECHECK_MS); return Number.isFinite(ms) && env.ERGA_HOME_RECHECK_MS ? ms : 5000; };
const cacheKey = (url: URL) => new Request(`${url.origin}${HOME_FILES}page`);
const edgeCache = (): Cache | null => { try { return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null; } catch { return null; } };

/** Forgets the snapshot this isolate and its colo remember (after the homepage changed, through this isolate). */
export async function forgetHome(url: URL): Promise<void> {
  memo = null;
  await edgeCache()?.delete(cacheKey(url)).catch(() => false);
}

/** Asks the Durable Object for the snapshot (only what's changed), and remembers it here and in the colo's cache. */
function refresh(env: Env, url: URL): Promise<LivePage | null> {
  return refreshing ??= (async () => {
    const answer = await homeObject(env).page(memo?.page.gen ?? null);
    const cache = edgeCache();
    if (!answer) {
      memo = null;
      await cache?.delete(cacheKey(url)).catch(() => false);
      return null;
    }
    const page = answer.same ? memo!.page : answer.page;
    const checked = Date.now();
    memo = { page, checked };
    await cache?.put(cacheKey(url), new Response(JSON.stringify(page), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", "x-checked": String(checked) } })).catch(() => {});
    return page;
  })().finally(() => { refreshing = null; });
}

/** The snapshot to serve, and where it came from: this isolate, the colo's cache or the Durable Object. */
async function livePage(env: Env, ctx: ExecutionContext, url: URL): Promise<{ page: LivePage; from: string } | null> {
  // 0 (local development, tests): nothing remembered, every / asks the Durable Object.
  if (recheckMs(env) == 0) { const page = await refresh(env, url); return page && { page, from: "home" }; }
  const stale = (checked: number) => Date.now() - checked >= recheckMs(env);
  const later = (p: Promise<unknown>) => ctx.waitUntil(p.catch((e) => console.log(`couldn't check the homepage: ${e}`)));
  if (memo) {
    if (stale(memo.checked)) later(refresh(env, url));
    return { page: memo.page, from: "memory" };
  }
  const cached = await edgeCache()?.match(cacheKey(url)).catch(() => undefined);
  if (cached) {
    try {
      const page = await cached.json() as LivePage;
      const checked = Number(cached.headers.get("x-checked")) || 0;
      if (!memo) memo = { page, checked };
      if (stale(checked)) later(refresh(env, url));
      return { page, from: "cache" };
    } catch { /* unreadable: ask */ }
  }
  const page = await refresh(env, url);
  return page && { page, from: "home" };
}

/**
 * / on the app's own site: the homepage's snapshot, with its controls for
 * whoever's asking. The page goes out at once; the controls follow as soon as
 * it's known who's asking (signed out, that's at once too). Null when there's
 * no snapshot yet: the caller shows the viewer, and a deploy starts.
 */
export async function serveHome(request: Request, env: Env, ctx: ExecutionContext, platform: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  const live = await livePage(env, ctx, url);
  if (!live) {
    ctx.waitUntil(homeObject(env).ensure().catch((e) => console.log(`couldn't start the homepage's deploy: ${e}`)));
    return null;
  }
  const { page, from } = live;
  const controls = (async () => {
    const session = await platform.sessionOf(request);
    const who = session && whoOf(session);
    const dir = platform.directory;
    // Only admins may edit the homepage: their role is asked of the database only if they are one
    // (whether someone is, the isolate remembers for a few seconds), so for anyone else, signed out above all, nothing is.
    const admin = !!who && !session.test && !session.agent && (await dir.users.isAdmin(who));
    const doc = { id: page.docId, owner: page.address.split("/")[1], test: false };
    const role = admin ? await dir.access(who, doc) : null;
    return homeHeader({
      clone: link("/new?from=landing", session),
      edit: session && !session.agent && roleMay(role, "edit") ? `${link(page.address, session)}#edit` : null,
      account: accountOf(session, admin, await mayDeploy(dir, session)),
      here: url.pathname + url.search,
      doc: page.docId,
    });
  })();
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    // Different for each person (the controls): never kept for someone else; checked each time.
    "Cache-Control": "private, no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
    "Server-Timing": `home;desc="${from}"`,
    [OWN_ACCOUNT]: "1",
  };
  if (request.method == "HEAD") { controls.catch(() => {}); return new Response(null, { headers }); }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(encoder.encode(page.before));
      let header = "";
      try { header = await controls; } catch (e) { console.log(`the homepage's controls failed: ${e}`); }
      c.enqueue(encoder.encode(header + page.after));
      c.close();
    },
  });
  return new Response(body, { headers });
}

/** One of a deploy's files, /_home/<gen>/<path>: the same forever, so kept for good, in the browser and the colo's cache. */
export async function serveHomeFile(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const [, gen, rest] = /^\/_home\/([a-z0-9]+)\/(.+)$/.exec(url.pathname) ?? [];
  let path: string | null = null;
  try { path = rest ? decodeURIComponent(rest) : null; } catch { path = null; }
  if ((request.method != "GET" && request.method != "HEAD") || !gen || !path) return new Response("Not found", { status: 404 });
  const cache = edgeCache();
  const key = new Request(url.origin + url.pathname);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return request.method == "HEAD" ? new Response(null, hit) : hit;
  const file = await homeObject(env).file(gen, path);
  if (!file) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const response = new Response(file.bytes, { headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" } });
  if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return request.method == "HEAD" ? new Response(null, response) : response;
}

/**
 * A path at the root that may be one of the homepage's own files (a link to
 * its other pages, a file its script fetches by a relative URL): the current
 * deploy's, if it has it. Null otherwise (the path is the app's).
 */
export async function serveHomeRoot(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  let rel: string;
  try { rel = decodeURIComponent(url.pathname.slice(1)); } catch { return null; }
  const live = await livePage(env, ctx, url);
  if (!live || !live.page.files.includes(rel)) return null;
  const file = await homeObject(env).file(live.page.gen, rel);
  if (!file) return null;
  return new Response(request.method == "HEAD" ? null : file.bytes, { headers: { "Content-Type": file.type, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
}
