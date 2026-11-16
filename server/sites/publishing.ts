// A domain's publishing: a publish renders the linked document, as it is now, into a snapshot (its page and its
// files), kept under a generation id that's never reused, and serve.ts serves the domain from the snapshot. This is the
// IO of the domain's state machine (state.ts); the Durable Object (cloudflare/objects/site.ts), one for each domain,
// gives it storage and an alarm, and forwards the calls.
//
// Nothing publishes by itself: a new version of the document, or a link to another document, leaves the snapshot as it
// is until someone publishes (Publish in the document's settings, or publish_document), and the publish runs at once,
// on the alarm. A publish that fails leaves the last good snapshot serving. "Not published" drops the snapshot at once.
// Every change of the state is told to everyone who has the document open ({ type: "publishing" } on its /api/events).

import type { DocRow } from "../directory/index.ts";
import { addressOf } from "../../document/model/names.ts";
import { addressesOf, REDIRECTS } from "./addresses.ts";
import { renderSite } from "./render.ts";
import { type Answer, isLivePage, kept, type LivePage, type Retired, tagOf } from "./snapshot.ts";
import { type Event, FREE, type Live, type Refusal, type Site, type SiteStatus, statusOf, step } from "./state.ts";

/** What the object answers to a change: the state after it, and why it did nothing, if it didn't. */
export interface Changed {
  status: SiteStatus;
  refused?: Refusal;
}

/** What the rest of the app may ask a domain's publishing (the Durable Object answers, by RPC). */
export interface SiteObject {
  /** The domain's state, as the API gives it. */
  status(): Promise<SiteStatus>;
  /** Links a document to the domain, with its header bar; `replace`: also when another document has the domain. */
  link(o: { doc: string; bars: boolean; replace: boolean; by: string }): Promise<Changed>;
  /** Publishes the linked document as it is now; `by`: who asks (byLine). */
  publish(doc: string, by: string): Promise<Changed>;
  /** "Not published": the document leaves the domain, which serves nothing from then on. */
  unlink(doc: string): Promise<SiteStatus>;
  /** A document was deleted: its link and its snapshot go. */
  forget(doc: string): Promise<void>;
  /** What the domain serves, unless the caller already has it (`known`: its tag); null if it serves nothing. */
  served(known?: string | null): Promise<Answer>;
  /** One of a snapshot's files. */
  file(gen: string, path: string): Promise<{ bytes: Uint8Array; type: string } | null>;
}

/** A document's files as they are now, as a publish reads them. */
export interface SiteFiles {
  index: string;
  files: Record<string, string | Uint8Array>;
  version: number | null;
}

/** What a domain's publishing needs from where it runs. */
export interface PublishingDeps {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    put(entries: Record<string, unknown>): Promise<void>;
    delete(key: string | string[]): Promise<unknown>;
    list(prefix: string): Promise<string[]>;
  };
  alarm: { set(at: number): Promise<void>; delete(): Promise<void> };
  /** A document's row; null if there's no such document. */
  document(docId: string): Promise<DocRow | null>;
  /** A document's files as they are now; null if there's no such document. */
  current(docId: string): Promise<SiteFiles | null>;
  /** Tells everyone with the document open that its publishing state changed. */
  notify(docId: string): Promise<void>;
  /** A file's media type, by its path. */
  mimeOf(path: string): string | null;
  /** Local development only: a page that asks for it fails its publish (the tests check what that leaves). */
  testFailures?: boolean;
  log(line: string): void;
}

const STATE = "state",
  LIVE = "live",
  RETIRED = "retired",
  FILE = "f:";

const liveOf = (page: LivePage): Live => ({ doc: page.docId, version: page.version, at: page.at });

export class Publishing implements SiteObject {
  private s: Site = FREE;
  private live: LivePage | null = null;

  constructor(readonly deps: PublishingDeps) {}

  /** Reads what's stored (before anything else runs). A copy of another shape (another release's) is none. */
  async load(): Promise<void> {
    const live: unknown = await this.deps.storage.get(LIVE);
    this.live = isLivePage(live) ? live : null;
    if (live && !this.live) this.deps.log("the stored snapshot has another shape: the domain serves nothing until the next publish");
    await this.step({ type: "load", stored: await this.deps.storage.get(STATE), live: this.live && liveOf(this.live) });
  }

  /** Takes the event to the state (state.ts), and does what it says. Answers why the event did nothing, if it says so. */
  private async step(e: Event): Promise<Refusal | undefined> {
    const before = this.s;
    const { s, fx } = step(before, e);
    this.s = s;
    if (fx.drop) await this.drop();
    if (fx.alarm == "set") await this.deps.alarm.set(Date.now());
    if (fx.alarm == "delete") await this.deps.alarm.delete();
    if (s !== before) await this.deps.storage.put(STATE, s);
    if (fx.tell) await this.tell(fx.tell);
    if (fx.run) await this.step(await this.run(fx.run));
    return fx.refused;
  }

  async status(): Promise<SiteStatus> {
    return statusOf(this.s);
  }

  /** Everyone with one of the documents open hears that its publishing state changed. */
  private async tell(ids: string[]): Promise<void> {
    await Promise.all(
      [...new Set(ids)].map((id) =>
        this.deps.notify(id).catch((e: unknown) => this.deps.log(`couldn't tell ${id} about its publishing: ${e}`))
      )
    );
  }

  async link(o: { doc: string; bars: boolean; replace: boolean; by: string }): Promise<Changed> {
    const refused = await this.step({ type: o.replace ? "replace" : "link", doc: o.doc, bars: o.bars, by: o.by, at: Date.now() });
    return { status: statusOf(this.s), ...(refused ? { refused } : {}) };
  }

  async publish(doc: string, by: string): Promise<Changed> {
    const refused = await this.step({ type: "publish", doc, by });
    return { status: statusOf(this.s), ...(refused ? { refused } : {}) };
  }

  async unlink(doc: string): Promise<SiteStatus> {
    await this.step({ type: "unlink", doc });
    return statusOf(this.s);
  }

  async forget(doc: string): Promise<void> {
    await this.step({ type: "forget", doc });
  }

  async served(known?: string | null): Promise<Answer> {
    if (!this.live) return null;
    const served = { page: this.live, bars: this.s.state != "free" && this.s.bars };
    return known == tagOf(served) ? { same: true, tag: known } : { same: false, served };
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

  /** Deletes every snapshot's files but `keep`'s. */
  private async prune(keep: Set<string>): Promise<void> {
    const stale = (await this.deps.storage.list(FILE)).filter((k) => !keep.has(k.slice(FILE.length, k.indexOf(":", FILE.length))));
    await this.remove(stale);
  }

  private async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 128) await this.deps.storage.delete(keys.slice(i, i + 128));
  }

  /** The publish itself, when its time comes. */
  async alarm(): Promise<void> {
    await this.step({ type: "alarm" });
  }

  /** One run, as the event that tells how it ended. */
  private async run(r: { epoch: number; doc: string }): Promise<Event> {
    try {
      const page = await this.render(r.epoch, r.doc);
      // (Thrown away: the state's epoch is another, so the state reads only that.)
      return page ? { type: "ready", epoch: r.epoch, live: liveOf(page) } : { type: "fail", epoch: r.epoch, error: "" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log(`the publish of ${r.doc} failed: ${message}`);
      return { type: "fail", epoch: r.epoch, error: message };
    }
  }

  /** Renders the document as it is now and makes it the live snapshot. Null: the domain's document changed meanwhile. */
  private async render(epoch: number, docId: string): Promise<LivePage | null> {
    const doc = await this.deps.document(docId);
    const now = doc && !doc.test ? await this.deps.current(doc.id) : null;
    if (!doc || !now) throw new Error("The document has no files.");
    const text = (path: string) => {
      const f = now.files[path];
      return f == null ? null : typeof f == "string" ? f : new TextDecoder().decode(f);
    };
    if (this.deps.testFailures && (text(now.index) ?? "").includes("erga:test-fail-publish"))
      throw new Error("This test page asks for its publish to fail.");
    const gen = `${Date.now().toString(36)}${Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(36)).join("")}`;
    const address = addressOf(doc);
    const rendered = await renderSite({ index: now.index, files: now.files, gen, title: doc.title, doc: doc.id, address });
    const encoder = new TextEncoder();
    const entries = Object.entries(now.files).map(([path, data]) => [`${FILE}${gen}:${path}`, typeof data == "string" ? encoder.encode(data) : data] as const);
    for (let i = 0; i < entries.length; i += 64) await this.deps.storage.put(Object.fromEntries(entries.slice(i, i + 64)));
    // The domain's document changed meanwhile: this run is thrown away, with its files.
    if (epoch != this.s.epoch) {
      await this.remove(entries.map(([key]) => key));
      return null;
    }
    const live: LivePage = {
      gen,
      docId: doc.id,
      address,
      before: rendered.before,
      after: rendered.after,
      files: Object.keys(now.files),
      site: addressesOf(text(REDIRECTS)),
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
