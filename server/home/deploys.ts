// The homepage's deploys: a deploy renders the homepage document, as it is
// now, into a snapshot (its page and its files), kept under a generation
// id that's never reused, and serve.ts serves / from the snapshot. This is
// the IO of its state machine (deploy-state.ts); the Durable Object (cloudflare/objects/home.ts) gives
// it storage and an alarm, and forwards the calls.
//
// A new version of the homepage document doesn't deploy: the snapshot stays
// as it is until someone deploys again (Deploy in the document's settings, or
// the redeploy operation), and the deploy runs at once, on the alarm. A deploy
// that fails leaves the last good snapshot serving. Choosing
// another homepage (the landing_document setting, however it's set) drops
// the snapshot and deploys the new one at once; until it's done, / is the
// viewer on it, as it is when there's no snapshot at all (a fresh server,
// whose first / makes the homepage from assets/landing/ and starts its first
// deploy). Every change to the deploy's state is told to everyone who has
// the homepage document open ({ type: "home" } on its /api/events).

import { byLine, SYSTEM } from "../../shared/attribution.ts";
import type { Directory, DocRow } from "../directory/index.ts";
import { renderHome, type DeployStatus } from "./render.ts";
import { addressOf } from "../../document/names.ts";
import { siteOf } from "./site.ts";
import { type Deploy, type Event, INITIAL, next } from "./deploy-state.ts";
import { isLivePage, kept, type LivePage, type Retired } from "./snapshot.ts";

/** What the rest of the app may ask the homepage's deploys (the Durable Object answers, by RPC). */
export interface HomeObject {
  /** The deploy's state, as the API gives it. */
  status(): Promise<DeployStatus>;
  /** Deploys the homepage as it is now (Deploy); `by`: who asks (byLine). */
  deploy(by?: string): Promise<DeployStatus>;
  /** The landing_document setting changed: another homepage, or none. */
  homeChanged(): Promise<DeployStatus>;
  /** There's no snapshot to serve: deploys the homepage if nothing's under way. */
  ensure(): Promise<void>;
  /** A document was deleted: if it was the homepage, its snapshot goes. */
  forget(docId: string): Promise<void>;
  /** The snapshot, unless the caller already has this generation (`same`); null if there's none. */
  page(known?: string | null): Promise<{ same: true; gen: string } | { same: false; page: LivePage } | null>;
  /** One of a deploy's files. */
  file(gen: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null>;
}

/** A document's files as they are now, as a deploy reads them. */
export interface HomeFiles { index: string; files: Record<string, string | Uint8Array>; version: number | null }

/** What the deploys need from where they run. */
export interface HomeDeps {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    put(entries: Record<string, unknown>): Promise<void>;
    delete(key: string | string[]): Promise<unknown>;
    list(prefix: string): Promise<string[]>;
  };
  alarm: { set(at: number): Promise<void>; delete(): Promise<void> };
  directory: Directory;
  /** A document's files as they are now; null if there's no such document. */
  current(docId: string): Promise<HomeFiles | null>;
  /** Tells everyone with the document open that its homepage state changed. */
  notify(docId: string): Promise<void>;
  /** A file's media type, by its path. */
  mimeOf(path: string): string | null;
  /** Local development only: a page that asks for it fails its deploy (the tests check what that leaves). */
  testFailures?: boolean;
  log(line: string): void;
}

const STATE = "state",
  LIVE = "live",
  RETIRED = "retired",
  FILE = "f:";

export class HomeDeploys implements HomeObject {
  private s: Deploy = INITIAL;
  private live: LivePage | null = null;

  constructor(readonly deps: HomeDeps) {}

  /** Reads what's stored (before anything else runs). A copy of another shape (an older release's) is none. */
  async load(): Promise<void> {
    const live: unknown = await this.deps.storage.get(LIVE);
    this.live = isLivePage(live) ? live : null;
    if (live && !this.live) this.deps.log("the homepage's stored snapshot has an older shape: the next / deploys it again");
    await this.step({ type: "load", stored: await this.deps.storage.get(STATE), liveDoc: this.live?.docId ?? null });
  }

  /** Takes the event to the state (deploy-state.ts), and does what it says. */
  private async step(e: Event): Promise<void> {
    const before = this.s;
    const { s, fx } = next(before, e);
    this.s = s;
    if (fx.drop) await this.drop();
    if (fx.alarm == "set") await this.deps.alarm.set(Date.now());
    if (fx.alarm == "delete") await this.deps.alarm.delete();
    if (s !== before) await this.deps.storage.put(STATE, s);
    if (fx.tell) await this.tell(...fx.tell);
    if (fx.run != null) await this.step(await this.run(fx.run));
  }

  async status(): Promise<DeployStatus> {
    const s = this.s;
    return {
      state: s.state,
      at: this.live && new Date(this.live.at).toISOString(),
      version: this.live?.version ?? null,
      error: s.state == "failed" ? s.error : null,
      by: s.by ?? byLine(SYSTEM),
    };
  }

  /** The homepage's document as the database has it now (not as an isolate remembers it). */
  private async homeDoc(): Promise<DocRow | null> {
    const config = this.deps.directory.config;
    let ref: unknown = null;
    if (config.isLocked("landing_document")) ref = await config.get("landing_document");
    else { try { ref = JSON.parse((await config.stored("landing_document")) ?? "null"); } catch { ref = null; } }
    const doc = typeof ref == "string" && ref ? await this.deps.directory.find(ref) : null;
    return doc && !doc.test ? doc : null;
  }

  /** Everyone with the document open hears that its homepage state changed. */
  private async tell(...ids: (string | null | undefined)[]): Promise<void> {
    await Promise.all([...new Set(ids.filter((id): id is string => !!id))].map((id) =>
      this.deps.notify(id).catch((e: unknown) => this.deps.log(`couldn't tell ${id} about the homepage: ${e}`))));
  }

  async deploy(by?: string): Promise<DeployStatus> {
    await this.step({ type: "deploy", by: by ?? null });
    return this.status();
  }

  /**
   * The landing_document setting changed: another homepage, or none. What's
   * live is the old one's, so it goes (/ is the viewer on the new one until
   * its deploy is done), and the new one deploys at once.
   */
  async homeChanged(): Promise<DeployStatus> {
    await this.step({ type: "home", doc: (await this.homeDoc())?.id ?? null, liveDoc: this.live?.docId ?? null });
    return this.status();
  }

  async ensure(): Promise<void> {
    if (this.live || this.s.state == "deploying") return;
    await this.step({ type: "ensure", doc: (await this.homeDoc())?.id ?? null, live: !!this.live, now: Date.now() });
  }

  async forget(docId: string): Promise<void> {
    await this.step({ type: "forget", docId, liveDoc: this.live?.docId ?? null });
  }

  async page(known?: string | null): Promise<{ same: true; gen: string } | { same: false; page: LivePage } | null> {
    if (!this.live) return null;
    return known == this.live.gen ? { same: true, gen: known } : { same: false, page: this.live };
  }

  async file(gen: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    const bytes = await this.deps.storage.get<Uint8Array>(`${FILE}${gen}:${path}`);
    return bytes ? { bytes, type: this.deps.mimeOf(path) ?? "application/octet-stream" } : null;
  }

  private async drop(): Promise<void> {
    this.live = null;
    await this.deps.storage.delete([LIVE, RETIRED]);
    await this.prune(new Set());
  }

  /** Deletes every deploy's files but `keep`'s. */
  private async prune(keep: Set<string>): Promise<void> {
    const stale = (await this.deps.storage.list(FILE)).filter((k) => !keep.has(k.slice(FILE.length, k.indexOf(":", FILE.length))));
    await this.remove(stale);
  }

  private async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 128) await this.deps.storage.delete(keys.slice(i, i + 128));
  }

  /** The deploy itself, when its time comes. */
  async alarm(): Promise<void> {
    await this.step({ type: "alarm" });
  }

  /** One run for `epoch`, as the event that tells how it ended. */
  private async run(epoch: number): Promise<Event> {
    const ran = (outcome: { docId: string | null } | { error: string }): Event => ({ type: "ran", epoch, outcome, now: Date.now() });
    try {
      return ran({ docId: (await this.render(epoch))?.docId ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`the homepage's deploy failed: ${message}`);
      return ran({ error: message });
    }
  }

  /** Renders the homepage as it is now and makes it the live snapshot. Null: there's no homepage. */
  private async render(epoch: number): Promise<LivePage | null> {
    const doc = await this.homeDoc();
    if (!doc) { await this.drop(); return null; }
    const now = await this.deps.current(doc.id);
    if (!now) throw new Error("The homepage's document has no files.");
    const page = now.files[now.index];
    if (this.deps.testFailures && String(typeof page == "string" ? page : new TextDecoder().decode(page ?? new Uint8Array())).includes("erga:test-fail-deploy")) {
      throw new Error("This test page asks for its deploy to fail.");
    }
    const gen = `${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(36)).join("")}`;
    const text = (path: string) => {
      const f = now.files[path];
      return f == null ? null : typeof f == "string" ? f : new TextDecoder().decode(f);
    };
    const site = await siteOf(async (path) => text(path));
    const rendered = await renderHome({ index: now.index, files: now.files, gen, title: doc.title, doc: doc.id, bars: site.bars });
    const encoder = new TextEncoder();
    const entries = Object.entries(now.files).map(([path, data]) => [`${FILE}${gen}:${path}`, typeof data == "string" ? encoder.encode(data) : data] as const);
    for (let i = 0; i < entries.length; i += 64) await this.deps.storage.put(Object.fromEntries(entries.slice(i, i + 64)));
    // The homepage changed meanwhile: this run is thrown away, with its files.
    if (epoch != this.s.epoch) {
      await this.remove(entries.map(([key]) => key));
      return null;
    }
    const live: LivePage = {
      gen,
      docId: doc.id,
      address: addressOf(doc),
      before: rendered.before,
      after: rendered.after,
      files: Object.keys(now.files),
      site,
      at: Date.now(),
      version: now.version,
    };
    const { keep, retired } = kept(gen, this.live?.gen ?? null, (await this.deps.storage.get<Retired[]>(RETIRED)) ?? [], live.at);
    await this.deps.storage.put({ [LIVE]: live, [RETIRED]: retired });
    this.live = live;
    await this.prune(keep);
    return live;
  }
}
