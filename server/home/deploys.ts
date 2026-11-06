// The homepage's deploys: a deploy renders the homepage document, as it is
// now, into a snapshot (its page and its files), kept under a generation
// id that's never reused, and serve.ts serves / from the snapshot. This is
// the state machine; the Durable Object (cloudflare/objects/home.ts) gives
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
import { IDLE, renderHome, type DeployStatus } from "./render.ts";
import { addressOf } from "../../document/names.ts";
import { siteOf, type Site } from "./site.ts";

/** A deployed snapshot, as serve.ts serves it. */
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
  /** The site's settings, from its files (site.ts). */
  site: Site;
  at: number;
  version: number | null;
}

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
  alarm: { get(): Promise<number | null>; set(at: number): Promise<void>; delete(): Promise<void> };
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

interface State {
  state: DeployStatus["state"];
  at: number | null;
  version: number | null;
  error: string | null;
  /** The homepage's document, as last seen. */
  docId: string | null;
  /** Deploy again as soon as the one under way is done (it was asked for meanwhile). */
  again?: boolean;
  /** Who asked for the latest deploy (byLine); the system's own (after a new version, a new homepage) when not set. */
  by?: string | null;
}

const STATE = "state", LIVE = "live", FILE = "f:";

export class HomeDeploys implements HomeObject {
  private s: State = { ...IDLE, at: null, docId: null };
  private live: LivePage | null = null;
  /** Bumped whenever the homepage changes to another document: a deploy for the one before is thrown away. */
  private epoch = 0;
  private running = false;

  constructor(readonly deps: HomeDeps) {}

  /** Reads what's stored (before anything else runs); a deploy stopped in the middle (the object moved or restarted) runs again. */
  async load(): Promise<void> {
    this.s = (await this.deps.storage.get<State>(STATE)) ?? this.s;
    this.live = (await this.deps.storage.get<LivePage>(LIVE)) ?? null;
    // A snapshot from a release before sites had settings: read them from its files once.
    if (this.live && !this.live.site) {
      const gen = this.live.gen;
      this.live.site = await siteOf(async (path) => {
        const f = await this.file(gen, path);
        return f && new TextDecoder().decode(f.bytes);
      });
      await this.deps.storage.put(LIVE, this.live);
    }
    if (this.s.state == "deploying" && (await this.deps.alarm.get()) == null) await this.deps.alarm.set(Date.now());
  }

  async status(): Promise<DeployStatus> {
    const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());
    return {
      state: this.s.state,
      at: iso(this.s.at),
      version: this.s.version,
      error: this.s.state == "failed" ? this.s.error : null,
      by: this.s.by ?? byLine(SYSTEM),
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

  private async save(): Promise<void> {
    await this.deps.storage.put(STATE, this.s);
  }

  /** Everyone with the document open hears that its homepage state changed. */
  private async tell(...ids: (string | null | undefined)[]): Promise<void> {
    await Promise.all([...new Set(ids.filter((id): id is string => !!id))].map((id) =>
      this.deps.notify(id).catch((e: unknown) => this.deps.log(`couldn't tell ${id} about the homepage: ${e}`))));
  }

  async deploy(by?: string): Promise<DeployStatus> {
    this.s.by = by ?? null;
    if (this.s.state == "deploying") this.s.again = true;
    else {
      this.s.state = "deploying";
      await this.deps.alarm.set(Date.now());
    }
    await this.save();
    await this.tell(this.s.docId);
    return this.status();
  }

  /**
   * The landing_document setting changed: another homepage, or none. What's
   * live is the old one's, so it goes (/ is the viewer on the new one until
   * its deploy is done), and the new one deploys at once.
   */
  async homeChanged(): Promise<DeployStatus> {
    const doc = await this.homeDoc();
    const before = this.s.docId;
    if (doc && doc.id == this.live?.docId && doc.id == before) return this.status();
    this.epoch++;
    await this.drop();
    this.s = {
      state: doc ? "deploying" : "idle",
      at: null,
      version: null,
      error: null,
      docId: doc?.id ?? null,
      again: this.running && !!doc,
    };
    if (doc && !this.running) await this.deps.alarm.set(Date.now());
    await this.save();
    await this.tell(before, doc?.id);
    return this.status();
  }

  async ensure(): Promise<void> {
    if (this.live || this.s.state == "deploying") return;
    const doc = await this.homeDoc();
    if (!doc) return;
    if (doc.id != this.s.docId) return void (await this.homeChanged());
    this.s.state = "deploying";
    await this.deps.alarm.set(Date.now());
    await this.save();
    await this.tell(doc.id);
  }

  async forget(docId: string): Promise<void> {
    if (this.live?.docId != docId && this.s.docId != docId) return;
    this.epoch++;
    await this.drop();
    this.s = { ...IDLE, at: null, docId: null };
    await this.deps.alarm.delete();
    await this.save();
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
    await this.deps.storage.delete(LIVE);
    await this.prune(new Set());
  }

  /** Deletes every deploy's files but `keep`'s. */
  private async prune(keep: Set<string>): Promise<void> {
    const stale = (await this.deps.storage.list(FILE)).filter((k) => !keep.has(k.slice(FILE.length, k.indexOf(":", FILE.length))));
    for (let i = 0; i < stale.length; i += 128) await this.deps.storage.delete(stale.slice(i, i + 128));
  }

  /** The deploy itself, when its time comes (the alarm). */
  async alarm(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      do {
        this.s.again = false;
        this.s.state = "deploying";
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
          this.deps.log(`the homepage's deploy failed: ${message}`);
          Object.assign(this.s, { state: "failed", error: message });
        }
      } while (this.s.again);
      await this.save();
      await this.tell(this.s.docId);
    } finally {
      this.running = false;
    }
  }

  /** Renders the homepage as it is now and makes it the live snapshot. Null: there's no homepage. */
  private async run(): Promise<LivePage | null> {
    const doc = await this.homeDoc();
    if (!doc) { await this.drop(); return null; }
    this.s.docId = doc.id;
    const epoch = this.epoch;
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
    if (epoch != this.epoch) {
      await this.prune(new Set([this.live?.gen ?? ""]));
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
    const previous = this.live;
    await this.deps.storage.put(LIVE, live);
    this.live = live;
    // This deploy's files, and the one before's, for pages still open on it.
    await this.prune(new Set([gen, previous?.gen ?? ""]));
    return live;
  }
}
